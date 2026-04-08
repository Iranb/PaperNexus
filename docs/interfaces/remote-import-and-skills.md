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

## Typical Batch Flow

1. prepare one manifest JSON
2. call the batch wrapper once
3. inspect queue progress snapshots instead of sleeping blindly
4. use batch `status` or `wait` to track the whole set
5. fall back to single-task log inspection only when one paper is stuck

## Recent Log Inspection

Operationally, the fastest way to see what happened to a recent upload is now:

```bash
bash scripts/pm2-papernexus-serve.sh recent
```

This focuses on import-related log lines instead of dumping all service output.

## Maintenance Guidance

If remote import behavior changes, the docs maintenance order should be:

1. update the canonical skill wrapper under `SKILL/PaperNexus/scripts`
2. regenerate or update references
3. update this narrative page if the conceptual workflow changed
