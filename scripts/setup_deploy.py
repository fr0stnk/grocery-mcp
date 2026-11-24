#!/usr/bin/env python3
"""One-time setup for automatic deployment. Run it from your computer.

  python3 scripts/setup_deploy.py --host my-pi --deploy-host 100.64.0.10

--host is the SSH destination you use today. --deploy-host is the address
GitHub Actions reaches over Tailscale, such as the server's tailnet IP or
MagicDNS name. Requires the GitHub CLI (gh) to be logged in with repo access.

It configures the GitHub environment "production" and the server:
  1. creates the environment and limits it to the main branch,
  2. generates an ed25519 deploy key and installs it on the server with
     restrict,command=".../scripts/deploy_receiver.py" and from Tailscale
     addresses only, so it can only deploy and only over the tailnet,
     stores the private key as the DEPLOY_SSH_KEY secret and deletes the
     local copy,
  3. stores the server's SSH host key and address as variables,
  4. copies the server's current credentials into secrets and variables.
Values travel over SSH stdout into memory and into `gh` on stdin. They are
never printed or passed as arguments.

Add the Tailscale OAuth client yourself afterwards; see the README.
"""
import argparse
import json
import pathlib
import shlex
import subprocess
import sys
import tempfile

KEY_COMMENT = "grocery-mcp-deploy"
# Tailscale assigns addresses from these ranges, so the deploy key is refused from
# anywhere else, for example through a router port forward to the server's SSH.
TAILNET_SOURCES = "100.64.0.0/10,fd7a:115c:a1e0::/48"
# Rami Levy's browser-session tokens stay on the server and are not copied.
SECRET_SETTINGS = ["SHUFERSAL_USERNAME", "SHUFERSAL_PASSWORD"]
VARIABLE_SETTINGS = ["RAMI_LEVY_STORE", "GROCERY_STORES", "GROCERY_READ_ONLY"]

# Runs on the server: prints the current settings and tunnel credentials as JSON.
COLLECT = r"""
import ast, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1]).expanduser()
env = {}
path = root / ".env"
for line in (path.read_text().splitlines() if path.exists() else []):
    key, sep, value = line.partition("=")
    if not sep or key.startswith("#"):
        continue
    value = value.strip()
    try:
        value = ast.literal_eval(value)
    except Exception:
        pass
    env[key.strip()] = str(value)
tunnels = {}
for name, config, key_file in (("main", "tunnel.yaml", "openai-tunnel.key"), ("extra", "extra.yaml", "extra.key")):
    config_path, key_path = root / "tunnel" / config, root / "tunnel" / "secrets" / key_file
    if config_path.exists():
        match = re.search(r"tunnel_id:\s*(\S+)", config_path.read_text())
        tunnels[name] = {"id": match.group(1) if match else "", "key": key_path.read_text().strip() if key_path.exists() else ""}
print(json.dumps({"env": env, "tunnels": tunnels}))
"""

# Runs on the server: checkout path, user, Python, SSH host key, and whether the receiver exists.
SERVER_INFO = r"""
import json, os, pathlib, pwd, shutil, sys
checkout = pathlib.Path(sys.argv[1]).expanduser().resolve()
print(json.dumps({
    "checkout": str(checkout),
    "user": pwd.getpwuid(os.getuid()).pw_name,
    "python": shutil.which("python3"),
    "host_key": pathlib.Path("/etc/ssh/ssh_host_ed25519_key.pub").read_text(),
    "receiver": (checkout / "scripts" / "deploy_receiver.py").exists(),
}))
"""

# Runs on the server: replaces any earlier deploy key with the new one.
INSTALL_KEY = r"""
import os, pathlib, sys, tempfile
line, comment = sys.argv[1], sys.argv[2]
ssh = pathlib.Path.home() / ".ssh"
ssh.mkdir(mode=0o700, exist_ok=True)
path = ssh / "authorized_keys"
old = path.read_text().splitlines() if path.exists() else []
kept = [l for l in old if not l.rstrip().endswith(" " + comment)]
fd, tmp = tempfile.mkstemp(dir=str(ssh), prefix=".authorized_keys.")
with os.fdopen(fd, "w") as out:
    out.write("\n".join(kept + [line]) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, str(path))
print("replaced" if len(kept) < len(old) else "added")
"""


def authorized_key_line(public_key, python, checkout, sources=TAILNET_SOURCES):
    """A deploy key that can only run the receiver (no shell, forwarding or terminal), and only from `sources`."""
    command = "{} {}/scripts/deploy_receiver.py".format(python, checkout)
    origin = 'from="{}",'.format(sources) if sources else ""
    return '{}restrict,command="{}" {} {}'.format(origin, command, " ".join(public_key.split()[:2]), KEY_COMMENT)


def known_hosts_line(deploy_host, host_public_key):
    key_type, key = host_public_key.split()[:2]
    return "{} {} {}".format(deploy_host, key_type, key)


