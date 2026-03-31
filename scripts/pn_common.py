#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_TIMEOUT = 30.0


class RemoteScriptError(RuntimeError):
    pass


def add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--api-base", default=os.environ.get("PAPERNEXUS_API_BASE_URL", ""))
    parser.add_argument("--token", default=os.environ.get("PAPERNEXUS_API_TOKEN", ""))
    parser.add_argument("--corpus", default=os.environ.get("PAPERNEXUS_CORPUS", ""))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--request-timeout", type=float, default=DEFAULT_TIMEOUT)


def normalize_api_base(raw: str) -> str:
    value = (raw or "").strip().rstrip("/")
    if not value:
        raise RemoteScriptError("Missing API base URL. Pass --api-base or set PAPERNEXUS_API_BASE_URL.")
    return value


def resolve_token(explicit: str) -> str:
    token = (explicit or "").strip()
    if token:
        return token
    source = os.environ.get("PAPERNEXUS_API_TOKEN_SOURCE", "").strip().lower()
    if source == "os_keychain":
        service = os.environ.get("PAPERNEXUS_API_TOKEN_SERVICE", "papernexus-api-token").strip()
        account = os.environ.get("PAPERNEXUS_API_TOKEN_ACCOUNT", "default").strip()
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
                check=True,
                capture_output=True,
                text=True
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise RemoteScriptError(
                f"Failed to load PaperNexus API token from keychain service={service} account={account}: {exc}"
            ) from exc
        token = result.stdout.strip()
        if token:
            return token
    raise RemoteScriptError("Missing API token. Pass --token or configure PAPERNEXUS_API_TOKEN.")


def build_headers(token: str, with_json: bool = False) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
    }
    if with_json:
        headers["Content-Type"] = "application/json"
    return headers


def request_json(method: str, api_base: str, path: str, token: str, payload: dict | None = None, timeout: float = DEFAULT_TIMEOUT):
    body = None
    headers = build_headers(token, with_json=payload is not None)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{normalize_api_base(api_base)}{path}",
        data=body,
        headers=headers,
        method=method.upper()
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        detail = text
        try:
            payload = json.loads(text)
            if isinstance(payload, dict) and payload.get("error"):
                detail = str(payload["error"])
        except json.JSONDecodeError:
            pass
        if "web/api/" in detail and "ENOENT" in detail:
            detail = f"{detail} (likely wrong API route shape; request fell through to static file handling)"
        raise RemoteScriptError(f"HTTP {exc.code} for {path}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RemoteScriptError(f"Request to {path} failed: {exc.reason}") from exc


def emit_result(payload, as_json: bool) -> int:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        if isinstance(payload, (dict, list)):
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(str(payload))
    return 0


def fail(message: str, as_json: bool) -> int:
    if as_json:
        print(json.dumps({"error": message}, ensure_ascii=False, indent=2), file=sys.stderr)
    else:
        print(message, file=sys.stderr)
    return 1


def require_corpus(value: str) -> str:
    corpus = (value or "").strip()
    if not corpus:
        raise RemoteScriptError("Missing corpus name. Pass --corpus or set PAPERNEXUS_CORPUS.")
    return corpus


def collect_supported_files(local_path: str) -> list[Path]:
    root = Path(local_path).expanduser().resolve()
    if not root.exists():
        raise RemoteScriptError(f"Local path does not exist: {root}")
    if root.is_file():
        if root.suffix.lower() not in {".pdf", ".md", ".markdown"}:
            raise RemoteScriptError(f"Unsupported file type: {root}")
        return [root]

    files = sorted([
        path for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".pdf", ".md", ".markdown"}
    ])
    if not files:
        raise RemoteScriptError(f"No supported PDF/Markdown files found under {root}")
    return files


def run_command(args: list[str], timeout: float = DEFAULT_TIMEOUT, env: dict[str, str] | None = None) -> None:
    try:
        subprocess.run(args, check=True, timeout=timeout, env=env)
    except subprocess.CalledProcessError as exc:
        raise RemoteScriptError(f"Command failed ({' '.join(args)}): exit {exc.returncode}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RemoteScriptError(f"Command timed out ({' '.join(args)}) after {timeout}s") from exc
    except OSError as exc:
        raise RemoteScriptError(f"Failed to run command ({' '.join(args)}): {exc}") from exc


def build_wait_summary(task_payload: dict, log_payload: dict) -> dict:
    return {
        "task": task_payload.get("task"),
        "log": log_payload.get("log", "")
    }


def wait_for_task(api_base: str, token: str, corpus: str, task_id: str, timeout_seconds: float, interval_seconds: float) -> dict:
    deadline = time.monotonic() + timeout_seconds
    last_task = None
    last_log = None
    while True:
        last_task = request_json(
            "GET",
            api_base,
            f"/api/imports/{urllib.parse.quote(task_id)}?name={urllib.parse.quote(corpus)}",
            token
        )
        last_log = request_json(
            "GET",
            api_base,
            f"/api/imports/{urllib.parse.quote(task_id)}/log?name={urllib.parse.quote(corpus)}",
            token
        )
        task = last_task.get("task", {})
        status = str(task.get("status", "")).strip().lower()
        if status in {"completed", "failed"}:
            return build_wait_summary(last_task, last_log)
        if time.monotonic() >= deadline:
            raise RemoteScriptError(
                f"Timed out waiting for task {task_id}. Last status={task.get('status')} stage={task.get('stage')}"
            )
        time.sleep(interval_seconds)


def build_graph_payload(corpus: str, query: str, options: dict | None = None) -> dict:
    payload = {
        "name": require_corpus(corpus),
        "query": str(query or "").strip(),
    }
    if not payload["query"]:
        raise RemoteScriptError("Missing query text.")
    if options:
        payload["options"] = options
    return payload
