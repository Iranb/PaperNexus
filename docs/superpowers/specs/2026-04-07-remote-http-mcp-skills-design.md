# Remote HTTP MCP-Only Skills Design

## Summary

This design migrates all PaperNexus `SKILL` control paths away from authenticated `/api/*` calls and onto a remote HTTP MCP surface only.

The approved direction is the high-level aggregation approach:

- keep PaperNexus remote-only for skill-driven live graph work
- do not allow local stdio MCP or local HTTP MCP as a skill control plane
- replace many fine-grained API calls with a small set of higher-level MCP tools
- keep the existing Python skill wrappers as thin transport adapters so skill ergonomics stay stable
- move expensive multi-step reasoning, queue polling, and idea-catalyst orchestration onto the PaperNexus server side for fewer round trips

## Context

PaperNexus now has two relevant pieces:

- an authenticated HTTP MCP endpoint exposed by `papernexus serve`
- an older skill ecosystem built around authenticated `/api/*` routes and Python wrappers in `SKILL/PaperNexus/scripts/`

Today the skill layer still assumes API-first live graph access:

- `pn_graph_query.py` calls `/api/query`, `/api/context`, `/api/impact`, `/api/ideas`, and `/api/brainstorm`
- `pn_research_chains.py` calls `/api/path-trace`, `/api/evidence-chain`, `/api/reflection-chain`, `/api/theory-brief`, `/api/storyline-brief`, `/api/research-brief`, `/api/brainstorm-brief`, and `/api/paper-enhancement`
- `pn_import_submit.py`, `pn_import_queue.py`, and `pn_batch_import.py` call `/api/imports*`
- `pn_idea_catalyst.py` orchestrates many `/api/*` calls plus ad-hoc LLM fallback behavior

This creates three problems:

- the skill layer does not actually use MCP as the control plane
- API route shape leaks into many wrappers and skill docs
- IDEA-CATALYST and queue polling make too many network round trips for common live workflows

## Goals

- make remote HTTP MCP the only supported live-graph skill control plane
- remove direct `/api/*` dependencies from PaperNexus skill wrappers
- reduce round trips by aggregating related operations into a few high-level MCP tools
- keep the existing skill-local wrapper entrypoints so skill usage stays familiar
- preserve remote file staging through `ssh` and `rsync` where needed, because MCP cannot stage local files by itself
- keep the migration testable and incremental

## Non-Goals

- removing the existing Web API from PaperNexus
- removing local stdio MCP for non-skill internal use and tests
- replacing SSH or rsync staging with MCP transports
- redesigning the core graph query semantics
- redesigning enhancement overlay schemas

## Hard Constraints

### 1. Remote HTTP MCP Only For Skills

Skill-driven live graph work must:

- use `http://` or `https://` MCP URLs only
- send `Authorization: Bearer <token>` headers
- reject stdio MCP and local filesystem-bound control paths

Skill wrappers must not:

- call `/api/*`
- spawn `papernexus mcp`
- talk to local stdio MCP

For production skill usage, wrappers should also reject:

- `http://127.0.0.1/...`
- `http://localhost/...`

This prevents a silent return to local MCP control flow.

Tests may use an internal opt-in override so local fixture servers remain possible.

### 2. High-Level MCP Aggregation

Do not implement a one-to-one API parity layer over MCP for the skill migration.

Instead, expose a smaller set of higher-level tools that match skill workflows directly.

This keeps:

- fewer `tools/call` requests per task
- fewer wrapper-specific request-shape branches
- a clearer long-term control plane

## Recommended MCP Tool Surface

### `research_lookup`

This tool replaces the low-level graph lookup scripts for common live queries.

Operations:

- `query`
- `context`
- `impact`
- `ideas`
- `brainstorm`
- `domain_distance`
- `extract_takeaways`
- `interdisciplinary_potential`

Recommended input shape:

```json
{
  "operation": "query",
  "corpus": "GCD",
  "query": "Open Compound Domain Adaptation",
  "options": {
    "limit": 8,
    "layers": "ProblemLayer,MethodLayer",
    "layerMode": "cross"
  }
}
```

Recommended output shape:

- include `operation`
- include `generatedAt`
- include the typed `result`
- include enough structured payload that wrappers do not need to screen-scrape human text

### `research_briefing`

This tool replaces the typed chain and brief wrappers.

Operations:

- `path_trace`
- `evidence_chain`
- `reflection_chain`
- `paper_enhancement`
- `theory_brief`
- `storyline_brief`
- `research_brief`
- `brainstorm_brief`
- optionally `corpus_meta` if we want one place for reasoning-oriented corpus context

Recommended input shape:

```json
{
  "operation": "reflection_chain",
  "corpus": "GCD",
  "query": "Data Shapley in One Training Run",
  "options": {
    "limit": 5
  }
}
```

For `paper_enhancement`:

```json
{
  "operation": "paper_enhancement",
  "corpus": "GCD",
  "paperId": "iclr2025-oral-data-shapley"
}
```

### `import_workflow`

This tool replaces all direct import queue API calls.

Operations:

- `submit`
- `list`
- `status`
- `log`
- `wait`

Key design choice:

- `wait` should execute server-side blocking polling so clients do not need to loop on `status`

Recommended input shape:

```json
{
  "operation": "submit",
  "corpus": "GCD",
  "serverFilePath": "/tmp/papernexus-import-staging/job-a/paper.pdf",
  "trigger": "mcp"
}
```

For `wait`:

```json
{
  "operation": "wait",
  "corpus": "GCD",
  "taskId": "imp:123",
  "timeout": 1800,
  "interval": 2
}
```

