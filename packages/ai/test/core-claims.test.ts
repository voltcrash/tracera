import assert from "node:assert/strict";
import {
  completeRunReportExample,
  runContextExample,
  runReportSchema,
  type ClaimV2,
  type DocumentSnapshot,
  type StageResult,
} from "@repo/contracts/core-v2";
import { test } from "vite-plus/test";
import { computeMetrics } from "../evaluation/metrics.js";
import {
  contentHash,
  datasetHash,
  evaluationDatasetSchema,
  type EvaluationDataset,
} from "../evaluation/schemas.js";
import {
  createScriptedClaimGeneration,
  scriptedClaim,
  type ClaimScript,
  type ScriptedGeneration,
} from "../scripts/support/scripted-claim-generation.js";
import {
  createClaimExtractionAdapter,
  createExtractClaimsV2,
  extractClaimsV2,
  matchInventoryToGold,
  summarizeInventory,
} from "../src/core/claims/index.js";
import { createDocumentAcquisitionPort, type OcrPort } from "../src/core/ingestion/index.js";
import type { AuditEvent, ExtractClaimsV2Data, RunEnvironment } from "../src/core/types.js";

const NOW = "2026-09-14T00:00:00.000Z";

test("a long multi-claim document is fully inventoried across overlapping paragraph chunks", async () => {
  const paragraphs = Array.from(
    { length: 600 },
    (_, index) => `Plant ${index + 1} in Town ${index + 1} employs ${(index + 1) * 3} workers.`,
  );
  const text = paragraphs.join("\n\n");
  const script: ClaimScript = {
    segments: [],
    claims: paragraphs.map((paragraph, index) =>
      scriptedClaim({
        text: paragraph.slice(0, -1),
        sourceQuotes: [{ quote: paragraph, in: `Plant ${index + 1} in Town ${index + 1} ` }],
        proposition: {
          subject: `Plant ${index + 1}`,
          predicate: "employs",
          object: `${(index + 1) * 3} workers`,
          qualifiers: [],
        },
        place: `Town ${index + 1}`,
        quantities: [
          {
            rawText: `${(index + 1) * 3} workers`,
            value: (index + 1) * 3,
            unit: "workers",
            denominatorText: null,
            kind: "count",
          },
        ],
      }),
    ),
  };
  const generation = createScriptedClaimGeneration(script);
  const { environment } = await fixture(generation);
  const snapshot = await textSnapshot(text);
  assert.ok(snapshot.normalizedText.length > 16_384);

  const result = await createExtractClaimsV2({ maxChunkCharacters: 2_000, overlapCharacters: 300 })(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );

  assert.equal(result.status, "complete", JSON.stringify(result.issues));
  const data = result.data!;
  assert.equal(data.claims.length, 600);
  assert.ok(generation.payloads.length > 3);
  assert.ok(
    generation.payloads
      .slice(1)
      .every((payload) => payload.segments.some((s) => s.role === "context")),
  );
  assertExactSpans(snapshot, data.claims, script);
  assert.equal(data.coverage[0]!.charactersCovered, snapshot.normalizedText.length);
  assert.ok(data.coverage[0]!.segments.every((segment) => segment.disposition === "factual_claim"));
  assertContractReport(snapshot, data);
});

test("an analysis limit persists every claim and defers the remainder explicitly", async () => {
  const sentences = Array.from(
    { length: 12 },
    (_, index) => `Depot ${index + 1} holds ${index + 10} buses.`,
  );
  const snapshot = await textSnapshot(sentences.join("\n\n"));
  const script: ClaimScript = {
    segments: [],
    claims: sentences.map((sentence, index) =>
      scriptedClaim({
        text: sentence,
        sourceQuotes: [sentence],
        proposition: {
          subject: `Depot ${index + 1}`,
          predicate: "holds",
          object: `${index + 10} buses`,
          qualifiers: [],
        },
        quantities: [
          {
            rawText: `${index + 10} buses`,
            value: index + 10,
            unit: "buses",
            denominatorText: null,
            kind: "count",
          },
        ],
        material: index % 2 === 0,
      }),
    ),
  };
  const { environment } = await fixture(createScriptedClaimGeneration(script));
  const result = await createExtractClaimsV2({ maxAnalyzedClaims: 4 })(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );

  assert.equal(result.status, "partial");
  const claims = result.data!.claims;
  assert.equal(claims.length, 12);
  const analyzed = claims.filter((claim) => claim.coverageDisposition === "factual_claim");
  assert.equal(analyzed.length, 4);
  assert.ok(analyzed.every((claim) => claim.material));
  assert.equal(claims.filter((claim) => claim.coverageDisposition === "deferred").length, 8);
  assert.ok(result.issues.some((issue) => issue.code === "deferred_processing"));
  assert.equal(summarizeInventory(result.data!).deferredClaims, 8);
  assert.ok(
    result.data!.coverage[0]!.segments.some(
      (segment) => segment.disposition === "deferred" && segment.claimIds.length === 1,
    ),
  );
});

