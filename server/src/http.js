import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthError, bearerToken, challenge, protectedResourceMetadata } from './auth.js';
import { BUILD } from './version.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Parses "host:port" or "port" (host defaults to loopback). */
export function parseListen(value) {
  const m = /^(?:(.+):)?(\d+)$/.exec(String(value).trim());
  if (!m) throw new Error(`GROCERY_HTTP must be "port" or "host:port", got ${JSON.stringify(value)}`);
  return { host: m[1] || '127.0.0.1', port: Number(m[2]) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Stateless Streamable HTTP: every POST gets a fresh MCP server and transport,
 * while all requests share the long-lived store processes.
 *
 * With `auth` ({ config, authenticate(token) -> principal }) every MCP request
 * needs a bearer token: it publishes the protected-resource metadata and
 * answers a missing or bad token with 401 and a challenge naming it, and a
 * person who may not use the server with 403. `makeServer` gets the principal.
 */
export function startHttpServer({ host, port, path = '/mcp', makeServer, log = () => {}, auth = null, extraHosts = [] }) {
  const hostNames = host === '0.0.0.0' || host === '::' ? null : [host, 'localhost', '127.0.0.1', ...extraHosts.filter(Boolean)];
  const metadataPaths = new Set(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${path}`]);

  const httpServer = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://local');
    if (pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: BUILD.version, commit: BUILD.commit, buildDate: BUILD.buildDate });
    if (auth && metadataPaths.has(pathname) && req.method === 'GET') {
      return send(res, 200, protectedResourceMetadata(auth.config), { 'access-control-allow-origin': '*', 'cache-control': 'max-age=3600' });
    }
    if (pathname !== path) {
      // Plain text, not JSON: OAuth discovery clients such as OpenAI's
      // tunnel-client parse a JSON 404 from /.well-known/... as broken
      // metadata and then refuse the server.
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    if (req.method !== 'POST') {
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { allow: 'POST' });
    }

    let principal = null;
    if (auth) {
      const token = bearerToken(req);
      if (!token) return send(res, 401, { error: 'unauthorized', error_description: 'sign in to use this server' }, { 'www-authenticate': challenge(auth.config) });
      try {
        principal = await auth.authenticate(token);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'server_error') {
          log(`sign-in check failed: ${error.message}`);
          return send(res, 503, { error: 'temporarily_unavailable', error_description: 'the sign-in service cannot be reached' });
        }
        if (error instanceof AuthError) return send(res, 401, { error: error.code, error_description: error.message }, { 'www-authenticate': challenge(auth.config, error) });
        // No challenge: signing in again would not help, and a client could loop on it.
        if (error.code === 'FORBIDDEN') return send(res, 403, { error: 'access_denied', error_description: error.message });
        log(`sign-in failed: ${error.message}`);
        return send(res, 500, { error: 'server_error' });
      }
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${error.message}` }, id: null });
    }

    const server = makeServer(principal);
    const { port: actualPort } = httpServer.address();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Loopback-only listener: reject requests whose Host header names anything else.
      ...(hostNames && { enableDnsRebindingProtection: true, allowedHosts: hostNames.flatMap((h) => [h, `${h}:${actualPort}`]) }),
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      log(`request failed: ${error.message}`);
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      log(`listening on http://${host}:${address.port}${path}`);
      resolve(httpServer);
    });
  });
}
