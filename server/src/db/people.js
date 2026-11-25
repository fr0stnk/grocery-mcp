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
 * The owner's store account for a store, in whatever state it is: connected on
 * the account page, expired, or still using the server's environment. Only
 * when the owner has none is one created, with status 'environment'.
 * Duplicate environment accounts left by v0.10.0-0.10.2, which looked for that
 * status only and so added a second account after a store was connected, are
 * removed when they hold no session.
 */
export function ensureEnvironmentStoreAccount(db, store, ownerId) {
  const owned = db
    .prepare("SELECT * FROM store_accounts WHERE store = ? AND owner_user_id = ? ORDER BY (session_enc IS NOT NULL) DESC, (status = 'environment') ASC, created_at ASC")
    .all(store, ownerId);
  if (owned.length) {
    const [keep, ...rest] = owned;
    const remove = db.prepare("DELETE FROM store_accounts WHERE id = ? AND status = 'environment' AND session_enc IS NULL");
    for (const extra of rest) remove.run(extra.id);
    return keep;
  }
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
