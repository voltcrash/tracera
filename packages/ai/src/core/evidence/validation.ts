import { createHash } from "node:crypto";
import type { ClaimV2, DocumentSnapshot, EvidenceAssessment } from "@repo/contracts/core-v2";
import { evidenceAssessmentSchema } from "@repo/contracts/core-v2";
import { EVIDENCE_ASSESSMENT_PROMPT_VERSION, type RawAssessment } from "./generation";

type AssessmentCheck = EvidenceAssessment["checks"][number];

export function validateAssessment(
  raw: RawAssessment,
  claim: ClaimV2,
  snapshot: DocumentSnapshot,
  passageSpan: { start: number; end: number },
  method: { model: string; engineVersion: string },
): EvidenceAssessment | null {
  const checks: AssessmentCheck[] = [];
  const referenceValid = raw.claimId === claim.id && raw.snapshotId === snapshot.id;
  checks.push(
    check(
      "citation_reference",
      referenceValid,
      "The response IDs must exactly match the requested claim and immutable snapshot.",
    ),
  );

  const passage = snapshot.normalizedText.slice(passageSpan.start, passageSpan.end);
  const localOffset = passage.indexOf(raw.quote);
  const unique = localOffset >= 0 && passage.indexOf(raw.quote, localOffset + 1) < 0;
  checks.push(
    check(
      "quote_offsets",
      unique,
      unique
        ? "The exact quote occurs once in the requested passage."
        : "The quote is absent or ambiguous in the requested passage.",
    ),
  );
  if (!referenceValid || !unique) return null;
  const excerptStart = localOffset < 0 ? passageSpan.start : passageSpan.start + localOffset;
  const excerpt = {
    span: { start: excerptStart, end: excerptStart + raw.quote.length },
    quote: raw.quote,
    locatorId: containingLocator(snapshot, excerptStart, excerptStart + raw.quote.length),
  };

  const entity = entityCheck(claim, raw.quote, raw.relation);
  checks.push(check("entity_identity", entity.pass, entity.detail));
  const temporal = temporalCheck(claim, raw.quote, raw.relation);
  checks.push(check("temporal_scope", temporal.pass, temporal.detail));
  const jurisdiction = jurisdictionCheck(claim, raw.quote);
  checks.push(check("jurisdiction", jurisdiction.pass, jurisdiction.detail));
  const attribution = attributionCheck(claim, raw.quote, raw.relation);
  checks.push(check("attribution", attribution.pass, attribution.detail));
  const negation = negationCheck(claim, raw.quote, raw.relation);
  checks.push(check("negation", negation.pass, negation.detail));
  const numeric = numericChecks(claim, raw.quote, raw.relation);
  checks.push(...numeric.checks);

  const failed = checks.some(({ result }) => result === "fail");
  const uncertain = Object.values(raw.applicability).some((value) => value === "uncertain");
  const applicability = {
    ...raw.applicability,
    entity: entity.pass ? raw.applicability.entity : "not_applicable",
    temporal: temporal.pass ? raw.applicability.temporal : "not_applicable",
    jurisdiction: jurisdiction.pass ? raw.applicability.jurisdiction : "not_applicable",
    scope:
      attribution.pass && negation.pass && numeric.scopePass
        ? raw.applicability.scope
        : "not_applicable",
  } as EvidenceAssessment["applicability"];
  const validationStatus = failed
    ? "rejected"
    : uncertain || Object.values(applicability).some((value) => value === "uncertain")
      ? "needs_human_review"
      : "validated";
  const id = stableId("assessment", claim.id, snapshot.id, String(excerpt.span.start), raw.quote);
  return evidenceAssessmentSchema.parse({
    id,
    claimId: claim.id,
    snapshotId: snapshot.id,
    excerpt,
    relation: raw.relation,
    applicability,
    directness: raw.directness,
    dependencyGroupId: stableId("origin", snapshot.contentHash),
    dependence: "unknown",
    dependenceLocators: [],
    method: {
      name: "entailment-v2",
      model: method.model,
      promptVersion: EVIDENCE_ASSESSMENT_PROMPT_VERSION,
      engineVersion: method.engineVersion,
    },
    checks,
    calculation: numeric.calculation,
    validationStatus,
    justification: raw.justification,
  });
}

function check(
  name: AssessmentCheck["check"],
  pass: boolean | null,
  detail: string,
): AssessmentCheck {
  return { check: name, result: pass === null ? "not_applicable" : pass ? "pass" : "fail", detail };
}

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{N}%]+/gu, " ")
    .trim();
}

function significantWords(value: string) {
  return normalized(value)
    .split(" ")
    .filter((word) => word.length > 2);
}

function entityCheck(claim: ClaimV2, quote: string, relation: RawAssessment["relation"]) {
  if (["irrelevant", "insufficient", "context"].includes(relation))
    return { pass: true, detail: "No factual entailment is claimed." };
  const entities = [claim.proposition.subject, claim.proposition.object]
    .filter((value): value is string => value !== null)
    .filter((value) => /\p{Lu}/u.test(value));
  const quoteText = normalized(quote);
  const missing = entities.filter((entity) => {
    const words = significantWords(entity);
    return words.length > 0 && !words.some((word) => quoteText.includes(word));
  });
  return missing.length === 0
    ? { pass: true, detail: "The passage identifies the scoped entity." }
    : { pass: false, detail: `The passage does not identify: ${missing.join(", ")}.` };
}

