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
  randomB64u,
  verifyPasskeyRegistration,
  verifyPasskeyAssertion,
  secretsMatch,
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
    name: "get_transfers",
    description:
      "List this wallet's recent transfers (incoming and outgoing) with amounts, direction, status and timestamps.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default 10, max 20)" },
      },
      required: [],
    },
  },
  {
    name: "get_static_deposit_address",
    description:
      "Get the wallet's REUSABLE on-chain Bitcoin (L1) deposit address. Deposits to it need 3 confirmations and must then be CLAIMED (see list_pending_deposits / claim_deposit).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_pending_deposits",
    description:
      "List confirmed-but-unclaimed L1 deposits waiting on the static deposit address. Each entry can be claimed with claim_deposit.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "claim_deposit",
    description:
      "Claim a confirmed L1 deposit into the Spark balance. Without confirm it returns the quote (credited sats + max fee) — show that to the user and get an explicit yes before calling again with confirm=true.",
    parameters: {
      type: "object",
      properties: {
        txid: { type: "string", description: "L1 transaction id of the deposit" },
        vout: { type: "number", description: "Output index (default 0)" },
        confirm: {
          type: "boolean",
          description: "Must be true; set only after the user approved the quoted fee",
        },
      },
      required: ["txid"],
    },
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
    name: "pay_l402",
    description:
      "Fetch an L402/LSAT-paywalled URL, paying its Lightning invoice if required. Without confirm it returns the quoted price — show the user and get an explicit yes, then call again with confirm=true. Reuses a cached token for the domain when one exists (no re-payment).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The paywalled https URL" },
        confirm: {
          type: "boolean",
          description: "Must be true to actually pay; set only after explicit user confirmation",
        },
      },
      required: ["url"],
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

// ---- L402 helpers (ported from the skill's l402-paywalls.js) ----

// Invoice amount from the BOLT11 human-readable part — no decoder dependency.
// Amountless invoices return null (refused: an unbounded invoice can't be
// amount-guarded). Ceil so the guard over-counts rather than under-counts.
function bolt11AmountSats(invoice) {
  const m = /^ln(bc|tb|bcrt)(\d+)([munp])?1/.exec(String(invoice).trim().toLowerCase());
  if (!m) return null;
  const mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 }[m[3]] ?? 1;
  const sats = Math.ceil(Number(m[2]) * mult * 1e8);
  return Number.isSafeInteger(sats) && sats > 0 ? sats : null;
}

// Parse a 402 challenge: WWW-Authenticate header first (field-by-name so it
// survives L402/LSAT schemes, any field order, macaroon= or token=), then the
// JSON body (non-standard but common).
async function parseL402Challenge(response) {
  const wwwAuth = response.headers.get("www-authenticate") || "";
  const field = (key) => wwwAuth.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
  let invoice = field("invoice");
  let macaroon = field("macaroon") || field("token");
  if (!invoice || !macaroon) {
    const ct = response.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const body = await response.json().catch(() => ({}));
      invoice = invoice || body.invoice || body.payment_request || body.pr;
      macaroon = macaroon || body.macaroon || body.token;
    }
  }
  return invoice && macaroon ? { invoice, macaroon } : null;
}

const l402Body = async (response) => {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1500);
};

// Lazy: the SDK does I/O at module-eval time, which workerd forbids at global scope.
async function initWallet(env, seed) {
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const init = await SparkWallet.initialize({
    mnemonicOrSeed: seed,
    options: { network: env.SPARK_NETWORK || "MAINNET" },
  });
  return init.wallet;
}

// Rolling-window budget (spend-ledger port). Default 21,000 sats/24h — a
// bounded default loss beats an unbounded default; raise SPARK_DAILY_BUDGET_SATS
// deliberately (or set it to "off" to disable, matching the Node lib's opt-in).
function dailyBudget(env) {
  const raw = env.SPARK_DAILY_BUDGET_SATS;
  if (String(raw).toLowerCase() === "off") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 21000;
}

