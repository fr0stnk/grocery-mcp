import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { StoreError } from '../src/normalize.js';
import { fetchRamiCatalog } from '../src/rami-catalog.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))));

/** A stand-in catalog endpoint; `reply(req, body)` returns [status, contentType, text] or never answers when it returns null. */
async function catalog(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      const answer = reply(req, body);
      if (!answer) return;
      const [status, type, text] = answer;
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/api/catalog`, seen };
}

test('fetchRamiCatalog posts the query, branch, User-Agent and cookie', async () => {
  const { url, seen } = await catalog(() => [200, 'application/json', JSON.stringify({ data: [{ id: 1 }] })]);
  const data = await fetchRamiCatalog('חלב', { url, store: 1214, userAgent: 'UA/1', cookie: 'cf_clearance=x' });
  assert.deepEqual(data, { data: [{ id: 1 }] });
  assert.deepEqual(seen[0].body, { q: 'חלב', store: '1214' });
  assert.equal(seen[0].headers['user-agent'], 'UA/1');
  assert.equal(seen[0].headers.cookie, 'cf_clearance=x');
  assert.equal(seen[0].headers.accept, 'application/json');
});

test('fetchRamiCatalog sends a default User-Agent and no cookie when none is set', async () => {
  const { url, seen } = await catalog(() => [200, 'application/json', '{"data":[]}']);
  await fetchRamiCatalog('x', { url });
  assert.match(seen[0].headers['user-agent'], /^Mozilla\/5\.0/);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].body.store, '412');
});

test('fetchRamiCatalog explains challenge pages, HTTP errors, network failures and timeouts', async () => {
  const challenge = await catalog(() => [403, 'text/html', '<html>Just a moment...</html>']);
  await assert.rejects(fetchRamiCatalog('x', { url: challenge.url }), (e) => e instanceof StoreError && /non-JSON page \(HTTP 403\).*Cloudflare/.test(e.message));
  const failing = await catalog(() => [500, 'application/json', '{"error":"boom"}']);
  await assert.rejects(fetchRamiCatalog('x', { url: failing.url }), /HTTP 500/);
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(fetchRamiCatalog('x', { url: `http://127.0.0.1:${closedPort}/api/catalog` }), /catalog request failed: ECONNREFUSED/);
  const silent = await catalog(() => null);
  await assert.rejects(fetchRamiCatalog('x', { url: silent.url, timeoutMs: 150 }), /catalog request failed: timed out/);
});
