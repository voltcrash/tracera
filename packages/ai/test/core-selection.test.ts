import assert from "node:assert/strict";
import {
  claimSchema,
  documentSnapshotSchema,
  inputCoverageSchema,
  runContextExample,
  type ClaimV2,
  type DocumentSnapshot,
  type InputCoverage,
  type StageResult,
} from "@repo/contracts/core-v2";
import { test } from "vite-plus/test";
import {
  createRunAnalysisV2,
  hashValue,
  projectReport,
  selectTopClaims,
  type RunAnalysisV2StageFactories,
  type RunEnvironment,
} from "../src/core/index.js";
import { scoreReportV2 } from "../src/core/scoring/index.js";

const NOW = "2026-09-15T00:00:00.000Z";
const EMPTY_INTERVAL = {
  earliest: null,
  latest: null,
  precision: null,
  timezone: null,
} as const;

test("selects at most three claims while preserving the long-document inventory", () => {
  const text = [
    "Article headline: Aurora Labs opened a plant in Turin in 2024.",
    "Aurora Labs hired 300 workers in 2024.",
    "The Turin plant produced 1,000 units in 2025.",
    "The ministry inspected the plant in 2025.",
    "Aurora Labs exported 2,000 units in 2025.",
  ].join("\n\n");
  const snapshot = makeSnapshot("article", text, [
    locator("title", 0, text.indexOf("\n\n")),
    ...paragraphLocators(text),
  ]);
  const claims = [
    makeClaim({
      id: "claim_headline",
      documentId: snapshot.id,
      text: "Aurora Labs opened a plant in Turin in 2024.",
      start: 17,
    }),
    makeClaim({
      id: "claim_workers",
      documentId: snapshot.id,
      text: "Aurora Labs hired 300 workers in 2024.",
      start: text.indexOf("Aurora Labs hired"),
    }),
    makeClaim({
      id: "claim_produced",
      documentId: snapshot.id,
      text: "The Turin plant produced 1,000 units in 2025.",
      start: text.indexOf("The Turin plant produced"),
    }),
    makeClaim({
      id: "claim_inspected",
      documentId: snapshot.id,
      text: "The ministry inspected the plant in 2025.",
      start: text.indexOf("The ministry inspected"),
    }),
    makeClaim({
      id: "claim_exported",
      documentId: snapshot.id,
      text: "Aurora Labs exported 2,000 units in 2025.",
      start: text.indexOf("Aurora Labs exported"),
    }),
  ];
  const result = selectTopClaims({
    claims,
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, claims),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [
    "claim_headline",
    "claim_workers",
    "claim_produced",
  ]);
  assert.equal(result.claims.length, 5);
  assert.equal(result.selection.inventory.totalClaims, 5);
  assert.equal(result.selection.inventory.analyzedClaims, 3);
  assert.deepEqual(result.selection.deferredClaimIds, ["claim_inspected", "claim_exported"]);
  assert.ok(
    result.claims
      .filter(({ id }) => ["claim_inspected", "claim_exported"].includes(id))
      .every(({ coverageDisposition }) => coverageDisposition === "deferred"),
  );
  assert.equal(result.selection.coverage.totalCharacters, text.length);
  assert.equal(result.selection.coverage.coveredCharacters, text.length);
});

test("canonical duplicates never occupy multiple focused slots", () => {
  const text = "Aurora Labs opened a plant in Turin.\n\nThe ministry inspected the plant.";
  const snapshot = makeSnapshot("duplicates", text, paragraphLocators(text));
  const canonical = makeClaim({
    id: "claim_canonical",
    documentId: snapshot.id,
    text: "Aurora Labs opened a plant in Turin.",
    start: 0,
  });
  const duplicate = makeClaim({
    id: "claim_duplicate",
    documentId: snapshot.id,
    text: canonical.text,
    start: 0,
    duplicateOfClaimId: canonical.id,
  });
  const other = makeClaim({
    id: "claim_other",
    documentId: snapshot.id,
    text: "The ministry inspected the plant.",
    start: text.indexOf("The ministry"),
  });
  const result = selectTopClaims({
    claims: [duplicate, other, canonical],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [duplicate, other, canonical]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [canonical.id, other.id]);
  assert.equal(result.selection.inventory.canonicalClaims, 2);
  assert.equal(result.selection.inventory.duplicateClaims, 1);
  assert.deepEqual(result.selection.excludedClaimIds, [duplicate.id]);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === duplicate.id)!.reasonCode,
    "duplicate_claim",
  );
});

