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
| `sortBy` | `relevance`, `unitPrice`, `price` | `relevance` | `relevance` keeps each store's own ranking, interleaved by rank. The others put the cheapest first. |
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

- By default the results keep each store's relevance order, interleaved by `rank`. Sorting by unit price would put a cheap but irrelevant match first. The stores' fuzzy search pads short lists with unrelated products, so results that share no word with the query are left out and counted in `stores.<id>.unrelatedHidden`. When nothing matches, the store returns no results rather than unrelated ones: Rami Levy's search reads `בננות` (bananas) as `בנות` (girls) and answers with girls' socks. A Hebrew plural also matches by its stem (`בננות` → `בננ-`, so `בננה` counts). If nothing fits, the store is searched again in the singular (`בננה`), reported as `stores.<id>.retriedAs`. `compare_basket` uses the same filter, so an unrelated product never reaches its totals. Numbers, sizes and units in the query (`12`, `3%`, `ליטר`, `גרם`) do not count as a match, so `ביצים 12` does not return pickles sold 10–12 per jar and `מים 1.5 ליטר` does not return a 1.5 litre kettle. Words match from their start, optionally behind a one-letter prefix (`המים`), not anywhere inside another word. A query without Hebrew letters must match every word instead, and nothing is kept when no product does: an untranslated "lactose free milk" otherwise found FREE-brand snack bars. Number and barcode queries are not filtered. With `sortBy: "unitPrice"` each unit (`kg`, `L`, `pc`) is sorted by `pricePerUnit` as its own group, because a price per litre and a price per kilogram are not comparable. Groups come in the order they first appear by relevance, and items without a unit price come last.
- `priceBasis` says what `price` buys: `unit`, `kg`, or `package`, which is packaged produce charged by actual weight and marked `priceEstimated: true`. Shufersal's weighed items, including packages described as מחיר לפי משקל (price by weight), are `kg` when Shufersal's own per-kg comparison price equals the price, or when a per-kg offer (`ב- 69.90 ₪ לק"ג`) explains the difference. In that case `price` already includes the offer, and `regularPrice` is the price without it.
- A query without Hebrew letters that is not a barcode gets a `hint` to translate it, because both catalogs are Hebrew.
- `size` is read from Shufersal's unit field, or else from the product name, for example `2 ליטר`, `1 ל'`, `6*200 מ"ל` or `500 גרם`. It is always shown in liters or kilograms. `null` means the size could not be read, and no value is guessed.
- `barcode` is the retail barcode (EAN-8, UPC-A, EAN-13 or GTIN-14). Shufersal's `P_<digits>` codes and Rami Levy's catalog both carry it. Internal codes, such as produce PLUs, give `null`.
- Many Shufersal codes have 7 digits, which are the tail of an EAN-13 starting with `729000`: `P_4131074` is `7290004131074`. Searching Shufersal for such a full barcode finds nothing, so the server retries with the 7-digit number. That barcode is inferred only when its GS1 check digit is valid, and is marked `barcodeInferred: true`. `sameProduct` groups and basket matches that rely on it report `confidence: "inferred"` instead of `"exact"`.
- `sameProduct` groups items with the same barcode in more than one store. Each group lists the offers cheapest first, with `cheapestStore` (or `null` on a tie) and `priceDifference`. Groups are sorted by the largest difference first. Other items are not matched, and the server instructions ask the client to compare them by name, size and unit price.
- `promotions` appears on items with offers from either store. Rami Levy's come from its catalog's `sale` records. Shufersal's come from its `promotionMsg` text. Multi-buy offers (`3 יח' ב- 15 ₪`), weight offers (`3 ק"ג ב- 49.98 ₪`) and per-kg offers (`ב- 69.90 ₪ לק"ג`) are parsed, and weight offers carry `perUnit: "kg"`. Other wording is kept as `text` only. Each one has `text`, `quantity` and `price` (for example 4 for ₪10), a per-item `unitPrice` under the offer, the `until` date, and `clubOnly` and `personal` flags.
- Packs with a count, such as eggs (`12 יחידות`, `ביצים 12 יח גדול L`), get `size: "12 pcs"`, `count: 12` and a price per piece (`perUnit: "pc"`).
- Items sold by weight carry `"soldByWeight": true`. Rami Levy prices them per kilogram, so their `pricePerUnit` is that price per `kg`. Shufersal's weighed items have no unit price, because the meaning of their price is not confirmed.
- `inStock` comes from Shufersal's stock status. For Rami Levy it is true when the configured branch is in the product's `available_in` list. Rami Levy's search already returns only products sold at that branch, so it is almost always true. `brand` is `null` for Rami Levy, whose catalog returns only a numeric brand ID.
- Shufersal is searched directly at `/online/he/search/results` (`src/shufersal-search.js`). The search uses the adapter's saved session cookies, which it reads but never writes, so the adapter remains the only process that manages the login. The adapter's own search drops the barcode, stock and promotions. If the direct search fails, for example because the session file is missing or the site answers with a login page, the server logs why and uses the adapter's search tool instead. When a product's size cannot be read from its text, Shufersal's own comparison price, such as ₪1.58 per 100 g, fills in `pricePerUnit`.
- Rami Levy is searched through its public catalog API (`src/rami-catalog.js`), which needs no login. The adapter's search drops barcodes and promotions, and catalog search keeps working when the adapter's tokens have expired. Carts and orders still go through the adapter. The search uses `RAMI_LEVY_STORE`, `RAMI_LEVY_USER_AGENT` and `RAMI_LEVY_COOKIE` when set.
- A store that fails, returns an error or takes more than 45 seconds is reported in `stores`. The other store's results are still returned.

### `compare_basket`

This tool prices a whole shopping list in every configured store.

| Argument | Type | Meaning |
|---|---|---|
| `items` | 1–40 of `{ query, quantity?, barcode? }` | Hebrew search terms per item. The quantity defaults to 1 and is in kilograms for weighed items. `barcode` pins an exact product. |
| `stores` | array of `shufersal`, `rami-levy` | Compare only these stores |

For each item it chooses one product per store. First, the query's own constraints are read and reported in `constraints`: a pack size (`חלב 3% 1 ליטר` → 1 L), a count (`ביצים 12` → 12 units), a grade (`L`, `M`, `XL`) and a percentage (`3%`). Products that contradict them are left out, so a request for 1 L milk never gets the 2 L carton and 12 L eggs never get 18 L or 12 M eggs. If no product in a store fits, the item is `missing` there rather than replaced. Products whose size, count or grade cannot be read are kept after those that verifiably fit, and are marked `fit: "unverified"`. A product stating a different percentage is left out. A product stating none is judged per store: if any of that store's candidates states a percentage, the request is checkable there and the unlabelled product is left out too, so `חלב 99%` is missing rather than 3% milk. Where no candidate states one, unlabelled products are kept as `fit: "unverified"`, so `חלב 3%` does not go missing in a store that never labels fat.

Next, the candidates are narrowed to those that are the product asked for (`src/match.js`):

- A product must name the query's first word, usually the kind of product, among the first two words of its name, or else match at least two of the query's words. `שריר עגל בננה` is a veal cut, not bananas.
- Of the rest, only those matching the most query words are kept, then those with the fewest **unrequested** words: variants and derived products the query does not mention, such as `דיאט`, `זירו`, `לימון`, `אומגה`, `קפוא`, `מלא`, `שרי`, `בחומץ` or `שוקולד`, and multipacks such as `שישייה` or `6*1.5`. Then those naming the product first are preferred. So `קוקה קולה זירו` gets plain Zero rather than lemon Zero, and `ביצים L 12` gets ordinary rather than Omega-3 eggs.
- When a store has only such variants, the closest is offered with `unrequested` listing the words, for example Diet Coke for `קוקה קולה 1.5 ליטר`. The item is then `notEquivalent` and the client is asked to confirm it.
- Store abbreviations are expanded first (`לל"ג` → `ללא גלוטן`, `ללת"ס` → `ללא תוספת סוכר`, `נטול` → `ללא`).

Then:

1. With a pinned `barcode`, only that exact product counts.
2. Otherwise, a barcode among the **top three** results of **every** store wins, preferring the one ranked highest by the stores' own relevance. The match is `identical: true`. A shared barcode further down is usually a different kind of product: for bananas, whose top results have no barcode, it was banana milk.
3. Otherwise, each store's most relevant in-stock result is used, with `identical: false`, and the client is asked to point out that the products differ.

Each offer's `lineTotal` is price × quantity. A fractional quantity means kilograms, so among the matching products, those a store sells per kilogram are preferred. This happens after the narrowing above, so a store that sells bananas only by the bunch offers the bunch, marked `INCOMPATIBLE_QUANTITY_BASIS`, rather than a veal cut that happens to be sold per kilogram. It is priced only for products sold per kilogram. `identical` is claimed only when every offer can be priced. For a product sold by unit or package, the offer is marked `excluded: "INCOMPATIBLE_QUANTITY_BASIS"` and left out of every total, listed under that store's `notComparable`. The cheapest qualifying Rami Levy multi-buy promotion is applied and named in `promotion`. Club-only and personal offers are shown as `clubOffer` but not applied.

The result contains:

- `items`: each item's chosen offers per store, with `cheapestStore`. It is `null` for an item marked `notEquivalent`, because different amounts of different products have no cheaper store.
- `totals`: each store's total, the number of items found and the `missing` queries.
- `comparable`: totals over only the items every store has **like for like**, with `cheaperStore` and `difference`. This is the fair comparison. An item whose products differ in pack size (`0.5 kg vs 1 kg`), count (`18 vs 12 units`) or how they are sold (`kg vs unit`, `package vs unit`), or whose offer carries an `unrequested` variant, is marked `notEquivalent` and listed in `comparable.leftOut` with the reason. A price per kilogram, per item and per estimated package buy different amounts, so their bases must be the same. It still counts in each store's own total. Sizes that cannot be read on both sides are not treated as different.
- `split`: the total when every item is bought where it is cheapest, and `savingsOnCommonItems` against the cheapest single store. Items marked `notEquivalent` are left out and listed in `split.leftOut`.
- `notes`: delivery fees and minimum orders are excluded, weighed quantities are in kilograms, and some prices may be stale.

A store that fails is reported in `stores`, and the other store is still priced.

#### Pricing a past order

`source: { store, order }` prices a past order in every store: "what would last week's Shufersal order cost at Rami Levy?". `order` is `"latest"` (the default) or an order code from the store's `list_orders`. It can be combined with `items`.

- Shufersal orders are read with its `get_order`, and Rami Levy's with `rami_levy_list_orders` and `rami_levy_view_order`.
- Each line is searched by barcode when it has one, including the inferred `729000` barcode of Shufersal's 7-digit codes. A store that does not stock that barcode is searched by the product's name, and its offer is marked `matchedBy: "name"`.
- The order's own store keeps the product that was bought.
- Shufersal's weighed and packaged lines are in grams in the order history (frozen salmon `1150`), so they are compared in kilograms (`1.15`).
- The result carries `source` (store, order code, date and the total paid then) and `sourceLine` on each item. A note says that prices are today's, and that the paid total included delivery and the actual weights.

### `price_history`

How a product's price changed, per store. Give a `barcode` (every store), a `store` with a `productId`, or a saved `preference`. `days` sets the period: 90 by default, at most 365.

For each store's product the tool returns the daily `series` and `current` price (with any promotion), plus:
- `lowest` and `highest`, with their days;
- `usualPrice`, the median before the latest day, and `vsUsual`, today's price minus it. A promotion with `vsUsual` at 0 or above is not a real discount;
- `isLowestSeen` and `change30Days`.

Prices are recorded in the `prices` table of the database: one row per store, product and day, kept for 400 days. Every fresh search result is recorded, from any tool and any client. The HTTP server also searches every saved preference once a day, so the products the household buys build a history without anyone searching for them. A product that was never searched has no history yet.

### `add_basket_to_cart`

This tool adds several products to **one** store's real cart in a single call, usually the chosen store's offers from `compare_basket`. The client then asks for confirmation once instead of once per item.

| Argument | Meaning |
|---|---|
| `store` | `shufersal` or `rami-levy` |
| `items` | 1–60 of `{ productId, quantity, name?, price? }`. `name` and `price` are only used for Rami Levy products that are not in recent search results. |
| `dry_run` | Preview only; the cart is not changed |

- **The server checks every product before anything is added, and a dry run uses exactly the same checks.** Each product is looked up in fresh search results (up to 15 minutes old), or else with a live search by its code. Rejected items get a stable code:
  - `PRODUCT_NOT_FOUND` for an unknown product,
  - `OUT_OF_STOCK`, including Rami Levy items not sold at the branch,
  - `ALREADY_IN_CART` for a Shufersal weighed or packaged product already in the cart, whose amount is changed in Shufersal's app,
  - `UNSUPPORTED_PRODUCT_ID` for anything that is not a Shufersal code; variant codes such as `P_7296073409441_42` are accepted,
  - `INVALID_QUANTITY` for a fractional quantity of an item sold by unit or pack, or a Shufersal weight that is not in 0.5 kg steps. Products sold by weight take their quantity in kilograms in both stores,
  - `PRODUCT_NOT_VERIFIED` for a Rami Levy product that cannot be found again. A product outside the 15-minute search cache is re-checked live: by the barcode it had when this server last saw it (from the price history, up to two days back), otherwise by that name or the given `name`. Rami Levy's catalog cannot be searched by product id, and a caller's name and price are never trusted on their own.
- Every result line has a `status` (`added`, `would-add` or `rejected`). The summary counts `requested`, `accepted`, `rejected` and `added`, and `complete` is true only when every line went through.
- **Shufersal:** only the checked items go to the adapter's bulk `add_to_cart`, in one call. The adapter's per-line outcome is reported back. The adapter leaves a product that is already in the cart unchanged, so the server then raises it with `set_quantity` to the existing quantity plus the requested one, and confirms the new quantity in the returned cart (`cartQuantity`). A total above Shufersal's 30-unit limit is rejected as `INVALID_QUANTITY` and nothing is changed.
- **Rami Levy:** the name and price come from the server's own search results, not from the request (`priceSource: "server"`). A request price that differs is reported as `priceChanged`. A product outside recent results is searched for by its `name`, and refused as `PRODUCT_NOT_VERIFIED` if that search does not return it. Then one `rami_levy_add_items` call adds every checked product with a single cart sync, and quantities are added to what is already there. Products Rami Levy refuses come back as `STORE_REJECTED`, while the rest stay added. A failed sync changes nothing and returns `STORE_ERROR`. The result includes Rami Levy's own `serverTotal`.
- Nothing is ordered or paid. Checkout happens in the store's app or site.

### `server_info` and version reporting

`server_info` reports what is running:

- `version`, plus `fullVersion`, which adds the short commit (`0.1.0+2f08eed`),
- the full git `commit`,
- `buildDate`,
- `imageTag`,
- the pinned `upstream` adapter commits,
- `startedAt` and `uptimeSeconds`,
- `readOnly`,
- each store's connection.

The same `fullVersion` is the `serverInfo.version` every MCP client receives when it connects, in semantic-versioning build-metadata form. `GET /health` returns `{ ok, version, commit, buildDate }`.

Images get the commit, build time and upstream commits as build arguments from the image workflow. Compose passes `GROCERY_IMAGE_TAG` into the container. Local runs read the commits from git, and the values are `null` when neither source is available.

### `account_status` and login warnings

`account_status` checks each store's login live, using Shufersal's `status` and Rami Levy's `check_status`. It reports a `state` per store: `ok`, `rejected` when the store refused the login, or `unknown` when the check timed out or the adapter could not be reached. `loggedIn` is `true`, `false` or `null` to match. It also reports when the Rami Levy token expires (`expiresAt`, `daysLeft`). Only a `rejected` login returns `howToRenew`. An `unknown` check adds a warning to that response only, and is not remembered as a login failure.

The server also keeps track of login health between calls:

- The Rami Levy `ecomtoken` is a JWT, so its expiry date is read from the token itself, with no network call.
- Any call that fails with a login-type error, such as `auth_expired` or "not signed in", is remembered until the store works again.

While something needs attention, every `search_all_stores` and `compare_basket` result carries `accountWarnings`. The instructions ask the client to tell the user in one sentence. Warnings start 7 days before the Rami Levy token expires. Search keeps working without a Rami Levy login, because it uses the public catalog, so the warning says that only carts and orders are affected.

MCP cannot message a user outside a conversation. For a daily check, a client's own scheduler can call `account_status`, for example a ChatGPT scheduled task.

### Household preferences

`list_preferences`, `save_preference` and `remove_preference` manage products the household buys again. The data is shared by every client of the server: you and your family, ChatGPT and Claude.

```json
{ "name": "Milk", "barcode": "7290102398065", "query": "חלב 3%", "quantity": 2, "usual": true, "note": "only 1 L" }
```

- `name` can be in any language and is matched without regard to case.
- `barcode` pins an exact product, and is preferred over `query`: searching a store by barcode returns exactly that product.
- `quantity` is the default amount, and `usual` puts the item in the usual basket.
- `compare_basket` accepts `{ "preference": "milk" }` items, and `usual: true` adds every preference marked usual.
- The preferences live in the database, per person (see Database). A `preferences.json` from older versions is imported on the first start. If the database is unavailable, the server falls back to that file.
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

## Bridge for stdio clients

`src/bridge.js` relays a stdio MCP client to the long-running HTTP server. Claude Desktop, for example, can then share its store sessions and start almost instantly instead of starting its own adapters:

```sh
ssh -T <server> 'docker exec -i grocery-mcp-grocery-http-1 node src/bridge.js'
```

The bridge connects to `GROCERY_BRIDGE_URL` (default `http://127.0.0.1:8791/mcp`), which is the server inside the same container. When the server cannot be reached, each request gets a JSON-RPC error instead of hanging. The bridge exits when the client closes stdin.

