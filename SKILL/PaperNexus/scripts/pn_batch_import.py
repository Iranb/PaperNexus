#!/usr/bin/env python3
import typing
import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    build_registry_summary,
    call_mcp_tool_json,
    emit_result,
    fail,
    find_task_record,
    infer_source_kind,
    load_task_registry,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token,
    update_registry_from_task_payload,
    wait_for_task,
)
from pn_import_queue import match_task_file
from pn_import_submit import infer_paper_id, resolve_submission_source


BATCH_MANIFEST_VERSION = 1


def parse_args():
    parser = argparse.ArgumentParser(
        description="Batch upload local PDF/Markdown files to PaperNexus from a fixed JSON manifest."
    )
    add_connection_args(parser)
    parser.add_argument("--manifest", default="")
    subparsers = parser.add_subparsers(dest="command")

    template_parser = subparsers.add_parser("template")
    template_parser.add_argument("--output", default="")

    submit_parser = subparsers.add_parser("submit")
    submit_parser.add_argument("--ssh-target", default=os.environ.get("PAPERNEXUS_SSH_TARGET", ""))
    submit_parser.add_argument("--remote-dir", default="")
    submit_parser.add_argument("--remote-staging-root", default=os.environ.get("PAPERNEXUS_REMOTE_STAGING_ROOT", ""))
    submit_parser.add_argument("--ssh-bin", default=os.environ.get("PAPERNEXUS_SSH_BIN", "ssh"))
    submit_parser.add_argument("--rsync-bin", default=os.environ.get("PAPERNEXUS_RSYNC_BIN", "rsync"))
    submit_parser.add_argument("--trigger", default="mcp")
    submit_parser.add_argument("--fail-fast", action="store_true")

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--limit", type=int, default=200)

    wait_parser = subparsers.add_parser("wait")
    wait_parser.add_argument("--timeout", type=float, default=1800.0)
    wait_parser.add_argument("--interval", type=float, default=2.0)

    return parser.parse_args()


def first_defined(*values):
    for value in values:
        if value is not None and value != "":
            return value
    return ""


def manifest_template() -> dict:
    return {
        "version": BATCH_MANIFEST_VERSION,
        "defaults": {
            "mcpUrl": "http://211.71.76.29:4821/mcp",
            "corpus": "GCD",
            "sshTarget": "hyq@211.71.76.29",
            "remoteStagingRoot": "/tmp/papernexus-import-staging",
            "trigger": "mcp",
        },
        "papers": [
            {
                "paperId": "iclr2025-oral-data-shapley",
                "source": "/Users/iranb/Documents/papers/2025/ICLR2025 oral/Data Shapley in One Training Run.pdf",
                "sourceKind": "pdf",
            }
        ],
    }