function temporalCheck(claim: ClaimV2, quote: string, relation: RawAssessment["relation"]) {
  if (["irrelevant", "insufficient", "context"].includes(relation))
    return { pass: true, detail: "No factual entailment is claimed." };
  const claimYears = years(claim.time.statedText ?? claim.text);
  const quoteYears = years(quote);
  if (claimYears.length === 0 || quoteYears.length === 0)
    return { pass: true, detail: "No conflicting explicit year was found." };
  const overlap = claimYears.some((year) => quoteYears.includes(year));
  return {
    pass: overlap,
    detail: overlap
      ? "The explicit years match."
      : `Claim years ${claimYears.join(", ")} differ from passage years ${quoteYears.join(", ")}.`,
  };
}

function jurisdictionCheck(claim: ClaimV2, quote: string) {
  if (!claim.place)
    return { pass: true, detail: "The claim has no explicit place or jurisdiction." };
  const words = significantWords(claim.place);
  const present = words.some((word) => normalized(quote).includes(word));
  return {
    pass: present,
    detail: present
      ? "The passage names the scoped place or jurisdiction."
      : `The passage does not name ${claim.place}.`,
  };
}

function attributionCheck(claim: ClaimV2, quote: string, relation: RawAssessment["relation"]) {
  if (["irrelevant", "insufficient", "context"].includes(relation))
    return { pass: true, detail: "No factual entailment is claimed." };
  const quoteText = normalized(quote);
  const cue = /\b(?:alleged|claimed|said|reported|according to|quoted)\b/u.test(quoteText);
  const disclaimed = /\b(?:false|falsely|unfounded|denied|no evidence)\b/u.test(quoteText);
  if (
    claim.attribution.kind === "direct_assertion" &&
    relation === "supports" &&
    (cue || disclaimed)
  ) {
    return {
      pass: false,
      detail:
        "An attributed or disclaimed allegation cannot support the underlying direct assertion.",
    };
  }
  if (claim.attribution.kind !== "direct_assertion" && claim.attribution.attributedTo) {
    const present = significantWords(claim.attribution.attributedTo).some((word) =>
      quoteText.includes(word),
    );
    return {
      pass: present,
      detail: present
        ? "The attributed speaker is identified."
        : "The scoped attributed speaker is absent.",
    };
  }
  return { pass: true, detail: "Attribution scope is compatible with the relation." };
}

function negationCheck(claim: ClaimV2, quote: string, relation: RawAssessment["relation"]) {
  if (["irrelevant", "insufficient", "context", "contradicts"].includes(relation))
    return { pass: true, detail: "Negation does not conflict with the claimed relation." };
  const quoteNegated = /\b(?:no|not|never|neither|without)\b/iu.test(quote);
  const pass = claim.negated === quoteNegated;
  return {
    pass,
    detail: pass
      ? "Negation is preserved."
      : "Negation differs between the claim and supporting passage.",
  };
}

function numericChecks(claim: ClaimV2, quote: string, relation: RawAssessment["relation"]) {
  const factual = relation === "supports";
  const checks: AssessmentCheck[] = [];
  let scopePass = true;
  const fraction = quote.match(/([\d,.]+)\s+(?:of|out of)\s+([\d,.]+)/iu);
  for (const quantity of claim.quantities) {
    const unitPass =
      !factual ||
      quantity.unit === null ||
      normalized(quote).includes(normalized(quantity.unit)) ||
      (quantity.kind === "percentage" && fraction !== null);
    checks.push(
      check(
        "units",
        unitPass,
        unitPass ? "Units are compatible." : `The supporting passage omits unit ${quantity.unit}.`,
      ),
    );
    const denominatorPass =
      !factual ||
      quantity.denominatorText === null ||
      normalized(quote).includes(normalized(quantity.denominatorText));
    checks.push(
      check(
        "denominator",
        denominatorPass,
        denominatorPass
          ? "The denominator is preserved or not stated."
          : `The supporting passage changes or omits denominator ${quantity.denominatorText}.`,
      ),
    );
    scopePass &&= unitPass && denominatorPass;
  }
  if (claim.quantities.length === 0) {
    checks.push(check("units", null, "The claim has no quantity unit."));
    checks.push(check("denominator", null, "The claim has no denominator."));
  }
  const percentage = claim.quantities.find(
    (quantity) => quantity.kind === "percentage" && quantity.value !== null,
  );
  let calculation: EvidenceAssessment["calculation"] = null;
  if (fraction && percentage) {
    const numerator = Number(fraction[1]!.replaceAll(",", ""));
    const denominator = Number(fraction[2]!.replaceAll(",", ""));
    const result = denominator === 0 ? null : (numerator / denominator) * 100;
    calculation = {
      steps: [
        {
          expression: `${numerator} / ${denominator}`,
          value: denominator === 0 ? 0 : numerator / denominator,
          unit: null,
        },
        { expression: `(${numerator} / ${denominator}) * 100`, value: result ?? 0, unit: "%" },
      ],
      result,
    };
    const pass = result !== null && Math.abs(result - percentage.value!) < 1e-9;
    checks.push(
      check(
        "calculation",
        pass,
        pass
          ? "The stated operands reproduce the percentage."
          : "The stated operands do not reproduce the claimed percentage.",
      ),
    );
    scopePass &&= pass;
  } else {
    checks.push(check("calculation", null, "The required operands are not both present."));
  }
  return { checks, calculation, scopePass };
}

function years(value: string) {
  return [...value.matchAll(/\b(?:18|19|20|21)\d{2}\b/gu)].map(([year]) => year);
}

function containingLocator(snapshot: DocumentSnapshot, start: number, end: number) {
  return (
    snapshot.locators
      .filter((locator) => locator.span.start <= start && locator.span.end >= end)
      .sort(
        (left, right) => left.span.end - left.span.start - (right.span.end - right.span.start),
      )[0]?.id ?? null
  );
}

export function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}
