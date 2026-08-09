# Tracera

Tracera helps people assess news, claims, links, and images by tracing claims back to evidence instead of assigning one opaque score.

## What it does

- Normalizes text, links, and images into a common input.
- Splits a story into atomic, checkable claims.
- Finds the earliest known source ("Ground Zero") and retrieves corroborating or conflicting evidence.
- Produces claim verdicts, evidence-quality signals, and a multi-factor Tracera Score.
- Stores verified claims for future deduplication, related context, and re-checking.

## Apps

| Package | Purpose |
| --- | --- |
| `apps/web` | Next.js web app, including auth and News Hub. |
| `apps/mobile` | Expo / React Native app for iOS and Android. |
| `apps/api` | Hono API, verification pipeline, auth, and scheduled decay checks. |
| `apps/extension` | Manifest V3 browser extension. |
| `packages/ai` | Provider-agnostic AI and retrieval pipeline. |
| `packages/db` | Drizzle schema, migrations, and pgvector access. |

## Stack

Turborepo, pnpm, Next.js, Expo, Hono, Neon Postgres with pgvector, Upstash Redis, and Drizzle. AI generation and embeddings use a provider-neutral adapter layer supporting Gemini, OpenAI, OpenRouter, Anthropic, and OpenAI-compatible endpoints.

## Local setup

Requirements: Node 18+, pnpm 11.20.0, PostgreSQL with pgvector, Redis, and an AI provider API key. Set `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, and `AI_EMBEDDING_MODEL` in `apps/api/.env` before starting the API. Anthropic generation requires a separate embeddings provider because Anthropic does not provide embeddings.

`AI_PROVIDER` accepts `gemini`, `openai`, `openrouter`, `anthropic`, or `openai-compatible`. The last option requires `AI_BASE_URL`; use the `AI_EMBEDDING_*` variables to use a different provider for embeddings.

```sh
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @repo/db db:migrate
```

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` to your Mac's current LAN IP, for example `http://192.168.1.40:3001`. Do not use `localhost` when testing on a phone.

Run the API, web app, and mobile app in separate terminals:

```sh
pnpm --filter api dev
pnpm dev
pnpm dev:mobile
```

`pnpm dev:mobile` starts an Expo tunnel for Expo Go. The phone still needs access to the API at the LAN address configured above. Check service readiness at `http://localhost:3001/health`.

## Verification pipeline

1. Normalize input and extract atomic claims.
2. Trace Ground Zero and retrieve sources from the claim corpus, fact-check APIs, news retrieval, and web search.
3. Weight source credibility and generate per-claim verdicts with auditable evidence.
4. Aggregate factual accuracy, corroboration, framing, evidence quality, source reputation, and recency into the Tracera Score.
5. Persist claims and embeddings for deduplication, related-context retrieval, and decay monitoring.

## Checks

```sh
pnpm check-types
pnpm build
```

## Cloudflare deployment

The web and API applications deploy as independent Cloudflare Workers. Mobile
and the browser extension remain unchanged. The API's hourly Cron Trigger
replaces the former long-running BullMQ process; Upstash is used over its REST
endpoint for distributed authentication rate limiting.

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

3. Deploy the API Worker once to establish its Worker URL:

   ```sh
   pnpm run deploy:api
   ```

   Set its secrets in the Cloudflare dashboard or with `wrangler secret put
   <NAME> --config apps/api/wrangler.jsonc`. Required values are
   `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
   `WEB_ORIGIN`, `PUBLIC_WEB_URL`, `INTERNAL_API_URL`,
   `INTERNAL_WORKER_TOKEN`, `COOKIE_SECURE=true`, and the configured `AI_*`
   values. `INTERNAL_API_URL` is the deployed API URL and is used by the hourly
   decay trigger to invoke `/analyze`. Add the optional retrieval and Resend
   values from [`apps/api/.env.example`](apps/api/.env.example) as needed.

4. Build and deploy the web Worker with the API's public URL available at build
   time (Next.js exposes this value to the browser):

   ```sh
   export NEXT_PUBLIC_API_URL='https://tracera-api.<account>.workers.dev'
   pnpm run deploy:web
   ```

   Also set `TRACERA_API_URL` on the web Worker to the same API URL; it is used
   only by the server-side `/api/health` route. Point the API's `WEB_ORIGIN` and
   `PUBLIC_WEB_URL` at the deployed web custom domain after it is attached.

Run `pnpm --filter api cf:dev` or `pnpm --filter web cf:preview` for local
Workers previews. The Worker configuration intentionally contains no secrets.