def load_manifest(manifest_path: str) -> dict:
    raw_path = (manifest_path or "").strip()
    if not raw_path:
        raise RemoteScriptError("Missing manifest path. Pass --manifest <json-file>.")
    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise RemoteScriptError(f"Manifest file does not exist: {path}")
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RemoteScriptError(f"Failed to read batch manifest {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RemoteScriptError(f"Batch manifest must be a JSON object: {path}")
    version = int(payload.get("version", BATCH_MANIFEST_VERSION))
    if version != BATCH_MANIFEST_VERSION:
        raise RemoteScriptError(
            f"Unsupported batch manifest version {version}. Expected {BATCH_MANIFEST_VERSION}."
        )
    defaults = payload.get("defaults") or {}
    if defaults and not isinstance(defaults, dict):
        raise RemoteScriptError("Batch manifest field `defaults` must be a JSON object.")
    papers = payload.get("papers")
    if not isinstance(papers, list) or not papers:
        raise RemoteScriptError("Batch manifest field `papers` must be a non-empty array.")
    return {
        "path": str(path),
        "defaults": defaults,
        "papers": papers,
        "version": version,
    }


def normalize_manifest_items(manifest: dict) -> list[dict]:
    normalized = []
    for index, entry in enumerate(manifest["papers"], start=1):
        if not isinstance(entry, dict):
            raise RemoteScriptError(f"Batch manifest paper #{index} must be a JSON object.")
        source = str(entry.get("source") or "").strip()
        if not source:
            raise RemoteScriptError(f"Batch manifest paper #{index} is missing `source`.")
        paper_id = infer_paper_id(str(entry.get("paperId") or ""), source)
        source_kind = infer_source_kind(source, str(entry.get("sourceKind") or ""))
        normalized.append({
            "paperId": paper_id,
            "source": source,
            "sourceKind": source_kind,
            "taskId": str(entry.get("taskId") or "").strip(),
            "remoteDir": str(entry.get("remoteDir") or "").strip(),
            "serverFilePath": str(entry.get("serverFilePath") or "").strip(),
        })
    return normalized


def build_batch_summary(items: list[dict]) -> dict:
    summary = {
        "total": len(items),
        "submitted": 0,
        "completed": 0,
        "running": 0,
        "pending": 0,
        "failed": 0,
        "notSubmitted": 0,
        "submitFailed": 0,
    }
    for item in items:
        status = str(item.get("status") or "").strip().lower()
        if item.get("submitted"):
            summary["submitted"] += 1
        if status == "completed":
            summary["completed"] += 1
        elif status == "running":
            summary["running"] += 1
        elif status == "pending":
            summary["pending"] += 1
        elif status == "failed":
            summary["failed"] += 1
        elif status == "not-submitted":
            summary["notSubmitted"] += 1
        elif status == "submit-failed":
            summary["submitFailed"] += 1
    return summary


def resolve_runtime_settings(args, manifest: dict) -> tuple[str, str, str, dict]:
    defaults = manifest.get("defaults") or {}
    mcp_url = normalize_mcp_url(
        first_defined(args.mcp_url, defaults.get("mcpUrl")),
        first_defined(args.api_base, defaults.get("apiBase"))
    )
    token = resolve_token(args.token)
    corpus = resolve_corpus(first_defined(args.corpus, defaults.get("corpus")), mcp_url, token, timeout=args.request_timeout)
    return mcp_url, token, corpus, defaults


def build_submission_args(item: dict, args, defaults: dict) -> SimpleNamespace:
    return SimpleNamespace(
        server_file_path=item.get("serverFilePath", ""),
        source=item["source"],
        ssh_target=first_defined(args.ssh_target, defaults.get("sshTarget")),
        remote_dir=first_defined(item.get("remoteDir"), args.remote_dir, defaults.get("remoteDir")),
        remote_staging_root=first_defined(args.remote_staging_root, defaults.get("remoteStagingRoot")),
        ssh_bin=first_defined(args.ssh_bin, defaults.get("sshBin"), "ssh"),
        rsync_bin=first_defined(args.rsync_bin, defaults.get("rsyncBin"), "rsync"),
    )


def submit_item(item: dict, args, mcp_url: str, token: str, corpus: str, defaults: dict) -> dict:
    submission_args = build_submission_args(item, args, defaults)
    server_file_path, staging_payload, source_value = resolve_submission_source(submission_args, mcp_url)
    payload = call_mcp_tool_json(
        mcp_url,
        token,
        "import_workflow",
        {
            "operation": "submit",
            "corpus": corpus,
            "serverFilePath": server_file_path,
            "trigger": first_defined(args.trigger, defaults.get("trigger"), "mcp"),
        },
        timeout=args.request_timeout,
    )
    registry_path = update_registry_from_task_payload(
        payload,
        paper_id=item["paperId"],
        source=source_value or item["source"],
        source_kind=item["sourceKind"],
        remote_file=server_file_path,
        corpus=corpus,
    )
    task = payload.get("task", {})
    result = {
        "paperId": item["paperId"],
        "source": item["source"],
        "sourceKind": item["sourceKind"],
        "taskId": str(task.get("id") or "").strip(),
        "status": str(task.get("status") or "").strip() or "pending",
        "stage": str(task.get("stage") or "").strip(),
        "submitted": True,
        "synced": str(task.get("status") or "").lower() == "completed" and str(task.get("stage") or "").lower() == "completed",
        "remoteFile": server_file_path,
        "deduped": bool(payload.get("deduped")),
        "registry": {
            "path": str(registry_path),
            "saved": True,
        },
    }
    if staging_payload:
        result["staging"] = staging_payload
    return result


def load_remote_tasks(mcp_url: str, token: str, corpus: str, timeout: float, limit: int = 200) -> list[dict]:
    payload = call_mcp_tool_json(
        mcp_url,
        token,
        "import_workflow",
        {
            "operation": "list",
            "corpus": corpus,
            "limit": limit
        },
        timeout=timeout,
    )
    return list(payload.get("tasks") or [])[: max(0, limit)]


def resolve_remote_task(item: dict, remote_tasks: list[dict]) -> typing.Optional[dict]:
    for task in remote_tasks:
        if item["taskId"] and str(task.get("id") or "").strip() == item["taskId"]:
            return task
        if match_task_file(task, paper_id=item["paperId"], source=item["source"]):
            return task
    return None


def resolve_task_reference(item: dict, registry: dict, remote_tasks: list[dict], corpus: str) -> typing.Tuple[typing.Optional[str], typing.Optional[dict], typing.Optional[str]]:
    record, matched_by = find_task_record(
        registry,
        paper_id=item["paperId"],
        source=item["source"],
        task_id=item["taskId"],
        corpus=corpus,
    )
    if record and str(record.get("taskId") or "").strip():
        return str(record.get("taskId") or "").strip(), record, matched_by

    remote_task = resolve_remote_task(item, remote_tasks)
    if remote_task:
        return str(remote_task.get("id") or "").strip(), None, "remote-scan"

    return None, record, matched_by


def status_item(item: dict, args, mcp_url: str, token: str, corpus: str, registry: dict, remote_tasks: list[dict]) -> dict:
    task_id, record, matched_by = resolve_task_reference(item, registry, remote_tasks, corpus)
    if not task_id:
        return {
            "paperId": item["paperId"],
            "source": item["source"],
            "sourceKind": item["sourceKind"],
            "taskId": "",
            "status": "not-submitted",
            "stage": "",
            "submitted": False,
            "synced": False,
            "registry": build_registry_summary(record, matched_by),
        }

    payload = call_mcp_tool_json(
        mcp_url,
        token,
        "import_workflow",
        {
            "operation": "status",
            "corpus": corpus,
            "taskId": task_id
        },
        timeout=args.request_timeout,
    )
    registry_path = update_registry_from_task_payload(
        payload,
        paper_id=(record or {}).get("paperId") or item["paperId"],
        source=(record or {}).get("source") or item["source"],
        source_kind=(record or {}).get("sourceKind") or item["sourceKind"],
        remote_file=(record or {}).get("remoteFile") or "",
        corpus=corpus,
    )
    task = payload.get("task", {})
    return {
        "paperId": (record or {}).get("paperId") or item["paperId"],
        "source": (record or {}).get("source") or item["source"],
        "sourceKind": (record or {}).get("sourceKind") or item["sourceKind"],
        "taskId": str(task.get("id") or task_id),
        "status": str(task.get("status") or "").strip(),
        "stage": str(task.get("stage") or "").strip(),
        "submitted": True,
        "synced": str(task.get("status") or "").lower() == "completed" and str(task.get("stage") or "").lower() == "completed",
        "error": task.get("error"),
        "finishedAt": task.get("finishedAt"),
        "registry": {
            **build_registry_summary(record, matched_by),
            "path": str(registry_path),
        },
    }


def wait_item(item: dict, args, mcp_url: str, token: str, corpus: str, registry: dict, remote_tasks: list[dict]) -> dict:
    task_id, record, matched_by = resolve_task_reference(item, registry, remote_tasks, corpus)
    if not task_id:
        return {
            "paperId": item["paperId"],
            "source": item["source"],
            "sourceKind": item["sourceKind"],
            "taskId": "",
            "status": "not-submitted",
            "stage": "",
            "submitted": False,
            "synced": False,
            "log": "",
            "registry": build_registry_summary(record, matched_by),
        }

    payload = wait_for_task(mcp_url, token, corpus, task_id, args.timeout, args.interval)
    registry_path = update_registry_from_task_payload(
        payload,
        paper_id=(record or {}).get("paperId") or item["paperId"],
        source=(record or {}).get("source") or item["source"],
        source_kind=(record or {}).get("sourceKind") or item["sourceKind"],
        remote_file=(record or {}).get("remoteFile") or "",
        corpus=corpus,
    )
    task = payload.get("task", {})
    return {
        "paperId": (record or {}).get("paperId") or item["paperId"],
        "source": (record or {}).get("source") or item["source"],
        "sourceKind": (record or {}).get("sourceKind") or item["sourceKind"],
        "taskId": str(task.get("id") or task_id),
        "status": str(task.get("status") or "").strip(),
        "stage": str(task.get("stage") or "").strip(),
        "submitted": True,
        "synced": str(task.get("status") or "").lower() == "completed" and str(task.get("stage") or "").lower() == "completed",
        "error": task.get("error"),
        "finishedAt": task.get("finishedAt"),
        "log": payload.get("log", ""),
        "registry": {
            **build_registry_summary(record, matched_by),
            "path": str(registry_path),
        },
    }


def render_template(args) -> int:
    payload = manifest_template()
    output = (args.output or "").strip()
    if output:
        output_path = Path(output).expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
        return emit_result({
            "template": payload,
            "written": str(output_path),
        }, args.json)
    return emit_result(payload, args.json)


def require_manifest_for_command(args) -> dict:
    if args.command == "template":
        return {}
    return load_manifest(args.manifest)


def main() -> int:
    args = parse_args()
    try:
        if not args.command:
            raise RemoteScriptError("Missing batch command. Use template, submit, status, or wait.")

        if args.command == "template":
            return render_template(args)

        manifest = require_manifest_for_command(args)
        items = normalize_manifest_items(manifest)
        mcp_url, token, corpus, defaults = resolve_runtime_settings(args, manifest)

        if args.command == "submit":
            results = []
            for item in items:
                try:
                    results.append(submit_item(item, args, mcp_url, token, corpus, defaults))
                except RemoteScriptError as exc:
                    results.append({
                        "paperId": item["paperId"],
                        "source": item["source"],
                        "sourceKind": item["sourceKind"],
                        "taskId": "",
                        "status": "submit-failed",
                        "stage": "",
                        "submitted": False,
                        "synced": False,
                        "error": str(exc),
                    })
                    if args.fail_fast:
                        raise
            return emit_result({
                "manifest": manifest["path"],
                "corpus": corpus,
                "summary": build_batch_summary(results),
                "items": results,
            }, args.json)

        registry = load_task_registry()
        remote_tasks = load_remote_tasks(mcp_url, token, corpus, args.request_timeout, getattr(args, "limit", 200))

        if args.command == "status":
            results = [status_item(item, args, mcp_url, token, corpus, registry, remote_tasks) for item in items]
            return emit_result({
                "manifest": manifest["path"],
                "corpus": corpus,
                "summary": build_batch_summary(results),
                "items": results,
            }, args.json)

        if args.command == "wait":
            results = []
            for item in items:
                results.append(wait_item(item, args, mcp_url, token, corpus, registry, remote_tasks))
            return emit_result({
                "manifest": manifest["path"],
                "corpus": corpus,
                "summary": build_batch_summary(results),
                "items": results,
            }, args.json)

        raise RemoteScriptError(f"Unsupported batch command: {args.command}")
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
