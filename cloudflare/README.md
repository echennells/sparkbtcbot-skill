# sparkbtcbot on Cloudflare Workers

A single free-plan Worker that serves a chat UI, runs an LLM agent loop, and
holds a Spark L2 Bitcoin wallet — the "deploy to Cloudflare" distribution of
sparkbtcbot. Not the skill itself: the skill's flows and guardrails are
compiled into fixed tools (see *Architecture*).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/echennells/sparkbtcbot-worker)

> The button points at [echennells/sparkbtcbot-worker](https://github.com/echennells/sparkbtcbot-worker),
> a standalone mirror of this directory (same tree, app at repo root). Cloudflare's
> deploy-button cloner silently drops the source files when pointed at a
> subdirectory of a branch (reproduced twice, 2026-08-11: the copy repo contained
> only README + wrangler.jsonc and a placeholder worker was deployed) — a dedicated
> root-level repo is the shape it handles. Keep the mirror in sync after changes
> here: recreate the root-level commit (`git commit-tree "refs/heads/<branch>:cloudflare"`)
> and push it to the mirror's `main`.

**New here? That button is the whole setup:** it copies this app into your own
GitHub account, deploys it to your own (free) Cloudflare account, and gives
you a personal `*.workers.dev` URL. Set the `CLAIM_CODE` secret when the flow
asks (any string — it's your one-time setup code). Then open your worker's
URL: enter the claim code, pick a password, write down the 12 recovery words
it shows you — and you're chatting with your own Bitcoin wallet bot. Nobody
else (including this repo's author) ever touches your keys.

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

**Deploy-button behavior** (validated on a real button deploy, 2026-08-15):
deploying from this standalone repo applies the full wrangler config with
zero dashboard clicks — workers.dev URL enabled, cron trigger registered,
Workers Logs on, wasm patch run by the build's `postinstall`. (Historical
note: pointing the button at a *subdirectory of a branch* breaks Cloudflare's
cloner — the copy repo gets only README + wrangler.jsonc and a placeholder
worker deploys. That's why this standalone mirror exists; don't restructure
it back into the monorepo.)

Then open the Worker URL: the **first-boot wizard** is one screen — enter the
claim code, done (no password to invent: the claim code doubles as the
fallback login, checked live against the secret so it's rotatable from the
dashboard — make it strong). The wizard then offers **passkey enrollment**
(Face ID / Touch ID / device PIN) for daily login, and shows the freshly
client-side-generated 12 words once (write them down); an existing mnemonic
can be imported from the "advanced" disclosure instead. Seed + credentials +
session secret live in a SQLite Durable Object (encrypted at rest,
dashboard-unreadable, free plan). After the claim the wizard is gone forever;
login is passkey-first with the claim code (or a legacy password) as
fallback, minting a 30-day session cookie. Auth ladder: claim code proves the
deployer at deploy time → passkey binds the device → the 12 paper words are
the ultimate recovery.

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

## Unilateral-exit backup (leaf-vault)

A Spark seed alone cannot unilaterally exit — exit needs the tree of pre-signed
txs the operators hand the wallet at claim/transfer time. The Worker keeps a
continuously-fresh `spark.unilateral-exit-bundle.v1` bundle (the same format
Blink's [spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit)
recovery CLI consumes) in the Durable Object:

- **cron** (`*/20 * * * *`) snapshots the leaf material; every bundle is
  gate-proven before storage (shape-validated + every leaf's exit chain
  rebuilds offline to a root with its pre-signed txs)
- a snapshot also runs right **after any send** (via `waitUntil`, off the
  response path)
- shrink/identity/network guards prevent a partial capture or a different
  wallet from silently replacing the only good bundle; persistent failures
  surface as `broken: true` in status
- `GET /api/leaf-vault` downloads the bundle, `GET /api/leaf-vault/status`
  reports freshness/health, `POST /api/leaf-vault/snapshot` forces a capture
  (all session-gated); the chat header's **backup** link wraps the download

Download the bundle periodically (or after big balance changes) and keep it
with the mnemonic — if the operators ever vanish, the pair is what Blink's
tool needs to broadcast the exit. `src/leaf-vault.js` is the Worker port of
`skills/sparkbtcbot/scripts/leaf-vault.js`; the cooperative-exit-window excuse
is not ported because this Worker has no withdraw tool yet.

## Security model

Worker secrets are encrypted at rest and write-only via dashboard/API, but
anyone who can deploy code to the Cloudflare account can exfiltrate them —
account access ≈ wallet access. Use a dedicated wallet with limited funds,
same as every sparkbtcbot deployment.