## Database

The server keeps its state in SQLite, `grocery.db` under `GROCERY_DATA_DIR` (the `grocery-data` volume in Docker), opened in WAL mode so the HTTP server and one-shot stdio runs can share it. `src/db/` holds:

- `migrations.js`: numbered, append-only migrations, applied in order at start. The SQL avoids SQLite-only features (TEXT ids and timestamps, encrypted values as TEXT), so the database can move to PostgreSQL later with a new driver and a data copy.
- the tables: `users`, `store_accounts` (one Shufersal or Rami Levy login, owned by the person who connected it), `store_access` (who may use which store account, as `owner`, `shopper` or `viewer`), `addresses`, `preferences` (per person), `carts` and `cart_syncs` (per store account, with idempotency keys), `audit_log` and `prices`;
- `vault.js`: envelope encryption for secrets and personal data. Each value gets its own random AES-256-GCM key, wrapped by the master key `GROCERY_MASTER_KEY`, which lives only in the server's environment. The row and field are bound as associated data, so a value copied elsewhere does not open. Retired keys in `GROCERY_MASTER_KEYS_OLD` keep old values readable after a rotation.
- `bootstrap.js`: run at every start, it adds what is missing. Until sign-in arrives there is one person, the owner, with a store account for each configured store whose login still comes from the environment (`status: environment`). Older `preferences.json` and `price-history.db` files are imported once and renamed with `.imported`.