def plan(collected):
    """Splits collected values into GitHub secrets and variables, skipping empty ones."""
    env, tunnels = collected.get("env", {}), collected.get("tunnels", {})
    secrets = {k: env[k] for k in SECRET_SETTINGS if env.get(k)}
    variables = {k: env[k] for k in VARIABLE_SETTINGS if env.get(k)}
    for name, prefix in (("main", "OPENAI_TUNNEL"), ("extra", "OPENAI_TUNNEL_EXTRA")):
        tunnel = tunnels.get(name) or {}
        if tunnel.get("id"):
            variables[prefix + "_ID"] = tunnel["id"]
        if tunnel.get("key"):
            secrets[prefix + "_KEY"] = tunnel["key"]
    return secrets, variables


class GitHub:
    def __init__(self, repo, environment):
        self.repo, self.environment = repo, environment

    def run(self, *args, stdin=None):
        result = subprocess.run(["gh", *args], input=stdin, text=True, capture_output=True)
        if result.returncode != 0:
            raise SystemExit("gh {} failed: {}".format(args[0], result.stderr.strip()))
        return result.stdout

    def create_environment(self):
        body = json.dumps({"deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True}})
        self.run("api", "-X", "PUT", "repos/{}/environments/{}".format(self.repo, self.environment), "--input", "-", stdin=body)
        policies = json.loads(self.run("api", "repos/{}/environments/{}/deployment-branch-policies".format(self.repo, self.environment)))
        if not any(p.get("name") == "main" for p in policies.get("branch_policies", [])):
            self.run("api", "-X", "POST", "repos/{}/environments/{}/deployment-branch-policies".format(self.repo, self.environment),
                     "-f", "name=main", "-f", "type=branch")

    def secret(self, name, value):
        self.run("secret", "set", name, "--repo", self.repo, "--env", self.environment, stdin=value)

    def variable(self, name, value):
        self.run("variable", "set", name, "--repo", self.repo, "--env", self.environment, "--body", value)


def ssh(host, script, *args, stdin=None):
    remote = "python3 -c {} {}".format(shlex.quote(script), " ".join(shlex.quote(a) for a in args))
    result = subprocess.run(["ssh", "-T", host, remote], input=stdin, text=True, capture_output=True)
    if result.returncode != 0:
        raise SystemExit("ssh {} failed: {}".format(host, result.stderr.strip()))
    return result.stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", required=True, help="SSH destination you use today, for setup only")
    ap.add_argument("--deploy-host", required=True, help="server address GitHub Actions uses over Tailscale")
    ap.add_argument("--checkout", default="~/grocery-mcp", help="repository checkout on the server (default: %(default)s)")
    ap.add_argument("--repo", help="GitHub repository OWNER/NAME (default: this checkout's)")
    ap.add_argument("--environment", default="production")
    ap.add_argument("--key-from", default=TAILNET_SOURCES, metavar="CIDRS",
                    help="source addresses allowed to use the deploy key (default: Tailscale ranges %(default)s; empty allows any)")
    ap.add_argument("--skip-key", action="store_true", help="keep the current deploy key")
    ap.add_argument("--skip-credentials", action="store_true", help="do not copy the server's credentials")
    opts = ap.parse_args()

    repo = opts.repo or subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
                                       text=True, capture_output=True, check=True).stdout.strip()
    github = GitHub(repo, opts.environment)
    info = json.loads(ssh(opts.host, SERVER_INFO, opts.checkout))
    if not info["receiver"]:
        raise SystemExit("{}/scripts/deploy_receiver.py is missing on the server; update its checkout first".format(info["checkout"]))

    print("1. Environment {} in {}, limited to main".format(opts.environment, repo))
    github.create_environment()

    if not opts.skip_key:
        print("2. Deploy key")
        with tempfile.TemporaryDirectory() as tmp:
            key = pathlib.Path(tmp) / "deploy"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", KEY_COMMENT, "-f", str(key)], check=True)
            line = authorized_key_line(key.with_suffix(".pub").read_text(), info["python"], info["checkout"], opts.key_from)
            print("   server key", ssh(opts.host, INSTALL_KEY, line, KEY_COMMENT).strip(), "- restricted to scripts/deploy_receiver.py")
            github.secret("DEPLOY_SSH_KEY", key.read_text())
        print("   private key stored as DEPLOY_SSH_KEY; local copy deleted")

    print("3. Server address and host key")
    github.variable("DEPLOY_SSH_HOST", opts.deploy_host)
    github.variable("DEPLOY_SSH_USER", info["user"])
    github.variable("DEPLOY_SSH_KNOWN_HOSTS", known_hosts_line(opts.deploy_host, info["host_key"]))

    if not opts.skip_credentials:
        print("4. Credentials from the server")
        secrets, variables = plan(json.loads(ssh(opts.host, COLLECT, opts.checkout)))
        for name, value in secrets.items():
            github.secret(name, value)
        for name, value in variables.items():
            github.variable(name, value)
        print("   secrets:", ", ".join(sorted(secrets)) or "none")
        print("   variables:", ", ".join(sorted(variables)) or "none")

    print("\nStill needed: the Tailscale OAuth client as TS_OAUTH_CLIENT_ID and TS_OAUTH_SECRET. See the README.")


if __name__ == "__main__":
    main()
