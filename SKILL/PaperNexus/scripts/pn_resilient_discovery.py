#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import sys
import typing
from pathlib import Path

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    call_mcp_tool_json,
    emit_result,
    fail,
    normalize_mcp_url,
    now_iso,
    resolve_corpus,
    resolve_token,
)


LEDGER_VERSION = 1
DEFAULT_LANES = ["target", "near", "far"]
SUBMITTABLE_OPERATIONS = {"search", "resolve", "run", "import", "ingest", "import_and_process"}
TIMEOUT_OR_TRANSPORT_PATTERNS = [
    "timed out",
    "timeout",
    "connection reset",
    "connection aborted",
    "connection refused",
    "remote end closed",
    "temporarily unavailable",
    "http 502",
    "http 503",
    "http 504",
    "failed:",
    "urlopen error",
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run timeout-resilient PaperNexus literature discovery lanes over remote HTTP MCP."
    )
    add_connection_args(parser)
    parser.add_argument("--workflow-id", default=os.environ.get("PAPERNEXUS_DISCOVERY_WORKFLOW_ID", "resilient-discovery"))
    parser.add_argument("--ledger", default=os.environ.get("PAPERNEXUS_DISCOVERY_LEDGER", ""))
    subparsers = parser.add_subparsers(dest="command", required=True)

    template = subparsers.add_parser("template")
    template.add_argument("--output", default="")

    submit = subparsers.add_parser("submit")
    add_lane_args(submit)
    submit.add_argument("--topic", required=True)
    submit.add_argument("--lane-topic", action="append", default=[], help="Lane-specific topic as lane=text.")
    submit.add_argument("--discovery-operation", default="search", choices=sorted(SUBMITTABLE_OPERATIONS))
    submit.add_argument("--search-mode", default="balanced")
    submit.add_argument("--provider", action="append", default=[])
    submit.add_argument("--max-queries", type=int, default=4)
    submit.add_argument("--max-results-per-query", type=int, default=20)
    submit.add_argument("--max-candidates", type=int, default=80)
    submit.add_argument("--search-budget-ms", type=int, default=90000)
    submit.add_argument("--return-partial", action=argparse.BooleanOptionalAction, default=True)
    submit.add_argument("--resolve-sources", action=argparse.BooleanOptionalAction, default=None)
    submit.add_argument("--allow-downloads", action=argparse.BooleanOptionalAction, default=False)
    submit.add_argument("--import-resolved", action="store_true")
    submit.add_argument("--process-imports", action="store_true")
    submit.add_argument("--extra-json", action="append", default=[], help="JSON object merged into literature_discovery submit args.")
    submit.add_argument("--force-resubmit", action="store_true")
    submit.add_argument("--fail-on-unknown", action="store_true")

    poll = subparsers.add_parser("poll")
    add_lane_args(poll)
    poll.add_argument("--skip-report", action="store_true")

    reconcile = subparsers.add_parser("reconcile")
    add_lane_args(reconcile)
    reconcile.add_argument("--skip-report", action="store_true")
    reconcile.add_argument("--list-limit", type=int, default=50)

    queue = subparsers.add_parser("queue")
    add_lane_args(queue)
    queue.add_argument("--limit", type=int, default=200)

    return parser.parse_args()


def add_lane_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--lane", action="append", default=[], help="Discovery lane. Repeat for target/near/far.")


