# sparkbtcbot on Cloudflare Workers

A single free-plan Worker that serves a chat UI, runs an LLM agent loop, and
holds a Spark L2 Bitcoin wallet — the "deploy to Cloudflare" distribution of
sparkbtcbot. Not the skill itself: the skill's flows and guardrails are
compiled into fixed tools (see *Architecture*).

**Status:** working spike promoted to a product branch. Live-validated on
mainnet: balance, addresses, receive+claim, Lightning invoice creation.
Untested: FROST signing with funds (first funded send). See the repo memory /
commit history for the full spike findings.

## Architecture

- `src/index.js` — router, agent loop, wallet tool implementations, HTML pages.
- `patch-sdk-wasm.js` — **required** build step (runs on `postinstall`). The
  SDK's browser build inlines its two wasm blobs as base64 and instantiates
  them from bytes at runtime; Workers forbids that (dynamic codegen). The patch
  rewrites the entry to static `.wasm` imports, which arrive as precompiled
  `WebAssembly.Module`s. `--no-tokens` stubs the token-primitives wasm so the
  bundle fits the free plan's 3 MiB gzip cap (BTKN ops need the paid plan).
- Model: any Workers AI model (`@cf/...`, free daily allocation) or any
  OpenRouter model when `OPENROUTER_API_KEY` is set. Configured via `MODEL`.

## Deploy (manual, until the deploy-button template ships)

```bash
npm install                  # postinstall runs the wasm patch; if your npm has
                             # ignore-scripts=true, run: npm run patch-sdk
npx wrangler login
npx wrangler deploy --minify
npx wrangler secret put CLAIM_CODE   # one-time setup code (any string)
```

Then open the Worker URL: the **first-boot wizard** asks for the claim code,
generates the 12 words client-side (shown once, quiz-confirmed) or imports an
existing mnemonic, and sets the login password. Seed + password hash + session
secret live in a SQLite Durable Object (encrypted at rest, dashboard-unreadable,
free plan). After the claim the wizard is gone forever; the page becomes
password login + 30-day session cookie.

Optional: paste an OpenRouter key in the wizard (or set the
`OPENROUTER_API_KEY` secret) to use non-`@cf/` models; otherwise the `MODEL`
var must be a free Workers AI model.

Legacy note: deployments that still have the old `AUTH_TOKEN` secret can use
it as the claim code (`CLAIM_CODE` falls back to it); the old `SPARK_MNEMONIC`
secret is ignored once the DO is claimed — import those words through the
wizard, then delete both secrets.

## Guardrails (enforced in code, not prompt)

- `SPARK_MAX_SEND_SATS` (default 5000) per-transaction cap
- `SPARK_MAX_LN_FEE_SATS` (default 50) Lightning fee cap
- send/pay tools refuse without `confirm: true`, which the system prompt only
  permits after an explicit user "yes" in the conversation
- the seed is never readable: Worker secrets are write-only, and no tool
  touches the mnemonic

## Security model

Worker secrets are encrypted at rest and write-only via dashboard/API, but
anyone who can deploy code to the Cloudflare account can exfiltrate them —
account access ≈ wallet access. Use a dedicated wallet with limited funds,
same as every sparkbtcbot deployment.