test("opinion and background are preserved but are not focused factual work", () => {
  const text = "The new plant is wonderful.\n\nThe plant opened in 2024.\n\nThe plant is in Turin.";
  const snapshot = makeSnapshot("dispositions", text, paragraphLocators(text));
  const opinion = makeClaim({
    id: "claim_opinion",
    documentId: snapshot.id,
    text: "The new plant is wonderful.",
    start: 0,
    coverageDisposition: "opinion",
    checkability: "not_checkable",
    material: false,
  });
  const factual = makeClaim({
    id: "claim_factual",
    documentId: snapshot.id,
    text: "The plant opened in 2024.",
    start: text.indexOf("The plant opened"),
  });
  const background = makeClaim({
    id: "claim_background",
    documentId: snapshot.id,
    text: "The plant is in Turin.",
    start: text.indexOf("The plant is in"),
    coverageDisposition: "background",
  });
  const result = selectTopClaims({
    claims: [opinion, factual, background],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [opinion, factual, background]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [factual.id]);
  assert.equal(result.selection.inventory.canonicalFactualClaims, 1);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === opinion.id)!.reasonCode,
    "opinion",
  );
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === background.id)!.reasonCode,
    "background",
  );
  assert.deepEqual(
    result.claims.map(({ id, coverageDisposition }) => [id, coverageDisposition]),
    [
      [opinion.id, "opinion"],
      [factual.id, "factual_claim"],
      [background.id, "background"],
    ],
  );
});

test("ambiguous and unanswerable factual claims remain explicit deferred work", () => {
  const text = "They said the figure doubled last year.\n\nThe plant opened in 2024.";
  const snapshot = makeSnapshot("ambiguous", text, paragraphLocators(text));
  const ambiguous = makeClaim({
    id: "claim_ambiguous",
    documentId: snapshot.id,
    text: "They said the figure doubled last year.",
    start: 0,
    checkability: "needs_context",
  });
  const unanswerable = makeClaim({
    id: "claim_unanswerable",
    documentId: snapshot.id,
    text: "The plant opened in 2024.",
    start: text.indexOf("The plant opened"),
    checkability: "unanswerable",
  });
  const result = selectTopClaims({
    claims: [ambiguous, unanswerable],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [ambiguous, unanswerable]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, []);
  assert.deepEqual(result.selection.deferredClaimIds, [ambiguous.id, unanswerable.id]);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === ambiguous.id)!.reasonCode,
    "ambiguous_context",
  );
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === unanswerable.id)!.reasonCode,
    "unanswerable",
  );
  assert.match(result.selection.shortfallReason!, /No canonical claims/);
});

test("headline and heading locators outrank body claims even when they occur later", () => {
  const text = [
    "Background claim in the opening paragraph.",
    "\n\nHeadline claim about Aurora Labs.",
    "\n\nSection heading claim about Turin.",
  ].join("");
  const first = text.indexOf("Background");
  const headline = text.indexOf("Headline");
  const heading = text.indexOf("Section");
  const snapshot = makeSnapshot("structure", text, [
    locator("paragraph", first, first + "Background claim in the opening paragraph.".length),
    locator("title", headline, headline + "Headline claim about Aurora Labs.".length),
    locator("heading", heading, heading + "Section heading claim about Turin.".length),
  ]);
  const claims = [
    makeClaim({
      id: "claim_body",
      documentId: snapshot.id,
      text: "Background claim in the opening paragraph.",
      start: first,
    }),
    makeClaim({
      id: "claim_headline_late",
      documentId: snapshot.id,
      text: "Headline claim about Aurora Labs.",
      start: headline,
    }),
    makeClaim({
      id: "claim_heading_late",
      documentId: snapshot.id,
      text: "Section heading claim about Turin.",
      start: heading,
    }),
  ];
  const result = selectTopClaims({
    claims,
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, claims),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [
    "claim_headline_late",
    "claim_heading_late",
    "claim_body",
  ]);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === "claim_headline_late")!.ranking
      .position,
    "headline",
  );
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === "claim_heading_late")!.ranking
      .position,
    "heading",
  );
});