test("an exhausted extraction budget defers unread segments instead of dropping them", async () => {
  const paragraphs = Array.from(
    { length: 30 },
    (_, index) => `Station ${index + 1} opened ${index + 2} platforms.`,
  );
  const snapshot = await textSnapshot(paragraphs.join("\n\n"));
  const script: ClaimScript = {
    segments: [],
    claims: paragraphs.map((paragraph, index) =>
      scriptedClaim({
        text: paragraph,
        sourceQuotes: [paragraph],
        proposition: {
          subject: `Station ${index + 1}`,
          predicate: "opened",
          object: `${index + 2} platforms`,
          qualifiers: [],
        },
        quantities: [
          {
            rawText: `${index + 2} platforms`,
            value: index + 2,
            unit: "platforms",
            denominatorText: null,
            kind: "count",
          },
        ],
      }),
    ),
  };
  const generation = createScriptedClaimGeneration(script);
  const { environment, audit } = await fixture(generation);
  const result = await createExtractClaimsV2({
    maxChunkCharacters: 300,
    overlapCharacters: 0,
    maxGenerationRequests: 2,
  })({ snapshots: [snapshot], primarySnapshotId: snapshot.id }, environment);

  assert.equal(result.status, "partial");
  assert.equal(generation.payloads.length, 2);
  assert.equal(result.metrics.externalRequests, 2);
  assert.ok(result.issues.some((issue) => issue.code === "budget_exhausted"));
  assert.ok(audit.some((event) => event.kind === "budget_consumed"));
  const coverage = result.data!.coverage[0]!;
  const deferred = coverage.segments.filter((segment) => segment.disposition === "deferred");
  assert.ok(deferred.length > 0 && deferred.every((segment) => segment.claimIds.length === 0));
  assert.equal(coverage.charactersCovered, coverage.charactersTotal);
  assert.equal(result.data!.claims.length + deferred.length, 30);
});

test("attribution versus truth keeps the statement and the attributed proposition distinct", async () => {
  const sentence = "The ministry said unemployment fell to 4.1% in 2025.";
  const snapshot = await textSnapshot(sentence);
  const statement = scriptedClaim({
    localId: "statement",
    text: sentence,
    sourceQuotes: [sentence],
    proposition: {
      subject: "The ministry",
      predicate: "said",
      object: "unemployment fell to 4.1% in 2025",
      qualifiers: [],
    },
    quantities: [
      { rawText: "4.1%", value: 4.1, unit: "percent", denominatorText: null, kind: "percentage" },
    ],
    time: { statedText: "2025" },
  });
  const embedded = scriptedClaim({
    localId: "embedded",
    text: "Unemployment fell to 4.1% in 2025",
    sourceQuotes: ["unemployment fell to 4.1% in 2025"],
    proposition: {
      subject: "unemployment",
      predicate: "fell to",
      object: "4.1%",
      qualifiers: ["in 2025"],
    },
    attribution: {
      kind: "attributed_statement",
      attributedTo: "The ministry",
      quote: "The ministry said",
    },
    quantities: [
      { rawText: "4.1%", value: 4.1, unit: "percent", denominatorText: null, kind: "percentage" },
    ],
    time: { statedText: "2025" },
    parentLocalId: "statement",
  });

  const faithful = await extract(snapshot, { segments: [], claims: [statement, embedded] });
  assert.equal(faithful.status, "complete", JSON.stringify(faithful.issues));
  const [first, second] = faithful.data!.claims;
  assert.notEqual(first!.id, second!.id);
  const child = faithful.data!.claims.find(
    (claim) => claim.attribution.kind === "attributed_statement",
  )!;
  const parent = faithful.data!.claims.find(
    (claim) => claim.attribution.kind === "direct_assertion",
  )!;
  assert.equal(child.parentClaimId, parent.id);
  assert.equal(child.attribution.attributedTo, "The ministry");
  const attributionSpan = child.attribution.attributionSpan!;
  assert.equal(
    snapshot.normalizedText.slice(attributionSpan.start, attributionSpan.end),
    "The ministry said",
  );
  assert.equal(parent.time.interval.precision, "year");

  const collapsed = await extract(snapshot, {
    segments: [],
    claims: [
      statement,
      { ...embedded, attribution: { kind: "direct_assertion", attributedTo: null, quote: null } },
    ],
  });
  assert.equal(collapsed.status, "partial");
  assert.equal(collapsed.data!.claims.length, 1);
  assert.ok(
    collapsed.issues.some(
      (issue) =>
        issue.code === "citation_validation_failed" &&
        /cannot be a direct assertion/.test(issue.message),
    ),
  );
});

