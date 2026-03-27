# Import Latency Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add phase-one import latency optimizations by surfacing materialization timings, caching MinerU endpoint probes, and warming MinerU at serve startup.

**Architecture:** Extend the PDF conversion pipeline to return timing metadata, thread that metadata into import task results, and add a small process-local MinerU reachability cache plus best-effort serve warmup. Keep the changes additive so import semantics and existing graph behavior remain unchanged.

**Tech Stack:** Node.js, built-in test runner, PaperNexus import worker, ingest pipeline, HTTP serve command

---

### Task 1: Document the latency optimization shape

**Files:**
- Create: `docs/superpowers/specs/2026-03-27-import-latency-phase1-design.md`
- Create: `docs/superpowers/plans/2026-03-27-import-latency-phase1-implementation.md`

- [ ] **Step 1: Write the design doc**

Capture the phase-one goals, scope boundaries, timing fields, probe-cache policy, and serve warmup behavior.

- [ ] **Step 2: Write the implementation plan**

Describe the code changes, tests, and verification commands.

### Task 2: Add failing tests for MinerU probe caching and timing metadata

**Files:**
- Modify: `test/marker.test.js`

- [ ] **Step 1: Write the failing tests**

Add tests that expect:
- repeated reachability checks to reuse a cached probe result
- `mineruProbeCacheTtlMs: 0` to disable the cache
- MinerU conversion results to surface parser timing fields

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test test/marker.test.js`
Expected: FAIL because the new cache and timing fields do not exist yet.

- [ ] **Step 3: Implement the minimal marker-layer changes**

Modify `src/core/ingestion/marker.js` to add timing helpers, probe caching, cache invalidation, and timing-rich MinerU results.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `node --test test/marker.test.js`
Expected: PASS

### Task 3: Add failing tests for import-task timing persistence

**Files:**
- Modify: `test/import-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add a focused import-worker test that stubs `materializeCorpus()` to return timing metadata and expects `task.result.materialized.timings` to be persisted.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test test/import-worker.test.js`
Expected: FAIL because the worker currently discards timing metadata.

- [ ] **Step 3: Implement the minimal worker change**

Modify `src/core/imports/worker.js` so `result.materialized` includes the returned timings.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/import-worker.test.js`
Expected: PASS

### Task 4: Add failing tests for serve-time MinerU warmup

**Files:**
- Modify: `test/http-auth.test.js`
- Modify: `src/server/http.js`

- [ ] **Step 1: Write the failing test**

Add a serve test that injects a warmup stub and expects background warmup logging without blocking server startup.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test test/http-auth.test.js`
Expected: FAIL because serve does not yet trigger warmup.

- [ ] **Step 3: Implement the minimal serve change**

Thread a MinerU warmup helper into `serveCommand()` and launch it best-effort after workers start.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test test/http-auth.test.js`
Expected: PASS

### Task 5: Verify the full phase-one slice

**Files:**
- Modify: `src/core/ingestion/marker.js`
- Modify: `src/core/imports/worker.js`
- Modify: `src/server/http.js`
- Modify: `test/marker.test.js`
- Modify: `test/import-worker.test.js`
- Modify: `test/http-auth.test.js`

- [ ] **Step 1: Run focused verification**

Run: `node --test test/marker.test.js test/import-worker.test.js test/http-auth.test.js`
Expected: PASS

- [ ] **Step 2: Run the broader import regression slice**

Run: `node --test test/import-store.test.js test/import-api.test.js test/pipeline-marker-concurrency.test.js test/staged-pipeline.test.js`
Expected: PASS

- [ ] **Step 3: Re-run the live remote benchmark**

Use the existing remote import harness to compare:
- first import after startup
- later hot imports
- repeated import dedupe

- [ ] **Step 4: Summarize measured impact**

Report the timing deltas, any residual long poles, and whether a follow-up warmup strategy is needed.
