#!/usr/bin/env python3
"""
Run corpus-scale PaperNexus refresh/materialize/optimize workflows over remote HTTP MCP.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_SKILL_SCRIPTS = Path(__file__).resolve().parents[2] / "PaperNexus" / "scripts"
sys.path.insert(0, str(_SKILL_SCRIPTS))

from pn_common import (  # noqa: E402
    RemoteScriptError,
    add_connection_args,
    call_mcp_tool_json,
    emit_result,
    fail,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Run corpus-scale PaperNexus refresh/materialize/optimize workflows over remote HTTP MCP."
    )
    add_connection_args(parser)
    parser.add_argument(
        "--mode",
        choices=["analyze", "materialize", "llm_optimize", "optimize"],
        default="analyze"
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-incremental", action="store_true")
    parser.add_argument("--rebuild-pdf-markdown", action="store_true")
    parser.add_argument(
        "--semantic-extraction",
        choices=["auto", "heuristic-only", "llm-assisted", "llm-primary"],
        default=""
    )
    parser.add_argument("--llm-batch-size", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=0)
    parser.add_argument("--changed-source-key", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        llm_batch_size = args.llm_batch_size or args.batch_size or 0
        payload_args = {
            "corpus": corpus,
            "mode": str(args.mode or "analyze").strip(),
            "incremental": not args.no_incremental,
            "force": args.force,
        }
        if args.rebuild_pdf_markdown:
            payload_args["rebuildPdfMarkdown"] = True
        if str(args.semantic_extraction or "").strip():
            payload_args["semanticExtraction"] = str(args.semantic_extraction).strip()
        if llm_batch_size > 0:
            payload_args["llmBatchSize"] = llm_batch_size
        changed_source_keys = [str(value or "").strip() for value in args.changed_source_key if str(value or "").strip()]
        if changed_source_keys:
            payload_args["changedSourceKeys"] = changed_source_keys

        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "refresh_corpus",
            payload_args,
            timeout=max(60.0, args.request_timeout)
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
