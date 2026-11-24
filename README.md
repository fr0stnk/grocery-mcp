# Grocery MCP

Grocery MCP is a project to bring Rami Levy and Shufersal shopping tools together in one self-hosted MCP server for Raspberry Pi. The repository currently pins the two retailer integrations. The unified server and Pi deployment are planned.

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

From the repository root, build the two adapters with `docker compose build`. The images use Node 22 and support a 64-bit Raspberry Pi. To build on another ARM64 machine and transfer the images to the Pi:

```sh
docker compose build
docker save grocery-mcp-rami-levy grocery-mcp-shufersal | ssh raspberrypi docker load
```

Use the same Compose file on the Pi. Supply Rami Levy's `RAMI_LEVY_BEARER_TOKEN`, `RAMI_LEVY_ECOM_TOKEN`, and `RAMI_LEVY_USER_AGENT` through the environment or a private root-level `.env` file. Set `RAMI_LEVY_STORE` for your branch and `RAMI_LEVY_COOKIE` if needed. See the [upstream setup](https://github.com/shaiu/rami-levy-mcp).

For Shufersal, import an exported desktop session from a file readable by the container user (UID 1000), or supply `SHUFERSAL_USERNAME` and `SHUFERSAL_PASSWORD` for upstream HTTP login. The import command expects an absolute path in `SESSION_FILE`. See the [session setup guide](https://github.com/digitalbastard103/shufersal-cart/blob/ff23409/docs/DEPLOYMENT.md).

```sh
docker compose run --rm -T -v "$SESSION_FILE:/tmp/session.json:ro" shufersal npm run session -- import /tmp/session.json
```

Configure your MCP client to launch one of these stdio commands from the checkout. Each client starts its adapter on demand. The named volumes preserve the Rami Levy basket and the Shufersal session and product choices between runs.

```sh
docker compose run --rm -T rami-levy
docker compose run --rm -T shufersal
```
