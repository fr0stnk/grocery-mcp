# Grocery MCP

Grocery MCP brings Rami Levy and Shufersal shopping tools together in one self-hosted MCP server. It runs both pinned retailer integrations as child processes, adds a price search across both stores, and forwards each store's own tools. You can run it on a host with Docker and Docker Compose.

## Retailer integrations

- [Rami Levy](https://github.com/shaiu/rami-levy-mcp) lives in `upstream/rami-levy-mcp`.
- [Shufersal](https://github.com/digitalbastard103/shufersal-cart) lives in `upstream/shufersal-cart`.

## Clone with both integrations

```sh
git clone --recurse-submodules https://github.com/fr0stnk/grocery-mcp
cd grocery-mcp
```

For an existing clone, run `git submodule update --init --recursive` from the repository root to check out the pinned revisions.

## Run with Docker Compose

From the repository root, build the images on your Docker host. The containers use Node 22.

```sh
docker compose build
```

Supply Rami Levy's `RAMI_LEVY_BEARER_TOKEN`, `RAMI_LEVY_ECOM_TOKEN`, and `RAMI_LEVY_USER_AGENT` through the environment or a private root-level `.env` file. Set `RAMI_LEVY_STORE` for your branch and `RAMI_LEVY_COOKIE` if needed. See the [upstream setup](https://github.com/shaiu/rami-levy-mcp).

For Shufersal, import an exported desktop session from a file readable by the container user (UID 1000), or supply `SHUFERSAL_USERNAME` and `SHUFERSAL_PASSWORD` for upstream HTTP login. The import command expects an absolute path in `SESSION_FILE`. See the [session setup guide](https://github.com/digitalbastard103/shufersal-cart/blob/ff23409/docs/DEPLOYMENT.md).

```sh
docker compose run --rm -T -v "$SESSION_FILE:/tmp/session.json:ro" shufersal npm run session -- import /tmp/session.json
```

Configure your MCP client to launch the combined server from the checkout. The client starts it on demand over stdio, and it exits when the client disconnects.

```sh
docker compose run --rm -T grocery
```

The named volumes preserve the Rami Levy basket and the Shufersal session and product choices between runs. The combined server and the single-store services share the same volumes.

## Tools

- `search_all_stores` searches both stores at once. Results are sorted by price per liter or kilogram, then by price, and each store's status is reported. If one store fails, the other store's results are still returned. Products are not matched across stores, because the Rami Levy integration does not return barcodes.
- Each store's own tools are forwarded with a store prefix, such as `shufersal_view_cart` and `rami_levy_add_item`. Carts are separate per store, and no tool checks out or pays.

A store that cannot start, for example because its credentials are missing, is reported in search results. The other store keeps working. To run only one store, set `GROCERY_STORES` to `shufersal` or `rami-levy`.

To use a single store's server without the combined server, run `docker compose run --rm -T rami-levy` or `docker compose run --rm -T shufersal`.

## Development

The combined server lives in `server/` and needs Node 22.13 or newer. Run its tests from that folder:

```sh
npm ci
npm test
```

The tests use stand-in adapters, so they need no credentials or network access.
