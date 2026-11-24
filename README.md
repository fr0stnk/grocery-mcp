# Grocery MCP

[![Tests](https://github.com/fr0stnk/grocery-mcp/actions/workflows/tests.yml/badge.svg)](https://github.com/fr0stnk/grocery-mcp/actions/workflows/tests.yml)
[![Images](https://github.com/fr0stnk/grocery-mcp/actions/workflows/images.yml/badge.svg)](https://github.com/fr0stnk/grocery-mcp/actions/workflows/images.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22.13+](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](server/package.json)
[![Images: amd64 and arm64](https://img.shields.io/badge/images-amd64%20%7C%20arm64-informational.svg)](https://github.com/fr0stnk?tab=packages&repo_name=grocery-mcp)

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

Prebuilt images for `linux/amd64` and `linux/arm64`, such as a Raspberry Pi, are published to GitHub Container Registry. From the repository root, pull them:

```sh
docker compose pull
```

To build locally instead, run `docker compose build`. The containers use Node 22.

Then create your private `.env` from the example and fill it in as described in [Credentials](#credentials):

```sh
cp .env.example .env
chmod 600 .env
```

Configure your MCP client to launch the combined server from the checkout. The client starts it on demand over stdio, and it exits when the client disconnects.

```sh
docker compose run --rm -T grocery
```

The named volumes preserve the Rami Levy basket and the Shufersal session and product choices between runs. The combined server and the single-store services share the same volumes.

## Credentials

Docker Compose reads `.env` from the repository root, and git ignores it. Wrap each value in single quotes. Compose then keeps characters such as `$`, `!`, `#` and spaces exactly as written. A value itself cannot contain a single quote.

### Shufersal

Set `SHUFERSAL_USERNAME` to the email you use on shufersal.co.il and `SHUFERSAL_PASSWORD` to your password. Copy the password from your password manager rather than retyping it. The server signs in with them when it has no saved session, and it keeps the session in the `shufersal-data` volume.

Instead of storing a password, you can import an exported desktop session. Put it in a file readable by the container user (UID 1000) and set `SESSION_FILE` to its absolute path. See the [session setup guide](https://github.com/digitalbastard103/shufersal-cart/blob/ff23409/docs/DEPLOYMENT.md).

```sh
docker compose run --rm -T -v "$SESSION_FILE:/tmp/session.json:ro" shufersal npm run session -- import /tmp/session.json
```

### Rami Levy tokens

Rami Levy is accessed with session headers captured from a logged-in browser, not with a password:

1. Log in at rami-levy.co.il.
2. Open DevTools, go to **Network**, select **Fetch/XHR**, and reload the page.
3. Select a logged-in request, such as `cart` or `orders`, and look at its **Request Headers**.
4. Copy each value into `.env`:

| Request header | `.env` variable |
|---|---|
| `authorization: Bearer <token>` | `RAMI_LEVY_BEARER_TOKEN`, without the `Bearer ` prefix |
| `ecomtoken: <jwt>` | `RAMI_LEVY_ECOM_TOKEN` |
| `user-agent: <browser>` | `RAMI_LEVY_USER_AGENT`, from the same browser as the tokens |

Instead of copying the values by hand, right-click the request, choose **Copy → Copy as cURL**, and run the helper script. It reads the clipboard, shows only token expiry times and cookie names, and writes the Rami Levy values into `.env`. It updates `RAMI_LEVY_COOKIE` as well when the request carries cookies. Other lines in `.env` stay as they are, and the clipboard is cleared afterwards.

```sh
python3 scripts/set_rami_levy_tokens.py                   # .env in this checkout
python3 scripts/set_rami_levy_tokens.py --host my-server  # ~/grocery-mcp/.env on a server, over SSH
```

The script supports macOS and the common Linux clipboard tools. Use `--from-file PATH`, or `--from-file -` for stdin, to read the cURL from elsewhere. Add `--dry-run` to only check it.

Set `RAMI_LEVY_STORE` to your delivery branch. The site's own requests show it, for example `menu?store=<id>`. Prices and stock come from that branch, and the default is `412`. The tokens expire. When the server reports `auth_expired`, capture them again.

### Rami Levy cookie

`RAMI_LEVY_COOKIE` is optional. When it is set, the server sends it as the `Cookie` header on every Rami Levy request. Its main use is getting past Cloudflare when the server reports `blocked_by_cloudflare`. The Cloudflare cookie that matters is `cf_clearance`.

To get it, take the same logged-in request from the token steps. In its **Request Headers**, copy the whole value of the `cookie` header, which is a list of `name=value` pairs separated by `; `. The helper script above does this for you from a **Copy as cURL**. To set it by hand, put it in `.env`:

```sh
RAMI_LEVY_COOKIE='cf_clearance=AbC...; _ga=GA1.1...; other=value'
```

- `cf_clearance` only works for the public IP address and User-Agent that solved Cloudflare's check. Capture it on a browser that uses the same internet connection as the server, and set `RAMI_LEVY_USER_AGENT` from that same browser.
- It expires within hours to a few days. An expired cookie can itself cause `blocked_by_cloudflare`, so capture it again then, or set `RAMI_LEVY_COOKIE=''` to send no cookie.
- When the server's connection is not challenged, leave it empty.

## Connect an MCP client

- **Local clients**, such as Claude Desktop, Claude Code and Codex, launch `docker compose run --rm -T grocery` as a stdio command. To reach a server on another machine, run it over `ssh -T <host> 'cd <checkout> && docker compose run --rm -T grocery'`. For Claude Desktop, add that command under `mcpServers` in `claude_desktop_config.json`.
- **ChatGPT** connects through an OpenAI Secure MCP Tunnel to the `grocery-http` service, without exposing a port. See [`tunnel/README.md`](tunnel/README.md).
- Set `GROCERY_READ_ONLY=1` to offer only searches and read tools.

## Tools

- `search_all_stores` searches both stores at once. Results are sorted by price per liter or kilogram, then by price, and each store's status is reported. If one store fails, the other store's results are still returned. Products with the same barcode in both stores are paired, with the cheaper store named. Rami Levy promotions, such as multi-buy offers, are included.
- `compare_basket` prices a whole shopping list in both stores. It prefers identical products by barcode and applies Rami Levy multi-buy promotions. It returns each store's total and missing items, a fair comparison over items both stores have, and the total if the order is split. Searches are cached for 15 minutes, and recent prices are used if a store is briefly unavailable.
- Each store's own tools are forwarded with a store prefix, such as `shufersal_view_cart` and `rami_levy_add_item`. Carts are separate per store, and no tool checks out or pays.

A store that cannot start, for example because its credentials are missing, is reported in search results. The other store keeps working. To run only one store, set `GROCERY_STORES` to `shufersal` or `rami-levy`.

To use a single store's server without the combined server, run `docker compose run --rm -T rami-levy` or `docker compose run --rm -T shufersal`.

## Images and CI

[`.github/workflows/tests.yml`](.github/workflows/tests.yml) runs on pushes and pull requests that change `server/` or `scripts/`, excluding Markdown. It has two jobs:

- **Server:** ESLint, then the tests with coverage thresholds. The coverage table goes to the run summary.
- **Scripts:** the helper scripts' unit tests on Python 3.10 to 3.13.

[`.github/workflows/images.yml`](.github/workflows/images.yml) runs on pushes and pull requests that change the `Dockerfile`, `.dockerignore`, the server code, the pinned integrations or the workflow itself. Documentation, compose files and scripts do not trigger a build. Version tags and manual runs always do. Each run:

1. It runs the server tests.
2. It builds the `grocery`, `rami-levy`, `shufersal` and `tunnel` images for amd64 and arm64.

Pushes to `main` publish the images as `ghcr.io/fr0stnk/grocery-mcp-<image>`, tagged `latest` and `sha-<commit>`. `v*` tags also publish a version tag. Pull requests only test and build.

The compose files use these images by default. `GROCERY_IMAGE_TAG` pins a tag, for example `sha-1a2b3c4`. `GROCERY_IMAGE_PREFIX` points to another registry or to local names.

To update a server:

```sh
git pull --ff-only && git submodule update --init --recursive
docker compose pull          # add -f compose.tunnel.yaml for grocery-http and tunnel
docker compose up -d         # only for long-running services such as grocery-http
```

## Repository layout

| Path | Contents |
|---|---|
| [`server/`](server/README.md) | The combined MCP server: how it works, configuration, local runs and tests |
| [`scripts/`](scripts/README.md) | Setup helpers, such as saving Rami Levy tokens into `.env` |
| `upstream/` | The pinned Rami Levy and Shufersal integrations, as git submodules |
| [`assets/`](assets/README.md) | The server icon, as SVG and as a 256 px PNG for ChatGPT |
| [`tunnel/`](tunnel/README.md) | Connecting ChatGPT through an OpenAI Secure MCP Tunnel, with no public URL |
| `Dockerfile`, `compose.yaml` | Images and services for `grocery`, `rami-levy` and `shufersal` |
| `.github/workflows/` | Tests, and multi-platform image publishing |
| `compose.tunnel.yaml` | Optional `grocery-http` and `tunnel` services for ChatGPT |
| `.env.example` | Every credential and setting, with placeholders |
| [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md) | Development setup and checks, and how to report vulnerabilities |

## License

[MIT](LICENSE). The pinned [Rami Levy](https://github.com/shaiu/rami-levy-mcp) and [Shufersal](https://github.com/digitalbastard103/shufersal-cart) integrations are MIT-licensed by their own authors.
