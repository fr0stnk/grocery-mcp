import io
import pathlib
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from helpers import load

setup = load("setup_openai_tunnel")


class SetupOpenAITunnel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name) / "tunnel"
        patcher = mock.patch.object(setup, "TUNNEL_DIR", self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def run_main(self, argv, tunnel_id="tunnel_abc123", key="sk-test-key"):
        with mock.patch("sys.argv", ["setup_openai_tunnel.py", *argv]), \
             mock.patch("builtins.input", return_value=tunnel_id), \
             mock.patch.object(setup.getpass, "getpass", return_value=key), \
             redirect_stdout(io.StringIO()) as out:
            setup.main()
        return out.getvalue()

    def mode(self, path):
        return stat.S_IMODE(path.stat().st_mode)

    def test_default_writes_config_and_key_privately(self):
        output = self.run_main([])
        config = (self.dir / "tunnel.yaml").read_text()
        self.assertIn("tunnel_id: tunnel_abc123", config)
        self.assertIn("listen_addr: 127.0.0.1:8792", config)
        self.assertIn("api_key: file:/run/secrets/openai-tunnel.key", config)
        self.assertNotIn("sk-test-key", config)
        self.assertEqual((self.dir / "secrets" / "openai-tunnel.key").read_text(), "sk-test-key\n")
        self.assertEqual(self.mode(self.dir / "tunnel.yaml"), 0o600)
        self.assertEqual(self.mode(self.dir / "secrets" / "openai-tunnel.key"), 0o600)
        self.assertEqual(self.mode(self.dir / "secrets"), 0o700)
        self.assertNotIn("sk-test-key", output)

    def test_named_tunnel_uses_its_own_files_and_port(self):
        self.run_main(["--name", "extra"])
        self.assertIn("listen_addr: 127.0.0.1:8793", (self.dir / "extra.yaml").read_text())
        self.assertTrue((self.dir / "secrets" / "extra.key").exists())
        self.assertFalse((self.dir / "tunnel.yaml").exists())

    def test_keep_key_reuses_the_saved_key(self):
        self.run_main(["--name", "extra"])
        self.run_main(["--name", "extra", "--keep-key"], tunnel_id="tunnel_new1", key="unused")
        self.assertIn("tunnel_new1", (self.dir / "extra.yaml").read_text())
        self.assertEqual((self.dir / "secrets" / "extra.key").read_text(), "sk-test-key\n")

    def test_rejects_invalid_input(self):
        cases = [
            (["--name", "Bad Name"], {}, "lowercase"),
            ([], {"tunnel_id": "not-a-tunnel"}, "tunnel ID"),
            ([], {"key": "pk-wrong"}, "sk-"),
            (["--keep-key"], {}, "does not exist"),
        ]
        for argv, inputs, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(SystemExit, message):
                self.run_main(argv, **inputs)
        self.assertFalse((self.dir / "tunnel.yaml").exists())


if __name__ == "__main__":
    unittest.main()
