# Grocery MCP server

This is the combined MCP server for Rami Levy and Shufersal. It starts each pinned store integration from `../upstream/` as a child MCP server over stdio. It then offers one server to the client, with a search across both stores and every store tool forwarded. Clients connect over stdio, or over Streamable HTTP when `GROCERY_HTTP` is set.

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
    "rami-levy": { "ok": true, "count": 5 }
  },
  "sameProduct": [
    {
      "barcode": "7290102398065",
      "name": "חלב 3% בקרטון מהדרין",
      "offers": [
        { "store": "shufersal", "productId": "P_7290102398065", "price": 14.7 },
        { "store": "rami-levy", "productId": "329258", "price": 14.9 }
      ],
      "cheapestStore": "shufersal",
      "priceDifference": 0.2
    }
  ],
  "results": [
    {
      "store": "shufersal",
      "productId": "P_4131074",
      "barcode": null,
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
- `barcode` is the retail barcode (EAN-8, UPC-A, EAN-13 or GTIN-14). Shufersal's `P_<digits>` codes and Rami Levy's catalog both carry it. Internal codes, such as produce PLUs, give `null`.
- `sameProduct` groups items with the same barcode in more than one store. Each group lists the offers cheapest first, with `cheapestStore` (or `null` on a tie) and `priceDifference`. Groups are sorted by the largest difference first. Other items are not matched, and the server instructions ask the client to compare them by name, size and unit price.
- `promotions` appears on Rami Levy items with offers. Each one has `text`, `quantity` and `price` (for example 4 for ₪10), a per-item `unitPrice` under the offer, the `until` date, and `clubOnly` and `personal` flags.
- Items sold by weight carry `"soldByWeight": true`. Rami Levy prices them per kilogram, so their `pricePerUnit` is that price per `kg`. Shufersal's weighed items have no unit price, because the meaning of their price is not confirmed.
- `brand` and `inStock` are `null` for Rami Levy. Its catalog returns only a numeric brand ID and no stock flag.
- Rami Levy is searched through its public catalog API (`src/rami-catalog.js`), which needs no login. The adapter's search drops barcodes and promotions, and catalog search keeps working when the adapter's tokens have expired. Carts and orders still go through the adapter. The search uses `RAMI_LEVY_STORE`, `RAMI_LEVY_USER_AGENT` and `RAMI_LEVY_COOKIE` when set.
- A store that fails, returns an error or takes more than 45 seconds is reported in `stores`. The other store's results are still returned.

### `compare_basket`

This tool prices a whole shopping list in every configured store.

| Argument | Type | Meaning |
|---|---|---|
| `items` | 1–40 of `{ query, quantity?, barcode? }` | Hebrew search terms per item. The quantity defaults to 1 and is in kilograms for weighed items. `barcode` pins an exact product. |
| `stores` | array of `shufersal`, `rami-levy` | Compare only these stores |

For each item it chooses one product per store:

1. With a pinned `barcode`, only that exact product counts.
2. Otherwise, a barcode sold in **every** store wins, preferring the one ranked highest by the stores' own relevance. The match is `identical: true`.
3. Otherwise, each store's most relevant in-stock result is used, with `identical: false`, and the client is asked to point out that the products differ.

Each offer's `lineTotal` is price × quantity. The cheapest qualifying Rami Levy multi-buy promotion is applied and named in `promotion`. Club-only and personal offers are shown as `clubOffer` but not applied.

The result contains:

- `items`: each item's chosen offers per store, with `cheapestStore`.
- `totals`: each store's total, the number of items found and the `missing` queries.
- `comparable`: totals over only the items every store has, with `cheaperStore` and `difference`. This is the fair comparison.
- `split`: the total when every item is bought where it is cheapest, and `savingsOnCommonItems` against the cheapest single store.
- `notes`: delivery fees and minimum orders are excluded, weighed quantities are in kilograms, and some prices may be stale.

A store that fails is reported in `stores`, and the other store is still priced.

### `add_basket_to_cart`

This tool adds several products to **one** store's real cart in a single call, usually the chosen store's offers from `compare_basket`. The client then asks for confirmation once instead of once per item.

| Argument | Meaning |
|---|---|
| `store` | `shufersal` or `rami-levy` |
| `items` | 1–60 of `{ productId, quantity, name?, price? }`. For Rami Levy, `name` and `price` are required and are taken from the offer as returned. |
| `dry_run` | Preview only; the cart is not changed |

- **Shufersal:** one call to the adapter's bulk `add_to_cart`, which also handles `dry_run`. It takes only whole units, so weighed items are added in Shufersal's app.
- **Rami Levy:** one `rami_levy_add_item` per product. Each call syncs the whole cart, and quantities are added to what is already there. The tool reports each item's result. After 90 seconds it stops starting new adds and reports the rest as not attempted, which keeps it inside the OpenAI tunnel's 120-second limit.
- Nothing is ordered or paid. Checkout happens in the store's app or site.

### Household preferences

`list_preferences`, `save_preference` and `remove_preference` manage products the household buys again. The data is shared by every client of the server: you and your family, ChatGPT and Claude.

```json
{ "name": "Milk", "barcode": "7290102398065", "query": "חלב 3%", "quantity": 2, "usual": true, "note": "only 1 L" }
```

- `name` can be in any language and is matched without regard to case.
- `barcode` pins an exact product, and is preferred over `query`: searching a store by barcode returns exactly that product.
- `quantity` is the default amount, and `usual` puts the item in the usual basket.
- `compare_basket` accepts `{ "preference": "milk" }` items, and `usual: true` adds every preference marked usual.
- The preferences live in `preferences.json` under `GROCERY_DATA_DIR`. In Docker that is the `grocery-data` volume at `/data/grocery`; locally it is `<repo>/.data`. The file is re-read on every call and replaced atomically with mode 0600, so the stdio and HTTP servers share it safely.
- In read-only mode `save_preference`, `remove_preference` and `add_basket_to_cart` are hidden and refused.

### Search cache

`search_all_stores` and `compare_basket` share an in-memory cache (`src/cache.js`), keyed by store, Rami Levy branch and query:

- Each store is asked for a fixed batch of up to 20 results, so a cached search serves any `limit`.
- Results are reused for 15 minutes.
- If a fresh fetch fails, results up to 24 hours old are returned with `stale: true` and `fetchedAt`, instead of an error.
- Concurrent identical searches share one fetch, and each store runs at most 4 searches at once.
- Carts, orders and status are never cached.
- Each store's status includes `fetchedAt`, plus `cached: true` when the result came from the cache.

### Language

Users may write in Hebrew, Russian or English, while both catalogs are in Hebrew. The server instructions and the `search_all_stores` description tell the client to:

- search with Hebrew requests as written, and translate Russian or English requests into Hebrew search terms first,
- retry with a simpler term or synonym when nothing is found,
- answer in the user's language, showing the Hebrew product names with a translation (none for Hebrew speakers) and prices in ₪.

### Forwarded store tools

Each adapter's tools are listed with their input schemas unchanged. Each name carries a store prefix, and each description starts with the store name:

- Shufersal's 19 tools appear as `shufersal_<name>`, for example `shufersal_view_cart` and `shufersal_add_to_cart`.
- Rami Levy's 10 tools already start with `rami_levy_` and keep their names.

Calls are passed through as they are, with a 110-second timeout, which fits within the OpenAI tunnel's 120-second limit. Tool annotations are kept. Rami Levy's adapter declares none, so `src/config.js` marks its read tools `readOnlyHint` and its removal tools `destructiveHint`. Without that, ChatGPT would ask for confirmation even before a search. `search_all_stores` is marked read-only. The adapters' own server instructions are appended to this server's instructions. Those include Shufersal's rule that tools never check out or pay.

## Startup and failures

- Before answering the client's `initialize`, the server starts all stores, with a limit of 40 seconds, so their tools and instructions can be included.
- A store that fails to start does not stop the server. Its error is the last line the adapter wrote to stderr, for example a missing variable. That error appears in search results, and the store is tried again on its next use. When it comes up later, its tools are added and the client is notified that the tool list changed.
- If an adapter process exits, it is restarted on the next call.
- The server exits when the client closes stdin, and stops its adapters. The SDK's stdio transport does not do this by itself, and the open adapter pipes would otherwise keep the process running.
- Adapter stderr is forwarded with a `[shufersal]` or `[rami-levy]` prefix. The server's own messages use `[grocery]`.

## HTTP mode

With `GROCERY_HTTP=127.0.0.1:8791`, the server listens at `http://127.0.0.1:8791/mcp`:

- It is stateless. Each `POST /mcp` gets a fresh MCP server and transport, and returns a JSON response. All requests share the same long-running store processes, so stores start once, not once per client.
- `GET /health` returns `{"ok":true}`. Other paths return a plain-text 404, and other methods on `/mcp` return 405. The 404 is plain text because OpenAI's tunnel-client probes the `/.well-known/oauth-*` paths and tried to read a JSON 404 as OAuth metadata. Bodies are limited to 4 MiB.
- On a loopback address, requests whose `Host` header names another host are rejected with 403, which guards against DNS rebinding.
- It keeps running when stdin closes, so it can run as a detached service. Stdio mode exits instead.
- In stateless mode, notifications such as a changed tool list are not pushed. Clients see newly started store tools the next time they list tools.

`../compose.tunnel.yaml` runs this mode as the `grocery-http` service for ChatGPT. See [`../tunnel/README.md`](../tunnel/README.md).

## Configuration

The adapters read their own variables, listed in the root `.env.example`. The server passes its full environment through to them. The server itself reads:

| Variable | Default | Meaning |
|---|---|---|
| `GROCERY_STORES` | `shufersal,rami-levy` | Stores to run, comma-separated |
| `GROCERY_SHUFERSAL_ENTRY` | `upstream/shufersal-cart/bin/shufersal-mcp.mjs` | Shufersal adapter entry point, relative to the repository root |
| `GROCERY_RAMI_LEVY_ENTRY` | `upstream/rami-levy-mcp/dist/index.js` | Rami Levy adapter entry point, relative to the repository root |
| `GROCERY_RAMI_LEVY_SEARCH` | catalog | Set to `adapter` to search Rami Levy through the adapter's tool instead of its catalog API |
| `GROCERY_RAMI_LEVY_CATALOG_URL` | Rami Levy's catalog API | Catalog endpoint override, used by the tests |
| `GROCERY_DATA_DIR` | `<repo>/.data` locally, `/data/grocery` in Docker | Where `preferences.json` is kept |
| `GROCERY_PREFERENCES_FILE` | `$GROCERY_DATA_DIR/preferences.json` | Exact preferences file, used by the tests |
| `GROCERY_HTTP` | unset, which means stdio | Serve Streamable HTTP on `port` or `host:port`. The host defaults to `127.0.0.1`. |
| `GROCERY_READ_ONLY` | off | When `1`, only tools annotated `readOnlyHint` are listed, and other forwarded tools are refused. `search_all_stores` always works. |

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
npm test           # all tests
npm run coverage   # with coverage thresholds: 95% lines, 80% branches, 85% functions
npm run lint       # ESLint
```

The tests use stand-in adapters from `test/fixtures/`, so they need no credentials or network access:

- `normalize.test.js` covers size, price, barcode and promotion parsing, both stores' result shapes, weighed items, error reporting, sorting and barcode grouping. The cases come from live search results.
- `http.test.js` runs the server in HTTP mode with stdin closed. It also checks catalog search against a local stand-in for the catalog API, including the store and User-Agent sent and the barcode pairing. It covers listing tools and annotations, search, two clients sharing one store process, 404, 405, 400 and a foreign `Host` header, and read-only mode.
- `preferences.test.js` and `order.test.js` cover preference storage, validation and resolution into baskets, and both stores' cart paths, including failures, the time budget and dry runs.
- `basket.test.js` covers the cache (TTL, stale fallback, merged loads), the concurrency limiter, match selection, promotion pricing, basket totals and a failing store.
- `http-server.test.js` and `rami-catalog.test.js` test the HTTP listener and the catalog client in process, including error paths such as challenge pages, HTTP errors, refused connections and timeouts.
- `server.test.js` starts real child processes. It covers startup failure messages, restart after an adapter exits, partial results when one store fails or hangs, tool forwarding and prefixes, instruction pass-through, and exit when stdin closes.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | Entry point: starts the stores, then serves stdio or HTTP, and handles shutdown |
| `src/app.js` | Builds an MCP server: tool listing with annotations, read-only filtering, call routing and instructions |
| `src/http.js` | Stateless Streamable HTTP listener with health check, body limit and Host check |
| `src/config.js` | Store definitions and adapter entry points |
| `src/stores.js` | `StoreClient`: one adapter process, with startup, restart and stderr capture |
| `src/search.js` | `search_all_stores`, per-store cached search and barcode grouping |
| `src/basket.js` | `compare_basket`: match selection, promotion pricing and totals |
| `src/order.js` | `add_basket_to_cart`: Shufersal bulk add, Rami Levy per-item adds with a time budget |
| `src/preferences.js` | Household preference store and its three tools |
| `src/version.js` | Reads the version from `package.json` |
| `src/cache.js` | Search cache with stale fallback, and the per-store concurrency limiter |
| `src/normalize.js` | Converts each store's results to the shared shape, and parses sizes, prices, barcodes and promotions |
| `src/rami-catalog.js` | Client for Rami Levy's public catalog search |

`src/app.js` uses the SDK's low-level `Server` class instead of `McpServer`. Forwarded tools keep their JSON Schemas, which `McpServer`'s zod-based registration cannot take.

## Adding a store

1. Add the adapter under `upstream/` as a submodule.
2. Add a `STORE_DEFS` entry in `src/config.js`, with its label, tool prefix, entry point, search tool name, result limit and normalizer.
3. Write a normalizer in `src/normalize.js` and test it on real search output.
4. Add the store's build stage, its copy into the `grocery` image and its data volume in the root `Dockerfile` and `compose.yaml`. Then add its id to `SEARCH_TOOL`'s `stores` enum.
