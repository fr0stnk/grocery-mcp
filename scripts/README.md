# Scripts

These are helper scripts for setting up Grocery MCP. Run them from the repository root. They need only Python 3.10 or newer and its standard library.

Their tests are in `tests/` and use only `unittest`. They never touch the clipboard, SSH or real files outside a temporary folder. Run them with:

```sh
python3 -m unittest discover -s scripts/tests -v
```

| Script | Purpose |
|---|---|
| [`set_rami_levy_tokens.py`](set_rami_levy_tokens.py) | Saves Rami Levy session headers and cookie into `.env`, from a browser's **Copy as cURL** |
| [`setup_openai_tunnel.py`](setup_openai_tunnel.py) | Saves the OpenAI tunnel ID and runtime key for the ChatGPT connection. Run it on the server. |
| [`setup_deploy.py`](setup_deploy.py) | One-time setup for automatic deployment: GitHub environment, restricted deploy key, host key and credential copy. Run it from your computer. |
| [`deploy_receiver.py`](deploy_receiver.py) | Applies a deployment on the server. It is the only command the deploy key may run. Python 3.8 compatible. |

## `set_rami_levy_tokens.py`

Rami Levy has no password login for the server. It uses the session headers of a logged-in browser instead. This script takes them from one copied request, so you never paste tokens by hand.

### Use

1. Log in at rami-levy.co.il, then open DevTools → **Network** → **Fetch/XHR** and reload.
2. Right-click a logged-in request to `www.rami-levy.co.il` or `www-api.rami-levy.co.il`, such as `cart`, and choose **Copy → Copy as cURL**. On Windows, choose the bash variant.
3. Run one of:

```sh
python3 scripts/set_rami_levy_tokens.py                    # updates .env in this checkout
python3 scripts/set_rami_levy_tokens.py --host my-server   # updates ~/grocery-mcp/.env on my-server over SSH
python3 scripts/set_rami_levy_tokens.py --github           # stores them as GitHub secrets and starts the Deploy workflow
```

