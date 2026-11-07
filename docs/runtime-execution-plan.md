# Runtime execution plan

Admission saves a versioned, secret-free execution plan beside the input, seed, and
admission identity. The existing immutable input hash covers the plan in D1 or R2.
Run context keeps ownership, budgets, provider identity, and engine/model versions.

| Phase                 | Transition                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Admission             | Validate supported provider routes and save the selected plan before launching the Workflow     |
| Resume                | Read the immutable input and validate plan schema, mode, versions, and context                  |
| Credential resolution | Bind current platform secrets to matching saved routes, or load the saved personal-key revision |
| Execution             | Construct only the saved capabilities and enforce current safety limits                         |
| Unavailable           | Fail once with `execution_plan_unavailable`; release admission through normal settlement        |

The live plan records generation and embedding providers, models, HTTPS base URLs,
embedding dimensions and credential slot, cost-estimate floors, and enabled discovery
services. It contains no API keys. Endpoint credentials, query strings, and fragments
are rejected. Gemini records its fixed Google endpoint because its adapter does not
support a base-URL override.

Changing model environment variables does not change an admitted run. Platform key
rotation is allowed when the provider and route still match. A changed route, removed
required credential, revoked personal revision, unsupported version, or missing live
plan requires a new run. Adding a separate embedding provider or discovery key does
not add that capability to an existing run. Personal revisions retain their existing
owner-scoped revocation and request-admission checks.

Execution uses the greater of each saved estimate and the current operator estimate.
The current platform daily spend cap must remain explicitly positive; it is not frozen
in the plan. Run budgets and durable request/spend reservations continue to apply.

Permanent provider request rejections (HTTP 400, 404, 405, 413, 415, and 422) latch an
unavailable result so engine error handling or a later bookkeeping failure cannot
send the same request again. Transient failures retain bounded Workflow retries.
Personal-key authentication failures keep their distinct rejection state.

Owner cancellation and already-prepared report publication retain precedence over
plan loading. A missing plan is supported only for known-version local fixture runs;
an explicitly malformed plan is rejected. No live plan is reconstructed from current
environment settings. Failed runs show restart guidance in both streamed progress and
the stored report page, without exposing provider responses or configuration details.
