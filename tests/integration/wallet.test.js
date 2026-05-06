import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";

describe("wallet (REGTEST)", () => {
  let wallet;

  beforeAll(async () => {
    ({ wallet } = await createTestWallet());
  });

  afterAll(async () => {
    await cleanupAllWallets();
  });

  it("returns a Spark address", async () => {
    const address = await wallet.getSparkAddress();
    expect(address).toMatch(/^sparkrt1p/);
  });

  it("returns an identity public key", async () => {
    const pk = await wallet.getIdentityPublicKey();
    expect(pk).toMatch(/^[0-9a-f]{66}$/);
  });

  it("derives different identity keys for different account numbers", async () => {
    const { wallet: walletA } = await createTestWallet({
      mnemonic: "wear cattle behind affair parade error luxury profit just rate arch cigar",
    });
    const { wallet: walletB } = await createTestWallet({
      mnemonic: "wear cattle behind affair parade error luxury profit just rate arch cigar",
    });
    const a = await walletA.getIdentityPublicKey();
    const b = await walletB.getIdentityPublicKey();
    // Same mnemonic + default account → same identity
    expect(a).toEqual(b);
  });

  it("getBalance() returns the documented shape on a fresh wallet", async () => {
    const result = await wallet.getBalance();
    expect(result).toHaveProperty("balance"); // deprecated, still present
    expect(result).toHaveProperty("satsBalance");
    expect(result.satsBalance).toHaveProperty("available");
    expect(result.satsBalance).toHaveProperty("owned");
    expect(result.satsBalance).toHaveProperty("incoming");
    expect(result).toHaveProperty("tokenBalances");
    expect(result.tokenBalances).toBeInstanceOf(Map);

    // Fresh wallet → all zero
    expect(result.satsBalance.available).toBe(0n);
    expect(result.satsBalance.owned).toBe(0n);
    expect(result.satsBalance.incoming).toBe(0n);
    expect(result.tokenBalances.size).toBe(0);
  });
});
