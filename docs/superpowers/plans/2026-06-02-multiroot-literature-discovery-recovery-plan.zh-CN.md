# Multi-Root Literature Discovery Recovery ExecPlan

Created: 2026-06-02
Updated: 2026-06-02
Target repository: `/Users/iranb/Library/Mobile Documents/com~apple~CloudDocs/OpenClawThings/PaperNexus`
Target branch / worktree: `main`
Related docs:
- `docs/superpowers/plans/2026-06-01-resilient-mcp-interaction-plan.zh-CN.md`
- `docs/literature-discovery/index.md`
- `docs/interfaces/mcp-skill-contracts.md`
- `docs/reference/generated/config.md`
- `docs/reference/generated/mcp-tools.md`

This ExecPlan is a living document. Future implementers must be able to continue from the current repository state and this file without relying on chat history.

## Purpose / Big Picture

After completion, PaperNexus can run on the 41 server with more than one corpus root configured for background workers. A restart must not leave existing literature discovery progress queues or import queues invisible merely because they live outside the single `storage.indexDir` root. Operators can configure `storage.indexDirs` or an array-valued `storage.indexDir`, keep a backward-compatible primary `storage.indexDir`, and rely on `serve` to start workers across all valid configured roots.

The user-visible result is:

- `serve` logs all valid worker roots at startup.
- Import workers scan every configured root instead of only the first root.
- Literature discovery recovery scans configured roots, turns queued or stale running runs back into server-side execution when persisted recovery arguments are available, and marks unrecoverable stale runs as blocked rather than silently treating them as success.
- MCP clients can inspect discovery progress without running another provider search or import side effect.

## Progress

- [x] 2026-06-02 10:20 CST Identified that the 41 deployment had only `storage.indexDir=/data1/whw/worldmodels/.papernexus`, while stale pending import tasks lived under `/data1/hyq/papernexus-icml-ideation-datasets/PN-ICML-Ideation-Shared-240-v1/sources` and `/data2/hyq/papernexus-corpora/GCD`.
- [x] 2026-06-02 10:45 CST Added multi-root config normalization while preserving the old string `storage.indexDir` contract.
- [x] 2026-06-02 10:55 CST Updated `serve` worker startup so enhancement, authoritative sync, import, registry reconcile, and literature discovery recovery receive the same configured root set.
- [x] 2026-06-02 11:00 CST Added persisted literature discovery progress listing and a read-only `literature_discovery_progress` MCP tool.
- [x] 2026-06-02 11:05 CST Added server-side literature discovery restart recovery for queued and stale running runs.
- [x] 2026-06-02 11:08 CST Added tests and regenerated config/MCP docs.
- [x] 2026-06-02 11:10 CST Pushed implementation commit `5f32cf62e21a24971821cbe9ed4ec1887e9bb9d7` to `origin/main`.
- [x] 2026-06-02 11:12 CST Deployed the committed source to 41 and restarted `papernexus serve` on port `4821`.
- [x] 2026-06-02 11:13 CST Updated 41 runtime storage config to include the three valid roots; startup log confirmed `configured worker roots: 3 valid`.
- [x] 2026-06-02 11:13 CST Verified the stale PN-ICML import queue moved from `13 pending / 0 running` to `9 pending / 4 running`.

## Surprises & Discoveries

The observed `13 pending / 0 running` state was not caused by the import worker refusing the tasks. It happened because those tasks were under the PN-ICML root, while the 41 runtime config only pointed workers at the worldmodels root. The service was alive, but its scan coverage did not include the queue location.

Existing literature discovery runs on the three durable 41 roots were already terminal at verification time: PN-ICML had 17 completed runs, GCD had 12 completed runs, and worldmodels had no persisted discovery runs. Therefore the restart recovery worker had no live discovery run to resume during deployment verification; its startup and root coverage were verified, while the active state transition observed on 41 was the import queue moving into running.

## Decision Log

Decision: Keep `storage.indexDir` backward compatible as a primary string, and add `storage.indexDirs` plus support for array-valued `storage.indexDir`.
Rationale: Existing scripts and configs may still expect a string. The new normalization accepts both old and new forms, dedupes roots, and lets operators declare multiple scan roots without breaking older single-root setups.
Date/Author: 2026-06-02 / Codex

Decision: Start literature discovery recovery inside `serve`, not inside the MCP request handler.
Rationale: Restart recovery must happen even when no client is currently waiting on an MCP call. The direct authority for recovery is the persisted progress snapshot and recovery metadata under each corpus root.
Date/Author: 2026-06-02 / Codex

Decision: Add a read-only `literature_discovery_progress` MCP tool instead of overloading `literature_discovery search`.
Rationale: Progress inspection must not trigger another search/import side effect. The addition is backward-compatible because existing MCP tool names and schemas continue to work.
Date/Author: 2026-06-02 / Codex

