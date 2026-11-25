const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STORE_NAMES = { shufersal: 'Shufersal', 'rami-levy': 'Rami Levy' };
const STATUS = {
  environment: ['From the server settings', 'neutral', 'The login comes from the server\'s .env file. Connect it here to manage it from this page.'],
  connected: ['Connected', 'good', null],
  expiring: ['Expires soon', 'warn', 'Reconnect before it expires.'],
  expired: ['Expired', 'bad', 'Connect again to keep using this store.'],
  error: ['Needs attention', 'bad', null],
  disconnected: ['Not connected', 'neutral', null],
};

const field = (name, label, value, { type = 'text', required = false, autocomplete = 'off', wide = false, dir } = {}) => `
  <label class="field${wide ? ' wide' : ''}"><span>${esc(label)}${required ? '' : ' <em>optional</em>'}</span>
    <input id="${name}" name="${name}" type="${type}" value="${esc(value)}"${required ? ' required' : ''} autocomplete="${autocomplete}" dir="${dir ?? 'auto'}"></label>`;

const form = (action, csrf, body, button) => `
  <form method="post" action="/account/${action}">
    <input type="hidden" name="csrf" value="${esc(csrf(action))}">
    ${body}
    <div class="actions"><button type="submit">${esc(button)}</button></div>
  </form>`;

function storeCard(a, csrf) {
  const [label, tone, hint] = STATUS[a.shown] ?? [a.shown, 'neutral', null];
  const expiry = a.expires_at ? `<span class="meta">Login valid until ${esc(a.expires_at.slice(0, 10))}</span>` : '';
  const checked = a.last_verified_at ? `<span class="meta">Last checked ${esc(a.last_verified_at.slice(0, 16).replace('T', ' '))} UTC</span>` : '';
  const error = a.last_error ? `<p class="error-text">${esc(a.last_error)}</p>` : '';
  const connect =
    a.store === 'rami-levy'
      ? `<details${['expired', 'expiring', 'disconnected', 'environment'].includes(a.shown) ? ' open' : ''}><summary>${a.shown === 'connected' ? 'Replace the login' : 'Connect Rami Levy'}</summary>
          <ol class="steps"><li>Log in at rami-levy.co.il in your browser.</li><li>Open DevTools → Network → Fetch/XHR and reload.</li><li>Right-click a request such as <code>cart</code> → Copy → Copy as cURL.</li><li>Paste it below. Only the login tokens are kept, encrypted.</li></ol>
          ${form('connect-rami-levy', csrf, '<label class="field wide"><span>Copied request</span><textarea id="curl" name="curl" rows="5" required spellcheck="false" autocomplete="off" placeholder="curl \'https://www.rami-levy.co.il/api/v2/cart\' …"></textarea></label>', 'Connect Rami Levy')}
        </details>`
      : `<details${['expired', 'expiring', 'disconnected', 'environment', 'error'].includes(a.shown) ? ' open' : ''}><summary>${a.shown === 'connected' ? 'Log in again' : 'Connect Shufersal'}</summary>
          <p class="hint">The password is used once to log in and is not stored; only the session is kept, encrypted. When it expires, log in here again.</p>
          ${form('connect-shufersal', csrf, `<div class="grid">
            <label class="field"><span>Email or ID number</span><input id="shufersal-username" name="username" type="text" required autocomplete="username" dir="ltr"></label>
            <label class="field"><span>Password</span><input id="shufersal-password" name="password" type="password" required autocomplete="current-password" dir="ltr"></label></div>`, 'Connect Shufersal')}
        </details>`;
  const disconnect = a.role === 'owner' && ['connected', 'expiring', 'expired', 'error'].includes(a.shown)
    ? form('disconnect', csrf, `<input type="hidden" name="account" value="${esc(a.id)}">`, 'Disconnect and delete the login')
    : '';
  return `<article class="store">
    <header><h3>${esc(STORE_NAMES[a.store] ?? a.store)}</h3><span class="pill ${tone}">${esc(label)}</span></header>
    <div class="meta-row">${expiry}${checked}<span class="meta">Your role: ${esc(a.role)}</span></div>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}${error}${connect}${disconnect}
  </article>`;
}

