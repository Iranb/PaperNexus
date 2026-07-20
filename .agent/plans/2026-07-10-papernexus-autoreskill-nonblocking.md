# Make PaperNexus Non-Blocking for AutoResearch ExecPlan

Created: 2026-07-10 16:43 CST
Updated: 2026-07-10 16:58 CST
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `main` at baseline `d3d0018`, with pre-existing uncommitted user changes that must be preserved
Related docs:

- `AGENTS.md`: requires GitNexus impact analysis before symbol edits and change detection before commit.
- `docs/pipeline/imports-and-queue.md`: public import queue and worker behavior.
- `docs/agent-materials/research-controller-skill.md`: public research-controller workflow.
- `src/mcp/tools.js`: authoritative MCP input-schema declarations.

This ExecPlan is a living document. Future implementers must be able to continue from the current repository state and this file without relying on chat history. Update `Progress`, `Surprises & Discoveries`, `Decision Log`, `Artifacts and Notes`, and `Outcomes & Retrospective` after each material change or failed assumption. Proceed milestone by milestone without asking for generic next steps unless blocked by a missing decision, missing permission, or unsafe external side effect.

No repository-level `PLANS.md` was present when this plan was created. This file therefore follows the `execplan-builder` content contract directly.

## Purpose / Big Picture

After completion, an AutoResearch conductor can submit potentially slow PaperNexus import/status work without holding one MCP request open, observe a stable typed status, survive a PaperNexus process restart for replay-safe work, and advance a long `research_controller.run_round` in bounded resumable steps. Operators can distinguish a live HTTP process from an authenticated MCP service that is ready to accept work.

The observable success scenario is:

1. Call `import_workflow` with `operation=submit_async`, a replay-safe `asyncOperation`, and an `idempotencyKey`. The call returns promptly with a job id and `statusEnvelope`.
2. Repeating the same request with the same key returns the same job instead of creating duplicate work. Reusing the key with different arguments fails explicitly.
3. If the process dies after a replay-safe job is queued or running, the serve recovery worker discovers and resumes it. It never automatically replays `asyncOperation=submit`, because that can create an external import task twice.
4. `GET /livez` responds without API authentication, while authenticated `GET /api/readyz` reports MCP and recovery-worker readiness.
5. `agent_materials` with `operation=research_controller`, `action=run_round`, and `maxControllerSteps=1` performs at most one missing stage, returns a checkpoint naming the next action, and can be called repeatedly until the existing full export result is returned.

Current problem:

- AutoResearch currently treats PaperNexus as one large blocking dependency even when the active research task has already moved to writing, idea-gate cleanup, or implementation.
- The existing async wrapper persists a JSON record but starts execution only through in-process `setImmediate`; a restart leaves queued/running records orphaned.
- The synchronous `run_round` can execute decomposition, candidate generation, judging, evidence expansion, solution composition, review, and export in one call.
- The service exposes only an authenticated coarse `/api/health`, so transport reachability, MCP readiness, and worker recovery are conflated.
- Some previously suspected response-size pressure is already reduced by uncommitted candidate-report pagination work; duplicating that edit would risk overwriting user changes.

## Progress

- [x] 2026-07-10 16:12 CST Audited the three active AutoResearch task states and separated current local blockers from historical PaperNexus blockers.
- [x] 2026-07-10 16:20 CST Audited the repository, dirty worktree, tool schemas, workers, controller, HTTP routes, and relevant tests.
- [x] 2026-07-10 16:27 CST Ran the baseline targeted suite: 118 tests passed, 0 failed across import workflow, literature discovery, MCP HTTP, and HTTP auth.
- [x] 2026-07-10 16:35 CST Ran GitNexus impact analysis. `executeImportWorkflowTool` is CRITICAL (3 direct callers, 5 execution flows); `serveCommand` is MEDIUM (7 direct callers, 1 process); async helpers and `executeRunRound` are LOW. The implementation must stay additive and preserve default behavior.
- [x] 2026-07-10 16:43 CST Compared the initial diagnosis with current code and optimized the implementation into three independently testable slices.
- [x] 2026-07-10 16:47 CST Implemented durable/idempotent async import jobs, per-job locks, typed status, and restart recovery; focused import tests passed 21/21.
- [x] 2026-07-10 16:50 CST Implemented liveness/readiness endpoints and wired the recovery worker into `serveCommand`; HTTP/MCP tests passed.
- [x] 2026-07-10 16:51 CST Implemented bounded resumable `research_controller.run_round`; controller tests passed 17/17, including one-step convergence to export.
- [x] 2026-07-10 16:53 CST Synchronized schemas, example config, generated docs, interface docs, and focused recovery/deduplication/route/checkpoint tests.
- [x] 2026-07-10 16:58 CST Targeted regression passed 141/141; full `npm test` passed 970 with 0 failures and 2 skips; `git diff --check` and syntax checks passed.
- [x] 2026-07-10 16:58 CST Ran GitNexus change detection and reviewed the intended import-workflow, serve, and research-controller flows separately from pre-existing Firecrawl/pagination changes.
- [x] 2026-07-10 16:58 CST Backfilled actual outcomes, residual risks, validation evidence, and final audit score.

