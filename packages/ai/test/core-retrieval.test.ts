import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  createScriptedRetrievalEnvironment,
  inputSnapshot,
  retrievalClaim,
} from "../scripts/support/scripted-retrieval.js";
import {
  buildPropositionKey,
  buildRetrievalQuestions,
  createExistingDiscoveryAdapters,
  createRetrieveEvidence,
  selectPassageCandidates,
} from "../src/analysis/retrieval/index.js";

test("questions preserve scope and include neutral, counterevidence, primary, and historical plans", () => {
  const claim = retrievalClaim();
  const questions = buildRetrievalQuestions(claim, 0, null);
  assert.deepEqual(
    new Set(questions.map(({ intent }) => intent)),
    new Set(["neutral", "disconfirming", "primary_source", "supporting", "date_constrained"]),
  );
  assert.ok(questions.every(({ query }) => query.includes("Northbridge")));
  assert.ok(questions.some(({ query }) => query.includes("42 incidents")));
  assert.ok(questions.some(({ dateRange }) => dateRange?.earliest?.startsWith("1998")));
  assert.ok(
    questions.some(({ transformations }) => transformations.some(({ kind }) => kind === "quoted")),
  );
});

test("existing discovery channels are wrapped as non-admissible candidate generators", async () => {
  let tick = 0;
  const client = {
    async search() {
      return {
        results: [
          {
            url: "https://fact-check.example/result",
            title: "Fact-check result",
            snippet: "A rating and snippet are discovery metadata only.",
            rating: "False",
          },
        ],
        costUsd: 0,
      };
    },
  };
  const ports = createExistingDiscoveryAdapters(
    {
      googleFactCheck: client,
      newsApi: client,
      gdelt: client,
      googleNews: client,
      bingNews: client,
    },
    { now: () => "2026-09-14T00:00:00.000Z", monotonicMs: () => tick++ },
  );
  assert.deepEqual(
    ports.map(({ provider }) => provider),
    ["google-fact-check", "news-api", "gdelt", "google-news", "bing-news"],
  );
  const result = await ports[0]!.search({
    query: "scoped claim",
    intent: "neutral",
    claimId: "claim_adapter",
    limit: 2,
    dateRange: null,
    signal: new AbortController().signal,
  });
  assert.equal(result.data?.candidates[0]?.admissible, false);
  assert.equal(result.data?.candidates[0]?.providerRating, "False");
});

test("needs-context queries never invent a resolved entity", () => {
  const claim = retrievalClaim({
    text: "They said it doubled last year.",
    proposition: {
      subject: "They",
      predicate: "said it doubled",
      object: null,
      qualifiers: ["last year"],
    },
    quantities: [],
    time: {
      statedText: "last year",
      interval: { earliest: null, latest: null, precision: null, timezone: null },
    },
    place: null,
    unresolvedContext: ["They has no antecedent."],
    checkability: "needs_context",
  });
  const questions = buildRetrievalQuestions(claim, 0, null);
  assert.ok(questions.every(({ query }) => !query.includes("Northbridge")));
  assert.ok(questions.every(({ query }) => query.includes("They said it doubled last year")));
});

test("full primary and disconfirming records are acquired while snippets remain candidates", async () => {
  const primary = {
    url: "https://records.example/annual-register",
    content: "The official 1998 register records 41 incidents in Northbridge.",
    intents: ["primary_source" as const, "date_constrained" as const],
    fetch: "complete" as const,
    publishedAt: "1999-01-04T00:00:00.000Z",
  };
  const counter = {
    url: "https://archive.example/correction",
    content: "A correction says Northbridge recorded 41, not 42, incidents in 1998.",
    intents: ["disconfirming" as const],
    fetch: "complete" as const,
    publishedAt: "1999-02-01T00:00:00.000Z",
  };
  const snippetOnly = {
    url: "https://news.example/snippet",
    content: "",
    intents: ["supporting" as const],
    fetch: "failed" as const,
  };
  const { environment, audits, stored } = createScriptedRetrievalEnvironment({
    sources: [primary, counter, snippetOnly],
  });
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.data?.admittedSnapshotIds.length, 2);
  assert.equal(stored.size, 2);
  assert.ok(result.data?.candidates.some(({ proposedUrl }) => proposedUrl === snippetOnly.url));
  assert.ok(result.data?.snapshots.every(({ normalizedText }) => normalizedText.length > 0));
  assert.ok(audits.some(({ message }) => message.includes("candidate remains non-admissible")));
});

