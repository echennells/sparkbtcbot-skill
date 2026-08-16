import { DurableObject } from "cloudflare:workers";

const bytesToHexStr = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

// Single-instance Durable Object ("primary") holding the wallet's claim
// state: seed, password hash, session secret, and optional config. DO
// storage is encrypted at rest and — like Worker secrets — unreadable from
// the dashboard; unlike secrets it can be written at runtime, which is what
// makes the first-boot claim wizard possible.
export class WalletDO extends DurableObject {
  async isClaimed() {
    // The seed alone is the claim marker: passkey-era claims may have no
    // password hash at all (fallback login is the live claim code).
    return Boolean(await this.ctx.storage.get("seed"));
  }

  async claim({ mnemonic, pwHash, sessionSecret, config }) {
    if (await this.isClaimed()) return { ok: false, error: "already claimed" };
    await this.ctx.storage.put({
      seed: mnemonic,
      ...(pwHash ? { pwHash } : {}),
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

  // ---- spend ledger: rolling-window cumulative budget (ports lib/spend-ledger.js) ----
  // Per-call caps can't stop a LOOP of individually-legal spends; this can.
  // The DO makes check-then-record ATOMIC (single-threaded per object), which
  // kills the race the Node lib documents. No HMAC signing here: DO storage
  // sits inside the same trust boundary as the seed itself.

  async reserveSpend({ sats, operation, budgetSats, windowMs }) {
    const win = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 24 * 3600 * 1000;
    const now = Date.now();
    const entries = ((await this.ctx.storage.get("spendLedger")) ?? []).filter((e) => e.ts > now - win);
    const spent = entries.reduce((s, e) => s + e.sats, 0);
    const budget = budgetSats == null ? NaN : Number(budgetSats);
    const amount = Number(sats);
    if (Number.isFinite(budget)) {
      // Uncountable spends fail CLOSED when a budget is set.
      if (!Number.isFinite(amount) || amount < 0) {
        await this.ctx.storage.put("spendLedger", entries);
        return { ok: false, spentSats: spent, budgetSats: budget, remainingSats: Math.max(0, budget - spent), reason: "spend amount is unreadable — refusing an uncountable spend against a budget" };
      }
      if (spent + amount > budget) {
        await this.ctx.storage.put("spendLedger", entries);
        return { ok: false, spentSats: spent, budgetSats: budget, remainingSats: Math.max(0, budget - spent), reason: `spending ${amount} sats would exceed the ${budget}-sat rolling ${Math.round(win / 3600000)}h budget (${spent} already spent)` };
      }
    }
    const entry = { id: bytesToHexStr(crypto.getRandomValues(new Uint8Array(8))), ts: now, sats: Number.isFinite(amount) ? amount : 0, operation: String(operation ?? "spend") };
    entries.push(entry);
    await this.ctx.storage.put("spendLedger", entries);
    return {
      ok: true,
      entryId: entry.id,
      spentSats: spent,
      budgetSats: Number.isFinite(budget) ? budget : null,
      remainingSats: Number.isFinite(budget) ? budget - spent - entry.sats : null,
    };
  }

  // Best-effort refund when the SDK call provably never moved money. If this
  // fails the ledger overcounts — the safe direction.
  async unrecordSpend(id) {
    const entries = (await this.ctx.storage.get("spendLedger")) ?? [];
    const kept = entries.filter((e) => e.id !== id);
    if (kept.length !== entries.length) await this.ctx.storage.put("spendLedger", kept);
  }

  async spendStatus({ budgetSats, windowMs } = {}) {
    const win = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 24 * 3600 * 1000;
    const now = Date.now();
    const entries = ((await this.ctx.storage.get("spendLedger")) ?? []).filter((e) => e.ts > now - win);
    const spent = entries.reduce((s, e) => s + e.sats, 0);
    const budget = budgetSats == null ? null : Number(budgetSats);
    return { spentSats: spent, budgetSats: budget, remainingSats: budget == null ? null : Math.max(0, budget - spent), windowHours: Math.round(win / 3600000), entryCount: entries.length };
  }

  // ---- passkeys: stored credentials + single-use ceremony challenges ----
  // Single-user system, so one active challenge per purpose ("register" /
  // "login") is enough; take() is get-and-delete so a challenge can never be
  // replayed, and expired ones read as absent.

  async putAuthChallenge(purpose, value) {
    await this.ctx.storage.put("authChallenge:" + purpose, { value, exp: Date.now() + 120_000 });
  }

  async takeAuthChallenge(purpose) {
    const key = "authChallenge:" + purpose;
    const c = await this.ctx.storage.get(key);
    await this.ctx.storage.delete(key);
    return c && c.exp > Date.now() ? c.value : null;
  }

  async getPasskeys() {
    return (await this.ctx.storage.get("passkeys")) ?? [];
  }

  async addPasskey(credential) {
    const list = (await this.ctx.storage.get("passkeys")) ?? [];
    if (list.some((c) => c.id === credential.id)) return { ok: false, error: "credential already enrolled" };
    list.push(credential);
    await this.ctx.storage.put("passkeys", list);
    return { ok: true, count: list.length };
  }

  async updatePasskeyCounter(id, counter) {
    const list = (await this.ctx.storage.get("passkeys")) ?? [];
    const c = list.find((x) => x.id === id);
    if (c) {
      c.counter = counter;
      await this.ctx.storage.put("passkeys", list);
    }
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
