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
| `idea_catalyst` | Stable high-level idea-catalyst surface; optional `selectionMode=topk\|mmr\|submodular\|dpp` post-generation selection is additive and returns `selection_trace` only when requested. |
| `agent_materials` | Additive Agent-facing material backend and project overlay surface. Material operations include `research_material_pack`, `source_discovery_plan`, `paper_material_view`, `negative_evidence_pack`, `experiment_cost_materials`, and `import_requisition_pack`; `paper_material_view` and cost materials may expose optional markdown table/figure-caption provenance; `experiment_cost_materials` can explicitly opt in to bounded LLM structured extraction with `includeCostLlmExtraction`; `autoDiscoverSources`, source-router arguments, opt-in `includeProviderEvidence` provider-snippet evidence, opt-in `includeLiveDiscoveryEvidence` idea-catalyst live-discovery evidence, opt-in sparse live-discovery fallback with `runLiveIdeaCatalystIfNeeded`, opt-in `includeLiteratureDiscoveryEvidence` literature-discovery resolve/import readiness, opt-in `literatureDiscoverySeedProviderPapers` provider-to-literature exact seeding, opt-in `literatureDiscoverySeedLivePapers` live-to-literature exact seeding, explicit `submitLiteratureDiscoveryImports` / `processLiteratureDiscoveryImports`, and opt-in provider/live-discovery evidence-cart persistence are optional/additive; overlay operations include `paper_role_overlay`, `evidence_cart`, `workflow_state`, and `research_controller` actions such as configured-provider single-model JSON assistance, graph-only `search-trace.json` / `IdeaSearchState` persistence, top-k/MMR/greedy-submodular selector traces, offline random/fixed/UCB/Thompson source-domain/mechanism bandit proxy comparisons with cost-normalized proxy metrics, bounded innovation brief composition, approval-gated material-request execution with separate provider/live/literature/import opt-in flags, post-evidence decomposition drift surfacing, and `validate_gcd_mvp` validation/retrospective reports, stored outside the raw corpus graph. |
| `mutate_graph` | Write-capable graph mutation surface; keep dry-run semantics stable. |
| `refresh_corpus` | Write-capable corpus maintenance surface; keep mode names stable. |
| `refresh_paper_graph` | Write-capable per-paper refresh surface. |

## Skill Wrapper Contract

The canonical Python wrappers under `SKILL/PaperNexus/scripts` are the stable skill-local entrypoints. Specialized skills may re-export them, but should not fork protocol behavior.

Stable wrapper expectations:

- `pn_common.py` owns MCP URL/token handling and JSON-RPC transport.
- `pn_graph_query.py` owns read-only graph query/context/idea workflows.
- `pn_research_chains.py` owns chain and briefing workflows.
- `pn_agent_materials.py` owns Agent material pack, source discovery plan, paper material view, negative evidence, experiment-cost materials, explicit `--include-cost-llm-extraction`, import requisition, `--auto-discover-sources`, graph-native source-router hints, opt-in provider-evidence/live-discovery/literature-discovery evidence, sparse live/literature-discovery fallback, opt-in `--literature-discovery-seed-provider-papers` and `--literature-discovery-seed-live-papers`, explicit literature-discovery import submission/processing, persistence flags, paper role overlay, evidence cart, and workflow state workflows.
- `pn_import_submit.py`, `pn_import_queue.py`, and `pn_batch_import.py` own remote import submission and tracking.
- Skill wrappers should not call private `/api/*` routes for live graph control.
- Skill docs must not embed bearer tokens, server IPs, or user-specific credentials.
- MCP import batching is a server/worker default, not a wrapper protocol: `papernexus serve` defaults to `imports.batchEnabled=true` and `batchMaxTasks=8`; wrappers continue tracking per-task ids.

## Current Harness Changes

The 2026-05-12 harness work is internal/additive:

- Retrieval benchmark run artifacts add `run-manifest.json`, `queries.jsonl`, `per-query-results.jsonl`, `failures.jsonl`, `checkpoint.json`, `time.txt`, `report.json`, and `report.md`.
- Retrieval benchmark CLI adds optional `--run-id`, `--resume`, `--continue-on-error`, `--fixed-corpus-cache-dir`, and `--query-decomposition`.
- LLM extraction can write optional batch ledgers when `llmBatchLedgerDir` is supplied.
- Graph-v2 verification reports additional telemetry fields.

These changes do not add, remove, or rename public MCP tools or skill wrapper commands.

## Internal Control Fields

The 2026-05-14 engineering-control work is also additive:

- Run registry records may include optional `traceId`, `idempotencyKey`, `attemptId`, `paperIds`, and `terminalReportPath`.
- Run directories may include optional `trace.jsonl`, while global trace spans are written under `.papernexus/traces/`.
- Active graph-v2 authoritative sync writes optional Kuzu commit receipts under `.papernexus/kuzu-receipts/`.
- Idea-Catalyst responses may include optional `run_id`, `trace_id`, and `evidence_export`.
- Live Idea-Catalyst LLM subtasks can write optional batch-ledger rows when `llmBatchLedgerDir` is supplied.

These fields are not required for older clients. Callers that do not need provenance or trace observability can ignore them.

## Review Checklist For Future Changes

Before changing MCP/SKILL behavior:

1. Compare `src/mcp/tools.js`, `docs/reference/generated/mcp-tools.md`, and the affected `SKILL/**/scripts` wrapper.
2. Classify the change as additive, compatible behavior refinement, or breaking.
3. For additive changes, document the new optional field or argument.
4. For breaking changes, introduce a versioned tool/wrapper path or a migration note before switching callers.
5. Run MCP and wrapper tests that cover the affected surface.
