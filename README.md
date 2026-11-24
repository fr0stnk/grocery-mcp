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

- `search_all_stores` searches both stores at once. Results are sorted by price per liter or kilogram, then by price, and each store's status is reported. If one store fails, the other store's results are still returned. Products are not matched across stores, because the Rami Levy integration does not return barcodes.
- Each store's own tools are forwarded with a store prefix, such as `shufersal_view_cart` and `rami_levy_add_item`. Carts are separate per store, and no tool checks out or pays.

A store that cannot start, for example because its credentials are missing, is reported in search results. The other store keeps working. To run only one store, set `GROCERY_STORES` to `shufersal` or `rami-levy`.

To use a single store's server without the combined server, run `docker compose run --rm -T rami-levy` or `docker compose run --rm -T shufersal`.

## Repository layout

| Path | Contents |
|---|---|
| [`server/`](server/README.md) | The combined MCP server: how it works, configuration, local runs and tests |
| [`scripts/`](scripts/README.md) | Setup helpers, such as saving Rami Levy tokens into `.env` |
| `upstream/` | The pinned Rami Levy and Shufersal integrations, as git submodules |
| [`assets/`](assets/README.md) | The server icon, as SVG and as a 256 px PNG for ChatGPT |
| [`tunnel/`](tunnel/README.md) | Connecting ChatGPT through an OpenAI Secure MCP Tunnel, with no public URL |
| `Dockerfile`, `compose.yaml` | Images and services for `grocery`, `rami-levy` and `shufersal` |
| `compose.tunnel.yaml` | Optional `grocery-http` and `tunnel` services for ChatGPT |
| `.env.example` | Every credential and setting, with placeholders |