## Surprises & Discoveries

- Observation: the three sampled AutoResearch tasks are not all currently waiting on PaperNexus.
  Evidence: GCD is at submission-ready writing/review with 61/67 PaperNexus sources synchronized and six source debts; ContinueGCD is at idea-gate with legacy v2 schema debt and stale snapshots; DomainGCD has moved to code/baseline-manifest work after an explicitly approved degraded evidence gate.
  Action: make the status contract identify the blocking scope so the conductor does not project a historical PaperNexus wait onto the current stage.

- Observation: the configured remote `10.126.56.41` responded to network ping during diagnosis, but HTTP and SSH application handshakes did not complete.
  Evidence: network-layer reachability existed while application-layer calls timed out.
  Action: provide separate liveness and authenticated readiness observations; do not deploy or mutate the remote host in this plan.

- Observation: candidate-report pagination is already present in the dirty worktree in `src/mcp/tool-literature-discovery.js`, `src/mcp/tools.js`, and `test/literature-discovery.test.js`.
  Evidence: `includeCandidates`, `candidateOffset`, `candidateLimit`, and `candidateView` plus a passing pagination test are already implemented.
  Action: count pagination as an existing capability, validate it, and avoid rewriting those symbols.

- Observation: PaperNexus already has atomic JSON writes and a heartbeat-backed file lock in `src/lib/fs.js`.
  Evidence: `writeJson` is atomic and `withFileLock` supports timeout, heartbeat, and stale-lock recovery.
  Action: reuse these primitives for cross-process job ownership rather than introduce a new database or queue dependency.

- Observation: the full suite emits substantial pre-existing registry-reconcile warnings for stale temporary/user registry roots, but they are not test failures.
  Evidence: final test summary was 970 passed, 0 failed, 2 skipped despite the warnings.
  Action: use test exit status and summary as authority; leave registry cleanup outside this plan because it would mutate unrelated user state.

- Observation: GitNexus change detection reports aggregate CRITICAL risk because the worktree contains this implementation together with earlier Firecrawl, ingestion, MCP, and pagination edits.
  Evidence: detection found 253 changed symbols, 47 affected processes, and 35 changed files; the relevant intended flows include import-workflow execution, `serveCommand`, and `executeRunRound`.
  Action: record the aggregate risk instead of claiming an isolated clean diff; rely on pre-edit symbol impact, focused tests, and the full suite for this slice.

## Decision Log

- Decision: preserve the existing synchronous import operations and the v1 top-level async job shape, adding fields instead of changing defaults.
  Rationale: `executeImportWorkflowTool` is CRITICAL and is shared by stdio MCP, HTTP MCP, CLI, and tests. AutoResearch can adopt the safer async path without breaking existing clients.
  Date/Author: 2026-07-10 / Codex

- Decision: automatically recover only replay-safe operations (`list`, `status`, `progress`, `queue_progress`, `log`, and `wait`). Stale async `submit` jobs become `manual_recovery_required`.
  Rationale: repeating an import submission may create duplicate external work. A durable system must prefer a visible manual blocker over an invisible duplicate side effect.
  Date/Author: 2026-07-10 / Codex

- Decision: add a caller-supplied idempotency key with a canonical request fingerprint and deterministic job id.
  Rationale: file locks prevent two workers from executing one job, but they do not prevent two retrying clients from creating two jobs. Key plus fingerprint closes that gap without a new datastore.
  Date/Author: 2026-07-10 / Codex

- Decision: bound `run_round` by number of actually executed missing stages, with no limit when `maxControllerSteps` is omitted.
  Rationale: the additive option makes AutoResearch calls resumable while preserving every existing caller and test that expects one-shot completion.
  Date/Author: 2026-07-10 / Codex

- Decision: keep workers in the existing serve process in this slice and record process isolation as a follow-up.
  Rationale: a separate worker executable and supervisor contract is a larger deployment change. Recovery, bounded calls, and health semantics provide immediate value with a reversible patch, but they cannot prove liveness during a CPU-bound event-loop stall.
  Date/Author: 2026-07-10 / Codex

## Outcomes & Retrospective

Actual outcome:

- Asynchronous import-workflow calls now support stable idempotency keys, canonical request fingerprints, deterministic keyed job ids, per-job execution locks, attempt/recovery metadata, and an additive typed status envelope.
- A serve-side recovery worker scans stale jobs. Read/wait operations resume; ambiguous mutating `submit` work becomes `manual_recovery_required` without invoking submission.
- `GET /livez` is a minimal public process observation; authenticated `GET /api/readyz` reports MCP configuration, root counts, and recovery-worker state.
- `research_controller.run_round` accepts an optional positive stage budget and returns durable checkpoints until the normal export completes. Omitted limits preserve the previous one-shot response.
- Public schemas, generated reference docs, config examples, queue/controller contracts, and schema snapshots were synchronized.
- Validation completed with 141/141 focused tests and 970 passed, 0 failed, 2 skipped in the full suite.

Remaining gaps:

- OS-process isolation between HTTP/MCP serving and background workers is intentionally deferred.
- Exact identifier-first literature ingestion and a separate discovery-versus-evidence-closure policy require broader provider and AutoSkill contract changes.
- No remote deployment or live production migration is authorized by this plan.

Lessons for future harness:

- Durable JSON alone is not a durable job system; ownership locks, a startup scanner, replay classification, and request deduplication are all required.
- Liveness, readiness, and workflow completion must remain separate authorities.
- Artifact-driven controllers become transport-resilient with a small additive stage budget; no second controller state machine was needed.
- A dirty worktree makes aggregate impact reports conservative. Future large changes should start on an isolated branch/worktree when possible, but this execution correctly preserved the user's existing edits.

## Context and Orientation

### User-Visible Outcome

- AutoResearch sees a short-lived submit response and polls a durable job record instead of holding a six-to-thirty-minute tool call.
- Operators can tell “the process answers HTTP” (`/livez`) from “the authenticated MCP surface is configured and recovery state is observable” (`/api/readyz`).
- A long research round can be checkpointed after each expensive stage, so a timeout does not discard already committed controller artifacts.
- Existing synchronous clients and existing one-shot `run_round` calls behave exactly as before unless the new options are supplied.

### Current State Snapshot

Current code and roles:

- `src/mcp/tool-import-workflow.js`: normal import operations, v1 JSON async job wrapper, and polling. Jobs are atomically written but have no startup scanner or per-job execution lock.
- `src/lib/fs.js`: atomic JSON and cross-process heartbeat file locking.
- `src/server/http.js`: HTTP/MCP server plus enhancement, synchronization, import, discovery-recovery, and registry workers in one Node.js process.
- `src/core/materials/research-controller.js`: artifact-driven, mostly idempotent controller stages; `executeRunRound` currently chains all missing stages.
- `src/mcp/tools.js`: public schemas for `import_workflow` and `agent_materials`.
- `test/tool-import-workflow.test.js`, `test/http-auth.test.js`, `test/mcp-http.test.js`, and `test/agent-materials-tool.test.js`: primary regression surfaces.
- `test/fixtures/mcp-tools-schema.snapshot.json`: public MCP schema snapshot; currently dirty because of unrelated user work and must be updated without discarding those changes.

Baseline proof:

    node --test test/tool-import-workflow.test.js test/literature-discovery.test.js test/mcp-http.test.js test/http-auth.test.js

Current result: 118 passed, 0 failed.

Plan-versus-code gap analysis:

| Expected capability | Current code | Gap | Optimized plan response |
|---|---|---|---|
| Non-blocking import interaction | Async submit/status/wait exists | Execution is tied to `setImmediate`; restart orphans jobs | Durable job lock, recovery scan, typed envelope |
| Retry without duplicate jobs | Random job id on every submit | Client retry creates a new job | Idempotency key plus fingerprint and deterministic id |
| Safe restart behavior | JSON records survive | No owner/recovery semantics; mutating replay risk | Replay-safe allowlist; unsafe submit becomes manual blocker |
| Distinguish transport/process readiness | Authenticated `/api/health` only | Liveness, auth, MCP config, and recovery conflated | Public minimal `/livez`; authenticated detailed `/api/readyz` |
| Bound controller latency | Artifact checks make stages resumable | One call still chains all missing stages | Optional `maxControllerSteps`; checkpoint with next action |
| Bound large discovery response | Candidate pagination present in dirty worktree | No further code gap in this slice | Preserve and regression-test existing work |
| True worker isolation | All workers share server process | CPU/event-loop failure can still hide `/livez` | Explicit follow-up; not falsely claimed solved |
| Discovery recall separated from evidence closure | Mixed downstream policies | Requires AutoSkill/provider policy coordination | Follow-up contract, not an unsafe local guess |

Expectation-fit audit and optimization:

