#!/usr/bin/env python3
import typing
import argparse
from pathlib import Path

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    build_registry_summary,
    call_mcp_tool_json,
    emit_result,
    find_task_record,
    fail,
    load_task_registry,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token,
    update_registry_from_task_payload,
    wait_for_task
)


def parse_args():
    parser = argparse.ArgumentParser(description="Inspect and wait on PaperNexus import tasks.")
    add_connection_args(parser)
    parser.add_argument("--paper-id", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--status", action="store_true")
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--limit", type=int, default=10)

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("task_id", nargs="?")
    status_parser.add_argument("--paper-id", default="")
    status_parser.add_argument("--source", default="")

    log_parser = subparsers.add_parser("log")
    log_parser.add_argument("task_id", nargs="?")
    log_parser.add_argument("--paper-id", default="")
    log_parser.add_argument("--source", default="")

    wait_parser = subparsers.add_parser("wait")
    wait_parser.add_argument("task_id", nargs="?")
    wait_parser.add_argument("--paper-id", default="")
    wait_parser.add_argument("--source", default="")
    wait_parser.add_argument("--timeout", type=float, default=1800.0)
    wait_parser.add_argument("--interval", type=float, default=2.0)

    return parser.parse_args()


def match_task_file(task: dict, paper_id: str = "", source: str = "") -> bool:
    files = task.get("files") or []
    source_name = Path(source).name if source else ""
    for file_entry in files:
        original_name = str(file_entry.get("originalName") or file_entry.get("name") or "").strip()
        if paper_id and paper_id in original_name:
            return True
        if source_name and original_name == source_name:
            return True
    return False


def resolve_task_id(args, mcp_url: str, token: str, corpus: str, timeout: float) -> typing.Tuple[typing.Optional[str], typing.Optional[dict], typing.Optional[str]]:
    direct_task_id = str(getattr(args, "task_id", "") or "").strip()
    if direct_task_id:
        return direct_task_id, None, "task-id"

    registry = load_task_registry()
    record, matched_by = find_task_record(
        registry,
        paper_id=(args.paper_id or "").strip(),
        source=(args.source or "").strip(),
        corpus=corpus
    )
    if record and str(record.get("taskId") or "").strip():
        return str(record["taskId"]).strip(), record, matched_by

    if (args.paper_id or "").strip() or (args.source or "").strip():
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "import_workflow",
            {
                "operation": "list",
                "corpus": corpus
            },
            timeout=timeout
        )
        paper_id = (args.paper_id or "").strip()
        source = (args.source or "").strip()
        for task in payload.get("tasks", []):
            if match_task_file(task, paper_id=paper_id, source=source):
                update_registry_from_task_payload(
                    {"task": task},
                    paper_id=paper_id,
                    source=source,
                    corpus=corpus
                )
                return str(task.get("id") or "").strip(), None, "remote-scan"

    return None, record, matched_by


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        command = args.command
        if args.status and not command:
            command = "status"
        if not command:
            raise RemoteScriptError("Missing queue command. Use list/status/log/wait or pass --status.")

        if command == "list":
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "import_workflow",
                {
                    "operation": "list",
                    "corpus": corpus
                },
                timeout=args.request_timeout
            )
            payload["tasks"] = list(payload.get("tasks", []))[: max(0, args.limit)]
            payload["registry"] = build_registry_summary()
            return emit_result(payload, args.json)

        task_id, record, matched_by = resolve_task_id(args, mcp_url, token, corpus, args.request_timeout)

        if command == "status":
            if not task_id:
                if (args.paper_id or "").strip() or (args.source or "").strip():
                    raise RemoteScriptError("No tracked task found for the requested paper/source.")
                payload = call_mcp_tool_json(
                    mcp_url,
                    token,
                    "import_workflow",
                    {
                        "operation": "list",
                        "corpus": corpus
                    },
                    timeout=args.request_timeout
                )
                payload["registry"] = build_registry_summary()
                return emit_result(payload, args.json)
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "import_workflow",
                {
                    "operation": "status",
                    "corpus": corpus,
                    "taskId": task_id
                },
                timeout=args.request_timeout
            )
            registry_path = update_registry_from_task_payload(
                payload,
                paper_id=(record or {}).get("paperId") or args.paper_id,
                source=(record or {}).get("source") or args.source,
                source_kind=(record or {}).get("sourceKind") or "",
                remote_file=(record or {}).get("remoteFile") or "",
                corpus=corpus
            )
            payload["paperId"] = (record or {}).get("paperId") or args.paper_id or ""
            payload["registry"] = {
                **build_registry_summary(record, matched_by),
                "path": str(registry_path)
            }
            return emit_result(payload, args.json)

        if command == "log":
            if not task_id:
                raise RemoteScriptError("Missing task reference for log lookup. Pass a task id, --paper-id, or --source.")
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "import_workflow",
                {
                    "operation": "log",
                    "corpus": corpus,
                    "taskId": task_id
                },
                timeout=args.request_timeout
            )
            payload["paperId"] = (record or {}).get("paperId") or args.paper_id or ""
            payload["registry"] = build_registry_summary(record, matched_by)
            return emit_result(payload, args.json)

        if command == "wait":
            if not task_id:
                raise RemoteScriptError("Missing task reference for wait. Pass a task id, --paper-id, or --source.")
            payload = wait_for_task(mcp_url, token, corpus, task_id, args.timeout, args.interval)
            registry_path = update_registry_from_task_payload(
                payload,
                paper_id=(record or {}).get("paperId") or args.paper_id,
                source=(record or {}).get("source") or args.source,
                source_kind=(record or {}).get("sourceKind") or "",
                remote_file=(record or {}).get("remoteFile") or "",
                corpus=corpus
            )
            payload["paperId"] = (record or {}).get("paperId") or args.paper_id or ""
            payload["registry"] = {
                **build_registry_summary(record, matched_by),
                "path": str(registry_path)
            }
            return emit_result(payload, args.json)

        raise RemoteScriptError(f"Unsupported command: {command}")
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