def canonical_json(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_hash(payload) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def slugify(value: str, fallback: str = "run") -> str:
    raw = re.sub(r"[^a-zA-Z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return raw[:80] or fallback


def default_ledger_path(workflow_id: str) -> Path:
    return Path(".papernexus") / "remote-workflows" / slugify(workflow_id, "workflow") / "resilient-discovery-ledger.json"


def resolve_ledger_path(args) -> Path:
    raw = str(args.ledger or "").strip()
    return Path(raw).expanduser().resolve() if raw else default_ledger_path(args.workflow_id).resolve()


def empty_ledger(workflow_id: str) -> dict:
    timestamp = now_iso()
    return {
        "version": LEDGER_VERSION,
        "workflowId": workflow_id,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "lanes": {},
    }


def load_ledger(path: Path, workflow_id: str) -> dict:
    if not path.exists():
        return empty_ledger(workflow_id)
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RemoteScriptError(f"Failed to read resilient discovery ledger {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise RemoteScriptError(f"Resilient discovery ledger must be a JSON object: {path}")
    lanes = payload.get("lanes")
    if not isinstance(lanes, dict):
        lanes = {}
    return {
        "version": payload.get("version", LEDGER_VERSION),
        "workflowId": payload.get("workflowId") or workflow_id,
        "createdAt": payload.get("createdAt") or now_iso(),
        "updatedAt": payload.get("updatedAt") or now_iso(),
        "lanes": lanes,
    }


def save_ledger(path: Path, ledger: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    ledger["updatedAt"] = now_iso()
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    temp_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), "utf-8")
    temp_path.replace(path)
    return path


def append_attempt(lane_record: dict, attempt: dict) -> None:
    attempts = lane_record.get("attempts")
    if not isinstance(attempts, list):
        attempts = []
    attempts.append({
        "at": now_iso(),
        **attempt,
    })
    lane_record["attempts"] = attempts[-20:]


def selected_lanes(args, ledger: typing.Optional[dict] = None, default_all: bool = True) -> list[str]:
    raw_lanes = [slugify(value, "lane") for value in getattr(args, "lane", []) or [] if str(value or "").strip()]
    if raw_lanes:
        return list(dict.fromkeys(raw_lanes))
    if ledger and ledger.get("lanes"):
        return sorted(ledger["lanes"].keys())
    return list(DEFAULT_LANES) if default_all else []


def parse_lane_topics(values: list[str]) -> dict:
    topics = {}
    for raw in values or []:
        if "=" not in raw:
            raise RemoteScriptError(f"Invalid --lane-topic value {raw!r}. Use lane=text.")
        lane, topic = raw.split("=", 1)
        lane_key = slugify(lane, "lane")
        topic_text = topic.strip()
        if not topic_text:
            raise RemoteScriptError(f"Invalid --lane-topic value {raw!r}. Topic is empty.")
        topics[lane_key] = topic_text
    return topics


def parse_extra_json(values: list[str]) -> dict:
    merged = {}
    for raw in values or []:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RemoteScriptError(f"Invalid --extra-json object: {exc}") from exc
        if not isinstance(payload, dict):
            raise RemoteScriptError("--extra-json must decode to a JSON object.")
        merged.update(payload)
    return merged


def build_run_id(workflow_id: str, lane: str, request_hash: str) -> str:
    return f"pn-{slugify(workflow_id, 'workflow')[:48]}-{slugify(lane, 'lane')[:24]}-{request_hash[:12]}"


def strip_empty_values(payload: dict) -> dict:
    return {
        key: value
        for key, value in payload.items()
        if value is not None and value != "" and value != []
    }


def build_submit_arguments(args, corpus: str, lane: str, topic: str, run_id: str, extra: dict) -> dict:
    payload = {
        "operation": "submit",
        "discoveryOperation": args.discovery_operation,
        "corpus": corpus,
        "topic": topic,
        "runId": run_id,
        "searchMode": args.search_mode,
        "providers": args.provider,
        "maxQueries": args.max_queries,
        "maxResultsPerQuery": args.max_results_per_query,
        "maxCandidates": args.max_candidates,
        "searchBudgetMs": args.search_budget_ms,
        "returnPartial": args.return_partial,
        "resolveSources": args.resolve_sources,
        "allowDownloads": args.allow_downloads,
        "importResolved": args.import_resolved,
        "processImports": args.process_imports,
    }
    payload.update(extra)
    return strip_empty_values(payload)


def build_request_identity(args, corpus: str, lane: str, topic: str, extra: dict) -> tuple[str, str, dict]:
    identity = {
        "workflowId": args.workflow_id,
        "lane": lane,
        "corpus": corpus,
        "topic": topic,
        "discoveryOperation": args.discovery_operation,
        "searchMode": args.search_mode,
        "providers": args.provider,
        "maxQueries": args.max_queries,
        "maxResultsPerQuery": args.max_results_per_query,
        "maxCandidates": args.max_candidates,
        "searchBudgetMs": args.search_budget_ms,
        "returnPartial": args.return_partial,
        "resolveSources": args.resolve_sources,
        "allowDownloads": args.allow_downloads,
        "importResolved": args.import_resolved,
        "processImports": args.process_imports,
        "extra": extra,
    }
    request_hash = stable_hash(identity)
    run_id = build_run_id(args.workflow_id, lane, request_hash)
    return request_hash, run_id, identity


def classify_submit_error(error: Exception) -> str:
    message = str(error or "").lower()
    if any(pattern in message for pattern in TIMEOUT_OR_TRANSPORT_PATTERNS):
        return "unknown_after_timeout"
    return "submit_failed"


def summarize_ledger(ledger: dict) -> dict:
    summary = {
        "total": 0,
        "submitted": 0,
        "running": 0,
        "completed": 0,
        "reportReady": 0,
        "unknownAfterTimeout": 0,
        "failed": 0,
        "needsResubmit": 0,
        "skipped": 0,
    }
    for lane_record in ledger.get("lanes", {}).values():
        summary["total"] += 1
        status = str(lane_record.get("status") or "").strip().lower()
        if status == "submitted":
            summary["submitted"] += 1
        elif status == "running":
            summary["running"] += 1
        elif status == "completed":
            summary["completed"] += 1
        elif status == "report_ready":
            summary["reportReady"] += 1
        elif status == "unknown_after_timeout":
            summary["unknownAfterTimeout"] += 1
        elif status in {"failed", "submit_failed"}:
            summary["failed"] += 1
        elif status == "needs_resubmit":
            summary["needsResubmit"] += 1
        elif status == "skipped":
            summary["skipped"] += 1
    return summary


def terminal_or_active_status(status: str) -> bool:
    return status in {"submitted", "running", "completed", "report_ready", "failed"}


def submit_lanes(args) -> tuple[dict, int]:
    mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
    token = resolve_token(args.token)
    corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
    ledger_path = resolve_ledger_path(args)
    ledger = load_ledger(ledger_path, args.workflow_id)
    lane_topics = parse_lane_topics(args.lane_topic)
    extra = parse_extra_json(args.extra_json)
    lanes = selected_lanes(args, default_all=True)
    results = []
    exit_code = 0

    for lane in lanes:
        topic = lane_topics.get(lane) or args.topic
        request_hash, run_id, identity = build_request_identity(args, corpus, lane, topic, extra)
        existing = ledger["lanes"].get(lane)
        if existing and not args.force_resubmit:
            existing_status = str(existing.get("status") or "").strip().lower()
            existing_hash = str(existing.get("requestHash") or "")
            if existing_hash == request_hash and terminal_or_active_status(existing_status):
                append_attempt(existing, {
                    "type": "submit",
                    "status": "skipped_existing_lane",
                    "requestHash": request_hash,
                })
                existing["lastSeenAt"] = now_iso()
                results.append({
                    "lane": lane,
                    "status": "skipped_existing_lane",
                    "runId": existing.get("runId"),
                    "requestHash": request_hash,
                })
                continue

        submit_args = build_submit_arguments(args, corpus, lane, topic, run_id, extra)
        lane_record = {
            **(existing or {}),
            "lane": lane,
            "status": "submitting",
            "topic": topic,
            "corpus": corpus,
            "requestHash": request_hash,
            "runId": run_id,
            "requestIdentity": identity,
            "request": submit_args,
            "lastSeenAt": now_iso(),
        }
        append_attempt(lane_record, {
            "type": "submit",
            "status": "started",
            "requestHash": request_hash,
            "runId": run_id,
        })
        ledger["lanes"][lane] = lane_record
        save_ledger(ledger_path, ledger)

        try:
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "literature_discovery",
                submit_args,
                timeout=args.request_timeout,
            )
            lane_record["status"] = str(payload.get("status") or "submitted")
            lane_record["stage"] = str(payload.get("stage") or lane_record.get("stage") or "")
            lane_record["runId"] = str(payload.get("runId") or run_id)
            lane_record["progress"] = payload.get("progress") or lane_record.get("progress")
            lane_record["lastResult"] = payload
            lane_record.pop("lastError", None)
            lane_record["lastSeenAt"] = now_iso()
            append_attempt(lane_record, {
                "type": "submit",
                "status": lane_record["status"],
                "runId": lane_record["runId"],
            })
            results.append({
                "lane": lane,
                "status": lane_record["status"],
                "runId": lane_record["runId"],
                "requestHash": request_hash,
            })
        except RemoteScriptError as exc:
            status = classify_submit_error(exc)
            lane_record["status"] = status
            lane_record["stage"] = "needs_reconcile" if status == "unknown_after_timeout" else "submit_failed"
            lane_record["lastError"] = str(exc)
            lane_record["lastSeenAt"] = now_iso()
            append_attempt(lane_record, {
                "type": "submit",
                "status": status,
                "runId": run_id,
                "error": str(exc),
            })
            results.append({
                "lane": lane,
                "status": status,
                "runId": run_id,
                "requestHash": request_hash,
                "error": str(exc),
            })
            if status == "submit_failed" or args.fail_on_unknown:
                exit_code = 1
        finally:
            save_ledger(ledger_path, ledger)

    return {
        "contractVersion": "papernexus-resilient-discovery-v1",
        "command": "submit",
        "ledgerPath": str(ledger_path),
        "workflowId": ledger.get("workflowId"),
        "summary": summarize_ledger(ledger),
        "results": results,
    }, exit_code


def status_from_progress(progress: dict, fallback: str = "running") -> str:
    status = str(progress.get("status") or "").strip().lower()
    stage = str(progress.get("stage") or "").strip().lower()
    if status == "failed" or stage == "failed":
        return "failed"
    if status == "completed" or stage == "completed":
        return "completed"
    if status in {"queued", "submitted"}:
        return "submitted"
    if status:
        return status
    return fallback


def poll_lanes(args, reconcile: bool = False) -> tuple[dict, int]:
    mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
    token = resolve_token(args.token)
    corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
    ledger_path = resolve_ledger_path(args)
    ledger = load_ledger(ledger_path, args.workflow_id)
    lanes = selected_lanes(args, ledger=ledger, default_all=False)
    results = []

    for lane in lanes:
        lane_record = ledger["lanes"].get(lane)
        if not lane_record:
            results.append({"lane": lane, "status": "missing_from_ledger"})
            continue
        run_id = str(lane_record.get("runId") or "").strip()
        if not run_id:
            lane_record["status"] = "needs_resubmit"
            lane_record["lastError"] = "Lane has no runId to poll."
            append_attempt(lane_record, {"type": "poll", "status": "needs_resubmit"})
            results.append({"lane": lane, "status": "needs_resubmit"})
            continue

        lane_result = {"lane": lane, "runId": run_id}
        try:
            progress = call_mcp_tool_json(
                mcp_url,
                token,
                "literature_discovery",
                {
                    "operation": "progress",
                    "corpus": corpus,
                    "runId": run_id,
                },
                timeout=args.request_timeout,
            )
            lane_record["progress"] = progress
            lane_record["status"] = status_from_progress(progress, lane_record.get("status") or "running")
            lane_record["stage"] = str(progress.get("stage") or lane_record.get("stage") or "")
            lane_record["lastSeenAt"] = now_iso()
            lane_result["progressStatus"] = lane_record["status"]
            lane_result["progressStage"] = lane_record.get("stage")
            lane_record.pop("lastPollError", None)
        except RemoteScriptError as exc:
            lane_record["lastPollError"] = str(exc)
            append_attempt(lane_record, {"type": "progress", "status": "error", "error": str(exc)})
            lane_result["progressError"] = str(exc)
            if reconcile:
                reconcile_with_list(args, mcp_url, token, corpus, lane_record, lane_result)

        if not getattr(args, "skip_report", False):
            try:
                report = call_mcp_tool_json(
                    mcp_url,
                    token,
                    "literature_discovery",
                    {
                        "operation": "report",
                        "corpus": corpus,
                        "runId": run_id,
                    },
                    timeout=args.request_timeout,
                )
                lane_record["report"] = report
                lane_record["importTaskIds"] = sorted(collect_import_task_ids(report))
                if lane_record.get("status") == "completed" or report.get("candidates") is not None:
                    lane_record["status"] = "report_ready"
                lane_record["lastSeenAt"] = now_iso()
                lane_result["reportReady"] = True
                lane_result["importTaskIds"] = lane_record["importTaskIds"]
                lane_record.pop("lastReportError", None)
            except RemoteScriptError as exc:
                lane_record["lastReportError"] = str(exc)
                lane_result["reportError"] = str(exc)

        append_attempt(lane_record, {
            "type": "reconcile" if reconcile else "poll",
            "status": lane_record.get("status", ""),
        })
        results.append(lane_result | {"status": lane_record.get("status")})

    save_ledger(ledger_path, ledger)
    return {
        "contractVersion": "papernexus-resilient-discovery-v1",
        "command": "reconcile" if reconcile else "poll",
        "ledgerPath": str(ledger_path),
        "workflowId": ledger.get("workflowId"),
        "summary": summarize_ledger(ledger),
        "results": results,
    }, 0


def reconcile_with_list(args, mcp_url: str, token: str, corpus: str, lane_record: dict, lane_result: dict) -> None:
    try:
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "literature_discovery",
            {
                "operation": "list",
                "corpus": corpus,
                "limit": getattr(args, "list_limit", 50),
            },
            timeout=args.request_timeout,
        )
    except RemoteScriptError as exc:
        lane_result["listError"] = str(exc)
        return

    run_id = str(lane_record.get("runId") or "")
    runs = payload.get("runs") if isinstance(payload, dict) else []
    matching_run = None
    if isinstance(runs, list):
        for entry in runs:
            if isinstance(entry, dict) and str(entry.get("runId") or entry.get("run_id") or "") == run_id:
                matching_run = entry
                break
    lane_record["lastList"] = payload
    if matching_run:
        lane_record["lastListMatch"] = matching_run
        lane_result["listMatch"] = True
    else:
        lane_result["listMatch"] = False
        if lane_record.get("status") == "unknown_after_timeout":
            lane_record["stage"] = "not_found_in_list"


