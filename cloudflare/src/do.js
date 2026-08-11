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

  // ---- leaf-vault: the unilateral-exit recovery bundle + run health ----
  // The bundle is stored as a JSON STRING (exactly what /api/leaf-vault
  // serves) under one key; run health lives in "vaultMeta". SQLite-backed DO
  // values cap at 2 MiB — a bundle that would exceed it is refused loudly
  // (recorded as a failed run) rather than truncated.

  async getVault() {
    return (await this.ctx.storage.get("leafVault")) ?? null;
  }

  async getVaultStatus() {
    const meta = (await this.ctx.storage.get("vaultMeta")) ?? null;
    const broken = Boolean(
      meta && (meta.consecutiveFailures >= 3 || meta.transientSkips >= 3),
    );
    return { ...(meta ?? {}), broken, hasBundle: Boolean(await this.ctx.storage.get("leafVault")) };
  }

  // One atomic write for bundle + health so a crash can't persist one without
  // the other. `result` mirrors takeSnapshot's summary; `bundleJson` (when
  // present) is stored even for a failed run — that's the union-rescue path.
  async recordVaultRun(result, bundleJson) {
    const meta = (await this.ctx.storage.get("vaultMeta")) ?? {
      consecutiveFailures: 0,
      transientSkips: 0,
      lastSuccessAt: null,
      lastError: null,
    };
    meta.lastRunAt = Date.now();
    if (bundleJson !== undefined && bundleJson.length > 1_800_000) {
      result = { ok: false, error: `bundle is ${bundleJson.length} bytes — exceeds the DO value limit; NOT stored` };
      bundleJson = undefined;
    }
    if (result.ok) {
      meta.consecutiveFailures = 0;
      meta.transientSkips = 0;
      meta.lastSuccessAt = meta.lastRunAt;
      meta.lastError = null;
      if (!result.skipped || result.skipped === "no-leaves") meta.leafCount = result.leafCount ?? 0;
      if (result.network) meta.network = result.network;
      if (result.createdAt) meta.bundleCreatedAt = result.createdAt;
    } else if (result.skipped === "transient-empty-getLeaves") {
      meta.transientSkips = (meta.transientSkips ?? 0) + 1;
      meta.lastError = "getLeaves returned empty while the wallet reports funds — stored bundle KEPT but aging";
    } else {
      meta.consecutiveFailures = (meta.consecutiveFailures ?? 0) + 1;
      meta.lastError = String(result.error ?? "unknown").slice(0, 500);
      if (bundleJson !== undefined && result.createdAt) meta.bundleCreatedAt = result.createdAt; // union rescue
    }
    const put = { vaultMeta: meta };
    if (bundleJson !== undefined) put.leafVault = bundleJson;
    await this.ctx.storage.put(put);
    return meta;
  }
}
