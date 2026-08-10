# Tracera

Tracera helps people assess news, claims, links, and images by tracing claims back to evidence instead of assigning one opaque score.

## What it does

- Normalizes text, links, and images into a common input.
- Splits a story into atomic, checkable claims.
- Finds the earliest known source ("Ground Zero") and retrieves corroborating or conflicting evidence.
- Produces claim verdicts, evidence-quality signals, and a multi-factor Tracera Score.
- Stores verified claims for future deduplication, related context, and re-checking.
- Searches both submitted stories and decomposed claims with PostgreSQL full-text search.

## Apps

| Package          | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `apps/web`       | Next.js web app, including auth and News Hub.                      |
| `apps/mobile`    | Expo / React Native app for iOS and Android.                       |
| `apps/api`       | Hono API, verification pipeline, auth, and scheduled decay checks. |
| `apps/extension` | Manifest V3 browser extension.                                     |
| `packages/ai`    | Provider-agnostic AI and retrieval pipeline.                       |
| `packages/db`    | Drizzle schema, migrations, and pgvector access.                   |

## Stack

Turborepo, pnpm, Next.js, Expo, Hono, Neon Postgres with pgvector, Upstash Redis, and Drizzle. AI generation and embeddings use a provider-neutral adapter layer supporting Gemini, OpenAI, OpenRouter, Anthropic, and OpenAI-compatible endpoints.

## Local setup

Requirements: Node 20.9+, pnpm 11.20.0, a deployed Neon PostgreSQL database with pgvector, Upstash Redis, a Clerk application, and an AI provider API key. Set `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, and `AI_EMBEDDING_MODEL` as Worker secrets before deploying the API. Anthropic generation requires a separate embeddings provider because Anthropic does not provide embeddings.

`AI_PROVIDER` accepts `gemini`, `openai`, `openrouter`, `anthropic`, or `openai-compatible`. The last option requires `AI_BASE_URL`; use the `AI_EMBEDDING_*` variables to use a different provider for embeddings.

```sh
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/mobile/.env.example apps/mobile/.env
cp apps/extension/.env.example apps/extension/.env
pnpm --filter @repo/db db:migrate
```

### Authentication

Clerk owns passwordless email verification and sessions on every platform.
Tracera keeps a local `users` row only as the owner of checks, alerts, and
report preferences. On the first authenticated API request, an existing local
row with the same email is linked to the Clerk user so prior Tracera data is
preserved.

In the Clerk Dashboard:

1. Enable email sign-up/sign-in with verification codes. Passwords are disabled
   so the same passwordless flow works on web, mobile, and the extension.
2. Enable Native API for Expo and the Chrome extension.
3. Copy the publishable key into the web, mobile, and extension environment
   files. Put the secret key and JWT public key only in the API environment.
4. Configure the web development/production origins and the extension's
   `chrome-extension://<ID>` as allowed origins.
5. Give the extension a stable Chrome ID, then set its Frontend API URL and
   public key in `apps/extension/.env`. The extension requests `cookies` and
   `storage`, as required by Clerk's Manifest V3 SDK.

The database migration removes Tracera's password hashes, account tokens, and
session table. Existing users must create or sign into their Clerk account with
the same email to reclaim their stored checks.

All web, mobile, and extension clients use the deployed API Worker at
`https://api.tracera.voltcrash.com`. Run the web and mobile development clients
in separate terminals:

```sh
pnpm dev
pnpm dev:mobile
```

`pnpm dev:mobile` starts an Expo tunnel for Expo Go. Check Worker readiness at
`https://api.tracera.voltcrash.com/health`.

## Verification pipeline

1. Normalize input and extract atomic claims.
2. Trace Ground Zero and retrieve sources from the claim corpus, fact-check APIs, news retrieval, and web search.
3. Weight source credibility and generate per-claim verdicts with auditable evidence.
4. Aggregate factual accuracy, corroboration, framing, evidence quality, source reputation, and recency into the Tracera Score.
5. Persist claims and embeddings for deduplication, related-context retrieval, and decay monitoring.

