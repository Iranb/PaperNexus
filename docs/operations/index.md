# Operations Overview

This section focuses on running PaperNexus as a durable system rather than as a one-off local CLI command.

## Configuration

Runtime behavior is controlled by the discovered or explicitly supplied config file, usually `~/.papernexus/config.json`. Configuration decides:

- source inputs
- storage roots
- parser defaults
- LLM provider defaults
- server host, port, token, and MCP settings

## Important Runtime Roots

The current system uses several distinct runtime roots. The most important ones are:

- `~/.papernexus/config.json`
- `~/.papernexus/index-store/` or the configured corpus storage root
- `~/.papernexus/pdf-parser/` for parser run state and logs
- `~/.papernexus/pdf-bench/` for standalone parser probes such as `test-pdf-to-markdown`

Per corpus, import queue state lives under:

```text
<corpus-root>/.papernexus/imports/
```

This split is intentional:

- queue state is corpus-local
- parser run state is global runtime state

## Service Responsibilities

Operationally, the current long-running roles are:

- `serve` process
- import worker
- enhancement worker
- authoritative sync worker

The critical nuance is:

- `papernexus serve` is what starts the import worker
- `papernexus mcp` alone is not the same thing as “the queue is being consumed”

So if a remote client can talk to MCP but imports never leave `pending`, the first suspicion should be the `serve` process and import worker startup, not parser correctness.

## Deployment Modes

The system supports several deployment patterns:

- foreground local CLI use
- local browser dashboard
- background services
- remote authenticated HTTP serve with remote MCP

## PM2 And Service Wrappers

For long-running server processes, the repository includes service wrappers and a PM2-oriented serve wrapper that handles:

- starting `papernexus serve`
- daily log rollover
- status inspection
- focused recent import log extraction

The PM2 wrapper is designed to work on normal `$HOME` installs and on disk-mounted server installs such as:

```text
/srv/papernexus/miniconda3/bin/node
/srv/papernexus/miniconda3/bin/pm2
```

When invoking PM2, the wrapper injects the resolved Node directory into `PATH`. This matters because `pm2` can be a shebang script that internally calls `/usr/bin/env node`.

Useful commands:

```bash
scripts/pm2-papernexus-serve.sh status
scripts/pm2-papernexus-serve.sh restart
scripts/pm2-papernexus-serve.sh recent
scripts/pm2-papernexus-serve.sh recent --task-id imp:...
```

## Logs

There are several useful log perspectives:

- CLI stdout for one-shot local commands
- serve logs for browser/API/MCP and worker startup
- import task logs for per-task detail
- PM2 wrapper daily logs for recent processing history

The current parser layer adds another one:

- parser run logs under `~/.papernexus/pdf-parser/runs/<runId>/events.log`

This is the fastest source when one PDF appears stuck but the queue task itself is too coarse.

## Queue Stall Triage

When import backlog grows, split the problem into two categories before doing anything destructive.

First inspect completed task metrics when they exist. `result.metrics.importPerformance.stageTimingsMs` separates materialization, Stage 2 LLM optimization, fast commit, and total wall time; `llmBatches` shows whether work ran through chunk semantic/relation batches or paper-level fallback. If Stage 2 dominates, parser/GPU tuning is probably not the limiting factor.

### Case A: `running > 0`

That means the queue worker is consuming tasks and at least one task is live.

Focus on:

- parser state
- GPU waits
- parser child process hangs
- stage heartbeats

### Case B: `running = 0`, many old `pending`

That means the queue is not being consumed or old orphan tasks are blocking visibility.

Focus on:

- whether `serve` is actually running
- whether imports are enabled in that process
- whether the worker sees the correct corpus root
- whether an old worker lock or multi-instance deployment is preventing progress

If `imports.batchCoalesceMs` is configured, a short worker-held wait for more pending tasks is expected while the queue is underfilled. Treat it as suspicious only after it exceeds the configured coalescing window plus the normal worker heartbeat/timeout policy.

## Timeout And Quarantine Strategy

The current system now has three automatic recovery policies.

### Running-task timeout

If an import task is already `running` but stops emitting progress long enough, the worker fails it automatically.

This prevents:

- parser deadlocks
- mid-stage crashes that never release the queue
- indefinite ownership of the worker lane

### Pending-task quarantine

If there are no active `running` tasks and old `pending` tasks remain in `queued` long enough, the worker can quarantine them out of the active queue.

