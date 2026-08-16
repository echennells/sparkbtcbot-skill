// Client-side WebAuthn ceremony helpers, shared by the pages that need them.
// Kept dependency-free and interpolation-free (no \${} inside) so it can live
// safely inside the page template literals.
const PASSKEY_JS = `
const bu = {
  enc: (b) => btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(b)))).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/,''),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g,'+').replace(/_/g,'/')), function(c){return c.charCodeAt(0)})
};
async function enrollPasskey(){
  const o = await fetch('/api/passkey/register-options',{method:'POST'}).then(r=>r.json());
  if (!o.challenge) throw new Error(o.error||'no options');
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: bu.dec(o.challenge),
    rp: { id: o.rpId, name: 'sparkbtcbot' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'wallet', displayName: 'wallet owner' },
    pubKeyCredParams: [{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
    excludeCredentials: (o.excludeIds||[]).map(function(id){return {type:'public-key', id: bu.dec(id)}}),
    authenticatorSelection: { residentKey:'preferred', userVerification:'preferred' },
    timeout: 60000
  }});
  const resp = cred.response;
  const r = await fetch('/api/passkey/register',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: cred.id, clientDataJSON: bu.enc(resp.clientDataJSON),
      authenticatorData: bu.enc(resp.getAuthenticatorData()), publicKey: bu.enc(resp.getPublicKey()),
      alg: resp.getPublicKeyAlgorithm() })}).then(function(x){return x.json()});
  if (!r.ok) throw new Error(r.error||'enroll failed');
  return r;
}
async function passkeyLogin(){
  const o = await fetch('/api/passkey/login-options',{method:'POST'}).then(r=>r.json());
  if (!o.challenge) throw new Error(o.error||'no passkeys enrolled yet');
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: bu.dec(o.challenge),
    rpId: o.rpId,
    allowCredentials: (o.credentialIds||[]).map(function(id){return {type:'public-key', id: bu.dec(id)}}),
    userVerification: 'preferred', timeout: 60000
  }});
  const resp = cred.response;
  const r = await fetch('/api/passkey/login',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: cred.id, clientDataJSON: bu.enc(resp.clientDataJSON),
      authenticatorData: bu.enc(resp.authenticatorData), signature: bu.enc(resp.signature) })}).then(function(x){return x.json()});
  if (!r.ok) throw new Error(r.error||'login failed');
  return r;
}
`;

const STYLE = `<style>
:root{color-scheme:dark}
body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,sans-serif}
.wrap{max-width:520px;margin:0 auto;padding:24px 16px}
h1{font-size:20px}h1 small{color:#f0b429;font-weight:400;margin-left:8px;font-size:13px}
label{display:block;margin:14px 0 4px;color:#8b949e;font-size:13px}
input,textarea{width:100%;box-sizing:border-box;background:#161b22;border:1px solid #30363d;border-radius:8px;color:inherit;padding:10px 12px;font:inherit}
textarea{font-family:ui-monospace,monospace;min-height:70px}
button{background:#238636;border:0;border-radius:8px;color:#fff;padding:10px 18px;font:inherit;cursor:pointer;margin-top:16px}
button.alt{background:#21262d}
button:disabled{opacity:.5}
.err{color:#f85149;margin-top:10px;min-height:1.2em}
.words{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:12px 0;padding:14px;background:#161b22;border:1px solid #30363d;border-radius:8px;font-family:ui-monospace,monospace}
.words span{color:#8b949e;font-size:11px;margin-right:4px}
.warn{background:#341a00;border:1px solid #9e6a03;border-radius:8px;padding:10px 12px;font-size:13px;margin:12px 0}
.hide{display:none}
</style>`;

