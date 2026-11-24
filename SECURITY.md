# Security policy

Grocery MCP holds live sessions for real supermarket accounts and can change their carts. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's **[Report a vulnerability](https://github.com/fr0stnk/grocery-mcp/security/advisories/new)** form, under the repository's Security tab. Do not open a public issue for a vulnerability. Include steps to reproduce and the affected commit. You should get a reply within a week.

Only the latest commit on `main` is supported.

## Scope

In scope:

- Code in this repository: `server/`, `scripts/`, the `Dockerfile` and the compose files.
- Ways the server could leak credentials, sessions or account data, or change carts without a client request.
- The HTTP mode's Host check and loopback binding, and how the tunnel setup handles keys.
- The deployment path: `deploy.yml`, the deploy key's restriction and `deploy_receiver.py`'s validation.

Problems in the pinned store integrations under `upstream/` belong to their own repositories: [rami-levy-mcp](https://github.com/shaiu/rami-levy-mcp) and [shufersal-cart](https://github.com/digitalbastard103/shufersal-cart).

## Deployment guidance

- Keep `.env`, `tunnel/secrets/` and the data volumes private. They hold store passwords, session tokens and API keys.
- HTTP mode has no authentication of its own. Bind it to loopback, which is the default, and reach it only through an access-controlled path such as an OpenAI Secure MCP Tunnel or SSH. Never publish it on a public port.
- Give tunnel runtime keys only the **Tunnels: Read + Use** permissions.
- For automatic deployment, keep the deploy key's `restrict,command=` line as `setup_deploy.py` writes it. Allow `tag:ci` in Tailscale to reach only the server's SSH port, and keep the `production` environment limited to `main`.
- Set `GROCERY_READ_ONLY=1` for clients that should not change carts.
- No tool checks out or pays. Orders are completed on the store's own site or app.