test("ranking ties are reproducible and use source order before the claim ID", () => {
  const text = "First claim.\n\nSecond claim.\n\nThird claim.\n\nFourth claim.";
  const snapshot = makeSnapshot("ties", text, paragraphLocators(text));
  const claims = ["First", "Second", "Third", "Fourth"].map((word) =>
    makeClaim({
      id: `claim_${word.toLowerCase()}`,
      documentId: snapshot.id,
      text: `${word} claim.`,
      start: text.indexOf(`${word} claim.`),
    }),
  );
  const input = {
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, claims),
    inventoryStatus: "complete" as const,
    primarySnapshotId: snapshot.id,
  };
  const first = selectTopClaims({ claims, ...input });
  const second = selectTopClaims({ claims: [...claims].reverse(), ...input });

  assert.deepEqual(first.selection.selectedClaimIds, [
    "claim_first",
    "claim_second",
    "claim_third",
  ]);
  assert.deepEqual(second.selection.selectedClaimIds, first.selection.selectedClaimIds);
  assert.deepEqual(
    first.selection.claims.map(({ claimId, ranking }) => [
      claimId,
      ranking.documentOrder,
      ranking.spanStart,
    ]),
    second.selection.claims.map(({ claimId, ranking }) => [
      claimId,
      ranking.documentOrder,
      ranking.spanStart,
    ]),
  );
});

test("concrete signals outrank a same-position claim with no measurable detail", () => {
  const text = "The policy is important.\n\nAurora Labs opened 300 stores in Turin in 2024.";
  const snapshot = makeSnapshot(
    "concrete",
    text,
    paragraphLocators(text),
    "complete",
    "plain_text",
  );
  const vague = makeClaim({
    id: "claim_vague",
    documentId: snapshot.id,
    text: "The policy is important.",
    start: 0,
  });
  const concrete = makeClaim({
    id: "claim_concrete",
    documentId: snapshot.id,
    text: "Aurora Labs opened 300 stores in Turin in 2024.",
    start: text.indexOf("Aurora Labs"),
    place: "Turin",
    time: { statedText: "2024", interval: EMPTY_INTERVAL },
    quantities: [
      {
        rawText: "300 stores",
        value: 300,
        unit: "stores",
        denominatorText: null,
        kind: "count",
      },
    ],
    proposition: {
      subject: "Aurora Labs",
      predicate: "opened",
      object: "300 stores",
      qualifiers: ["in Turin", "in 2024"],
    },
  });
  const result = selectTopClaims({
    claims: [vague, concrete],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [vague, concrete]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [concrete.id, vague.id]);
  assert.deepEqual(
    result.selection.claims.find(({ claimId }) => claimId === concrete.id)!.ranking.concreteSignals,
    ["entity", "date", "place", "quantity", "measurable_event"],
  );
});

test("claims intersecting uncertain OCR are deferred instead of being selected", () => {
  const text = "OCR claim opened in 2024.\n\nClear claim opened in 2025.";
  const firstEnd = "OCR claim opened in 2024.".length;
  const snapshot = makeSnapshot(
    "uncertain-ocr",
    text,
    [locator("ocr_text", 0, firstEnd, true), ...paragraphLocators(text)],
    "complete",
    "ocr",
  );
  const uncertain = makeClaim({
    id: "claim_uncertain_ocr",
    documentId: snapshot.id,
    text: "OCR claim opened in 2024.",
    start: 0,
  });
  const clear = makeClaim({
    id: "claim_clear_ocr",
    documentId: snapshot.id,
    text: "Clear claim opened in 2025.",
    start: text.indexOf("Clear claim"),
  });
  const result = selectTopClaims({
    claims: [uncertain, clear],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [uncertain, clear]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [clear.id]);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === uncertain.id)!.reasonCode,
    "uncertain_ocr",
  );
});