This is designed for historical backlog such as:

- orphan queue items after service outages
- abandoned queue states from earlier buggy deployments
- mass pending items that block new resubmissions even though no worker is actually processing them

Quarantine lives under:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

The important policy choice is that these items are **not deleted**. They are preserved with:

- task metadata
- logs
- uploaded source files
- quarantine summary metadata

That gives operations a reversible cleanup path.

### Failed-task recovery

Failed import tasks are not always permanent failures.

Before reserving work, the import worker now checks active failed tasks.

If uploaded source files still exist and retry limits allow it, a failed task is requeued:

```text
failed / materialize
  -> pending / queued
```

If a later equivalent task already completed, the old failed task becomes:

```text
completed / completed
```

with `recovery.status = superseded`.

This keeps agent workflows from stopping on stale historical failure records. It also keeps direct task-id queries honest: a task that was historically failed but later recovered should show completed as its final state.

Default policy:

- retry delay: 5 minutes
- max retries: 3
- old equivalent failures become completed/superseded
- missing-file failures remain failed for operator inspection

## Parser Runtime Troubleshooting

The recommended parser debugging order is:

1. run `test-pdf-to-markdown`
2. inspect the printed `Parse state:` path
3. inspect the printed `Parse log:` path
4. decide whether the problem is:
   - parser startup
   - parser conversion
   - GPU wait
   - fallback chaining
   - queue starvation

This is much faster than trying to infer parser state only from import queue summaries.

## Import Queue Inspection

Use the native CLI before opening raw JSON files:

```bash
papernexus imports status --corpus demo-corpus
papernexus imports running --corpus demo-corpus
papernexus imports log --corpus demo-corpus --task-id imp:... --tail 40
```

On the GPU server deployment, use the known Node binary:

```bash
cd ~/PaperNexus
~/miniconda3/bin/node ./src/cli/index.js imports status --corpus demo-corpus
```

Interpretation:

- `0 pending`, `0 running`, `0 failed`, `100%` means the active queue is done
- `completed / completed` with `recovery.status = superseded` is safe to treat as success
- a historical `[error]` line in `events.log` is not necessarily terminal if the final task status is completed
- quarantined tasks remain auditable but do not block active queue progress

## MarkItDown And Project LLM Reuse

The current MarkItDown integration now tries to reuse the project `llm.*` configuration automatically.

That means:

- no second parser-only LLM block is required for normal use
- if `llm.model` and `llm.baseUrl` are configured, MarkItDown can auto-enable its LLM-assisted path
- if the project LLM configuration is absent or incomplete, MarkItDown falls back to plain conversion automatically

This reduces config duplication and keeps parser behavior aligned with the rest of the system.

## Performance Triage

When imports are slow, identify the stage first.

Typical stage meanings:

- `materialize`: source reading, PDF conversion, markdown cache, semantic snapshot
- `llm-optimize`: LLM semantic extraction and optional relation extraction
- `fast-commit`: lite graph delta and authoritative sync queueing

Recent production measurements showed that after scoped import processing was enabled:

- PDF parsing was usually sub-second to low seconds
- materialize was usually under a few seconds
- LLM Stage 2 dominated per-paper latency
- fast-commit was a small but visible fixed cost

That means the best future throughput improvement is batching multiple changed import sources through one Stage 2 and one fast commit, not blindly increasing Docling parallelism.

## Documentation Maintenance

The docs site itself is now part of operations because it ships with the repository and deploys through GitHub Pages.

The maintenance loop is:

```bash
npm run docs:generate
npm run docs:build
```

When behavior changes, update whichever of these two layers is affected:

- generated references if the code contract changed
- curated narrative pages if the design explanation changed

## Troubleshooting Style

Operational debugging in PaperNexus usually works best when you identify the failing layer first:

- source parsing
- semantic extraction
- graph commit
- queue state
- interface misuse
- background worker scheduling

For the current system, it is especially important to separate:

- queue starvation
- parser execution
- Stage 2 semantic extraction
- graph commit/write-index

They now each have separate persisted signals and should be debugged as separate layers.

Trying to debug everything at the HTTP surface alone usually hides the real cause.

## Read Next

- [Generated Config Reference](/reference/generated/config)
- [Generated HTTP Serve Reference](/reference/generated/http-serve)
- [Generated Scripts Reference](/reference/generated/scripts)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
