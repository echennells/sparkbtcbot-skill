# sparkbtcbot-skill

Claude Code skill for setting up Spark Bitcoin L2 wallet capabilities for AI agents.

## What is Spark?

Spark is a Bitcoin Layer 2 built on threshold cryptography (FROST). It enables instant, zero-fee BTC and token transfers with full self-custody via a BIP39 mnemonic. Spark wallets also interoperate with the Lightning Network.

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

**Mnemonic = full wallet access.** Unlike NWC which supports permission scoping and spending limits, a Spark mnemonic can do everything: check balance, create invoices, and send payments. There is no read-only mode.

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
