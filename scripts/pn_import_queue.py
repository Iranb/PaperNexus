#!/usr/bin/env python3
import argparse
import urllib.parse

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    build_wait_summary,
    emit_result,
    fail,
    normalize_api_base,
    request_json,
    require_corpus,
    resolve_token,
    wait_for_task
)


def parse_args():
    parser = argparse.ArgumentParser(description="Inspect and wait on PaperNexus import tasks.")
    add_connection_args(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--limit", type=int, default=10)

    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("task_id")

    log_parser = subparsers.add_parser("log")
    log_parser.add_argument("task_id")

    wait_parser = subparsers.add_parser("wait")
    wait_parser.add_argument("task_id")
    wait_parser.add_argument("--timeout", type=float, default=1800.0)
    wait_parser.add_argument("--interval", type=float, default=2.0)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        api_base = normalize_api_base(args.api_base)
        token = resolve_token(args.token)
        corpus = require_corpus(args.corpus)
        corpus_q = urllib.parse.quote(corpus)

        if args.command == "list":
            payload = request_json(
                "GET",
                api_base,
                f"/api/imports?name={corpus_q}",
                token,
                timeout=args.request_timeout
            )
            payload["tasks"] = list(payload.get("tasks", []))[: max(0, args.limit)]
            return emit_result(payload, args.json)

        if args.command == "status":
            payload = request_json(
                "GET",
                api_base,
                f"/api/imports/{urllib.parse.quote(args.task_id)}?name={corpus_q}",
                token,
                timeout=args.request_timeout
            )
            return emit_result(payload, args.json)

        if args.command == "log":
            payload = request_json(
                "GET",
                api_base,
                f"/api/imports/{urllib.parse.quote(args.task_id)}/log?name={corpus_q}",
                token,
                timeout=args.request_timeout
            )
            return emit_result(payload, args.json)

        if args.command == "wait":
            payload = wait_for_task(api_base, token, corpus, args.task_id, args.timeout, args.interval)
            return emit_result(payload, args.json)

        raise RemoteScriptError(f"Unsupported command: {args.command}")
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
