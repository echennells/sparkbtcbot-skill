import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";

// Important: validateMessageWithIdentityKey on the SparkWallet validates
// the signature against the *calling wallet's own* identity key. There is
// no parameter for "verify against an arbitrary public key" — for that you
// would use @noble/curves/secp256k1 verify() directly. These tests pin the
// actual API behavior so the skill examples can't drift back into the
// 3-argument pattern that silently ignores the public key.
describe("message signing (REGTEST)", () => {
  let walletA;
  let walletB;

  beforeAll(async () => {
    ({ wallet: walletA } = await createTestWallet());
    ({ wallet: walletB } = await createTestWallet());
  });

  afterAll(async () => {
    await cleanupAllWallets();
  });

  it("validates a signature created by the same wallet", async () => {
    const sig = await walletA.signMessageWithIdentityKey("hello regtest");
    const valid = await walletA.validateMessageWithIdentityKey("hello regtest", sig);
    expect(valid).toBe(true);
  });

  it("rejects a signature when validated by a different wallet", async () => {
    const sig = await walletA.signMessageWithIdentityKey("cross-wallet check");
    // walletB.validate uses walletB's identity key → cannot verify walletA's signature.
    const valid = await walletB.validateMessageWithIdentityKey("cross-wallet check", sig);
    expect(valid).toBe(false);
  });

  it("rejects a signature when the message was altered", async () => {
    const sig = await walletA.signMessageWithIdentityKey("original");
    const valid = await walletA.validateMessageWithIdentityKey("tampered", sig);
    expect(valid).toBe(false);
  });

  it("supports compact signatures", async () => {
    const sig = await walletA.signMessageWithIdentityKey("compact form", true);
    const valid = await walletA.validateMessageWithIdentityKey("compact form", sig);
    expect(valid).toBe(true);
  });
});