// Atomic check-and-record against the DO ledger. Returns { ok, entryId?, ... };
// callers unrecord on provable non-spend failures.
async function reserveSpend(env, stub, sats, operation) {
  return stub.reserveSpend({ sats, operation, budgetSats: dailyBudget(env), windowMs: 24 * 3600 * 1000 });
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
      const budget = await state.stub?.spendStatus?.({ budgetSats: dailyBudget(env) }).catch(() => null);
      return { balanceSats: b.balance.toString(), ...(budget?.budgetSats != null ? { dailyBudget: budget } : {}) };
    }
    case "get_spark_address":
      return { sparkAddress: await wallet.getSparkAddress() };
    case "get_deposit_address":
      return {
        depositAddress: await wallet.getSingleUseDepositAddress(),
        note: "single-use L1 address; funds appear after confirmation and claim",
      };
    case "get_transfers": {
      const limit = Math.min(Math.max(1, Math.floor(Number(args.limit) || 10)), 20);
      const t = await wallet.getTransfers(limit, 0);
      return {
        transfers: (t?.transfers ?? []).map((tr) => ({
          time: tr.createdTime,
          type: tr.type,
          direction: tr.transferDirection,
          amountSats: String(tr.totalValue ?? ""),
          status: tr.status,
        })),
      };
    }
    case "get_static_deposit_address":
      return {
        depositAddress: await wallet.getStaticDepositAddress(),
        note: "reusable L1 address; after 3 confirmations the deposit must be CLAIMED (list_pending_deposits, then claim_deposit)",
      };
    case "list_pending_deposits": {
      // Static-address deposits sit invisible to getBalance until claimed —
      // scan each static address for confirmed-but-unclaimed UTXOs.
      const addrs = await wallet.queryStaticDepositAddresses();
      const pending = [];
      for (const addr of addrs ?? []) {
        const utxos = await wallet.getUtxosForDepositAddress(addr, 100, 0, true); // excludeClaimed
        for (const u of utxos ?? []) pending.push({ txid: u.txid, vout: u.vout, address: addr });
      }
      return { pending, note: pending.length ? "claim each with claim_deposit" : "nothing confirmed-and-unclaimed" };
    }
    case "claim_deposit": {
      const txid = String(args.txid || "");
      const vout = Math.max(0, Math.floor(Number(args.vout) || 0));
      // Quote first, always: the fee ceiling is SIZE-AWARE (10% of the quoted
      // credit) and fails closed on an unreadable quote — same posture as the
      // Node agent's claimDeposit.
      const quote = await wallet.getClaimStaticDepositQuote(txid, vout);
      const quoted = quote?.creditAmountSats == null ? NaN : Number(quote.creditAmountSats);
      if (!Number.isFinite(quoted))
        return { error: "claim quote unreadable for this txid/vout — is the deposit confirmed (3 blocks)?" };
      const maxFee = Math.ceil(quoted / 10);
      if (args.confirm !== true)
        return {
          refused: "confirm flag not set — show the user this quote and ask for an explicit yes",
          quote: { creditSats: quoted, maxFeeSats: maxFee, txid, vout },
        };
      // The claim's FEE is the outbound spend (the credit is incoming).
      const cr = await reserveSpend(env, state.stub, maxFee, "deposit-claim-fee");
      if (!cr.ok) return { refused: cr.reason, budget: cr };
      let res;
      try {
        res = await wallet.claimStaticDepositWithMaxFee({
          transactionId: txid,
          outputIndex: vout,
          maxFee,
        });
      } catch (e) {
        await state.stub?.unrecordSpend?.(cr.entryId).catch(() => {});
        throw e;
      }
      state.leafChanged = true; // leaves changed — refresh the exit backup after this chat
      return { claimed: true, creditSats: quoted, result: JSON.parse(jsonSafe(res)) };
    }
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
      // Budget the AMOUNT + worst-case fee; amountless invoices are uncountable
      // and fail closed while a budget is set (spend-ledger semantics).
      const invAmount = bolt11AmountSats(args.invoice);
      if (invAmount == null && dailyBudget(env) != null)
        return { refused: "invoice is amountless — cannot count it against the daily budget" };
      const lr = await reserveSpend(env, state.stub, (invAmount ?? 0) + maxLnFee, "lightning");
      if (!lr.ok) return { refused: lr.reason, budget: lr };
      let res;
      try {
        res = await wallet.payLightningInvoice({
          invoice: String(args.invoice),
          maxFeeSats: maxLnFee,
        });
      } catch (e) {
        await state.stub?.unrecordSpend?.(lr.entryId).catch(() => {});
        throw e;
      }
      state.leafChanged = true; // leaves moved — refresh the exit backup after this chat
      return { paid: true, result: JSON.parse(jsonSafe(res)) };
    }
    case "pay_l402": {
      let url;
      try {
        url = new URL(String(args.url));
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("bad scheme");
      } catch {
        return { error: "url must be a valid http(s) URL" };
      }
      // Cached token for this domain? Try it first — no payment.
      const config = (await state.stub?.getConfig?.()) ?? {};
      const cached = config.l402Tokens?.[url.host];
      if (cached) {
        const r = await fetch(url, { headers: { Authorization: `L402 ${cached.macaroon}:${cached.preimage}` } });
        if (r.status !== 402 && r.status !== 401)
          return { paid: false, cachedToken: true, status: r.status, data: await l402Body(r) };
        // expired/rejected — forget it and fall through to pay fresh
        delete config.l402Tokens[url.host];
        await state.stub?.setConfig?.({ l402Tokens: config.l402Tokens });
      }
      const first = await fetch(url);
      if (first.status !== 402)
        return { paid: false, status: first.status, data: await l402Body(first) };
      const challenge = await parseL402Challenge(first);
      if (!challenge) return { error: "402 response but no parseable L402 challenge (invoice+macaroon)" };
      const amountSats = bolt11AmountSats(challenge.invoice);
      if (amountSats == null) return { refused: "invoice is amountless or unparseable — cannot amount-guard it" };
      // Bound the AMOUNT, not just the fee: a hostile paywall can demand any invoice.
      if (amountSats > maxSend)
        return { refused: `paywall wants ${amountSats} sats — over the ${maxSend}-sat hard cap` };
      if (args.confirm !== true)
        return {
          refused: "confirm flag not set — show the user this price and get an explicit yes",
          quote: { amountSats, domain: url.host },
        };
      // Fee cap mirrors lib/fee-guards lightningFeeCap: max(25, 0.5%) — the 25
      // floor is a live-payment lesson (a 4,464-sat send needed a 25-sat fee).
      const feeCap = Math.max(25, Math.ceil((amountSats * 50) / 10_000));
      const l4r = await reserveSpend(env, state.stub, amountSats + feeCap, "l402");
      if (!l4r.ok) return { refused: l4r.reason, budget: l4r };
      let pay;
      try {
        pay = await wallet.payLightningInvoice({ invoice: challenge.invoice, maxFeeSats: feeCap });
      } catch (e) {
        await state.stub?.unrecordSpend?.(l4r.entryId).catch(() => {});
        throw e;
      }
      state.leafChanged = true;
      // The preimage is the auth secret — poll briefly if the payment is async,
      // and never return or log it.
      let preimage = pay?.paymentPreimage;
      if (!preimage) {
        for (let i = 0; i < 10 && !preimage; i++) {
          await new Promise((res) => setTimeout(res, 700));
          const s = await wallet.getLightningSendRequest?.(pay?.id).catch(() => null);
          if (s?.status === "LIGHTNING_PAYMENT_FAILED") return { error: "L402 payment failed" };
          preimage = s?.paymentPreimage;
        }
      }
      if (!preimage) return { error: "paid but no preimage arrived in time — retry the tool; the cached payment may resolve" };
      const final = await fetch(url, { headers: { Authorization: `L402 ${challenge.macaroon}:${preimage}` } });
      // Cache the token per-domain in the DO so repeat fetches are free.
      const tokens = { ...(config.l402Tokens ?? {}), [url.host]: { macaroon: challenge.macaroon, preimage } };
      await state.stub?.setConfig?.({ l402Tokens: tokens });
      return { paid: true, amountSats, status: final.status, data: await l402Body(final) };
    }
    case "send_spark": {
      if (args.confirm !== true)
        return { refused: "confirm flag not set — ask the user to confirm first" };
      const amount = Math.floor(Number(args.amountSats));
      if (!(amount > 0) || amount > maxSend)
        return { refused: `amount must be 1..${maxSend} sats (hard cap)` };
      const sr = await reserveSpend(env, state.stub, amount, "spark-send");
      if (!sr.ok) return { refused: sr.reason, budget: sr };
      let res;
      try {
        res = await wallet.transfer({
          receiverSparkAddress: String(args.receiverSparkAddress),
          amountSats: amount,
        });
      } catch (e) {
        await state.stub?.unrecordSpend?.(sr.entryId).catch(() => {});
        throw e;
      }
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
- claim_deposit and pay_l402 also need confirmation: call them WITHOUT confirm first, show the user the quote, and only after an explicit "yes" call again with confirm=true.
- L1 deposits: the single-use address (get_deposit_address) claims automatically after confirmation; the reusable static address (get_static_deposit_address) needs list_pending_deposits + claim_deposit.
- Per-transaction hard caps AND a rolling 24h spending budget are enforced in code; if a tool refuses, relay why (get_balance shows the budget's remaining sats).
- Be concise. Never invent balances or addresses — always use tools.
- Report tool results EXACTLY as returned. Never fabricate transaction details, senders, fees, or amounts that a tool did not return. If you don't know something, say so.
- You cannot access the seed phrase; never discuss revealing it.
- The chat UI automatically shows a scannable QR code when a tool returns a RECEIVING artifact (your spark address, a deposit address, or an invoice you create) — when asked for a QR, call the matching tool and mention the QR appears below. Outgoing sends never get a QR.`;

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
  const state = { seed, stub }; // stub: pay_l402 caches domain tokens in the DO
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

// Current leaf count, or null when it can't be read. The cheap probe that
// decides whether a full re-capture is worth its subrequest/CPU budget.
async function leafCountOrNull(wallet) {
  try {
    const leaves = await wallet?.leafManager?.getLeaves?.(true);
    return Array.isArray(leaves) ? leaves.length : null;
  } catch {
    return null;
  }
}

// Cron body: init the wallet from the DO seed, snapshot, record. Never touches
// FROST signing — queries + proto codec only.
async function runCronSnapshot(env, stub) {
  const seed = await stub.getSeed();
  if (!seed) return;
  let wallet;
  try {
    wallet = await initWallet(env, seed);
    // Booting claims pending incoming transfers, and those claims can land
    // AFTER the first capture (observed live: a tick claimed 1000 sats yet
    // captured the pre-claim leaf set). Watch the leaf-changing events and
    // re-capture after a short settle window, up to twice.
    // Only the two events that PROVE a leaf change — balance:update fires on
    // ordinary boots too, and re-capturing on it tripled the CPU per tick
    // (observed live: consecutive exceededCpu kills on a heavy leafset).
    let claimed = false;
    for (const ev of ["transfer:claimed", "deposit:confirmed"])
      wallet.on?.(ev, () => { claimed = true; });
    let r = await snapshotToDO(wallet, stub, { networkLabel: env.SPARK_NETWORK });
    if (claimed) {
      await new Promise((res) => setTimeout(res, 4000));
      // One getLeaves, not a whole snapshot: a re-capture re-runs the ancestor
      // prefetch, the per-leaf chain walk and a proto-encode of every node, so
      // spend it only when the set actually moved. An unchanged count means the
      // first capture already saw the claim; an unreadable count declines to
      // guess. A failed first pass has no leafCount, so it still gets its retry.
      const after = await leafCountOrNull(wallet);
      if (after !== null && after !== r?.leafCount) {
        r = await snapshotToDO(wallet, stub, { networkLabel: env.SPARK_NETWORK });
      }
    }
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
      // Passkey-era claims need no password: the claim code doubles as the
      // fallback login (checked LIVE against the env secret, so it's
      // rotatable from the dashboard). Without an env code there is no
      // fallback to inherit, so a password is still required.
      let pwHash = null;
      if (typeof body.password === "string" && body.password.length > 0) {
        if (body.password.length < 8) return json({ error: "password must be at least 8 characters" }, 400);
        pwHash = await hashPassword(body.password);
      } else if (!requiredCode) {
        return json({ error: "password required (no claim code is configured to fall back on)" }, 400);
      }
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
      if (!sessionSecret) return json({ error: "unclaimed" }, 409);
      const supplied = String(body?.password || "");
      // Legacy password if one was set, else the LIVE claim code (dashboard-
      // rotatable). Both accepted when both exist.
      const pwOk = pwHash ? await verifyPassword(supplied, pwHash) : false;
      const codeOk = !pwOk && (await secretsMatch(supplied, env.CLAIM_CODE || env.AUTH_TOKEN || ""));
      if (!pwOk && !codeOk) return json({ error: "wrong password or claim code" }, 401);
      const token = await mintSession(sessionSecret);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
    }

    // ---- passkeys: enrollment (session-gated) and login (public) ----
    if (url.pathname === "/api/passkey/register-options" && request.method === "POST") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      const challenge = randomB64u();
      await stub.putAuthChallenge("register", challenge);
      const existing = (await stub.getPasskeys()).map((c) => c.id);
      return json({ challenge, rpId: url.hostname, excludeIds: existing });
    }

    if (url.pathname === "/api/passkey/register" && request.method === "POST") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      const cred = await request.json().catch(() => null);
      if (!cred) return json({ error: "bad request" }, 400);
      const expectedChallenge = await stub.takeAuthChallenge("register");
      try {
        const stored = await verifyPasskeyRegistration({
          cred,
          expectedChallenge,
          origin: url.origin,
          rpId: url.hostname,
        });
        const r = await stub.addPasskey(stored);
        if (!r.ok) return json({ error: r.error }, 409);
        return json({ ok: true, passkeys: r.count });
      } catch (e) {
        return json({ error: "enrollment failed: " + String(e?.message ?? e).slice(0, 200) }, 400);
      }
    }

    if (url.pathname === "/api/passkey/login-options" && request.method === "POST") {
      const ids = (await stub.getPasskeys()).map((c) => c.id);
      if (!ids.length) return json({ error: "no passkeys enrolled" }, 404);
      const challenge = randomB64u();
      await stub.putAuthChallenge("login", challenge);
      return json({ challenge, rpId: url.hostname, credentialIds: ids });
    }

    if (url.pathname === "/api/passkey/login" && request.method === "POST") {
      const cred = await request.json().catch(() => null);
      if (!cred) return json({ error: "bad request" }, 400);
      const stored = (await stub.getPasskeys()).find((c) => c.id === cred.id);
      if (!stored) return json({ error: "unknown credential" }, 401);
      const expectedChallenge = await stub.takeAuthChallenge("login");
      try {
        const { counter } = await verifyPasskeyAssertion({
          cred,
          stored,
          expectedChallenge,
          origin: url.origin,
          rpId: url.hostname,
        });
        await stub.updatePasskeyCounter(stored.id, counter);
      } catch (e) {
        return json({ error: "passkey login failed: " + String(e?.message ?? e).slice(0, 200) }, 401);
      }
      const { sessionSecret } = await stub.getAuth();
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

    // QR render for addresses/invoices the bot hands out. Session-gated so it
    // isn't a free QR service for the internet; SVG so it's crisp and tiny.
    if (url.pathname === "/api/qr" && request.method === "GET") {
      if (!(await sessionOk(stub, request))) return json({ error: "unauthorized" }, 401);
      const data = url.searchParams.get("d") || "";
      if (!data || data.length > 1200) return json({ error: "d must be 1..1200 chars" }, 400);
      const qrcode = (await import("qrcode-generator")).default;
      // Uppercase bech32 payloads so the encoder can use alphanumeric mode
      // (smaller, easier-scanning QR) — valid for bech32/bech32m and BOLT11.
      const payload = /^(lnbc|lntb|spark1|bc1|bitcoin:)[a-z0-9:]+$/i.test(data) ? data.toUpperCase() : data;
      let qr;
      try {
        qr = qrcode(0, "M");
        qr.addData(payload);
        qr.make();
      } catch {
        return json({ error: "data does not fit in a QR code" }, 400);
      }
      return new Response(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }), {
        headers: { "content-type": "image/svg+xml", "cache-control": "private, max-age=3600" },
      });
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
