# ChatGPT through an OpenAI Secure MCP Tunnel

This folder connects Grocery MCP to ChatGPT without a public URL or an open port. Two containers run on the server:

```
ChatGPT ──▶ OpenAI tunnel service ◀── tunnel  (outbound HTTPS only, OpenAI's tunnel-client)
                                         │
                                         ▼
                                    grocery-http  (127.0.0.1:8791/mcp, Streamable HTTP)
```

- `grocery-http` is the combined server in HTTP mode. It listens on loopback only and runs continuously, so ChatGPT does not wait for the stores to start.
- `tunnel` runs OpenAI's `tunnel-client`, which connects out to OpenAI and passes ChatGPT's requests to `grocery-http`. Access is controlled by the tunnel's association with a ChatGPT account. See [Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Both services are defined in `../compose.tunnel.yaml`. Both have a read-only root filesystem, drop all capabilities, and use `no-new-privileges`.

## Files

| Path | In git | Contents |
|---|---|---|
| `README.md` | yes | This guide |
| `tunnel.yaml`, `extra.yaml` | no | Tunnel IDs and local addresses, written by `scripts/setup_openai_tunnel.py` |
| `secrets/openai-tunnel.key`, `secrets/extra.key` | no | Tunnel runtime API keys, mode `0600` |
| `runtime/tunnel-client` | no | The `tunnel-client` binary for the server's architecture |

## Setup

### 1. Create the tunnel and key, in the account that will use ChatGPT

A tunnel only appears in ChatGPT for the account or workspace it is associated with. For a personal ChatGPT account, use that account's own **Personal** organization on platform.openai.com.

1. Sign in to platform.openai.com as the ChatGPT user. Under **Settings → Tunnels**, create a tunnel and note its ID (`tunnel_…`).
2. Under **API keys**, create a **restricted** key with only **Tunnels: Read + Use**. Do not paste it into chats, issues or command lines.

### 2. Install tunnel-client

Download the official `tunnel-client` release for the server's platform, as linked from the Secure MCP Tunnels guide, for example linux-arm64 on a Raspberry Pi. Verify its SHA-256 against the published checksum. Then place the binary at `tunnel/runtime/tunnel-client`, readable and executable by UID 1000:

```sh
mkdir -p tunnel/runtime
install -m 0700 /path/to/tunnel-client tunnel/runtime/tunnel-client
tunnel/runtime/tunnel-client --version
```

### 3. Save the tunnel ID and key

Run this on the server. It asks for the ID, and then for the key with hidden input:

```sh
python3 scripts/setup_openai_tunnel.py
```

### 4. Start the services

Build or load the images first. The `tunnel` image is a small Debian image with CA certificates, and the binary is mounted into it.

```sh
docker compose -f compose.yaml -f compose.tunnel.yaml up -d grocery-http tunnel
curl -fsS http://127.0.0.1:8791/health   # grocery-http
curl -fsS http://127.0.0.1:8792/health   # tunnel-client
docker compose -f compose.yaml -f compose.tunnel.yaml logs --tail 50 tunnel
```

### 5. Add the server in ChatGPT

On chatgpt.com in a web browser, signed in as the same user:

1. Open **Plugins**, select **+** and then **Add custom MCP server**.
2. Enter a name, for example `Grocery`, and optionally upload `assets/grocery-mcp-256.png` as the icon. Under **Connection** choose **Tunnel**, then pick the tunnel or paste its ID.
3. Set **Authentication** to **No authentication**. The tunnel's account association controls who can reach it.
4. Confirm the warning and create the plugin. Then install it and use it in a chat by typing `@` and choosing it.

ChatGPT asks for confirmation before any tool that is not marked read-only, such as cart changes. Searches and other reads run without asking.

## A second ChatGPT account

A tunnel is visible only to the workspaces it is associated with. To give another ChatGPT account access, such as a personal account outside your workspace, create a separate tunnel and key in that account's Platform organization, as in step 1. Then serve it with the optional `tunnel-extra` service, which uses the same `grocery-http`:

```sh
python3 scripts/setup_openai_tunnel.py --name extra     # writes tunnel/extra.yaml and tunnel/secrets/extra.key
docker compose -f compose.yaml -f compose.tunnel.yaml --profile extra up -d tunnel-extra
curl -fsS http://127.0.0.1:8793/readyz
```

That account then adds the plugin as in step 5, with its own tunnel ID. Both accounts use the same store logins, so they share carts.

## Operation

- To use the tools read-only, set `GROCERY_READ_ONLY=1` in `.env` and recreate `grocery-http`. Write tools are then hidden and refused.
- To revoke access, delete the key or the tunnel on platform.openai.com, or stop the `tunnel` service.
- The tunnel limits each request to 120 seconds and 10 MiB.
- After a reboot, each tunnel waits up to 180 seconds (`MCP_STARTUP_WAIT_TIMEOUT`) for `grocery-http` to start listening. Without that wait, `tunnel-client` reports `startup catalog failed; control-plane polling disabled` and stays offline until restarted. If it does, run `curl http://127.0.0.1:8792/readyz` to see the state, then restart the tunnel.
- `grocery-http` and the on-demand `grocery` service share the same data volumes. Avoid running cart changes through both at the same moment.