def collect_import_task_ids(value) -> set[str]:
    task_ids = set()
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key or "").replace("_", "").lower()
            if normalized in {"taskid", "importtaskid"} and isinstance(item, str) and item.strip():
                task_ids.add(item.strip())
            else:
                task_ids.update(collect_import_task_ids(item))
    elif isinstance(value, list):
        for item in value:
            task_ids.update(collect_import_task_ids(item))
    return task_ids


def queue_progress(args) -> tuple[dict, int]:
    mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
    token = resolve_token(args.token)
    corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
    ledger_path = resolve_ledger_path(args)
    ledger = load_ledger(ledger_path, args.workflow_id)
    lanes = selected_lanes(args, ledger=ledger, default_all=False)
    task_ids = []
    for lane in lanes:
        lane_record = ledger["lanes"].get(lane)
        if not lane_record:
            continue
        collected = set(lane_record.get("importTaskIds") or [])
        collected.update(collect_import_task_ids(lane_record.get("report")))
        collected.update(collect_import_task_ids(lane_record.get("progress")))
        lane_record["importTaskIds"] = sorted(collected)
        task_ids.extend(lane_record["importTaskIds"])

    task_ids = sorted(set(task_ids))
    if not task_ids:
        save_ledger(ledger_path, ledger)
        return {
            "contractVersion": "papernexus-resilient-discovery-v1",
            "command": "queue",
            "ledgerPath": str(ledger_path),
            "workflowId": ledger.get("workflowId"),
            "status": "skipped",
            "reason": "no_import_task_ids",
            "taskIds": [],
            "summary": summarize_ledger(ledger),
        }, 0

    payload = call_mcp_tool_json(
        mcp_url,
        token,
        "import_workflow",
        {
            "operation": "queue_progress",
            "corpus": corpus,
            "taskIds": task_ids,
            "limit": args.limit,
        },
        timeout=args.request_timeout,
    )
    for lane in lanes:
        lane_record = ledger["lanes"].get(lane)
        if lane_record:
            lane_record["queueProgress"] = payload
            lane_record["lastSeenAt"] = now_iso()
            append_attempt(lane_record, {"type": "queue", "status": "read", "taskIds": lane_record.get("importTaskIds", [])})
    save_ledger(ledger_path, ledger)
    return {
        "contractVersion": "papernexus-resilient-discovery-v1",
        "command": "queue",
        "ledgerPath": str(ledger_path),
        "workflowId": ledger.get("workflowId"),
        "status": "read",
        "taskIds": task_ids,
        "queueProgress": payload,
        "summary": summarize_ledger(ledger),
    }, 0


