import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

from helpers import load

setup = load("setup_deploy")


class SetupDeploy(unittest.TestCase):
    def test_deploy_key_can_only_run_the_receiver_from_the_tailnet(self):
        line = setup.authorized_key_line("ssh-ed25519 AAAAkey generated@laptop\n", "/usr/bin/python3", "/home/u/grocery-mcp")
        self.assertEqual(line, 'from="100.64.0.0/10,fd7a:115c:a1e0::/48",restrict,command="/usr/bin/python3 /home/u/grocery-mcp/scripts/deploy_receiver.py" ssh-ed25519 AAAAkey grocery-mcp-deploy')
        anywhere = setup.authorized_key_line("ssh-ed25519 AAAAkey x", "/usr/bin/python3", "/c", sources="")
        self.assertTrue(anywhere.startswith('restrict,command='))

    def test_known_hosts_pins_the_deploy_address(self):
        self.assertEqual(setup.known_hosts_line("100.64.0.10", "ssh-ed25519 AAAAhost root@pi\n"), "100.64.0.10 ssh-ed25519 AAAAhost")

    def test_plan_splits_secrets_from_variables_and_skips_empty_values(self):
        secrets, variables = setup.plan({
            "env": {"SHUFERSAL_PASSWORD": "p", "RAMI_LEVY_COOKIE": "", "RAMI_LEVY_STORE": "412", "OTHER": "x"},
            "tunnels": {"main": {"id": "tunnel_a", "key": "sk-a"}, "extra": {"id": "tunnel_b", "key": ""}},
        })
        self.assertEqual(secrets, {"SHUFERSAL_PASSWORD": "p", "OPENAI_TUNNEL_KEY": "sk-a"})
        self.assertEqual(variables, {"RAMI_LEVY_STORE": "412", "OPENAI_TUNNEL_ID": "tunnel_a", "OPENAI_TUNNEL_EXTRA_ID": "tunnel_b"})

    def test_collect_reads_env_quoting_and_tunnel_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / ".env").write_text("# comment\nSHUFERSAL_PASSWORD='!a$b'\nRAMI_LEVY_USER_AGENT=\"it's UA\"\nRAW=plain value\n")
            (root / "tunnel" / "secrets").mkdir(parents=True)
            (root / "tunnel" / "tunnel.yaml").write_text("control_plane:\n  tunnel_id: tunnel_abc\n")
            (root / "tunnel" / "secrets" / "openai-tunnel.key").write_text("sk-main\n")
            out = subprocess.run([sys.executable, "-c", setup.COLLECT, str(root)], capture_output=True, text=True, check=True).stdout
        collected = json.loads(out)
        self.assertEqual(collected["env"], {"SHUFERSAL_PASSWORD": "!a$b", "RAMI_LEVY_USER_AGENT": "it's UA", "RAW": "plain value"})
        self.assertEqual(collected["tunnels"], {"main": {"id": "tunnel_abc", "key": "sk-main"}})

    def test_install_key_replaces_an_earlier_deploy_key(self):
        with tempfile.TemporaryDirectory() as home:
            ssh = pathlib.Path(home) / ".ssh"
            ssh.mkdir()
            (ssh / "authorized_keys").write_text("ssh-ed25519 AAAApersonal me@mac\nrestrict ssh-ed25519 AAAAold grocery-mcp-deploy\n")
            run = lambda: subprocess.run([sys.executable, "-c", setup.INSTALL_KEY, "restrict ssh-ed25519 AAAAnew grocery-mcp-deploy", "grocery-mcp-deploy"],
                                         capture_output=True, text=True, check=True, env={"HOME": home}).stdout.strip()
            self.assertEqual(run(), "replaced")
            self.assertEqual((ssh / "authorized_keys").read_text(), "ssh-ed25519 AAAApersonal me@mac\nrestrict ssh-ed25519 AAAAnew grocery-mcp-deploy\n")
            self.assertEqual((ssh / "authorized_keys").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
