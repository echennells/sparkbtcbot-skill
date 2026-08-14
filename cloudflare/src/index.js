import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { WalletDO } from "./do.js";
import {
  hashPassword,
  verifyPassword,
  mintSession,
  verifySession,
  sessionCookie,
  readSessionCookie,
  bytesToHex,
} from "./auth.js";
import { setupPage, LOGIN_PAGE, CHAT_PAGE } from "./pages.js";
import { snapshotToDO } from "./leaf-vault.js";

export { WalletDO };

const jsonSafe = (v) =>
  JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));

const json = (obj, status = 200, headers = {}) =>
  new Response(jsonSafe(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const html = (body) =>
  new Response(body, { headers: { "content-type": "text/html;charset=utf-8" } });

// ---------------------------------------------------------------- wallet tools

const TOOLS = [
  {
    name: "get_balance",
    description: "Get the wallet's current BTC balance in sats.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_spark_address",
    description:
      "Get this wallet's Spark address (for receiving instant zero-fee Spark transfers).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_deposit_address",
    description:
      "Generate a single-use on-chain Bitcoin (L1) deposit address. Each address can only be used once.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_lightning_invoice",
    description: "Create a BOLT11 Lightning invoice so someone can pay this wallet.",
    parameters: {
      type: "object",
      properties: {
        amountSats: { type: "number", description: "Amount in sats" },
        memo: { type: "string", description: "Short human-readable memo" },
      },
      required: ["amountSats"],
    },
  },
  {
    name: "pay_lightning_invoice",
    description:
      "Pay a BOLT11 Lightning invoice from this wallet. Only call after the user has explicitly confirmed the payment in this conversation.",
    parameters: {
      type: "object",
      properties: {
        invoice: { type: "string", description: "The BOLT11 invoice string" },
        confirm: {
          type: "boolean",
          description: "Must be true; set only after explicit user confirmation",
        },
      },
      required: ["invoice", "confirm"],
    },
  },
  {
    name: "send_spark",
    description:
      "Send sats instantly (zero fee) to another Spark address. Only call after the user has explicitly confirmed amount and recipient in this conversation.",
    parameters: {
      type: "object",
      properties: {
        receiverSparkAddress: { type: "string" },
        amountSats: { type: "number" },
        confirm: {
          type: "boolean",
          description: "Must be true; set only after explicit user confirmation",
        },
      },
      required: ["receiverSparkAddress", "amountSats", "confirm"],
    },
  },
];

// Lazy: the SDK does I/O at module-eval time, which workerd forbids at global scope.
async function initWallet(env, seed) {
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const init = await SparkWallet.initialize({
    mnemonicOrSeed: seed,
    options: { network: env.SPARK_NETWORK || "MAINNET" },
  });
  return init.wallet;
}

async function runTool(name, args, env, state) {
  const maxSend = Number(env.SPARK_MAX_SEND_SATS || 5000);
  const maxLnFee = Number(env.SPARK_MAX_LN_FEE_SATS || 50);

  if (!state.wallet) {
    state.wallet = await initWallet(env, state.seed);
    // Same leaf-changing events the Node agent watches: a claim that happens
    // DURING this request (boot claims pending incoming transfers) marks the
    // vault dirty so the teardown snapshots even a <30-min-fresh backup.
    for (const ev of ["balance:update", "transfer:claimed", "deposit:confirmed"])
      state.wallet.on?.(ev, () => { state.leafChanged = true; });
  }
  const wallet = state.wallet;

  switch (name) {
    case "get_balance": {
      const b = await wallet.getBalance();
      return { balanceSats: b.balance.toString() };
    }
    case "get_spark_address":
      return { sparkAddress: await wallet.getSparkAddress() };
    case "get_deposit_address":
      return {
        depositAddress: await wallet.getSingleUseDepositAddress(),
        note: "single-use L1 address; funds appear after confirmation and claim",
      };
    case "create_lightning_invoice": {
      const inv = await wallet.createLightningInvoice({
        amountSats: Math.floor(Number(args.amountSats)),
        memo: String(args.memo || "").slice(0, 90),
      });
      return {
        encodedInvoice: inv?.invoice?.encodedInvoice ?? inv,
        amountSats: Math.floor(Number(args.amountSats)),
      };
    }
    case "pay_lightning_invoice": {
      if (args.confirm !== true)
        return { refused: "confirm flag not set — ask the user to confirm first" };
      const res = await wallet.payLightningInvoice({
        invoice: String(args.invoice),
        maxFeeSats: maxLnFee,
      });
      state.leafChanged = true; // leaves moved — refresh the exit backup after this chat
      return { paid: true, result: JSON.parse(jsonSafe(res)) };
    }
    case "send_spark": {
      if (args.confirm !== true)
        return { refused: "confirm flag not set — ask the user to confirm first" };
      const amount = Math.floor(Number(args.amountSats));
      if (!(amount > 0) || amount > maxSend)
        return { refused: `amount must be 1..${maxSend} sats (hard cap)` };
      const res = await wallet.transfer({
        receiverSparkAddress: String(args.receiverSparkAddress),
        amountSats: amount,
      });
      state.leafChanged = true; // leaves moved — refresh the exit backup after this chat
      return { sent: true, result: JSON.parse(jsonSafe(res)) };
    }
    default:
      return { error: "unknown tool " + name };
  }
}

// ---------------------------------------------------------------- agent loop

const SYSTEM_PROMPT = `You are sparkbtcbot, a Bitcoin wallet assistant running on the Spark L2 (MAINNET — real money, real sats).
You control one wallet via tools. Amounts are always in sats.
Rules:
- Before any send_spark or pay_lightning_invoice, restate amount + recipient and get an explicit "yes" from the user in this conversation; only then call the tool with confirm=true.
- Per-transaction hard caps are enforced in code; if a tool refuses, relay why.
- Be concise. Never invent balances or addresses — always use tools.
- Report tool results EXACTLY as returned. Never fabricate transaction details, senders, fees, or amounts that a tool did not return. If you don't know something, say so.
- You cannot access the seed phrase; never discuss revealing it.`;

function normalizeModelResponse(r) {
  if (r?.choices?.[0]?.message) {
    const m = r.choices[0].message;
    return { content: m.content ?? "", rawCalls: m.tool_calls || [] };
  }
  return { content: r?.response ?? "", rawCalls: r?.tool_calls || [] };
}

function withCallIds(rawCalls) {
  return rawCalls.map((tc, i) => ({
    id: tc.id || "call_" + i,
    type: "function",
    function: {
      name: tc.function?.name ?? tc.name,
      arguments:
        typeof (tc.function?.arguments ?? tc.arguments) === "string"
          ? (tc.function?.arguments ?? tc.arguments)
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
    },
  }));
}

function parseCall(tc) {
  let args = tc.function.arguments;
  try {
    args = JSON.parse(args);
  } catch {
    args = {};
  }
  return { name: tc.function.name, args, id: tc.id };
}

async function callModel(env, config, messages, tools) {
  const model = config.model || env.MODEL;
  const orKey = config.openrouterKey || env.OPENROUTER_API_KEY;
  if (model.startsWith("@cf/") || !orKey)
    return env.AI.run(model, { messages, tools, max_tokens: 900 });
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + orKey,
      "content-type": "application/json",
      "x-title": "sparkbtcbot",
    },
    body: JSON.stringify({ model, messages, tools, max_tokens: 900 }),
  });
  if (!res.ok)
    throw new Error("openrouter " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

async function chat(request, env, stub, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "bad request" }, 400);

  const [seed, config] = await Promise.all([stub.getSeed(), stub.getConfig()]);
  if (!seed) return json({ error: "unclaimed" }, 409);

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-30)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const tools = TOOLS.map((t) => ({ type: "function", function: t }));
  const state = { seed };
  const toolEvents = [];
  let reply = "";

  try {
    for (let turn = 0; turn < 6; turn++) {
      let r;
      try {
        r = await callModel(env, config, messages, tools);
      } catch (e) {
        reply = "model error: " + String(e?.message ?? e).slice(0, 300);
        break;
      }
      const { content, rawCalls } = normalizeModelResponse(r);
      if (!rawCalls.length) {
        // Models occasionally return a fully empty message (observed: GLM-5.2
        // handed a long BOLT11 invoice) — retry once instead of surfacing
        // "(no reply)", and log the raw response so it's diagnosable.
        if (!content && !state.emptyRetried) {
          state.emptyRetried = true;
          console.warn("[chat] empty model response, retrying once:", jsonSafe(r).slice(0, 500));
          continue;
        }
        reply = content || "(no reply)";
        break;
      }
      const calls = withCallIds(rawCalls);
      messages.push({ role: "assistant", content: content || "", tool_calls: calls });
      for (const raw of calls) {
        const { name, args, id } = parseCall(raw);
        let result;
        try {
          result = await runTool(name, args, env, state);
        } catch (e) {
          result = { error: String(e?.message ?? e).slice(0, 400) };
        }
        toolEvents.push({ tool: name, args, result });
        messages.push({ role: "tool", name, content: jsonSafe(result), tool_call_id: id });
      }
      reply = content || reply;
    }
  } finally {
    if (state.wallet) {
      const wallet = state.wallet;
      // After a leaf-changing send, refresh the exit backup — via waitUntil so
      // the user's reply isn't held hostage to the snapshot round-trips.
      const teardown = (async () => {
        try {
          // Snapshot when leaves changed (a send) — and ALSO when the stored
          // backup is stale, so any wallet activity self-heals freshness and
          // the cron is a belt, not the only suspender. 30 min ≈ 1.5 cron
          // periods: a working cron makes this a no-op.
          let refresh = state.leafChanged;
          if (!refresh) {
            const s = await stub.getVaultStatus().catch(() => null);
            const STALE_MS = 30 * 60_000;
            refresh = !s?.lastSuccessAt || Date.now() - s.lastSuccessAt > STALE_MS;
          }
          if (refresh) await snapshotToDO(wallet, stub, { networkLabel: env.SPARK_NETWORK });
        } catch (e) {
          console.error("[leaf-vault] post-chat snapshot failed:", e?.message ?? e);
        } finally {
          await wallet.cleanupConnections().catch(() => {});
        }
      })();
      if (ctx) ctx.waitUntil(teardown);
      else await teardown;
    }
  }

  return json({ reply, toolEvents });
}

