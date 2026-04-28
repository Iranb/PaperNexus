# PaperNexus Comprehensive Code Review

Date: 2026-04-11
Scope: repository-wide code review of the current `main` line, covering code under `src/`, `scripts/`, `web/`, `SKILL/`, and `test/`
Files inventoried: 179 code files
Recommendation: REQUEST CHANGES

## Executive Summary

The repository is in good shape structurally: the staged pipeline model is coherent, the parser layer is now much more unified than earlier revisions, and the test suite is broad enough to give meaningful regression confidence in the core graph/import/runtime paths.

The biggest concerns are not “style issues”. They are operational correctness and maintenance-contract issues:

1. the repository-level test entrypoint is currently broken because `node --test` auto-discovers a utility script that exits with usage text
2. the shared file-lock implementation can evict a live lock holder during long-running work, which creates a real risk of double-entry into critical sections
3. the new import-task quarantine flow preserves files on disk but breaks normal `taskId` lookup through the public API surface
4. the browser UI persists the bearer token in `localStorage`, which is an avoidable expansion of the attack surface
5. the self-update command’s `--force` path does not actually guarantee a clean worktree and can still fail in the presence of untracked files

These are the findings I would treat as the primary review output. The rest of the codebase has many maintainability opportunities, but those are not the highest-value changes to make first.

## Methodology

This review combined:

- repository-wide file inventory across `src/`, `scripts/`, `web/`, `SKILL/`, and `test/`
- targeted manual inspection of the highest-risk runtime surfaces:
  - CLI control paths
  - import queue and storage
  - parser execution and persistence
  - locking and concurrency primitives
  - HTTP and MCP boundaries
  - browser token handling
- dynamic verification:
  - `node --test scripts/test-pdf-to-markdown.js`
  - initial `node --test` baseline run, which surfaced the same failure contract immediately
- broad static scans for:
  - token / secret handling
  - child-process boundaries
  - file mutation
  - lock ownership
  - HTTP request entry points

This report does not claim that every line of every file was manually read in equal depth. It does claim that every code file was included in the review inventory, and that the deepest manual inspection was concentrated where correctness, security, and recovery risks are highest.

## Findings

### HIGH: `npm test` / repository-wide `node --test` is currently broken by utility script auto-discovery

Files:

- `package.json:16`
- `scripts/test-pdf-to-markdown.js:258`
- `scripts/test-pdf-to-markdown.js:274`

Evidence:

- The package test script is `node --test`.
- Node’s test runner auto-discovers `scripts/test-pdf-to-markdown.js` because of its filename.
- That script is a CLI utility, not a test. When run without positional arguments, it prints usage and exits non-zero.
- Reproduction from this review:

```bash
node --test scripts/test-pdf-to-markdown.js
```

Result:

- fails with usage text
- reports `✖ scripts/test-pdf-to-markdown.js`

Why this matters:

- this breaks the repository-level test contract
- CI or maintainers relying on `npm test` / `node --test` get a false-red baseline even when the actual test suite is healthy
- it makes “all tests pass” claims ambiguous and forces everyone to remember a special-case exclusion manually

Recommended fix:

- narrow the package test script to the actual test tree, for example `node --test test`
- or rename the utility script to avoid Node test-runner discovery
- do not leave a utility CLI under a `test-*.js` filename while the repo-wide test command is broad discovery

### HIGH: `withFileLock()` can incorrectly reap a live lock holder during long-running work

File:

- `src/lib/fs.js:102`

Evidence:

- stale detection is based on `fs.stat(lockPath).mtimeMs`
- once the lock directory is created and `owner.json` is written, the holder does not refresh lock mtime during the protected function
- any waiter that sees `Date.now() - stats.mtimeMs > staleMs` removes the lock directory unconditionally

Why this matters:

- long-running operations can exceed `staleMs` without actually being dead
- if that happens, a second worker can remove the lock directory and enter the same critical section while the first worker is still running
- this is especially dangerous for:
  - graph writes
  - import queue mutation
  - registry updates
  - any code path assuming single-writer safety

This is a genuine correctness issue, not just a tuning issue. Raising `staleMs` reduces the probability but does not fix the underlying race.

Recommended fix:

- add a lock heartbeat that periodically updates a file or the directory mtime while the lock holder is alive
- or store owner PID/host metadata and verify liveness before reaping
- or separate “wait timeout” from “stale lock reaping” entirely for locks protecting potentially long-running work

### MEDIUM: quarantined import tasks become undiscoverable via the normal task-id APIs

Files:

- `src/storage/import-store.js:722`
- `src/storage/import-store.js:768`
- `src/server/api.js:1327`
- `src/server/api.js:1345`

Evidence:

- `quarantineImportTasks()` moves the task directory out of the active `tasks/` tree into `imports/quarantine/<batch-id>/...`
- `importTaskPayload()` resolves a task either from the active queue listing or from `loadImportTask(rootPath, taskId)`
- `importTaskLogPayload()` resolves directly from `loadImportTask(rootPath, taskId)`
- after quarantine, the task is intentionally removed from the queue and no longer exists under the active task directory

Why this matters:

- the quarantine feature preserves data on disk, but callers holding a historical `taskId` can no longer inspect that task through the normal API
- this weakens the operational value of quarantine because preserved evidence is no longer reachable through the existing control plane
- external agents or dashboards can experience this as “task disappeared” rather than “task was quarantined”

Recommended fix:

- preserve a small tombstone record in the active task path pointing to the quarantine batch directory
- or add quarantine-aware lookup in `importTaskPayload()` and `importTaskLogPayload()`
- or expose a dedicated “quarantine lookup by task id” API surface

### MEDIUM: browser dashboard stores a bearer token in `localStorage` and accepts `?token=` bootstrap from the URL

File:

- `web/app.js:214`

Evidence:

- `persistApiToken()` writes the bearer token into `window.localStorage`
- `captureApiTokenFromLocation()` reads `?token=...` from the URL, stores it, then removes it from the URL via `history.replaceState`

Why this matters:

- any same-origin XSS now immediately gains a durable bearer token
- browser profiles shared across users or machines retain the token beyond the current session
- URL token bootstrap is convenient, but it increases the chance of accidental disclosure through:
  - copy/paste before replacement
  - screenshots
  - browser history race windows
  - support/debug workflows where full URLs are shared

This may be an acceptable UX tradeoff for local tooling, but it is still a real security tradeoff and should be treated explicitly.

Recommended fix:

- prefer `sessionStorage` by default, with explicit opt-in persistence if long-lived storage is desired
- consider one-time URL bootstrap that does not persist automatically
- document the trust model clearly if persistence remains intentional

### MEDIUM: `papernexus update --force` does not actually guarantee a clean worktree before pull

File:

- `src/cli/index.js:1516`

Evidence:

- the `--force` path checks `git status --porcelain`
- if changes exist, it runs `git checkout .`
- that resets tracked files only; it does not remove untracked files, generated artifacts, or ignored-but-conflicting local outputs

Why this matters:

- users invoking `papernexus update --force` can still fail on `git pull` if untracked files would be overwritten
- the command message implies a stronger guarantee than the implementation provides
- this makes the recovery path brittle exactly when the user is asking the tool to “just get me updated”

Recommended fix:

- either make the force path truly comprehensive after explicit confirmation
- or reduce the promise and fail fast when untracked files remain
- if keeping `--force`, the implementation should cover both tracked and untracked conflict sources

## Secondary Notes

These are not blocking findings, but they are worth recording:

- `package.json:4` still describes the project as “powered by Marker”, which no longer matches the current default parser/runtime story
- the repository has strong test coverage in the central graph/import/LLM areas, but many operational shell/Python wrappers remain validated mainly by targeted path tests rather than end-to-end service scenarios
- the current parser-state and queue-state persistence story is much better than earlier revisions and is a notable strength of the current design

## What Looks Good

The review also surfaced a number of positives worth preserving:

- the staged ingestion model in `pipeline.js` is coherent and increasingly resilient to restart/retry workflows
- parser selection and fallback are now much more centralized in `src/core/ingestion/pdf-parser.js`
- the import queue has meaningful structured progress rather than only coarse task status
- recent work on parser-state persistence and queue quarantine is operationally valuable
- test coverage around import queue behavior, parser fallback, and CLI/config behavior is unusually strong for a codebase of this size

## Suggested Fix Order

