import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseListen } from '../src/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, '../src/index.js');
const fixture = (name) => path.join(here, 'fixtures', name);
const cleanup = [];
after(() => Promise.allSettled(cleanup.map((f) => f())));

/** Starts the server in HTTP mode on a free port; stdin is closed, as in a detached container. */
async function startHttp(extraEnv = {}) {
  const child = spawn(process.execPath, [INDEX], {
    env: {
      ...process.env,
      GROCERY_HTTP: '127.0.0.1:0',
      GROCERY_PREFERENCES_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'grocery-prefs-')), 'preferences.json'),
      GROCERY_HISTORY_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'grocery-history-')), 'history.db'),
      GROCERY_DATABASE_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'grocery-db-')), 'grocery.db'),
      GROCERY_RAMI_LEVY_SEARCH: 'adapter',
      GROCERY_SHUFERSAL_ENTRY: fixture('fake-shufersal.js'),
      GROCERY_RAMI_LEVY_ENTRY: fixture('fake-rami-levy.js'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.push(() => child.kill('SIGKILL'));
  let stderr = '';
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no listen line:\n${stderr}`)), 15_000);
    child.stderr.on('data', (d) => {
      stderr += d;
      const m = /listening on (http:\S+)/.exec(stderr);
      if (m && /\] ready/.test(stderr)) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${stderr}`)));
  });
  return { child, url };
}

async function connect(url) {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanup.push(() => client.close());
  return client;
}

test('parseListen accepts a port or host:port and defaults to loopback', () => {
  assert.deepEqual(parseListen('8791'), { host: '127.0.0.1', port: 8791 });
  assert.deepEqual(parseListen('0.0.0.0:80'), { host: '0.0.0.0', port: 80 });
  assert.throws(() => parseListen('nope'), /GROCERY_HTTP/);
});

test('HTTP mode serves tools, search and annotations, and stays up without stdin', async () => {
  const { child, url } = await startHttp();
  const client = await connect(url);

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.search_all_stores.annotations.readOnlyHint, true);
  assert.equal(byName.rami_levy_view_cart.annotations.readOnlyHint, true, 'override applied to a Rami Levy tool');
  assert.ok(byName.shufersal_view_cart, 'write-capable tools are listed when not read-only');

  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.deepEqual(Object.keys(search.stores).sort(), ['rami-levy', 'shufersal']);

  // A second, independent client on the same long-lived store processes.
  const other = await connect(url);
  const cart1 = JSON.parse((await client.callTool({ name: 'rami_levy_view_cart', arguments: {} })).content[0].text);
  const cart2 = JSON.parse((await other.callTool({ name: 'rami_levy_view_cart', arguments: {} })).content[0].text);
  assert.equal(cart1.pid, cart2.pid);
  assert.equal(child.exitCode, null);
});

test('HTTP mode rejects other paths, methods and Host headers', async () => {
  const { url } = await startHttp();
  const base = new URL(url);
  assert.equal((await fetch(new URL('/health', base))).status, 200);
  assert.equal((await fetch(new URL('/other', base), { method: 'POST' })).status, 404);
  const discovery = await fetch(new URL('/.well-known/oauth-protected-resource', base));
  assert.equal(discovery.status, 404);
  assert.match(discovery.headers.get('content-type'), /^text\/plain/, 'a JSON 404 would read as broken OAuth metadata');
  assert.equal((await fetch(url)).status, 405);
  const bad = await fetch(url, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
  assert.equal(status, 403);
});

test('read-only mode lists only read tools and refuses writes', async () => {
  const { url } = await startHttp({ GROCERY_READ_ONLY: '1' });
  const client = await connect(url);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['account_status', 'compare_basket', 'list_preferences', 'price_history', 'rami_levy_search_products', 'rami_levy_view_cart', 'search_all_stores', 'server_info']);
  const refusedOwn = await client.callTool({ name: 'add_basket_to_cart', arguments: { store: 'shufersal', items: [{ productId: 'P_1' }] } });
  assert.match(refusedOwn.content[0].text, /read-only/);
  assert.match(client.getInstructions(), /read-only/);

  const refused = await client.callTool({ name: 'shufersal_view_cart', arguments: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /read-only/);

  // The cross-store search still uses each store's own search tool internally.
  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.equal(search.stores.shufersal.ok, true);
});

test('instructions and the search tool tell clients to search in Hebrew', async () => {
  const { url } = await startHttp();
  const client = await connect(url);
  assert.match(client.getInstructions(), /catalogs are in Hebrew/);
  assert.match(client.getInstructions(), /Answer in the user's language/);
  const search = (await client.listTools()).tools.find((t) => t.name === 'search_all_stores');
  assert.match(search.description, /use Hebrew requests as written/);
  assert.match(client.getInstructions(), /Hebrew, Russian or English/);
});

test('Rami Levy search uses the catalog and pairs barcodes with Shufersal', async () => {
  const { createServer } = await import('node:http');
  const requests = [];
  const catalog = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ body: JSON.parse(body), ua: req.headers['user-agent'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', data: [
        { id: 329258, barcode: 7290102398065, name: 'חלב 3% טרה 2 ליטר', price: { price: 14.9 }, prop: { by_kilo: 0 }, sale: [{ cmt: 2, scm: 25, label: '2 ב-25', active: 1 }] },
      ] }));
    });
  });
  await new Promise((r) => catalog.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise((r) => catalog.close(r)));

  const { url } = await startHttp({
    GROCERY_RAMI_LEVY_SEARCH: '',
    GROCERY_RAMI_LEVY_CATALOG_URL: `http://127.0.0.1:${catalog.address().port}/api/catalog`,
    RAMI_LEVY_STORE: '1214',
    RAMI_LEVY_USER_AGENT: 'TestBrowser/1',
  });
  const client = await connect(url);
  const out = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.deepEqual(requests.at(-1), { body: { q: 'חלב', store: '1214' }, ua: 'TestBrowser/1' });
  assert.equal(out.stores['rami-levy'].ok, true);
  assert.equal(out.sameProduct.length, 1);
  assert.equal(out.sameProduct[0].cheapestStore, 'shufersal');
  assert.equal(out.sameProduct[0].offers[1].promotions[0].unitPrice, 12.5);

  const basket = JSON.parse((await client.callTool({ name: 'compare_basket', arguments: { items: [{ query: 'חלב', quantity: 2 }] } })).content[0].text);
  assert.equal(basket.items[0].identical, true);
  assert.deepEqual([basket.items[0].offers.shufersal.lineTotal, basket.items[0].offers['rami-levy'].lineTotal, basket.items[0].offers['rami-levy'].promotion], [29.4, 25, '2 ב-25']);
  assert.equal(basket.comparable.cheaperStore, 'rami-levy');
  assert.equal(basket.stores['rami-levy'].cached, true, 'the earlier search for the same query was reused');
  assert.equal(requests.length, 1);
});

