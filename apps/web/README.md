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

## Structure

- `src/app` contains the App Router routes and Next.js file conventions.
- `src/app/(marketing)`, `src/app/(auth)`, and `src/app/(workspace)` use route groups to organize sections without changing public URLs.
- Route-specific UI is colocated in private `_components` folders; shared UI lives in `src/components` by domain.
- `src/lib` contains browser-side utilities and clients, while `src/server` contains the Hono application mounted by the catch-all route.
- `public` contains static assets and `test` contains server and integration tests.