- The initial broad idea—make everything asynchronous, split every worker process, reduce all timeouts, and relax all evidence gates—would touch multiple public contracts and deployment assumptions at once. It would be hard to roll back and could replay paid or duplicate import work.
- The optimized plan addresses the demonstrated stall mechanisms first: durable ownership, restart recovery, retry deduplication, status truth, bounded controller calls, and observable readiness.
- It intentionally does not claim that same-process `/livez` survives an event-loop stall. That expectation is only fully met after a supervised process split.
- It intentionally does not change the existing 1,800-second synchronous `wait` default. The new AutoResearch contract is to use async submit/status with bounded client polling, avoiding a critical-path compatibility break.
- Therefore this slice fully satisfies recoverable non-blocking orchestration and status observability, partially satisfies fault isolation, and leaves evidence-policy semantics to a separately reviewable AutoSkill/PaperNexus integration plan.

### Terms and System Map

- Async import job: a PaperNexus-owned JSON record describing one invocation of a normal `import_workflow` operation.
- Replay-safe: an operation that only reads or waits for existing state and can be repeated after a crash without creating a second import task.
- Status envelope: an additive normalized projection used by AutoResearch to classify active wait, completion, failure, or manual recovery.
- Controller checkpoint: a normal response emitted when a bounded `run_round` used its stage budget before the round was complete.
- Direct authority: the durable artifact that alone decides current state; logs and health snapshots are observations, not completion authorities.

System flow:

    AutoResearch conductor
      -> import_workflow submit_async
      -> durable JSON job + per-job lock
      -> normal import_workflow operation
      -> import task store / graph state
      -> async_status statusEnvelope

    AutoResearch conductor
      -> agent_materials research_controller run_round(maxControllerSteps=N)
      -> existing controller artifacts after each stage
      -> checkpoint or existing export response

## Scope

This plan includes:

- Additive async-job idempotency, execution locks, attempt metadata, typed status, recovery scanning, and a serve recovery worker.
- Public `/livez` and authenticated `/api/readyz` routes with focused tests.
- Additive `maxControllerSteps` and resumable checkpoint responses for `research_controller.run_round`.
- MCP schemas, generated schema snapshot/docs, and focused plus full regression tests.
- Documentation for which operations may or may not be automatically replayed.

## Non-Goals

This plan does not include:

- Deploying, restarting, or modifying the remote PaperNexus host.
- Splitting HTTP, MCP, import, discovery, and controller execution into separately supervised OS processes.
- Replacing JSON job storage with Redis, SQLite, PostgreSQL, or an external queue.
- Automatically replaying an async import `submit` after ambiguous failure.
- Removing or shortening synchronous operations used by existing clients.
- Reworking exact-identifier literature ingestion, provider recall, graph evidence gates, or AutoSkill stage policy.
- Cleaning, reverting, staging, committing, or publishing unrelated dirty-worktree changes.

## Non-Negotiable Rules

1. Public changes are additive. Omitted new fields/options preserve existing behavior and response fields.
2. A durable job file is the authority for async wrapper state; the underlying import task store remains the authority for import completion and graph visibility.
3. At most one process executes a job at a time. An unsafe mutating job is never automatically retried after ambiguous `running` state.
4. Idempotency-key reuse with a different canonical request must fail loudly.
5. `/livez` reveals no corpus names, paths, task ids, credentials, or worker details. `/api/readyz` remains API-token protected.
6. A bounded controller call counts only stages it actually invokes; already-present artifacts do not consume the budget.
7. Preserve all pre-existing user edits. Use surgical patches and verify the combined diff.
8. No remote, paid, destructive, deployment, commit, or push action is part of execution.

## Authority / Evidence Model

Direct authority:

- `mcp-jobs/import-workflow/<jobId>.json`: async wrapper state (`queued`, `running`, `completed`, `failed`, or `manual_recovery_required`).
- Existing import task records loaded by `src/storage/import-store.js`: actual import/graph-readiness state.
- Existing research-controller artifacts under the project overlay: which controller stages are complete and what the next missing stage is.

Evidence only:

- `/livez`: proof that this Node.js HTTP loop answered one request.
- `/api/readyz`: snapshot of configuration and recovery-worker health; it does not declare a job complete.
- Worker logs, test output, and `statusEnvelope`: compact observations derived from direct authorities.

State transitions:

    async request + idempotency key
      -> durable queued job
      -> locked running job
      -> completed / failed job
      -> statusEnvelope shown to AutoResearch

    stale queued/running job
      -> recovery scanner
      -> replay-safe: locked re-execution
      -> unsafe submit: manual_recovery_required

    controller artifacts
      -> next missing stage decision
      -> at most maxControllerSteps executions
      -> checkpoint or export result

## Plan of Work

### Phase 0: Context and Contract Inventory

Goal:

- Establish the current blocking mechanisms, existing capabilities, dirty worktree, public contracts, test baseline, and symbol blast radius.

