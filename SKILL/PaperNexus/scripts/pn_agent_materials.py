#!/usr/bin/env python3
import argparse
import json

from pn_common import (
    RemoteScriptError,
    add_connection_args,
    call_mcp_tool_json,
    emit_result,
    fail,
    normalize_mcp_url,
    resolve_corpus,
    resolve_token
)


def add_project_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project")
    parser.add_argument("--target-domain")
    parser.add_argument("--target-problem")
    parser.add_argument("--constraint", action="append", default=[])
    parser.add_argument("--role", action="append", default=[])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output-dir")


def add_seed_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--seed-paper-json", action="append", default=[], help="JSON object for one seed paper.")
    parser.add_argument("--seed-papers-file", help="JSON file containing a seed paper array.")


def parse_seed_papers(args) -> list:
    seeds = []
    for raw in getattr(args, "seed_paper_json", []) or []:
        seeds.append(json.loads(raw))
    if getattr(args, "seed_papers_file", None):
        with open(args.seed_papers_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, list):
            seeds.extend(payload)
        elif isinstance(payload, dict) and isinstance(payload.get("seedPapers"), list):
            seeds.extend(payload["seedPapers"])
        else:
            raise RemoteScriptError("--seed-papers-file must contain a JSON array or {seedPapers: [...]}.")
    return seeds


def parse_args():
    parser = argparse.ArgumentParser(description="Assemble Agent-facing PaperNexus research materials over remote HTTP MCP.")
    add_connection_args(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    pack = subparsers.add_parser("research-material-pack")
    add_project_args(pack)
    add_seed_args(pack)

    discovery = subparsers.add_parser("source-discovery-plan")
    add_project_args(discovery)
    add_seed_args(discovery)

    requisitions = subparsers.add_parser("import-requisition-pack")
    add_project_args(requisitions)
    add_seed_args(requisitions)

    paper = subparsers.add_parser("paper-material-view")
    paper.add_argument("--paper-id")
    paper.add_argument("--paper-title")
    paper.add_argument("--source-key")
    paper.add_argument("--identifier")
    paper.add_argument("--doi")
    paper.add_argument("--arxiv-id")
    paper.add_argument("--pmid")
    paper.add_argument("--pmcid")
    paper.add_argument("--chunk-limit", type=int)
    paper.add_argument("--output-dir")

    return parser.parse_args()


def common_payload(args, corpus: str) -> dict:
    payload = {
        "corpus": corpus,
        "project": args.project,
        "targetDomain": args.target_domain,
        "targetProblem": args.target_problem,
        "constraints": args.constraint,
        "roles": args.role,
        "limit": args.limit,
        "outputDir": args.output_dir,
        "seedPapers": parse_seed_papers(args)
    }
    return {key: value for key, value in payload.items() if value not in (None, "", [])}


def paper_payload(args, corpus: str) -> dict:
    payload = {
        "corpus": corpus,
        "paperId": args.paper_id,
        "paperTitle": args.paper_title,
        "sourceKey": args.source_key,
        "identifier": args.identifier,
        "doi": args.doi,
        "arxivId": args.arxiv_id,
        "pmid": args.pmid,
        "pmcid": args.pmcid,
        "chunkLimit": args.chunk_limit,
        "outputDir": args.output_dir
    }
    return {key: value for key, value in payload.items() if value not in (None, "", [])}


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        corpus = resolve_corpus(args.corpus, mcp_url, token, timeout=args.request_timeout)

        operation = args.command.replace("-", "_")
        payload = paper_payload(args, corpus) if operation == "paper_material_view" else common_payload(args, corpus)
        payload["operation"] = operation

        result = call_mcp_tool_json(
            mcp_url,
            token,
            "agent_materials",
            payload,
            timeout=args.request_timeout
        )
        return emit_result(result, args.json)
    except (RemoteScriptError, json.JSONDecodeError) as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
