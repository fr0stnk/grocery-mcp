// A stand-in store adapter. FAKE_MODE: "shufersal" | "rami-levy" | "fail".
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mode = process.env.FAKE_MODE;
if (mode === 'fail') {
  console.error('fake-store: missing required env var FAKE_TOKEN');
  process.exit(1);
}

const searchTool = mode === 'rami-levy' ? 'rami_levy_search_products' : 'search_products';
const results = {
  shufersal: [{ code: 'P_7290102398065', name: 'חלב 3%', brand: 'טרה', unit: '2 ליטר', price: '14.70 ₪', inStock: true, sellingMethod: 'BY_UNIT' }],
  'rami-levy': { ok: true, results: [{ productId: '419939', name: 'חלב טרי 3% 1 ליטר רמי לוי', price: 7.1 }] },
};

const server = new Server({ name: `fake-${mode}`, version: '0' }, { capabilities: { tools: {} }, instructions: `fake ${mode} instructions` });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: searchTool, description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } } },
    { name: mode === 'rami-levy' ? 'rami_levy_view_cart' : 'view_cart', description: 'cart', inputSchema: { type: 'object' } },
    { name: 'crash', description: 'exit the process', inputSchema: { type: 'object' } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'crash') {
    console.error('fake-store: crashing on request');
    setTimeout(() => process.exit(1), 10);
    return { content: [{ type: 'text', text: 'bye' }] };
  }
  if (name === searchTool) {
    if (args?.query === 'boom') return { isError: true, content: [{ type: 'text', text: 'search exploded' }] };
    return { content: [{ type: 'text', text: JSON.stringify(results[mode]) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify({ tool: name, pid: process.pid }) }] };
});
await server.connect(new StdioServerTransport());
