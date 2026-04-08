#!/usr/bin/env python3
"""
Resolve the current live PaperNexus corpus name over remote HTTP MCP.
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
    call_mcp_tool,
    emit_result,
    extract_tool_text,
    fail,
    normalize_mcp_url,
    resolve_token,
)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Resolve the current live PaperNexus corpus name over remote HTTP MCP."
    )
    add_connection_args(parser)
    return parser.parse_args()


def parse_corpus_names(text: str) -> list[str]:
    names = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        name = stripped[2:].split(":", 1)[0].strip()
        if name:
            names.append(name)
    return names


def main() -> int:
    args = parse_args()
    try:
        mcp_url = normalize_mcp_url(args.mcp_url, args.api_base)
        token = resolve_token(args.token)
        explicit_corpus = str(args.corpus or "").strip()
        corpora_payload = call_mcp_tool(
            mcp_url,
            token,
            "list_corpora",
            {},
            timeout=args.request_timeout
        )
        corpora_text = extract_tool_text(corpora_payload)
        available = parse_corpus_names(corpora_text)

        primary_graph_name = ""
        resolved_by = ""
        message = ""

        if explicit_corpus:
            primary_graph_name = explicit_corpus
            resolved_by = "explicit-corpus"
            if available and explicit_corpus not in available:
                message = (
                    f'Explicit corpus "{explicit_corpus}" was not listed by the remote server. '
                    f'Available corpora: {", ".join(available)}'
                )
            else:
                message = f'Using explicitly selected corpus "{explicit_corpus}".'
        elif len(available) == 1:
            primary_graph_name = available[0]
            resolved_by = "single-remote-corpus"
            message = f'Remote server exposes one corpus: "{primary_graph_name}".'
        elif not available:
            raise RemoteScriptError("No remote corpora found.")
        else:
            resolved_by = "unresolved-multiple-corpora"
            message = (
                "Multiple remote corpora are available; main graph name is not inferable. "
                "Pass --corpus or set PAPERNEXUS_CORPUS."
            )

        return emit_result({
            "primaryGraphName": primary_graph_name,
            "resolvedBy": resolved_by,
            "availableCorpora": available,
            "message": message,
        }, args.json)
    except RemoteScriptError as exc:
        return fail(str(exc), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
