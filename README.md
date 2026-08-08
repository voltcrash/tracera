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
| `apps/api` | Hono API, verification pipeline, auth, and background jobs. |
| `apps/extension` | Manifest V3 browser extension. |
| `packages/ai` | Provider-agnostic AI and retrieval pipeline. |
| `packages/db` | Drizzle schema, migrations, and pgvector access. |

## Stack

Turborepo, pnpm, Next.js, Expo, Hono, PostgreSQL with pgvector, Redis/BullMQ, and Drizzle. AI generation and embeddings use hosted provider APIs; Gemini is the configured adapter.

## Local setup

Requirements: Node 18+, pnpm 11.20.0, PostgreSQL with pgvector, Redis, and a Gemini API key. Set `GEMINI_API_KEY` in `apps/api/.env` before starting the API.

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
