import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { getAddress, getProfile, saveAddress, saveProfile } from '../db/profile.js';
import { storeAccountsFor } from '../db/people.js';
import { clearSession, effectiveStatus, saveSession } from '../db/sessions.js';
import { ramiSessionFromCurl } from '../rami-curl.js';
import { renderPage } from './pages.js';

const MAX_BODY = 64 * 1024;

/**
 * The account page has no sign-in until OAuth arrives (plan phase 3), so the
 * address it listens on is its only protection: loopback, or the tailnet
 * (100.64.0.0/10, fd7a:115c:a1e0::/48), never 0.0.0.0 or a public address.
 */
export function allowedListenHost(host) {
  if (host === 'localhost') return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(host)) return host === '::1' || /^fd7a:115c:a1e0:/i.test(host);
  return false;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('the form is too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

/**
 * Handlers for the account page, separate from the listener so tests can call
 * them. `ctx` holds the database, the vault, the owner and a hook to restart a
 * store's adapter after its session changes.
 */
export function accountHandler({ db, vault, ownerId, hostAllow, onSessionChange = () => {}, log = () => {}, now = () => Date.now() }) {
  const secret = crypto.randomBytes(32);
  const csrf = (form) => crypto.createHmac('sha256', secret).update(`csrf:${form}`).digest('base64url');
  const validCsrf = (form, token) => {
    const expected = Buffer.from(csrf(form));
    const given = Buffer.from(String(token ?? ''));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const view = (flash = null) => {
    const accounts = storeAccountsFor(db, ownerId).map((a) => ({ ...a, shown: effectiveStatus(a, now()) }));
    return renderPage({ profile: getProfile(db, vault, ownerId), address: getAddress(db, vault, ownerId), accounts, csrf, flash, vaultReady: vault.available });
  };

  const actions = {
    profile: (form) => {
      saveProfile(db, vault, ownerId, form);
      return 'Profile saved.';
    },
    address: (form) => {
      saveAddress(db, vault, ownerId, form);
      return 'Address saved.';
    },
    'connect-rami-levy': (form) => {
      const account = storeAccountsFor(db, ownerId).find((a) => a.store === 'rami-levy' && a.role === 'owner');
      if (!account) throw Object.assign(new Error('Rami Levy is not configured on this server'), { status: 400 });
      const { session, expiresAt } = ramiSessionFromCurl(form.curl, { now: now() });
      saveSession(db, vault, account.id, session, { expiresAt, now: now() });
      onSessionChange('rami-levy');
      return `Rami Levy connected${expiresAt ? `; the login lasts until ${expiresAt.slice(0, 10)}` : ''}.`;
    },
    disconnect: (form) => {
      const account = storeAccountsFor(db, ownerId).find((a) => a.id === form.account && a.role === 'owner');
      if (!account) throw Object.assign(new Error('no such store account'), { status: 404 });
      clearSession(db, account.id, { now: now() });
      onSessionChange(account.store);
      return `${account.store === 'rami-levy' ? 'Rami Levy' : 'Shufersal'} disconnected. Its saved login was deleted.`;
    },
  };

  return async function handle(req, res) {
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(body);
    };
    // A DNS-rebinding page could reach the listener under another name.
    const host = String(req.headers.host ?? '');
    if (!hostAllow(host)) return send(421, 'Unknown host', 'text/plain; charset=utf-8');
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/account') return send(200, view());
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(303, { location: '/account' });
        return res.end();
      }
      const action = url.pathname.startsWith('/account/') ? url.pathname.slice('/account/'.length) : null;
      if (req.method !== 'POST' || !actions[action]) return send(404, 'Not found', 'text/plain; charset=utf-8');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return send(403, 'Cross-site form refused', 'text/plain; charset=utf-8');
      const form = await readForm(req);
      if (!validCsrf(action, form.csrf)) return send(403, 'The form expired; reload the page and try again.', 'text/plain; charset=utf-8');
      try {
        const message = actions[action](form);
        log(`account page: ${action} ok`);
        return send(200, view({ ok: true, message }));
      } catch (error) {
        if (error.status) throw error;
        log(`account page: ${action} refused: ${error.code ?? 'error'}`);
        return send(400, view({ ok: false, message: error.message }));
      }
    } catch (error) {
      return send(error.status ?? 500, error.status ? error.message : 'Something went wrong; see the server log.', 'text/plain; charset=utf-8');
    }
  };
}

/** Starts the account page on `host:port`, refusing any address outside loopback and the tailnet. */
export async function startAccountServer({ host, port, extraHosts = [], ...ctx }) {
  if (!allowedListenHost(host)) throw new Error(`the account page may only listen on loopback or the tailnet, not ${host}`);
  // The listener's own address, the loopback names an SSH tunnel arrives with,
  // and names the owner adds (GROCERY_ACCOUNT_HOSTS, e.g. a MagicDNS name).
  const names = new Set([host, `[${host}]`, 'localhost', '127.0.0.1', ...extraHosts.map((h) => h.trim().toLowerCase()).filter(Boolean)]);
  const hostAllow = (h) => {
    const m = /^(.+):(\d+)$/.exec(h.toLowerCase());
    // A tunnel's local port may differ; rebinding protection comes from the name.
    return Boolean(m) && names.has(m[1]);
  };
  const server = http.createServer(accountHandler({ ...ctx, hostAllow }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  ctx.log?.(`account page on http://${net.isIPv6(host) ? `[${host}]` : host}:${port}/account`);
  return server;
}
