# Resilient MCP Interaction ExecPlan

Created: 2026-06-01 12:00 CST
Updated: 2026-06-01 12:25 CST
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: current working tree
Related docs:
- `SKILL/PaperNexus/SKILL.md`: PaperNexus live work must use remote HTTP MCP, not raw `/api/*` or local graph reads.
- `docs/superpowers/plans/2026-04-07-remote-http-mcp-skills-implementation.md`: Python wrappers are thin shell fallbacks over HTTP MCP.
- `AGENTS.md`: GitNexus impact rules and dirty-worktree safety rules apply.

This ExecPlan is a living document. Update `Progress`, `Surprises & Discoveries`, `Decision Log`, `Artifacts and Notes`, and `Outcomes & Retrospective` as the work proceeds.

Implementers should proceed milestone by milestone without asking for generic next steps unless blocked by a missing decision, missing permission, or unsafe side effect.

## Purpose / Big Picture

After completion, PaperNexus operators can run high-risk discovery/import workflows against the 41-server MCP without treating a 120-second client timeout as success or failure. The user can split source-free GCD ideation discovery into `target`, `near`, and `far` lanes, submit each lane as a background MCP job, persist local transaction state, poll progress/report artifacts, reconcile unknown outcomes, and separately inspect import queue progress before claiming graph visibility.

Current problem:

- Interactive MCP calls such as broad `literature_discovery search`, batch import requisitions, `agent_materials` with literature-discovery/import opt-ins, and inline import processing can exceed client wait limits.
- A timed-out client only proves the client stopped waiting. It does not prove the server did not enqueue work, write progress, or start background discovery/import jobs.
- AutoResearch ideation needs a stable evidence chain: three-lane literature discovery, screening, graph/material-view handoff, evidence pack, and idea gate. That chain currently depends on operator discipline instead of a small recovery harness.

## Progress

- [x] 2026-06-01 12:00 CST Identified high/medium/low timeout-risk MCP operations from the current tool contracts and code paths.
- [x] 2026-06-01 12:00 CST Confirmed existing Python wrappers use remote HTTP MCP via `pn_common.call_mcp_tool_json`.
- [x] 2026-06-01 12:00 CST Refreshed stale GitNexus index with `npx gitnexus analyze`.
- [x] 2026-06-01 12:18 CST Added a local resilient discovery wrapper that keeps a durable ledger and never requires MCP schema changes.
- [x] 2026-06-01 12:21 CST Added tests for submit success, timeout reconciliation state, report polling, and import queue extraction.
- [x] 2026-06-01 12:23 CST Updated PaperNexus skill docs with the timeout-safe interaction policy.
- [x] 2026-06-01 12:24 CST Ran focused tests and Python syntax check.

## Surprises & Discoveries

- Observation: `literature_discovery operation=submit` already persists progress snapshots and returns a `runId`.
  Evidence: `src/mcp/tool-literature-discovery.js` writes queued progress before starting the background task.
  Action: Reuse `submit`, `progress`, `report`, and `list`; do not add a new MCP operation.

- Observation: `import_workflow wait` is intentionally blocking and can wait for downstream authoritative sync.
  Evidence: tool schema and wrapper behavior distinguish `queue_progress`, `status`, `progress`, `log`, and `wait`.
  Action: Use `queue_progress`/`status` for routine reconciliation; reserve `wait` for explicit blocking gates.

- Observation: Current working tree has unrelated dirty files.
  Evidence: `git status --short` reported a modified PDF and untracked `SKILL/PaperNexus/scripts/pn_corpus_refresh 2.py`.
  Action: Do not touch or revert those paths.

## Decision Log

- Decision: Optimize the client-side interaction logic only.
  Rationale: The MCP interface already exposes durable background submission and polling primitives; changing schemas would increase blast radius and break clients.
  Date/Author: 2026-06-01, Codex.

- Decision: Treat transport timeout after a submit attempt as `unknown_after_timeout`.
  Rationale: The server may have accepted and queued work before the client timed out; the only safe next step is remote-state reconciliation.
  Date/Author: 2026-06-01, Codex.

