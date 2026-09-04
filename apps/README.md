# Tracera web

The whole of Tracera: the Next.js client plus the Hono server it mounts at
`/api/*`. Better Auth answers at `/api/auth/*` and the application API at
`/api/tracera/*`, always on the same origin as the pages.

From the repository root:

```sh
vp run --filter web dev
```

Copy `.env.example` to `.env` and fill in the database, auth, and AI provider
values before running the server routes.