If I were sequencing fixes, I would do them in this order:

1. fix the repository-wide test contract (`package.json` / utility script discovery)
2. harden `withFileLock()` so stale reaping cannot remove an active lock holder
3. restore observability for quarantined import tasks by task id
4. decide and document the intended browser token persistence model
5. tighten the update command’s `--force` semantics

## Approval Recommendation

REQUEST CHANGES

Reason:

- there are multiple production-facing correctness and operations-contract issues
- the lock-staleness behavior is the most concerning technical risk
- the broken repo-wide test entrypoint is an immediate maintenance-footgun

## File Coverage Appendix

### SKILL (23)

- `SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py`
- `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`
- `SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py`
- `SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py`
- `SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py`
- `SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py`
- `SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py`
- `SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py`
- `SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py`
- `SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py`
- `SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py`
- `SKILL/PaperNexus/scripts/pn_stage_sync.py`
- `SKILL/PaperNexus/scripts/pn_batch_import.py`
- `SKILL/PaperNexus/scripts/pn_research_chains.py`
- `SKILL/PaperNexus/scripts/pn_import_queue.py`
- `SKILL/PaperNexus/scripts/pn_common.py`
- `SKILL/PaperNexus/scripts/pn_import_submit.py`
- `SKILL/PaperNexus/scripts/pn_graph_query.py`
- `SKILL/PaperNexusReflection/scripts/pn_import_submit.py`
- `SKILL/PaperNexusReflection/scripts/pn_import_queue.py`
- `SKILL/PaperNexusReflection/scripts/pn_stage_sync.py`
- `SKILL/PaperNexusReflection/scripts/pn_batch_import.py`
- `SKILL/PaperNexusReflection/scripts/pn_research_chains.py`

### scripts (26)

- `scripts/pn_stage_sync.py`
- `scripts/pn_research_chains.py`
- `scripts/opendataloader_pdf_to_markdown.py`
- `scripts/manage-service.sh`
- `scripts/pm2-papernexus-serve.sh`
- `scripts/docling_to_markdown.py`
- `scripts/paddleocr_vl_to_markdown.py`
- `scripts/systemd/papernexus-watch.service`
- `scripts/systemd/papernexus-serve.timer`
- `scripts/systemd/papernexus-serve.service`
- `scripts/pn_import_queue.py`
- `scripts/pn_common.py`
- `scripts/markpdfdown_to_markdown.py`
- `scripts/test-pdf-to-markdown.js`
- `scripts/pn_graph_query.py`
- `scripts/pn_import_submit.py`
- `scripts/generate-docs-reference.mjs`
- `scripts/markitdown_to_markdown.py`
- `scripts/pn_batch_import.py`
- `scripts/install-service.sh`
- `scripts/reinstall.sh`
- `scripts/macos/io.github.papernexus.serve.plist`
- `scripts/macos/io.github.papernexus.watch.plist`
- `scripts/graph_manage/delete_graph_index.sh`
- `scripts/graph_manage/delete_and_rebuild_all.sh`
- `scripts/graph_manage/delete_graph_index_snapshot.sh`

### src (70)

