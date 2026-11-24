import io
import pathlib
import stat
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from helpers import jwt, load

tokens = load("set_rami_levy_tokens")
FUTURE = int(time.time()) + 3600


def curl(*parts, url="https://www.rami-levy.co.il/api/v2/cart"):
    return " \\\n  ".join([f"curl '{url}'", *parts])


VALID = curl(
    "-H 'authorization: Bearer opaque-token'",
    f"-H 'ecomtoken: {jwt({'exp': FUTURE})}'",
    "-H 'user-agent: Mozilla/5.0 Test'",
    "-b 'cf_clearance=abc; _ga=GA1.1'",
    "--data-raw '{\"store\":\"1\"}'",
)


class ParseCurl(unittest.TestCase):
    def test_reads_headers_and_cookie(self):
        values = tokens.parse_curl(VALID)
        self.assertEqual(values["RAMI_LEVY_BEARER_TOKEN"], "opaque-token")
        self.assertEqual(values["RAMI_LEVY_USER_AGENT"], "Mozilla/5.0 Test")
        self.assertEqual(values["RAMI_LEVY_COOKIE"], "cf_clearance=abc; _ga=GA1.1")

    def test_accepts_www_api_and_cookie_header(self):
        raw = curl("-H 'Authorization: Bearer t'", "-H 'ecomtoken: e'", "-A 'UA'", "-H 'Cookie: a=1'",
                   url="https://www-api.rami-levy.co.il/api/v3/site/orders")
        values = tokens.parse_curl(raw)
        self.assertEqual((values["RAMI_LEVY_USER_AGENT"], values["RAMI_LEVY_COOKIE"]), ("UA", "a=1"))

    def test_without_cookie_leaves_cookie_out(self):
        raw = curl("-H 'authorization: Bearer t'", "-H 'ecomtoken: e'", "-H 'user-agent: UA'")
        self.assertNotIn("RAMI_LEVY_COOKIE", tokens.parse_curl(raw))

    def test_rejects_bad_input(self):
        cases = {
            "not a curl": "not a cURL command",
            curl("-H 'a: b'", url="https://example.com/x"): "example.com",
            curl("-H 'user-agent: UA'"): "RAMI_LEVY_BEARER_TOKEN, RAMI_LEVY_ECOM_TOKEN",
            curl("-H 'authorization: Bearer t'", "-H 'ecomtoken: e'", "-H \"user-agent: it's\""): "single quote",
        }
        for raw, message in cases.items():
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                tokens.parse_curl(raw)


class Report(unittest.TestCase):
    def run_report(self, values):
        out = io.StringIO()
        with redirect_stdout(out):
            ok = tokens.report(values)
        return ok, out.getvalue()

    def test_reports_expiry_and_cookie_names_without_values(self):
        ok, text = self.run_report(tokens.parse_curl(VALID))
        self.assertTrue(ok)
        self.assertIn("opaque token", text)
        self.assertIn("2 cookies, cf_clearance present", text)
        self.assertNotIn("opaque-token", text)
        self.assertNotIn("abc", text)

    def test_flags_expired_tokens(self):
        values = {"RAMI_LEVY_BEARER_TOKEN": jwt({"exp": 1}), "RAMI_LEVY_ECOM_TOKEN": jwt({}), "RAMI_LEVY_USER_AGENT": "UA"}
        ok, text = self.run_report(values)
        self.assertFalse(ok)
        self.assertIn("EXPIRED", text)
        self.assertIn("JWT without expiry", text)


class UpdateEnvFile(unittest.TestCase):
    def test_replaces_only_given_keys_atomically_with_private_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = pathlib.Path(tmp) / "nested" / ".env"
            env.parent.mkdir()
            env.write_text("SHUFERSAL_PASSWORD='!a$b'\nRAMI_LEVY_COOKIE='old'\n# comment\n")
            tokens.update_env_file(str(env), {"RAMI_LEVY_COOKIE": "new", "RAMI_LEVY_STORE": "412"})
            self.assertEqual(env.read_text(), "SHUFERSAL_PASSWORD='!a$b'\n# comment\nRAMI_LEVY_COOKIE='new'\nRAMI_LEVY_STORE='412'\n")
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)

    def test_creates_a_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = pathlib.Path(tmp) / "new" / ".env"
            tokens.update_env_file(str(env), {"A": "1"})
            self.assertEqual(env.read_text(), "A='1'\n")


class Main(unittest.TestCase):
    def test_dry_run_from_file_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "request.curl"
            source.write_text(VALID)
            env = pathlib.Path(tmp) / ".env"
            argv = ["set_rami_levy_tokens.py", "--from-file", str(source), "--env-file", str(env), "--dry-run"]
            with mock.patch("sys.argv", argv), redirect_stdout(io.StringIO()) as out:
                tokens.main()
            self.assertIn("Dry run", out.getvalue())
            self.assertFalse(env.exists())

    def test_local_write_from_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "request.curl"
            source.write_text(VALID)
            env = pathlib.Path(tmp) / ".env"
            with mock.patch("sys.argv", ["x", "--from-file", str(source), "--env-file", str(env)]), redirect_stdout(io.StringIO()):
                tokens.main()
            self.assertIn("RAMI_LEVY_BEARER_TOKEN='opaque-token'", env.read_text())

    def test_github_mode_sets_secrets_on_stdin_and_starts_a_deploy(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "request.curl"
            source.write_text(VALID)
            ok = mock.Mock(returncode=0, stdout="", stderr="")
            with mock.patch("sys.argv", ["x", "--from-file", str(source), "--github"]), \
                 mock.patch.object(tokens.subprocess, "run", return_value=ok) as run, redirect_stdout(io.StringIO()):
                tokens.main()
        calls = [c.args[0] for c in run.call_args_list]
        self.assertIn(["gh", "secret", "set", "RAMI_LEVY_BEARER_TOKEN", "--env", "production"], calls)
        self.assertEqual(calls[-1], ["gh", "workflow", "run", "deploy.yml"])
        bearer = next(c for c in run.call_args_list if c.args[0][3] == "RAMI_LEVY_BEARER_TOKEN")
        self.assertEqual(bearer.kwargs["input"], "opaque-token")
        self.assertFalse(any("opaque-token" in " ".join(c.args[0]) for c in run.call_args_list))

    def test_github_mode_without_deploy(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "request.curl"
            source.write_text(VALID)
            ok = mock.Mock(returncode=0, stdout="", stderr="")
            with mock.patch("sys.argv", ["x", "--from-file", str(source), "--github", "staging", "--no-deploy"]), \
                 mock.patch.object(tokens.subprocess, "run", return_value=ok) as run, redirect_stdout(io.StringIO()):
                tokens.main()
        calls = [c.args[0] for c in run.call_args_list]
        self.assertTrue(all(c[:3] == ["gh", "secret", "set"] and c[-1] == "staging" for c in calls))

    def test_remote_write_sends_values_on_stdin_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = pathlib.Path(tmp) / "request.curl"
            source.write_text(VALID)
            done = mock.Mock(returncode=0, stdout="/home/u/grocery-mcp/.env\n", stderr="")
            with mock.patch("sys.argv", ["x", "--from-file", str(source), "--host", "pi"]), \
                 mock.patch.object(tokens.subprocess, "run", return_value=done) as run, redirect_stdout(io.StringIO()):
                tokens.main()
            args, kwargs = run.call_args
            self.assertEqual(args[0][:3], ["ssh", "-T", "pi"])
            self.assertNotIn("opaque-token", " ".join(args[0]))
            self.assertIn("opaque-token", kwargs["input"])


if __name__ == "__main__":
    unittest.main()