// ---------------------------------------------------------------- router

async function sessionOk(stub, request) {
  const { sessionSecret } = await stub.getAuth();
  return verifySession(sessionSecret, readSessionCookie(request));
}

// Cron body: init the wallet from the DO seed, snapshot, record. Never touches
// FROST signing — queries + proto codec only.
async function runCronSnapshot(env, stub) {
  const seed = await stub.getSeed();
  if (!seed) return;
  let wallet;
  try {
    wallet = await initWallet(env, seed);
    const r = await snapshotToDO(wallet, stub, { networkLabel: env.SPARK_NETWORK });
    console.log("[leaf-vault] cron snapshot:", jsonSafe(r));
  } catch (e) {
    console.error("[leaf-vault] cron snapshot failed:", e?.message ?? e);
    // A failure before snapshotToDO's own recording (e.g. wallet init) must
    // still be visible in /api/leaf-vault/status — an unrecorded death is
    // indistinguishable from "cron never fired".
    await stub
      .recordVaultRun({ ok: false, error: "cron: " + String(e?.message ?? e).slice(0, 400) })
      .catch(() => {});
  } finally {
    await wallet?.cleanupConnections?.().catch(() => {});
  }
}

export default {
  async scheduled(controller, env, ctx) {
    const stub = env.WALLET_DO.get(env.WALLET_DO.idFromName("primary"));
    if (!(await stub.isClaimed())) return;
    ctx.waitUntil(runCronSnapshot(env, stub));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const stub = env.WALLET_DO.get(env.WALLET_DO.idFromName("primary"));

    if (url.pathname === "/health") return json({ ok: true });

    if (url.pathname === "/api/claim" && request.method === "POST") {
      if (await stub.isClaimed()) return json({ error: "already claimed" }, 409);
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: "bad request" }, 400);
      const requiredCode = env.CLAIM_CODE || env.AUTH_TOKEN;
      if (requiredCode && body.claimCode !== requiredCode)
        return json({ error: "wrong claim code" }, 403);
      const mnemonic = String(body.mnemonic || "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!validateMnemonic(mnemonic, wordlist))
        return json({ error: "invalid mnemonic (checksum failed)" }, 400);
      if (typeof body.password !== "string" || body.password.length < 8)
        return json({ error: "password must be at least 8 characters" }, 400);
      const pwHash = await hashPassword(body.password);
      const sessionSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const config = {};
      if (body.openrouterKey) config.openrouterKey = String(body.openrouterKey).slice(0, 200);
      const res = await stub.claim({ mnemonic, pwHash, sessionSecret, config });
      if (!res.ok) return json({ error: res.error }, 409);
      const token = await mintSession(sessionSecret);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const { pwHash, sessionSecret } = await stub.getAuth();
      if (!pwHash) return json({ error: "unclaimed" }, 409);
      if (!body || !(await verifyPassword(String(body.password || ""), pwHash)))
        return json({ error: "wrong password" }, 401);
      const token = await mintSession(sessionSecret);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
    }

    if (url.pathname === "/api/logout" && request.method === "POST")
      return json({ ok: true }, 200, {
        "set-cookie": "sb_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      });

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      return chat(request, env, stub, ctx);
    }

    // ---- leaf-vault: download / status / snapshot-now (all session-gated) ----
    if (url.pathname === "/api/leaf-vault" && request.method === "GET") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      const vault = await stub.getVault();
      if (!vault) return json({ error: "no backup captured yet" }, 404);
      return new Response(vault, {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="sparkbtcbot-leaf-vault.json"',
        },
      });
    }

    if (url.pathname === "/api/leaf-vault/status" && request.method === "GET") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      return json(await stub.getVaultStatus());
    }

    if (url.pathname === "/api/leaf-vault/snapshot" && request.method === "POST") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      const seed = await stub.getSeed();
      if (!seed) return json({ error: "unclaimed" }, 409);
      let wallet;
      try {
        wallet = await initWallet(env, seed);
        const r = await snapshotToDO(wallet, stub, { networkLabel: env.SPARK_NETWORK });
        return json({ ...r, status: await stub.getVaultStatus() }, r.ok ? 200 : 500);
      } catch (e) {
        return json({ ok: false, error: String(e?.message ?? e).slice(0, 400) }, 500);
      } finally {
        await wallet?.cleanupConnections?.().catch(() => {});
      }
    }

    // pages
    if (!(await stub.isClaimed()))
      return html(setupPage(JSON.stringify(wordlist), Boolean(env.CLAIM_CODE || env.AUTH_TOKEN)));
    const { sessionSecret } = await stub.getAuth();
    if (await verifySession(sessionSecret, readSessionCookie(request))) return html(CHAT_PAGE);
    return html(LOGIN_PAGE);
  },
};
