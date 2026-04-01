#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_TIMEOUT = 30.0
DEFAULT_REMOTE_STAGING_ROOT = "/tmp/papernexus-import-staging"
TASK_REGISTRY_VERSION = 1


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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def resolve_corpus(explicit: str, api_base: str, token: str, timeout: float = DEFAULT_TIMEOUT) -> str:
    corpus = (explicit or "").strip()
    if corpus:
        return corpus
    payload = request_json("GET", api_base, "/api/corpora", token, timeout=timeout)
    corpora = payload.get("corpora", [])
    if len(corpora) == 1:
        name = str(corpora[0].get("name") or "").strip()
        if name:
            return name
    if not corpora:
        raise RemoteScriptError("No remote corpora found.")
    names = [str(entry.get("name") or "").strip() for entry in corpora if str(entry.get("name") or "").strip()]
    raise RemoteScriptError(
        "Missing corpus name. Multiple remote corpora are available: "
        + ", ".join(names or ["<unnamed>"])
        + ". Pass --corpus or set PAPERNEXUS_CORPUS."
    )


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


def infer_source_kind(source_path: str, explicit_kind: str = "") -> str:
    kind = (explicit_kind or "").strip().lower()
    if kind in {"pdf", "markdown"}:
        return kind
    suffix = Path(source_path).suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".md", ".markdown"}:
        return "markdown"
    raise RemoteScriptError(f"Unsupported source kind for {source_path}. Pass --source-kind pdf|markdown.")


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


def build_remote_paths(local_root: Path, files: list[Path], remote_dir: str) -> list[str]:
    remote_root = remote_dir.rstrip("/")
    if local_root.is_file():
        return [f"{remote_root}/{local_root.name}"]
    remote_files = []
    for file_path in files:
        relative = file_path.relative_to(local_root).as_posix()
        remote_files.append(f"{remote_root}/{relative}")
    return remote_files


def slugify_staging_name(value: str) -> str:
    raw = "".join(char.lower() if char.isalnum() else "-" for char in value)
    collapsed = "-".join(part for part in raw.split("-") if part)
    return collapsed[:80] or "upload"


def default_remote_staging_root() -> str:
    return os.environ.get("PAPERNEXUS_REMOTE_STAGING_ROOT", DEFAULT_REMOTE_STAGING_ROOT).rstrip("/")


def build_default_remote_dir(local_root: Path, remote_root: str | None = None) -> str:
    root = (remote_root or default_remote_staging_root()).rstrip("/")
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    digest = hashlib.sha1(str(local_root).encode("utf-8")).hexdigest()[:8]
    leaf = slugify_staging_name(local_root.stem if local_root.is_file() else local_root.name)
    return f"{root}/{timestamp}-{leaf}-{digest}"


def run_command(args: list[str], timeout: float = DEFAULT_TIMEOUT, env: dict[str, str] | None = None) -> None:
    try:
        subprocess.run(args, check=True, timeout=timeout, env=env)
    except subprocess.CalledProcessError as exc:
        raise RemoteScriptError(f"Command failed ({' '.join(args)}): exit {exc.returncode}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RemoteScriptError(f"Command timed out ({' '.join(args)}) after {timeout}s") from exc
    except OSError as exc:
        raise RemoteScriptError(f"Failed to run command ({' '.join(args)}): {exc}") from exc


def stage_local_path(
    local_path: str,
    ssh_target: str,
    remote_dir: str = "",
    remote_root: str = "",
    ssh_bin: str = "ssh",
    rsync_bin: str = "rsync"
) -> dict:
    local_root = Path(local_path).expanduser().resolve()
    files = collect_supported_files(str(local_root))
    target_dir = (remote_dir or build_default_remote_dir(local_root, remote_root=remote_root or None)).rstrip("/")
    if not target_dir.startswith("/"):
        raise RemoteScriptError("Remote staging directory must be an absolute path.")
    run_command([ssh_bin, ssh_target, f"mkdir -p {urllib.parse.quote(target_dir, safe='/.-_~')}"])
    rsync_source = str(local_root)
    if local_root.is_dir():
        rsync_source = f"{rsync_source.rstrip('/')}/"
    rsync_target = f"{ssh_target}:{target_dir}/"
    run_command([
        rsync_bin,
        "-avz",
        "--partial",
        "--partial-dir=.rsync-partial",
        "--progress",
        "--checksum",
        "--timeout=60",
        rsync_source,
        rsync_target
    ], timeout=300.0)
    return {
        "localPath": str(local_root),
        "remoteDir": target_dir,
        "fileCount": len(files),
        "remoteFiles": build_remote_paths(local_root, files, target_dir)
    }


def build_wait_summary(task_payload: dict, log_payload: dict) -> dict:
    return {
        "task": task_payload.get("task"),
        "log": log_payload.get("log", "")
    }


def get_task_registry_path() -> Path:
    explicit = os.environ.get("PAPERNEXUS_TASK_REGISTRY_PATH", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    return Path(tempfile.gettempdir()) / "papernexus-remote-task-registry.json"


def normalize_registry_source(source: str = "") -> str:
    value = (source or "").strip()
    if not value:
        return ""
    candidate = Path(value).expanduser()
    try:
        if candidate.exists():
            return str(candidate.resolve())
    except OSError:
        pass
    if candidate.is_absolute():
        return str(candidate)
    return value


def load_task_registry() -> dict:
    path = get_task_registry_path()
    if not path.exists():
        return {
            "version": TASK_REGISTRY_VERSION,
            "updatedAt": None,
            "tasks": []
        }
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RemoteScriptError(f"Failed to read task registry at {path}: {exc}") from exc
    tasks = payload.get("tasks")
    if not isinstance(tasks, list):
        tasks = []
    return {
        "version": payload.get("version", TASK_REGISTRY_VERSION),
        "updatedAt": payload.get("updatedAt"),
        "tasks": tasks
    }


def save_task_registry(registry: dict) -> Path:
    path = get_task_registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = {
        "version": TASK_REGISTRY_VERSION,
        "updatedAt": now_iso(),
        "tasks": registry.get("tasks", [])
    }
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    temp_path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), "utf-8")
    temp_path.replace(path)
    return path


