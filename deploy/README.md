# Deploy

Files for running Grocery MCP's public, signed-in URL on your own server. Nothing here is used by the default setup: the tunnels and the bridge need none of it.

| File | What it is |
|---|---|
| `nginx/grocery.conf.example` | nginx reverse proxy with TLS for two hosts: `grocery.example.com`, which serves only `/mcp`, `/.well-known/oauth-protected-resource*` and `/health` from the public listener on `127.0.0.1:8796` and returns 404 for everything else; and `id.example.com`, which serves Pocket ID on `127.0.0.1:1411`. |

The sign-in service itself is the `pocket-id` service in `../compose.tunnel.yaml`, under the `auth` profile:

- It is pinned to `ghcr.io/pocket-id/pocket-id:v2.19.3-distroless` by digest, and runs as Pocket ID's own non-root user with a read-only filesystem, no capabilities and `no-new-privileges`.
- It uses host networking bound to `127.0.0.1:1411`, so it is reachable only through the proxy.
- Its database and uploads live in the `pocket-id-data` volume. Back that volume up together with `.env`: `POCKET_ID_ENCRYPTION_KEY` is needed to read it.

Follow the step-by-step checklist in [`../server/README.md`](../server/README.md#deploying-sign-in), from DNS and certificates to the first connector. Replace `example.com` with your domain everywhere. Keep real domains and addresses out of the committed files.

Before enabling the profile, check the files with:

```sh
docker compose -f compose.yaml -f compose.tunnel.yaml --profile auth config -q
sudo nginx -t
```