Decision: On 41, keep `storage.indexDir` and `storage.defaultIndexDir` set to `/data1/whw/worldmodels/.papernexus`, and add the PN-ICML and GCD roots through `storage.indexDirs`.
Rationale: This preserves default corpus behavior while making workers cover the roots that actually contain stale queues.
Date/Author: 2026-06-02 / Codex

## Outcomes & Retrospective

Implemented in commit `5f32cf62e21a24971821cbe9ed4ec1887e9bb9d7`.

The fix addresses the root cause of stale queues after restart: worker coverage now follows all configured roots, and discovery recovery is no longer dependent on a client retry. The remaining operational caveat is that literature discovery can only be resumed automatically when the persisted progress snapshot contains enough sanitized recovery arguments. Runs that predate recovery metadata, or runs whose recovery arguments are missing, must be marked blocked and inspected rather than silently retried.

## Context and Orientation

Relevant implementation files:

- `src/lib/config.js`: normalizes `storage.indexDir`, `storage.indexDirs`, `storage.defaultIndexDir`, and default root fallbacks.
- `src/server/api.js`: resolves configured root paths, validates configured worker coverage, and keeps API corpus resolution compatible.
- `src/server/http.js`: starts background workers with all valid configured roots and logs coverage at startup.
- `src/core/imports/worker.js`: records import worker coverage observations and continues scanning all configured roots.
- `src/core/discovery/store.js`: lists persisted discovery progress snapshots.
- `src/mcp/tool-literature-discovery.js`: persists recovery metadata on submit and starts the restart recovery worker.
- `src/mcp/tool-literature-discovery-progress.js`: exposes read-only progress inspection.
- `src/mcp/core.js` and `src/mcp/tools.js`: wire MCP tool schemas and runtime init support.

The 41 server runtime paths verified on 2026-06-02:

- App directory: `/data2/hyq/PaperNexus`
- Node binary: `/data2/hyq/papernexus-runtime/node-current/bin/node`
- Runtime config: `/data2/hyq/.papernexus/config.json`
- Serve command: `./src/cli/index.js serve --host 0.0.0.0 --port 4821`

## Scope

In scope:

- Multi-root config parsing and worker fan-out.
- Restart-safe literature discovery recovery from persisted progress snapshots.
- Read-only discovery progress inspection.
- Queue coverage diagnostics for import workers.
- Documentation and regression tests.
- 41 deployment config update for the known durable roots.

Non-goals:

- Reprocessing already completed literature discovery reports.
- Recreating missing provider requests when a pre-recovery run lacks recovery arguments.
- Changing existing MCP tool names or making existing MCP clients migrate immediately.
- Copying or moving corpus data between roots.

## Non-Negotiable Rules

Do not treat a client timeout as success. The direct authority is persisted run or task state.

Do not auto-retry a discovery run if persisted recovery metadata is missing. Mark it blocked and expose the reason.

Do not scan arbitrary large filesystem trees at runtime. Workers use configured roots and registry fallback, not broad `find`-style discovery.

Do not leak provider secrets when printing runtime config. Operator checks should print only `storage` fields and process health.

## Authority / Evidence Model

Import queue state is authoritative in each task's `.papernexus/imports/tasks/<taskId>/task.json`.

Literature discovery state is authoritative in `.papernexus/discovery/runs/<runId>/progress.json` and the completed run report for the same `runId`.

Server startup coverage is evidenced by `serve` logs such as `configured worker roots: 3 valid` and individual `worker root:` lines.

MCP progress output is evidence for clients; it does not itself mutate queue state.

## Implementation Slices

First, normalize storage roots in one shared config helper. The helper must accept a string, an array, and `storage.indexDirs`, dedupe paths, resolve relative and home-prefixed paths, and keep a deterministic primary root.

Second, move server startup from single-root worker wiring to multi-root worker wiring. Every background worker that scans corpora must receive the same configured root set.

Third, persist recovery metadata for new discovery submissions and add a recovery worker that scans progress snapshots on interval. Queued runs and stale running runs are recoverable only when sanitized recovery arguments exist.

Fourth, add read-only progress inspection so clients can check a run or root without reissuing a long-running provider call.

Fifth, update tests, generated docs, 41 runtime config, and deployment.

## Plan of Work

The code work is complete. Future changes should proceed by preserving this structure:

1. Change storage normalization first and add focused unit coverage.
2. Wire all worker callers through the normalized root list.
3. Add state-transition tests using fixtures, not live provider calls.
4. Regenerate docs after MCP schema or config reference changes.
5. Deploy from a clean Git commit, not from a dirty worktree.
6. On 41, update storage roots before restart and verify logs plus queue state after restart.

## Concrete Steps

Validation commands already run from the repository root:

    node --check src/lib/config.js
    node --check src/server/api.js
    node --check src/server/http.js
    node --check src/mcp/tool-literature-discovery.js
    node --check src/mcp/tool-literature-discovery-progress.js
    node --test test/mcp-schema-snapshot.test.js
    node --test test/mcp.test.js
    node --test test/mcp-http.test.js
    node --test test/tool-import-workflow.test.js test/literature-discovery-progress-tool.test.js
    npm test
    git diff --check