test('preferences drive compare_basket and add_basket_to_cart previews over HTTP', async () => {
  const { url } = await startHttp();
  const client = await connect(url);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const saved = await call('save_preference', { name: 'Milk', barcode: '7290102398065', quantity: 2, usual: true });
  assert.equal(saved.created, true);
  assert.equal((await call('list_preferences', {})).preferences[0].name, 'Milk');

  const basket = await call('compare_basket', { usual: true });
  assert.deepEqual([basket.items[0].preference, basket.items[0].quantity, basket.items[0].query, basket.items[0].searchedBy, basket.items[0].barcode], ['Milk', 2, 'Milk', 'barcode', '7290102398065'], 'GROC-012: reported by name, searched by barcode');
  const offer = basket.items[0].offers.shufersal;
  assert.equal(offer.productId, 'P_7290102398065');

  const preview = await call('add_basket_to_cart', { store: 'shufersal', items: [{ productId: offer.productId, quantity: 2 }], dry_run: true });
  assert.deepEqual([preview.store, preview.dryRun, preview.requested], ['shufersal', true, 1]);
  assert.deepEqual(await call('remove_preference', { name: 'milk' }), { removed: 'Milk' });

  const missing = await client.callTool({ name: 'compare_basket', arguments: { items: [{ preference: 'tea' }] } });
  assert.equal(missing.isError, true);
  assert.deepEqual(JSON.parse(missing.content[0].text), { error: { code: 'NOT_FOUND', message: 'item 1: no saved preference named "tea"', retryable: false } });
});

test('account_status runs live checks and search results carry account warnings', async () => {
  const soon = ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 2 * 86400 + 3600 })).toString('base64url'), 's'].join('.');
  const { url } = await startHttp({ RAMI_LEVY_ECOM_TOKEN: soon });
  const client = await connect(url);
  const status = JSON.parse((await client.callTool({ name: 'account_status', arguments: {} })).content[0].text);
  assert.deepEqual([status.stores.shufersal.loggedIn, status.stores['rami-levy'].loggedIn, status.stores['rami-levy'].token.daysLeft], [true, true, 2]);
  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.match(search.accountWarnings[0], /Rami Levy login expires in 2 days/);
});

test('the bridge relays a stdio client to the HTTP server and exits with it', async () => {
  const { url } = await startHttp();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '../src/bridge.js')],
    env: { ...process.env, GROCERY_BRIDGE_URL: url },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'desktop', version: '0' });
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('account_status') && names.includes('shufersal_view_cart'), names.join(', '));
  const search = JSON.parse((await client.callTool({ name: 'search_all_stores', arguments: { query: 'חלב' } })).content[0].text);
  assert.equal(search.stores.shufersal.ok, true);
  const pid = transport.pid;
  await client.close();
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the bridge exits when its client closes');
});

test('the bridge answers with an error when the server is unreachable', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '../src/bridge.js')],
    env: { ...process.env, GROCERY_BRIDGE_URL: 'http://127.0.0.1:9/mcp' },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'desktop', version: '0' });
  cleanup.push(() => client.close());
  await assert.rejects(client.connect(transport), /unreachable/);
});
