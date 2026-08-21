# Security Policy

## Reporting a Vulnerability

If you find a security issue in `sparkbtcbot`, **please do not open a public GitHub issue.**

Email **eric@brodie.rocks** with:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- The affected version (`npm view sparkbtcbot-skill version` or commit SHA)
- Your assessment of severity, if you have one

You should expect an acknowledgement within 7 days. I'll work with you on a fix and coordinate disclosure timing before any public write-up.

## Scope

In scope:

- The npm package `sparkbtcbot-skill` — encryption helpers (`lib/encrypted-seed.js`), the skill content shipped to LLM agents, the example scripts in `skills/sparkbtcbot/scripts/`. (The `sparkbtcbot` package is only the name-reservation stub described below; it contains no wallet code.)
- Anything that could cause a mnemonic, passphrase, or decrypted seed to leak to disk, logs, network, or process output where the skill's own docs say it won't.
- Anything that could cause an agent following the skill's instructions to send funds to an address other than the one the user/code specified.

Out of scope:

- Vulnerabilities in `@buildonspark/spark-sdk` or other upstream dependencies — report those to the respective project. (If a dependency issue is being amplified by how the skill uses it, that *is* in scope.)
- Spark protocol or Signing Operator issues — report to the Spark team.
- Social engineering, phishing, or attacks that require the user's passphrase to already be compromised.

## What the Threat Model Assumes

The skill is built around two assumptions; issues that violate either are in scope:

1. The encrypted seed file (`~/.spark/seed.enc`) is useless without the passphrase, and vice versa.
2. The runtime never writes the plaintext mnemonic, passphrase, or decrypted seed to disk, logs, stdout, or any file the agent reads back into its context.

See `skills/sparkbtcbot/references/encrypted-seed.md` for the full threat model.

## Registry Name Reservations

`npx <cmd>` resolves the string you type as an npm package name, so any command name this project
has ever documented is a potential landing spot for a squatter if it is unregistered. The current
CLI is a single bin, `sparkbtcbot`, and that npm name is **owned by this project** — the
`stub/sparkbtcbot/` reservation package, which only prints an error and exits 1. A
wrong-directory `npx sparkbtcbot ...` therefore lands on our code.

The five per-command bins retired in 0.6.0 — `sparkbtcbot-setup`, `sparkbtcbot-reveal-mnemonic`,
`sparkbtcbot-leaf-vault`, `sparkbtcbot-set-policy`, `sparkbtcbot-reset-ledger` — are **also owned
by this project** (`stub/sparkbtcbot-*/`), each a reservation stub that prints the
`sparkbtcbot <subcommand>` migration and exits 1. They needed claiming separately: npx resolves
each string as its own package name, so the `sparkbtcbot` stub does not cover them.

0.6.2 recorded the opposite decision — that leaving them unclaimed was acceptable because no living
doc emits those names (enforced by `docs-lint`). That reasoning missed the reader this project
actually has. The retired names were the documented form throughout 0.4.x–0.5.x, so they sit in
model weights and agent memory, and an agent acting from recall never reads the SKILL.md rule that
would stop it. Since npx does not prompt without a TTY, a recalled name in a tool call installs and
executes silently. Owning the name is the only control that operates at resolution time rather than
upstream of a model's choice of what to type.

This is bounded, not comprehensive: it covers the names actually shipped and documented, not
arbitrary misspellings. **If a future release retires another bin name, claim it** — the collapse
of a name into a subcommand does not remove it from the registry's namespace.

## Supported Versions

Only the latest published version on npm receives security fixes. The project is pre-1.0; pin a version if you need stability.