// One-screen claim: password (+ claim code when set) and a single button. A
// fresh mnemonic is generated CLIENT-SIDE on submit; the 12 words are shown
// once AFTER the claim succeeds (no quiz — the leaf-vault backup plus the DO
// copy mean a skipped paper backup is recoverable-by-download, not fatal).
// Import + model key live behind an "advanced" disclosure.
export function setupPage(wordlistJson, hasClaimCode) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot setup</title>${STYLE}<style>
details{margin:14px 0}summary{color:#8b949e;font-size:13px;cursor:pointer}
</style></head><body><div class="wrap">
<div id="setup">
<h1>&#9889; sparkbtcbot<small>one-time setup</small></h1>
${hasClaimCode
  ? `<p>Enter the claim code you set when deploying and you're in. A new wallet is generated in your browser; you'll add a passkey (Face ID / Touch ID) and see your recovery words right after. The claim code stays your fallback login, so keep it safe.</p>`
  : `<p>Pick a password and you're in. A new wallet is generated in your browser; its recovery words are shown right after (or expand advanced to import an existing one).</p>`}
<form id="f">
${hasClaimCode
  ? `<label>Claim code (shown when you deployed &mdash; also your fallback login)</label><input id="code" autocomplete="off" required autofocus>`
  : `<label>Choose a password (min 8 chars — this is how you'll log in)</label>
<input id="pw" type="password" minlength="8" required autofocus>
<label>Repeat password</label>
<input id="pw2" type="password" required>`}
<details>
<summary>Advanced: import an existing wallet / bring your own model key</summary>
<label>Existing mnemonic (12 or 24 words — leave blank to generate a new wallet)</label>
<textarea id="mnemonicIn" autocomplete="off"></textarea>
<label>OpenRouter API key (optional — enables Claude/GLM etc.; blank = free Workers AI model)</label>
<input id="orKey" autocomplete="off" placeholder="sk-or-...">
</details>
<div class="err" id="err"></div>
<button id="go">Create wallet &amp; sign in</button>
</form>
</div>
<div id="pk" class="hide">
<h1>&#9889; add a passkey</h1>
<p>Use Face ID / Touch ID / your device PIN to sign in from now on &mdash; nothing to type or remember. <b>Enrolling disables the typed login</b>: from then on this passkey is the only way in${hasClaimCode ? " (lost-device recovery: re-enable claim-code login via the SPARK_ALLOW_FALLBACK_LOGIN variable in your Cloudflare dashboard)" : ""}.</p>
<div class="err" id="pkerr"></div>
<button id="pkgo">Enable passkey</button>
<button id="pkskip" class="alt">Skip for now</button>
</div>
<div id="backup" class="hide">
<h1>&#9889; your recovery words</h1>
<div class="warn"><b>Write these 12 words down, in order, on paper.</b> They will never be shown again. They were generated in your browser and stored only, encrypted, inside this Worker. Anyone with these words controls the wallet.</div>
<div class="words" id="words"></div>
<button id="done">I wrote them down &mdash; open my wallet</button>
</div>
<script>
${PASSKEY_JS}
const WORDS = ${wordlistJson};
const $ = (id) => document.getElementById(id);
async function gen() {
  const ent = crypto.getRandomValues(new Uint8Array(16));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', ent.slice().buffer));
  let bin = '';
  for (const b of ent) bin += b.toString(2).padStart(8, '0');
  bin += hash[0].toString(2).padStart(8, '0').slice(0, 4);
  const ws = [];
  for (let i = 0; i < 12; i++) ws.push(WORDS[parseInt(bin.slice(i * 11, (i + 1) * 11), 2)]);
  return ws;
}
let afterAuth = () => { location.href = '/'; };
$('f').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('err'); err.textContent = '';
  ${hasClaimCode ? "" : "if ($('pw').value !== $('pw2').value) { err.textContent = 'passwords do not match'; return; }"}
  const imported = $('mnemonicIn').value.trim().toLowerCase().replace(/\\s+/g, ' ');
  const ws = imported ? null : await gen();
  const m = imported || ws.join(' ');
  $('go').disabled = true;
  const res = await fetch('/api/claim', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimCode: ${hasClaimCode ? "$('code').value.trim()" : "''"}, mnemonic: m, password: ${hasClaimCode ? "undefined" : "$('pw').value"}, openrouterKey: $('orKey').value.trim() || undefined }) });
  const j = await res.json().catch(() => ({}));
  if (!(res.ok && j.ok)) { err.textContent = j.error || ('claim failed (' + res.status + ')'); $('go').disabled = false; return; }
  if (!imported) {
    afterAuth = () => {
      $('words').innerHTML = ws.map((w, i) => '<div><span>' + (i + 1) + '</span>' + w + '</div>').join('');
      $('pk').classList.add('hide');
      $('backup').classList.remove('hide');
    };
  }
  // Passkey step (skippable; unsupported browsers go straight through)
  if (window.PublicKeyCredential) {
    $('setup').classList.add('hide');
    $('pk').classList.remove('hide');
  } else { afterAuth(); }
};
$('pkgo').onclick = async () => {
  $('pkerr').textContent = '';
  $('pkgo').disabled = true;
  try { await enrollPasskey(); afterAuth(); }
  catch (e) { $('pkerr').textContent = String(e.message || e); $('pkgo').disabled = false; }
};
$('pkskip').onclick = () => { afterAuth(); };
$('done').onclick = () => { location.href = '/'; };
</script></div></body></html>`;
}

// hasPasskeys + fallback policy shape the page: once a passkey exists (and
// fallback isn't re-enabled via SPARK_ALLOW_FALLBACK_LOGIN), the password/
// claim-code form is gone — the passkey is the only door.
export function loginPage(hasPasskeys, allowFallback) {
  const showForm = !hasPasskeys || allowFallback;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot login</title>${STYLE}</head><body><div class="wrap">
<h1>&#9889; sparkbtcbot<small>login</small></h1>
${hasPasskeys ? `<button id="pkbtn" style="width:100%;margin-top:20px">&#128273; Sign in with passkey</button>
<div class="err" id="pkerr"></div>` : ""}
${showForm ? `<form id="f">
<label>${hasPasskeys ? "Or: password / claim code" : "Password / claim code"}</label>
<input id="pw" type="password" required>
<div class="err" id="err"></div>
<button class="alt">Log in</button>
</form>` : `<p style="color:#8b949e;font-size:13px">This wallet is passkey-only. Lost your passkey? The wallet owner can set the <code>SPARK_ALLOW_FALLBACK_LOGIN</code> variable to <code>true</code> in the Cloudflare dashboard to re-enable claim-code login.</p>`}
<script>
${PASSKEY_JS}
const pkbtn = document.getElementById('pkbtn');
if (pkbtn) {
  if (!window.PublicKeyCredential) pkbtn.style.display = 'none';
  pkbtn.onclick = async () => {
    document.getElementById('pkerr').textContent = '';
    pkbtn.disabled = true;
    try { await passkeyLogin(); location.href = '/'; }
    catch (e) { document.getElementById('pkerr').textContent = String(e.message || e); pkbtn.disabled = false; }
  };
}
const lf = document.getElementById('f');
if (lf) lf.onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }) });
  if (res.ok) location.href = '/';
  else document.getElementById('err').textContent = 'login refused';
};
</script></div></body></html>`;
}

