import base64
import importlib.util
import json
import pathlib

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent


def load(name):
    """Imports scripts/<name>.py, whose file names are not package-importable."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def jwt(claims):
    part = lambda obj: base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{part({'alg': 'HS256'})}.{part(claims)}.signature"