export function renderPage({ profile, address, accounts, csrf, flash, vaultReady }) {
  const a = address ?? {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grocery account</title>
<style>
:root{--bg:#f5f6f2;--surface:#fff;--ink:#1d2420;--muted:#5d6862;--line:#d8ddd7;--accent:#1f7a5a;--good:#1f7a5a;--good-bg:#e2f1e9;--warn:#9a5a12;--warn-bg:#f8ecdc;--bad:#a3322a;--bad-bg:#f8e3e0;--neutral-bg:#eceee9;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121714;--surface:#1a211d;--ink:#e6ece8;--muted:#9aa8a0;--line:#2d3732;--accent:#5cc39a;--good:#5cc39a;--good-bg:#1d3329;--warn:#e3a35c;--warn-bg:#33281b;--bad:#ef8a80;--bad-bg:#3a201d;--neutral-bg:#232b27;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:2rem 16px 4rem;display:grid;gap:1.5rem}
h1{font-size:1.6rem;margin:0}h2{font-size:1.15rem;margin:0 0 .75rem}h3{font-size:1rem;margin:0}
section,.store{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.2rem}
.lede,.meta,.hint{color:var(--muted)}.meta{font-size:.85rem}.lede{margin:.25rem 0 0}
form{display:grid;gap:.75rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.75rem}
.field{display:grid;gap:.25rem}.field.wide{grid-column:1/-1}.field span{font-size:.85rem;color:var(--muted)}.field em{font-style:normal;opacity:.75}
input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:.5rem .6rem;width:100%}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:.8rem}
input:focus,textarea:focus,button:focus,summary:focus{outline:2px solid var(--accent);outline-offset:2px}
.actions{display:flex;justify-content:flex-end}button{font:inherit;font-weight:600;border:0;border-radius:7px;padding:.5rem 1rem;background:var(--accent);color:var(--surface);cursor:pointer}
.store{display:grid;gap:.6rem}.store header{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.meta-row{display:flex;flex-wrap:wrap;gap:.25rem 1rem}
.pill{font-size:.78rem;font-weight:600;padding:.15rem .55rem;border-radius:999px}.good{background:var(--good-bg);color:var(--good)}.warn{background:var(--warn-bg);color:var(--warn)}.bad{background:var(--bad-bg);color:var(--bad)}.neutral{background:var(--neutral-bg);color:var(--muted)}
.flash{padding:.7rem 1rem;border-radius:8px;font-weight:500}.flash.ok{background:var(--good-bg);color:var(--good)}.flash.err{background:var(--bad-bg);color:var(--bad)}
.error-text{color:var(--bad);margin:0}.steps{margin:.5rem 0;padding-left:1.2rem;color:var(--muted);font-size:.9rem}summary{cursor:pointer;font-weight:600}
code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;background:var(--neutral-bg);padding:.05em .3em;border-radius:4px}
.stores{display:grid;gap:.75rem}
</style></head><body><main>
<header><h1>Grocery account</h1><p class="lede">Your details, delivery address and store logins for Grocery MCP. Phone, address and logins are stored encrypted on this server.</p></header>
${flash ? `<p class="flash ${flash.ok ? 'ok' : 'err'}" role="status">${esc(flash.message)}</p>` : ''}
${vaultReady ? '' : '<p class="flash err">The server has no master key (GROCERY_MASTER_KEY), so the phone, address and logins cannot be saved yet.</p>'}
<section><h2>Store logins</h2><div class="stores">${accounts.map((acc) => storeCard(acc, csrf)).join('') || '<p class="meta">No stores are configured on this server.</p>'}</div></section>
<section><h2>Profile</h2>${form('profile', csrf, `<div class="grid">
  ${field('firstName', 'First name', profile.firstName, { required: true, autocomplete: 'given-name' })}
  ${field('lastName', 'Last name', profile.lastName, { required: true, autocomplete: 'family-name' })}
  ${field('email', 'Email', profile.email, { type: 'email', required: true, autocomplete: 'email' })}
  ${field('phone', 'Phone', profile.phone, { type: 'tel', required: true, autocomplete: 'tel', dir: 'ltr' })}</div>`, 'Save profile')}</section>
<section><h2>Delivery address</h2><p class="meta">Used to work out delivery fees and minimum orders. Street and city may be in Hebrew.</p>${form('address', csrf, `<div class="grid">
  ${field('city', 'City', a.city, { required: true, autocomplete: 'address-level2' })}
  ${field('street', 'Street', a.street, { required: true, autocomplete: 'address-line1' })}
  ${field('houseNumber', 'House number', a.houseNumber, { required: true })}
  ${field('apartment', 'Apartment', a.apartment, { required: true })}
  ${field('floor', 'Floor', a.floor)}
  ${field('entrance', 'Entrance', a.entrance)}
  ${field('notes', 'Notes for the courier', a.notes, { wide: true })}</div>`, 'Save address')}</section>
</main></body></html>`;
}
