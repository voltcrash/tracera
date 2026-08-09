# tracera

## goal

Combat misinformation by measuring the accuracy of a given text, image, or source (news) by cross-verifying it against reputable sources, and producing a confidence score (news-analysis).

## platforms

Web, mobile, browser extension.

## screens

1. **Main screen** — ability to insert an image, link, or text. For now, assume a typical AI-chat-style interface (single input, streaming/structured result below).
2. **News Hub** — displays sources/news already checked by users in the past, along with their confidence scores. This reduces repeated analysis of the same news item within a threshold/duration. After that threshold expires, re-analysis is allowed again (exact duration TBD).
3. **Login/signup screen.**

## novel ideas

- **Ground Zero** — Tracera's key differentiator: trace and surface the _original source_ of a given news item, not just corroborating sources.
- **Claim decomposition** — instead of scoring an entire article as one unit, split it into atomic, individually-checkable claims. e.g., 3 claims supported, 1 misleading, 2 unverified/unknown.
- **Evidence-quality confidence** — separate from the claim verdict itself, disclose how strong/weak the _evidence_ behind that verdict is (e.g., a claim may be accurate but only backed by thin evidence because the news is very recent).
- **Tracera Score** — a custom, nutrition-label-style rating system instead of a single opaque number. Sub-dimensions:
  - Source reputation
  - Manipulative / emotional language level
  - Degree of factual skew in reporting (framing vs. fact)
  - Recency
  - Cross-source corroboration strength
- **Trace Timeline (News Hub)** — for each news item, show a timeline of past checks, how its score has changed over time, and where/when it has reappeared.
- **Trace Timeline (per-check)** — a mini version of the above embedded in each individual check result, scoped to that specific news item.
- **Reactive browser extension** — real-time inline highlighting of claims directly on the page as the user reads an article, rather than requiring a manual click to trigger a check.
- **Update/decay alerts** — most users never revisit a checked news item. Let them opt in to notifications if that item's status/score changes later (e.g., a claim gets debunked or corrected after the fact).
- **Personal media-diet report** — an opt-in email/notification digest giving users insight into their own news consumption (e.g., "70% of the news you checked this month came from high-reputation sources"). Aimed at improving media literacy over time.
- **Public API** — final stage, once the product and scoring pipeline are stable.

## technologies

### frontend

- Web: Next.js
- Mobile: React Native (with Expo)
- Extension: Manifest V3, TypeScript, WXT
- Monorepo: Turborepo
- Package manager: pnpm

### backend

- Core API: Hono
- Database: Postgres + pgvector
- Cache / queue: Upstash Redis REST. Scheduled decay work uses a durable
  ready/processing/dead-letter list queue driven by Cloudflare Cron; BullMQ is
  intentionally not used because the Worker runtime has no persistent TCP
  process.
- ORM: Drizzle
- Search: Postgres full-text search (`tsvector` + GIN), covering submissions and atomic claims.

### AI providers

- **Primary: hosted AI provider APIs.** Gemini, OpenRouter, Anthropic, OpenAI, and OpenAI-compatible endpoints are selected by environment configuration behind the same interface.
- Architecture must **not** hard-couple to a provider. Keep a thin provider-abstraction layer (a single interface like `generate(prompt, schema)` / `embed(text)`) so providers can be swapped in per-environment or per-call via config, without touching pipeline logic.
- Same abstraction applies to embeddings (model swap should not require touching dedup/RAG logic).
- All structured-output calls (regardless of provider) must go through a schema-validation-and-retry step (e.g. Zod parse → retry on failure) — "valid JSON" from `format: "json"` mode is not the same as "matches our schema," and this must not be assumed to work reliably by default.

### claim-verification pipeline

**Step 0 — Model validation (do this before building the pipeline):**
Before writing pipeline code, validate the chosen hosted model's output quality on Stage 2 (claim extraction) and Stage 6 (verdict generation) using 5-10 real articles (mixed true/false/misleading). Check: consistent valid-schema JSON output, genuine claim atomicity, coherent (not just confident-sounding) reasoning, latency, and cost. Use the results to set retry policy and approve the production model.

1. **Input normalization** — convert text / link / image into a common shape: `{ text, sourceUrl?, sourceDomain?, publishedAt?, imageMetadata? }`.
   - Link → scrape + readability extraction (body text, author, publish date, domain).
   - Image → OCR (if text present) + reverse image search + EXIF metadata check, run in parallel.
   - Text → pass through directly.
2. **Claim extraction** — LLM call (via provider abstraction) with structured output, decomposing input into atomic, checkable claims: `{ id, claimText, claimType, checkability, context }`. Explicitly separates factual assertions from framing/opinion.
3. **Ground Zero trace** — attempt to identify the earliest known appearance of the story/claim (via domain publish-date comparison, retrieved source ordering, and/or existing corpus lookup).
4. **Source retrieval (per claim)** — run in parallel:
   - Own corpus lookup (pgvector — RAG strategy 1, see below)
   - Structured fact-check APIs (e.g. Google Fact Check Tools API)
   - General news retrieval (NewsAPI / GDELT / Bing News, or equivalent)
   - Web search fallback for very recent/niche claims
5. **Source credibility scoring** — each retrieved source is weighted using a maintained `domains` table (trust score seeded from known media-reliability datasets, refined over time using outcome data).
6. **Verdict generation** — LLM call given claim + weighted sources, required to reason step-by-step, flag source conflicts rather than averaging them away, and output `{ verdict, confidence, reasoning, supportingSources, contradictingSources }`. Full prompt + sources used must be logged for auditability.
7. **Evidence-quality scoring** — separate signal alongside the verdict: how much/strong/recent is the evidence this verdict rests on.
8. **Aggregation (Tracera Score)** — roll per-claim verdicts + evidence quality + source credibility into the multi-dimensional nutrition-label score described above.
9. **Persist + embed** — store result in `checks` (and a normalized `claims` table, embedded individually — not the whole article as one vector) for RAG/dedup reuse.
10. **Decay monitoring hook** — Cloudflare Cron feeds an Upstash-backed durable queue that periodically re-checks high-traffic/high-recency items and triggers update/decay alerts if verdicts change.

### RAG strategy

Using **Strategy 1**: build our own retrieval layer on top of our accumulated, self-verified claims corpus (pgvector), rather than attempting to index the open web ourselves. External APIs (fact-check DBs, news APIs, web search) remain the source of _raw_ retrieval; our own corpus is checked first and also injected as supplementary context for claims that are related-but-not-identical to past checks (two similarity thresholds: exact-dedup vs. related-context). This corpus compounds in value over time and is the core moat, distinct from raw retrieval infrastructure.
