import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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
  assert.deepEqual(names, ['rami_levy_search_products', 'rami_levy_view_cart', 'search_all_stores']);
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
