# Deploy

Files for running Grocery MCP's public, signed-in URL on your own server. Nothing here is used by the default setup: the tunnels and the bridge need none of it.

| File | What it is |
|---|---|
| `nginx/grocery.conf.example` | nginx reverse proxy with TLS for two hosts: `grocery.example.com`, which serves only `/mcp`, `/.well-known/oauth-protected-resource*` and `/health` from the public listener on `127.0.0.1:8796` and returns 404 for everything else; and `id.example.com`, which serves Pocket ID on `127.0.0.1:1411`. |

The sign-in service itself is the `pocket-id` service in `../compose.tunnel.yaml`, under the `auth` profile:

- It is pinned by digest to `ghcr.io/fr0stnk/pocket-id:v2.19.3-cimd1`: Pocket ID v2.19.3 plus the upstream fix [69d2310](https://github.com/pocket-id/pocket-id/commit/69d2310633), built from source in the [fr0stnk/pocket-id](https://github.com/fr0stnk/pocket-id/tree/fr0stnk/v2.19.3-cimd1) fork. v2.19.3 refuses a client ID metadata document whose preferred token auth method is not `none`, even when it lists `none` as supported, which is how ChatGPT's reads, so ChatGPT could not connect without a pre-registered client. The image is distroless and runs as the same non-root user (65532) as the official one, with a read-only filesystem, no capabilities and `no-new-privileges`. Switch back to `ghcr.io/pocket-id/pocket-id` once a v2 release includes the fix.
- It uses host networking bound to `127.0.0.1:1411`, so it is reachable only through the proxy.
- If nginx runs in a Docker bridge container, loopback on the host is out of its reach. Bind both listeners to the bridge's gateway instead (`POCKET_ID_HOST`, and the host part of `GROCERY_PUBLIC_HTTP`), set `POCKET_ID_TRUST_PROXY` to the bridge subnet, and point the example's `proxy_pass` lines at that gateway. `docker network inspect <network>` shows both.
- Its database and uploads live in the `pocket-id-data` volume. Back that volume up together with `.env`: `POCKET_ID_ENCRYPTION_KEY` is needed to read it.

Follow the step-by-step checklist in [`../server/README.md`](../server/README.md#deploying-sign-in), from DNS and certificates to the first connector. Replace `example.com` with your domain everywhere. Keep real domains and addresses out of the committed files.

Before enabling the profile, check the files with:

```sh
docker compose -f compose.yaml -f compose.tunnel.yaml --profile auth config -q
sudo nginx -t
```
