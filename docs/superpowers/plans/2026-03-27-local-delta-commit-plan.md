# Fast Local Delta Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a newly imported paper become query-visible in under 5 seconds after PDF-to-Markdown and LLM extraction complete, by applying a fast local delta commit to the lite graph and manifest first, then syncing Kuzu authoritative storage asynchronously through a managed queue, while persisting every intermediate state so the pipeline can be interrupted and resumed safely.

**Architecture:** Split the current Stage 4 commit into two phases. Phase A is a fast, lock-bounded delta commit that updates the committed lite graph, metadata, manifest, and sync queue using only changed paper fragments. Phase B is an asynchronous authoritative sync worker that drains a corpus-scoped queue and brings Kuzu into parity without blocking graph visibility. Both phases persist durable checkpoint state so a crash, Ctrl+C, or service restart can resume from the last completed boundary instead of recomputing the entire paper update.

**Tech Stack:** Node.js, existing PaperNexus staged pipeline, lite graph materialized view, Kuzu backend, file-lock queues, Node test runner.

---

## Resume And Checkpoint Rules

These rules apply to every task below and are part of the contract, not an optional enhancement.

- Every fast-commit attempt must persist a checkpoint record before and after each state transition.
- Every authoritative sync attempt must persist a queue job state before and after each transition.
- A process restart must be able to answer:
  - which source keys were already materialized
  - which source keys were already LLM-optimized
  - which delta payload was computed
  - whether the lite graph commit already succeeded
  - whether the authoritative Kuzu sync is still pending, running, failed, or completed
- No step should require recomputing the PDF parse, Markdown cache, or LLM output just because the commit/sync phase was interrupted.
- `--continue` must mean “resume from persisted state if it is still valid”, not “restart the whole stage and hope cache helps.”
- Queue jobs must be idempotent: replaying the same committed delta or authoritative sync job should be safe.

## State Files To Add

The implementation should persist durable state under `.papernexus/`:

- `.papernexus/fast-commit/`
  - `pending.json`
  - `history/*.json`
- `.papernexus/authoritative-sync/`
  - `queue.json`
  - `jobs/<jobId>.json`
  - `history/*.json`

Each persisted fast-commit job should include:

- `jobId`
- `rootPath`
- `baseManifestToken`
- `targetManifestToken`
- `changedSourceKeys`
- `deltaFingerprint`
- `status`
- `stage`
- timestamps

Each authoritative sync job should include:

- `jobId`
- `dependsOnFastCommitJobId`
- `baseManifestToken`
- `targetManifestToken`
- `changedSourceKeys`
- `status`
- `stage`
- retry/error info
- timestamps

## Visibility Rules

- Once the fast local delta commit completes, the paper must be query-visible through the lite graph and API even if Kuzu sync is still pending.
- Corpus metadata must clearly indicate when the lite graph is ahead of Kuzu, so callers can distinguish:
  - `fully-synced`
  - `lite-visible-authoritative-sync-pending`
  - `authoritative-sync-running`
  - `authoritative-sync-failed`

### Task 1: Remove Mandatory Backup From The Stage 4 Fast Path

**Files:**
- Modify: `src/core/ingestion/pipeline.js`
- Modify: `src/storage/corpus-store.js`
- Test: `test/staged-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that runs `writeIndexCorpus(...)` with a prepared staged build and asserts the default path does not call corpus backup.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/staged-pipeline.test.js`
Expected: FAIL because `write-index` still backs up the whole corpus by default.

- [ ] **Step 3: Write minimal implementation**

Change `commitPreparedCorpusIndex(...)` so backup only happens when a new explicit option is enabled, for example `analysisOptions.backupBeforeCommit === true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/staged-pipeline.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ingestion/pipeline.js src/storage/corpus-store.js test/staged-pipeline.test.js
git commit -m "perf: remove default stage4 backup from fast path"
```

### Task 2: Add A Corpus-Scoped Authoritative Sync Queue