Edits:

- This ExecPlan only.

Validation:

- Baseline targeted tests pass 118/118.
- GitNexus impact results are recorded in `Progress` and `Artifacts and Notes`.

Risks:

- Confusing historical PaperNexus debt with the active AutoResearch stage would optimize the wrong bottleneck.

Artifacts:

- `.agent/plans/2026-07-10-papernexus-autoreskill-nonblocking.md`: self-contained diagnosis, gap matrix, optimized plan, and execution ledger.

### Phase 1: Durable Non-Blocking Import Slice

Goal:

- Make async read/wait operations restart-recoverable and caller retries deduplicated without changing synchronous behavior.

Edits:

- `src/mcp/tool-import-workflow.js`: canonical request fingerprints, deterministic idempotent job ids, per-job locks, attempt/recovery metadata, status envelopes, replay-safe recovery scanner, and exported recovery worker.
- `src/mcp/tools.js`: additive `idempotencyKey`, project/workflow identity fields, and descriptions of recovery behavior.
- `test/tool-import-workflow.test.js`: duplicate-key, fingerprint conflict, stale replay-safe recovery, and unsafe stale submit tests.

Validation:

    node --test test/tool-import-workflow.test.js

Expected result: existing async tests remain green; new tests prove same-key dedupe, conflict rejection, single-owner execution, replay-safe recovery, and manual recovery for stale submit.

Risks:

- A lock timeout could be mistaken for execution failure. Mitigation: leave the durable in-progress record intact and let status/recovery retry ownership later.
- Auto-replaying a mutating submit could duplicate work. Mitigation: explicit replay-safe allowlist and terminal manual-recovery state.

Artifacts:

- Runtime job JSON files and adjacent lock directories in the configured async job root.

### Phase 2: Observable Service and Bounded Controller Slice

Goal:

- Expose truthful health boundaries and prevent one `run_round` request from chaining an unbounded number of missing stages.

Edits:

- `src/server/http.js`: start/stop import recovery with serve, add public `/livez`, add authenticated `/api/readyz`, and expose worker snapshot without treating it as completion authority.
- `src/core/materials/research-controller.js`: optional stage budget, deterministic next-action calculation, and checkpoint response.
- `src/mcp/tools.js`: document `maxControllerSteps` and new identity inputs.
- `test/http-auth.test.js` and/or `test/mcp-http.test.js`: auth and response-shape tests.
- `test/agent-materials-tool.test.js`: one-step checkpoint/resume test and unchanged one-shot regression.

Validation:

    node --test test/http-auth.test.js test/mcp-http.test.js
    node --test test/agent-materials-tool.test.js

Expected result: `/livez` succeeds without a token, `/api/readyz` rejects missing/wrong tokens and reports readiness with a valid token, and bounded rounds advance no more than the requested number of stages.

Risks:

- Same-process liveness can still be masked by a blocked event loop. Mitigation: state the limitation in docs and avoid presenting `/livez` as process-isolation proof.
- A checkpoint could misname the next stage. Mitigation: derive it from the same artifact predicates that gate stage execution and test repeated resume to completion.

Artifacts:

- HTTP JSON responses and controller checkpoint responses captured by tests.

### Phase 3: Contract, Regression, and Documentation Closure

Goal:

- Synchronize public schemas/docs, prove no regression across the repository, and leave an auditable handoff.

Edits:

- `docs/pipeline/imports-and-queue.md`: document async idempotency, replay-safe recovery, health semantics, and unsafe replay behavior while preserving existing edits.
- `docs/agent-materials/research-controller-skill.md`: document bounded round continuation.
- `docs/reference/generated/mcp-tools.md` and `test/fixtures/mcp-tools-schema.snapshot.json`: regenerate/refresh public schema artifacts while preserving unrelated changes.
- This ExecPlan: mark actual results, surprises, residual risks, and audit score.

Validation:

    npm run docs:generate
    node --test test/mcp-schema-snapshot.test.js
    npm test
    git diff --check
    npx gitnexus detect-changes

Expected result: generated docs and snapshot agree with schemas; the full suite passes; whitespace checks pass; GitNexus reports only intended execution-flow changes in addition to pre-existing user work.

## Implementation Slices

- Slice: Durable import job contract
  Files: `src/mcp/tool-import-workflow.js`, `src/mcp/tools.js`, `test/tool-import-workflow.test.js`
  Acceptance: stale replay-safe job completes after recovery; stale submit becomes manual recovery; same idempotency key never creates a second job.

- Slice: Health boundary
  Files: `src/server/http.js`, `test/http-auth.test.js`, `test/mcp-http.test.js`
  Acceptance: unauthenticated `/livez` is minimal; `/api/readyz` is protected and includes MCP plus recovery snapshot.

