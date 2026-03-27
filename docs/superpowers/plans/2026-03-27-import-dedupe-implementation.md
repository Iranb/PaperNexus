# Import Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make identical API uploads reuse an existing import task immediately and stop rescanning completed import task directories while keeping completed imported papers durable through manifest-backed source reuse.

**Architecture:** Add content-fingerprint indexing in the import store and thread a small `deduped` signal through the API payload helpers. Separately, narrow active import directory discovery to running tasks only, then rehydrate completed imported sources from the manifest so later imports retain imported papers without directory rescans.

**Tech Stack:** Node.js, existing import queue/file-lock storage, PaperNexus ingestion pipeline, Node test runner.

---

### Task 1: Add Failing Tests For Duplicate Upload Reuse

**Files:**
- Modify: `test/import-store.test.js`
- Modify: `test/import-api.test.js`

- [ ] **Step 1: Write the failing test**

Add tests that assert:
- two uploads with identical bytes but different names return the same task id
- API payload helpers expose `deduped: true` when reusing an existing task
- failed tasks are not reused

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/import-store.test.js test/import-api.test.js`
Expected: FAIL because duplicate uploads still create new tasks and API payloads do not expose dedupe state.

- [ ] **Step 3: Write minimal implementation**

Implement content fingerprints, a task-level dedupe index, and API payload metadata just enough to satisfy the tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/import-store.test.js test/import-api.test.js`
Expected: PASS

### Task 2: Add Failing Tests For Completed Import Scan Narrowing

**Files:**
- Modify: `test/import-store.test.js`
- Modify: `test/import-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add tests that assert:
- `listActiveImportSourceDirs(...)` only returns running tasks
- after a completed import, a later import run still retains the earlier imported paper without rediscovering completed task directories

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/import-store.test.js test/import-worker.test.js`
Expected: FAIL because completed tasks are still treated as active import directories and later runs depend on rescanning them.

- [ ] **Step 3: Write minimal implementation**

Change active import directory selection to running-only and rehydrate completed import sources from the manifest during discovery.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/import-store.test.js test/import-worker.test.js`
Expected: PASS

### Task 3: Verify Targeted Regressions

**Files:**
- No new production files expected beyond the import store and ingestion pipeline changes above

- [ ] **Step 1: Run the focused suite**

Run: `node --test test/import-store.test.js test/import-api.test.js test/import-worker.test.js`
Expected: PASS

- [ ] **Step 2: Review modified files for unintended behavior changes**

Confirm:
- failed tasks remain retryable
- running tasks remain resumable
- completed tasks remain query-visible through manifest-backed sources

- [ ] **Step 3: Summarize verification evidence**

Record the exact commands run and any residual risks in the final handoff.
