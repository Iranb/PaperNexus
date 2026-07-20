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
| `literature_discovery_progress` | Stable read-only literature-discovery progress and ETA inspection surface. |
| `idea_catalyst` | Stable high-level idea-catalyst surface; optional `selectionMode=topk\|mmr\|submodular\|dpp` post-generation selection is additive and returns `selection_trace` only when requested. |
| `agent_materials` | Additive Agent-facing material backend and project overlay surface. Material operations include `research_material_pack`, `structural_gap_pack`, `innovation_pattern_pack`, `innovation_evidence_pack`, `source_discovery_plan`, `paper_material_view`, `negative_evidence_pack`, `experiment_cost_materials`, `import_requisition_pack`, and `proposal_graph_session`; structural/pattern operations enforce committed evidence -> structural gap -> research action order, mark bounded lineage endpoints as frontier candidates, count persistent assumptions across distinct graph-backed papers, and keep built-in pattern cards labeled as non-empirical seed taxonomy; `innovation_evidence_pack` compiles novelty baselines, gap maps, closest-prior risk signals, mechanism-to-intervention maps, experiment anchors, ResearchStudio-traced idea cards, storyline chains, evidence boundaries, evidence sufficiency, coverage matrix, lexical composition-collision screening, a mechanism-collision query plan, episode-local proposal handoff, provider-to-import priorities, required follow-up actions, and AutoResearch checks without proving novelty or selecting the final idea; `proposal_graph_session` runs episode-local typed proposal graph validation, deterministic action merge, commit gating, and committed proposal artifact synthesis without mutating the raw corpus graph; `evidence_sufficiency.novelty_claim_allowed=false` means consumers must continue approved follow-up research or report a blocker rather than emitting a final novelty claim; provider-only/discovery-only papers are not committed graph evidence until import completion and graph sync; `negative_inconclusive` marks provider 429/timeout/error weakened absence evidence; `ideaComponents` and `coverageAreas` are optional/additive audit inputs; `paper_material_view` and cost materials may expose optional markdown table/figure-caption provenance; `experiment_cost_materials` can explicitly opt in to bounded LLM structured extraction with `includeCostLlmExtraction`; `autoDiscoverSources`, source-router arguments, opt-in `includeProviderEvidence` provider-snippet evidence, opt-in `includeLiveDiscoveryEvidence` idea-catalyst live-discovery evidence, opt-in sparse live-discovery fallback with `runLiveIdeaCatalystIfNeeded`, opt-in `includeLiteratureDiscoveryEvidence` literature-discovery resolve/import readiness, opt-in `literatureDiscoverySeedProviderPapers` provider-to-literature exact seeding, opt-in `literatureDiscoverySeedLivePapers` live-to-literature exact seeding, explicit `submitLiteratureDiscoveryImports` / `processLiteratureDiscoveryImports`, and opt-in provider/live-discovery evidence-cart persistence are optional/additive; overlay operations include `paper_role_overlay`, `evidence_cart`, `workflow_state`, and `research_controller` actions such as configured-provider single-model JSON assistance, graph-only `search-trace.json` / `IdeaSearchState` persistence, top-k/MMR/greedy-submodular selector traces, offline random/fixed/UCB/Thompson source-domain/mechanism bandit proxy comparisons with cost-normalized proxy metrics, bounded innovation brief composition, approval-gated material-request execution with separate provider/live/literature/import opt-in flags, post-evidence decomposition drift surfacing, and `validate_gcd_mvp` validation/retrospective reports, stored outside the raw corpus graph. |
| `mutate_graph` | Write-capable graph mutation surface; keep dry-run semantics stable. |
| `runtime_init` | Write-capable runtime config initialization/update surface. It writes server-side PaperNexus config only; use `create_corpus` for the first committed graph build. |
| `create_corpus` | Write-capable first-corpus creation surface. Source-backed builds may run asynchronously and should be tracked through returned job ids. |
| `refresh_corpus` | Write-capable corpus maintenance surface; keep mode names stable. |
| `refresh_paper_graph` | Write-capable per-paper refresh surface. |

## Skill Wrapper Contract

The canonical Python wrappers under `SKILL/PaperNexus/scripts` are the stable skill-local entrypoints. Specialized skills may re-export them, but should not fork protocol behavior.

Stable wrapper expectations:

- `pn_common.py` owns MCP URL/token handling and JSON-RPC transport.
- `pn_graph_query.py` owns read-only graph query/context/idea workflows.
- `pn_research_chains.py` owns chain and briefing workflows.
- `pn_agent_materials.py` owns Agent material pack, `structural-gap-pack`, `innovation-pattern-pack`, innovation evidence pack, source discovery plan, paper material view, negative evidence, experiment-cost materials, explicit `--include-cost-llm-extraction`, import requisition, `--auto-discover-sources`, graph-native source-router hints, opt-in provider-evidence/live-discovery/literature-discovery evidence, sparse live/literature-discovery fallback, opt-in `--literature-discovery-seed-provider-papers` and `--literature-discovery-seed-live-papers`, explicit literature-discovery import submission/processing, persistence flags, proposal graph sessions, paper role overlay, evidence cart, and workflow state workflows. Its ResearchStudio controls include `--method`, lineage bounds, distinct-paper persistence threshold, pattern limit/cards, candidate mechanism, and removed components.
- `pn_resilient_discovery.py` owns timeout-resilient literature-discovery lane submission, polling, reconciliation, and import queue progress reads through `literature_discovery`, `literature_discovery_progress`, and `import_workflow`. It is additive and should use the read-only progress tool for timer-based wait decisions when available.
- `pn_import_submit.py`, `pn_import_queue.py`, and `pn_batch_import.py` own remote import submission and tracking.
- Skill wrappers should not call private `/api/*` routes for live graph control.
- Skill docs must not embed bearer tokens, server IPs, or user-specific credentials.
- MCP import batching is a server/worker default, not a wrapper protocol: `papernexus serve` defaults to `imports.batchEnabled=true`, `batchProgressive=true`, `batchInitialTasks=4`, `batchMaxTasks=16`, and `batchCoalesceMs=0`; wrappers continue tracking per-task ids.
- `import_workflow` also exposes a durable non-blocking MCP job wrapper: pass `async=true` on a normal operation or call `operation=submit_async` with `asyncOperation`, then poll `operation=async_status` by `jobId`. Optional `idempotencyKey`, project/run identity, a typed status envelope, per-job locking, and restart recovery are additive. Automatic recovery is limited to read/wait operations; ambiguous asynchronous `submit` jobs require manual authority inspection and are never replayed automatically. This remains a client-timeout guard and does not make discovered/imported papers graph-grounded before task completion and authoritative sync.
- `agent_materials` `research_controller.run_round` accepts additive `maxControllerSteps` / `max_controller_steps`. A positive limit executes at most that many missing artifact stages and returns `round_progress` with the next action; omission preserves one-shot behavior.

## Ordered Innovation Evidence Contract

The ResearchStudio-style additions are conservative material-layer contracts:

- `structural_gap_pack` separates additive gaps from subtractive persistent assumptions, labels limited traversal endpoints as `frontier_candidate` with `global_leaf_proven=false`, and emits historical-regression references when validated lineage evidence exists.
- `innovation_pattern_pack` may match only compiled `structural_gap_id` values. Built-in cards always report `source_type=seed_taxonomy` and `empirical_outcome_backed=false`; caller cards need explicit outcome evidence references to claim a stronger origin.
- `innovation_evidence_pack` adds `structural_gap_analysis`, `innovation_pattern_analysis`, `mechanism_collision_audit`, and `proposal_graph_handoff` without removing existing fields. Collision output keeps `semantic_equivalence_checked=false` and `novelty_claim_allowed=false` until a source-backed semantic comparison is performed.
- Candidate mechanisms, pattern applications, threats, and planned experiments remain episode-local proposal evidence. They are not written into the raw corpus graph.

## AutoResearch Graph-of-Evidence Contract

AutoResearch / `$autoreskill` clients may build a local Graph-of-Evidence idea package from PaperNexus outputs without changing the MCP interface. The PaperNexus side remains additive:

- `literature_discovery`, `literature_discovery_progress`, and `import_workflow` provide asynchronous discovery/import state.
- `agent_materials proposal_graph_session`, material views, negative evidence packs, and evidence carts provide source-backed material.
- Skill clients compile those remote outputs into local `.autoreskill/ideation/EVIDENCE_GRAPH_PROJECTION.json`, `IDEA_BUILD_BRIEF.json/md`, `GOE_IDEA_AUDIT.json`, and `IDEA_TRACK_SEEDS.json`.

These `.autoreskill` artifacts are client-side projections. They must not be treated as PaperNexus graph mutations, and they must not require a new MCP schema. A client may mark `unknown_after_timeout`, `async_wait`, `metadata_only`, or `degraded` locally, but graph-grounded claims still require import queue completion plus authoritative sync or explicit split-reading/material evidence.

## Current Harness Changes

The 2026-05-12 harness work is internal/additive:

- Retrieval benchmark run artifacts add `run-manifest.json`, `queries.jsonl`, `per-query-results.jsonl`, `failures.jsonl`, `checkpoint.json`, `time.txt`, `report.json`, and `report.md`.
- Retrieval benchmark CLI adds optional `--run-id`, `--resume`, `--continue-on-error`, `--fixed-corpus-cache-dir`, and `--query-decomposition`.
- LLM extraction can write optional batch ledgers when `llmBatchLedgerDir` is supplied.
- DeepSeek is available through the existing `llm.provider="deepseek"` configuration and existing MCP fields. It uses JSON mode on the OpenAI-compatible chat-completions endpoint, and PaperNexus internally forces DeepSeek LLM extraction to single-item requests because DeepSeek does not support multi-paper batch prompts.
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
