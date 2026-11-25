import { StoreError } from './normalize.js';

const HOSTS = new Set(['www.rami-levy.co.il', 'www-api.rami-levy.co.il']);

/**
 * Splits a shell command the way DevTools writes it: '…', "…" with backslash
 * escapes, $'…' (Chrome's bash form for values with special characters) and
 * backslash line continuations.
 */
export function shellWords(text) {
  const words = [];
  let word = null;
  const s = text.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new StoreError('the copied command has an unclosed quote', 'INVALID_ARGUMENT');
      word = (word ?? '') + s.slice(i + 1, end);
      i = end;
    } else if (c === '$' && s[i + 1] === "'") {
      let out = '';
      let j = i + 2;
      for (; j < s.length && s[j] !== "'"; j++) {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[++j];
          out += { n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\', '"': '"' }[n] ?? n;
        } else out += s[j];
      }
      if (j >= s.length) throw new StoreError('the copied command has an unclosed quote', 'INVALID_ARGUMENT');
      word = (word ?? '') + out;
      i = j;
    } else if (c === '"') {
      let out = '';
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) out += s[j] === '\\' && j + 1 < s.length ? s[++j] : s[j];
      if (j >= s.length) throw new StoreError('the copied command has an unclosed quote', 'INVALID_ARGUMENT');
      word = (word ?? '') + out;
      i = j;
    } else if (c === '\\' && i + 1 < s.length) {
      word = (word ?? '') + s[++i];
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The `exp` of a JWT in milliseconds, or null when the token is not a JWT. */
export function jwtExpiry(token) {
  const body = String(token).split('.')[1];
  if (!body) return null;
  try {
    const exp = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * A Rami Levy session from DevTools' "Copy as cURL" of a logged-in request,
 * the same rules as scripts/set_rami_levy_tokens.py. Returns the session
 * (bearer, ecomtoken, user agent, cookie) and when it expires: the earliest
 * JWT expiry among the tokens. Expired tokens are refused. Token values never
 * appear in error messages.
 */
export function ramiSessionFromCurl(raw, { now = Date.now() } = {}) {
  const text = String(raw ?? '').trim();
  if (!text.startsWith('curl')) throw new StoreError('this is not a cURL command; in DevTools use Copy > Copy as cURL', 'INVALID_ARGUMENT');
  const args = shellWords(text);
  const headers = {};
  let url = '';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if ((a === '-H' || a === '--header') && i + 1 < args.length) {
      const h = args[++i];
      const at = h.indexOf(':');
      if (at > 0) headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
    } else if ((a === '-A' || a === '--user-agent') && i + 1 < args.length) {
      headers['user-agent'] = args[++i];
    } else if ((a === '-b' || a === '--cookie') && i + 1 < args.length) {
      headers.cookie = args[++i];
    } else if (!a.startsWith('-') && a.includes('://')) {
      url = a;
    }
  }
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // reported below
  }
  if (!HOSTS.has(host)) throw new StoreError(`this request is for ${host || 'an unknown host'}, not Rami Levy; copy a request such as cart or orders`, 'INVALID_ARGUMENT');
  const bearerToken = (headers.authorization ?? '').replace(/^bearer\s+/i, '').trim();
  const session = { bearerToken, ecomToken: headers.ecomtoken ?? '', userAgent: headers['user-agent'] ?? '' };
  const missing = Object.entries({ 'bearer token': session.bearerToken, ecomtoken: session.ecomToken, 'user agent': session.userAgent }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new StoreError(`missing from the copied request: ${missing.join(', ')}; try another logged-in request`, 'INVALID_ARGUMENT');
  if (headers.cookie) session.cookie = headers.cookie;
  const expiries = [jwtExpiry(session.bearerToken), jwtExpiry(session.ecomToken)].filter((x) => x != null);
  const expiresAt = expiries.length ? Math.min(...expiries) : null;
  if (expiresAt != null && expiresAt <= now) throw new StoreError('a token in this request has already expired; reload the page and copy the request again', 'INVALID_ARGUMENT');
  return { session, expiresAt: expiresAt == null ? null : new Date(expiresAt).toISOString() };
}
