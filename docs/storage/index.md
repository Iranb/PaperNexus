# Storage Overview

PaperNexus persists more than just one graph file. The storage model is what makes resumability, queue recovery, and incremental refresh practical.

## Main Persistent Artifacts

Each corpus maintains several classes of stored state:

- markdown cache
- semantic snapshots
- source manifest
- authoritative graph
- lite graph
- corpus metadata
- import queue state
- enhancement queue state
- authoritative sync queue state
- registry entries
- PDF parser runtime pointers and logs under the global runtime root

## Typical Corpus Layout

The exact layout varies by corpus root, but conceptually you should expect:

```text
index-store/
  .papernexus/
    graph.json or graph.kuzu
    graph.lite.json
    graph.lite.state.json
    meta.json
    sources.json
    staged/
    papers/
    markdown/
    marker/
    imports/
      queue.json
      content-index.json
      tasks/
      quarantine/
    enhancements/
    authoritative-sync/
```

The important design point is that not all of these files serve the same audience. Some are for build resumability, some are for interactive reads, and some are purely worker-facing.

## Why So Many Files Exist

The storage model is intentionally decomposed because each artifact answers a different operational question.

- markdown cache answers “do I need to parse the PDF again?”
- semantic snapshot answers “do I need to rerun extraction?”
- source manifest answers “which sources currently define this corpus?”
- authoritative graph answers “what is the full source of truth?”
- lite graph answers “what should interactive reads and search use?”
- queue stores answer “what background work is still in flight?”

## Import Queue Storage

The import store is deliberately split into:

- `queue.json`: queue-ordered snapshots of import tasks
- `content-index.json`: upload fingerprint to task mapping
- `tasks/<task-hash>/task.json`: authoritative per-task state
- `tasks/<task-hash>/events.log`: append-only task events
- `tasks/<task-hash>/sources/`: preserved uploaded files
- `quarantine/<batch-id>/`: isolated historical tasks

`task.json` is treated as the source of truth when it diverges from `queue.json`. The queue store has self-healing logic that reconciles stale queue snapshots from task files.

This matters after restarts or older deployments because it prevents stale `queue.json` status from hiding the actual task state.

## Failed Import Recovery Storage

Recoverable failures update the task record itself.

A failed task that can be retried becomes:

```json
{
  "status": "pending",
  "stage": "queued",
  "recovery": {
    "status": "queued-retry",
    "retryCount": 1
  }
}
```

A failed task that was already recovered by another equivalent task becomes:

```json
{
  "status": "completed",
  "stage": "completed",
  "recovery": {
    "status": "superseded",
    "supersededByTaskIds": ["imp:..."]
  }
}
```

The original error remains in `events.log`, so auditability is preserved while the final task state reflects the current truth.

## PDF Parser Runtime Storage

PDF parser runs are global runtime artifacts, not corpus-local graph artifacts.

They live under:

```text
~/.papernexus/pdf-parser/
  latest/<sourceHash>.json
  runs/<runId>/
    state.json
    events.log
```

This lets operators inspect parser progress even if the import worker restarts or a task later fails at graph commit.

## Lite Graph

The lite graph is a materialized view optimized for fast read access, search token lookups, and incremental delta application. It is not an unrelated second graph model; it is a derivative optimized for responsiveness.

## Corpus Meta

`meta.json` is more than a count summary. It now also carries derived graph metadata such as persisted domain distance information so those higher-order structures survive incremental update paths.

## Incremental Consistency

Recent work ensures that derived graph structures are refreshed not only during full rebuilds but also during:

- fast commit
- authoritative sync
- graph mutation writeback
- recovered import retries
- scoped import Stage 2 and fast commit updates

That closes one of the common consistency gaps where lite state could be fresher than higher-order metadata.

## Storage Design Tradeoff

PaperNexus favors **more explicit files with narrower responsibility** over a single opaque blob. That increases the number of artifacts, but it makes the system dramatically easier to recover, inspect, and incrementally refresh.

## Read Next

- [Generated Module Map](/reference/generated/module-map)
- [Generated Graph Schema](/reference/generated/graph-schema)
- [Imports And Queue](/pipeline/imports-and-queue)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
