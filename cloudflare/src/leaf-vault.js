// Leaf-vault for the Worker: keep a fresh `spark.unilateral-exit-bundle.v1`
// recovery bundle in the WalletDO so funds are exitable if the Spark operators
// go dark. Recovery itself is performed by Blink's spark-unilateral-exit CLI
// against the downloaded bundle; this module only captures + proves it.
//
// Port of skills/sparkbtcbot/scripts/leaf-vault.js (Node) with storage
// inverted: no filesystem — the caller supplies the prior bundle (from the DO)
// and persists whatever this returns. All safety semantics carry over:
//   - INTEGRITY GATE: shape-validate, then prove every leaf reconstructs its
//     exit chain OFFLINE (pre-signed txs present, chain reaches a real root)
//     before anything is persisted.
//   - SHRINK GUARD: a leaf present in the prior bundle but missing from this
//     capture is only excused when the captured sats cover the wallet's
//     reported owned balance; otherwise a UNION bundle (fresh + carried-over
//     prior leaves, gate-proven) is offered as a rescue and the run FAILS.
//   - IDENTITY/NETWORK GUARDS: never overwrite a different wallet's (or
//     network's) only recovery bundle.
// Not ported: the cooperative-exit-window excuse — this Worker has no withdraw
// tool yet, so a pending COOP_EXIT can't originate here; add it with withdrawals.
//
// The SDK import is LAZY (module-eval randomness is banned in workerd), and
// nothing here touches the FROST wasm — capture is queries + proto codec only.

export const BUNDLE_SCHEMA = "spark.unilateral-exit-bundle.v1";
// Networks Blink's recovery CLI accepts — a bundle labeled outside this set
// verifies structurally but is refused at recovery time, so both the writer
// and the validator enforce it.
export const RECOVERABLE_NETWORKS = ["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"];

const isHexString = (s) =>
  typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
