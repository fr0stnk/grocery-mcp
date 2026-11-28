import crypto from 'node:crypto';
import { StoreError } from '../normalize.js';
import { transaction } from './database.js';

export const ROLES = ['owner', 'shopper', 'viewer'];
const nowIso = (ms) => new Date(ms).toISOString();
const lower = (s) => (typeof s === 'string' && s.trim() ? s.trim().toLowerCase() : null);

/**
 * Who may sign in, from GROCERY_OAUTH_USERS: "email:role,email:role", where
 * role is shopper or viewer (default shopper). The owner is always allowed.
 */
export function parseMembers(value = '') {
  const members = new Map();
  for (const entry of String(value).split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf(':');
    const [email, role] = at > entry.indexOf('@') ? [entry.slice(0, at), entry.slice(at + 1).trim()] : [entry, 'shopper'];
    if (!['shopper', 'viewer'].includes(role)) throw new Error(`GROCERY_OAUTH_USERS: role for ${email} must be shopper or viewer, got ${JSON.stringify(role)}`);
    if (!lower(email)?.includes('@')) throw new Error(`GROCERY_OAUTH_USERS: ${JSON.stringify(email)} is not an email address`);
    members.set(lower(email), role);
  }
  return members;
}

const forbidden = (message) => new StoreError(message, 'FORBIDDEN');

/** Whether this identity has signed in before, so its email need not be looked up again. */
export function knownIdentity(db, issuer, subject) {
  return Boolean(db.prepare('SELECT 1 FROM identities WHERE issuer = ? AND subject = ?').get(issuer, subject));
}

/**
 * The person behind a verified token: { userId, role, email }. A known identity
 * signs in as its person; a new one is linked by email, to the owner when it is
 * the owner's address, otherwise to a new person on the member list, who gets
 * the owner's store accounts in their role. Removing someone from the list, or
 * disabling them, refuses their next request.
 */
export function signIn(db, { issuer, subject, email }, { ownerId, ownerEmail = null, members = new Map(), now = Date.now() }) {
  if (!issuer || !subject) throw forbidden('the token names no subject');
  const owner = db.prepare('SELECT id, email FROM users WHERE id = ?').get(ownerId);
  const ownerAddress = lower(ownerEmail) ?? lower(owner?.email);
  const at = nowIso(now);

  let identity = db.prepare('SELECT user_id FROM identities WHERE issuer = ? AND subject = ?').get(issuer, subject);
  if (!identity) {
    const address = lower(email);
    if (!address) throw forbidden('no verified email came with this sign-in, so it cannot be linked to a person; sign in again allowing the email scope');
    let userId;
    if (address === ownerAddress) userId = ownerId;
    else if (members.has(address)) {
      userId = db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id <> ?').get(address, ownerId)?.id ?? null;
      if (!userId) {
        userId = crypto.randomUUID();
        const role = members.get(address);
        transaction(db, () => {
          db.prepare('INSERT INTO users (id, idp_sub, email, created_at) VALUES (?, ?, ?, ?)').run(userId, `oidc:${issuer}#${subject}`, address, at);
          const accounts = db.prepare('SELECT id FROM store_accounts WHERE owner_user_id = ?').all(ownerId);
          const grant = db.prepare('INSERT OR IGNORE INTO store_access (store_account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
          for (const a of accounts) grant.run(a.id, userId, role, at);
        });
      }
    } else throw forbidden(`${address} is not allowed to use this server; the owner can add it to GROCERY_OAUTH_USERS`);
    db.prepare('INSERT INTO identities (issuer, subject, user_id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(issuer, subject, userId, address, at, at);
    identity = { user_id: userId };
  }

  const user = db.prepare('SELECT id, email, disabled_at FROM users WHERE id = ?').get(identity.user_id);
  if (!user || user.disabled_at) throw forbidden('this account is disabled');
  let role = 'owner';
  if (user.id !== ownerId) {
    role = members.get(lower(user.email));
    if (!role) throw forbidden(`${user.email} is no longer allowed to use this server`);
  }
  db.prepare('UPDATE identities SET last_seen_at = ? WHERE issuer = ? AND subject = ?').run(at, issuer, subject);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, user.id);
  return { userId: user.id, role, email: user.email };
}