- Slice: Bounded controller
  Files: `src/core/materials/research-controller.js`, `src/mcp/tools.js`, `test/agent-materials-tool.test.js`
  Acceptance: `maxControllerSteps=1` executes at most one missing controller stage and repeated calls reach the same terminal export as an unlimited call.

- Slice: Contract closure
  Files: queue/controller docs, generated reference, schema snapshot, this ExecPlan
  Acceptance: schema snapshot and full suite pass; actual outcome is recorded.

## Concrete Steps

Run from `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`:

1. Preserve the current dirty-worktree inventory with `git status --short` and inspect overlapping diffs before every patch.
2. Patch the durable job implementation and its focused tests; run `node --test test/tool-import-workflow.test.js`.
3. Patch server health/recovery wiring and tests; run `node --test test/http-auth.test.js test/mcp-http.test.js`.
4. Patch bounded controller behavior and tests; run `node --test test/agent-materials-tool.test.js`.
5. Update schema descriptions and documentation; refresh generated schema artifacts with the repository script.
6. Run:

       npm run docs:generate
       node --test test/mcp-schema-snapshot.test.js
       npm test
       git diff --check

7. Run GitNexus change detection through the configured GitNexus tool or `npx gitnexus detect-changes`, record the output, and do not commit unless separately requested.

Expected:

- All new behavior is additive and focused tests prove each slice independently.
- The full suite passes with no unexpected change to existing one-shot behavior.
- No remote system is contacted or mutated during implementation validation.
- Pre-existing dirty files retain their unrelated changes.

## Validation and Acceptance

This ExecPlan is complete when:

- [x] `submit_async` returns promptly with the existing v1 fields plus a typed `statusEnvelope`.
- [x] Same idempotency key plus same request resolves to one job; same key plus different request returns an explicit error.
- [x] A replay-safe stale job is resumed under a per-job lock, and a stale `submit` is marked `manual_recovery_required` without invoking submission.
- [x] `/livez` is unauthenticated and minimal; `/api/readyz` is authenticated and reports MCP/recovery state.
- [x] `maxControllerSteps=1` produces resumable checkpoints and existing unlimited `run_round` remains compatible.
- [x] Existing candidate pagination still passes its regression test.
- [x] MCP schema snapshot and generated docs match the additive contract.
- [x] Focused tests, full `npm test`, and `git diff --check` pass.
- [x] GitNexus change detection was reviewed; aggregate CRITICAL scope is attributable to the combined pre-existing dirty worktree, while this slice's intended import, serve, and controller flows are covered by focused and full regression tests.
- [x] `Outcomes & Retrospective` records actual results and all residual gaps are explicit.

## Idempotence and Recovery

Repeatable commands:

- All focused `node --test ...` commands, `npm test`, `npm run docs:generate`, and `git diff --check` are safe to repeat locally.
- Recovery scanning is safe to repeat because each job is protected by its own file lock and terminal jobs are skipped.
- Repeating a keyed async request is safe only when the canonical fingerprint matches; the existing job is returned.
- Repeating bounded `run_round` is safe because existing controller artifacts skip completed stages and only missing stages consume the supplied budget.

Checkpoint / ledger / manifest:

- `.agent/plans/2026-07-10-papernexus-autoreskill-nonblocking.md`: implementation progress and proof ledger.
- `<runtime-root>/mcp-jobs/import-workflow/<jobId>.json`: async job checkpoint and terminal state.
- Existing project research-controller artifact directory: per-stage durable controller checkpoints.

Resume:

- Inspect `git status --short` and this file's first unchecked `Progress` item.
- Run the focused test for the current slice before continuing.
- For async runtime work, call `async_status` by job id or let the recovery worker scan stale jobs.
- For a bounded controller round, repeat the same `run_round` inputs; do not manually fabricate stage artifacts.
- Skip a job when its durable status is terminal. Skip a controller stage when its authority artifact already satisfies the stage predicate.

Must not retry automatically:

- `import_workflow` `asyncOperation=submit` after a process died while its job was `running`.
- Any remote deployment, paid provider call, destructive cleanup, commit, push, or production restart.

Cleanup and repair:

- A failed test may remove only its temporary job/corpus directory.
- An operator may resolve `manual_recovery_required` only after inspecting the underlying import task list for a matching request; this plan does not automate that decision.
- Stale lock directories are reclaimed only through the existing `withFileLock` stale-lock policy.

## Risks and Rollback

