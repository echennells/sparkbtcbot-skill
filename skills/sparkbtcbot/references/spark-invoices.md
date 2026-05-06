# Spark Native Invoices

Load when working with Spark's native invoice format (distinct from BOLT11 Lightning invoices). Spark invoices can request payment in sats or in tokens.

## Create Sats Invoice

```javascript
const invoice = await wallet.createSatsInvoice({
  amount: 1000,
  memo: "Spark native payment",
});
```

## Create Token Invoice

```javascript
const invoice = await wallet.createTokensInvoice({
  amount: 100n,
  tokenIdentifier: "btkn1...",
  memo: "Token payment request",
});
```

## Fulfill (Pay) a Spark Invoice

`fulfillSparkInvoice` accepts an array — one or many invoices in a single batch:

```javascript
const result = await wallet.fulfillSparkInvoice([
  { invoice: "sp1...", amount: 1000n },
]);

for (const success of result.satsTransactionSuccess) {
  console.log("Paid:", success.invoice);
}
for (const err of result.satsTransactionErrors) {
  console.log("Failed:", err.invoice, err.error.message);
}
```

For token invoices the result has `tokenTransactionSuccess` / `tokenTransactionErrors` arrays of the same shape.

## Spark Invoice Embedded in BOLT11

When you create a Lightning invoice with `includeSparkAddress: true`, the resulting BOLT11 carries the Spark address in route hints. Spark-aware payers can detect this and route via Spark (instant, free) instead of paying Lightning routing fees. The recipient can call `getLightningReceiveRequest(id)` and read `sparkInvoice` to get the embedded Spark invoice directly without decoding the BOLT11 manually.
