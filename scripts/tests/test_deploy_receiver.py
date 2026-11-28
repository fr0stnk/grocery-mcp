import io
import json
import pathlib
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from helpers import load

receiver = load("deploy_receiver")
KEY = "sk-test-key"


def request(**overrides):
    body = {"ref": "v0.1.0", "env": {"SHUFERSAL_PASSWORD": "!a$b", "RAMI_LEVY_STORE": "412"}, "tunnels": {"main": {"id": "tunnel_abc", "key": KEY}}}
    body.update(overrides)
    return json.dumps(body)


class ParseRequest(unittest.TestCase):
    def test_accepts_a_release_and_drops_empty_values(self):
        r = receiver.parse_request(json.dumps({"ref": "v1.2.3", "env": {"GROCERY_STORES": ""}, "tunnels": {}}))
        self.assertEqual((r["ref"], r["image_tag"], r["env"]), ("v1.2.3", "1.2.3", {}))
        self.assertEqual(receiver.parse_request(request(ref="v1.0.0-rc.1"))["image_tag"], "1.0.0-rc.1")

    def test_rejects_anything_unexpected(self):
        cases = {
            "not json": "not JSON",
            request(ref="main"): "release tag",
            request(ref="v1.0; rm -rf /"): "release tag",
            request(env={"PATH": "/tmp"}): "unknown settings: PATH",
            request(env={"RAMI_LEVY_ECOM_TOKEN": "x"}): "unknown settings: RAMI_LEVY_ECOM_TOKEN",
            request(env={"SHUFERSAL_PASSWORD": "it's"}): "single quotes",
            request(env={"SHUFERSAL_PASSWORD": "a\nb"}): "single-line",
            request(tunnels={"other": {"id": "tunnel_x"}}): "tunnels may only be",
            request(tunnels={"main": {"id": "x"}}): "needs an id",
            request(tunnels={"main": {"id": "tunnel_x", "key": "pk-1"}}): "start with sk-",
            json.dumps({"ref": "v1.0.0", "extra": 1}): "ref, env and tunnels",
        }
        for raw, message in cases.items():
            with self.subTest(message=message), self.assertRaisesRegex(receiver.DeployError, message):
                receiver.parse_request(raw)