| Risk | Signal | Mitigation | Rollback |
|---|---|---|---|
| Critical public import path regression | Existing import/MCP/CLI tests fail | Additive fields, unchanged default sync path, focused then full suite | Revert only this plan's import-workflow hunks; persisted v1 JSON remains readable |
| Duplicate import submission after crash | Two underlying tasks or ambiguous stale mutating job | Never auto-replay `submit`; manual-recovery terminal status | Disable recovery worker and inspect task authority before any manual action |
| Two processes execute one job | Attempt count increments concurrently or duplicated logs | Per-job `withFileLock` ownership and terminal-state re-read inside lock | Stop recovery worker; existing JSON remains available for status |
| Idempotency collision/misuse | Same key has a different fingerprint | Deterministic scoped id plus exact fingerprint rejection | Omit key to retain random-job behavior, or choose a new key intentionally |
| Readiness leaks internal data | Public route contains paths/tasks | Keep `/livez` minimal; authenticate `/api/readyz` | Remove only the new routes without affecting MCP |
| Checkpoint returns wrong next action | Repeated bounded call stalls or skips stage | Share artifact predicates; repeated-resume test | Omit `maxControllerSteps` to use the unchanged one-shot path |
| Same-process event-loop stall remains | `/livez` also times out during CPU/blocking work | Explicit limitation; future supervised process split | No code rollback fixes this structural risk; follow-up architecture work is required |
| Dirty worktree overwrite | Unrelated diff disappears or broad generated rewrite appears | Inspect overlapping diffs and preserve candidate/Firecrawl work | Restore only our specific hunks with `apply_patch`; never reset the worktree |

## Artifacts and Notes

- Baseline targeted suite: 118 passed, 0 failed.
- Final targeted suite: 141 passed, 0 failed.
- Final full suite: 970 passed, 0 failed, 2 skipped, duration 164.1 seconds.
- Syntax checks and `git diff --check`: passed with no output.
- GitNexus blast radius: `executeImportWorkflowTool` CRITICAL (12 impacted symbols, 3 direct callers, 5 processes); `serveCommand` MEDIUM (9 impacted symbols, 7 direct callers, 1 process); async helpers and `executeRunRound` LOW.
- GitNexus post-change detection: aggregate CRITICAL, 253 changed symbols, 47 affected processes, 35 changed files. This includes pre-existing user changes; intended flows were import-workflow execution, serve, and research-controller execution.
- Dirty worktree at plan creation: 26 modified/untracked paths with approximately +1484/-28 lines, including candidate pagination and Firecrawl work that predates this plan.
- `.gitignore` now narrowly permits `.agent/plans/*.md` so this living plan can be versioned while the repository's general `*.md` ignore rule remains intact.

## Interfaces and Dependencies

Required end-state interfaces:

- `import_workflow` additive inputs:
  - `idempotencyKey` / `idempotency_key`: caller-controlled retry identity.
  - `projectId` / `project_id`, `workflowRunId` / `workflow_run_id`, `selectionRevision` / `selection_revision`: optional orchestration identity carried into status.
- Async job JSON additive fields: `idempotencyKey`, `requestFingerprint`, `replaySafe`, `attempts`, `recoveryCount`, and optional recovery/manual-blocker metadata.
- Async response additive `statusEnvelope`:
  - `contractVersion: papernexus-operation-status-v1`
  - `operationId`, `projectId`, `corpusId`, `workflowRunId`, `selectionRevision`
  - `stateClass`, `blockingScope`, `status`, `stage`, `retryable`, `blockerCode`
  - `taskIds`, `capturedAt`, `expiresAt`
- Recovery worker export: `startImportWorkflowRecoveryWorker(options)` returning `stop()`, `pollNow()`, and `snapshot()`.
- HTTP routes:
  - `GET /livez`: public minimal liveness response.
  - `GET /api/readyz`: API-token protected readiness response with MCP and recovery snapshots.
- `agent_materials` additive input: `maxControllerSteps` / `max_controller_steps`, integer minimum 1.
- Bounded response additive `round_progress`: contract version, `complete`, `stepsExecuted`, `stepLimit`, `executedActions`, `nextAction`, and repeat-call resume arguments.

Dependencies:

- Node.js standard library only plus existing `src/lib/fs.js` and `src/lib/utils.js`; no new package.
- Existing artifact predicates in `research-controller.js` remain the single source for deciding missing stages.
- Existing serve API token policy remains authoritative for all `/api/*` endpoints.

### Agent Contract: AutoResearch Conductor

- Purpose: advance research without treating every PaperNexus background activity as a global workflow blocker.
- Owns: deciding whether the current research stage truly requires a PaperNexus result and when to poll/resume.
- Does not own: rewriting PaperNexus job files, declaring an import task complete, or auto-resolving ambiguous mutating submissions.
- Inputs: project/workflow/selection identity, requested operation, corpus/task references, idempotency key, controller stage budget.
- Outputs: persisted job id/status envelope or controller checkpoint/export result.
- Tools: `import_workflow`, `agent_materials`, `/livez`, and `/api/readyz`.
- Guardrails: use async mode for slow work; use stable unique idempotency keys; stop polling on terminal/manual-recovery status; do not infer completion from liveness/readiness.
- Eval cases: duplicate client retry, process restart during replay-safe work, ambiguous restart during submit, stale selection revision, and repeated one-step controller resume.

