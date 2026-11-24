# Scripts

These are helper scripts for setting up Grocery MCP. Run them from the repository root. They need only Python 3 and its standard library.

| Script | Purpose |
|---|---|
| [`set_rami_levy_tokens.py`](set_rami_levy_tokens.py) | Saves Rami Levy session headers and cookie into `.env`, from a browser's **Copy as cURL** |

## `set_rami_levy_tokens.py`

Rami Levy has no password login for the server. It uses the session headers of a logged-in browser instead. This script takes them from one copied request, so you never paste tokens by hand.

### Use

1. Log in at rami-levy.co.il, then open DevTools → **Network** → **Fetch/XHR** and reload.
2. Right-click a logged-in request to `www.rami-levy.co.il` or `www-api.rami-levy.co.il`, such as `cart`, and choose **Copy → Copy as cURL**. On Windows, choose the bash variant.
3. Run one of:

```sh
python3 scripts/set_rami_levy_tokens.py                    # updates .env in this checkout
python3 scripts/set_rami_levy_tokens.py --host my-server   # updates ~/grocery-mcp/.env on my-server over SSH
```

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
| `--dry-run` | Check and report only. Nothing is written and the clipboard is kept. |

### Checks and safety

- It refuses a request for any host other than Rami Levy, a request without all three headers, and a token whose JWT expiry has passed.
- It refuses values with a newline or a single quote, which `.env` cannot hold literally.
- It prints only token expiry times, the User-Agent and cookie names, never token or cookie values.
- Over SSH the values travel as JSON on stdin, never as command arguments, so they do not appear in the remote process list. The remote host needs `python3`.
- It clears the clipboard after a successful write. Supported clipboards are macOS (`pbpaste`), Wayland (`wl-paste`) and X11 (`xclip` or `xsel`). Elsewhere, use `--from-file`.

The tokens and cookie expire. Run the script again when the server reports `auth_expired` or `blocked_by_cloudflare`. The root README's [Credentials](../README.md#credentials) section explains each value, including `cf_clearance`'s binding to the browser's IP address and User-Agent.
