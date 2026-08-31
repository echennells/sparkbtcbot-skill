// Persistent Lightning payment-dedup identities (spark-sdk ≥0.10 `transferId`).
//
// The SDK dedupes a Lightning payment on `transferId` across every rail it can
// settle on — Spark fallback transfer, preimage swap, SSP admission — so a
// retry that REUSES the first attempt's ID cannot produce a second payment.
// That guarantee is only as durable as the ID: minted fresh per call (the
// SDK's default when the caller omits it), a crash between "request sent" and
// "outcome known" leaves no safe retry. This store makes the ID survive the
// crash: one file per invoice, WRITTEN BEFORE the first pay attempt, keyed by
// the invoice's payment hash, so any later attempt at the same invoice — same
// process, next process, or a concurrent one — resolves to the same ID.
//
// Concurrency is settled by the kernel, not by locks: entries publish through
// atomic-file's exclusive link(2) mode (create-or-EEXIST, never replace), so
// two racers cannot both mint — the loser reads the winner's file. This holds
// across processes, not just within one.
//
// Fail-closed doctrine: an UNREADABLE entry throws instead of minting a fresh
// ID, because a fresh ID for an invoice that may already have a payment in
// flight is exactly the double-pay this store exists to prevent. The
// deliberate reset is deleting the entry file, and the error says what that
// forfeits. Pruning honors the same rule: only entries whose recorded expiry
// has passed are removed; unreadable ones are left for a human.
//
// This module stays SDK-free (the mint function is injected) so the library
// keeps working — and testing — without @buildonspark/spark-sdk installed.
import { readFile, readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "./atomic-file.js";
import { invoicePaymentHash, invoiceSecondsRemaining } from "./bolt11.js";

/** Default store location: ~/.spark/ln-dedup/ (one JSON file per invoice). */
export const DEFAULT_TRANSFER_IDS_DIR = join(homedir(), ".spark", "ln-dedup");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // TTL when the invoice's expiry is unreadable
const SETTLE_GRACE_MS = 60 * 60 * 1000; // retries can trail the invoice's expiry

// The invoice's payment hash when decodable — its semantic identity, stable
// across case differences — else a hash of the lowercased string, so even an
// undecodable invoice dedupes on exact bytes rather than not at all.
export function invoiceDedupKey(bolt11) {
  return (
    invoicePaymentHash(bolt11) ??
    createHash("sha256").update(String(bolt11).toLowerCase()).digest("hex")
  );
}

export function createTransferIdStore({ dir = DEFAULT_TRANSFER_IDS_DIR, clock = Date.now } = {}) {
  const entryPath = (key) => join(dir, `${key}.json`);

  async function readEntry(path) {
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    let entry = null;
    try { entry = JSON.parse(raw); } catch { /* refused below, with the path */ }
    if (typeof entry?.transferId !== "string" || entry.transferId.length === 0) {
      throw new Error(
        `transfer-ids: unreadable dedup entry at ${path} — refusing to mint a fresh transferId for an ` +
        `invoice that may already have a payment in flight (a fresh ID is exactly the double-pay this ` +
        `store prevents). If you are certain no attempt is pending, delete that file to reset deliberately.`,
      );
    }
    return entry;
  }

  // Hygiene, not safety: callers fire-and-forget this, and a prune failure
  // must never fail a payment. Removes only entries whose recorded expiry has
  // passed; unreadable entries stay (deleting one is the user's deliberate act).
  async function prune() {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const now = clock();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const entry = JSON.parse(await readFile(path, "utf8"));
        if (typeof entry?.expiresAt === "number" && entry.expiresAt < now) {
          await unlink(path);
          removed++;
        }
      } catch { /* unreadable or already gone — leave it */ }
    }
    return removed;
  }

  return {
    dir,
    prune,
    // Resolve THE transferId for this invoice: the stored one when any prior
    // attempt recorded it, else mint() persisted write-ahead of the caller's
    // pay attempt. `explicitId` (caller-managed dedup) must AGREE with a
    // stored id — a disagreement is a bug or an injected parameter, so refuse
    // rather than silently pick one (the amountSats-disagreement doctrine).
    async idForInvoice(bolt11, mint, { explicitId } = {}) {
      const path = entryPath(invoiceDedupKey(bolt11));
      const resolve = (entry, reused) => {
        if (explicitId !== undefined && entry.transferId !== explicitId) {
          throw new Error(
            `transfer-ids: transferId ${explicitId} disagrees with the id already recorded for this ` +
            `invoice (${entry.transferId}, recorded ${entry.createdAt}). One invoice gets ONE dedup ` +
            `identity — omit transferId to reuse the recorded one.`,
          );
        }
        return { transferId: entry.transferId, reused };
      };
      const existing = await readEntry(path);
      if (existing) return resolve(existing, true);
      const transferId = explicitId ?? mint();
      if (typeof transferId !== "string" || transferId.length === 0) {
        throw new Error("transfer-ids: mint() must return a non-empty transferId string");
      }
      const now = clock();
      const remainingMs = (invoiceSecondsRemaining(bolt11, now) ?? WEEK_MS / 1000) * 1000;
      const entry = {
        v: 1,
        transferId,
        invoice: String(bolt11).slice(0, 24),
        createdAt: new Date(now).toISOString(),
        expiresAt: now + Math.max(remainingMs, 0) + SETTLE_GRACE_MS,
      };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        await atomicWriteFile(path, JSON.stringify(entry) + "\n", { exclusive: true });
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        const winner = await readEntry(path); // a concurrent racer published first
        if (!winner) throw err; // published then deleted mid-race — surface it
        return resolve(winner, true);
      }
      prune().catch(() => {});
      return { transferId, reused: false };
    },
  };
}
