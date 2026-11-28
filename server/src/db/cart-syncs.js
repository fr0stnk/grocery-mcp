import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StoreError } from '../normalize.js';

const now = () => new Date().toISOString();
export const cartJournalUnavailable = () => new StoreError(
  'The Rami Levy cart journal is unavailable. Try again when it is available.', 'CART_SYNC_UNAVAILABLE', { retryable: true });
const inProgress = () => new StoreError('A Rami Levy cart change is still running. Retry the same operation with the same key, if supplied.', 'CART_SYNC_IN_PROGRESS', { retryable: true });
const unknown = () => new StoreError('Rami Levy may have applied this change. Inspect the cart in the store before making a new change. This request will not be sent again with the same key.', 'CART_SYNC_UNKNOWN');

export function cartErrorResult(error) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: {
    code: error.code ?? 'INTERNAL_ERROR', message: error.message, retryable: Boolean(error.retryable),
  } }) }] };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function requestHash(operation, args) {
  return crypto.createHash('sha256').update(JSON.stringify(stable([operation, args]))).digest('hex');
}

function acquire(file, accountId) {
  const digest = crypto.createHash('sha256').update(accountId).digest('hex');
  const dir = `${fs.realpathSync(file)}.cart-locks`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gate = new DatabaseSync(path.join(dir, `${digest}.db`));
  try {
    // Hold an exclusive transaction on this empty gate database. The cart
    // journal lives in a separate database and commits each update immediately.
    gate.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    return gate;
  } catch (error) {
    gate.close();
    if ([5, 6].includes(error.errcode)) throw inProgress();
    throw error;
  }
}

function possiblyApplied(upstream) {
  if (upstream?.ok === true) return false;
  const explicitlyRefused = upstream && ['auth_expired', 'not_found', 'rejected'].includes(upstream.reason) &&
    [400, 401, 403, 404, 422].includes(upstream.status);
  return !explicitlyRefused;
}

export function createCartJournal(db, file) {
  function cached(row, hash) {
    if (!row) return null;
    if (row.request_hash !== hash) throw new StoreError('The idempotency key was already used for a different Rami Levy cart request.', 'IDEMPOTENCY_KEY_CONFLICT');
    if (row.status === 'unknown') return cartErrorResult(unknown());
    if (row.status === 'in_progress') return null;
    const result = storage(() => JSON.parse(row.result).response);
    if (!result) return cartErrorResult(unknown());
    return result;
  }

  function storage(fn) {
    try {
      return fn();
    } catch {
      throw cartJournalUnavailable();
    }
  }
  const find = (accountId, key) => key === null ? null : storage(() =>
    db.prepare('SELECT * FROM cart_syncs WHERE store_account_id = ? AND idempotency_key = ?').get(accountId, key));

  return {
    async run({ accountId, userId, operation, key, args }, execute) {
      if (!accountId) throw cartJournalUnavailable();
      const hash = key === null ? null : requestHash(operation, args);
      const replay = cached(find(accountId, key), hash);
      if (replay) return replay;
      let gate;
      try {
        gate = acquire(file, accountId);
      } catch (error) {
        if (error.code !== 'CART_SYNC_IN_PROGRESS') throw cartJournalUnavailable();
        const completed = cached(find(accountId, key), hash);
        if (completed) return completed;
        throw error;
      }
      try {
        const id = crypto.randomUUID();
        storage(() => db.prepare(`UPDATE cart_syncs SET status = 'unknown', finished_at = ?, error = 'CART_SYNC_UNKNOWN'
          WHERE store_account_id = ? AND status = 'in_progress'`).run(now(), accountId));
        const recovered = cached(find(accountId, key), hash);
        if (recovered) return recovered;
        storage(() => db.prepare(`INSERT INTO cart_syncs (id, store_account_id, user_id, at, operation, idempotency_key, request_hash, result, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'in_progress')`).run(id, accountId, userId ?? null, now(), operation, key, hash));

        let attempted = false;
        let upstream;
        const accepted = [];
        const rejected = [];
        const observeSync = async (items, send) => {
          attempted = true;
          upstream = await send();
          if (upstream?.ok) {
            const ids = new Set(upstream.acceptedIds);
            for (const [productId, quantity] of Object.entries(items)) {
              (ids.has(productId) ? accepted : rejected).push({ productId, quantity: Number(quantity) });
            }
          }
          return upstream;
        };

        let response;
        let status;
        let errorCode;
        let serverTotal;
        try {
          response = await execute(observeSync);
          const body = JSON.parse(response.content[0].text);
          if (attempted && (possiblyApplied(upstream) || body.reason === 'network_error' || body.reason === 'internal_error')) {
            throw unknown();
          }
          const partial = body.reason === 'items_rejected' || (attempted && body.rejected > 0 && body.added > 0);
          status = partial ? 'partial' : upstream?.ok ? 'completed' : 'no_write';
          errorCode = body.error?.code ?? body.reason ?? (partial ? 'items_rejected' : null);
          serverTotal = body.serverTotal ?? upstream?.serverTotal ?? null;
        } catch (error) {
          const uncertain = attempted && (upstream?.ok || possiblyApplied(upstream));
          const safe = uncertain ? unknown() : new StoreError('Rami Levy did not apply this cart request.', error.code ?? 'CART_SYNC_NOT_SENT');
          response = cartErrorResult(safe);
          status = uncertain ? 'unknown' : 'no_write';
          errorCode = safe.code;
          serverTotal = null;
        }
        try {
          const updated = db.prepare(`UPDATE cart_syncs SET result = ?, finished_at = ?, status = ?, server_total = ?, error = ? WHERE id = ?`)
            .run(JSON.stringify({ response, accepted, rejected }), now(), status, serverTotal, errorCode, id);
          if (updated.changes !== 1) throw cartJournalUnavailable();
        } catch {
          // Leave the original row reserved if the database cannot record the outcome.
          throw attempted ? unknown() : cartJournalUnavailable();
        }
        return response;
      } finally {
        gate.close();
      }
    },
  };
}
