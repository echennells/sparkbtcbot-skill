# sparkbtcbot-skill

Claude Code skill for setting up Spark Bitcoin L2 wallet capabilities for AI agents.

## What is Spark?

Spark is a Bitcoin Layer 2 that lets you send and receive Bitcoin instantly with low fees. Spark-to-Spark transfers are free, and Lightning interop costs 0.15–0.25%. It is fully self-custodial — you hold your own keys via a BIP39 mnemonic — and fully interoperable with the Lightning Network. Spark currently has a small number of infrastructure providers (Signing Operators), so there is some risk of downtime, and it requires trusting that at least one operator behaves honestly during transfers.

## Why Spark for Agents?

- **Simple setup** — Generate a mnemonic and you have a wallet. No accounts, no API keys, no approval process.
- **No server required** — The SDK connects directly to the Spark network. No node to run, no infrastructure to maintain.
- **No channel management** — Unlike Lightning, there are no channels to open, fund, or rebalance. Just send and receive.
- **Low fees** — Spark-to-Spark transfers are free. Lightning payments cost 0.15–0.25%. Compare that to on-chain fees of 200+ sats or card processing at 2–3%.

## Capabilities

- **Wallet Setup** — Generate or import wallets from a BIP39 mnemonic
- **BTC Balance & Deposits** — Check balance, generate L1 deposit addresses, claim deposits
- **Spark Transfers** — Instant, zero-fee BTC transfers between Spark wallets
- **Lightning Invoices** — Create and pay BOLT11 invoices for Lightning compatibility
- **Spark Invoices** — Native invoices payable in sats or BTKN tokens
- **Token Operations** — Transfer BTKN/LRC20 tokens, batch transfers, token invoices
- **Withdrawal** — Cooperative exit back to L1 Bitcoin with fee estimation
- **Message Signing** — Prove identity via cryptographic signatures

## Installation

Clone into your Claude Code skills directory:

```bash
git clone https://github.com/echennells/sparkbtcbot-skill.git ~/.claude/skills/sparkbtcbot-skill
```

Or add the path to your Claude Code configuration.

## Quick Start

```bash
# Install dependencies (in the skill directory)
cd ~/.claude/skills/sparkbtcbot-skill
npm install

# Copy env template
cp .env.example .env

# Generate a new wallet
node examples/wallet-setup.js

# Add the generated mnemonic to .env, then:
node examples/balance-and-deposits.js
node examples/payment-flow.js
```

## Example Scripts

| Script | Purpose |
|--------|---------|
| `wallet-setup.js` | Generate new wallet or import from mnemonic |
| `balance-and-deposits.js` | Check balance (BTC + tokens), get deposit addresses |
| `payment-flow.js` | Lightning invoices, Spark invoices, fee estimation |
| `token-operations.js` | BTKN token balances, transfers, batch operations |
| `spark-agent.js` | Complete `SparkAgent` class with all capabilities |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPARK_MNEMONIC` | Yes* | BIP39 mnemonic (12 or 24 words). *`wallet-setup.js` can generate one. |
| `SPARK_NETWORK` | No | `MAINNET` (default), `REGTEST`, `TESTNET`, `SIGNET` |
| `SPARK_ACCOUNT_NUMBER` | No | BIP32 account index. Defaults: 1 (MAINNET), 0 (REGTEST) |

## Dependencies

```bash
npm install @buildonspark/spark-sdk dotenv
```

## Security

**Mnemonic = full wallet access.** A Spark mnemonic can do everything: check balance, create invoices, and send payments. There is no permission scoping, no spending limits, no read-only mode.

Recommendations:
- Never expose the mnemonic in code, logs, or version control
- Use environment variables for secrets
- Use a dedicated wallet with limited funds for each agent
- Use separate `accountNumber` values for different funding tiers
- Back up the mnemonic securely

## Resources

- [Spark Docs](https://docs.spark.money)
- [Spark SDK (npm)](https://www.npmjs.com/package/@buildonspark/spark-sdk)
- [Sparkscan Explorer](https://sparkscan.io)

## License

MIT