// Session-gated seed reveal — the worker equivalent of the Node skill's
// reveal-mnemonic: deliberate, user-initiated, rendered only in the owner's
// logged-in browser. The words never transit chat, tools, logs, or any
// transcript, and the model has no tool that can reach them.
export const REVEAL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot reveal</title>${STYLE}</head><body><div class="wrap">
<h1>&#9889; recovery words</h1>
<div class="warn"><b>These 12 words ARE the wallet.</b> Anyone who sees them controls the funds — forever, from anywhere. Reveal only on a private screen, and copy them to PAPER — not a file, screenshot, or clipboard.</div>
<button id="go">Reveal my recovery words</button>
<div class="words hide" id="words"></div>
<div class="err" id="err"></div>
<p style="color:#8b949e;font-size:13px"><a href="/" style="color:#8b949e">&larr; back to chat</a></p>
<script>
document.getElementById('go').onclick = async () => {
  const err = document.getElementById('err'); err.textContent = '';
  try {
    const r = await fetch('/api/reveal-seed', { method: 'POST' });
    const j = await r.json();
    if (!r.ok || !j.mnemonic) { err.textContent = j.error || 'reveal failed'; return; }
    const el = document.getElementById('words');
    el.innerHTML = j.mnemonic.trim().split(/\\s+/).map((w, i) => '<div><span>' + (i + 1) + '</span>' + w + '</div>').join('');
    el.classList.remove('hide');
    document.getElementById('go').remove();
  } catch (e) { err.textContent = String(e); }
};
</script></div></body></html>`;

// showEnroll: the header "passkey" link exists only until a passkey is on file.
export function chatPage(showEnroll) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot</title><style>
:root{color-scheme:dark}
body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 system-ui,sans-serif;display:flex;flex-direction:column;height:100dvh}
header{padding:10px 16px;border-bottom:1px solid #21262d;font-weight:600;display:flex;justify-content:space-between;align-items:center}
header small{color:#f0b429;font-weight:400;margin-left:8px}
header a{color:#8b949e;font-size:12px;text-decoration:none}
#log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:75%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.user{align-self:flex-end;background:#1f6feb}
.bot{align-self:flex-start;background:#21262d}
.tool{align-self:flex-start;color:#8b949e;font-size:12px;font-family:ui-monospace,monospace;padding:0 4px}
form{display:flex;gap:8px;padding:12px;border-top:1px solid #21262d}
input{flex:1;background:#161b22;border:1px solid #30363d;border-radius:8px;color:inherit;padding:10px 12px;font:inherit}
button{background:#238636;border:0;border-radius:8px;color:#fff;padding:0 18px;font:inherit;cursor:pointer}
button:disabled{opacity:.5}
img.qr{display:block;background:#fff;border-radius:8px;padding:8px;margin-top:8px;width:180px;height:180px}
</style></head><body>
<header><span>&#9889; sparkbtcbot<small>Spark L2 &middot; MAINNET</small></span><span>${showEnroll ? `<a href="#" id="pk" style="margin-right:14px">passkey</a>` : ""}<a href="#" id="snap" style="margin-right:14px">backup now</a><a href="#" id="bk" style="margin-right:14px">download</a><a href="#" id="out">log out</a></span></header>
<div id="log"></div>
<form id="f"><input id="i" placeholder="Ask about your wallet&hellip;" autocomplete="off" autofocus><button id="b">Send</button></form>
<script>
${PASSKEY_JS}
const log = document.getElementById('log'), f = document.getElementById('f'),
      i = document.getElementById('i'), b = document.getElementById('b');
// History persists in THIS BROWSER (localStorage) — reloads and re-logins keep
// it; explicit logout wipes it (shared-machine hygiene). Never server-stored:
// transcripts carry redemption codes and payment details.
const LS_KEY = 'sb_chat_v1';
let history = [], display = [];
function persist(){ try { localStorage.setItem(LS_KEY, JSON.stringify({ history: history.slice(-60), display: display.slice(-200) })); } catch {} }
function add(cls, text, opts){ const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d);
  if (opts && opts.qr) { const img = document.createElement('img'); img.className='qr'; img.alt='QR'; img.src='/api/qr?d='+encodeURIComponent(opts.qr); d.appendChild(img); }
  log.scrollTop = log.scrollHeight;
  if (!(opts && opts.noSave)) { display.push({ cls, text, qr: opts && opts.qr || undefined }); persist(); }
  return d; }
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  if (saved && Array.isArray(saved.display) && saved.display.length) {
    history = Array.isArray(saved.history) ? saved.history : [];
    for (const m of saved.display) { display.push(m); add(m.cls, m.text, { qr: m.qr, noSave: true }); }
  }
} catch {}
// QR codes attach ONLY to receive-artifacts produced by tools this turn —
// an address you're SENDING to must never get one (someone scanning it would
// pay the recipient), so message text is never scanned.
const QR_TOOLS = { get_spark_address: 'sparkAddress', create_lightning_invoice: 'encodedInvoice', get_deposit_address: 'depositAddress', get_static_deposit_address: 'depositAddress' };
function addBot(text, toolEvents){
  let data = null;
  for (const t of (toolEvents || [])) { const f = QR_TOOLS[t.tool]; if (f && t.result && typeof t.result[f] === 'string') data = t.result[f]; }
  return add('bot', text, data ? { qr: data } : undefined);
}
if (!display.length) add('bot', 'Hi! I\\'m your Spark wallet bot. Try: "what\\'s my balance?" or "give me a lightning invoice for 500 sats".');
document.getElementById('out').onclick = async (e) => { e.preventDefault(); try { localStorage.removeItem(LS_KEY); } catch {} await fetch('/api/logout', {method:'POST'}); location.href = '/'; };
const pkLink = document.getElementById('pk');
if (pkLink) pkLink.onclick = async (e) => {
  e.preventDefault();
  if (!window.PublicKeyCredential) { add('tool', '\\u26a0 this browser has no passkey support'); return; }
  try { const r = await enrollPasskey(); add('tool', '\\u2705 passkey enrolled (' + r.passkeys + ' on file) \\u2014 next login uses Face ID / Touch ID; claim-code login is now disabled'); pkLink.remove(); }
  catch (err) { add('tool', '\\u26a0 passkey enrollment failed \\u2014 ' + String(err.message || err)); }
};
document.getElementById('snap').onclick = async (e) => {
  e.preventDefault();
  const w = add('tool', '\\u23f3 capturing exit backup\\u2026');
  try {
    const r = await fetch('/api/leaf-vault/snapshot', {method:'POST'}).then(x => x.json());
    w.textContent = r.ok
      ? '\\u2705 backup captured \\u2014 ' + (r.leafCount ?? '?') + ' leaves (' + (r.skipped || r.network || '') + '). Click download to save it.'
      : '\\u26a0 backup FAILED \\u2014 ' + (r.error || 'unknown') + (r.skipped ? ' (' + r.skipped + ')' : '');
  } catch (err) { w.textContent = '\\u26a0 backup request error: ' + err; }
};
document.getElementById('bk').onclick = async (e) => {
  e.preventDefault();
  const s = await fetch('/api/leaf-vault/status').then(r => r.json()).catch(() => null);
  if (!s || !s.hasBundle) {
    let why = ' \\u2014 snapshots run every 20 min once the wallet holds funds';
    if (s && s.lastError) why = ' \\u2014 ' + s.lastError;
    else if (s && !s.lastRunAt) why = ' \\u2014 and NO snapshot has ever run: the cron trigger may not be firing';
    else if (s && s.lastRunAt) why += ' (last attempt ' + new Date(s.lastRunAt).toISOString() + ')';
    add('tool', '\\u26a0 no exit backup captured yet' + why);
    return;
  }
  add('tool', '\\u2b07 downloading exit backup \\u2014 ' + (s.leafCount ?? '?') + ' leaves, captured ' + (s.bundleCreatedAt || 'unknown') + (s.broken ? ' \\u26a0 backup runs are FAILING; this file is stale' : ''));
  location.href = '/api/leaf-vault';
};
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = i.value.trim(); if (!q) return;
  i.value = ''; b.disabled = true;
  add('user', q); history.push({role:'user', content:q});
  const w = add('tool', 'thinking…');
  try {
    const res = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ messages: history }) });
    if (res.status === 401) { location.href = '/'; return; }
    const j = await res.json();
    w.remove();
    for (const t of (j.toolEvents || [])) add('tool', '\\u2699 ' + t.tool + ' \\u2192 ' + JSON.stringify(t.result).slice(0, 200));
    addBot(j.reply || '(no reply)', j.toolEvents);
    history.push({role:'assistant', content: j.reply || ''});
  } catch (err) { w.textContent = 'error: ' + err; }
  finally { b.disabled = false; i.focus(); }
});
</script></body></html>`;
}
