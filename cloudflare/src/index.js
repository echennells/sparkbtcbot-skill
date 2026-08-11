const jsonSafe = (v) =>
  JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));

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

async function runTool(name, args, env, state) {
  const maxSend = Number(env.SPARK_MAX_SEND_SATS || 5000);
  const maxLnFee = Number(env.SPARK_MAX_LN_FEE_SATS || 50);

  if (!state.wallet) {
    const { SparkWallet } = await import("@buildonspark/spark-sdk");
    const init = await SparkWallet.initialize({
      mnemonicOrSeed: env.SPARK_MNEMONIC,
      options: { network: env.SPARK_NETWORK || "MAINNET" },
    });
    state.wallet = init.wallet;
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
      return { sent: true, result: JSON.parse(jsonSafe(res)) };
    }
    default:
      return { error: "unknown tool " + name };
  }
}

function normalizeModelResponse(r) {
  if (r?.choices?.[0]?.message) {
    const m = r.choices[0].message;
    return { content: m.content ?? "", rawCalls: m.tool_calls || [] };
  }
  return { content: r?.response ?? "", rawCalls: r?.tool_calls || [] };
}

function parseCall(tc) {
  const name = tc.function?.name ?? tc.name;
  let args = tc.function?.arguments ?? tc.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return { name, args, id: tc.id };
}

const SYSTEM_PROMPT = `You are sparkbtcbot, a Bitcoin wallet assistant running on the Spark L2 (MAINNET — real money, real sats).
You control one wallet via tools. Amounts are always in sats.
Rules:
- Before any send_spark or pay_lightning_invoice, restate amount + recipient and get an explicit "yes" from the user in this conversation; only then call the tool with confirm=true.
- Per-transaction hard caps are enforced in code; if a tool refuses, relay why.
- Be concise. Never invent balances or addresses — always use tools.
- Report tool results EXACTLY as returned. Never fabricate transaction details, senders, fees, or amounts that a tool did not return. If you don't know something, say so.
- You cannot access the seed phrase; never discuss revealing it.`;

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

async function callModel(env, messages, tools) {
  const useOpenRouter = env.OPENROUTER_API_KEY && !env.MODEL.startsWith("@cf/");
  if (!useOpenRouter) return env.AI.run(env.MODEL, { messages, tools, max_tokens: 900 });
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "content-type": "application/json",
      "x-title": "sparkbtcbot",
    },
    body: JSON.stringify({ model: env.MODEL, messages, tools, max_tokens: 900 }),
  });
  if (!res.ok)
    throw new Error("openrouter " + res.status + ": " + (await res.text()).slice(0, 200));
  return res.json();
}

async function chat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || body.token !== env.AUTH_TOKEN || !env.AUTH_TOKEN)
    return new Response(jsonSafe({ error: "unauthorized" }), { status: 401 });

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .slice(-30)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  const tools = TOOLS.map((t) => ({ type: "function", function: t }));
  const state = {};
  const toolEvents = [];
  let reply = "";

  try {
    for (let turn = 0; turn < 6; turn++) {
      let r;
      try {
        r = await callModel(env, messages, tools);
      } catch (e) {
        reply = "model error: " + String(e?.message ?? e).slice(0, 300);
        break;
      }
      const { content, rawCalls } = normalizeModelResponse(r);
      if (!rawCalls.length) {
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
        const toolMsg = { role: "tool", name, content: jsonSafe(result) };
        if (id) toolMsg.tool_call_id = id;
        messages.push(toolMsg);
      }
      reply = content || reply;
    }
  } finally {
    if (state.wallet) await state.wallet.cleanupConnections().catch(() => {});
  }

  return new Response(jsonSafe({ reply, toolEvents }), {
    headers: { "content-type": "application/json" },
  });
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sparkbtcbot</title><style>
:root{color-scheme:dark}
body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:10px 16px;border-bottom:1px solid #21262d;font-weight:600}
header small{color:#f0b429;font-weight:400;margin-left:8px}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:75%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.user{align-self:flex-end;background:#1f6feb}
.bot{align-self:flex-start;background:#21262d}
.tool{align-self:flex-start;color:#8b949e;font-size:12px;font-family:ui-monospace,monospace;padding:0 4px}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #21262d}
input{flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;color:inherit;padding:10px 12px;font:inherit}
button{background:#238636;border:0;border-radius:8px;color:#fff;padding:0 18px;font:inherit;cursor:pointer}
button:disabled{opacity:.5}
</style></head><body>
<header>&#9889; sparkbtcbot<small>Spark L2 &middot; MAINNET</small></header>
<div id="log"></div>
<form id="f"><input id="i" placeholder="Ask about your wallet&hellip;" autocomplete="off" autofocus><button id="b">Send</button></form>
<script>
const log = document.getElementById('log'), f = document.getElementById('f'),
      i = document.getElementById('i'), b = document.getElementById('b');
let token = localStorage.sbToken || '';
const history = [];
function add(cls, text){ const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
if (!token) { token = prompt('Access token:') || ''; localStorage.sbToken = token; }
add('bot', 'Hi! I\\'m your Spark wallet bot. Try: "what\\'s my balance?" or "give me a lightning invoice for 500 sats".');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = i.value.trim(); if (!q) return;
  i.value = ''; b.disabled = true;
  add('user', q); history.push({role:'user', content:q});
  const w = add('tool', 'thinking…');
  try {
    const res = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ token, messages: history }) });
    if (res.status === 401) { localStorage.removeItem('sbToken'); w.textContent = 'bad token — reload the page'; return; }
    const j = await res.json();
    w.remove();
    for (const t of (j.toolEvents || [])) add('tool', '\\u2699 ' + t.tool + ' \\u2192 ' + JSON.stringify(t.result).slice(0, 200));
    add('bot', j.reply || '(no reply)');
    history.push({role:'assistant', content: j.reply || ''});
  } catch (err) { w.textContent = 'error: ' + err; }
  finally { b.disabled = false; i.focus(); }
});
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat" && request.method === "POST")
      return chat(request, env);
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response(PAGE, {
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  },
};
