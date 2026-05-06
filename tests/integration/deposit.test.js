import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";

describe("deposit addresses (REGTEST)", () => {
  let wallet;

  beforeAll(async () => {
    ({ wallet } = await createTestWallet());
  });

  afterAll(async () => {
    await cleanupAllWallets();
  });

  it("returns an L1 static deposit address", async () => {
    const addr = await wallet.getStaticDepositAddress();
    expect(typeof addr).toBe("string");
    expect(addr.length).toBeGreaterThan(20);
  });

  it("returns a single-use deposit address distinct from the static one", async () => {
    const staticAddr = await wallet.getStaticDepositAddress();
    const single = await wallet.getSingleUseDepositAddress();
    expect(typeof single).toBe("string");
    expect(single).not.toEqual(staticAddr);
  });

  it("static deposit address is reusable (same value across calls)", async () => {
    const a = await wallet.getStaticDepositAddress();
    const b = await wallet.getStaticDepositAddress();
    expect(a).toEqual(b);
  });
});
