# Token Operations (BTKN / LRC20)

Load for any task involving Spark-native tokens — checking token balances, transferring, batch transfers. Spark supports tokens via the BTKN (LRC20) standard — they can represent stablecoins, points, or any fungible asset.

**Note on issuance:** the `@buildonspark/spark-sdk` (`SparkWallet`) only handles tokens you *receive* and *transfer*. Token *creation* (minting new tokens) requires `@buildonspark/issuer-sdk` (`IssuerSparkWallet`). See `references/extras.md` for issuance.

## Check Token Balances

```javascript
const { tokenBalances } = await wallet.getBalance();

for (const [id, info] of tokenBalances) {
  const meta = info.tokenMetadata;
  console.log(`${meta.tokenName} (${meta.tokenTicker}): ${info.ownedBalance.toString()}`);
  console.log(`  decimals:   ${meta.decimals}`);
  console.log(`  max supply: ${meta.maxSupply.toString()}`);
  console.log(`  available:  ${info.availableToSendBalance.toString()}`);
}
```

Each entry has `ownedBalance` (total) and `availableToSendBalance` (excludes pending outbound). For "what can I spend right now," use `availableToSendBalance`.

## Transfer Tokens

```javascript
const txId = await wallet.transferTokens({
  tokenIdentifier: "btkn1...",     // bech32m token id (btknrt1... on regtest)
  tokenAmount: 100n,               // BigInt
  receiverSparkAddress: "sp1p...",
});
console.log("Token transfer:", txId);
```

## Batch Transfer Tokens

Multiple recipients in a single transaction:

```javascript
const txIds = await wallet.batchTransferTokens([
  { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
]);
```

## Token Identifiers

Token identifiers are bech32m-encoded:
- Mainnet prefix: `btkn1...`
- Regtest prefix: `btknrt1...`

Decode programmatically with `decodeBech32mTokenIdentifier` from the SDK's exports.

## Token Optimization

Spark tokens consist of multiple outputs that can fragment over time. The wallet has a periodic optimizer that consolidates these:

```javascript
await wallet.optimizeTokenOutputs(); // manual consolidation
wallet.startPeriodicTokenOptimization(); // auto on a schedule
```

For most agent use cases the periodic optimizer is fine — manual calls are only needed for unusual usage patterns.
