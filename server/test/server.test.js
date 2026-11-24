import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SearchCache } from '../src/cache.js';
import { searchAllStores } from '../src/search.js';
import { StoreClient } from '../src/stores.js';
import { normalizeRamiLevy } from '../src/normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures/fake-store.js');
const INDEX = path.join(here, '../src/index.js');
const cleanup = [];
after(() => Promise.allSettled(cleanup.map((f) => f())));

const fakeStore = (mode, extra = {}) => {
  const store = new StoreClient({
    id: mode === 'fail' ? 'rami-levy' : mode,
    label: mode,
    toolPrefix: mode === 'rami-levy' ? 'rami_levy_' : 'shufersal_',
    search: { tool: mode === 'rami-levy' ? 'rami_levy_search_products' : 'search_products', maxLimit: 20, normalize: normalizeRamiLevy },
    command: process.execPath,
    args: [FAKE],
    env: { ...process.env, FAKE_MODE: mode },
    connectTimeoutMs: 10_000,
    ...extra,
  });
  cleanup.push(() => store.close());
  return store;
};

test('a store that exits at startup reports its last stderr line', async () => {
  const store = fakeStore('fail');
  await assert.rejects(store.connect(), /fail failed to start: fake-store: missing required env var FAKE_TOKEN/);
});

test('a store restarts on the next call after its process exits', async () => {
  const store = fakeStore('rami-levy');
  const first = JSON.parse((await store.callTool('rami_levy_view_cart', {})).content[0].text);
  await store.callTool('crash', {});
  await new Promise((r) => setTimeout(r, 300));
  const second = JSON.parse((await store.callTool('rami_levy_view_cart', {})).content[0].text);
  assert.notEqual(first.pid, second.pid);
});

test('searchAllStores keeps one store\'s results when the other fails or hangs', async () => {
  const ok = {
    id: 'rami-levy', label: 'Rami Levy',
    search: { tool: 't', maxLimit: 50, normalize: normalizeRamiLevy },
    callTool: async (_t, args) => {
      assert.deepEqual(args, { query: 'חלב', limit: 20 }, 'stores are asked for a fixed batch, so cached results serve any limit');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [{ productId: '1', name: 'חלב 1 ליטר', price: 7 }] }) }] };
    },
  };
  const broken = { id: 'shufersal', label: 'Shufersal', search: { tool: 't', maxLimit: 20 }, callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'login required' }] }) };
  const hung = { id: 'slow', label: 'Slow', search: { tool: 't', maxLimit: 20 }, callTool: () => new Promise(() => {}) };

  const out = await searchAllStores([ok, broken, hung], { query: ' חלב ', limit: 5 }, { timeoutMs: 200, cache: new SearchCache() });
  assert.equal(out.query, 'חלב');
  assert.deepEqual([out.stores['rami-levy'].ok, out.stores['rami-levy'].count, out.stores['rami-levy'].cached], [true, 1, undefined]);
  assert.match(out.stores['rami-levy'].fetchedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(out.stores.shufersal, { ok: false, error: 'login required' });
  assert.match(out.stores.slow.error, /did not answer/);
  assert.equal(out.results.length, 1);
  await assert.rejects(searchAllStores([ok], { query: '  ' }, { cache: new SearchCache() }), /query is required/);
  await assert.rejects(searchAllStores([ok], { query: 'x', stores: ['nope'] }, { cache: new SearchCache() }), /No configured store/);
});

async function startGrocery(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [INDEX], env: { ...process.env, GROCERY_RAMI_LEVY_SEARCH: 'adapter', ...env }, stderr: 'pipe' });
  transport.stderr?.resume();
  const client = new Client({ name: 'test', version: '0' });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return client;
}

const fixture = (name) => path.join(here, 'fixtures', name);

test('the grocery server forwards store tools and merges search', async () => {
  const client = await startGrocery({
    GROCERY_SHUFERSAL_ENTRY: fixture('fake-shufersal.js'),
    GROCERY_RAMI_LEVY_ENTRY: fixture('fake-rami-levy.js'),
  });

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['search_all_stores', 'shufersal_search_products', 'shufersal_view_cart', 'rami_levy_view_cart', 'rami_levy_search_products']) {
    assert.ok(names.includes(n), `${n} missing from ${names.join(', ')}`);
  }
  const instructions = client.getInstructions();
  assert.match(instructions, /fake shufersal instructions/);
  assert.match(instructions, /fake rami-levy instructions/);

  const cart = await client.callTool({ name: 'rami_levy_view_cart', arguments: {} });
  assert.equal(JSON.parse(cart.content[0].text).tool, 'rami_levy_view_cart');

  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.deepEqual(Object.fromEntries(Object.entries(search.stores).map(([k, v]) => [k, [v.ok, v.count]])), { shufersal: [true, 1], 'rami-levy': [true, 1] });
  assert.deepEqual(search.results.map((r) => [r.store, r.pricePerUnit]), [['rami-levy', 7.1], ['shufersal', 7.35]]);

  const unknown = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(unknown.isError, true);
});

test('the grocery server still serves when one store cannot start', async () => {
  const client = await startGrocery({
    GROCERY_SHUFERSAL_ENTRY: fixture('fake-shufersal.js'),
    GROCERY_RAMI_LEVY_ENTRY: fixture('fake-fail.js'),
  });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('shufersal_view_cart'));
  assert.ok(!names.some((n) => n.startsWith('rami_levy_')));

  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.deepEqual([search.stores.shufersal.ok, search.stores.shufersal.count], [true, 1]);
  assert.equal(search.stores['rami-levy'].ok, false);
  assert.match(search.stores['rami-levy'].error, /missing required env var FAKE_TOKEN/);
});

test('the grocery server exits when its client closes stdin', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, GROCERY_RAMI_LEVY_SEARCH: 'adapter', GROCERY_SHUFERSAL_ENTRY: fixture('fake-shufersal.js'), GROCERY_RAMI_LEVY_ENTRY: fixture('fake-rami-levy.js') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanup.push(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not become ready')), 10_000);
    child.stderr.on('data', () => /\[grocery\] ready/.test(stderr) && (clearTimeout(t), resolve()));
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 8_000))]);
  assert.equal(code, 0);
});