41 deployment verification commands:

    ssh 10.126.56.41 'cat ~/PaperNexus/.papernexus-deploy-revision'
    ssh 10.126.56.41 'tail -n 220 ~/.papernexus/serve.log | grep -E "configured worker roots|worker root|recovery worker|import worker"'
    ssh 10.126.56.41 'curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4821/'

Expected 41 observations after restart:

- Revision marker equals `5f32cf62e21a24971821cbe9ed4ec1887e9bb9d7`.
- HTTP probe returns `200`.
- Startup log reports `configured worker roots: 3 valid`.
- Startup log lists worldmodels, PN-ICML, and GCD roots.
- Import queue for PN-ICML has running tasks after restart.

## Validation and Acceptance

Acceptance is satisfied when:

- All local tests pass.
- Generated docs and MCP schema snapshots are consistent with implementation.
- GitHub `origin/main` contains the implementation commit.
- 41 server is running the same revision marker.
- 41 server config includes the three valid storage roots.
- 41 startup log confirms all three roots are used by workers.
- A previously stale queue outside the old `storage.indexDir` transitions from pending into running after restart.

Observed results:

- `npm test`: 853 tests passed, 0 failed.
- 41 HTTP probe: `200 text/html; charset=utf-8`.
- 41 startup log: `configured worker roots: 3 valid`.
- PN-ICML import queue: from `13 pending / 0 running` to `9 pending / 4 running`.
- Existing literature discovery queues: PN-ICML `17 completed`, GCD `12 completed`, worldmodels `0`; no queued discovery run was present to resume during deployment verification.

## Idempotence and Recovery

The 41 runtime config was backed up before mutation. If rollback is required, restore the backup under `/data2/hyq/.papernexus/config.json.pre-multiroot-*.bak`, then restart `/data2/hyq/.papernexus/start-papernexus-serve.sh`.

The deployment was performed from `git archive HEAD` into a temporary remote directory, then rsynced to `/data2/hyq/PaperNexus` while excluding `node_modules`, `.papernexus`, `index-store`, `~`, `.gitnexus`, and `.codex-backups`. This avoids copying local dirty files and preserves runtime state.

Discovery recovery is idempotent because terminal progress snapshots are skipped. Queued or stale running snapshots are only executed when the persisted recovery contract is present; otherwise they are blocked with a reason.

Import recovery remains idempotent through existing task status files. Workers pick pending tasks and update task state; completed and failed tasks are not treated as pending work.

## Risks and Rollback

Risk: A newly configured root is invalid or points to a large non-corpus directory.
Rollback: Remove it from `storage.indexDirs` and restart. The server logs invalid roots and valid root count at startup.

Risk: A stale discovery run lacks recovery metadata.
Rollback: No automatic provider call is made. Inspect `literature_discovery_progress`, then manually resubmit if the operator decides it is safe.

Risk: Multi-root workers increase background load.
Rollback: Reduce `storage.indexDirs` to the minimum active roots or tune import batch settings. Do not delete task files to reduce load unless explicitly performing queue maintenance.

Risk: Deployment artifact accidentally includes local dirty files.
Rollback: Deployment must use `git archive HEAD`; verify remote revision marker. The 2026-06-02 deployment followed this rule.

## Artifacts and Notes

Implementation commit: `5f32cf62e21a24971821cbe9ed4ec1887e9bb9d7`.

41 code backup: `/data2/hyq/papernexus-deploy-backups/PaperNexus-code-20260602-111119-pre-5f32cf62e21a.tgz`.

41 config backup: `/data2/hyq/.papernexus/config.json.pre-multiroot-2026-06-02T03-11-57-238Z.bak`.

41 configured roots:

- `/data1/whw/worldmodels/.papernexus`
- `/data1/hyq/papernexus-icml-ideation-datasets/PN-ICML-Ideation-Shared-240-v1/sources`
- `/data2/hyq/papernexus-corpora/GCD`

## Interfaces and Dependencies

Config interface:

- `storage.indexDir`: string or array of strings. The first normalized path is the primary root.
- `storage.indexDirs`: optional array of additional roots.
- `storage.defaultIndexDir`: optional default root used when several roots are configured and an API call omits an explicit corpus/root.

MCP interface:

- Existing `literature_discovery` operations remain compatible.
- New additive tool: `literature_discovery_progress`.
- `runtime_init` accepts `indexDir` as string or array and accepts `indexDirs`.

Runtime dependencies:

- Node.js on 41: `/data2/hyq/papernexus-runtime/node-current/bin/node`.
- Existing corpus metadata under each root's `.papernexus/meta.json`.
- Existing provider configuration under 41 runtime home; do not print secrets in logs or reports.
