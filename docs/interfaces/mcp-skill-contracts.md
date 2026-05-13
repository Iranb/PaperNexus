# MCP And Skill Contract Guardrails

This document records the public PaperNexus MCP/SKILL surface that should stay stable while benchmark, LLM batch, and Kuzu harness internals evolve.

## Stability Rule

- Existing MCP tool names remain stable.
- Existing required arguments remain required with the same meaning.
- Existing response fields remain present when callers already depend on them.
- New fields must be optional/additive unless a versioned tool or explicit migration note is introduced.
- Skill wrappers should keep their command-line entrypoints stable and route live graph work through remote HTTP MCP.

## Public MCP Tools

The generated reference in `docs/reference/generated/mcp-tools.md` is the source of truth for tool names and argument descriptions. The current public high-level tools are:

| Tool | Contract status |
|---|---|
| `list_corpora` | Stable read-only discovery surface. |
| `corpus_status` | Stable read-only corpus summary surface. |
| `corpus_sources` | Stable read-only source/provenance surface. |
| `query` | Stable graph search surface for already committed corpus state. |
| `context` | Stable graph-neighborhood read surface. |
| `impact` | Stable graph traversal read surface. |
| `ideas` | Stable graph ideation read surface. |
| `brainstorm` | Stable graph brainstorming read surface. |
| `domain_distance` | Stable analytical read surface. |
| `extract_takeaways` | Stable analytical read surface. |
| `interdisciplinary_potential` | Stable analytical read surface. |
| `research_lookup` | Stable high-level remote workflow surface. |
| `research_briefing` | Stable high-level remote briefing surface. |
| `import_workflow` | Stable remote import queue control surface. |
| `literature_discovery` | Stable fresh literature discovery and optional import surface. |
| `idea_catalyst` | Stable high-level idea-catalyst surface. |
| `mutate_graph` | Write-capable graph mutation surface; keep dry-run semantics stable. |
| `refresh_corpus` | Write-capable corpus maintenance surface; keep mode names stable. |
| `refresh_paper_graph` | Write-capable per-paper refresh surface. |

## Skill Wrapper Contract

The canonical Python wrappers under `SKILL/PaperNexus/scripts` are the stable skill-local entrypoints. Specialized skills may re-export them, but should not fork protocol behavior.

Stable wrapper expectations:

- `pn_common.py` owns MCP URL/token handling and JSON-RPC transport.
- `pn_graph_query.py` owns read-only graph query/context/idea workflows.
- `pn_research_chains.py` owns chain and briefing workflows.
- `pn_import_submit.py`, `pn_import_queue.py`, and `pn_batch_import.py` own remote import submission and tracking.
- Skill wrappers should not call private `/api/*` routes for live graph control.
- Skill docs must not embed bearer tokens, server IPs, or user-specific credentials.

## Current Harness Changes

The 2026-05-12 harness work is internal/additive:

- Retrieval benchmark run artifacts add `run-manifest.json`, `queries.jsonl`, `per-query-results.jsonl`, `failures.jsonl`, `checkpoint.json`, `time.txt`, `report.json`, and `report.md`.
- Retrieval benchmark CLI adds optional `--run-id`, `--resume`, `--continue-on-error`, `--fixed-corpus-cache-dir`, and `--query-decomposition`.
- LLM extraction can write optional batch ledgers when `llmBatchLedgerDir` is supplied.
- Graph-v2 verification reports additional telemetry fields.

These changes do not add, remove, or rename public MCP tools or skill wrapper commands.

## Review Checklist For Future Changes

Before changing MCP/SKILL behavior:

1. Compare `src/mcp/tools.js`, `docs/reference/generated/mcp-tools.md`, and the affected `SKILL/**/scripts` wrapper.
2. Classify the change as additive, compatible behavior refinement, or breaking.
3. For additive changes, document the new optional field or argument.
4. For breaking changes, introduce a versioned tool/wrapper path or a migration note before switching callers.
5. Run MCP and wrapper tests that cover the affected surface.
