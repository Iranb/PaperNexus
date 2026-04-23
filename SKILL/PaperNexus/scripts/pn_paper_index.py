#!/usr/bin/env python3
import argparse

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


def parse_args():
    parser = argparse.ArgumentParser(
        description="Query the remote PaperNexus precise paper index by canonicalId, sourceId, DOI, arXiv ID, PMID, PMCID, ISBN, ISSN, paperId, sourceKey, source path, or exact title."
    )
    add_connection_args(parser)
    parser.add_argument("--paper-id", default="")
    parser.add_argument("--canonical-id", default="")
    parser.add_argument("--source-id", default="")
    parser.add_argument("--source-key", default="")
    parser.add_argument("--source", default="")
    parser.add_argument("--paper-title", default="")
    parser.add_argument("--identifier", default="")
    parser.add_argument("--identifier-type", choices=["doi", "arxivId", "pmid", "pmcid", "isbn", "issn"], default="")
    parser.add_argument("--doi", default="")
    parser.add_argument("--arxiv-id", default="")
    parser.add_argument("--pmid", default="")
    parser.add_argument("--pmcid", default="")
    parser.add_argument("--isbn", default="")
    parser.add_argument("--issn", default="")
    return parser.parse_args()


def build_payload(args, corpus: str) -> dict:
    payload = {
        "operation": "paper_index",
        "corpus": corpus,
    }

    if args.paper_id.strip():
        payload["paperId"] = args.paper_id.strip()
    if args.canonical_id.strip():
        payload["canonicalId"] = args.canonical_id.strip()
    if args.source_id.strip():
        payload["sourceId"] = args.source_id.strip()
    if args.source_key.strip():
        payload["sourceKey"] = args.source_key.strip()
    if args.source.strip():
        payload["source"] = args.source.strip()
    if args.paper_title.strip():
        payload["paperTitle"] = args.paper_title.strip()
    if args.identifier.strip():
        payload["identifier"] = args.identifier.strip()
    if args.identifier_type.strip():
        payload["identifierType"] = args.identifier_type.strip()
    if args.doi.strip():
        payload["doi"] = args.doi.strip()
    if args.arxiv_id.strip():
        payload["arxivId"] = args.arxiv_id.strip()
    if args.pmid.strip():
        payload["pmid"] = args.pmid.strip()
    if args.pmcid.strip():
        payload["pmcid"] = args.pmcid.strip()
    if args.isbn.strip():
        payload["isbn"] = args.isbn.strip()
    if args.issn.strip():
        payload["issn"] = args.issn.strip()

    if len(payload) == 2:
        raise RemoteScriptError(
            "Pass at least one exact selector: --doi, --arxiv-id, --pmid, --pmcid, --isbn, --issn, --paper-id, --canonical-id, --source-id, --source-key, --source, or --paper-title."
        )

    return payload


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
            build_payload(args, corpus),
            timeout=args.request_timeout
        )
        return emit_result(payload, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
