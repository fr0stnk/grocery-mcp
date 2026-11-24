#!/usr/bin/env python3
"""Save Rami Levy session headers to .env from a browser's "Copy as cURL".

1. Log in at rami-levy.co.il and open DevTools > Network > Fetch/XHR.
2. Right-click a logged-in request to www.rami-levy.co.il or
   www-api.rami-levy.co.il, such as "cart", and choose Copy > Copy as cURL.
3. Run one of:
     python3 scripts/set_rami_levy_tokens.py                    # this checkout's .env
     python3 scripts/set_rami_levy_tokens.py --host my-server   # ~/grocery-mcp/.env over SSH

The script reads the clipboard, checks the tokens, and writes
RAMI_LEVY_BEARER_TOKEN, RAMI_LEVY_ECOM_TOKEN and RAMI_LEVY_USER_AGENT. It also
writes RAMI_LEVY_COOKIE when the request carries cookies. Over SSH the values
travel on stdin, never as command arguments. Afterwards the clipboard is
cleared. Token and cookie values are never printed.
"""
import argparse
import base64
import inspect
import json
import pathlib
import shlex
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse

HOSTS = {"www.rami-levy.co.il", "www-api.rami-levy.co.il"}
REPO_ENV = pathlib.Path(__file__).resolve().parent.parent / ".env"


def update_env_file(path, values):
    """Replace or add KEY='value' lines atomically, keeping every other line. Also runs on the remote host."""
    import os
    import pathlib
    import tempfile

    f = pathlib.Path(os.path.expanduser(path))
    f.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    old = f.read_text().splitlines() if f.exists() else []
    lines = [l for l in old if l.partition("=")[0].strip() not in values]
    lines += [f"{k}='{v}'" for k, v in values.items()]
    fd, tmp = tempfile.mkstemp(dir=f.parent, prefix=".env.")
    with os.fdopen(fd, "w") as out:
        out.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, f)
    return str(f)


def parse_curl(raw):
    raw = raw.replace("\\\r\n", " ").replace("\\\n", " ").strip()
    if not raw.startswith("curl"):
        raise ValueError("The input is not a cURL command. In DevTools use Copy > Copy as cURL.")
    args = shlex.split(raw)
    headers, url = {}, ""
    i = 1
    while i < len(args):
        a = args[i]
        if a in ("-H", "--header") and i + 1 < len(args):
            name, _, value = args[i + 1].partition(":")
            headers[name.strip().lower()] = value.strip()
            i += 2
            continue
        if a in ("-A", "--user-agent", "-b", "--cookie") and i + 1 < len(args):
            headers["user-agent" if a in ("-A", "--user-agent") else "cookie"] = args[i + 1]
            i += 2
            continue
        if not a.startswith("-") and "://" in a:
            url = a
        i += 1

    host = urlparse(url).hostname or ""
    if host not in HOSTS:
        raise ValueError(f"This cURL is for {host or 'an unknown host'}, not Rami Levy. Copy a request such as cart or orders.")

    bearer = headers.get("authorization", "")
    if bearer.lower().startswith("bearer "):
        bearer = bearer[7:].strip()
    values = {
        "RAMI_LEVY_BEARER_TOKEN": bearer,
        "RAMI_LEVY_ECOM_TOKEN": headers.get("ecomtoken", ""),
        "RAMI_LEVY_USER_AGENT": headers.get("user-agent", ""),
    }
    missing = [k for k, v in values.items() if not v]
    if missing:
        raise ValueError(f"Missing from the copied request: {', '.join(missing)}. Try another logged-in request.")
    if headers.get("cookie"):
        values["RAMI_LEVY_COOKIE"] = headers["cookie"]
    for key, v in values.items():
        # Values are written single-quoted so Compose reads them literally.
        if "\n" in v or "'" in v:
            raise ValueError(f"{key} contains a newline or single quote, which .env cannot store literally.")
    return values


def jwt_expiry(token):
    body = token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    return claims.get("exp")