Recommended output shape:

- always include `task` when a single task is involved
- include `log` for `log` and `wait`
- include `deduped` and `submitted` flags for submit
- preserve enough task metadata that the local temp registry can still be maintained client-side

### `idea_catalyst`

This tool replaces the current client-side orchestration in `pn_idea_catalyst.py`.

It should perform, inside PaperNexus:

- target-domain decomposition
- domain-agnostic abstraction
- source-domain matchmaking
- KG sufficiency evaluation
- either brainstorming-idea generation or requisition generation

This should become one MCP tool call instead of many chained query calls plus local wrapper logic.

Recommended input shape:

```json
{
  "corpus": "GCD",
  "problem": "How can we improve open compound domain adaptation under class uncertainty?",
  "targetDomain": "Computer Science",
  "numQuestions": 5,
  "numSourceDomains": 3,
  "relevanceThreshold": 3,
  "limit": 8
}
```

Recommended output:

- preserve the existing “idea fragments or requisition report” branching model
- return machine-readable JSON as the primary payload
- keep exact status signaling for `DATA_STARVATION`

## Service-Side Architecture

### Shared Principle

The new high-level MCP tools should not duplicate the HTTP API controller layer.

Instead:

- keep existing payload builders in `src/server/api.js` as the low-level data functions
- call those builders from the new MCP high-level tool handlers where possible
- add missing shared helpers in lower-level modules only when the existing API builders are too controller-shaped

### New MCP Tool Modules

Recommended file additions:

- `src/mcp/tool-research-lookup.js`
- `src/mcp/tool-research-briefing.js`
- `src/mcp/tool-import-workflow.js`
- `src/mcp/tool-idea-catalyst.js`

Recommended responsibility split:

- keep `src/mcp/core.js` as dispatcher and JSON-RPC surface
- keep `src/mcp/tools.js` as schema declarations only
- put high-level tool business logic in focused modules

This avoids growing `src/mcp/core.js` into another monolith.

## Python Wrapper Strategy

Do not delete the existing wrapper entrypoints.

Instead, turn them into thin HTTP MCP clients:

- `pn_graph_query.py` -> `research_lookup`
- `pn_research_chains.py` -> `research_briefing`
- `pn_import_submit.py`, `pn_import_queue.py`, `pn_batch_import.py` -> `import_workflow`
- `pn_idea_catalyst.py` -> `idea_catalyst`

The wrappers should keep:

- argument parsing
- temp task registry updates
- local file staging through `ssh` and `rsync`
- user-friendly CLI output

The wrappers should stop owning:

- `/api/*` URL construction
- HTTP request-shape knowledge for individual routes
- client-side orchestration of many graph and chain endpoints when a single high-level MCP call can do the job

## Skill Documentation Migration

Every PaperNexus skill doc should be updated to say:

- remote HTTP MCP is the default and only live-graph control plane
- wrappers use `--mcp-url` and `--token`
- wrappers no longer use `--api-base`
- `/api/*` examples are removed from the skill guidance

Affected skills:

- `SKILL/PaperNexus/SKILL.md`
- `SKILL/PaperNexusBatchImport/SKILL.md`
- `SKILL/PaperNexusResearchChains/SKILL.md`
- `SKILL/PaperNexusIdeaCatalyst/SKILL.md`
- `SKILL/PaperNexusReflection/SKILL.md`
- `SKILL/PaperNexusAgenticReasoning/SKILL.md`

## Efficiency Rules

To preserve efficiency:

- wrappers must call `tools/call` directly without prefetching `tools/list`
- `research_lookup` and `research_briefing` should perform internal dispatch server-side
- `import_workflow.wait` should poll server-side
- `idea_catalyst` should do all orchestration in one server-side call
- outputs should be structured enough that wrappers rarely need follow-up requests

## Testing Strategy

### Server Tests

Add MCP tests for:

- `research_lookup` operation dispatch
- `research_briefing` operation dispatch
- `import_workflow` submit/status/log/wait
- `idea_catalyst` success and data-starvation modes
- remote HTTP MCP auth and route behavior

### Wrapper Tests

Migrate Python wrapper tests so they validate:

- wrappers speak HTTP MCP JSON-RPC rather than `/api/*`
- remote-only URL validation works
- local task registry behavior still works
- staging plus `import_workflow submit` still works

### Regression Goal

The migration is successful when:

- all PaperNexus skills can operate on a running remote server without `/api/*`
- live graph control is MCP-only
- local staging still works for PDFs and markdown files
- no skill wrapper needs local stdio MCP

## Risks

### 1. Over-aggregation

If the high-level tools become too broad, they can turn into unstable RPC blobs.

Mitigation:

- keep exactly four high-level workflow tools
- keep operation enums explicit
- keep payload schemas strict

### 2. Server-side wait behavior

Blocking `wait` calls can tie up server work if implemented carelessly.

Mitigation:

- poll lightweight task state only
- bound timeout and interval inputs
- avoid loading full corpus state during waits

### 3. IDEA-CATALYST server complexity

Moving IDEA-CATALYST server-side increases PaperNexus MCP responsibility.

Mitigation:

- keep the implementation isolated in its own module
- reuse existing query and brief builders
- keep output contract identical to the current wrapper where possible

## Acceptance Criteria

- PaperNexus skills use remote HTTP MCP only for live graph control
- no skill wrapper issues `/api/*` requests
- no skill wrapper launches local stdio MCP
- `research_lookup`, `research_briefing`, `import_workflow`, and `idea_catalyst` exist and are covered by tests
- Python wrappers remain stable entrypoints for skill users
- skill docs consistently describe MCP-only remote operation
