import { DurableObject } from "cloudflare:workers";

// Single-instance Durable Object ("primary") holding the wallet's claim
// state: seed, password hash, session secret, and optional config. DO
// storage is encrypted at rest and — like Worker secrets — unreadable from
// the dashboard; unlike secrets it can be written at runtime, which is what
// makes the first-boot claim wizard possible.
export class WalletDO extends DurableObject {
  async isClaimed() {
    const [seed, pwHash] = await Promise.all([
      this.ctx.storage.get("seed"),
      this.ctx.storage.get("pwHash"),
    ]);
    return Boolean(seed && pwHash);
  }

  async claim({ mnemonic, pwHash, sessionSecret, config }) {
    if (await this.isClaimed()) return { ok: false, error: "already claimed" };
    await this.ctx.storage.put({
      seed: mnemonic,
      pwHash,
      sessionSecret,
      config: config || {},
      claimedAt: Date.now(),
    });
    return { ok: true };
  }

  async getAuth() {
    const [pwHash, sessionSecret] = await Promise.all([
      this.ctx.storage.get("pwHash"),
      this.ctx.storage.get("sessionSecret"),
    ]);
    return { pwHash: pwHash ?? null, sessionSecret: sessionSecret ?? null };
  }

  async getSeed() {
    return (await this.ctx.storage.get("seed")) ?? null;
  }

  async getConfig() {
    return (await this.ctx.storage.get("config")) ?? {};
  }

  async setConfig(patch) {
    const config = { ...((await this.ctx.storage.get("config")) ?? {}), ...patch };
    await this.ctx.storage.put("config", config);
    return config;
  }
}