### Reanalysis policy

Exact submissions use an adaptive reuse window based on publication age: 2
hours for breaking stories, 6 hours for developing stories, 12 hours for
recent or undated text, and 24 hours for established stories. Uploaded images
without a publication date use a 6-hour window. Evidence is normally reviewed
again after 6, 12, 24, or 72 hours respectively; thin evidence and inconclusive
scores accelerate that review. `DEDUP_MAX_AGE_HOURS` is an operational cap on
reuse, not the product policy itself.

### Domain reputation refinement

High-confidence, high-evidence verdicts produce bounded domain-reputation
proposals after a trace is persisted. Proposals are always written to
`domain_trust_events`; they change the active score only when
`DOMAIN_TRUST_AUTO_REFINE=true` and the domain has accumulated at least five
signals. Each automatic change is capped at one percentage point per trace.

Editorial corrections use the internal
`POST /internal/domains/:domain/trust-review` endpoint with
`x-tracera-domain-admin-token`. Its required reason, previous score, reviewer,
and applied score are retained in the same audit trail. Inspect the history at
`GET /internal/domains/:domain/trust-history`.

### Public API

The versioned public API supports submitting text, links, and images, searching
public traces, and retrieving a completed trace. It requires API keys and
enforces shared per-minute and daily quotas through Upstash. The OpenAPI
document is served at `GET /v1/openapi.json`; setup and examples are in
[`docs/public-api.md`](docs/public-api.md).

## Checks

```sh
pnpm check-types
pnpm build
```

## Cloudflare deployment

The web and API applications deploy as independent Cloudflare Workers. The
API's hourly Cron Trigger feeds an Upstash ready/processing/dead-letter queue.
Processing leases, deduplicated jobs, crash recovery, and three-attempt
dead-lettering replace the former long-running BullMQ process while remaining
compatible with the Worker runtime.

Wrangler is installed as a project dependency, not globally. Authenticate with:

```sh
pnpm --filter api exec wrangler login
```

1. Create a Neon database with the `vector` extension enabled, then migrate it:

   ```sh
   export DATABASE_URL='postgresql://…'
   pnpm --filter @repo/db db:migrate
   ```

2. Create an Upstash Redis database and copy its `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` (not its TCP `REDIS_URL`).

3. Deploy the `tracera-api` Worker to its configured custom domain:

   ```sh
   pnpm run deploy:api
   ```

   Set its secrets in the Cloudflare dashboard or with `wrangler secret put
<NAME> --config apps/api/wrangler.jsonc`. Required values are
   `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
   `CLERK_SECRET_KEY`, `CLERK_JWT_KEY`, `INTERNAL_WORKER_TOKEN`, and the
   configured `AI_*` values. The Clerk JWT
   public key lets the Worker verify sessions locally without a Clerk API call.
   `INTERNAL_API_URL`, `WEB_ORIGIN`, and `PUBLIC_WEB_URL` are non-secret values
   pinned in Wrangler. The internal URL is used by the hourly decay trigger to
   invoke `/analyze`. Add the optional retrieval and Resend
   values from [`apps/api/.env.example`](apps/api/.env.example) as needed.

4. Build and deploy the web Worker with the API's public URL available at build
   time (Next.js exposes this value to the browser):

   ```sh
   export NEXT_PUBLIC_API_URL='https://api.tracera.voltcrash.com'
   export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...'
   pnpm run deploy:web
   ```

   Also set `TRACERA_API_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` on the web
   Worker. Point the API's `WEB_ORIGIN` and `PUBLIC_WEB_URL` at the deployed web
   custom domain after it is attached.

Run `pnpm --filter api dev` or `pnpm --filter web cf:preview` for Worker
previews. The Worker configuration intentionally contains no secrets.
