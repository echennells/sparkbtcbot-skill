# sparkbtcbot-skill

Claude Code skill for setting up Spark Bitcoin L2 wallet capabilities for AI agents.

**Installation:** Clone to `~/.claude/skills/sparkbtcbot-skill`

## What This Skill Does

Teaches Claude Code how to give AI agents Bitcoin capabilities using the Spark L2:

1. **Initialize Wallet** — Create or import a BIP39 mnemonic-based wallet
2. **Check Balance** — Query BTC and token balances
3. **Receive Deposits** — Generate L1 Bitcoin deposit addresses
4. **Transfer BTC** — Instant, zero-fee Spark-to-Spark transfers
5. **Lightning Invoices** — Create and pay BOLT11 invoices (Lightning Network interop)
6. **Spark Invoices** — Native Spark invoices payable in sats or tokens
7. **Token Operations** — Transfer BTKN/LRC20 tokens natively
8. **Withdraw to L1** — Cooperative exit back to on-chain Bitcoin
9. **Message Signing** — Sign and verify messages for identity proof

## Structure

```
skills/
  sparkbtcbot/
    SKILL.md              # Main knowledge base
examples/
  wallet-setup.js         # Generate/import wallet
  balance-and-deposits.js # Balance + deposit addresses
  payment-flow.js         # Lightning + Spark payments
  token-operations.js     # BTKN token operations
  spark-agent.js          # Complete SparkAgent class
.env.example              # Environment variable template
```

## Trigger Phrases

Activates when user mentions: "Spark wallet", "Spark Bitcoin", "Spark L2", "BTKN tokens", "Spark SDK", "Spark payment", "Spark transfer", "Spark invoice", "Bitcoin L2 wallet", "agent wallet on Spark"

## Dependencies

```bash
npm install @buildonspark/spark-sdk dotenv
```

## Environment Variables

```bash
SPARK_MNEMONIC=<BIP39 mnemonic>
SPARK_NETWORK=MAINNET
```

## Security Note

A Spark mnemonic grants full wallet access (no permission scoping like NWC). Use dedicated wallets with limited funds for agents. See SKILL.md for full security guidance.