test("negation is preserved and a claim that drops it is rejected", async () => {
  const sentence = "The council did not approve the budget in 2024.";
  const snapshot = await textSnapshot(sentence);
  const base = scriptedClaim({
    text: "The council did not approve the budget in 2024",
    sourceQuotes: [sentence],
    proposition: {
      subject: "The council",
      predicate: "approve",
      object: "the budget",
      qualifiers: ["in 2024"],
    },
    negated: true,
    time: { statedText: "2024" },
  });
  const faithful = await extract(snapshot, { segments: [], claims: [base] });
  assert.equal(faithful.status, "complete", JSON.stringify(faithful.issues));
  assert.equal(faithful.data!.claims[0]!.negated, true);

  const dropped = await extract(snapshot, {
    segments: [],
    claims: [{ ...base, text: "The council approved the budget in 2024", negated: false }],
  });
  assert.equal(dropped.status, "partial");
  assert.equal(dropped.data!.claims.length, 0);
  assert.ok(dropped.issues.some((issue) => /drops the negation/.test(issue.message)));
  assert.ok(
    dropped.data!.coverage[0]!.charactersCovered < dropped.data!.coverage[0]!.charactersTotal,
  );

  const mislabeled = await extract(snapshot, {
    segments: [],
    claims: [{ ...base, negated: false }],
  });
  assert.equal(mislabeled.data!.claims.length, 0);
});

test("an entity collision keeps a partial name unresolved instead of guessing the person", async () => {
  const text = [
    "Maria Lopez chairs the transit board. Carlos Lopez runs the port authority.",
    "Lopez said the ferry fleet will expand.",
  ].join("\n\n");
  const snapshot = await textSnapshot(text);
  const guessed = scriptedClaim({
    text: "Maria Lopez said the ferry fleet will expand",
    sourceQuotes: ["Lopez said the ferry fleet will expand."],
    proposition: {
      subject: "Maria Lopez",
      predicate: "said",
      object: "the ferry fleet will expand",
      qualifiers: [],
    },
    referents: [
      {
        mention: "Lopez",
        referent: "Maria Lopez",
        antecedent: "Maria Lopez chairs the transit board.",
      },
    ],
  });
  const script: ClaimScript = {
    segments: [
      {
        text: "Maria Lopez chairs the transit board.",
        disposition: "background",
        reason: "Role context.",
      },
      {
        text: "Carlos Lopez runs the port authority.",
        disposition: "background",
        reason: "Role context.",
      },
    ],
    claims: [guessed],
  };
  const result = await extract(snapshot, script);

  assert.equal(result.status, "complete", JSON.stringify(result.issues));
  const claim = result.data!.claims[0]!;
  assert.equal(claim.text, "Lopez said the ferry fleet will expand");
  assert.equal(claim.proposition.subject, "Lopez");
  assert.equal(claim.checkability, "needs_context");
  assert.match(claim.unresolvedContext[0]!, /Maria Lopez and Carlos Lopez/);
  assert.ok(
    result.issues.some((issue) => issue.code === "ambiguous_input" && issue.severity === "info"),
  );

  const single = await textSnapshot(
    "Maria Lopez chairs the transit board.\n\nShe said the ferry fleet will expand.",
  );
  const resolved = await extract(single, {
    segments: [
      {
        text: "Maria Lopez chairs the transit board.",
        disposition: "background",
        reason: "Role context.",
      },
    ],
    claims: [
      {
        ...guessed,
        sourceQuotes: ["She said the ferry fleet will expand."],
        referents: [
          {
            mention: "She",
            referent: "Maria Lopez",
            antecedent: "Maria Lopez chairs the transit board.",
          },
        ],
      },
    ],
  });
  assert.equal(resolved.status, "complete", JSON.stringify(resolved.issues));
  assert.equal(resolved.data!.claims[0]!.checkability, "checkable");
  assert.equal(resolved.data!.claims[0]!.proposition.subject, "Maria Lopez");
});

