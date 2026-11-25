import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, test } from 'node:test';
import { createGroceryServer } from '../src/app.js';
import { startHttpServer } from '../src/http.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

async function start() {
  const logs = [];
  const server = await startHttpServer({ host: '127.0.0.1', port: 0, makeServer: () => createGroceryServer([]), log: (m) => logs.push(m) });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, logs };
}

const rpc = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});

test('startHttpServer answers MCP requests in process', async () => {
  const { base, logs } = await start();
  assert.match(logs[0], /^listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const res = await fetch(`${base}/mcp`, rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(res.status, 200);
  const names = (await res.json()).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['server_info', 'account_status', 'search_all_stores', 'compare_basket', 'add_basket_to_cart', 'list_preferences', 'save_preference', 'remove_preference']);

  const init = await fetch(`${base}/mcp`, rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }));
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const reported = (await init.json()).result.serverInfo;
  assert.equal(reported.name, 'grocery-mcp');
  assert.match(reported.version, new RegExp(`^${version.replaceAll('.', '\\.')}\\+[0-9a-f]{7}$`), 'version plus commit as build metadata');

  const info = await fetch(`${base}/mcp`, rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'server_info', arguments: {} } }));
  const body = JSON.parse((await info.json()).result.content[0].text);
  assert.deepEqual([body.version, body.fullVersion, body.readOnly, body.stores], [version, reported.version, false, {}]);
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.ok(body.uptimeSeconds >= 0 && body.startedAt);
});

test('startHttpServer rejects unknown paths, methods, bad JSON and foreign hosts', async () => {
  const { base } = await start();
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.match(health.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof health.version, 'string');
  const missing = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.deepEqual([missing.status, await missing.text()], [404, 'Not Found']);
  const get = await fetch(`${base}/mcp`);
  assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST']);
  const bad = await fetch(`${base}/mcp`, { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
  assert.equal(status, 403);
});

test('startHttpServer reports a port that is already in use', async () => {
  const { base } = await start();
  const port = Number(new URL(base).port);
  await assert.rejects(startHttpServer({ host: '127.0.0.1', port, makeServer: () => createGroceryServer([]) }), /EADDRINUSE/);
});