def report(values):
    """Prints expiry times and cookie names only. Returns False if a token has expired."""
    expired = False
    for key, label in (("RAMI_LEVY_BEARER_TOKEN", "bearer token"), ("RAMI_LEVY_ECOM_TOKEN", "ecomtoken")):
        try:
            exp = jwt_expiry(values[key])
        except Exception:
            print(f"  {label:<15} opaque token, expiry unknown")
            continue
        if not exp:
            print(f"  {label:<15} JWT without expiry")
            continue
        when = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(exp))
        left = exp - time.time()
        expired |= left <= 0
        print(f"  {label:<15} JWT, {'EXPIRED at ' + when if left <= 0 else f'expires {when} (in {left / 3600:.1f} h)'}")
    print(f"  {'user agent':<15} {values['RAMI_LEVY_USER_AGENT']}")
    cookie = values.get("RAMI_LEVY_COOKIE")
    if cookie:
        names = [part.split("=", 1)[0].strip() for part in cookie.split(";") if part.strip()]
        print(f"  {'cookie':<15} {len(names)} cookies, cf_clearance {'present' if 'cf_clearance' in names else 'absent'}")
    else:
        print(f"  {'cookie':<15} none in this request; RAMI_LEVY_COOKIE is left unchanged")
    return not expired


CLIPBOARD = [
    (["pbpaste"], ["pbcopy"]),
    (["wl-paste", "--no-newline"], ["wl-copy", "--clear"]),
    (["xclip", "-selection", "clipboard", "-o"], ["xclip", "-selection", "clipboard", "-i"]),
    (["xsel", "--clipboard", "--output"], ["xsel", "--clipboard", "--clear"]),
]


def clipboard_tools():
    for paste, clear in CLIPBOARD:
        if shutil.which(paste[0]):
            return paste, clear
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", help="SSH host whose .env to update, for example a Raspberry Pi")
    ap.add_argument("--remote-env", default="~/grocery-mcp/.env", help="the .env path on --host (default: %(default)s)")
    ap.add_argument("--env-file", default=str(REPO_ENV), help="local .env to update when --host is not given (default: this checkout)")
    ap.add_argument("--from-file", metavar="PATH", help="read the cURL from PATH, or from stdin with -, instead of the clipboard")
    ap.add_argument("--dry-run", action="store_true", help="check the cURL only; write nothing and keep the clipboard")
    opts = ap.parse_args()

    paste, clear = clipboard_tools()
    if opts.from_file == "-":
        raw = sys.stdin.read()
    elif opts.from_file:
        raw = pathlib.Path(opts.from_file).read_text(encoding="utf-8")
    elif paste:
        raw = subprocess.run(paste, capture_output=True, text=True, check=True).stdout
    else:
        sys.exit("No clipboard tool found (pbpaste, wl-paste, xclip or xsel). Use --from-file PATH or --from-file - instead.")

    try:
        values = parse_curl(raw)
    except ValueError as error:
        sys.exit(str(error))
    if not report(values):
        sys.exit("A token has already expired. Reload the page and copy the request again.")
    if opts.dry_run:
        print("Dry run: nothing written.")
        return

    if opts.host:
        code = inspect.getsource(update_env_file) + (
            "\nimport json, sys\nprint(update_env_file(sys.argv[1], json.load(sys.stdin)))\n"
        )
        remote = f"python3 -c {shlex.quote(code)} {shlex.quote(opts.remote_env)}"
        done = subprocess.run(["ssh", "-T", opts.host, remote], input=json.dumps(values), capture_output=True, text=True)
        if done.returncode:
            sys.exit(f"Writing on {opts.host} failed: {done.stderr.strip()}")
        print(f"Saved {', '.join(values)} to {opts.host}:{done.stdout.strip()}")
    else:
        print(f"Saved {', '.join(values)} to {update_env_file(opts.env_file, values)}")

    if not opts.from_file and clear:
        subprocess.run(clear, input="", text=True, check=False)
        print("Clipboard cleared.")


if __name__ == "__main__":
    main()