Every tool call is written to `audit_log`: the tool, the store account, the outcome code, the duration and a short summary, never secrets or addresses. Entries are kept for 400 days. If the database cannot be opened, the server logs why and keeps working from the older preference and price files.

## Errors

Errors from the server's own tools are JSON with a stable code:

```json
{ "error": { "code": "NOT_FOUND", "message": "item 1: no saved preference named \"tea\"", "retryable": false } }
```

The codes are:

- `INVALID_ARGUMENT` and `INVALID_QUANTITY` for bad input,
- `NOT_FOUND` for an unknown preference,
- `STORE_UNAVAILABLE` and `STORE_ERROR` for a store problem,
- `STORAGE_ERROR` for an unreadable preferences file, which can be retried,
- the per-item codes of `add_basket_to_cart`, listed above.

Tools forwarded from the store adapters keep the adapters' own messages.

## Startup and failures

- Before answering the client's `initialize`, the server starts all stores, with a limit of 40 seconds, so their tools and instructions can be included.
- A store that fails to start does not stop the server. Its error is the last line the adapter wrote to stderr, for example a missing variable. That error appears in search results, and the store is tried again on its next use. When it comes up later, its tools are added and the client is notified that the tool list changed.
- If an adapter process exits, it is restarted on the next call.
- The server exits when the client closes stdin, and stops its adapters. The SDK's stdio transport does not do this by itself, and the open adapter pipes would otherwise keep the process running.
- Adapter stderr is forwarded with a `[shufersal]` or `[rami-levy]` prefix. The server's own messages use `[grocery]`.