**Files:**
- Modify: `src/storage/corpus-store.js`
- Create: `src/storage/authoritative-sync-store.js`
- Test: `test/authoritative-sync-store.test.js`

- [ ] **Step 1: Write the failing test**

Add tests for:
- enqueueing a sync job
- reserving the next sync job
- marking a sync job completed
- deduping multiple queued jobs for the same manifest token

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/authoritative-sync-store.test.js`
Expected: FAIL because the new queue store does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create a store under `.papernexus/authoritative-sync/` with:
- `queue.json`
- queue lock path
- helper APIs for enqueue/reserve/complete/fail/list

The queue record should include:
- `jobId`
- `rootPath`
- `baseManifestToken`
- `targetManifestToken`
- `changedSourceKeys`
- `mode`
- `status`
- timestamps

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/authoritative-sync-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/corpus-store.js src/storage/authoritative-sync-store.js test/authoritative-sync-store.test.js
git commit -m "feat: add authoritative sync queue store"
```

### Task 3: Build A Fast Delta Payload From Changed Papers

**Files:**
- Create: `src/core/graph/delta-commit.js`
- Modify: `src/core/ingestion/pipeline.js`
- Test: `test/delta-commit.test.js`

- [ ] **Step 1: Write the failing test**

Add tests that:
- load an existing committed graph
- add one new semantic paper
- build a delta payload that contains only changed nodes/relationships/source keys

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/delta-commit.test.js`
Expected: FAIL because no delta builder exists.

- [ ] **Step 3: Write minimal implementation**

Implement a delta builder that:
- constructs a fragment graph for changed semantic papers only
- compares fragment ids against the committed lite graph
- emits:
  - `upsertNodes`
  - `upsertRelationships`
  - `deleteNodeIds`
  - `deleteRelationshipIds`
  - `changedSourceKeys`
- preserves source membership info so lite-view incremental updates remain correct

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/delta-commit.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/delta-commit.js src/core/ingestion/pipeline.js test/delta-commit.test.js
git commit -m "feat: build graph delta payloads for changed papers"
```

### Task 4: Add A Fast Local Commit Path For Lite Graph Visibility

**Files:**
- Modify: `src/storage/lite-view.js`
- Modify: `src/storage/corpus-store.js`
- Modify: `src/core/ingestion/pipeline.js`
- Test: `test/lite.test.js`
- Test: `test/delta-commit.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that:
- starts from a committed corpus
- applies a delta for one new paper
- verifies the lite graph, metadata, and manifest are updated without rebuilding the entire graph

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lite.test.js test/delta-commit.test.js`
Expected: FAIL because no fast local delta commit exists.

- [ ] **Step 3: Write minimal implementation**

Implement:
- `applyLiteDeltaCommit(...)`
- `saveCorpusFastLocalDelta(...)`

Behavior:
- take a short corpus lock
- patch lite graph incrementally
- update committed `meta.json`
- update committed `sources.json`
- persist fast-commit checkpoint state before and after the lock-bounded commit
- enqueue authoritative sync job
- return quickly without writing Kuzu

