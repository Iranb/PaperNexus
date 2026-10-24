#!/usr/bin/env python3
"""Submit one versioned research-decision request without automatic retries."""
import argparse
import json
from pathlib import Path

from pn_common import (
    RemoteScriptError, add_connection_args, call_mcp_tool_json, emit_result,
    fail, normalize_mcp_url, resolve_corpus, resolve_token,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Read or update a PaperNexus research decision project.")
    add_connection_args(parser)
    parser.add_argument("--request-file", required=True, help="Local UTF-8 JSON containing one research_decision request.")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        request = json.loads(Path(args.request_file).read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise RemoteScriptError("Request file must contain a JSON object.")
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        if not request.get("corpus"):
            request["corpus"] = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        result = call_mcp_tool_json(mcp_url, token, "research_decision", request, timeout=args.request_timeout)
        return emit_result(result, args.json)
    except (RemoteScriptError, OSError, ValueError) as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
