# Remote Import And Skills

This page documents the highest-friction integration boundary in the current system: live remote imports driven by agents.

## Why Raw Route Calls Fail So Often

There are two recurring failure patterns:

1. callers invent raw `/api/*` routes that do not exist in the current server
2. callers pass a local file path as a remote `serverFilePath`

Both problems are solved by the current skill-local wrapper layer.

## Remote Path Boundary

For remote imports:

- `serverFilePath` means a path on the PaperNexus server machine
- local paths on the caller machine must be staged first

That staging is typically done through `ssh` and `rsync`.

## Main Skill-Local Wrapper Families

The canonical wrappers live under `SKILL/PaperNexus/scripts` and are re-exported into specialized skill directories.

Important wrappers include:

- `pn_main_graph_name.py`
- `pn_stage_sync.py`
- `pn_import_submit.py`
- `pn_import_queue.py`
- `pn_batch_import.py`
- `pn_graph_query.py`
- `pn_research_chains.py`
- `pn_idea_catalyst.py`

## Typical Single-Paper Flow

1. resolve the remote MCP URL, token, and current corpus name
2. if the source file is local, upload it to the server with staging
3. submit the remote import task
4. query progress by `paperId`, `source`, or `taskId`
5. only declare success when the task reports `completed` at the final stage

Recommended server-side inspection command:

```bash
cd /home/disk0/hyq/AutoResearch/PaperNexus
/home/disk0/hyq/miniconda3/bin/node ./src/cli/index.js imports status --corpus GCD
```

For a single task:

```bash
/home/disk0/hyq/miniconda3/bin/node ./src/cli/index.js imports log --corpus GCD --task-id imp:... --tail 40
```

## Typical Batch Flow

1. prepare one manifest JSON
2. call the batch wrapper once
3. inspect queue progress snapshots instead of sleeping blindly
4. use batch `status` or `wait` to track the whole set
5. fall back to single-task log inspection only when one paper is stuck

## What To Do When A Remote Import Looks Stuck

Remote imports now expose enough state to avoid guesswork.

Use this order:

1. inspect queue progress
2. check whether any task is actually `running`
3. if a PDF task started, inspect parser state under `~/.papernexus/pdf-parser/`
4. if nothing is `running`, inspect the import worker / `serve` process

Do not assume that “MCP is reachable” means “the import queue worker is healthy”.

## Historical Backlog Handling

The current system can quarantine stale pending import tasks out of the active queue instead of deleting them.

That matters for remote agents because it means:

- new resubmissions do not have to sit forever behind abandoned queue entries
- historical tasks can still be audited later
- queue cleanup can be made safe by default

When a task was quarantined, the authoritative record is per-corpus under:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

## Failed Task Recovery

Remote agents often treat `failed` as a hard stop. PaperNexus now avoids that for recoverable import states.

Before reserving normal work, the import worker scans failed tasks.

If the uploaded PDF/Markdown still exists and retry limits allow it, the task is reset to:

```text
pending / queued
```

If an equivalent later task already completed, the old failed task is changed to:

```text
completed / completed
```

with recovery metadata:

```json
{
  "recovery": {
    "status": "superseded",
    "supersededByTaskIds": ["imp:..."]
  }
}
```

That means an agent should treat `completed / completed` with `recovery.status = superseded` as a successful terminal state. The historical error remains in `events.log` for audit, but it is no longer the live workflow outcome.

This is especially important after duplicate submissions or old concurrent-commit failures. A task can have an old error log and still be safe to continue if its final task status is completed.

## Parser-Level Diagnostics For Remote Uploads

For PDF uploads, task logs alone may not tell you whether the parser is:

- still converting
- waiting for GPU
- already in fallback
- abandoned due to a restart

That state now lives in the parser runtime store:

```text
~/.papernexus/pdf-parser/
```

This is the preferred source when one remote import is “stuck” but the queue summary is too coarse.

## Recent Log Inspection

Operationally, the fastest way to see what happened to a recent upload is now:

```bash
bash scripts/pm2-papernexus-serve.sh recent
```

This focuses on import-related log lines instead of dumping all service output.

The native import CLI is usually better when you know the corpus or task id:

```bash
papernexus imports running --corpus GCD
papernexus imports log --corpus GCD --task-id imp:... --tail 80
```

The PM2 `recent` command is best when you do not yet know which task id matters.

## Maintenance Guidance

If remote import behavior changes, the docs maintenance order should be:

1. update the canonical skill wrapper under `SKILL/PaperNexus/scripts`
2. regenerate or update references
3. update this narrative page if the conceptual workflow changed

## Read Next

- [Imports And Queue](/pipeline/imports-and-queue)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
- [Operations Overview](/operations/)
