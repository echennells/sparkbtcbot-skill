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
npm install                 # runs the wasm patch automatically
npx wrangler login
npx wrangler deploy --minify
npx wrangler secret put SPARK_MNEMONIC   # 12 words
npx wrangler secret put AUTH_TOKEN       # chat access token
# optional: npx wrangler secret put OPENROUTER_API_KEY
```

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