### Tool Contract: import_workflow asynchronous execution

- Capability: persist and run one normal import-workflow operation asynchronously.
- Input: existing import operation arguments plus async target and optional identity/idempotency fields.
- Side effects: read-only targets have no new external mutation; `submit` may create an import task and is therefore unsafe to replay after ambiguity.
- Idempotency: deterministic scoped job id for a supplied key; same fingerprint returns existing job; mismatch errors.
- Error model: operation failure is persisted as `failed`; ambiguous unsafe restart is `manual_recovery_required`; lock contention preserves in-progress state.
- Audit artifacts: durable job JSON, attempt/recovery counters, timestamps, error/blocker fields, status envelope.
- Mock/eval plan: temporary job root plus injected execution callback where needed; no remote provider.

### Tool Contract: research_controller run_round

- Capability: execute all missing planning stages or an optional bounded number of them.
- Input: existing controller arguments plus optional positive integer stage limit.
- Side effects: writes existing project controller artifacts one stage at a time.
- Idempotency: completed artifact predicates skip already-finished stages.
- Error model: stage errors propagate as before; exhausted budget is a successful checkpoint, not a failure.
- Audit artifacts: existing controller files and additive `round_progress` response.
- Mock/eval plan: temporary corpus/project with deterministic mocked model calls; repeated limit-one calls must converge.

### Tool Contract: HTTP liveness and readiness

- Capability: distinguish a responding process from configured authenticated service readiness.
- Input: `GET /livez` without credentials; `GET /api/readyz` with existing API token.
- Side effects: none.
- Idempotency: pure observation.
- Error model: unauthorized readiness uses existing 401/503 auth behavior; not-ready uses HTTP 503 with structured body.
- Audit artifacts: route tests and worker snapshot.
- Mock/eval plan: start ephemeral local server with workers disabled or injected and assert status/body/auth.

Orchestration pattern: durable job plus polling for import work, and a pipeline/DAG checkpoint pattern for research-controller stages. The PaperNexus durable artifacts control state; the AutoResearch conductor controls routing and whether a particular state blocks its current stage.

State locations:

- Model context: transient explanation and next-action reasoning only; never authoritative job completion.
- Request/run context: current poll/checkpoint call and auth identity; never relied upon after restart.
- Persistent state: async job JSON, import task store, controller artifacts.
- Forbidden: credentials in public liveness output; completion claims sourced only from logs; mutating replays without authority inspection.

Trace/eval acceptance covers correct async routing, idempotency conflict, replay guardrail, recovery ownership, health auth boundary, checkpoint handoff context, and regression snapshot updates.

## Revision Notes

- 2026-07-10 16:43 CST: Converted the prior diagnosis into a self-contained executable plan, compared it with current code, and optimized a broad architecture rewrite into three additive, independently reversible slices. Candidate pagination was reclassified as already implemented; process isolation and evidence-policy changes were moved to explicit follow-ups.
- 2026-07-10 16:58 CST: Completed all three implementation slices, synchronized public contracts, recorded focused/full regression evidence, and qualified GitNexus's aggregate CRITICAL result against the pre-existing dirty worktree. No remote deployment or unrelated cleanup was performed.

## Audit Rubric

Final plan-and-execution score: 20/20.

| Dimension | Score | Evidence |
|---|---:|---|
| User result | 2 | Five observable end-to-end behaviors and proof routes are stated. |
| Self-contained | 2 | Diagnosis, active-task context, contracts, paths, and commands require no chat history. |
| Current state | 2 | Code map, baseline tests, dirty worktree, remote symptom, and gap matrix are recorded. |
| Scope boundary | 2 | Scope, non-goals, invariants, and remote/deployment exclusions are explicit. |
| Work slices | 2 | Four independently accepted and reversible slices are defined. |
| Acceptance | 2 | Behavioral checks, exact test commands, schema/docs, and change detection are required. |
| Recovery | 2 | Durable ledger, file locking, idempotency, safe allowlist, resume, and no-retry rule are concrete. |
| Risk control | 2 | Each public/API/external-side-effect risk has signal, mitigation, and rollback. |
| Progress log | 2 | Timestamped evidence and ordered remaining work are present. |
| Decisions/discoveries | 2 | Surprises, rationale, dates, outcomes placeholder, and revision note are auditable. |

The final score is backed by the completed behavior tests, recovery tests, public schema snapshot, full regression suite, rollback notes, and updated outcome ledger above.