class Deploy(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        (self.root / ".env").write_text("SHUFERSAL_USERNAME='me@example.com'\nSHUFERSAL_PASSWORD='old'\n")
        (self.root / "compose.override.yaml").write_text("services: {}\n")
        self.commands = []

    def runner(self, fail_on=None, pocket_id=False):
        def run(root, command):
            self.commands.append(command)
            if fail_on and fail_on in command:
                raise receiver.DeployError("simulated failure")
            if pocket_id and "ps" in command:
                return "0123abcd\n"
            return "abc1234def\n" if command[:2] == ["git", "rev-parse"] else ""
        return run

    def deploy(self, raw, **kwargs):
        with redirect_stdout(io.StringIO()) as out:
            receiver.deploy(receiver.parse_request(raw), root=self.root, runner=self.runner(**kwargs), ready=lambda tunnels: None)
        return out.getvalue()

    def test_writes_settings_checks_out_the_tag_and_restarts(self):
        output = self.deploy(request())
        env = (self.root / ".env").read_text()
        self.assertIn("SHUFERSAL_USERNAME='me@example.com'", env)
        self.assertIn("SHUFERSAL_PASSWORD='!a$b'", env)
        self.assertIn("GROCERY_IMAGE_TAG='0.1.0'", env)
        self.assertEqual(stat.S_IMODE((self.root / ".env").stat().st_mode), 0o600)
        self.assertIn("tunnel_id: tunnel_abc", (self.root / "tunnel" / "tunnel.yaml").read_text())
        self.assertEqual((self.root / "tunnel" / "secrets" / "openai-tunnel.key").read_text(), KEY + "\n")
        self.assertIn(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "v0.1.0"], self.commands)
        up = self.commands[-1]
        self.assertEqual(up[:4], ["docker", "compose", "-f", "compose.yaml"])
        self.assertIn("compose.override.yaml", up)
        self.assertEqual(up[-4:], ["up", "-d", "grocery-http", "tunnel"])
        self.assertNotIn(KEY, output)
        self.assertNotIn("!a$b", output)

    def test_includes_the_extra_tunnel_when_configured(self):
        self.deploy(request(tunnels={"main": {"id": "tunnel_a", "key": KEY}, "extra": {"id": "tunnel_b", "key": "sk-other"}}))
        self.assertIn("127.0.0.1:8793", (self.root / "tunnel" / "extra.yaml").read_text())
        self.assertEqual(self.commands[-1][-3:], ["grocery-http", "tunnel", "tunnel-extra"])
        self.assertIn("--profile", self.commands[-1])

    def test_restarts_pocket_id_only_where_it_was_set_up(self):
        self.deploy(request())
        self.assertNotIn("pocket-id", self.commands[-1])
        self.commands.clear()
        self.deploy(request(), pocket_id=True)
        up = self.commands[-1]
        self.assertEqual(up[-5:], ["up", "-d", "grocery-http", "tunnel", "pocket-id"])
        self.assertEqual(up[up.index("auth") - 1], "--profile")

    def test_a_tunnel_without_a_key_needs_one_on_the_server(self):
        with self.assertRaisesRegex(receiver.DeployError, "no key on the server"):
            self.deploy(request(tunnels={"main": {"id": "tunnel_abc"}}))

    def test_refuses_releases_without_the_receiver_before_changing_anything(self):
        before = (self.root / ".env").read_text()
        with self.assertRaisesRegex(receiver.DeployError, "predates automatic deployment"):
            self.deploy(request(), fail_on="cat-file")
        self.assertEqual((self.root / ".env").read_text(), before)
        self.assertFalse(any("checkout" in c for c in self.commands))

    def test_failure_restores_files_and_the_previous_commit(self):
        before = (self.root / ".env").read_text()
        with self.assertRaisesRegex(receiver.DeployError, "simulated failure"):
            self.deploy(request(), fail_on="up")
        self.assertEqual((self.root / ".env").read_text(), before)
        self.assertFalse((self.root / "tunnel" / "tunnel.yaml").exists())
        self.assertFalse((self.root / "tunnel" / "secrets" / "openai-tunnel.key").exists())
        checkouts = [c[-1] for c in self.commands if "checkout" in c]
        self.assertEqual(checkouts, ["v0.1.0", "abc1234def"])


class WaitReady(unittest.TestCase):
    def test_waits_until_every_service_answers(self):
        answers = {receiver.MCP_URL: iter(["", '{"ok": true}']), "http://127.0.0.1:8792/readyz": iter(["startup catalog pending", "ready"])}
        with redirect_stdout(io.StringIO()):
            receiver.wait_ready(["main"], fetch=lambda url: next(answers[url]), sleep=lambda s: None)

    def test_times_out_with_the_services_still_pending(self):
        def fetch(url):
            raise OSError("connection refused")
        with self.assertRaisesRegex(receiver.DeployError, "grocery-http"):
            receiver.wait_ready([], timeout_s=0, fetch=fetch, sleep=lambda s: None)


class Main(unittest.TestCase):
    def test_rejects_oversized_requests(self):
        with mock.patch("sys.stdin", io.StringIO("x" * (receiver.MAX_REQUEST_BYTES + 1))), redirect_stdout(io.StringIO()):
            self.assertEqual(receiver.main(), 2)

    def test_reports_invalid_requests_without_deploying(self):
        with mock.patch("sys.stdin", io.StringIO('{"ref": "main"}')), mock.patch.object(receiver, "deploy") as deploy, redirect_stdout(io.StringIO()) as out:
            self.assertEqual(receiver.main(), 1)
        deploy.assert_not_called()
        self.assertIn("release tag", out.getvalue())


if __name__ == "__main__":
    unittest.main()
