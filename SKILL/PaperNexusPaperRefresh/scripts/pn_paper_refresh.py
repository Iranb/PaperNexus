#!/usr/bin/env python3
"""
Force-refresh one PaperNexus paper over remote HTTP MCP.
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
        description="Force-refresh one PaperNexus paper over remote HTTP MCP."
    )
    add_connection_args(parser)
    parser.add_argument("--paper-id", default="")
    parser.add_argument("--source-key", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--paper-title", default="")
    parser.add_argument(
        "--semantic-extraction",
        choices=["auto", "heuristic-only", "llm-assisted", "llm-primary"],
        default=""
    )
    parser.add_argument("--no-include-duplicate-group", action="store_true")
    parser.add_argument("--no-rebuild-pdf-markdown", action="store_true")
    return parser.parse_args()


def require_selector(args) -> None:
    if any([
        str(args.paper_id or "").strip(),
        str(args.source_key or "").strip(),
        str(args.source or "").strip(),
        str(args.paper_title or "").strip(),
    ]):
        return
    raise RemoteScriptError(
        "Missing paper selector. Pass --paper-id, --source-key, --source, or --paper-title."
    )


def main() -> int:
    args = parse_args()
    try:
        require_selector(args)
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "refresh_paper_graph",
            {
                "corpus": corpus,
                "paperId": str(args.paper_id or "").strip(),
                "sourceKey": str(args.source_key or "").strip(),
                "source": str(args.source or "").strip(),
                "paperTitle": str(args.paper_title or "").strip(),
                "includeDuplicateGroup": not args.no_include_duplicate_group,
                "rebuildPdfMarkdown": not args.no_rebuild_pdf_markdown,
                "semanticExtraction": str(args.semantic_extraction or "").strip() or None,
            },
            timeout=max(600.0, args.request_timeout)
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
