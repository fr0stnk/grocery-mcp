import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createGroceryServer } from '../src/app.js';
import { AuthError, challenge, createTokenVerifier, oauthConfig, protectedResourceMetadata } from '../src/auth.js';
import { openDatabase } from '../src/db/database.js';
import { knownIdentity, parseMembers, signIn } from '../src/db/identities.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner } from '../src/db/people.js';
import { startHttpServer } from '../src/http.js';

const ISSUER = 'https://id.example.test';
const AUDIENCE = 'https://grocery.example.test/mcp';
const NOW = Date.parse('2026-11-28T12:00:00Z');
const T = NOW / 1000;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { key, kid = 'k1', alg = 'RS256', header = {} }) {
  const head = b64({ alg, kid, typ: 'at+jwt', ...header });
  const body = b64(claims);
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg.startsWith('ES') ? crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('sha256', data, key);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (pair, kid, alg) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
const good = { iss: ISSUER, aud: [AUDIENCE], sub: 'user-1', exp: T + 600, iat: T, email: 'owner@example.test' };

function issuer(keys) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.endsWith('/openid-configuration')) return { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` };
    if (url === `${ISSUER}/jwks`) return { keys: keys() };
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchJson };
}

test('the verifier accepts a well-formed token and refuses every way it can be wrong', async () => {
  let clock = NOW;
  const { calls, fetchJson } = issuer(() => [jwk(rsa, 'k1', 'RS256'), jwk(ec, 'e1', 'ES256')]);
  const verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson, now: () => clock });

  assert.equal((await verify(sign(good, { key: rsa.privateKey }))).sub, 'user-1');
  assert.equal((await verify(sign({ ...good, aud: AUDIENCE }, { key: ec.privateKey, kid: 'e1', alg: 'ES256' }))).sub, 'user-1');
  assert.equal(calls.length, 2, 'discovery and keys are fetched once');

  const refused = async (token, pattern) => assert.rejects(verify(token), (e) => e instanceof AuthError && pattern.test(e.message));
  await refused(sign({ ...good, aud: 'https://other.example.test/mcp' }, { key: rsa.privateKey }), /not for this server/);
  await refused(sign({ ...good, iss: 'https://evil.example.test' }, { key: rsa.privateKey }), /another issuer/);
  await refused(sign({ ...good, exp: T - 120 }, { key: rsa.privateKey }), /expired/);
  await refused(sign({ ...good, nbf: T + 600 }, { key: rsa.privateKey }), /not valid yet/);
  await refused(sign({ ...good, sub: '' }, { key: rsa.privateKey }), /no subject/);
  await refused(sign(good, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /signature is not valid/);
  await refused(sign(good, { key: ec.privateKey, kid: 'k1', alg: 'ES256' }), /does not match its key/);
  await refused(`${b64({ alg: 'none', kid: 'k1' })}.${b64(good)}.`, /algorithm "none"/);
  await refused(`${b64({ alg: 'HS256', kid: 'k1' })}.${b64(good)}.c2ln`, /algorithm "HS256"/);
  await refused('not-a-jwt', /not a JWT/);
  const [h, , s] = sign(good, { key: rsa.privateKey }).split('.');
  await refused(`${h}.${b64({ ...good, sub: 'someone-else' })}.${s}`, /signature is not valid/);

  // An unknown key id refetches the keys, at most every 30 seconds.
  const before = calls.length;
  await refused(sign(good, { key: rsa.privateKey, kid: 'k9' }), /unknown key/);
  assert.equal(calls.length, before, 'too soon after the last fetch');
  clock += 31_000;
  await refused(sign(good, { key: rsa.privateKey, kid: 'k9' }), /unknown key/);
  assert.equal(calls.length, before + 1);
});

test('a rotated key is picked up, and an unreachable issuer is a server error', async () => {
  let clock = NOW;
  let keys = [jwk(rsa, 'k1', 'RS256')];
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson: issuer(() => keys).fetchJson, now: () => clock });
  await verify(sign(good, { key: rsa.privateKey }));
  keys = [jwk(rotated, 'k2', 'RS256')];
  clock += 31_000;
  assert.equal((await verify(sign(good, { key: rotated.privateKey, kid: 'k2' }))).sub, 'user-1');

  const down = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down(sign(good, { key: rsa.privateKey })), (e) => e.code === 'server_error');
  const wrong = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson: async () => ({ issuer: 'https://evil.example.test', jwks_uri: 'x' }) });
  await assert.rejects(wrong(sign(good, { key: rsa.privateKey })), (e) => e.code === 'server_error' && /does not match/.test(e.message));
});

test('oauthConfig needs every value once the public listener is set, and only https', () => {
  assert.equal(oauthConfig({}), null);
  assert.throws(() => oauthConfig({ GROCERY_PUBLIC_HTTP: '8796' }), /GROCERY_PUBLIC_URL and GROCERY_OAUTH_ISSUER/);
  assert.throws(() => oauthConfig({ GROCERY_PUBLIC_HTTP: '8796', GROCERY_PUBLIC_URL: 'http://grocery.example.test', GROCERY_OAUTH_ISSUER: ISSUER }), /https/);
  const config = oauthConfig({ GROCERY_PUBLIC_HTTP: '8796', GROCERY_PUBLIC_URL: 'https://grocery.example.test/', GROCERY_OAUTH_ISSUER: `${ISSUER}/` });
  assert.deepEqual(config, {
    listen: '8796', publicHost: 'grocery.example.test', issuer: ISSUER, resource: AUDIENCE, audience: AUDIENCE,
    metadataUrl: 'https://grocery.example.test/.well-known/oauth-protected-resource/mcp',
  });
  assert.deepEqual(protectedResourceMetadata(config).authorization_servers, [ISSUER]);
  assert.equal(challenge(config, { code: 'invalid_token', message: 'the "token" expired' }),
    'Bearer resource_metadata="https://grocery.example.test/.well-known/oauth-protected-resource/mcp", scope="openid email", error="invalid_token", error_description="the token expired"');
  assert.deepEqual(protectedResourceMetadata(config).scopes_supported, ['openid', 'email']);
});

test('parseMembers reads email:role pairs and refuses anything else', () => {
  assert.deepEqual([...parseMembers(' Wife@Example.test:shopper, guest@example.test:viewer,kid@example.test ')], [
    ['wife@example.test', 'shopper'], ['guest@example.test', 'viewer'], ['kid@example.test', 'shopper'],
  ]);
  assert.throws(() => parseMembers('x@example.test:owner'), /shopper or viewer/);
  assert.throws(() => parseMembers('nobody'), /not an email/);
  assert.equal(parseMembers('').size, 0);
});

const tempDb = () => openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')), 'g.db'));

test('signIn links the owner by email, adds members with shared store access, and refuses everyone else', async () => {
  const db = await tempDb();
  const owner = ensureLocalOwner(db, { GROCERY_OWNER_EMAIL: 'Owner@example.test' });
  const shufersal = ensureEnvironmentStoreAccount(db, 'shufersal', owner.id);
  const members = parseMembers('wife@example.test:shopper,guest@example.test:viewer');
  const opts = { ownerId: owner.id, members, now: NOW };

  assert.deepEqual(signIn(db, { issuer: ISSUER, subject: 'o-1', email: 'owner@EXAMPLE.test' }, opts), { userId: owner.id, role: 'owner', email: 'Owner@example.test' });
  assert.equal(signIn(db, { issuer: ISSUER, subject: 'o-1' }, opts).userId, owner.id, 'a known identity needs no email');

  const wife = signIn(db, { issuer: ISSUER, subject: 'w-1', email: 'wife@example.test' }, opts);
  assert.equal(wife.role, 'shopper');
  assert.notEqual(wife.userId, owner.id);
  assert.deepEqual(db.prepare('SELECT store_account_id, role FROM store_access WHERE user_id = ?').all(wife.userId).map((r) => ({ ...r })), [{ store_account_id: shufersal.id, role: 'shopper' }]);
  assert.equal(signIn(db, { issuer: 'https://other-idp.example.test', subject: 'w-2', email: 'wife@example.test' }, opts).userId, wife.userId, 'a second identity joins the same person');
  assert.equal(signIn(db, { issuer: ISSUER, subject: 'g-1', email: 'guest@example.test' }, opts).role, 'viewer');

  const denied = (identity, options, pattern) => assert.throws(() => signIn(db, identity, options), (e) => e.code === 'FORBIDDEN' && pattern.test(e.message));
  denied({ issuer: ISSUER, subject: 'x-1', email: 'stranger@example.test' }, opts, /not allowed/);
  denied({ issuer: ISSUER, subject: 'x-2' }, opts, /no verified email/);
  denied({ issuer: ISSUER, subject: 'w-1' }, { ...opts, members: parseMembers('guest@example.test:viewer') }, /no longer allowed/);
  db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), wife.userId);
  denied({ issuer: ISSUER, subject: 'w-1' }, opts, /disabled/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3, 'refused sign-ins create nobody');
  db.close();
});

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))));

test('the public listener publishes its metadata, challenges without a token and serves each person their own server', async () => {
  const config = oauthConfig({ GROCERY_PUBLIC_HTTP: '0', GROCERY_PUBLIC_URL: 'https://grocery.example.test', GROCERY_OAUTH_ISSUER: ISSUER });
  const seen = [];
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    extraHosts: [config.publicHost],
    auth: {
      config,
      authenticate: async (token) => {
        if (token === 'good') return { userId: 'u1', role: 'viewer' };
        if (token === 'stranger') throw Object.assign(new Error('stranger@example.test is not allowed'), { code: 'FORBIDDEN' });
        if (token === 'down') throw new AuthError('the issuer cannot be reached', 'server_error');
        throw new AuthError('the token has expired');
      },
    },
    makeServer: (who) => {
      seen.push(who);
      return createGroceryServer([], { readOnly: who.role === 'viewer' });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (headers = {}) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const meta = await fetch(`${base}${p}`);
    assert.equal(meta.status, 200);
    assert.deepEqual((await meta.json()).authorization_servers, [ISSUER]);
  }

  const anonymous = await call();
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), `Bearer resource_metadata="${config.metadataUrl}", scope="openid email"`);
  const expired = await call({ authorization: 'Bearer old' });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get('www-authenticate'), /error="invalid_token", error_description="the token has expired"/);
  const stranger = await call({ authorization: 'Bearer stranger' });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.headers.get('www-authenticate'), null);
  assert.equal((await call({ authorization: 'Bearer down' })).status, 503);
  assert.equal(seen.length, 0, 'no MCP server is made before sign-in succeeds');

  const ok = await call({ authorization: 'Bearer good', host: 'grocery.example.test' });
  assert.equal(ok.status, 200);
  const names = (await ok.json()).result.tools.map((t) => t.name);
  assert.ok(!names.includes('add_basket_to_cart'), 'a viewer gets the read-only tools');
  assert.deepEqual(seen, [{ userId: 'u1', role: 'viewer' }]);
});

test('verify.email uses a verified email from the token, otherwise from userinfo for the same subject', async () => {
  let info = { sub: 'user-1', email: 'owner@example.test', email_verified: true };
  const sent = [];
  const fetchJson = async (url, headers) => {
    if (url.endsWith('/openid-configuration')) return { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/userinfo` };
    if (url === `${ISSUER}/jwks`) return { keys: [jwk(rsa, 'k1', 'RS256')] };
    if (url === `${ISSUER}/userinfo`) {
      sent.push(headers.authorization);
      if (info instanceof Error) throw info;
      return info;
    }
    throw new Error(url);
  };
  const verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, fetchJson, now: () => NOW });
  const plain = { ...good, email: undefined };
  const token = sign(plain, { key: rsa.privateKey });
  const claims = await verify(token);

  assert.equal(await verify.email(token, { ...claims, email: 'in-token@example.test', email_verified: true }), 'in-token@example.test');
  assert.equal(sent.length, 0, 'a verified email in the token needs no lookup');
  assert.equal(await verify.email(token, claims), 'owner@example.test');
  assert.deepEqual(sent, [`Bearer ${token}`]);
  assert.equal(await verify.email(token, { ...claims, email: 'unverified@example.test' }), 'owner@example.test', 'an unverified token email is looked up instead');
  info = { ...info, email_verified: false };
  assert.equal(await verify.email(token, claims), null, 'an unverified email is never used');
  info = { sub: 'someone-else', email: 'x@example.test', email_verified: true };
  assert.equal(await verify.email(token, claims), null, 'userinfo for another subject is ignored');
  info = new Error('HTTP 401');
  assert.equal(await verify.email(token, claims), null);
});

test('knownIdentity says whether a subject has signed in before', async () => {
  const db = await tempDb();
  const owner = ensureLocalOwner(db, { GROCERY_OWNER_EMAIL: 'owner@example.test' });
  assert.equal(knownIdentity(db, ISSUER, 'o-1'), false);
  signIn(db, { issuer: ISSUER, subject: 'o-1', email: 'owner@example.test' }, { ownerId: owner.id, now: NOW });
  assert.equal(knownIdentity(db, ISSUER, 'o-1'), true);
  assert.equal(knownIdentity(db, 'https://other.example.test', 'o-1'), false);
  db.close();
});