test("a denominator is preserved and a claim that drops it is rejected", async () => {
  const sentence = "Unemployment reached 12% among adults under 25 in 2025.";
  const snapshot = await textSnapshot(sentence);
  const base = scriptedClaim({
    text: "Unemployment reached 12% among adults under 25 in 2025",
    sourceQuotes: [sentence],
    proposition: {
      subject: "Unemployment",
      predicate: "reached",
      object: "12%",
      qualifiers: ["among adults under 25", "in 2025"],
    },
    quantities: [
      {
        rawText: "12%",
        value: 12,
        unit: "percent",
        denominatorText: "adults under 25",
        kind: "percentage",
      },
    ],
    time: { statedText: "2025" },
  });
  const faithful = await extract(snapshot, { segments: [], claims: [base] });
  assert.equal(faithful.status, "complete", JSON.stringify(faithful.issues));
  assert.equal(faithful.data!.claims[0]!.quantities[0]!.denominatorText, "adults under 25");

  const broadened = await extract(snapshot, {
    segments: [],
    claims: [
      {
        ...base,
        text: "Unemployment reached 12% in 2025",
        sourceQuotes: [sentence],
        quantities: [{ ...base.quantities[0]!, denominatorText: null }],
      },
    ],
  });
  assert.equal(broadened.data!.claims.length, 0);
  assert.ok(broadened.issues.some((issue) => /drops its stated denominator/.test(issue.message)));

  const renumbered = await extract(snapshot, {
    segments: [],
    claims: [{ ...base, text: "Unemployment reached 21% among adults under 25 in 2025" }],
  });
  assert.equal(renumbered.data!.claims.length, 0);
});

