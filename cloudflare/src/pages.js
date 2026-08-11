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

export function setupPage(wordlistJson, hasClaimCode) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot setup</title>${STYLE}</head><body><div class="wrap">
<h1>&#9889; sparkbtcbot<small>first-time setup</small></h1>
<p>This wallet is unclaimed. Set it up once; after that this page is gone forever.</p>
<form id="f">
${hasClaimCode ? `<label>Claim code (shown when you deployed)</label><input id="code" autocomplete="off" required>` : ""}
<label>Wallet</label>
<div>
  <button type="button" id="genBtn" class="alt">Generate new wallet</button>
  <button type="button" id="impBtn" class="alt">Import existing 12/24 words</button>
</div>
<div id="genBox" class="hide">
  <div class="warn"><b>Write these words down now, in order, on paper.</b> This is the only time they will ever be shown. They are generated in your browser and never sent anywhere except, encrypted, into this Worker's storage.</div>
  <div class="words" id="words"></div>
  <label id="quizLabel"></label><input id="quiz" autocomplete="off">
</div>
<div id="impBox" class="hide">
  <label>Your existing mnemonic (12 or 24 words)</label>
  <textarea id="mnemonicIn" autocomplete="off"></textarea>
</div>
<label>Choose a password (min 8 chars — this is how you'll log in)</label>
<input id="pw" type="password" minlength="8" required>
<label>Repeat password</label>
<input id="pw2" type="password" required>
<label>OpenRouter API key (optional — enables Claude/GLM etc.; blank = free Workers AI model)</label>
<input id="orKey" autocomplete="off" placeholder="sk-or-...">
<div class="err" id="err"></div>
<button id="go" disabled>Claim wallet</button>
</form>
<script>
const WORDS = ${wordlistJson};
let mnemonic = null, mode = null, quizIdx = [];
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
$('genBtn').onclick = async () => {
  mode = 'gen';
  const ws = await gen();
  mnemonic = ws.join(' ');
  $('words').innerHTML = ws.map((w, i) => '<div><span>' + (i + 1) + '</span>' + w + '</div>').join('');
  quizIdx = [Math.floor(Math.random() * 6), 6 + Math.floor(Math.random() * 6)];
  $('quizLabel').textContent = 'Prove you wrote them down: type words #' + (quizIdx[0] + 1) + ' and #' + (quizIdx[1] + 1) + ' (space-separated)';
  $('genBox').classList.remove('hide'); $('impBox').classList.add('hide');
  $('go').disabled = false;
};
$('impBtn').onclick = () => {
  mode = 'imp';
  $('impBox').classList.remove('hide'); $('genBox').classList.add('hide');
  $('go').disabled = false;
};
$('f').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('err'); err.textContent = '';
  if ($('pw').value !== $('pw2').value) { err.textContent = 'passwords do not match'; return; }
  let m = mnemonic;
  if (mode === 'imp') m = $('mnemonicIn').value.trim().toLowerCase().replace(/\\s+/g, ' ');
  if (!m) { err.textContent = 'generate or import a wallet first'; return; }
  if (mode === 'gen') {
    const ans = $('quiz').value.trim().toLowerCase().split(/\\s+/);
    const ws = m.split(' ');
    if (ans[0] !== ws[quizIdx[0]] || ans[1] !== ws[quizIdx[1]]) { err.textContent = 'quiz words wrong — check your paper backup'; return; }
  }
  $('go').disabled = true;
  const res = await fetch('/api/claim', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claimCode: ${hasClaimCode ? "$('code').value.trim()" : "''"}, mnemonic: m, password: $('pw').value, openrouterKey: $('orKey').value.trim() || undefined }) });
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.ok) { location.href = '/'; }
  else { err.textContent = j.error || ('claim failed (' + res.status + ')'); $('go').disabled = false; }
};
</script></div></body></html>`;
}

export const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot login</title>${STYLE}</head><body><div class="wrap">
<h1>&#9889; sparkbtcbot<small>login</small></h1>
<form id="f">
<label>Password</label>
<input id="pw" type="password" autofocus required>
<div class="err" id="err"></div>
<button>Log in</button>
</form>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }) });
  if (res.ok) location.href = '/';
  else document.getElementById('err').textContent = 'wrong password';
};
</script></div></body></html>`;

export const CHAT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sparkbtcbot</title><style>
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
</style></head><body>
<header><span>&#9889; sparkbtcbot<small>Spark L2 &middot; MAINNET</small></span><a href="#" id="out">log out</a></header>
<div id="log"></div>
<form id="f"><input id="i" placeholder="Ask about your wallet&hellip;" autocomplete="off" autofocus><button id="b">Send</button></form>
<script>
const log = document.getElementById('log'), f = document.getElementById('f'),
      i = document.getElementById('i'), b = document.getElementById('b');
const history = [];
function add(cls, text){ const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
add('bot', 'Hi! I\\'m your Spark wallet bot. Try: "what\\'s my balance?" or "give me a lightning invoice for 500 sats".');
document.getElementById('out').onclick = async (e) => { e.preventDefault(); await fetch('/api/logout', {method:'POST'}); location.href = '/'; };
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
    add('bot', j.reply || '(no reply)');
    history.push({role:'assistant', content: j.reply || ''});
  } catch (err) { w.textContent = 'error: ' + err; }
  finally { b.disabled = false; i.focus(); }
});
</script></body></html>`;
