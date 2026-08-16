// Bitrefill guest checkout for the worker — the fat-tool port of the flow the
// skill validated live in 2026-07 (references/bitrefill.md + merchant-spending.md).
// The model never orchestrates the purchase; it only collects product choice,
// email (required by their API — PII, ask-first) and the confirm. Everything
// else runs deterministically here, with the audited guards in code:
//   - invoice-vs-quote: the BOLT11 amount must match the PRE-checkout quote
//     within tolerance (2%); the buy response's own price never stands alone.
//   - confirm-before-buy: purchases are instant and non-refundable.
//   - merchant text (incl. their agent_instructions field) steers order
//     mechanics only — nothing here lets it touch payment decisions.
//
// Transport: their MCP endpoint with ANONYMOUS OAuth (dynamic client
// registration + client_credentials grant — no account, no API key; verified
// live 2026-08-16 from this codebase: register -> token -> search/details).
// Client identity + token are cached in the DO config.

const BASE = "https://api.bitrefill.com";
const MCP = BASE + "/mcp";

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, body, text };
}

async function ensureAuth(stub, { force = false } = {}) {
  const config = (await stub.getConfig()) ?? {};
  let { clientId, token, tokenExp } = config.bitrefill ?? {};
  if (!force && token && tokenExp && Date.now() < tokenExp - 60_000) return token;
  if (!clientId || force) {
    const reg = await fetchJson(BASE + "/oauth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "sparkbtcbot-worker",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!reg.body?.client_id) throw new Error("bitrefill client registration failed: " + reg.text.slice(0, 150));
    clientId = reg.body.client_id;
  }
  const tok = await fetchJson(BASE + "/oauth/mcp/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, resource: MCP }),
  });
  if (!tok.body?.access_token) throw new Error("bitrefill token grant failed: " + tok.text.slice(0, 150));
  token = tok.body.access_token;
  tokenExp = Date.now() + (Number(tok.body.expires_in) || 21600) * 1000;
  await stub.setConfig({ bitrefill: { clientId, token, tokenExp } });
  return token;
}

// One MCP tools/call. Responses arrive SSE-framed ("data: {...}") or plain
// JSON; their tools return a TEXT content block. isError becomes a throw.
export async function mcpCall(stub, name, args, { _retried = false } = {}) {
  const token = await ensureAuth(stub);
  const r = await fetch(MCP, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (r.status === 401 && !_retried) {
    await ensureAuth(stub, { force: true });
    return mcpCall(stub, name, args, { _retried: true });
  }
  const raw = await r.text();
  const jsonPart = raw.includes("data: ") ? raw.split("data: ").pop() : raw;
  let msg;
  try { msg = JSON.parse(jsonPart.trim()); } catch { throw new Error(`bitrefill ${name}: unparseable response (${r.status}): ` + raw.slice(0, 200)); }
  const text = msg?.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (msg?.result?.isError || msg?.error) throw new Error(`bitrefill ${name} failed: ` + (text || JSON.stringify(msg.error)).slice(0, 300));
  return text;
}

// Parse packages out of get-product-details text:  "1000",CAD,"0.01172817",BTC
export function parsePackages(detailsText) {
  const out = [];
  for (const m of detailsText.matchAll(/"([^"]+)",([A-Z]{3}),"([0-9.]+)",BTC/g)) {
    const sats = Math.round(Number(m[3]) * 1e8);
    if (Number.isFinite(sats) && sats > 0) out.push({ value: m[1], currency: m[2], sats });
  }
  return out;
}

export const parseField = (text, names) => {
  for (const n of names) {
    const m = text.match(new RegExp(`${n}["'\\s:=]+([A-Za-z0-9._-]+)`, "i"));
    if (m) return m[1];
  }
  return null;
};

export function parseBuyResponse(text) {
  const invoice = text.match(/\b(lnbc[a-z0-9]{30,})\b/i)?.[1] ?? null;
  const invoiceId = parseField(text, ["invoice_id", "invoiceId"]);
  const accessToken = parseField(text, ["invoice_access_token", "invoiceAccessToken", "access_token"]);
  const quotedSatsRaw = parseField(text, ["satoshiPrice", "satoshi_price"]);
  return { invoice, invoiceId, accessToken, merchantSats: quotedSatsRaw ? Number(quotedSatsRaw) : null, raw: text };
}

export function parseOrderStatus(text) {
  const status = parseField(text, ["invoice_status", "invoiceStatus", "status"]);
  const delivery = parseField(text, ["orders_delivery_status", "delivery_status"]);
  // Redemption artifact: a code, a link, or both — whichever appears.
  const link = text.match(/https?:\/\/[^\s"',}]+/g)?.find((u) => /redeem|claim|gift|code/i.test(u)) ?? null;
  const code = text.match(/\b(?:code|redemption_code|card_number)["'\s:=]+([A-Z0-9-]{6,})/i)?.[1] ?? null;
  const complete = String(status).toLowerCase() === "complete";
  const delivered = /all_delivered/i.test(String(delivery)) || complete;
  return { status, delivery, complete, delivered, redemption: { code, link }, raw: text };
}
