#!/usr/bin/env python3
"""Configure the OpenAI Secure MCP Tunnel for Grocery MCP. Run it on the server.

Prompts for the tunnel ID and for the tunnel runtime API key (hidden input),
then writes:
  tunnel/tunnel.yaml                 tunnel ID and local addresses (mode 0600)
  tunnel/secrets/openai-tunnel.key   the runtime key (mode 0600, folder 0700)
Both are ignored by git. The key is never printed or passed as an argument.

Create the tunnel and a restricted key (Tunnels: Read + Use) in the OpenAI
Platform organization of the ChatGPT account that will use it. See
tunnel/README.md.
"""
import argparse
import getpass
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TUNNEL_DIR = ROOT / "tunnel"

CONFIG = """\
config_version: 1
control_plane:
  base_url: https://api.openai.com
  tunnel_id: {tunnel_id}
  api_key: file:/run/secrets/openai-tunnel.key
health:
  listen_addr: {health}
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  server_urls:
    - channel: main
      url: {mcp_url}
"""


def write_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path.with_suffix(path.suffix + ".tmp"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as out:
        os.fchmod(out.fileno(), 0o600)
        out.write(text)
    os.replace(path.with_suffix(path.suffix + ".tmp"), path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mcp-url", default="http://127.0.0.1:8791/mcp", help="the grocery-http endpoint (default: %(default)s)")
    ap.add_argument("--health", default="127.0.0.1:8792", help="tunnel-client health and admin address (default: %(default)s)")
    ap.add_argument("--keep-key", action="store_true", help="only rewrite tunnel.yaml and keep the saved key")
    opts = ap.parse_args()

    tunnel_id = input("Tunnel ID (tunnel_...): ").strip()
    if not re.fullmatch(r"tunnel_[A-Za-z0-9]+", tunnel_id):
        sys.exit("That does not look like a tunnel ID (tunnel_ followed by letters and digits). Nothing saved.")

    key_path = TUNNEL_DIR / "secrets" / "openai-tunnel.key"
    if not opts.keep_key:
        key = getpass.getpass("Tunnel runtime API key (input hidden): ").strip()
        if not key.startswith("sk-") or any(c.isspace() for c in key):
            sys.exit("Expected an OpenAI key starting with sk- and without spaces. Nothing saved.")
        write_private(key_path, key + "\n")
        os.chmod(key_path.parent, 0o700)
    elif not key_path.exists():
        sys.exit(f"--keep-key given but {key_path} does not exist.")

    write_private(TUNNEL_DIR / "tunnel.yaml", CONFIG.format(tunnel_id=tunnel_id, health=opts.health, mcp_url=opts.mcp_url))
    print(f"Saved {TUNNEL_DIR / 'tunnel.yaml'} and {key_path} (mode 0600). The key was not printed.")
    binary = TUNNEL_DIR / "runtime" / "tunnel-client"
    if not binary.exists():
        print(f"Still needed: the tunnel-client binary at {binary}. See tunnel/README.md.")


if __name__ == "__main__":
    main()