test("historical evidence is retained and passage overlap is never an admissibility verdict", async () => {
  const source = {
    url: "https://library.example/1998-ledger",
    content: "Northbridge municipal ledger, 1998: total incidents 42.",
    intents: ["date_constrained" as const],
    fetch: "complete" as const,
    publishedAt: "1998-12-31T00:00:00.000Z",
  };
  const { environment } = createScriptedRetrievalEnvironment({ sources: [source] });
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  const snapshot = result.data!.snapshots[0]!;
  assert.equal(snapshot.timestampAssertions[0]?.interval.earliest, "1998-12-31T00:00:00.000Z");
  const passages = selectPassageCandidates(snapshot, retrievalClaim(), 4);
  assert.ok(passages[0]!.lexicalScore > 0);
  assert.ok(passages.every(({ requiresAssessment }) => requiresAssessment));
});

test("a total search API outage is unavailable rather than a completed empty search", async () => {
  const { environment } = createScriptedRetrievalEnvironment({ outage: true });
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
  assert.ok(result.issues.some(({ code }) => code === "provider_outage"));
});

test("a successful empty search is complete no-results, distinct from unsupported capability", async () => {
  const { environment } = createScriptedRetrievalEnvironment({ sources: [] });
  const noResults = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(noResults.status, "complete");
  assert.equal(noResults.data?.stoppingReason, "no_results");

  const unsupported = await createRetrieveEvidence({ searchPorts: [] })(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(unsupported.status, "unavailable");
  assert.equal(unsupported.issues.at(-1)?.code, "capability_unavailable");
});

test("corpus proposals are revalidated against exact tenant, owner, scope, hash, time, and version", async () => {
  const source = {
    url: "https://records.example/corpus",
    content: "Northbridge recorded 42 incidents in 1998.",
    intents: [] as [],
    fetch: "complete" as const,
  };
  const { environment } = createScriptedRetrievalEnvironment({ sources: [source] });
  const acquired = await environment.ports.documents.acquire({
    url: source.url,
    role: "evidence",
    maxBytes: 5_000_000,
    signal: environment.signal,
  });
  const snapshot = acquired.data!.snapshot;
  await environment.ports.snapshots.put(snapshot, environment.signal);
  const claim = retrievalClaim();
  const baseMatch = {
    snapshotId: snapshot.id,
    contentHash: snapshot.contentHash,
    tenantId: environment.context.tenantId,
    ownerUserId: environment.context.ownerUserId,
    visibility: environment.context.visibility,
    propositionKey: buildPropositionKey(claim),
    temporalScope: claim.time.interval,
    retrieverVersion: environment.context.versions.retriever,
    sourceRunId: "older-run-with-model-output-that-is-never-returned",
  };
  const corpus = {
    async find(request: { tenantId: string }) {
      assert.equal(request.tenantId, environment.context.tenantId);
      return {
        status: "complete" as const,
        data: { matches: [{ ...baseMatch, tenantId: "another-tenant" }, baseMatch] },
        issues: [],
        metrics: {
          startedAt: "2026-09-14T00:00:00.000Z",
          completedAt: "2026-09-14T00:00:00.000Z",
          durationMs: 1,
          externalRequests: 0,
          inputTokens: null,
          outputTokens: null,
          costUsd: 0,
        },
      };
    },
  };
  const result = await createRetrieveEvidence({ searchPorts: [], corpus })(
    { claims: [claim], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.data?.admittedSnapshotIds.length, 1);
  assert.ok(result.issues.some(({ code }) => code === "citation_validation_failed"));
});

test("the global budget reserves a fetch and reports omitted queries", async () => {
  const source = {
    url: "https://records.example/budget",
    content: "Northbridge recorded 42 incidents in 1998.",
    intents: ["disconfirming" as const],
    fetch: "complete" as const,
  };
  const { environment, audits } = createScriptedRetrievalEnvironment({
    sources: [source],
    budget: { maxExternalRequests: 2 },
  });
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.status, "partial");
  assert.equal(result.data?.stoppingReason, "budget_exhausted");
  assert.equal(result.data?.budgetUsed.externalRequests, 2);
  assert.equal(result.data?.admittedSnapshotIds.length, 1);
  assert.ok(
    audits.some(({ message }) => message.includes("acquisition capacity remained reserved")),
  );
});

test("duplicates and deferred claims are not retrieved and targeted rounds stop after two", async () => {
  const source = {
    url: "https://records.example/targeted",
    content: "The complete official record.",
    intents: ["primary_source" as const],
    fetch: "complete" as const,
  };
  const { environment } = createScriptedRetrievalEnvironment({ sources: [source] });
  const claim = retrievalClaim();
  const duplicate = retrievalClaim({ id: "claim_duplicate", duplicateOfClaimId: claim.id });
  const deferred = retrievalClaim({ id: "claim_deferred", coverageDisposition: "deferred" });
  const result = await createRetrieveEvidence()(
    {
      claims: [claim, duplicate, deferred],
      snapshots: [inputSnapshot()],
      round: 1,
      sufficiency: [
        {
          claimId: claim.id,
          sufficient: false,
          missing: ["primary_record"],
          suggestedQueries: [
            { query: "Northbridge official record 1998", intent: "primary_source" },
          ],
          independentOriginCount: 0,
          unknownDependenceCount: 0,
        },
      ],
    },
    environment,
  );
  assert.ok(result.data?.candidates.every(({ claimId }) => claimId === claim.id));
  const tooLate = await createRetrieveEvidence()(
    { claims: [claim], snapshots: [inputSnapshot()], round: 3, sufficiency: [] },
    environment,
  );
  assert.equal(tooLate.status, "failed");
});

test("submitted input and truncated fetches cannot enter the admitted snapshot set", async () => {
  const inputUrl = "https://publisher.example/article";
  const truncated = {
    url: "https://records.example/truncated",
    content: "Partial record",
    intents: ["primary_source" as const],
    fetch: "truncated" as const,
  };
  const self = {
    url: inputUrl,
    content: "Self report",
    intents: ["neutral" as const],
    fetch: "complete" as const,
  };
  const { environment } = createScriptedRetrievalEnvironment({ sources: [self, truncated] });
  const input = {
    ...inputSnapshot(),
    originalUrl: inputUrl,
    finalUrl: inputUrl,
    canonicalUrl: inputUrl,
  };
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [input], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.data?.admittedSnapshotIds.length, 0);
  assert.ok(result.issues.some(({ code }) => code === "citation_validation_failed"));
  assert.ok(result.issues.some(({ code }) => code === "content_unavailable"));
});