- Decision: Split broad ideation discovery into independent lanes.
  Rationale: `target`, `near`, and `far` lanes reduce per-call latency, improve retry isolation, and map directly to AutoResearch evidence requirements.
  Date/Author: 2026-06-01, Codex.

- Decision: Default to metadata/discovery evidence first, then queue-confirmed graph evidence.
  Rationale: `literature_discovery report` is available before graph ingestion; graph claims require import task `status=completed` and `stage=completed`.
  Date/Author: 2026-06-01, Codex.

## Outcomes & Retrospective

Actual outcome:

- Implemented `pn_resilient_discovery.py` as a client-side, no-schema-change recovery wrapper for background literature discovery lanes.
- Added mock-MCP regression coverage for successful submit/poll/queue and transport-failure `unknown_after_timeout`.
- Updated PaperNexus skill docs so agents use submit/poll/reconcile/queue and do not treat timeouts as success.

Remaining gaps:

- The wrapper has not been exercised against the live 41-server MCP in this implementation pass; tests intentionally use a local mock MCP server.

Lessons for future harness:

- Keep long-running operations behind background submit IDs and durable local state. Client-side timeouts are transport observations, not workflow verdicts.

## Context and Orientation

`SKILL/PaperNexus/scripts/pn_common.py` is the shared Python wrapper transport layer. It normalizes remote MCP URLs, resolves tokens/corpora, calls MCP tools over JSON-RPC, and parses JSON text returned by MCP tool calls.

`SKILL/PaperNexus/scripts/pn_batch_import.py` is the closest existing pattern. It stores import task IDs locally and reads `queue_progress` snapshots instead of assuming that a submitted import is graph-visible.

`src/mcp/tool-literature-discovery.js` is the server-side contract for background discovery. `operation=submit` writes an initial progress record, starts the requested discovery operation in the background, and returns `runId`, `progress`, and suggested `progress/report` calls.

### User-Visible Outcome

- Scenario: a broad three-lane ideation discovery would previously risk a 120-second client timeout.
- Expected behavior: the operator can submit each lane through a durable ledger, poll reports, and reconcile unknown submit outcomes.
- Observation: a ledger JSON file records lane status, request hash, run ID, last result, last error, and import task IDs if present.

### Current State Snapshot

Current code/docs/experiment state:

- `SKILL/PaperNexus/scripts/pn_common.py`: shared remote MCP wrapper utilities.
- `SKILL/PaperNexus/scripts/pn_batch_import.py`: import-side registry and batch progress precedent.
- `SKILL/PaperNexus/SKILL.md`: live graph policy and keyword discovery/graph-lag policy.
- `src/mcp/tool-literature-discovery.js`: existing background submit/progress/report implementation.
- `git status --short`: unrelated modified PDF and untracked duplicate corpus refresh script are present and out of scope.

Existing capabilities:

- Remote HTTP MCP supports `literature_discovery submit/progress/report/list`.
- Remote HTTP MCP supports `import_workflow queue_progress/status/log/wait`.
- Existing wrappers can call MCP tools through `pn_common.call_mcp_tool_json`.

Known gaps:

- Live 41-server validation has not been run in this implementation pass.
- AutoResearch agents that do not load the updated PaperNexus skill docs can still accidentally treat a client timeout or discovery completion as graph sync.

Known constraints and dirty-worktree risks:

- Do not change MCP tool schemas.
- Do not run live graph mutations on 41 during implementation.
- Do not touch unrelated PDF or untracked duplicate script.
- If editing existing indexed symbols, run GitNexus impact first. This plan avoids existing-symbol edits by adding a new wrapper and docs/tests.

### Terms and System Map

- `client timeout`: the local MCP client stops waiting, commonly at 120 seconds; server state is unknown.
- `unknown_after_timeout`: ledger state meaning submit may or may not have been accepted, so reconciliation is required.
- `discovery evidence`: candidate/report data from `literature_discovery`; not necessarily graph-visible.
- `graph evidence`: data safe for `research_lookup`, `research_briefing`, or graph-mode `idea_catalyst`, only after import queue completion.
- `lane`: one independent discovery route, usually `target`, `near`, or `far`.
- `ledger`: local JSON transaction log storing lane requests, run IDs, progress/report snapshots, and import queue task IDs.

