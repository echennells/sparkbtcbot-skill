import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const itFunded = fundedMnemonic ? it : it.skip;

describe("funded lightning (REGTEST)", () => {
  let funded;
  let receiver;

  beforeAll(async () => {
    if (!fundedMnemonic) return;
    ({ wallet: funded } = await createTestWallet({ mnemonic: fundedMnemonic }));
    ({ wallet: receiver } = await createTestWallet());
  });

  afterAll(async () => {
    await cleanupAllWallets();
  });

  itFunded("estimates a Lightning send fee", async () => {
    const inv = await receiver.createLightningInvoice({
      amountSats: 1000,
      memo: "fee estimate target",
      expirySeconds: 600,
    });
    const fee = await funded.getLightningSendFeeEstimate({
      encodedInvoice: inv.invoice.encodedInvoice,
    });
    expect(fee).toBeDefined();
  });

  itFunded("pays a Lightning invoice (Spark-preferred routing)", async () => {
    const inv = await receiver.createLightningInvoice({
      amountSats: 1000,
      memo: "funded payment test",
      expirySeconds: 600,
      includeSparkAddress: true,
    });
    const payment = await funded.payLightningInvoice({
      invoice: inv.invoice.encodedInvoice,
      maxFeeSats: 10,
      preferSpark: true,
    });
    expect(payment).toBeDefined();
  });
});
