#!/usr/bin/env node
// Relays a stdio MCP client (such as Claude Desktop) to the long-running HTTP
// server, so the client shares its store sessions and starts instantly:
//   docker exec -i grocery-mcp-grocery-http-1 node src/bridge.js
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const url = new URL(process.env.GROCERY_BRIDGE_URL || `http://127.0.0.1:${process.env.GROCERY_BRIDGE_PORT || 8791}/mcp`);
const log = (message) => process.stderr.write(`[grocery-bridge] ${message}\n`);

const upstream = new StreamableHTTPClientTransport(url);
const downstream = new StdioServerTransport();

let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.allSettled([upstream.close(), downstream.close()]);
  process.exit(code);
}

downstream.onmessage = (message) => {
  upstream.send(message).catch((error) => {
    log(`request failed: ${error.message}`);
    if (message.id !== undefined) {
      void downstream.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `Grocery server at ${url.host} is unreachable: ${error.message}` },
      });
    }
  });
};
upstream.onmessage = (message) => void downstream.send(message);
upstream.onerror = (error) => log(error.message);

// Like the server's stdio mode: leave when the client closes stdin.
process.stdin.on('end', () => void close(0));
process.on('SIGINT', () => void close(130));
process.on('SIGTERM', () => void close(143));

await upstream.start();
await downstream.start();
log(`relaying stdio to ${url}`);
