#!/usr/bin/env python3
import argparse
from pn_common import (
    RemoteScriptError,
    add_connection_args,
    build_graph_payload,
    call_mcp_tool_json,
    emit_result,
    fail,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token
)


def add_query_parser(subparsers, name: str) -> argparse.ArgumentParser:
    parser = subparsers.add_parser(name)
    parser.add_argument("query")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--layers")
    return parser


def parse_args():
    parser = argparse.ArgumentParser(description="Run chain and brief lookups against a remote PaperNexus HTTP MCP server.")
    add_connection_args(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    path_trace = subparsers.add_parser("path-trace")
    path_trace.add_argument("from_query")
    path_trace.add_argument("to_query")
    path_trace.add_argument("--max-depth", type=int)
    path_trace.add_argument("--max-paths", type=int)
    path_trace.add_argument("--direction", choices=["any", "incoming", "outgoing"], default="any")
    path_trace.add_argument("--layer-mode", choices=["any", "intra", "cross"])
    path_trace.add_argument("--layers")
    path_trace.add_argument("--node-view", choices=["all", "brainstorm"])

    add_query_parser(subparsers, "evidence-chain")
    add_query_parser(subparsers, "reflection-chain")
    add_query_parser(subparsers, "research-brief")
    add_query_parser(subparsers, "theory-brief")
    add_query_parser(subparsers, "storyline-brief")
    brainstorm_brief = add_query_parser(subparsers, "brainstorm-brief")
    brainstorm_brief.add_argument("--mode", choices=["diverge", "converge"])

    paper = subparsers.add_parser("paper-enhancement")
    paper.add_argument("--paper-id", required=True)

    return parser.parse_args()


def build_query_options(args) -> dict:
    options = {}
    for key in ("limit", "layers", "mode", "layer_mode", "node_view", "max_depth", "max_paths", "direction"):
        value = getattr(args, key, None)
        if value is not None:
            option_key = {
                "layer_mode": "layerMode",
                "node_view": "nodeView",
                "max_depth": "maxDepth",
                "max_paths": "maxPaths"
            }.get(key, key)
            options[option_key] = value
    return options


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)

        if args.command == "paper-enhancement":
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "research_briefing",
                {
                    "operation": "paper_enhancement",
                    "corpus": corpus,
                    "paperId": args.paper_id
                },
                timeout=args.request_timeout
            )
            return emit_result(payload, args.json)

        if args.command == "path-trace":
            payload = call_mcp_tool_json(
                mcp_url,
                token,
                "research_briefing",
                {
                    "operation": "path_trace",
                    "corpus": corpus,
                    "from": args.from_query,
                    "to": args.to_query,
                    "options": build_query_options(args)
                },
                timeout=args.request_timeout
            )
            return emit_result(payload, args.json)

        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "research_briefing",
            {
                "operation": args.command.replace("-", "_"),
                **build_graph_payload(corpus, args.query, build_query_options(args)),
                "corpus": corpus
            },
            timeout=args.request_timeout
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