def select_task_match(task: dict, paper_id: str = "", source: str = "", task_id: str = "", corpus: str = "") -> bool:
    if task_id and str(task.get("taskId") or "").strip() == task_id:
        return True
    if paper_id and str(task.get("paperId") or "").strip() == paper_id:
        if corpus and str(task.get("corpus") or "").strip() != corpus:
            return False
        return True
    if source:
        normalized_source = normalize_registry_source(source)
        task_source = normalize_registry_source(str(task.get("source") or ""))
        if normalized_source and task_source and normalized_source == task_source:
            if corpus and str(task.get("corpus") or "").strip() != corpus:
                return False
            return True
    return False


def find_task_record(registry: dict, paper_id: str = "", source: str = "", task_id: str = "", corpus: str = "") -> tuple[dict | None, str | None]:
    matches = []
    for task in registry.get("tasks", []):
        if select_task_match(task, paper_id=paper_id, source=source, task_id=task_id, corpus=corpus):
            matched_by = "task-id" if task_id and str(task.get("taskId") or "").strip() == task_id else (
                "paper-id" if paper_id and str(task.get("paperId") or "").strip() == paper_id else "source"
            )
            matches.append((task, matched_by))
    if not matches:
        return None, None
    matches.sort(
        key=lambda item: (
            str(item[0].get("updatedAt") or item[0].get("createdAt") or ""),
            str(item[0].get("taskId") or "")
        ),
        reverse=True
    )
    return matches[0]


def build_task_record(
    task: dict,
    *,
    paper_id: str = "",
    source: str = "",
    source_kind: str = "",
    remote_file: str = "",
    corpus: str = ""
) -> dict:
    return {
        "paperId": (paper_id or task.get("paperId") or "").strip(),
        "source": normalize_registry_source(source or task.get("source") or ""),
        "sourceKind": (source_kind or task.get("sourceKind") or "").strip(),
        "remoteFile": (remote_file or task.get("remoteFile") or "").strip(),
        "corpus": (corpus or task.get("corpus") or "").strip(),
        "taskId": str(task.get("id") or task.get("taskId") or "").strip(),
        "status": str(task.get("status") or "").strip(),
        "stage": str(task.get("stage") or "").strip(),
        "createdAt": task.get("createdAt"),
        "startedAt": task.get("startedAt"),
        "updatedAt": task.get("updatedAt") or now_iso(),
        "finishedAt": task.get("finishedAt"),
        "error": task.get("error")
    }


def upsert_task_record(record: dict) -> Path:
    registry = load_task_registry()
    existing, _matched_by = find_task_record(
        registry,
        paper_id=str(record.get("paperId") or ""),
        source=str(record.get("source") or ""),
        task_id=str(record.get("taskId") or ""),
        corpus=str(record.get("corpus") or "")
    )
    if existing is not None:
        existing.update({key: value for key, value in record.items() if value not in {None, ""}})
    else:
        registry["tasks"].append(record)
    return save_task_registry(registry)


def build_registry_summary(record: dict | None = None, matched_by: str | None = None) -> dict:
    summary = {
        "path": str(get_task_registry_path())
    }
    if matched_by:
        summary["matchedBy"] = matched_by
    if record:
        summary["taskId"] = record.get("taskId")
    return summary


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


def update_registry_from_task_payload(
    task_payload: dict,
    *,
    paper_id: str = "",
    source: str = "",
    source_kind: str = "",
    remote_file: str = "",
    corpus: str = ""
) -> Path:
    task = task_payload.get("task", task_payload)
    record = build_task_record(
        task,
        paper_id=paper_id,
        source=source,
        source_kind=source_kind,
        remote_file=remote_file,
        corpus=corpus
    )
    return upsert_task_record(record)


def api_host_is_local(api_base: str) -> bool:
    host = urllib.parse.urlparse(normalize_api_base(api_base)).hostname or ""
    return host in {"127.0.0.1", "localhost"}


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
