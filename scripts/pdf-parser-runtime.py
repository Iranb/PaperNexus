#!/usr/bin/env python3
"""Install/audit the recorded parser releases in independent virtual environments."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

MANIFEST = Path(__file__).resolve().parents[1] / "config" / "pdf-parser-versions.json"


def inspect_runtime(python, spec):
    code = """
import importlib.metadata as m, json, sys
try:
    d = m.distribution(sys.argv[1])
    java = None
    if sys.argv[1] == 'opendataloader-pdf':
        try:
            from jdk4py import JAVA
            java = str(JAVA) if JAVA.is_file() else None
        except ImportError:
            pass
    try:
        torch_version = m.version('torch')
    except m.PackageNotFoundError:
        torch_version = None
    print(json.dumps({'version':d.version,'directUrl':json.loads(d.read_text('direct_url.json') or '{}'),'javaExecutable':java,'torchVersion':torch_version}))
except m.PackageNotFoundError:
    print(json.dumps({'version':None,'directUrl':{}}))
"""
    result = subprocess.run([str(python), "-c", code, spec["distribution"]], check=True, capture_output=True, text=True)
    installed = json.loads(result.stdout)
    revision = spec.get("revision")
    direct = installed["directUrl"]
    expected_url = next((item.split(" @ ", 1)[1] for item in spec.get("requirements", []) if " @ " in item), "")
    revision_ok = not revision or (bool(expected_url) and revision in expected_url and direct.get("url") == expected_url)
    return {**installed, "aligned": installed["version"] == spec["version"] and revision_ok}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "audit"])
    parser.add_argument("--root", required=True, type=Path, help="Dedicated parser environment directory; never the system Python prefix")
    parser.add_argument("--parser", default="all")
    parser.add_argument("--python", default=sys.executable, help="Base Python used only when creating a new environment")
    parser.add_argument("--uv", default="uv")
    parser.add_argument("--torch-backend", default="cpu", help="Explicit PyTorch wheel backend (default CPU; installs no GPU service)")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    parsers = manifest["parsers"]
    selected = list(parsers) if args.parser == "all" else args.parser.split(",")
    if any(name not in parsers for name in selected):
        parser.error("Unknown parser; choose from " + ", ".join(parsers))
    root = args.root.expanduser().resolve()
    if args.action == "install":
        root.mkdir(parents=True, exist_ok=True)
    report, config = [], {}
    for name in selected:
        spec = parsers[name]
        if spec.get("kind") == "http-api":
            report.append({"parser": name, "status": "provider-managed", "apiVersion": spec["release"]})
            continue
        env = root / f"{name}-{spec['release']}"
        python = env / "bin" / "python"
        if args.action == "install":
            if env.exists() and not (env / "pyvenv.cfg").is_file():
                raise RuntimeError(f"Refusing to install into a non-venv directory: {env}")
            if not python.exists():
                subprocess.run([args.uv, "venv", "--python", args.python, str(env)], check=True)
            subprocess.run([args.uv, "pip", "install", "--python", str(python), "--torch-backend", args.torch_backend, *spec["requirements"]], check=True)
            subprocess.run([args.uv, "pip", "check", "--python", str(python)], check=True)
            frozen = subprocess.run([args.uv, "pip", "freeze", "--python", str(python)], check=True, capture_output=True, text=True)
            (env / "requirements.resolved.txt").write_text(frozen.stdout)
        result = inspect_runtime(python, spec) if python.exists() else {"version": None, "aligned": False}
        report.append({"parser": name, "release": spec["release"], "python": str(python), **result,
                       **({"javaAvailable": bool(shutil.which("java") or result.get("javaExecutable"))} if name == "opendataloader" else {})})
        if result["aligned"]:
            config.update({key: str(env / relative) for key, relative in spec.get("configFields", {}).items()})
            if name == "docling" and str(result.get("torchVersion") or "").endswith("+cpu"):
                config.update({"doclingDevice": "cpu", "doclingAutoGpu": False})
    payload = {"verifiedReleaseDate": manifest["verifiedAt"], "runtimes": report, "configPatch": {"analyze": config},
               "boundary": "Distribution/source alignment only. Imports, PDF conversion, models, and remote services require separate checks."}
    print(json.dumps(payload, indent=2))
    if args.action == "install":
        (root / "runtime-audit.json").write_text(json.dumps(payload, indent=2) + "\n")
    return 0 if all(row.get("aligned", row.get("status") == "provider-managed") for row in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
