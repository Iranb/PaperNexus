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


def add_shared_query_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("query")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--layers")


def parse_args():
    parser = argparse.ArgumentParser(description="Query a remote PaperNexus graph over authenticated HTTP MCP.")
    add_connection_args(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    query_parser = subparsers.add_parser("query")
    add_shared_query_options(query_parser)

    context_parser = subparsers.add_parser("context")
    add_shared_query_options(context_parser)
    context_parser.add_argument("--layer-mode", choices=["any", "intra", "cross"])
    context_parser.add_argument("--node-view", choices=["all", "brainstorm"])

    impact_parser = subparsers.add_parser("impact")
    add_shared_query_options(impact_parser)
    impact_parser.add_argument("--direction", choices=["upstream", "downstream"], default="upstream")
    impact_parser.add_argument("--max-depth", type=int)
    impact_parser.add_argument("--layer-mode", choices=["any", "intra", "cross"])
    impact_parser.add_argument("--node-view", choices=["all", "brainstorm"])

    ideas_parser = subparsers.add_parser("ideas")
    add_shared_query_options(ideas_parser)

    brainstorm_parser = subparsers.add_parser("brainstorm")
    add_shared_query_options(brainstorm_parser)
    brainstorm_parser.add_argument("--mode", choices=["diverge", "converge"], default="diverge")
    brainstorm_parser.add_argument("--max-hops", type=int)
    brainstorm_parser.add_argument("--layer-mode", choices=["any", "intra", "cross"])

    return parser.parse_args()


def build_options(args) -> dict:
    options = {}
    for key in ("limit", "layers", "layer_mode", "node_view", "direction", "max_depth", "mode", "max_hops"):
        value = getattr(args, key, None)
        if value is not None:
            option_key = {
                "layer_mode": "layerMode",
                "node_view": "nodeView",
                "max_depth": "maxDepth",
                "max_hops": "maxHops"
            }.get(key, key)
            options[option_key] = value
    return options


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)
        payload = call_mcp_tool_json(
            mcp_url,
            token,
            "research_lookup",
            {
                "operation": args.command,
                **build_graph_payload(corpus, args.query, build_options(args)),
                "corpus": corpus
            },
            timeout=args.request_timeout
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