test("fewer than three checkable claims reports a focused shortfall", () => {
  const text = "The plant opened in 2024.\n\nThe plant is wonderful.";
  const snapshot = makeSnapshot("shortfall", text, paragraphLocators(text));
  const factual = makeClaim({
    id: "claim_only_checkable",
    documentId: snapshot.id,
    text: "The plant opened in 2024.",
    start: 0,
  });
  const opinion = makeClaim({
    id: "claim_only_opinion",
    documentId: snapshot.id,
    text: "The plant is wonderful.",
    start: text.indexOf("The plant is wonderful"),
    coverageDisposition: "opinion",
    checkability: "not_checkable",
    material: false,
  });
  const result = selectTopClaims({
    claims: [factual, opinion],
    snapshots: [snapshot],
    coverage: makeCoverage(snapshot, [factual, opinion]),
    inventoryStatus: "complete",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, [factual.id]);
  assert.equal(result.selection.inventory.eligibleClaims, 1);
  assert.match(result.selection.shortfallReason!, /Only 1 canonical claims are eligible/);
});

test("partial extraction keeps deferred claims, coverage, and the selection shortfall explicit", () => {
  const text =
    "The plant opened in 2024.\n\nThe plant hired 300 workers.\n\nThe plant exported 500 units.";
  const snapshot = makeSnapshot("partial", text, paragraphLocators(text));
  const claims = [
    makeClaim({
      id: "claim_partial_one",
      documentId: snapshot.id,
      text: "The plant opened in 2024.",
      start: 0,
    }),
    makeClaim({
      id: "claim_partial_two",
      documentId: snapshot.id,
      text: "The plant hired 300 workers.",
      start: text.indexOf("The plant hired"),
    }),
    makeClaim({
      id: "claim_partial_deferred",
      documentId: snapshot.id,
      text: "The plant exported 500 units.",
      start: text.indexOf("The plant exported"),
      coverageDisposition: "deferred",
    }),
  ];
  const coverage = makeCoverage(snapshot, claims, "partial");
  const result = selectTopClaims({
    claims,
    snapshots: [snapshot],
    coverage,
    inventoryStatus: "partial",
    primarySnapshotId: snapshot.id,
  });

  assert.deepEqual(result.selection.selectedClaimIds, ["claim_partial_one", "claim_partial_two"]);
  assert.deepEqual(result.selection.deferredClaimIds, ["claim_partial_deferred"]);
  assert.equal(result.selection.inventory.deferredClaims, 1);
  assert.equal(result.selection.coverage.partialDocuments, 1);
  assert.equal(result.selection.coverage.omittedCharacters, 0);
  assert.match(result.selection.shortfallReason!, /partial inventory/);
  assert.equal(
    result.selection.claims.find(({ claimId }) => claimId === "claim_partial_deferred")!.reasonCode,
    "deferred_by_extraction_limit",
  );
});

test("the orchestration pipeline sends only selected claims to evidence-bearing stages", async () => {
  const text = "First claim.\n\nSecond claim.\n\nThird claim.\n\nFourth claim.\n\nFifth claim.";
  const snapshot = makeSnapshot("orchestration", text, paragraphLocators(text));
  const claims = ["First", "Second", "Third", "Fourth", "Fifth"].map((word) =>
    makeClaim({
      id: `claim_${word.toLowerCase()}`,
      documentId: snapshot.id,
      text: `${word} claim.`,
      start: text.indexOf(`${word} claim.`),
    }),
  );
  const coverage = makeCoverage(snapshot, claims);
  const observed = new Map<string, string[][]>();
  const observe = (stage: string, input: ClaimV2[]) => {
    observed.set(stage, [...(observed.get(stage) ?? []), input.map(({ id }) => id)]);
  };
  const stages: Partial<RunAnalysisV2StageFactories> = {
    normalizeInput: () => async () =>
      stageResult({ snapshots: [snapshot], primarySnapshotId: snapshot.id }),
    extractClaims: () => async () => stageResult({ claims, coverage }),
    retrieveEvidence:
      () =>
      async ({ claims: inputClaims }) => {
        observe("retrieve", inputClaims);
        return stageResult({
          candidates: [],
          snapshots: [],
          admittedSnapshotIds: [],
          budgetUsed: { externalRequests: 0, costUsd: 0 },
          stoppingReason: "no_results" as const,
        });
      },
    assessEvidence:
      () =>
      async ({ claims: inputClaims }) => {
        observe("assess", inputClaims);
        return stageResult({ assessments: [], sufficiency: [] });
      },
    traceOrigins:
      () =>
      async ({ claims: inputClaims }) => {
        observe("trace", inputClaims);
        return stageResult({ graphs: [], newSnapshotIds: [] });
      },
    adjudicateClaims:
      () =>
      async ({ claims: inputClaims }) => {
        observe("adjudicate", inputClaims);
        return stageResult({ decisions: [] });
      },
    calibrateDecisions:
      () =>
      async ({ claims: inputClaims }) => {
        observe("calibrate", inputClaims);
        return stageResult({ decisions: [] });
      },
    scoreReport: () => (input) => {
      observe("score", input.claims);
      return scoreReportV2(input);
    },
  };
  const environment = makeEnvironment(snapshot);
  const result = await createRunAnalysisV2({ stages })(
    { input: { kind: "text", text }, seed: 20260915 },
    environment,
  );
  assert.ok(result.report);
  const report = result.report;
  const selected = report.focusedSelection!.selectedClaimIds;

  for (const stage of ["retrieve", "assess", "trace", "adjudicate", "calibrate", "score"]) {
    assert.deepEqual(observed.get(stage), [selected], `${stage} received a non-focused claim set`);
  }
  assert.equal(report.claims.length, claims.length);
  assert.equal(report.assessments.length, 0);
  assert.equal(report.provenance.length, 0);
  assert.equal(report.decisions.length, 0);
  assert.equal(report.inputCoverage[0]!.segments[0]!.claimIds.length, claims.length);
  assert.equal(report.scorecard!.counts.deferredClaims, 2);
  assert.equal(report.scorecard!.counts.eligibleFactualClaims, 0);
  const view = projectReport(report);
  assert.equal(view.schemaVersion, 2);
  if (view.schemaVersion !== 2) return;
  assert.equal(view.score.label, "Supported share of selected claims");
  assert.equal(view.claims.length, selected.length);
  assert.equal(view.deferredClaims.length, 2);
  assert.equal(view.focusedSelection?.inventoriedClaims, claims.length);
});

function makeClaim(input: {
  id: string;
  documentId: string;
  text: string;
  start: number;
  coverageDisposition?: ClaimV2["coverageDisposition"];
  checkability?: ClaimV2["checkability"];
  material?: boolean;
  duplicateOfClaimId?: string | null;
  proposition?: ClaimV2["proposition"];
  quantities?: ClaimV2["quantities"];
  time?: ClaimV2["time"];
  place?: string | null;
}) {
  return claimSchema.parse({
    id: input.id,
    documentId: input.documentId,
    text: input.text,
    spans: [{ start: input.start, end: input.start + input.text.length }],
    occurrenceSpans: [],
    retrievalText: input.text,
    proposition: input.proposition ?? {
      subject: "The plant",
      predicate: "states",
      object: input.text,
      qualifiers: [],
    },
    attribution: { kind: "direct_assertion", attributedTo: null, attributionSpan: null },
    negated: false,
    quantities: input.quantities ?? [],
    time: input.time ?? { statedText: null, interval: EMPTY_INTERVAL },
    place: input.place ?? null,
    unresolvedContext: [],
    checkability: input.checkability ?? "checkable",
    material: input.material ?? true,
    parentClaimId: null,
    duplicateOfClaimId: input.duplicateOfClaimId ?? null,
    coverageDisposition: input.coverageDisposition ?? "factual_claim",
  });
}

function stageResult<Data>(data: Data): StageResult<Data> {
  return {
    status: "complete",
    data,
    issues: [],
    metrics: {
      startedAt: NOW,
      completedAt: NOW,
      durationMs: 0,
      externalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
  };
}

function makeEnvironment(snapshot: DocumentSnapshot): RunEnvironment {
  const context = {
    ...runContextExample,
    runId: "run_selection_orchestration",
    inputHash: snapshot.contentHash,
    asOfTime: NOW,
    executionMode: "fixture" as const,
  };
  return {
    context,
    signal: new AbortController().signal,
    ports: {
      generation: {
        modelId: "selection-test-model",
        promptVersion: "selection-test-prompt",
        generate: async () => {
          throw new Error("The selection orchestration fixture does not generate.");
        },
      },
      embeddings: {
        modelId: "selection-test-embedding",
        dimensions: 1,
        preprocessing: "none",
        embed: async () => {
          throw new Error("The selection orchestration fixture does not embed.");
        },
      },
      search: [],
      documents: {
        acquire: async () => {
          throw new Error("The selection orchestration fixture does not acquire URLs.");
        },
        acquireFromText: async () => {
          throw new Error("The selection orchestration fixture does not acquire text.");
        },
      },
      snapshots: {
        put: async () => undefined,
        get: async (id) => (id === snapshot.id ? snapshot : null),
        getMany: async (ids) => ids.flatMap((id) => (id === snapshot.id ? [snapshot] : [])),
      },
      runs: {
        checkpoint: async () => undefined,
        readCheckpoint: async () => null,
        finalize: async () => undefined,
      },
      clock: { now: () => NOW, monotonicMs: () => 0 },
      audit: { sinkId: "selection-test-audit", record: async () => undefined },
    },
  };
}

function makeSnapshot(
  id: string,
  text: string,
  locators: DocumentSnapshot["locators"],
  extractionStatus: DocumentSnapshot["extractionStatus"] = "complete",
  extractionMethod: DocumentSnapshot["extractionMethod"] = "structured_html",
) {
  return documentSnapshotSchema.parse({
    id: `snapshot_${id}`,
    contentHash: hashValue({ id, text }),
    rawContentHash: null,
    originalUrl: null,
    finalUrl: null,
    canonicalUrl: null,
    acquiredAt: NOW,
    mimeType: "text/html",
    language: "en",
    role: "submitted_input",
    normalizedText: text,
    extractionStatus,
    extractionMethod,
    limits: {
      byteLimit: 5_000_000,
      characterLimit: 200_000,
      bytesRetained: Buffer.byteLength(text),
      charactersRetained: text.length,
      truncated: extractionStatus === "partial",
    },
    locators,
    timestampAssertions: [],
    discoveryHints: [],
    blobLocator: { status: "unavailable", uri: null },
  });
}

function locator(
  kind: DocumentSnapshot["locators"][number]["kind"],
  start: number,
  end: number,
  transcriptionUncertain = false,
) {
  return {
    id: `${kind}_${start}`,
    kind,
    path: `/${kind}/${start}`,
    span: { start, end },
    boundingBox: null,
    transcriptionUncertain,
  } satisfies DocumentSnapshot["locators"][number];
}

function paragraphLocators(text: string) {
  return text.split("\n\n").flatMap((paragraph, index, paragraphs) => {
    const start = paragraphs.slice(0, index).reduce((offset, item) => offset + item.length + 2, 0);
    return [locator("paragraph", start, start + paragraph.length)];
  });
}

function makeCoverage(
  snapshot: DocumentSnapshot,
  claims: ClaimV2[],
  extractionStatus: InputCoverage["extractionStatus"] = "complete",
) {
  return [
    inputCoverageSchema.parse({
      documentId: snapshot.id,
      segments: [
        {
          span: { start: 0, end: snapshot.normalizedText.length },
          disposition: "factual_claim",
          claimIds: claims.map(({ id }) => id),
          reason: null,
        },
      ],
      charactersCovered: snapshot.normalizedText.length,
      charactersTotal: snapshot.normalizedText.length,
      extractionStatus,
    }),
  ];
}
