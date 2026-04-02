#!/usr/bin/env python3
import argparse
import urllib.parse

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    build_graph_payload,
    emit_result,
    fail,
    normalize_api_base,
    request_json,
    require_corpus,
    resolve_token
)


def add_shared_query_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("query")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--layers")


def parse_args():
    parser = argparse.ArgumentParser(description="Query a remote PaperNexus graph over the authenticated API.")
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
        api_base = normalize_api_base(args.api_base)
        token = resolve_token(args.token)
        corpus = require_corpus(args.corpus)
        payload = request_json(
            "POST",
            api_base,
            f"/api/{args.command}?name={urllib.parse.quote(corpus)}",
            token,
            payload=build_graph_payload(corpus, args.query, build_options(args)),
            timeout=args.request_timeout
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
