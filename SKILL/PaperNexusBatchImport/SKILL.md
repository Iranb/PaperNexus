---
name: papernexus-batch-import
description: Use when an agent needs to upload or track multiple local PDF or Markdown papers into a live PaperNexus corpus through a fixed JSON manifest and remote HTTP MCP wrappers.
---

# PaperNexus Batch Import

Use this skill when the task is to ingest many local papers into a running PaperNexus server.

## Default Rule

For two or more files, prefer:

- `python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py`

Do not write ad-hoc shell loops. The batch wrapper is the default control plane because it keeps one manifest format, one task registry, and one `summary/items` response shape.
It also uses one remote `queue_progress` snapshot for status reads, so agents do not need to infer progress from elapsed time.

## Manifest Format

```json
{
  "version": 1,
  "defaults": {
    "mcpUrl": "http://211.71.76.29:4821/mcp",
    "corpus": "GCD",
    "sshTarget": "hyq@211.71.76.29",
    "remoteStagingRoot": "/tmp/papernexus-import-staging",
    "trigger": "mcp"
  },
  "papers": [
    {
      "paperId": "iclr2025-oral-data-shapley",
      "source": "/absolute/local/path/to/paper.pdf",
      "sourceKind": "pdf"
    }
  ]
}
```

Rules:

- `version` must be `1`
- `papers` must be non-empty
- each paper must include `source`
- `paperId` is strongly recommended
- optional per-paper overrides: `remoteDir`, `serverFilePath`, `taskId`
- `source` is the local file path on the agent machine
- `serverFilePath` is only for files that already exist on the remote PaperNexus server
- if a server-home path is known, store it as `~/...`, not `/home/<user>/...`
- do not copy a local `/Users/...` path into `serverFilePath`

## Workflow

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py template

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  submit

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  status

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  wait --timeout 1800 --interval 15
```

`submit` behavior:

- if a paper already has `serverFilePath`, the wrapper submits that remote file directly
- if a paper only has local `source`, the wrapper stages it with `ssh`/`rsync` first
- the remote MCP submit step always receives a server-side `serverFilePath`, never the raw local path
- `remoteDir` may be `/tmp/...` or `~/...`; for server-home paths prefer `~/...`

## Status Rules

- `summary.submitted`: tasks accepted by the server
- `summary.completed`: tasks with `status=completed`
- `summary.failed`: tasks that failed after submission
- `summary.submitFailed`: items that never became remote tasks
- `summary.remaining`: tasks still `pending` or `running`
- `summary.overallPercent`: aggregate progress across the returned batch items

Per paper:

- `submitted=true` means the server accepted a task
- `synced=true` means the task reached `completed`
- `progress.percent` is the per-task overall progress
- `progress.stagePercent` is the current-stage progress
- `progress.queuePosition` shows where the task sits among unfinished queue entries
- `registry.matchedBy` explains whether task resolution came from `paper-id`, `source`, `task-id`, or `remote-scan`

Do not claim a paper is in the graph when only `submitted=true`.

## Batch Tracking Rules

- Use `status` during uploads to read a live batch snapshot.
- Use `wait` when you need a terminal batch result; it polls all tasks round-robin instead of waiting one paper at a time.
- Prefer `paperId` in the manifest so registry matching stays stable across retries.
- During uploads, read `summary.remaining`, `summary.overallPercent`, and each paper's `progress.percent`.
- If one paper is stuck, inspect it with `python3 SKILL/PaperNexusBatchImport/scripts/pn_import_queue.py status --paper-id "<paperId>"` or `log --paper-id "<paperId>"`.