const u8ToHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const hexToU8 = (hex) => {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
};
const toHexMaybe = (v) => (typeof v === "string" ? v : v && v.length ? u8ToHex(v) : undefined);
const toSafeSats = (value) => {
  try {
    const n = Number(BigInt(value ?? 0));
    return Number.isSafeInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
};
const normalizeNetwork = (v) => String(v ?? "").toUpperCase();
const safe = async (fn) => { try { return await fn(); } catch { return undefined; } };

// Owned FIRST: the top-level `balance` is a deprecated alias for AVAILABLE,
// and owned includes leaves locked in in-flight transfers — still exitable,
// still needing a backup.
const ownedSats = (b) => b?.satsBalance?.owned ?? b?.balance ?? b?.satsBalance?.available ?? null;

async function reportedBalanceSats(wallet) {
  try {
    const v = ownedSats(await wallet.getBalance?.());
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

const sumLeafSats = (leaves) => {
  try {
    let s = 0n;
    for (const l of leaves) {
      if (l?.valueSats == null) return null;
      s += BigInt(l.valueSats);
    }
    return s;
  } catch {
    return null;
  }
};

// Structural check mirroring Blink's validateRecoveryBundle (same contract as
// lib/leaf-vault.js — keep in sync).
export function validateSnapshotShape(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return { ok: false, reason: "bundle must be a JSON object" };
  if (bundle.schema !== BUNDLE_SCHEMA) return { ok: false, reason: `unsupported schema: ${bundle.schema ?? "missing"}` };
  if (typeof bundle.createdAt !== "string" || Number.isNaN(Date.parse(bundle.createdAt))) return { ok: false, reason: "createdAt must be an ISO timestamp" };
  if (!isNonEmptyStr(bundle.network)) return { ok: false, reason: "network is required" };
  if (!RECOVERABLE_NETWORKS.includes(bundle.network)) return { ok: false, reason: `network "${bundle.network}" is not recoverable by Blink's CLI` };
  if (!Array.isArray(bundle.leaves) || bundle.leaves.length === 0) return { ok: false, reason: "bundle must include at least one leaf" };
  for (let i = 0; i < bundle.leaves.length; i++) {
    const leaf = bundle.leaves[i];
    if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) return { ok: false, reason: `leaf ${i} must be an object` };
    if (!isNonEmptyStr(leaf.id)) return { ok: false, reason: `leaf ${i} id is required` };
    if (!isHexString(leaf.treeNodeHex)) return { ok: false, reason: `leaf ${leaf.id} treeNodeHex must be hex` };
    if (leaf.valueSats !== undefined && !Number.isSafeInteger(leaf.valueSats)) return { ok: false, reason: `leaf ${leaf.id} valueSats must be an integer` };
  }
  if (bundle.nodes !== undefined) {
    if (!Array.isArray(bundle.nodes)) return { ok: false, reason: "nodes must be an array when present" };
    for (let i = 0; i < bundle.nodes.length; i++) {
      const n = bundle.nodes[i];
      if (!n || typeof n !== "object" || Array.isArray(n) || !isNonEmptyStr(n.id)) return { ok: false, reason: `node ${i} id is required` };
      if (!isHexString(n.treeNodeHex)) return { ok: false, reason: `node ${n.id} treeNodeHex must be hex` };
    }
  }
  return { ok: true, reason: "ok" };
}

// Fail LOUD if the protected internals the capture depends on have moved — a
// silently-empty bundle is the worst possible failure for recovery data.
function assertInternalsIntact(wallet, TreeNode) {
  const missing = [];
  if (typeof wallet?.leafManager?.getLeaves !== "function") missing.push("wallet.leafManager.getLeaves");
  if (typeof wallet?.connectionManager?.createSparkClient !== "function") missing.push("wallet.connectionManager.createSparkClient");
  if (typeof wallet?.config?.getCoordinatorAddress !== "function") missing.push("wallet.config.getCoordinatorAddress");
  if (typeof TreeNode?.encode !== "function" || typeof TreeNode?.decode !== "function" || typeof TreeNode?.fromPartial !== "function") {
    missing.push("TreeNode proto codec");
  }
  if (missing.length) {
    throw new Error(`leaf-vault: SDK internals moved — cannot reach [${missing.join(", ")}]. Backup NOT captured; re-verify the reach-in against the resolved spark-sdk version.`);
  }
}

// Prove each leaf reconstructs OFFLINE from the bundle's own bytes (no client,
// no operators) — the single statement of "this bundle can recover funds".
async function proveOffline(sdk, TreeNode, leaves, nodes) {
  const decode = (hex) => TreeNode.decode(hexToU8(hex));
  const reMap = new Map([...leaves, ...(nodes ?? [])].map((n) => [n.id, decode(n.treeNodeHex)]));
  const proofs = new Map();
  for (const leaf of leaves) {
    const ln = reMap.get(leaf.id);
    const chain = await sdk.buildUnilateralExitChain(ln, reMap, undefined, undefined); // NO client
    proofs.set(leaf.id, {
      hasTxs: ln?.nodeTx?.length > 0 && ln?.refundTx?.length > 0,
      chainLen: chain.length,
      reachesRoot: chain.some((n) => !n?.parentNodeId),
    });
  }
  return proofs;
}

// Take a snapshot from an initialized SparkWallet. `prior` is the currently
// stored bundle (parsed object or null). Never throws for expected outcomes —
// returns one of:
//   { ok: true,  bundle, leafCount, nodeCount, network }
//   { ok: true,  skipped: "no-leaves", leafCount: 0 }          // confirmed empty
//   { ok: false, skipped: "transient-empty-getLeaves" }        // funded, capture failed
//   { ok: false, error, rescueBundle? }                        // guard tripped; rescue is gate-proven
export async function takeSnapshot(wallet, prior, { networkLabel } = {}) {
  const sdk = await import("@buildonspark/spark-sdk");
  const { TreeNode, networkToJSON } = await import("@buildonspark/spark-sdk/proto/spark");
  assertInternalsIntact(wallet, TreeNode);
  const encodeNode = (node) => u8ToHex(TreeNode.encode(TreeNode.fromPartial(node)).finish());

  const leaves = await wallet.leafManager.getLeaves(true);

  if (leaves.length === 0) {
    // Empty getLeaves on a FUNDED wallet is a transient capture failure (the
    // coordinator recover path swallows errors) — "empty" only counts when the
    // wallet also reports zero balance. Unreadable balance fails safe (funded).
    const sats = await reportedBalanceSats(wallet);
    if (sats == null || sats > 0n) return { ok: false, skipped: "transient-empty-getLeaves" };
    return { ok: true, skipped: "no-leaves", leafCount: 0 };
  }

  // A leaf's `network` is a NUMERIC proto enum at runtime — derive the label
  // through the codec and refuse anything Blink's CLI would refuse.
  let derived = leaves[0]?.network;
  if (typeof derived === "number") {
    try { derived = networkToJSON(derived); } catch { /* gate below fails loud */ }
  }
  const network = normalizeNetwork(networkLabel ?? derived ?? "MAINNET");
  if (!RECOVERABLE_NETWORKS.includes(network)) {
    return { ok: false, error: `network "${network}" is not one Blink's recovery CLI accepts — bundle NOT written` };
  }

  const netEnum = sdk.Network[network];
  const client = await wallet.connectionManager.createSparkClient(wallet.config.getCoordinatorAddress());

  const leafIds = new Set(leaves.map((l) => l.id));
  const ancestors = new Map();
  const onlineLen = new Map();
  const reachesRoot = new Map();
  for (const leaf of leaves) {
    const nodeMap = new Map();
    const chain = await sdk.buildUnilateralExitChain(leaf, nodeMap, client, netEnum);
    if (!chain.length) return { ok: false, error: `could not resolve exit chain for leaf ${leaf.id}; backup NOT captured` };
    onlineLen.set(leaf.id, chain.length);
    reachesRoot.set(leaf.id, chain.some((n) => !n?.parentNodeId));
    for (const n of nodeMap.values()) if (!leafIds.has(n.id)) ancestors.set(n.id, n);
  }

  const identity = toHexMaybe(await safe(() => wallet.getIdentityPublicKey?.()));
  const balance = await safe(() => wallet.getBalance?.());
  let btcSats;
  try {
    const owned = ownedSats(balance);
    btcSats = owned != null ? String(BigInt(owned)) : String(leaves.reduce((s, l) => s + BigInt(l.value ?? 0), 0n));
  } catch { btcSats = undefined; }

  const bundle = {
    schema: BUNDLE_SCHEMA,
    createdAt: new Date().toISOString(),
    network,
    operatorSet: "spark-sdk",
    ...(identity ? { walletIdentityPublicKey: identity } : {}),
    sparkSdkVersion: "0.9.0", // pinned in package.json (no ./package.json export to read at runtime)
    appVersion: "sparkbtcbot-cloudflare",
    leaves: leaves.map((l) => {
      const valueSats = toSafeSats(l.value);
      return {
        id: l.id,
        ...(l.status != null ? { status: String(l.status) } : {}),
        ...(valueSats !== undefined ? { valueSats } : {}),
        treeNodeHex: encodeNode(l),
      };
    }),
    ...(ancestors.size ? { nodes: [...ancestors.values()].map((n) => ({ id: n.id, treeNodeHex: encodeNode(n) })) } : {}),
    balances: { ...(btcSats != null ? { btcSats } : {}), usdb: { amount: "unknown", status: "not-covered-by-bitcoin-unilateral-exit" } },
  };

  // --- INTEGRITY GATE (must pass or nothing is persisted) ---
  const persisted = JSON.parse(JSON.stringify(bundle));
  const shape = validateSnapshotShape(persisted);
  if (!shape.ok) return { ok: false, error: `bundle failed shape validation (${shape.reason}); NOT written` };

  const proofs = await proveOffline(sdk, TreeNode, persisted.leaves, persisted.nodes);
  for (const leaf of persisted.leaves) {
    const p = proofs.get(leaf.id);
    if (!p.hasTxs) return { ok: false, error: `leaf ${leaf.id} missing pre-signed nodeTx/refundTx — not exitable; NOT written` };
    if (!reachesRoot.get(leaf.id)) return { ok: false, error: `leaf ${leaf.id} exit chain never reaches a tree root — incomplete; NOT written` };
    if (p.chainLen !== onlineLen.get(leaf.id)) return { ok: false, error: `leaf ${leaf.id} rebuilds to ${p.chainLen}/${onlineLen.get(leaf.id)} nodes offline — incomplete; NOT written` };
  }

  // --- IDENTITY/NETWORK + SHRINK GUARDS vs the prior stored bundle ---
  if (Array.isArray(prior?.leaves) && prior.leaves.length > 0) {
    if (isNonEmptyStr(prior.network) && normalizeNetwork(prior.network) !== network) {
      return { ok: false, error: `stored bundle is for network ${prior.network}, this wallet is ${network} — refusing to overwrite; prior bundle KEPT` };
    }
    if (isNonEmptyStr(prior.walletIdentityPublicKey) && isNonEmptyStr(identity) &&
        prior.walletIdentityPublicKey.toLowerCase() !== identity.toLowerCase()) {
      return { ok: false, error: "stored bundle belongs to a different wallet identity — refusing to overwrite; prior bundle KEPT" };
    }

    const newIds = new Set(persisted.leaves.map((l) => l.id));
    const missing = prior.leaves.filter((l) => !newIds.has(l.id));
    if (missing.length > 0) {
      // Legitimate only if every owned sat is represented in THIS capture —
      // compare captured to the reported balance, not the prior total.
      const capturedSats = sumLeafSats(persisted.leaves);
      const reported = await reportedBalanceSats(wallet);
      const coversBalance = capturedSats != null && reported != null && capturedSats >= reported;
      if (!coversBalance) {
        // RESCUE: the fresh capture may hold leaves that exist nowhere else.
        // Offer a gate-proven UNION bundle so they get exit material, but the
        // run still FAILS (feeds the failure counter → "broken" status).
        let rescueBundle;
        try {
          const nodeById = new Map();
          for (const n of prior.nodes ?? []) nodeById.set(n.id, n);
          for (const n of persisted.nodes ?? []) nodeById.set(n.id, n); // fresh bytes win
          const union = {
            ...persisted,
            leaves: [...persisted.leaves, ...missing],
            ...(nodeById.size ? { nodes: [...nodeById.values()] } : {}),
          };
          if (validateSnapshotShape(union).ok) {
            const unionProofs = await proveOffline(sdk, TreeNode, union.leaves, union.nodes);
            const allProven = union.leaves.every((l) => {
              const p = unionProofs.get(l.id);
              if (!p?.hasTxs || !p.reachesRoot || !p.chainLen) return false;
              const online = onlineLen.get(l.id); // undefined for carried-over prior leaves
              return online === undefined || p.chainLen === online;
            });
            if (allProven) rescueBundle = union;
          }
        } catch { /* best-effort; the guard error below still fires */ }
        return {
          ok: false,
          error: `a leaf in the stored bundle is missing from this capture (${capturedSats ?? "unreadable"} captured vs ${reported ?? "unreadable"} owned sats) — treating as a partial getLeaves` +
            (rescueBundle ? "; a UNION bundle was stored so new leaves keep exit material" : "; prior bundle KEPT"),
          ...(rescueBundle ? { rescueBundle } : {}),
        };
      }
    }
  }

  return { ok: true, bundle: persisted, leafCount: persisted.leaves.length, nodeCount: (persisted.nodes ?? []).length, network };
}

// Run a snapshot against the DO-stored state: fetch prior, capture, persist
// bundle (or rescue), record the run for health tracking. `wallet` must be an
// initialized SparkWallet. Returns the takeSnapshot result (minus bundles).
export async function snapshotToDO(wallet, stub, { networkLabel } = {}) {
  let prior = null;
  try {
    const raw = await stub.getVault();
    if (raw) prior = JSON.parse(raw);
  } catch { /* unreadable prior — guards simply don't apply */ }
  let r;
  try {
    r = await takeSnapshot(wallet, prior, { networkLabel });
  } catch (e) {
    r = { ok: false, error: String(e?.message ?? e).slice(0, 500) };
  }
  const toStore = r.bundle ?? r.rescueBundle;
  await stub.recordVaultRun(
    {
      ok: r.ok,
      skipped: r.skipped,
      error: r.error,
      leafCount: r.leafCount ?? toStore?.leaves?.length,
      network: r.network ?? toStore?.network,
      createdAt: toStore?.createdAt,
    },
    toStore ? JSON.stringify(toStore) : undefined,
  );
  const { bundle, rescueBundle, ...summary } = r;
  return summary;
}
