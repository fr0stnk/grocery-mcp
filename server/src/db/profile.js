import crypto from 'node:crypto';
import { StoreError } from '../normalize.js';

const now = () => new Date().toISOString();
const ADDRESS_FIELDS = ['city', 'street', 'house_number', 'apartment', 'floor', 'entrance', 'notes'];
const LIMITS = { first_name: 60, last_name: 60, email: 120, city: 60, street: 80, house_number: 10, apartment: 10, floor: 10, entrance: 10, notes: 200 };

function clean(value, field) {
  const text = String(value ?? '').trim();
  if (text.length > LIMITS[field]) throw new StoreError(`${field.replace('_', ' ')} is longer than ${LIMITS[field]} characters`, 'INVALID_ARGUMENT');
  return text || null;
}

/** Israeli phone numbers as typed (050-123-4567, +972 50 1234567) to +972XXXXXXXXX. */
export function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+972')) digits = digits.slice(4);
  else if (digits.startsWith('972')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^\d{8,9}$/.test(digits)) throw new StoreError('the phone number does not look like an Israeli number', 'INVALID_ARGUMENT');
  return `+972${digits}`;
}

const phoneContext = (userId) => `users:${userId}:phone`;
const addressContext = (id) => `addresses:${id}:line`;

/** The owner's profile. The phone is decrypted only for display on the account page. */
export function getProfile(db, vault, userId) {
  const u = db.prepare('SELECT id, email, phone_enc, first_name, last_name FROM users WHERE id = ?').get(userId);
  if (!u) throw new StoreError('no such person', 'NOT_FOUND');
  return { firstName: u.first_name, lastName: u.last_name, email: u.email, phone: u.phone_enc ? vault.open(u.phone_enc, phoneContext(userId)) : null };
}

export function saveProfile(db, vault, userId, input = {}) {
  const firstName = clean(input.firstName, 'first_name');
  const lastName = clean(input.lastName, 'last_name');
  const email = clean(input.email, 'email');
  const phone = normalizePhone(input.phone);
  const missing = Object.entries({ 'first name': firstName, 'last name': lastName, email, phone }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new StoreError(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`, 'INVALID_ARGUMENT');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError('the email address does not look right', 'INVALID_ARGUMENT');
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, email = ?, phone_enc = ? WHERE id = ?').run(firstName, lastName, email, vault.seal(phone, phoneContext(userId)), userId);
  return getProfile(db, vault, userId);
}

/**
 * The person's default delivery address. City and street stay readable for
 * delivery-zone lookups; the full line, which identifies the home, is
 * encrypted. Changing the address replaces the default.
 */
export function getAddress(db, vault, userId) {
  const a = db.prepare('SELECT * FROM addresses WHERE user_id = ? AND is_default = 1').get(userId);
  if (!a) return null;
  const line = a.address_enc ? JSON.parse(vault.open(a.address_enc, addressContext(a.id))) : {};
  return { id: a.id, city: a.city, street: a.street, houseNumber: line.houseNumber ?? null, apartment: line.apartment ?? null, floor: line.floor ?? null, entrance: line.entrance ?? null, notes: line.notes ?? null };
}

export function saveAddress(db, vault, userId, input = {}) {
  const fields = Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, clean(input[f.replace(/_(\w)/g, (_, c) => c.toUpperCase())], f)]));
  if (!fields.city || !fields.street || !fields.house_number || !fields.apartment) throw new StoreError('city, street, house number and apartment are required', 'INVALID_ARGUMENT');
  const existing = db.prepare('SELECT id FROM addresses WHERE user_id = ? AND is_default = 1').get(userId);
  const id = existing?.id ?? crypto.randomUUID();
  const line = JSON.stringify({ houseNumber: fields.house_number, apartment: fields.apartment, floor: fields.floor, entrance: fields.entrance, notes: fields.notes });
  const sealed = vault.seal(line, addressContext(id));
  if (existing) {
    db.prepare('UPDATE addresses SET city = ?, street = ?, address_enc = ?, updated_at = ? WHERE id = ?').run(fields.city, fields.street, sealed, now(), id);
  } else {
    db.prepare('INSERT INTO addresses (id, user_id, city, street, address_enc, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, userId, fields.city, fields.street, sealed, now(), now());
  }
  return getAddress(db, vault, userId);
}
