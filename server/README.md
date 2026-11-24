# Grocery MCP server

This is the combined MCP server for Rami Levy and Shufersal. It starts each pinned store integration from `../upstream/` as a child MCP server over stdio. It then offers one server to the client, with a search across both stores and every store tool forwarded.

```
MCP client ──stdio──▶ grocery server ──stdio──▶ Shufersal adapter  (upstream/shufersal-cart)
                                     └─stdio──▶ Rami Levy adapter  (upstream/rami-levy-mcp)
```

The server reaches the adapters only through their public MCP tools, so updating a submodule needs no change here as long as the tool names and output shapes stay the same.

## Tools

### `search_all_stores`

This tool searches every configured store in parallel.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | required | What to search for. Hebrew works best, for example `חלב 3%`. |
| `limit` | integer, 1–20 | 10 | Maximum results per store |
| `stores` | array of `shufersal`, `rami-levy` | all configured | Search only these stores |

It returns JSON text like this:

```json
{
  "query": "חלב 3%",
  "stores": {
    "shufersal": { "ok": true, "count": 5 },
    "rami-levy": { "ok": false, "error": "Rami Levy failed to start: rami-levy-mcp: missing required env var RAMI_LEVY_BEARER_TOKEN" }
  },
  "results": [
    {
      "store": "shufersal",
      "productId": "P_4131074",
      "name": "חלב בקרטון 3% שומן",
      "brand": "תנובה",
      "size": "1 L",
      "price": 7.35,
      "pricePerUnit": 7.35,
      "perUnit": "L",
      "inStock": true
    }
  ]
}
```

- Results are sorted by `pricePerUnit`, then by `price`. Items without a unit price come last.
- `size` is read from Shufersal's unit field, or else from the product name, for example `2 ליטר`, `1 ל'`, `6*200 מ"ל` or `500 גרם`. It is always shown in liters or kilograms. `null` means the size could not be read, and no value is guessed.
- Items sold by weight carry `"soldByWeight": true` and have no unit price, because their price does not follow from the pack size.
- `brand` and `inStock` are `null` for Rami Levy, because its search does not return them.
- Products are not matched across stores. The Rami Levy integration returns its own product IDs, not barcodes. The server instructions ask the client to compare by name, size and unit price, and to say which items it treats as equivalent.
- A store that fails, returns an error or takes more than 45 seconds is reported in `stores`. The other store's results are still returned.

### Forwarded store tools

Each adapter's tools are listed with their input schemas unchanged. Each name carries a store prefix, and each description starts with the store name:

- Shufersal's 19 tools appear as `shufersal_<name>`, for example `shufersal_view_cart` and `shufersal_add_to_cart`.
- Rami Levy's 10 tools already start with `rami_levy_` and keep their names.

Calls are passed through as they are, with a 120-second timeout. The adapters' own server instructions are appended to this server's instructions. Those include Shufersal's rule that tools never check out or pay.

## Startup and failures

- Before answering the client's `initialize`, the server starts all stores, with a limit of 40 seconds, so their tools and instructions can be included.
- A store that fails to start does not stop the server. Its error is the last line the adapter wrote to stderr, for example a missing variable. That error appears in search results, and the store is tried again on its next use. When it comes up later, its tools are added and the client is notified that the tool list changed.
- If an adapter process exits, it is restarted on the next call.
- The server exits when the client closes stdin, and stops its adapters. The SDK's stdio transport does not do this by itself, and the open adapter pipes would otherwise keep the process running.
- Adapter stderr is forwarded with a `[shufersal]` or `[rami-levy]` prefix. The server's own messages use `[grocery]`.

## Configuration

The adapters read their own variables, listed in the root `.env.example`. The server passes its full environment through to them. The server itself reads:

| Variable | Default | Meaning |
|---|---|---|
| `GROCERY_STORES` | `shufersal,rami-levy` | Stores to run, comma-separated |
| `GROCERY_SHUFERSAL_ENTRY` | `upstream/shufersal-cart/bin/shufersal-mcp.mjs` | Shufersal adapter entry point, relative to the repository root |
| `GROCERY_RAMI_LEVY_ENTRY` | `upstream/rami-levy-mcp/dist/index.js` | Rami Levy adapter entry point, relative to the repository root |

Each adapter runs with its own folder as the working directory. The container image keeps the repository layout, so the defaults work both locally and in Docker.

## Run locally

This needs Node 22.13 or newer. From the repository root:

```sh
git submodule update --init --recursive
(cd upstream/rami-levy-mcp && npm ci)      # also builds dist/
(cd upstream/shufersal-cart && npm ci)
cd server && npm ci
npm start
```

The server talks MCP over stdio, so in practice an MCP client starts it. Set the store variables in the environment first. Without them the server still starts, and the affected store reports why it is unavailable.

With Docker, run `docker compose run --rm -T grocery` from the repository root. See the root README.

## Tests

```sh
npm test
```

The tests use stand-in adapters from `test/fixtures/`, so they need no credentials or network access:

- `normalize.test.js` covers size and price parsing, both stores' result shapes, error reporting and sorting. The cases come from live search results.
- `server.test.js` starts real child processes. It covers startup failure messages, restart after an adapter exits, partial results when one store fails or hangs, tool forwarding and prefixes, instruction pass-through, and exit when stdin closes.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | MCP server: tool listing, call routing, startup and shutdown |
| `src/config.js` | Store definitions and adapter entry points |
| `src/stores.js` | `StoreClient`: one adapter process, with startup, restart and stderr capture |
| `src/search.js` | `search_all_stores`: definition, parallel search and per-store status |
| `src/normalize.js` | Converts each store's results to the shared shape, and parses sizes and prices |

The server uses the SDK's low-level `Server` class instead of `McpServer`. Forwarded tools keep their JSON Schemas, which `McpServer`'s zod-based registration cannot take.

## Adding a store

1. Add the adapter under `upstream/` as a submodule.
2. Add a `STORE_DEFS` entry in `src/config.js`, with its label, tool prefix, entry point, search tool name, result limit and normalizer.
3. Write a normalizer in `src/normalize.js` and test it on real search output.
4. Add the store's build stage, its copy into the `grocery` image and its data volume in the root `Dockerfile` and `compose.yaml`. Then add its id to `SEARCH_TOOL`'s `stores` enum.
