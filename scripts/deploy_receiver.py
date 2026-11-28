#!/usr/bin/env python3
"""Apply a deployment sent by GitHub Actions. Runs on the server.

This script is the forced command of the deploy SSH key (see
scripts/setup_deploy.py), so the key can do nothing else. It reads one JSON
request from stdin:

  {"ref": "v0.1.0",
   "env": {"SHUFERSAL_PASSWORD": "...", ...},
   "tunnels": {"main": {"id": "tunnel_...", "key": "sk-..."}, "extra": {...}}}

and then:
  0. refuses releases that do not contain this script,
  1. backs up .env and the tunnel files it will change,
  2. writes the given settings, plus GROCERY_IMAGE_TAG for the release,
  3. checks out the release tag and its submodules,
  4. pulls that release's images and restarts grocery-http and the tunnels,
     and pocket-id once it has been started by hand (profile auth),
  5. waits until the server and every tunnel report ready.
If steps 3 to 5 fail, it restores the backups and the previous commit and
restarts the services on them. Secret values are never printed.

Compatible with Python 3.8.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from setup_openai_tunnel import CONFIG as TUNNEL_CONFIG, write_private  # noqa: E402

# Rami Levy's browser-session tokens are not accepted: they live only on the
# server, where they are renewed, so a deploy can never overwrite a renewal.
ENV_KEYS = {"SHUFERSAL_USERNAME", "SHUFERSAL_PASSWORD", "RAMI_LEVY_STORE", "GROCERY_STORES", "GROCERY_READ_ONLY"}
# name: (config file, key file, health address, compose service)
TUNNELS = {
    "main": ("tunnel.yaml", "openai-tunnel.key", "127.0.0.1:8792", "tunnel"),
    "extra": ("extra.yaml", "extra.key", "127.0.0.1:8793", "tunnel-extra"),
}
REF_RE = re.compile(r"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
MAX_REQUEST_BYTES = 64 * 1024
READY_TIMEOUT_S = 240
MCP_URL = "http://127.0.0.1:8791/health"


class DeployError(Exception):
    pass


def log(message):
    print(message, flush=True)


def parse_request(raw):
    """Validates the request; only known settings, tunnel names and release tags pass."""
    try:
        request = json.loads(raw)
    except ValueError as error:
        raise DeployError("request is not JSON: {}".format(error))
    if not isinstance(request, dict) or set(request) - {"ref", "env", "tunnels"}:
        raise DeployError("request must be an object with ref, env and tunnels")
    ref = request.get("ref")
    if not isinstance(ref, str) or not REF_RE.match(ref):
        raise DeployError("ref must be a release tag such as v0.1.0")

    env = request.get("env") or {}
    if not isinstance(env, dict):
        raise DeployError("env must be an object")
    unknown = sorted(set(env) - ENV_KEYS)
    if unknown:
        raise DeployError("unknown settings: " + ", ".join(unknown))
    for key, value in env.items():
        if not isinstance(value, str) or "\n" in value or "'" in value:
            raise DeployError("{} must be a single-line string without single quotes".format(key))
    env = {k: v for k, v in env.items() if v}

    tunnels = request.get("tunnels") or {}
    if not isinstance(tunnels, dict) or set(tunnels) - set(TUNNELS):
        raise DeployError("tunnels may only be: " + ", ".join(sorted(TUNNELS)))
    for name, tunnel in tunnels.items():
        if not isinstance(tunnel, dict) or not re.match(r"^tunnel_[A-Za-z0-9]+$", str(tunnel.get("id", ""))):
            raise DeployError("tunnel {} needs an id like tunnel_...".format(name))
        key = tunnel.get("key")
        if key is not None and (not isinstance(key, str) or not key.startswith("sk-") or any(c.isspace() for c in key)):
            raise DeployError("tunnel {} key must start with sk- and contain no spaces".format(name))
    return {"ref": ref, "image_tag": ref[1:], "env": env, "tunnels": tunnels}


def update_env(path, updates):
    """Replaces or adds KEY='value' lines and keeps every other line."""
    old = path.read_text().splitlines() if path.exists() else []
    lines = [line for line in old if line.partition("=")[0].strip() not in updates]
    lines += ["{}='{}'".format(k, v) for k, v in updates.items()]
    write_private(path, "\n".join(lines) + "\n")


class Backup:
    """Remembers files before they change so a failed deploy can put them back."""

    def __init__(self):
        self.saved = {}

    def keep(self, path):
        if path not in self.saved:
            self.saved[path] = path.read_bytes() if path.exists() else None

    def restore(self):
        for path, content in self.saved.items():
            if content is None:
                if path.exists():
                    path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                os.chmod(path, 0o600)


def write_settings(root, request, backup):
    env_path = root / ".env"
    backup.keep(env_path)
    update_env(env_path, dict(request["env"], GROCERY_IMAGE_TAG=request["image_tag"]))
    tunnel_dir = root / "tunnel"
    for name, tunnel in request["tunnels"].items():
        config_file, key_file, health, _ = TUNNELS[name]
        key_path = tunnel_dir / "secrets" / key_file
        if tunnel.get("key"):
            backup.keep(key_path)
            write_private(key_path, tunnel["key"] + "\n")
            os.chmod(key_path.parent, 0o700)
        elif not key_path.exists():
            raise DeployError("tunnel {} has no key on the server and none was sent".format(name))
        backup.keep(tunnel_dir / config_file)
        write_private(tunnel_dir / config_file, TUNNEL_CONFIG.format(tunnel_id=tunnel["id"], health=health, mcp_url="http://127.0.0.1:8791/mcp"))


def active_tunnels(root):
    return [name for name, (config_file, _, _, _) in TUNNELS.items() if (root / "tunnel" / config_file).exists()]


def compose(root, tunnels, *args, auth=False):
    files = ["-f", "compose.yaml"]
    if (root / "compose.override.yaml").exists():
        files += ["-f", "compose.override.yaml"]
    files += ["-f", "compose.tunnel.yaml"]
    if "extra" in tunnels:
        files += ["--profile", "extra"]
    if auth:
        files += ["--profile", "auth"]
    return ["docker", "compose"] + files + list(args)


def run(root, command):
    result = subprocess.run(command, cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    if result.returncode != 0:
        raise DeployError("{} failed:\n{}".format(" ".join(command[:3]), result.stdout[-2000:]))
    return result.stdout


def fetch_text(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode()


def wait_ready(tunnels, timeout_s=READY_TIMEOUT_S, fetch=fetch_text, sleep=time.sleep):
    checks = [("grocery-http", MCP_URL, lambda body: '"ok":true' in body.replace(" ", ""))]
    checks += [(TUNNELS[n][3], "http://{}/readyz".format(TUNNELS[n][2]), lambda body: body.strip() == "ready") for n in tunnels]
    deadline = time.monotonic() + timeout_s
    pending = list(checks)
    while pending:
        still = []
        for name, url, ok in pending:
            try:
                if ok(fetch(url)):
                    log("  {} is ready".format(name))
                    continue
            except Exception:  # not listening yet
                pass
            still.append((name, url, ok))
        pending = still
        if pending:
            if time.monotonic() > deadline:
                raise DeployError("not ready after {}s: {}".format(timeout_s, ", ".join(n for n, _, _ in pending)))
            sleep(3)


def has_pocket_id(root, tunnels, runner):
    """Whether pocket-id was set up on this host: sign-in is enabled by starting it once by hand."""
    try:
        return bool(runner(root, compose(root, tunnels, "ps", "--all", "--quiet", "pocket-id", auth=True)).strip())
    except DeployError:
        return False


def deploy(request, root=ROOT, runner=run, ready=wait_ready):
    backup = Backup()
    previous = runner(root, ["git", "rev-parse", "HEAD"]).strip()
    log("Deploying {} (current commit {})".format(request["ref"], previous[:7]))
    runner(root, ["git", "fetch", "--quiet", "--tags", "--force", "origin"])
    # The deploy key runs this file from the checkout, so a release without it
    # would make every later deploy impossible.
    try:
        runner(root, ["git", "cat-file", "-e", "{}:scripts/deploy_receiver.py".format(request["ref"])])
    except DeployError:
        raise DeployError("{} does not exist or predates automatic deployment; deploy a newer release".format(request["ref"]))
    write_settings(root, request, backup)
    tunnels = active_tunnels(root)
    services = ["grocery-http"] + [TUNNELS[n][3] for n in tunnels]
    # Its image is pinned by digest, so `up` recreates it only when the release changes its image or settings.
    auth = has_pocket_id(root, tunnels, runner)
    if auth:
        services.append("pocket-id")
    try:
        runner(root, ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", request["ref"]])
        runner(root, ["git", "submodule", "update", "--init", "--recursive", "--quiet"])
        runner(root, compose(root, tunnels, "pull", "--quiet", *services, auth=auth))
        runner(root, compose(root, tunnels, "up", "-d", *services, auth=auth))
        ready(tunnels)
    except Exception as error:
        log("Deploy failed: {}".format(error))
        log("Rolling back to {}".format(previous[:7]))
        backup.restore()
        try:
            runner(root, ["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", previous])
            runner(root, ["git", "submodule", "update", "--init", "--recursive", "--quiet"])
            runner(root, compose(root, active_tunnels(root), "up", "-d", *services, auth=auth))
            log("Rolled back.")
        except Exception as rollback_error:
            log("Rollback also failed: {}".format(rollback_error))
        raise
    log("Deployed {}: {}".format(request["ref"], ", ".join(services)))


def main():
    raw = sys.stdin.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        log("Request too large.")
        return 2
    try:
        request = parse_request(raw)
        deploy(request)
    except DeployError as error:
        log("Error: {}".format(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