- `src/lib/fs.js`
- `src/lib/keychain.js`
- `src/lib/server-paths.js`
- `src/lib/keychain-linux.js`
- `src/lib/utils.js`
- `src/lib/watch-log.js`
- `src/lib/keychain-windows.js`
- `src/lib/prompt.js`
- `src/lib/launchd.js`
- `src/lib/encrypted-storage.js`
- `src/lib/keychain-darwin.js`
- `src/lib/config.js`
- `src/lib/render.js`
- `src/storage/pdf-parse-store.js`
- `src/storage/lite-view.js`
- `src/storage/backup-archive.js`
- `src/storage/enhancement-store.js`
- `src/storage/import-store.js`
- `src/storage/corpus-store.js`
- `src/storage/authoritative-sync-store.js`
- `src/storage/registry.js`
- `src/storage/kuzu-store.js`
- `src/cli/index.js`
- `src/server/http.js`
- `src/server/api.js`
- `src/core/graph/takeaways.js`
- `src/core/graph/lite.js`
- `src/core/graph/idea-catalyst-packets.js`
- `src/core/graph/catalyst-adapter.js`
- `src/core/graph/delta-commit.js`
- `src/core/graph/summary.js`
- `src/core/graph/challenges.js`
- `src/core/graph/schema.js`
- `src/core/graph/analogy.js`
- `src/core/graph/domain-taxonomy.js`
- `src/core/graph/merge-similar.js`
- `src/core/graph/interdisciplinary-ranking.js`
- `src/core/graph/interdisciplinary-potential.js`
- `src/core/graph/research-questions.js`
- `src/core/graph/takeaway-extraction.js`
- `src/core/graph/abstract-mechanisms.js`
- `src/core/graph/brainstorm-view.js`
- `src/core/graph/rules.js`
- `src/core/graph/mutations.js`
- `src/core/graph/graph.js`
- `src/core/graph/domain-bridges.js`
- `src/core/graph/bridge-retrieval.js`
- `src/core/imports/worker.js`
- `src/mcp/http.js`
- `src/mcp/resources.js`
- `src/mcp/tool-research-briefing.js`
- `src/mcp/stdio.js`
- `src/mcp/tool-import-workflow.js`
- `src/mcp/tool-research-lookup.js`
- `src/mcp/server.js`
- `src/mcp/core.js`
- `src/mcp/prompts.js`
- `src/mcp/tool-idea-catalyst.js`
- `src/mcp/tools.js`
- `src/core/enhancements/worker.js`
- `src/core/enhancements/extract.js`
- `src/core/llm/ollama.js`
- `src/core/search/brainstorm-communities.js`
- `src/core/search/search.js`
- `src/core/ingestion/markdown.js`
- `src/core/ingestion/pipeline.js`
- `src/core/ingestion/graph-postprocess.js`
- `src/core/ingestion/graph-precompute.js`
- `src/core/ingestion/pdf-parser.js`
- `src/core/authoritative-sync/worker.js`

### test (57)

- `test/lite.test.js`
- `test/graph-refinement.test.js`
- `test/markdown.test.js`
- `test/mixed-sources.test.js`
- `test/catalyst-adapter.test.js`
- `test/import-worker.test.js`
- `test/analogy-graph.test.js`
- `test/markdown-cache.test.js`
- `test/staged-pipeline.test.js`
- `test/takeaway-extraction.test.js`
- `test/server-paths.test.js`
- `test/mutations.test.js`
- `test/mcp-http.test.js`
- `test/brainstorm-community-profile.test.js`
- `test/http-auth.test.js`
- `test/watch-log.test.js`
- `test/mcp.test.js`
- `test/concurrency.test.js`
- `test/reinstall-script.test.js`
- `test/merge-graph-stage.test.js`
- `test/analyze-resume.test.js`
- `test/brainstorm-view.test.js`
- `test/pdf-to-markdown-script.test.js`
- `test/python-remote-scripts.test.js`
- `test/enhancement-logging.test.js`
- `test/graph-postprocess.test.js`
- `test/query-api.test.js`
- `test/incremental-derived-graph.test.js`
- `test/import-store.test.js`
- `test/takeaway-graph.test.js`
- `test/pipeline-pdf-parser-concurrency.test.js`
- `test/backup-archive.test.js`
- `test/catalyst-e2e.test.js`
- `test/challenge-graph.test.js`
- `test/node-llm-check.test.js`
- `test/workflow.test.js`
- `test/idea-catalyst-packets.test.js`
- `test/backup.test.js`
- `test/enhancements.test.js`
- `test/single-graph-safety.test.js`
- `test/idea-catalyst-schema.test.js`
- `test/authoritative-sync-store.test.js`
- `test/cli.test.js`
- `test/semantic-extraction.test.js`
- `test/research-chain-api.test.js`
- `test/authoritative-sync-worker.test.js`
- `test/pm2-serve-script.test.js`
- `test/domain-distance-persistence.test.js`
- `test/pdf-parser.test.js`
- `test/launchd.test.js`
- `test/import-api.test.js`
- `test/pdf-parse-store.test.js`
- `test/delta-commit.test.js`
- `test/ollama.test.js`
- `test/llm-config.test.js`
- `test/corpus-store-progress.test.js`
- `test/materialize-optimize.test.js`

### web (3)

- `web/app.js`
- `web/styles.css`
- `web/index.html`
