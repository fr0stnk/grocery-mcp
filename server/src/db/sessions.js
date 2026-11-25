import { StoreError } from '../normalize.js';

const EXPIRING_DAYS = 7;
const context = (id) => `store_accounts:${id}:session`;
const nowIso = (ms) => new Date(ms).toISOString();

/**
 * Store sessions in the vault: a Shufersal cookie jar or Rami Levy tokens,
 * sealed per store account. No password is ever stored; an expired session
 * means the owner connects the store again.
 */
export function saveSession(db, vault, accountId, session, { expiresAt = null, now = Date.now() } = {}) {
  const sealed = vault.seal(JSON.stringify(session), context(accountId));
  const changes = db
    .prepare(`UPDATE store_accounts SET session_enc = ?, status = 'connected', expires_at = ?, last_verified_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`)
    .run(sealed, expiresAt, nowIso(now), nowIso(now), accountId).changes;
  if (!changes) throw new StoreError(`no store account ${accountId}`, 'NOT_FOUND');
}

/** The session object, or null when the account has none. */
export function loadSession(db, vault, accountId) {
  const row = db.prepare('SELECT session_enc FROM store_accounts WHERE id = ?').get(accountId);
  if (!row?.session_enc) return null;
  return JSON.parse(vault.open(row.session_enc, context(accountId)));
}

/** Forgets the session; the account stays, so access and cart history are kept. */
export function clearSession(db, accountId, { now = Date.now(), error = null } = {}) {
  db.prepare(`UPDATE store_accounts SET session_enc = NULL, status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(error ? 'error' : 'disconnected', error, nowIso(now), accountId);
}

/** Records the outcome of a live check without touching the session. */
export function markChecked(db, accountId, { ok, error = null, now = Date.now() }) {
  db.prepare(`UPDATE store_accounts SET last_verified_at = ?, last_error = ?, status = CASE WHEN ? THEN status ELSE 'error' END, updated_at = ? WHERE id = ?`)
    .run(nowIso(now), ok ? null : error, ok ? 1 : 0, nowIso(now), accountId);
}

/**
 * The status to show: a connected session is 'expiring' within 7 days of its
 * expiry and 'expired' after it; other statuses are shown as stored.
 */
export function effectiveStatus(account, now = Date.now()) {
  if (account.status !== 'connected' || !account.expires_at) return account.status;
  const left = Date.parse(account.expires_at) - now;
  if (left <= 0) return 'expired';
  return left <= EXPIRING_DAYS * 86_400_000 ? 'expiring' : 'connected';
}
