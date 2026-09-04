# Tracera web

The Next.js client for Tracera. It is exported as a static site and deployed
alongside the Hono server in a single Vercel project, so browser requests to
`/api/auth/*` and `/api/tracera/*` stay on the same origin.

From the repository root:

```sh
vp run web#dev
```

Set `NEXT_PUBLIC_SERVER_ORIGIN` when the Hono server runs on a different port
during local development.
