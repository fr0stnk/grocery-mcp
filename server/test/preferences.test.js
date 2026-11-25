import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveItems } from '../src/basket.js';
import { StoreError } from '../src/normalize.js';
import { PreferenceStore, preferencesFile, runPreferenceTool } from '../src/preferences.js';

const tempStore = () => new PreferenceStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-')), 'nested', 'preferences.json'));

test('preferences are saved, updated by any-case name, listed and removed', () => {
  const store = tempStore();
  assert.deepEqual(store.list(), []);
  const first = store.save({ name: 'Молоко', barcode: 'P_7290102398065', query: 'חלב 3%', usual: true });
  assert.equal(first.created, true);
  assert.deepEqual([first.saved.barcode, first.saved.quantity, first.saved.usual], ['7290102398065', 1, true]);

  const updated = store.save({ name: 'молоко', quantity: 2, note: 'only 1 L' });
  assert.equal(updated.created, false);
  assert.deepEqual([updated.saved.name, updated.saved.quantity, updated.saved.barcode, updated.saved.usual, updated.saved.note], ['Молоко', 2, '7290102398065', true, 'only 1 L']);
  assert.equal(store.save({ name: 'МОЛОКО', barcode: null }).saved.barcode, undefined);

  store.save({ name: 'eggs', query: 'ביצים L 12' });
  assert.deepEqual(store.list().map((p) => p.name), ['eggs', 'Молоко']);
  assert.equal(store.get('EGGS').query, 'ביצים L 12');
  assert.deepEqual(store.remove('Eggs'), { removed: 'eggs' });
  assert.equal(store.get('eggs'), null);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('preferences reject invalid input', () => {
  const store = tempStore();
  const cases = [
    [{}, /name is required/],
    [{ name: 'x' }, /query, a barcode, or both/],
    [{ name: 'x', barcode: '162' }, /not a retail barcode/],
    [{ name: 'x', query: 'חלב', quantity: 0 }, /quantity/],
    [{ name: 'x'.repeat(61), query: 'q' }, /longer than 60/],
  ];
  for (const [input, message] of cases) assert.throws(() => store.save(input), (e) => e instanceof StoreError && message.test(e.message));
  assert.throws(() => store.remove('missing'), /no preference named/);
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.list(), /unreadable/);
});

test('runPreferenceTool and the default file location', () => {
  const store = tempStore();
  runPreferenceTool(store, 'save_preference', { name: 'bread', query: 'לחם' });
  assert.equal(runPreferenceTool(store, 'list_preferences').preferences.length, 1);
  assert.deepEqual(runPreferenceTool(store, 'remove_preference', { name: 'bread' }), { removed: 'bread' });
  assert.throws(() => runPreferenceTool(store, 'nope'), /unknown preference tool/);
  assert.equal(preferencesFile({ GROCERY_DATA_DIR: '/data/grocery' }), '/data/grocery/preferences.json');
  assert.equal(preferencesFile({ GROCERY_PREFERENCES_FILE: '/x/p.json', GROCERY_DATA_DIR: '/y' }), '/x/p.json');
  assert.match(preferencesFile({}), /\.data\/preferences\.json$/);
});

test('resolveItems uses preferences, barcodes and the usual basket', () => {
  const store = tempStore();
  store.save({ name: 'milk', barcode: '7290102398065', quantity: 2, usual: true });
  store.save({ name: 'bread', query: 'לחם אחיד', usual: true });
  store.save({ name: 'chocolate', query: 'שוקולד' });

  assert.deepEqual(resolveItems({ items: [{ preference: 'MILK' }] }, store), [{ query: '7290102398065', quantity: 2, barcode: '7290102398065', label: 'milk', preference: 'milk' }]);
  assert.deepEqual(resolveItems({ items: [{ preference: 'milk', quantity: 5 }] }, store)[0].quantity, 5);
  store.save({ name: 'butter', barcode: '7290000000017', query: 'חמאה 200 גרם' });
  assert.equal(resolveItems({ items: [{ preference: 'butter' }] }, store)[0].label, 'חמאה 200 גרם', 'a saved query is the label');
  assert.deepEqual(resolveItems({ items: [{ barcode: '7290000000001' }] }, store)[0].query, '7290000000001');
  const usual = resolveItems({ usual: true, items: [{ preference: 'milk', quantity: 1 }, { query: 'ביצים' }] }, store);
  assert.deepEqual(usual.map((it) => [it.preference ?? it.query, it.quantity]), [['milk', 1], ['ביצים', 1], ['bread', 1]]);

  assert.throws(() => resolveItems({ items: [{ preference: 'tea' }] }, store), /no saved preference named "tea"/);
  assert.throws(() => resolveItems({ items: [] }, store), /non-empty list, or set usual/);
  assert.throws(() => resolveItems({ items: [{ quantity: 1 }] }, store), /needs a query, a barcode or a preference/);
  assert.throws(() => resolveItems({ usual: true }, tempStore()), /no saved preference is marked usual/);
});
