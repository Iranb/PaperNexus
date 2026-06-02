# Import Recovery And Performance

This page documents the current production import queue behavior after the latest queue recovery and performance work.

It is written for three audiences:

- operators who need to know why a queue is slow or stuck
- agents that need to decide whether to continue, retry, or wait
- maintainers who need to extend import processing without reintroducing backlog failures

## Current Queue Contract

The active import queue is a **corpus-local durable work queue**. It is not just an in-memory worker list.

For each corpus, PaperNexus stores active import state under:

```text
<corpus-root>/.papernexus/imports/
  queue.json
  content-index.json
  tasks/<task-hash>/
    task.json
    events.log
    sources/
  quarantine/<batch-id>/
```

The active queue is what normal tools and agents should read first:

```bash
papernexus imports status --corpus <name>
papernexus imports running --corpus <name>
papernexus imports log --corpus <name> --task-id <task-id>
```

On a deployment where `node` is not on the login shell path, use the absolute node binary:

```bash
~/miniconda3/bin/node ./src/cli/index.js imports status --corpus demo-corpus
```

## State Model

An import task has two dimensions:

- **task status**: `pending`, `running`, `completed`, `failed`
- **task stage**: `queued`, `materialize`, `llm-optimize`, `fast-commit`, `completed`

Typical transitions:

```text
pending / queued
  -> running / materialize
  -> running / llm-optimize
  -> running / fast-commit
  -> completed / completed
```

Failure is always attempt-scoped. A task may fail because one attempt encountered a transient conflict, but the same paper may later be recovered by:

- the same task being reset to `pending`
- a later equivalent task completing successfully
- an operator or worker marking the old task `completed / completed` with `recovery.status = superseded`

This distinction matters because agents should not treat every historical `failed` record as a permanent paper-level failure.

## Automatic Failed-Task Recovery

The import worker now runs a failed-task recovery pass before reserving normal work.

For every active `failed` task, it decides one of three outcomes.

### 1. Superseded By Completed Task

If an equivalent completed task exists, the failed task is converted to:

```text
completed / completed
```

The task also receives recovery metadata:

```json
{
  "recovery": {
    "status": "superseded",
    "reason": "equivalent-completed-import",
    "supersededByTaskIds": ["imp:..."]
  }
}
```

This is the safest behavior for historical transient failures. It means:

- queue summaries no longer show stale failed work
- direct task-id lookups no longer report a false blocker
- logs still preserve the original error and recovery event
- agents can continue instead of retrying an already recovered paper

Equivalence is detected by:

- uploaded file content fingerprint when available
- normalized file identity when content matching is not enough

The normalized identity path handles cases such as:

```text
2603.24268.pdf
260324268.pdf
```

These may refer to the same paper even though the filenames are not byte-identical.

### 2. Requeued For Retry

If no completed equivalent exists, but the original uploaded file still exists under the task `sources/` directory, the task can be reset to:

```text
pending / queued
```

The retry state is recorded:

```json
{
  "recovery": {
    "status": "queued-retry",
    "retryCount": 1,
    "previousError": {
      "message": "..."
    }
  }
}
```

The task progress message also changes, so observers see that this is not a brand-new upload but a recovered retry.

### 3. Left Failed

A task remains `failed` when:

- uploaded files are missing
- retry delay has not elapsed
- retry limit has been reached
- the task does not have enough evidence to safely retry

The default retry policy is intentionally bounded:

```text
retry delay: 5 minutes
max retries: 3
```

Config/worker options can override this through:

- `importFailedRetryDelayMs`
- `failedRetryDelayMs`
- `importFailedRetryMax`
- `failedRetryMax`

## What Happened To The Historical 33 Failed Tasks

One production-style queue incident showed:

```text
117 completed
33 failed
```

After auditing those records:

- all 33 original uploaded files still existed
- 24 were PDF uploads
- 9 were Markdown uploads
- the dominant failure mode was old concurrent commit conflicts, not missing files
- all 33 had equivalent completed imports later in the queue

They were therefore marked as recovered completed records, not retried.

The active queue became:

```text
117 completed
0 failed
0 pending
0 running
overall progress: 100%
```

Historical task logs still show the original error, followed by the recovery event. That is deliberate: the system preserves the audit trail while presenting the correct current state to agents.

## Stale Pending Quarantine

Failed recovery is different from stale pending quarantine.

Quarantine is for tasks that sit in:

```text
pending / queued
```

for too long when no worker is running any task.

Those tasks are moved out of the active queue into:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

Quarantine is not deletion. It preserves:

- `task.json`
- `events.log`
- uploaded source files
- `quarantine.json`
- batch `summary.json`

Quarantine is appropriate for orphaned historical queue entries. It is not the first-line response to a normal parser failure.

## Performance Model

A modern import task is no longer supposed to run the whole corpus through Stage 2.

The current intended path for a single uploaded paper is:

```text
task.sourcesDir
  -> materialize only the task-local upload
  -> merge new manifest entry into existing corpus manifest
  -> llmOptimizeCorpus(changedSourceKeys = [new source])
  -> fastCommitCorpus(changedSourceKeys = [new source])
```

This is the important fix that prevents:

```text
1 uploaded PDF -> 85 paper LLM optimization
```

from happening again.

When worker-side batching is enabled, several pending imports can share the same scoped Stage 2 call and fast commit. The batch is still logical: task ids, directories, logs, status, and recovery state remain per task. `imports.batchCoalesceMs` can optionally hold an underfilled batch for a short bounded window so bursty submissions are grouped before Stage 2 starts. Leave it at the default `0` when first-paper latency matters more than throughput.