def template_payload(args) -> dict:
    workflow_id = args.workflow_id
    return {
        "contractVersion": "papernexus-resilient-discovery-template-v1",
        "workflowId": workflow_id,
        "ledger": str(resolve_ledger_path(args)),
        "lanes": [
            {
                "lane": "target",
                "purpose": "Closest target-domain priors, baselines, protocols, datasets, and reviewer-overlap risk.",
                "exampleLaneTopic": "<target-domain exact topic>",
            },
            {
                "lane": "near",
                "purpose": "Near-neighbor methods and transferable assumptions with controlled novelty risk.",
                "exampleLaneTopic": "<near-source domain topic>",
            },
            {
                "lane": "far",
                "purpose": "Far-source analogies and method transfers for high-novelty idea generation.",
                "exampleLaneTopic": "<far-source domain topic>",
            },
        ],
        "safeDefaults": {
            "useSubmitThenPoll": True,
            "timeoutState": "unknown_after_timeout",
            "graphReadyRequires": "import_workflow queue_progress/status with status=completed and stage=completed",
            "avoidByDefault": ["processImports", "ingest", "import_and_process", "import_workflow wait"],
        },
        "commands": [
            "submit --topic '<broad topic>' --lane target --lane near --lane far",
            "poll",
            "reconcile",
            "queue",
        ],
    }


def run() -> int:
    args = parse_args()
    try:
        if args.command == "template":
            payload = template_payload(args)
            if args.output:
                output = Path(args.output).expanduser().resolve()
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
                payload = {**payload, "output": str(output)}
            return emit_result(payload, args.json)
        if args.command == "submit":
            payload, exit_code = submit_lanes(args)
            emit_result(payload, args.json)
            return exit_code
        if args.command == "poll":
            payload, exit_code = poll_lanes(args, reconcile=False)
            emit_result(payload, args.json)
            return exit_code
        if args.command == "reconcile":
            payload, exit_code = poll_lanes(args, reconcile=True)
            emit_result(payload, args.json)
            return exit_code
        if args.command == "queue":
            payload, exit_code = queue_progress(args)
            emit_result(payload, args.json)
            return exit_code
        raise RemoteScriptError(f"Unknown command: {args.command}")
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    sys.exit(run())
