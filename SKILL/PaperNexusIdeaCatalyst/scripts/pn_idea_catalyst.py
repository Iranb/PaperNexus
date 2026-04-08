#!/usr/bin/env python3
"""
Thin remote HTTP MCP wrapper for the PaperNexus idea_catalyst tool.
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
        description="Run IDEA-CATALYST against a remote PaperNexus HTTP MCP server."
    )
    add_connection_args(parser)
    parser.add_argument("--problem", required=True)
    parser.add_argument("--target-domain", required=True)
    parser.add_argument("--fine-grained-domain", default="")
    parser.add_argument("--coarse-grained-domain", default="")
    parser.add_argument("--num-questions", type=int, default=5)
    parser.add_argument("--num-source-domains", type=int, default=3)
    parser.add_argument("--relevance-threshold", type=int, default=3)
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--mechanisms", action="append", default=[])
    parser.add_argument("--output-mode", choices=["idea_fragments", "packet_bundle"], default="idea_fragments")
    parser.add_argument("--include-analysis", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        request_arguments = {
            "corpus": corpus,
            "problem": args.problem,
            "targetDomain": args.target_domain,
            "fineGrainedDomain": args.fine_grained_domain,
            "coarseGrainedDomain": args.coarse_grained_domain,
            "numQuestions": args.num_questions,
            "numSourceDomains": args.num_source_domains,
            "relevanceThreshold": args.relevance_threshold,
            "limit": args.limit,
            "mechanisms": args.mechanisms,
            "outputMode": args.output_mode,
            "includeAnalysis": args.include_analysis,
        }
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "idea_catalyst",
            request_arguments,
            timeout=max(args.request_timeout, 120.0),
        )
        return emit_result({
            "request": {
                "tool": "idea_catalyst",
                "arguments": request_arguments,
            },
            **payload,
        }, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
