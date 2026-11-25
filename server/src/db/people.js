import crypto from 'node:crypto';
import { transaction } from './database.js';

const now = () => new Date().toISOString();
const AUDIT_KEEP_DAYS = 400;

/**
 * Before OAuth (plan phase 3) there is one person: the owner, who runs this
 * server. Their id is stable, so the rows created now carry over when sign-in
 * arrives and the owner links their real identity.
 */
export const LOCAL_OWNER_SUB = 'local:owner';

export function ensureLocalOwner(db, env = process.env) {
  const found = db.prepare('SELECT * FROM users WHERE idp_sub = ?').get(LOCAL_OWNER_SUB);
  if (found) return found;
  const user = { id: crypto.randomUUID(), idp_sub: LOCAL_OWNER_SUB, email: env.GROCERY_OWNER_EMAIL || null, created_at: now() };
  db.prepare('INSERT INTO users (id, idp_sub, email, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.idp_sub, user.email, user.created_at);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

/**
 * The store account for a store whose login still comes from the server's
 * environment (status 'environment'), owned by `ownerId`. Phase 2 replaces the
 * environment with a session kept in session_enc.
 */
export function ensureEnvironmentStoreAccount(db, store, ownerId) {
  const found = db
    .prepare("SELECT * FROM store_accounts WHERE store = ? AND owner_user_id = ? AND status = 'environment'")
    .get(store, ownerId);
  if (found) return found;
  const id = crypto.randomUUID();
  const at = now();
  transaction(db, () => {
    db.prepare('INSERT INTO store_accounts (id, store, owner_user_id, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, store, ownerId, 'from the server environment', 'environment', at, at);
    db.prepare('INSERT INTO store_access (store_account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, 'owner', at);
  });
  return db.prepare('SELECT * FROM store_accounts WHERE id = ?').get(id);
}

/** Store accounts a person may use, with their role on each. Secrets are never selected here. */
export function storeAccountsFor(db, userId) {
  return db
    .prepare(`SELECT a.id, a.store, a.label, a.status, a.expires_at, a.last_verified_at, a.last_error, x.role
      FROM store_access x JOIN store_accounts a ON a.id = x.store_account_id
      WHERE x.user_id = ? ORDER BY a.store, a.created_at`)
    .all(userId);
}

/** The store account a person uses for a store: the one they own, otherwise the first shared with them. */
export function storeAccountFor(db, userId, store) {
  const rows = storeAccountsFor(db, userId).filter((a) => a.store === store && a.status !== 'disconnected');
  return rows.find((a) => a.role === 'owner') ?? rows[0] ?? null;
}

/**
 * One line per tool call: who, which tool, which store account, the outcome
 * and how long it took. `details` must never hold secrets or full addresses.
 */
export function recordAudit(db, { userId = null, storeAccountId = null, tool, outcome, durationMs = null, details = null }) {
  db.prepare('INSERT INTO audit_log (id, at, user_id, store_account_id, tool, outcome, duration_ms, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now(), userId, storeAccountId, tool, outcome, durationMs, details == null ? null : String(details).slice(0, 500));
}

export function pruneAudit(db, nowMs = Date.now()) {
  return db.prepare('DELETE FROM audit_log WHERE at < ?').run(new Date(nowMs - AUDIT_KEEP_DAYS * 86_400_000).toISOString()).changes;
}