## Scope

This plan includes:

- Add a timeout-safe Python wrapper for `literature_discovery` background submit/poll/reconcile/queue inspection.
- Add a deterministic local request hash and run ID policy.
- Add tests using a mock HTTP MCP server, not the live 41 server.
- Document timeout-safe MCP usage for AutoResearch and PaperNexus shell fallback.

## Non-Goals

This plan does not include:

- Changing MCP tool schemas or server-side handler contracts.
- Rewriting `agent_materials`, `research_controller`, or import worker internals.
- Running live 41-server discovery/import jobs as part of tests.
- Marking discovery results as graph-visible before import queue completion.
- Replacing `pn_batch_import.py`.

## Non-Negotiable Rules

1. A 120-second timeout must never be recorded as success.
2. A submit-side transport failure must be recorded as `unknown_after_timeout`, then reconciled with `progress`, `report`, and `list` before retrying.
3. Broad ideation discovery must be split by lane; one failed/slow lane must not hide the state of the others.
4. `processImports`, `ingest`, `import_and_process`, and `import_workflow wait` remain explicit opt-ins because they can block.
5. Graph-readiness claims require import task `status=completed` and `stage=completed`.
6. Tests must use local mock MCP or repository fixtures only.

## Authority / Evidence Model

Direct authority:

- `literature_discovery progress/report`: discovery run state and persisted report state.
- `import_workflow queue_progress/status`: import task state and graph sync readiness.
- Local ledger: client-side transaction history and recovery state.

Evidence only:

- Client stdout/stderr from a timed-out call: evidence that the client stopped waiting, not evidence of server success/failure.
- `literature_discovery report`: discovery evidence, not graph evidence unless linked import tasks completed.

State transition:

```text
submit attempt
  -> ledger lane state: submitted | unknown_after_timeout
  -> progress/report reconciliation
  -> optional import task extraction
  -> import_workflow queue_progress/status
  -> graph-ready state only when task status and stage are completed
```

## Plan of Work

### Phase 0: Context and Contract Inventory

Goal:

- Confirm the existing remote HTTP MCP contracts and wrapper conventions.

Edits:

- No code edits before this plan.

Validation:

- GitNexus index refreshed.
- Existing wrapper and tool contracts inspected.

Risks:

- GitNexus exposes no direct `impact` tool in this session; avoid existing-symbol edits.

Artifacts:

- This ExecPlan.

### Phase 1: Minimal Working Slice

Goal:

- Add a shell fallback wrapper that can submit one or more discovery lanes and keep durable state.

Edits:

- `SKILL/PaperNexus/scripts/pn_resilient_discovery.py`: new wrapper.

Validation:

- `python3 SKILL/PaperNexus/scripts/pn_resilient_discovery.py --json template` emits a stable lane template.
- A mock MCP `literature_discovery submit` success writes a ledger with `submitted` status and `runId`.

Risks:

- The wrapper must not hide validation errors such as missing corpus/token.

Artifacts:

- Ledger JSON under caller-specified `--ledger` or `.papernexus/remote-workflows/<workflow-id>/resilient-discovery-ledger.json`.

### Phase 2: Harness Hardening

Goal:

- Support timeout recovery and graph-readiness separation.

Edits:

- Extend the wrapper with `poll`, `reconcile`, and `queue` commands.

Validation:

- Mock submit failure after request transport error records `unknown_after_timeout`.
- Mock report polling stores the report payload.
- Mock import task extraction calls `import_workflow queue_progress`.

Risks:

- Import task IDs may appear in multiple report shapes; extraction must recursively scan common `taskId` fields.

### Phase 3: Regression and Documentation

Goal:

- Make the behavior discoverable to agents and future operators.

Edits:

- `test/resilient-discovery-wrapper.test.js`: focused wrapper tests with a mock MCP server.
- `SKILL/PaperNexus/SKILL.md`: timeout-safe interaction policy and shell fallback example.

Validation:

- `node --test test/resilient-discovery-wrapper.test.js`

## Implementation Slices

- Slice: ledger skeleton and CLI
  Files: `SKILL/PaperNexus/scripts/pn_resilient_discovery.py`
  Acceptance: `template` and default ledger path behavior work locally; ledger files are created lazily by `submit`.

- Slice: submit and unknown timeout state
  Files: `SKILL/PaperNexus/scripts/pn_resilient_discovery.py`, `test/resilient-discovery-wrapper.test.js`
  Acceptance: success and transport-failure tests pass.

- Slice: poll/reconcile/report and queue progress
  Files: `SKILL/PaperNexus/scripts/pn_resilient_discovery.py`, `test/resilient-discovery-wrapper.test.js`
  Acceptance: report payload and import task progress are persisted.

- Slice: docs
  Files: `SKILL/PaperNexus/SKILL.md`
  Acceptance: docs name high-risk calls and the safe recovery pattern.

## Concrete Steps

1. Add `pn_resilient_discovery.py` with commands `template`, `submit`, `poll`, `reconcile`, and `queue`.
2. Use deterministic run IDs derived from workflow ID, lane name, and canonical request hash.
3. Store all lane changes atomically in a ledger.
4. Use `literature_discovery operation=submit` for long-running search/resolve/run/import work.
5. On `RemoteScriptError` during submit, persist `unknown_after_timeout` and keep the run ID for later reconciliation.
6. Poll with `literature_discovery progress` and `report`; tolerate report absence while a run is still in progress.
7. Extract import task IDs from reports and use `import_workflow queue_progress` for graph-readiness checks.
8. Add mock-MCP tests for all important states.
9. Update docs and run focused tests.

## Validation and Acceptance

Focused validation:

- `node --test test/resilient-discovery-wrapper.test.js`

Expected result:

- Passed on 2026-06-01:
  - `node --test test/resilient-discovery-wrapper.test.js`
  - `node --test --test-name-pattern "PaperNexus skill scripts live" test/python-remote-scripts.test.js`
  - `python3 -m py_compile SKILL/PaperNexus/scripts/pn_resilient_discovery.py`
- Ledger contains deterministic lane state.
- Timeout test records `unknown_after_timeout`, not success.
- Queue test stores import progress separate from discovery report.

Manual smoke validation:

- `python3 SKILL/PaperNexus/scripts/pn_resilient_discovery.py --json template`

Expected result:

- JSON template includes `target`, `near`, and `far` lanes and safe defaults.

## Idempotence and Recovery

Repeated `submit` with the same workflow ID, lane, topic, and options produces the same request hash and run ID. If a lane already has `submitted`, `running`, `completed`, or `report_ready` state, operators should run `poll` or `reconcile` first instead of blind resubmission.

If a submit attempt times out, the ledger keeps enough information to call `progress`/`report` using the deterministic run ID. If the server has no progress/report for that run ID, `reconcile` records that the lane still needs operator review or safe resubmission.

`queue` only reads import queue progress. It does not process imports or wait indefinitely.

## Artifacts and Notes

Planned artifacts:

- `SKILL/PaperNexus/scripts/pn_resilient_discovery.py`: resilient client-side interaction layer.
- `test/resilient-discovery-wrapper.test.js`: mock-MCP regression tests.
- `SKILL/PaperNexus/SKILL.md`: updated operator policy.

## Interfaces and Dependencies

MCP tools consumed without schema changes:

- `literature_discovery`
  - `operation=submit`
  - `operation=progress`
  - `operation=report`
  - `operation=list`
- `import_workflow`
  - `operation=queue_progress`

Python dependencies:

- Python standard library only.
- Existing `pn_common.py` wrapper utilities.

Node test dependencies:

- Built-in `node:test`, `node:assert/strict`, `node:http`, and `node:child_process`.
