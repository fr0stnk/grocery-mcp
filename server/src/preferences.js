import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barcodeOf, StoreError } from './normalize.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_PREFERENCES = 200;

/** The container sets GROCERY_DATA_DIR=/data/grocery; local runs default to <repo>/.data. */
export function preferencesFile(env = process.env) {
  return env.GROCERY_PREFERENCES_FILE || path.join(env.GROCERY_DATA_DIR || path.join(repoRoot, '.data'), 'preferences.json');
}

const keyOf = (name) => name.trim().toLocaleLowerCase();

function text(value, field, max) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new StoreError(`${field} must be text`, 'INVALID_ARGUMENT');
  if (value.trim().length > max) throw new StoreError(`${field} is longer than ${max} characters`, 'INVALID_ARGUMENT');
  return value.trim();
}

export function preferenceName(input) {
  const name = text(input?.name, 'name', 60);
  if (!name) throw new StoreError('name is required', 'INVALID_ARGUMENT');
  return name;
}

/** Validates a save request against the saved preference, if any. `count` is how many the person has. */
export function buildPreference(input = {}, existing = {}, count = 0) {
  const name = preferenceName(input);
  if (!existing.name && count >= MAX_PREFERENCES) throw new StoreError(`at most ${MAX_PREFERENCES} preferences`, 'INVALID_ARGUMENT');
  let barcode = existing.barcode;
  if (input.barcode !== undefined) {
    barcode = input.barcode === null || input.barcode === '' ? undefined : barcodeOf(input.barcode);
    if (input.barcode && !barcode) throw new StoreError(`${input.barcode} is not a retail barcode`, 'INVALID_ARGUMENT');
  }
  const query = input.query !== undefined ? text(input.query, 'query', 100) : existing.query;
  if (!query && !barcode) throw new StoreError('give a Hebrew search query, a barcode, or both', 'INVALID_ARGUMENT');
  const quantity = input.quantity !== undefined ? Number(input.quantity) : existing.quantity ?? 1;
  if (!(quantity > 0 && quantity <= 100)) throw new StoreError('quantity must be above 0 and at most 100', 'INVALID_ARGUMENT');
  const note = input.note !== undefined ? text(input.note, 'note', 200) : existing.note;
  return {
    name: existing.name ?? name,
    ...(query ? { query } : {}),
    ...(barcode ? { barcode } : {}),
    quantity,
    usual: input.usual !== undefined ? Boolean(input.usual) : Boolean(existing.usual),
    ...(note ? { note } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export { keyOf as preferenceKey };

/**
 * Household product preferences in a JSON file: the store before the
 * database (plan phase 1), still used for imports and by tests.
 * The file is re-read on each call, so the stdio and HTTP servers see each
 * other's changes, and it is replaced atomically on every write.
 */
export class PreferenceStore {
  constructor(file = preferencesFile()) {
    this.file = file;
  }

  #read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data.items === 'object' ? data : { version: 1, items: {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, items: {} };
      throw new StoreError(`preferences file is unreadable: ${error.message}`, 'STORAGE_ERROR', { retryable: true });
    }
  }

  #write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.#read().items).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    const key = typeof name === 'string' ? keyOf(name) : '';
    return key ? this.#read().items[key] ?? null : null;
  }

  /** Creates or updates one preference; omitted fields keep their saved values. */
  save(input = {}) {
    const data = this.#read();
    const name = preferenceName(input);
    const existing = data.items[keyOf(name)] ?? {};
    const preference = buildPreference(input, existing, Object.keys(data.items).length);
    data.items[keyOf(name)] = preference;
    this.#write(data);
    return { saved: preference, created: !existing.name };
  }

  remove(name) {
    const key = typeof name === 'string' ? keyOf(name) : '';
    const data = this.#read();
    const existing = key ? data.items[key] : null;
    if (!existing) throw new StoreError(`no preference named ${JSON.stringify(name)}`, 'NOT_FOUND');
    delete data.items[key];
    this.#write(data);
    return { removed: existing.name };
  }
}

export const PREFERENCE_TOOLS = [
  {
    name: 'list_preferences',
    title: 'List household preferences',
    description:
      'List the household\'s saved product preferences, shared by everyone using this server. Each has a name (any language), ' +
      'a Hebrew query and/or an exact barcode, a default quantity, and whether it belongs to the usual basket. ' +
      'Use them when the user says "the usual milk" or "our usual basket".',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_preference',
    title: 'Save a household preference',
    description:
      'Save or update a product preference for the household, e.g. name "milk" with the barcode of Tnuva 3% 1 L from search results. ' +
      'Prefer a barcode: it finds exactly that product in every store that sells it. Omitted fields keep their saved values. ' +
      'Set usual: true to include it in the usual basket. Confirm with the user before saving.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60, description: 'What the household calls it, e.g. "milk", "молоко", "חלב"' },
        query: { type: 'string', maxLength: 100, description: 'Hebrew search terms, used when there is no barcode or the barcode is not sold' },
        barcode: { type: ['string', 'null'], description: 'Exact product barcode from search results; null clears it' },
        quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Default quantity (units, or kilograms for weighed items)' },
        usual: { type: 'boolean', description: 'Include in the usual basket' },
        note: { type: 'string', maxLength: 200, description: 'Optional note, e.g. "lactose-free only"' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_preference',
    title: 'Remove a household preference',
    description: 'Delete one saved preference by name. Confirm with the user first.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1 } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

export function runPreferenceTool(store, name, args = {}) {
  if (name === 'list_preferences') return { preferences: store.list() };
  if (name === 'save_preference') return store.save(args);
  if (name === 'remove_preference') return store.remove(args.name);
  throw new StoreError(`unknown preference tool ${name}`, 'INVALID_ARGUMENT');
}