Add an explicit metadata flag such as:
- `authoritativeSyncStatus: "pending"`
- `authoritativeSyncQueuedAt`
- `lastFastCommitJobId`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lite.test.js test/delta-commit.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/lite-view.js src/storage/corpus-store.js src/core/ingestion/pipeline.js test/lite.test.js test/delta-commit.test.js
git commit -m "feat: add fast local delta commit for lite graph visibility"
```

### Task 5: Add An Authoritative Kuzu Sync Worker

**Files:**
- Create: `src/core/authoritative-sync/worker.js`
- Modify: `src/storage/kuzu-store.js`
- Modify: `src/server/http.js`
- Modify: `src/cli/index.js`
- Test: `test/authoritative-sync-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add tests that:
- enqueue a pending sync job
- run one sync pass
- verify Kuzu is brought to the target manifest token
- verify queue status transitions to completed

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/authoritative-sync-worker.test.js`
Expected: FAIL because no sync worker exists.

- [ ] **Step 3: Write minimal implementation**

Implement a worker that:
- polls the authoritative sync queue
- reserves the next pending job
- loads the committed lite graph or staged graph target
- writes Kuzu authoritative storage
- clears the pending sync state when complete

Important:
- only one sync job per corpus runs at a time
- later jobs supersede older jobs targeting older manifest tokens
- every stage transition must be persisted so `--continue` or a worker restart resumes safely
- a partially completed sync must either restart idempotently or continue from the last durable stage marker

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/authoritative-sync-worker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/authoritative-sync/worker.js src/storage/kuzu-store.js src/server/http.js src/cli/index.js test/authoritative-sync-worker.test.js
git commit -m "feat: add background authoritative Kuzu sync worker"
```

### Task 6: Route Imports Through The Fast Commit Path

**Files:**
- Modify: `src/core/imports/worker.js`
- Modify: `src/core/ingestion/pipeline.js`
- Test: `test/import-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that imports one paper into an existing corpus and asserts:
- the task becomes query-visible through the lite graph before authoritative sync finishes
- the import task records both fast-commit and authoritative-sync phases

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/import-worker.test.js`
Expected: FAIL because imports still run the old full `build-graph -> merge-graph -> write-index` path.

- [ ] **Step 3: Write minimal implementation**

Change import processing to:
- run `materialize`
- run `llm-optimize`
- produce changed semantic papers
- run fast local delta commit
- enqueue authoritative sync

Keep the old full pipeline as fallback for:
- source removals
- changed source sets that cannot be safely patched
- merge cases that exceed the local delta rules
- resume cases where a prior fast-commit job or authoritative sync job is still in progress and can be continued safely

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/import-worker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/imports/worker.js src/core/ingestion/pipeline.js test/import-worker.test.js
git commit -m "feat: route imports through fast local delta commits"
```

### Task 7: Expose Queue State And Freshness Through API

**Files:**
- Modify: `src/server/api.js`
- Modify: `src/server/http.js`
- Modify: `docs/services-and-ui.md`
- Test: `test/http-auth.test.js`

- [ ] **Step 1: Write the failing test**

Add tests for:
- reading corpus sync state through API
- listing pending authoritative sync jobs
- confirming that a corpus can be query-visible while authoritative sync is still pending

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http-auth.test.js`
Expected: FAIL because no authoritative sync state is exposed.

- [ ] **Step 3: Write minimal implementation**

Expose:
- sync status inside corpus metadata
- optional `GET /api/corpus-sync` if needed

Document the meaning of:
- `query-visible`
- `authoritative-sync pending`
- `authoritative-sync completed`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/http-auth.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/api.js src/server/http.js docs/services-and-ui.md test/http-auth.test.js
git commit -m "feat: expose authoritative sync queue state over API"
```

### Task 8: Add Performance Regression Tests For The Fast Path

**Files:**
- Create: `test/fast-local-commit.test.js`
- Modify: `test/import-worker.test.js`

- [ ] **Step 1: Write the failing test**

Add a bounded performance-oriented test that asserts, on fixture-sized corpora:
- fast local commit stays under a small threshold
- no Kuzu write happens on the fast path
- queries can see the new paper immediately after the local delta commit

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fast-local-commit.test.js`
Expected: FAIL because no fast-path contract exists yet.

- [ ] **Step 3: Write minimal implementation**

Tune:
- lock windows
- lite-view patch cost
- queue dedupe
- manifest/meta writes

Do not encode a brittle wall-clock target for CI; assert the qualitative contract and a small fixture-time budget.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fast-local-commit.test.js test/import-worker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/fast-local-commit.test.js test/import-worker.test.js
git commit -m "test: guard fast local delta commit behavior"
```