## HTTP mode

With `GROCERY_HTTP=127.0.0.1:8791`, the server listens at `http://127.0.0.1:8791/mcp`:

- It is stateless. Each `POST /mcp` gets a fresh MCP server and transport, and returns a JSON response. All requests share the same long-running store processes, so stores start once, not once per client.
- `GET /health` returns `{"ok":true}` with the version, commit and build date. Other paths return a plain-text 404, and other methods on `/mcp` return 405. The 404 is plain text because OpenAI's tunnel-client probes the `/.well-known/oauth-*` paths and tried to read a JSON 404 as OAuth metadata. Bodies are limited to 4 MiB.
- On a loopback address, requests whose `Host` header names another host are rejected with 403, which guards against DNS rebinding.
- It keeps running when stdin closes, so it can run as a detached service. Stdio mode exits instead.
- A request whose `MCP-Protocol-Version` header names a version the SDK does not support gets HTTP 400, as the MCP specification requires. ChatGPT's newer `server/discover` probe is sent that way and is answered with 400, after which ChatGPT falls back to `2025-11-25` and connects normally. With a supported version, `server/discover` gets the standard JSON-RPC "Method not found". Support arrives with an SDK update, which Dependabot proposes.
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
| `GROCERY_SHUFERSAL_SEARCH` | direct | Set to `adapter` to always search Shufersal through the adapter's tool |
| `GROCERY_SHUFERSAL_ORIGIN` | `https://www.shufersal.co.il` | Shufersal origin override, used by the tests |
| `GROCERY_RAMI_LEVY_CATALOG_URL` | Rami Levy's catalog API | Catalog endpoint override, used by the tests |
| `GROCERY_DATA_DIR` | `<repo>/.data` locally, `/data/grocery` in Docker | Where `preferences.json` and `price-history.db` are kept |
| `GROCERY_PREFERENCES_FILE` | `$GROCERY_DATA_DIR/preferences.json` | Exact preferences file, used by the tests |
| `GROCERY_DATABASE_FILE` | `$GROCERY_DATA_DIR/grocery.db` | Exact database file, used by the tests |
| `GROCERY_MASTER_KEY` | unset | Master key for encrypted values, `1:<32 bytes base64>`; keep it only in the server's environment |
| `GROCERY_MASTER_KEYS_OLD` | unset | Retired master keys, comma-separated, still used to open older values |
| `GROCERY_OWNER_EMAIL` | unset | Email recorded on the owner, the first person in the database |
| `GROCERY_HISTORY_FILE` | `$GROCERY_DATA_DIR/price-history.db` | Price history file, used only when the database is unavailable, and by the tests |
| `GROCERY_PRICE_HISTORY` | on | `off` stops recording prices and hides `price_history` |
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
- `shufersal-search.test.js` covers cookie matching (domain, path, expiry, secure), the direct search against a local stand-in, raw result mapping, promotion parsing, Rami Levy branch stock, and falling back to the adapter.
- `accounts.test.js` covers token expiry, warning thresholds, which errors count as login failures, and live status checks for healthy, logged-out, failing and hung stores, where a hung or failing probe reports `unknown` and leaves no lasting warning. `http.test.js` also runs `account_status` and the warnings end to end, and runs the bridge with a stdio client, including exit on disconnect and an unreachable server.
- `preferences.test.js` and `order.test.js` cover preference storage, validation and resolution into baskets, and both stores' cart paths, including failures, refused products and dry runs.
- `basket.test.js` covers the cache (TTL, stale fallback, merged loads), the concurrency limiter, match selection, promotion pricing, basket totals and a failing store.
- `matching.test.js` replays live search results from both stores, saved on 2026-11-25 in `fixtures/catalog-2026-11-25.json`, through `compare_basket`. It checks the product-matching cases from the 0.6.1 QA review (GROC-001 to GROC-006): no veal for bananas or glassware for water, strict percentages, no unrequested variants, and no cheapest store or split total for items that are not like for like.
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
| `src/match.js` | Word matching shared by search and baskets: query terms, unit words, abbreviations, unrequested variants and choosing the best candidates |
| `src/accounts.js` | `account_status`, Rami Levy token expiry and remembered login failures |
| `src/bridge.js` | stdio-to-HTTP relay for clients such as Claude Desktop |
| `src/order.js` | `add_basket_to_cart`: one bulk add per store |
| `src/preferences.js` | Household preference store and its three tools |
| `src/db/` | Database: migrations, encryption vault, people and store accounts, preferences, audit log, and the import of older files |
| `src/history.js` | Price history: SQLite recording, `price_history` and the daily preference tracker |
| `src/version.js` | Version from `package.json`, and build info: commit, build date, image tag and upstream commits |
| `src/cache.js` | Search cache with stale fallback, and the per-store concurrency limiter |
| `src/normalize.js` | Converts each store's results to the shared shape, and parses sizes, prices, barcodes and promotions |
| `src/shufersal-search.js` | Direct Shufersal search with the adapter's saved session, read-only |
| `src/rami-catalog.js` | Client for Rami Levy's public catalog search |

`src/app.js` uses the SDK's low-level `Server` class instead of `McpServer`. Forwarded tools keep their JSON Schemas, which `McpServer`'s zod-based registration cannot take.

## Adding a store

1. Add the adapter under `upstream/` as a submodule.
2. Add a `STORE_DEFS` entry in `src/config.js`, with its label, tool prefix, entry point, search tool name, result limit and normalizer.
3. Write a normalizer in `src/normalize.js` and test it on real search output.
4. Add the store's build stage, its copy into the `grocery` image and its data volume in the root `Dockerfile` and `compose.yaml`. Then add its id to `SEARCH_TOOL`'s `stores` enum.
