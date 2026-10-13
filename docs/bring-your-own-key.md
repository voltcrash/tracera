# Bring your own AI key

Section 7 of the migration plan is implemented in source. Hosted activation requires the
new D1 migration, an environment-specific encryption secret, and explicit analysis bounds.
The existing deployment workflow applies pending D1 migrations before publishing a Worker.

## Provider settings

Signed-in users manage their keys under **Settings → AI provider**. Gemini, OpenAI,
Anthropic, OpenRouter, and public OpenAI-compatible HTTPS endpoints are supported. Model
names are explicit: choose a generation model with structured output support, image support
when analyzing screenshots, and an embedding model that supports 1024 dimensions.

Anthropic requires a separate embedding provider and key. Other providers may use either
their generation key or a separate personal embedding key. Personal runs never borrow the
platform's generation or embedding credentials.

Saving performs a generation request capped at one output token and one short embedding
request, with a shared 15-second timeout. The provider may charge for verification. This
checks credential and model access and embedding dimensions; it does not establish full
analysis quality or every generation capability. Both checks must succeed before storage
changes. Rejected or unavailable credentials preserve the existing saved key.

One key can be saved per provider, and one provider is active per account. Saving makes it
active; other saved providers remain inactive and can be selected with **Use key**. Only
metadata and the last four generation-key characters are returned. Password inputs are
cleared after a successful save; keys are not kept in browser storage or account caches.

When no personal key is active, new runs use the platform configuration if it is complete.
A queued personal run retains its provider and model identity: deleting or switching its
key cannot silently charge platform credentials. A provider 401 or 403 ends the run without
retrying and directs the user to update their key in Settings.

## Encryption setup

Generate independent keyrings for local development, staging, and production. This command
creates a new mode-0600 dotenv file, prints no key material, and refuses to overwrite a file:

```sh
vp run web#provider-keys:generate-secret /PRIVATE_DIR/tracera-staging-byok.env
vp run web#provider-keys:generate-secret /PRIVATE_DIR/tracera-production-byok.env
```

Add the generated `PROVIDER_KEYS_ENCRYPTION_KEY` line to the matching ignored private Worker
settings file. Keep the existing auth secret and OAuth credentials. Upload the keyring as a
Worker secret through the existing deployment process; it must not be a Wrangler var or be
committed. Local Settings accepts personal keys after this secret is added to `.dev.vars`.
Use `vp run dev:live` when personal credentials should power local analyses; fixture mode
continues to run offline.

The secret format is JSON with an active positive integer version and a map of base64
AES-256 keys. For example, with placeholders rather than usable key material:

```json
{
  "activeVersion": 1,
  "keys": { "1": "BASE64_ENCODED_32_RANDOM_BYTES" }
}
```

Each save uses AES-GCM, a fresh random 12-byte IV, and authenticated data containing the
user ID, provider, and encryption version. D1 stores ciphertext, IV, version, preferences,
fingerprint, status, and usage times. Deleting an account deletes its keys. The admission
request reads metadata only; stored credentials are decrypted inside the Workflow's provider
step and stay out of parameters, step results, run rows, reports, and logs.

Preserve the keyring across deployments. To rotate, add a newly generated 32-byte key under
a new version, retain the old entries, and advance `activeVersion`. New saves use that
version; existing rows remain readable under retained versions. Re-save keys to replace
their ciphertext with the active version. Do not remove an old version while rows or D1
recovery snapshots still need it. Production checks reject malformed retained entries and
any encryption material shared with staging, including differently formatted or renumbered
keyrings.

## Runtime controls and rollout

BYOK-only deployments may omit every platform provider credential and
`AI_DAILY_SPEND_LIMIT_USD`. They still require all eight `ANALYSIS_MAX_*` run bounds and the
three positive `AI_ESTIMATED_*_COST_USD` estimates in [Cloudflare operations](cloudflare-operations.md#run-and-spend-bounds).
The cost bound uses these estimates and does not guarantee a provider's invoice. Optional
evidence-source credentials remain independent of personal AI keys.

Personal runs skip the platform spend circuit and daily AI quota. User/IP rate limits,
concurrency, forced-reanalysis cooldown, idempotency, and per-run bounds still apply. Custom
generation and embedding endpoints require HTTPS and public DNS answers through `safeFetch`.
Provider requests reject redirects before credentials can move to another endpoint or to HTTP.

Prepare the private configuration and run the existing preflight before hosted activation:

```sh
vp check
vp test --run
vp run check-types
vp run web#deploy:staging-dry-run
vp run deploy:production-dry-run
```

Apply migration `0002_right_meteorite.sql` before running the new Worker. The normal staging
deploy and production release workflow already apply pending migrations. Validate a real
provider on staging with a private user key before enabling hosted use; synthetic tests do
not establish account billing, provider availability, or live analysis quality.

Without the encryption secret, Settings shows personal key entry as unavailable and platform
analysis keeps its existing behavior. Removing the secret after users have saved active keys
makes their personal runs unavailable until the keyring is restored; it does not substitute
platform credentials for those runs.