test("cancellation is terminal and performs no discovery or acquisition", async () => {
  const controller = new AbortController();
  controller.abort();
  const { environment, audits, stored } = createScriptedRetrievalEnvironment({
    signal: controller.signal,
  });
  const result = await createRetrieveEvidence()(
    { claims: [retrievalClaim()], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.data, null);
  assert.equal(result.metrics.externalRequests, 0);
  assert.equal(stored.size, 0);
  assert.ok(audits.some(({ kind }) => kind === "cancellation"));
});

test("counterevidence and acquisition capacity are preserved for later claims", async () => {
  const source = {
    url: "https://records.example/shared-counter",
    content: "The correction record covers both scoped claims.",
    intents: ["disconfirming" as const],
    fetch: "complete" as const,
  };
  const { environment } = createScriptedRetrievalEnvironment({
    sources: [source],
    budget: { maxExternalRequests: 4 },
  });
  const first = retrievalClaim({ id: "claim_first" });
  const second = retrievalClaim({ id: "claim_second" });
  const result = await createRetrieveEvidence()(
    { claims: [first, second], snapshots: [inputSnapshot()], round: 0, sufficiency: [] },
    environment,
  );
  assert.equal(result.data?.budgetUsed.externalRequests, 4);
  assert.deepEqual(
    new Set(result.data?.candidates.map(({ claimId }) => claimId)),
    new Set([first.id, second.id]),
  );
});