Every completed import now records `result.metrics.importPerformance`. Operators should use this object before guessing where the time went. The fields include:

- `contractVersion: "import-performance-v1"`
- `mode: "single"` or `"batch"`
- per-task and batch counts such as `changedSourceKeyCount`, `batchTaskCount`, and `batchChangedSourceKeyCount`
- `stageTimingsMs.materialize`, `stageTimingsMs.llmOptimize`, `stageTimingsMs.fastCommit`, and `stageTimingsMs.total`
- `llmBatches`, including the observed semantic/relation or chunk semantic/chunk relation batch events

For chunk-based Stage 2, the LLM batch phases are reported as `chunk-semantic-extraction` and `chunk-relation-extraction`. Paper-level fallback uses `semantic-extraction` and `relation-extraction`.

## Current Timing Shape

Recent production-style measurements after the latest import fixes showed roughly:

| Stage | Typical time per paper |
| --- | ---: |
| PDF to Markdown | 0.3s to 1.5s |
| Materialize total | 0.4s to 2.2s |
| LLM Stage 2 semantic extraction | 30s to 40s |
| Fast commit | 3.5s to 4s |
| End-to-end import task | 40s to 46s |

The main bottleneck is currently **LLM latency**, not PDF parsing.

This has two operational consequences:

- making Docling more parallel will not help most normal imports
- batching multiple changed papers into one LLM Stage 2 call produces the largest immediate throughput improvement

## Import LLM Defaults

Import workers use a backlog-friendly LLM profile.

By default:

- semantic extraction remains enabled according to configured import/analyze mode
- import relation extraction is off unless explicitly enabled for imports
- import LLM batch size defaults to `12`

This is different from full-corpus `analyze` or `optimize`, where relation extraction may still be enabled as part of the normal corpus build policy.

The purpose is to keep live upload queues moving. You can still re-enable relation extraction for imports if you prefer richer per-paper graph semantics over throughput.

Recommended backlog-clearing config:

```json
{
  "imports": {
    "relations": false,
    "batchSize": 12
  }
}
```

If a deployment has a fast and reliable LLM endpoint, try:

```json
{
  "imports": {
    "relations": false,
    "batchSize": 16
  }
}
```

## PDF Parser Parallelism

PaperNexus supports parser concurrency, but parser parallelism is not always the right lever.

Use parser parallelism when the queue is dominated by:

- large PDF parsing
- Docling fallback
- OCR-heavy input
- slow external parser services

Do not expect parser parallelism to help when the task is already in:

```text
llm-optimize
```

In that case, the bottleneck is usually LLM request latency or provider throughput.

## Docling And GPU

Docling is still protected by GPU-aware scheduling:

- automatic GPU selection when CUDA devices are not pinned
- per-GPU filesystem locks
- free-memory threshold
- wait/poll loop when no GPU slot is available
- thread caps for BLAS/OpenMP-style libraries

This prevents old failures where several Docling processes loaded on the same GPU and exhausted memory.

Operationally, if `nvidia-smi` shows GPUs idle while queue tasks are slow, Docling is not the bottleneck.

## Agent Guidance

Agents should interpret import task states as follows.

### Safe To Continue

Continue when:

- queue summary has `failed = 0`
- the task is `completed / completed`
- the task is `completed / completed` with `recovery.status = superseded`

Superseded completed means the old attempt failed, but an equivalent later task already completed the paper.

### Wait And Poll

Wait and poll when:

- status is `pending / queued`
- status is `running / materialize`
- status is `running / llm-optimize`
- status is `running / fast-commit`

Use:

```bash
papernexus imports running --corpus <name>
papernexus imports log --corpus <name> --task-id <id> --tail 40
```

### Escalate

Escalate when:

- a failed task remains failed after retry limit
- uploaded files are missing
- parser state shows repeated failure for the same PDF
- the queue has pending tasks but no running task and no worker activity

## Operator Checklist

When queue behavior looks wrong, check in this order:

1. `papernexus imports status --corpus <name>`
2. `papernexus imports running --corpus <name>`
3. `papernexus imports log --corpus <name> --task-id <id>`
4. parser state under `~/.papernexus/pdf-parser/`
5. service status through `scripts/pm2-papernexus-serve.sh status`
6. focused logs through `scripts/pm2-papernexus-serve.sh recent`
7. GPU status through `nvidia-smi`

If queue summary shows no failed tasks and no remaining work, the import backlog is done even if quarantine retains historical task evidence.

## Future Throughput Direction

The next major performance improvement should be **batch import execution**, not more ad hoc parser parallelism.

The target design is:

```text
N pending tasks
  -> materialize N uploaded files
  -> one llmOptimizeCorpus(changedSourceKeys = N)
  -> one fastCommitCorpus(changedSourceKeys = N)
  -> mark each task completed
```

That would let PaperNexus actually use LLM batch size for import queues. With a batch size of 12, the system could turn many `~40s per paper` imports into something closer to `~40s per batch`, depending on provider latency and prompt size.

Until that is implemented, the current queue is still safe and recoverable, but LLM latency remains the dominant per-task cost.

## Read Next

- [Imports And Queue](/pipeline/imports-and-queue)
- [PDF Parsers And Runtime](/pipeline/pdf-parsers-and-runtime)
- [Operations Overview](/operations/)
- [Generated CLI Reference](/reference/generated/cli)
