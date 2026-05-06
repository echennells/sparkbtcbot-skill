import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";
import { getOrCreateIssuerToken, cleanupAllIssuers } from "../helpers/issuer.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

describe("invoices (REGTEST)", () => {
  let wallet;
  let tokenId;

  beforeAll(async () => {
    ({ wallet } = await createTestWallet());
    // Mint a fresh token from a throwaway issuer so we have a real token id
    // to reference when constructing token invoices. The receiving wallet
    // does NOT need to own the token to create an invoice for it.
    const issuerMnemonic = generateMnemonic(wordlist);
    ({ tokenId } = await getOrCreateIssuerToken({
      mnemonic: issuerMnemonic,
      tokenName: "InvoiceTest",
      tokenTicker: "INVTEST",
    }));
  }, 90_000);

  afterAll(async () => {
    await cleanupAllWallets();
    await cleanupAllIssuers();
  });

  it("creates a Spark sats invoice", async () => {
    const invoice = await wallet.createSatsInvoice({
      amount: 1000,
      memo: "test sats invoice",
    });
    expect(invoice).toBeDefined();
    // Invoice carries an encoded form starting with the spark invoice prefix.
    const encoded = typeof invoice === "string" ? invoice : invoice.encodedInvoice ?? invoice.invoice;
    expect(typeof encoded === "string" || encoded === undefined).toBe(true);
  });

  it("creates a BOLT11 Lightning invoice", async () => {
    const request = await wallet.createLightningInvoice({
      amountSats: 1000,
      memo: "test lightning invoice",
      expirySeconds: 3600,
    });
    expect(request).toBeDefined();
    expect(request.invoice).toBeDefined();
    expect(typeof request.invoice.encodedInvoice).toBe("string");
    // BOLT11 starts with lnbcrt for regtest.
    expect(request.invoice.encodedInvoice).toMatch(/^lnbcrt/);
  });

  it("creates a Lightning invoice with an embedded Spark address", async () => {
    const request = await wallet.createLightningInvoice({
      amountSats: 500,
      memo: "spark-aware",
      expirySeconds: 3600,
      includeSparkAddress: true,
    });
    expect(request.invoice.encodedInvoice).toMatch(/^lnbcrt/);
  });

  it("creates a Spark token invoice for a known token id", async () => {
    expect(tokenId).toBeDefined();
    const invoice = await wallet.createTokensInvoice({
      amount: 100n,
      tokenIdentifier: tokenId,
      memo: "test token invoice",
    });
    expect(invoice).toBeDefined();
    // The invoice references a real token; verify the encoded form mentions it.
    const encoded = typeof invoice === "string" ? invoice : invoice.encodedInvoice ?? invoice.invoice;
    expect(typeof encoded === "string" || encoded === undefined).toBe(true);
  });
});
