# Imports And Queue

Queued imports are the runtime path for ad hoc paper uploads after a corpus already exists.

## Why Imports Exist

`papernexus analyze` is ideal for whole source trees that PaperNexus already owns locally. Import tasks exist for a different problem:

- a user uploads one or more PDF or Markdown files
- the system needs to stage them safely
- the live graph must refresh asynchronously
- callers need progress, logs, and completion state

## Import Task Lifecycle

An import task typically moves through:

- `pending` / `queued`
- `running` + `materialize`
- `running` + `llm-optimize`
- `running` + `fast-commit`
- `completed` + `completed`
- or `failed`

Each task now also carries structured progress information, including:

- overall percent
- stage percent
- queue position
- processed vs total units where available
- current step text

The key detail is that **queue state and parser state are separate but linked**.

- queue state lives under the corpus import store
- parser state lives under the global `~/.papernexus/pdf-parser/` runtime root
- parser state can point back to `importTaskId` and `importStage`

That separation is deliberate: parser runs can be restarted, interrupted, or retried while queue state still tracks the graph-facing lifecycle.

### Status Is Attempt-Aware

The queue now treats import failures as attempt state, not necessarily permanent paper state.

That means a paper can have an old failed attempt while still being safe for agents to continue because:

- the same task was reset to `pending` and retried
- another equivalent task completed later
- the old failed task was marked `completed / completed` with `recovery.status = superseded`

Agent-facing rule: always read the latest task status and recovery metadata before treating `failed` as a hard blocker.

## Where Queue State Lives

Per corpus, import queue state lives under:

```text
<corpus-root>/.papernexus/imports/
```

Important files and directories:

- `queue.json`
- `content-index.json`
- `tasks/<task-hash>/task.json`
- `tasks/<task-hash>/events.log`
- `tasks/<task-hash>/sources/`
- `quarantine/<batch-id>/...`

This gives you three useful observability levels:

- queue-wide state
- per-task graph import state
- per-PDF parser run state

## What Actually Moves A Task Forward

The queue only advances when the **import worker** is running.

In the current implementation the import worker is started by `papernexus serve`, not by `papernexus mcp` alone. If the service is up but imports are disabled, or if the wrong root paths are configured, tasks can remain `pending` indefinitely.

Operationally that means:

- `MCP works` does not imply `import worker is consuming queue items`
- `queue_progress` can show tasks even when no worker is touching them
- a pile of `pending` tasks with `running = 0` usually points to worker startup, root-path, or lock problems rather than parser runtime problems

## Worker Throughput Strategy

The queue is optimized so that expensive parsing work can be prepared ahead of the final commit path.

In practice that means:

- later queued PDFs can be pre-parsed in the background
- per-task materialization is scoped to the uploaded task’s own `sources/` directory
- Stage 2 receives `changedSourceKeys`, so imports do not rerun whole-corpus LLM optimization
- when import batching is enabled, the worker may reserve several fresh `pending / queued` tasks under one worker lock, materialize them separately, then run one shared Stage 2 and one shared `fast-commit` over the union of their changed source keys
- final graph commit remains controlled and ordered through `fast-commit`; batching does not introduce concurrent graph commits
- parser-local state can survive restarts even when the queue task itself has not completed

The important current performance rule is:

```text
one uploaded paper, or one worker-selected import batch, should not trigger full-corpus Stage 2
```

Instead, import tasks should only optimize and commit the changed source keys associated with the uploaded task or the current logical batch.

Batching is intentionally logical, not physical:

- task ids, task directories, logs, status, progress, and final results remain per task
- a pre-existing `running` task is processed alone so resume semantics stay simple
- if one task fails during materialization, only that task fails; successfully materialized tasks can continue through the shared stages
- if the shared LLM optimization or fast commit fails, every task that entered that shared stage fails together and can be retried through the existing failed-task recovery path

For MCP/serve workloads, import batching is enabled by default. Configure it under `imports` or `import` when you want to tune limits or explicitly disable batching:

```json
{
  "imports": {
    "batchEnabled": true,
    "batchProgressive": true,
    "batchInitialTasks": 4,
    "batchMaxTasks": 16,
    "batchMaxFiles": 16,
    "batchMaxBytes": 104857600
  }
}
```

Set `"batchEnabled": false` if a deployment needs strictly one import task per graph commit.
With the default progressive policy, an active queue starts later pending work at 4 tasks per logical batch, then grows to 8 and 16 while pending work remains. If fewer tasks are pending than the current target, the worker reserves all pending tasks immediately as one logical batch instead of waiting to fill the target. When the queue drains, the next burst starts from 4 again.

## Timeout And Recovery Policy

The current system now distinguishes between two different “stuck queue” cases.

### 1. `running` tasks with no heartbeat

These are tasks that were actually reserved by the worker but stopped making progress.

Typical causes:

- parser process hung
- parser child exited without producing a final update
- GPU wait never progressed
- upstream runtime died mid-stage

Current policy:

- if a `running` task stops emitting progress long enough, the worker fails it automatically
- this prevents one dead task from owning the queue forever

### 2. `pending` tasks that never start

These are different. They usually indicate:

- no import worker is consuming the queue
- the worker is pointed at a different corpus set
- the queue was abandoned during an older broken deployment
- a previous backlog was never cleaned up

Current policy:

- if there are no actively `running` import tasks
- and a task has remained `pending` in `queued` long enough
- the worker can quarantine it out of the active queue

This is not deletion. It is an unblock mechanism.

### 3. `failed` tasks that can be recovered

Failed import tasks are inspected by the worker before it reserves normal work.

There are two recovery paths:

- if an equivalent completed task exists, the failed task is marked `completed / completed` with `recovery.status = superseded`
- if no completed equivalent exists but the uploaded file still exists and retry limits allow it, the failed task is reset to `pending / queued`

This is designed for failures such as:

- old concurrent graph commit conflicts
- transient parser/runtime failures
- worker restarts during materialization
- duplicate submissions where a later task already succeeded

Default failed retry policy:

- retry delay: 5 minutes
- max retries: 3

After the retry limit, the task remains failed so an operator can inspect it.

## Quarantine Instead Of Delete

Stale pending tasks are now isolated into:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

Each batch contains:

- `summary.json`
- per-task directories
- preserved task metadata
- preserved task logs
- preserved uploaded source files

The goals are:

- unblock the live queue
- preserve enough evidence to audit what was removed
- allow selective manual resubmission
- avoid blindly dropping uploads

## How To Interpret Common Queue States

### `pending` / `queued`

The task has been accepted but not yet reserved by the import worker.

This is normal for short periods and suspicious for very long periods.

### `running` + `materialize`

The task has been reserved and is doing source preparation:

- markdown caching
- PDF parser work
- semantic snapshot generation

If a PDF is involved, this is the stage where parser-local state is most useful.

### `running` + `llm-optimize`

The task has passed parsing and is refreshing semantic objects and relation extraction.

### `running` + `fast-commit`

The task is applying graph updates, not parsing PDFs anymore.

### `failed`

The task failed for the current attempt. It may still be recoverable.

The worker can later:

- retry it if uploaded files still exist
- mark it completed if an equivalent completed task is found
- leave it failed if it is missing files or past retry limits

This is why agents should not stop only because an old log line contains `[error]`.

### quarantined stale pending

This is no longer in the active queue. It has been moved aside so newer work can proceed.

### completed / superseded

This means an old failed task was recovered by an equivalent completed import. Treat it as success for workflow continuation, while preserving the original error log for audit.

## Relationship To PDF Parser State

For PDF uploads, the queue is only one half of the story.

The parser runtime additionally persists:

- selected parser
- active parser
- fallback parser transitions
- waiting-for-resource state
- event logs

under:

```text
~/.papernexus/pdf-parser/
```

That means you can answer questions like:

- “is the task still queued or did parsing actually start?”
- “did MarkItDown fail and Docling take over?”
- “is Docling waiting for GPU or already converting?”

without guessing from elapsed time.

## Local Path Vs Server Path

One of the most important operational boundaries is:

- `serverFilePath` means **a path on the PaperNexus server**
- it does **not** mean a path on the caller’s machine

That is why the remote import wrappers stage local files with `ssh` and `rsync` before they call the import MCP tool.

## Batch Imports

Batch imports are manifest-driven. Instead of asking an agent to loop manually over many papers, PaperNexus provides batch wrappers that:

- stage files
- submit tasks
- store task ids in a local registry
- query batch progress from a queue snapshot

This avoids the common failure mode where agents guess status from elapsed time alone.

The wrapper batch and the worker batch are different layers:

- the wrapper batch is a control-plane convenience for submitting and tracking many task ids
- the worker batch is a graph-commit optimization that can complete several queued task ids with one shared LLM optimization and one shared authoritative sync job

Status and wait commands do not need new arguments for worker batching. They still read per-task queue state; tasks completed by one worker batch simply share `result.batch.batchId` and the same `result.authoritativeSync.jobId`.

## CLI Queue Inspection

The native CLI can inspect import state directly from the corpus store:

```bash
papernexus imports status --corpus demo-corpus
papernexus imports running --corpus demo-corpus
papernexus imports log --corpus demo-corpus --task-id imp:...
```

Useful flags:

- `--limit <n>` controls how many running, queued, and failed examples are shown
- `--tail <n>` limits task log output
- `--json` returns a structured payload for agents and scripts

On deployments where `node` is not on the login shell path, use the absolute Node binary:

```bash
~/miniconda3/bin/node ./src/cli/index.js imports status --corpus demo-corpus
```

## Queue Observability

The queue can now be inspected at two useful levels:

### Per Task

Use this when you care about one paper:

- current stage
- stage progress
- task log
- final success or failure

### Queue Snapshot

Use this when you care about a batch or the whole live queue:

- queued count
- running count
- completed count
- failed count
- overall percent
- remaining tasks

Recovered failures should disappear from `failed` counts. If an old failed attempt was superseded by a completed retry, the task counts as completed.

### Parser Run State

Use this when a PDF parse itself is the question:

- parser run status
- current parser step
- fallback transitions
- waiting-for-GPU status
- parser event log path

This is the fastest way to distinguish:

- true parser stalls
- queue starvation
- backlog from abandoned pending tasks
- normal long-running conversion

## Operational Advice

- Use the remote HTTP MCP surface for live imports.
- Use the skill-local wrappers instead of hand-written raw submits.
- Treat `completed + completed` as the real “safe to claim synced” condition.
- Treat `completed + completed + recovery.status=superseded` as safe to continue; it means a later equivalent task already recovered the paper.
- Inspect recent serve logs when a task appears stalled; the PM2 wrapper now includes a focused `recent` view for this.
- If `running = 0` for a long time, debug worker startup and root-path routing before blaming PDF parsers.
- If a parser started, inspect `~/.papernexus/pdf-parser/latest/<sourceHash>.json` and the referenced `events.log`.
- Prefer quarantine over deletion when cleaning historical pending backlog.

## Read Next

- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
- [PDF Parsers And Runtime](/pipeline/pdf-parsers-and-runtime)
- [Operations Overview](/operations/)
- [Generated CLI Reference](/reference/generated/cli)
