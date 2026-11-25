import crypto from 'node:crypto';
import { StoreError } from '../normalize.js';

const PREFIX = 'gv1';
const b64 = (buf) => buf.toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

function gcm(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct];
}

function ungcm(key, iv, tag, ct, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Master keys from the environment, never from the database or its volume.
 * GROCERY_MASTER_KEY is the current key, "<version>:<32 bytes base64>" (a bare
 * base64 key is version 1). GROCERY_MASTER_KEYS_OLD lists retired keys the same
 * way, comma-separated, so old envelopes still open after a rotation.
 */
export function masterKeys(env = process.env) {
  const parse = (value) => {
    const [v, k] = value.includes(':') ? value.split(':', 2) : ['1', value];
    const key = Buffer.from(k.trim(), 'base64');
    if (!/^\d+$/.test(v) || key.length !== 32) throw new Error('a master key must be 32 bytes, base64, optionally "<version>:" first');
    return [Number(v), key];
  };
  const current = env.GROCERY_MASTER_KEY ? parse(env.GROCERY_MASTER_KEY) : null;
  const old = (env.GROCERY_MASTER_KEYS_OLD ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(parse);
  return { current, all: new Map([...old, ...(current ? [current] : [])]) };
}

/**
 * Envelope encryption for secrets and personal data. Each value gets its own
 * random data key, encrypted with AES-256-GCM; the data key is wrapped by the
 * master key. `context` (for example "store_accounts:<id>:session") is bound as
 * associated data, so a value copied to another row or field will not open.
 * Envelope: gv1.<key version>.<wrap iv>.<wrap tag>.<wrapped key>.<iv>.<tag>.<ciphertext>
 */
export function createVault(env = process.env) {
  const { current, all } = masterKeys(env);
  return {
    available: Boolean(current),
    keyVersion: current?.[0] ?? null,
    seal(plaintext, context) {
      if (!current) throw new StoreError('GROCERY_MASTER_KEY is not set, so secrets cannot be stored', 'STORAGE_ERROR');
      const [version, master] = current;
      const dataKey = crypto.randomBytes(32);
      const [wiv, wtag, wrapped] = gcm(master, dataKey, `${PREFIX}:${version}:${context}`);
      const [iv, tag, ct] = gcm(dataKey, Buffer.from(String(plaintext), 'utf8'), context);
      return [PREFIX, version, b64(wiv), b64(wtag), b64(wrapped), b64(iv), b64(tag), b64(ct)].join('.');
    },
    open(envelope, context) {
      const parts = String(envelope ?? '').split('.');
      if (parts.length !== 8 || parts[0] !== PREFIX) throw new StoreError('not an encrypted value', 'STORAGE_ERROR');
      const version = Number(parts[1]);
      const master = all.get(version);
      if (!master) throw new StoreError(`master key version ${version} is not configured`, 'STORAGE_ERROR');
      try {
        const dataKey = ungcm(master, unb64(parts[2]), unb64(parts[3]), unb64(parts[4]), `${PREFIX}:${version}:${context}`);
        return ungcm(dataKey, unb64(parts[5]), unb64(parts[6]), unb64(parts[7]), context).toString('utf8');
      } catch {
        throw new StoreError('an encrypted value could not be opened (wrong key or context)', 'STORAGE_ERROR');
      }
    },
  };
}

/** A new master key in the GROCERY_MASTER_KEY format. */
export function newMasterKey(version = 1) {
  return `${version}:${crypto.randomBytes(32).toString('base64')}`;
}