Use `--github` once [automatic deployment](../README.md#automatic-deployment) is set up. The GitHub environment is then the source of truth, and a deploy would overwrite tokens written directly on the server.

Example output:

```
  bearer token    opaque token, expiry unknown
  ecomtoken       JWT, expires 2027-01-23 23:17 IST (in 1439.9 h)
  user agent      Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36
  cookie          12 cookies, cf_clearance present
Saved RAMI_LEVY_BEARER_TOKEN, RAMI_LEVY_ECOM_TOKEN, RAMI_LEVY_USER_AGENT, RAMI_LEVY_COOKIE to my-server:/home/me/grocery-mcp/.env
Clipboard cleared.
```

### What it writes

| `.env` variable | Taken from |
|---|---|
| `RAMI_LEVY_BEARER_TOKEN` | the `authorization` header, without `Bearer ` |
| `RAMI_LEVY_ECOM_TOKEN` | the `ecomtoken` header |
| `RAMI_LEVY_USER_AGENT` | the `user-agent` header |
| `RAMI_LEVY_COOKIE` | the `-b` argument or `cookie` header. Written only when the request has cookies, and otherwise left unchanged. |

- Only these lines are replaced. Everything else in `.env` stays as it is, including the Shufersal login and `RAMI_LEVY_STORE`.
- Values are written single-quoted, so Docker Compose reads them literally.
- The file is replaced atomically with mode `0600`. It is created if missing.

### Options

| Option | Meaning |
|---|---|
| `--host HOST` | Update the `.env` on an SSH host instead of locally |
| `--remote-env PATH` | The `.env` path on `--host` (default `~/grocery-mcp/.env`) |
| `--env-file PATH` | The local `.env` to update (default: the repository root's `.env`) |
| `--from-file PATH` | Read the cURL from a file, or from stdin with `-`, instead of the clipboard |
| `--github [ENV]` | Store the values as secrets in a GitHub environment (default `production`) through `gh`, then start the Deploy workflow |
| `--no-deploy` | With `--github`, only store the secrets |
| `--dry-run` | Check and report only. Nothing is written and the clipboard is kept. |

### Checks and safety

- It refuses a request for any host other than Rami Levy, a request without all three headers, and a token whose JWT expiry has passed.
- It refuses values with a newline or a single quote, which `.env` cannot hold literally.
- It prints only token expiry times, the User-Agent and cookie names, never token or cookie values.
- Over SSH the values travel as JSON on stdin, never as command arguments, so they do not appear in the remote process list. The remote host needs `python3`.
- It clears the clipboard after a successful write. Supported clipboards are macOS (`pbpaste`), Wayland (`wl-paste`) and X11 (`xclip` or `xsel`). Elsewhere, use `--from-file`.

The tokens and cookie expire. Run the script again when the server reports `auth_expired` or `blocked_by_cloudflare`. The root README's [Credentials](../README.md#credentials) section explains each value, including `cf_clearance`'s binding to the browser's IP address and User-Agent.

## `setup_openai_tunnel.py`

This script configures the [ChatGPT tunnel](../tunnel/README.md). Run it on the server that runs `grocery-http`, from the repository root:

```sh
python3 scripts/setup_openai_tunnel.py
```

It asks for the tunnel ID, which is visible, and then the restricted runtime key (**Tunnels: Read + Use**), which is hidden. It writes:

- `tunnel/tunnel.yaml`, which holds the tunnel ID, the MCP URL `http://127.0.0.1:8791/mcp` and the health address `127.0.0.1:8792`. The config refers to the key by file path and does not contain it.
- `tunnel/secrets/openai-tunnel.key`, mode `0600`, in a `0700` folder.

Both are ignored by git. The script refuses a tunnel ID or key that does not look valid. The key is never printed or passed as an argument.

| Option | Meaning |
|---|---|
| `--mcp-url URL` | The MCP endpoint the tunnel forwards to (default `http://127.0.0.1:8791/mcp`) |
| `--health ADDR` | tunnel-client's health and admin address (default `127.0.0.1:8792`) |
| `--name NAME` | Write `tunnel/NAME.yaml` and `tunnel/secrets/NAME.key`. Use `extra` for the optional `tunnel-extra` service, which serves a second ChatGPT account. The health address defaults to `127.0.0.1:8793`. |
| `--keep-key` | Only rewrite the tunnel config, for example for a new tunnel ID, and keep the saved key |

## `setup_deploy.py` and `deploy_receiver.py`

These two scripts set up and carry out [automatic deployment](../README.md#automatic-deployment).

`setup_deploy.py` runs once from your computer:

```sh
python3 scripts/setup_deploy.py --host <ssh-host> --deploy-host <server-tailnet-ip>
```

1. It creates the GitHub environment `production` and limits it to `main`.
2. It generates an ed25519 key and installs its public half on the server as `restrict,command="python3 <checkout>/scripts/deploy_receiver.py" … grocery-mcp-deploy`, replacing any earlier deploy key. The private half becomes the `DEPLOY_SSH_KEY` secret, and the local copy is deleted.
3. It stores the server's tailnet address, user and ed25519 host key as variables, so the workflow can verify the server.
4. It reads the server's `.env` and tunnel files over SSH and stores them as secrets and variables through `gh` on stdin. Values are never printed or passed as arguments.

| Option | Meaning |
|---|---|
| `--checkout PATH` | The repository checkout on the server (default `~/grocery-mcp`) |
| `--repo OWNER/NAME`, `--environment NAME` | Target repository and environment (defaults: this checkout's repository and `production`) |
| `--skip-key`, `--skip-credentials` | Keep the current deploy key, or skip copying credentials |

`deploy_receiver.py` runs on the server for each deploy. It refuses releases that do not contain the receiver itself, such as v0.1.0, because the deploy key runs it from the checkout. It accepts only a release tag, known setting names and the `main` or `extra` tunnel, and it rejects requests over 64 KiB. Each deploy goes like this:

1. It backs up `.env` and the tunnel files, then writes the new values together with `GROCERY_IMAGE_TAG`.
2. It checks out the tag and its submodules.
3. It pulls that version's images and restarts `grocery-http` and the configured tunnels.
4. It waits up to 4 minutes for `/health` and each tunnel's `/readyz`.

On any failure it restores the backups and the previous commit and restarts the services. It never prints secret values. Its tests stub git and Docker.
