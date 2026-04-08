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

## Worker Throughput Strategy

The queue is optimized so that expensive parsing work can be prepared ahead of the final commit path.

In practice that means:

- later queued PDFs can be pre-parsed in the background
- final graph commit remains controlled and ordered
- queue throughput improves without mixing multiple tasks into one unsafe graph commit

## Operational Advice

- Use the remote HTTP MCP surface for live imports.
- Use the skill-local wrappers instead of hand-written raw submits.
- Treat `completed + completed` as the real “safe to claim synced” condition.
- Inspect recent serve logs when a task appears stalled; the PM2 wrapper now includes a focused `recent` view for this.