test("unsupported-language input is reported unavailable without calling the model", async () => {
  const spanish = await textSnapshot(
    "El ministerio dijo que el desempleo bajó al cuatro por ciento durante el año pasado en todo el país.",
  );
  const generation = createScriptedClaimGeneration({ segments: [], claims: [] });
  const { environment } = await fixture(generation);
  const result = await extractClaimsV2(
    { snapshots: [spanish], primarySnapshotId: spanish.id },
    environment,
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
  assert.equal(result.issues[0]!.code, "unsupported_language");
  assert.equal(generation.payloads.length, 0);

  const mixed = await textSnapshot(
    [
      "The port handled 40 ships on Monday.",
      "El ministerio dijo que el desempleo bajó al cuatro por ciento durante el año pasado en todo el país.",
    ].join("\n\n"),
  );
  const partial = await extract(mixed, {
    segments: [],
    claims: [
      scriptedClaim({
        text: "The port handled 40 ships on Monday",
        sourceQuotes: ["The port handled 40 ships on Monday."],
        quantities: [
          { rawText: "40 ships", value: 40, unit: "ships", denominatorText: null, kind: "count" },
        ],
        time: { statedText: "on Monday" },
      }),
    ],
  });
  assert.equal(partial.status, "partial");
  assert.equal(partial.data!.claims.length, 1);
  const deferred = partial.data!.coverage[0]!.segments.find(
    (segment) => segment.disposition === "deferred",
  )!;
  assert.match(deferred.reason!, /not supported/);
  assert.ok(partial.issues.some((issue) => issue.code === "unsupported_language"));
});

test("duplicate propositions merge occurrences while different scopes stay separate", async () => {
  const repeated =
    "Aurora Labs opened a battery components plant in the northern Italian city of Turin in 2024, the company confirmed.";
  const later =
    "Aurora Labs opened a battery components plant in the northern Italian city of Turin in 2025, the company confirmed.";
  const text = [repeated, "Local officials welcomed the news.", repeated, later].join("\n\n");
  const snapshot = await textSnapshot(text);
  const claim = (sentence: string, year: string, anchor: string) =>
    scriptedClaim({
      text: sentence.slice(0, -1),
      sourceQuotes: [{ quote: sentence, in: anchor }],
      proposition: {
        subject: "Aurora Labs",
        predicate: "opened a plant in",
        object: "Turin",
        qualifiers: [`in ${year}`],
      },
      time: { statedText: year },
      place: "Turin",
    });
  const script: ClaimScript = {
    segments: [
      {
        text: "Local officials welcomed the news.",
        disposition: "background",
        reason: "Reaction without a checkable fact.",
      },
    ],
    claims: [claim(repeated, "2024", repeated), claim(later, "2025", later)],
  };
  const generation = createScriptedClaimGeneration(script);
  const { environment } = await fixture(generation);
  // The repeated sentence lands in two chunks, so the scripted model emits it twice.
  const result = await createExtractClaimsV2({ maxChunkCharacters: 200, overlapCharacters: 0 })(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );

  assert.equal(result.status, "complete", JSON.stringify(result.issues));
  const claims = result.data!.claims;
  assert.equal(claims.length, 2);
  const merged = claims.find((item) => item.time.statedText === "2024")!;
  const secondStart = text.indexOf(repeated, 1);
  assert.deepEqual(merged.spans, [{ start: 0, end: repeated.length }]);
  assert.deepEqual(merged.occurrenceSpans, [
    { start: secondStart, end: secondStart + repeated.length },
  ]);
  assert.notEqual(claims[1]!.id, merged.id);
  assert.equal(summarizeInventory(result.data!).inventoriedClaims, 2);

  const again = await createExtractClaimsV2({ maxChunkCharacters: 200, overlapCharacters: 0 })(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    (
      await fixture(
        createScriptedClaimGeneration({ ...script, claims: [...script.claims].reverse() }),
      )
    ).environment,
  );
  assert.deepEqual(
    again.data!.claims.map((item) => item.id),
    claims.map((item) => item.id),
    "claim identity is content-derived, not model-order-derived",
  );
});

test("opinion-only content returns a complete inventory with no checkable claims", async () => {
  const snapshot = await textSnapshot("What a wonderful plan. I love the new park design.");
  const result = await extract(snapshot, {
    segments: [
      { text: "What a wonderful plan.", disposition: "opinion", reason: "Expresses approval." },
      {
        text: "I love the new park design.",
        disposition: "opinion",
        reason: "Personal preference.",
      },
    ],
    claims: [],
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.data!.claims, []);
  assert.ok(
    result.data!.coverage[0]!.segments.every((segment) => segment.disposition === "opinion"),
  );
  assert.equal(summarizeInventory(result.data!).noCheckableClaims, true);
});

test("invented quotes, unknown segments and invented numbers are rejected, not repaired", async () => {
  const sentence = "The bridge carried 9,000 vehicles on its first day.";
  const snapshot = await textSnapshot(sentence);
  const base = scriptedClaim({
    text: "The bridge carried 9,000 vehicles on its first day",
    sourceQuotes: [sentence],
    quantities: [
      {
        rawText: "9,000 vehicles",
        value: 9000,
        unit: "vehicles",
        denominatorText: null,
        kind: "count",
      },
    ],
    time: { statedText: "on its first day" },
  });
  const result = await extract(snapshot, {
    segments: [],
    claims: [
      {
        ...base,
        localId: "paraphrased",
        sourceQuotes: [{ quote: "The bridge moved 9,000 cars", in: "The bridge" }],
      },
      { ...base, localId: "inflated", text: "The bridge carried 19,000 vehicles on its first day" },
      {
        ...base,
        localId: "invented-place",
        text: "The Oakland bridge carried 9,000 vehicles on its first day",
      },
    ],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.data!.claims.length, 0);
  const messages = result.issues
    .filter((issue) => issue.code === "citation_validation_failed")
    .map((issue) => issue.message);
  assert.equal(messages.length, 3);
  assert.ok(messages.some((message) => /paraphrased.*not an exact substring/.test(message)));
  assert.ok(messages.some((message) => /inflated/.test(message)));
  assert.ok(messages.some((message) => /invented-place.*Oakland/.test(message)));
});

test("unavailable originals, captions and uncertain OCR never become verified claims", async () => {
  const blocked = (
    await createDocumentAcquisitionPort({
      now: () => NOW,
      safeFetchOptions: {
        resolveHostAddresses: async () => ["8.8.8.8"],
        fetchImplementation: async () => new Response("Forbidden", { status: 403 }),
      },
    }).acquire({
      url: "https://news.example/scientists-confirm-mars-is-green",
      role: "submitted_input",
      maxBytes: 10_000,
      signal: new AbortController().signal,
    })
  ).data!.snapshot;
  const generation = createScriptedClaimGeneration({ segments: [], claims: [] });
  const { environment } = await fixture(generation);
  const unavailable = await extractClaimsV2(
    { snapshots: [blocked], primarySnapshotId: blocked.id },
    environment,
  );
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.issues[0]!.code, "blocked_page");

  const captionOnly = await imageSnapshot(null, "Mars photographed from Delhi yesterday");
  const captionResult = await extractClaimsV2(
    { snapshots: [captionOnly], primarySnapshotId: captionOnly.id },
    environment,
  );
  assert.equal(captionResult.status, "unavailable");
  assert.equal(generation.payloads.length, 0);

  const ocr = await imageSnapshot("Meeting on 2l May", "User says this was taken in Delhi");
  const ocrGeneration = createScriptedClaimGeneration({
    segments: [],
    claims: [
      scriptedClaim({
        text: "A meeting was held on 2l May",
        sourceQuotes: ["Meeting on 2l May"],
        time: { statedText: "2l May" },
        proposition: { subject: "Meeting", predicate: "held on", object: "2l May", qualifiers: [] },
      }),
    ],
  });
  const ocrResult = await extractClaimsV2(
    { snapshots: [ocr], primarySnapshotId: ocr.id },
    (await fixture(ocrGeneration)).environment,
  );
  assert.ok(
    ocrGeneration.payloads[0]!.segments.every((segment) => !segment.text.includes("Delhi")),
  );
  const claim = ocrResult.data!.claims[0]!;
  assert.equal(claim.checkability, "needs_context");
  assert.match(claim.unresolvedContext.join(" "), /uncertain/);
  assert.equal(claim.time.interval.earliest, null);
  const caption = ocrResult.data!.coverage[0]!.segments.find((segment) =>
    segment.reason?.includes("caption"),
  )!;
  assert.equal(caption.disposition, "background");
  assert.deepEqual(caption.claimIds, []);
});

test("cancellation and provider failure are explicit stage outcomes", async () => {
  const dam =
    "The regional dam operator released stored reservoir water through the eastern spillway gates during the spring of 2023.";
  const river =
    "Downstream gauges operated by the regional water agency showed that the river rose by two metres over the following days.";
  const snapshot = await textSnapshot(`${dam}\n\n${river}`);
  const controller = new AbortController();
  controller.abort();
  const { environment, audit } = await fixture(
    createScriptedClaimGeneration({ segments: [], claims: [] }),
    controller.signal,
  );
  const canceled = await extractClaimsV2(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    environment,
  );
  assert.equal(canceled.status, "failed");
  assert.equal(canceled.issues[0]!.code, "cancellation_requested");
  assert.ok(audit.some((event) => event.kind === "cancellation"));

  const midway = new AbortController();
  const aborting = createScriptedClaimGeneration(
    { segments: [], claims: [] },
    { beforeResponse: () => midway.abort() },
  );
  const midwayResult = await extractClaimsV2(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    (await fixture(aborting, midway.signal)).environment,
  );
  assert.equal(midwayResult.status, "failed");
  assert.equal(midwayResult.issues[0]!.code, "cancellation_requested");

  const script: ClaimScript = {
    segments: [],
    claims: [
      scriptedClaim({ text: dam, sourceQuotes: [dam], time: { statedText: "2023" } }),
      scriptedClaim({
        text: river,
        sourceQuotes: [river],
        quantities: [
          {
            rawText: "two metres",
            value: 2,
            unit: "metres",
            denominatorText: null,
            kind: "measure",
          },
        ],
      }),
    ],
  };
  const flaky = createScriptedClaimGeneration(script, { failOnCalls: [2] });
  const partial = await createExtractClaimsV2({ maxChunkCharacters: 200, overlapCharacters: 0 })(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    (await fixture(flaky)).environment,
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.data!.claims.length, 1);
  assert.ok(partial.issues.some((issue) => issue.code === "provider_failure"));
  assert.ok(
    partial.data!.coverage[0]!.charactersCovered < partial.data!.coverage[0]!.charactersTotal,
  );

  const down = await extractClaimsV2(
    { snapshots: [snapshot], primarySnapshotId: snapshot.id },
    (await fixture(createScriptedClaimGeneration(script, { failOnCalls: [1] }))).environment,
  );
  assert.equal(down.status, "failed");
  assert.equal(down.data, null);
});

test("extraction evaluation aligns with gold spans only and never grades itself", async () => {
  const text =
    "The ministry said unemployment fell to 4.1% in 2025. The council did not approve the budget in 2024.";
  const dataset = syntheticDataset(text, [
    { id: "gold-statement", text: "The ministry said unemployment fell to 4.1% in 2025." },
    { id: "gold-budget", text: "The council did not approve the budget in 2024." },
  ]);
  const script: ClaimScript = {
    segments: [],
    claims: [
      scriptedClaim({
        text: "The ministry said unemployment fell to 4.1% in 2025",
        sourceQuotes: ["The ministry said unemployment fell to 4.1% in 2025."],
        quantities: [
          {
            rawText: "4.1%",
            value: 4.1,
            unit: "percent",
            denominatorText: null,
            kind: "percentage",
          },
        ],
        time: { statedText: "2025" },
      }),
      scriptedClaim({
        text: "The council did not approve the budget in 2024",
        sourceQuotes: ["The council did not approve the budget in 2024."],
        negated: true,
        time: { statedText: "2024" },
      }),
    ],
  };
  const adapter = createClaimExtractionAdapter({
    id: "core-v2-claims-fixture",
    version: "1.0.0",
    modes: ["fixture"],
    createEnvironment: () => fixtureEnvironment(createScriptedClaimGeneration(script)).environment,
  });
  const run = await adapter.evaluate(dataset, { mode: "fixture", split: "all", seed: 20260910 });
  assert.equal(run.datasetHash, datasetHash(dataset));
  assert.deepEqual(
    run.extractionMatches.map((match) => [match.goldClaimId, match.status, match.method]),
    [
      ["gold-statement", "matched", "exact_span"],
      ["gold-budget", "matched", "exact_span"],
    ],
  );

  const { environment } = fixtureEnvironment(
    createScriptedClaimGeneration({ ...script, claims: [script.claims[0]!] }),
  );
  const snapshot = await textSnapshot(text);
  const partialInventory = (
    await extractClaimsV2({ snapshots: [snapshot], primarySnapshotId: snapshot.id }, environment)
  ).data!;
  const selfReportedComplete: ExtractClaimsV2Data = {
    claims: partialInventory.claims,
    coverage: partialInventory.coverage.map((document) => ({
      ...document,
      charactersCovered: document.charactersTotal,
      extractionStatus: "complete",
    })),
  };
  const matches = matchInventoryToGold({
    documentId: "doc-claims",
    goldClaims: dataset.claims,
    claims: selfReportedComplete.claims,
  });
  assert.deepEqual(
    matches.find((match) => match.goldClaimId === "gold-budget"),
    {
      documentId: "doc-claims",
      goldClaimId: "gold-budget",
      predictedClaimId: null,
      status: "missed",
      method: "human_review_required",
      rationale: "No extracted claim overlaps the gold spans.",
    },
  );

  const metrics = computeMetrics(dataset, run, undefined, 20260910);
  assert.equal(metrics.claimExtraction.recall.status, "not_evaluated");
  assert.equal(metrics.claimExtraction.recall.denominator, 0);
  assert.equal(metrics.claimExtraction.semanticPrecision.status, "not_evaluated");
});

function assertExactSpans(snapshot: DocumentSnapshot, claims: ClaimV2[], script: ClaimScript) {
  const quotes = new Set(
    script.claims.flatMap((claim) =>
      claim.sourceQuotes.map((q) => (typeof q === "string" ? q : q.quote)),
    ),
  );
  for (const claim of claims) {
    for (const span of [...claim.spans, ...claim.occurrenceSpans]) {
      assert.ok(quotes.has(snapshot.normalizedText.slice(span.start, span.end)));
    }
  }
}

function assertContractReport(snapshot: DocumentSnapshot, data: ExtractClaimsV2Data) {
  const report = {
    ...completeRunReportExample,
    status: "partial",
    snapshots: [snapshot],
    primarySnapshotId: snapshot.id,
    claims: data.claims,
    candidates: [],
    assessments: [],
    provenance: [],
    decisions: [],
    scorecard: null,
    inputCoverage: data.coverage,
    unresolvedReasons: [],
    evidenceSetHash: null,
    replayManifest: {
      ...completeRunReportExample.replayManifest,
      snapshotIds: [snapshot.id],
      assessmentIds: [],
    },
  };
  const parsed = runReportSchema.safeParse(report);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
}

async function extract(snapshot: DocumentSnapshot, script: ClaimScript) {
  const { environment } = await fixture(createScriptedClaimGeneration(script));
  return extractClaimsV2({ snapshots: [snapshot], primarySnapshotId: snapshot.id }, environment);
}

async function fixture(generation: ScriptedGeneration, signal = new AbortController().signal) {
  return fixtureEnvironment(generation, signal);
}

function fixtureEnvironment(generation: ScriptedGeneration, signal = new AbortController().signal) {
  const audit: AuditEvent[] = [];
  const stored = new Map<string, DocumentSnapshot>();
  const unused = () => {
    throw new Error("This port is not used by claim extraction fixtures.");
  };
  const environment: RunEnvironment = {
    context: { ...runContextExample, executionMode: "fixture" },
    signal,
    ports: {
      generation,
      embeddings: { modelId: "unused", dimensions: 1024, preprocessing: "unused", embed: unused },
      search: [],
      documents: createDocumentAcquisitionPort({ now: () => NOW }),
      snapshots: {
        async put(snapshot) {
          stored.set(snapshot.id, snapshot);
        },
        async get(id) {
          return stored.get(id) ?? null;
        },
        async getMany(ids) {
          return ids.flatMap((id) => (stored.has(id) ? [stored.get(id)!] : []));
        },
      },
      runs: { checkpoint: unused, readCheckpoint: unused, finalize: unused },
      clock: { now: () => NOW, monotonicMs: () => 0 },
      audit: {
        sinkId: "audit_fixture",
        async record(event) {
          audit.push(event);
        },
      },
    },
  };
  return { environment, audit };
}

async function textSnapshot(text: string) {
  const result: StageResult<{ snapshot: DocumentSnapshot }> = await createDocumentAcquisitionPort({
    now: () => NOW,
  }).acquireFromText({ text, role: "submitted_input", signal: new AbortController().signal });
  return result.data!.snapshot;
}

async function imageSnapshot(ocrText: string | null, caption: string) {
  const ocr: OcrPort | undefined =
    ocrText === null
      ? undefined
      : {
          provider: "fixture-ocr",
          modelId: "fixture-ocr-1",
          async recognize() {
            return {
              regions: [
                {
                  text: ocrText,
                  boundingBox: { page: 0, frameId: null, x: 10, y: 20, width: 200, height: 30 },
                  transcriptionUncertain: true,
                },
              ],
            };
          },
        };
  const result = await createDocumentAcquisitionPort({ now: () => NOW, ocr }).acquireImage({
    data: "data:image/png;base64,iVBORw0KGgo=",
    mimeType: "image/png",
    caption,
    role: "submitted_input",
    maxBytes: 10_000,
    signal: new AbortController().signal,
  });
  return result.data!.snapshot;
}

function syntheticDataset(
  text: string,
  claims: Array<{ id: string; text: string }>,
): EvaluationDataset {
  return evaluationDatasetSchema.parse({
    schemaVersion: "1.0.0",
    datasetId: "core-claims-unit",
    datasetVersion: "1.0.0",
    license: {
      name: "Synthetic fixture; repository license",
      url: null,
      redistributionAllowed: true,
      notes: "Synthetic, not human gold.",
    },
    documents: [
      {
        id: "doc-claims",
        text,
        contentHash: contentHash(text),
        language: "en",
        asOfTime: "2026-01-01T00:00:00Z",
        acquiredAt: "2025-12-01T00:00:00Z",
        sourceUrl: null,
        splitId: "development",
        eventGroupId: "claims-unit",
        sourceFamilyId: "synthetic-claims",
      },
    ],
    evidenceDocuments: [],
    excerpts: [],
    claims: claims.map((claim) => {
      const start = text.indexOf(claim.text);
      return {
        id: claim.id,
        documentId: "doc-claims",
        text: claim.text,
        spans: [{ start, end: start + claim.text.length }],
        material: true,
        checkability: "checkable",
        label: null,
        evidenceExcerptIds: [],
        origin: "not_applicable",
        goldStatus: "synthetic",
        annotations: [],
        adjudication: null,
      };
    }),
  });
}
