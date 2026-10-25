# Production workflow comparison

Compared with Oxytype `dee1522bc59e57249d3eb324df5174885c4ae5b7`.

## Aligned deployment behavior

Both workflows deploy after successful main-push CI and validate that exact SHA again before
preparing credentials. Both allow manual main retries, including unchanged commits and
multiple deployments on one day. Neither publishes website GitHub releases, allocates release
tags, builds changelogs or edits package versions.

Both use read-only Contents/Actions permissions, checkout without persisted credentials,
serialized production jobs, one fresh Worker/client build, internal SHA/run/attempt identifiers,
artifact fingerprints, validation and dry-run before migrations, and always-run settings cleanup.
Both optimize D1 after migrations and verify read replication before Worker upload.
Node.js comes from `.node-version` (24.22.1); setup-vp is v1.22.0.

## Remaining differences

| Area                   | Tracera                                                                     | Oxytype                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime                | React, AI execution through Cloudflare Workflows, private R2                | SolidJS and a Rust typing engine with browser Wasm                                                                 |
| Build preparation      | JavaScript/TypeScript toolchain                                             | Additional pinned Rust, Wasm target/bindings and Rust cache setup                                                  |
| Settings inputs        | One private `PRODUCTION_WORKER_ENV` file                                    | Private backend settings, separate public frontend build settings, optional Better Auth dashboard key              |
| Client delivery        | Build identity and non-cacheable `/version.json`; no service worker         | Shared service-worker cache identity and preservation of previous public assets for old clients                    |
| Database reads         | Existing primary reads; deployment prepares replica availability            | Runtime Sessions API/bookmark routing in addition to replica activation                                            |
| Retired infrastructure | No task queue consumer                                                      | Idempotent cleanup of the retired task consumer before migrations and direct deploys                               |
| CI organization        | One full validation job, with networking denied during unit/browser suites  | Component routing for PRs, parallel/sharded jobs, Rust/Wasm and multi-build update checks; all jobs on main pushes |
| Staging deployment     | Existing staging build/deploy path plus optimization and replica activation | Separate staging artifact validation and the retired-consumer cleanup                                              |

The artifact format and resource checks differ because Tracera also validates its R2 and
Workflow bindings. Oxytype validates its Turnstile/auth-provider public inputs and other
application-specific bindings. Their application dependencies and bundle output remain different. Tracera also retains its
refusal to overwrite an existing private settings file and rejects symlinks or private
environment files in production artifacts.

Neither production workflow currently performs automatic post-deployment HTTP smoke checks or
automatic rollback. Tracera's hourly maintenance Cron remains an application trigger; it does
not schedule website releases.
