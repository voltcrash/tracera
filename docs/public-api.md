# Tracera Public API v1

The public API exposes completed public traces and accepts new public analysis
requests. It is intended for server-to-server use. Every data endpoint requires
an API key in `x-api-key`; the OpenAPI document is available without a key at
`GET /api/tracera/v1/openapi.json`.

The base URL is `https://tracera.voltcrash.com/api/tracera`.

## Authentication

Set one or more comma-separated secrets in `PUBLIC_API_KEYS`. Multiple
keys support rotation without downtime. `PUBLIC_API_KEY` remains accepted as a
single-key compatibility setting. Do not place API keys in browser code.

## Analyze a submission

Send exactly one of `text`, `url`, or `image`:

```sh
curl https://tracera.voltcrash.com/api/tracera/v1/checks \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_API_KEY' \
  --data '{"url":"https://example.com/news/story"}'
```

The endpoint returns `201` for a newly completed trace and `200` when an
identical recent trace is reused under the adaptive reanalysis policy. Analysis
results include atomic claims, verdict confidence, evidence quality, the
multi-dimensional Tracera Score, Ground Zero, and the next review time.

## Search and retrieve

```sh
curl -H 'x-api-key: YOUR_API_KEY' \
  'https://tracera.voltcrash.com/api/tracera/v1/checks?q=climate&page=1&pageSize=20'

curl -H 'x-api-key: YOUR_API_KEY' \
  'https://tracera.voltcrash.com/api/tracera/v1/checks/CHECK_UUID'
```

Search uses PostgreSQL full-text indexes across both original submissions and
their atomic claims. Private user traces are never exposed through `/v1`.

The API is versioned in its URL. Backward-incompatible request or response
changes will be released under a new version rather than silently changing v1.
