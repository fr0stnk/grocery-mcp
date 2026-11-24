import { withTimeout } from './stores.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Errors that mean a store login is missing or expired, as worded by the adapters and the stores.
const AUTH_ERROR = /auth_expired|not signed in|sign(ed)? ?in|log ?in|unauthori[sz]ed|\b401\b|\b403\b/i;

const RENEW = {
  shufersal:
    'The server signs in again with the saved Shufersal password by itself. If it keeps failing, Shufersal may be asking for a captcha or SMS code: sign in once through the adapter\'s browser login or import a session, as described in the README.',
  'rami-levy':
    'Capture new Rami Levy tokens from a logged-in browser (DevTools, Copy as cURL) and save them with scripts/set_rami_levy_tokens.py, as described in the README. Search keeps working meanwhile; carts and orders need the login.',
};

export const ACCOUNT_TOOL = {
  name: 'account_status',
  title: 'Check the store logins',
  description:
    'Check whether the Shufersal and Rami Levy logins work, when the Rami Levy login token expires, and how to renew a login. ' +
    'Use it when the user asks whether the stores are connected, or when a result carries accountWarnings.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** The `exp` of a JWT as a Date, or null when the token is missing or not a JWT with an expiry. */
export function tokenExpiry(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(claims.exp) ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

function text(result) {
  return (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function parse(result) {
  try {
    return JSON.parse(text(result));
  } catch {
    return null;
  }
}

/**
 * Tracks the health of each store login: the Rami Levy token's known expiry
 * and the last login failure or success seen in any call.
 */
export class AccountMonitor {
  constructor({ env = process.env, now = () => Date.now(), warnDays = 7 } = {}) {
    Object.assign(this, { now, warnDays });
    this.ramiTokenExpiry = tokenExpiry(env.RAMI_LEVY_ECOM_TOKEN);
    this.failures = new Map();
  }

  /** Records a call outcome; only login-type errors count as failures. */
  observe(storeId, ok, message = '') {
    if (ok) this.failures.delete(storeId);
    else if (AUTH_ERROR.test(message)) this.failures.set(storeId, { message: String(message).slice(0, 200), at: new Date(this.now()).toISOString() });
  }

  ramiExpiry() {
    if (!this.ramiTokenExpiry) return null;
    const daysLeft = Math.floor((this.ramiTokenExpiry.getTime() - this.now()) / DAY_MS);
    return { expiresAt: this.ramiTokenExpiry.toISOString(), daysLeft };
  }

  /** Short notes for the user, empty when everything looks fine. */
  warnings() {
    const notes = [];
    const rami = this.ramiExpiry();
    if (rami && rami.daysLeft < 0) notes.push(`Rami Levy login expired on ${rami.expiresAt.slice(0, 10)}: Rami Levy carts and orders fail until it is renewed; search still works.`);
    else if (rami && rami.daysLeft <= this.warnDays) notes.push(`Rami Levy login expires in ${rami.daysLeft} day${rami.daysLeft === 1 ? '' : 's'} (${rami.expiresAt.slice(0, 10)}); renew it soon.`);
    for (const [store, failure] of this.failures) notes.push(`${store === 'shufersal' ? 'Shufersal' : 'Rami Levy'} login failed at ${failure.at}: ${failure.message}`);
    return notes;
  }

  /** Live check through each store's read-only status tool. */
  async status(stores, { timeoutMs = 25_000 } = {}) {
    const checks = { shufersal: 'status', 'rami-levy': 'rami_levy_check_status' };
    const result = {};
    await Promise.all(
      stores.map(async (store) => {
        const tool = checks[store.id];
        if (!tool) return;
        const entry = {};
        try {
          const response = await withTimeout(store.callTool(tool, {}), timeoutMs, `${store.label} status check timed out`);
          const body = parse(response);
          const ok = !response.isError && (store.id === 'shufersal' ? body?.signedIn === true : body?.ok === true);
          Object.assign(entry, { loggedIn: ok, detail: body ?? text(response).slice(0, 300) });
          this.observe(store.id, ok, ok ? '' : `not signed in: ${text(response).slice(0, 150)}`);
        } catch (error) {
          Object.assign(entry, { loggedIn: false, detail: error.message });
          this.observe(store.id, false, `log in check failed: ${error.message}`);
        }
        if (store.id === 'rami-levy') entry.token = this.ramiExpiry() ?? { expiresAt: null, note: 'the token carries no readable expiry' };
        if (!entry.loggedIn) entry.howToRenew = RENEW[store.id];
        result[store.id] = entry;
      }),
    );
    return { stores: result, warnings: this.warnings(), checkedAt: new Date(this.now()).toISOString() };
  }
}
