---
name: papernexus-batch-import
description: Use when an agent needs to upload or track multiple local PDF or Markdown papers into a live PaperNexus corpus through a fixed JSON manifest and remote HTTP MCP wrappers.
---

# PaperNexus Batch Import

Use this skill when the task is to ingest many local papers into a running PaperNexus server.
Assume OpenClaw already exposes PaperNexus as MCP server `papernexus-remote`.
Do not repeat IPs, MCP URLs, or bearer tokens in the skill.

## Default Rule

For two or more files, prefer:

- `python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py`

Do not write ad-hoc shell loops. The batch wrapper is the default control plane because it keeps one manifest format, one task registry, and one `summary/items` response shape.
It also uses one remote `queue_progress` snapshot for status reads, so agents do not need to infer progress from elapsed time.
When the PaperNexus import worker has logical batching enabled, several submitted task ids may complete from one shared graph commit and authoritative sync job; keep tracking by task id as usual.
For live graph status reads on already-staged files, `import_workflow` on `papernexus-remote` remains the authoritative MCP surface.

## Manifest Format

```json
{
  "version": 1,
  "defaults": {
    "corpus": "GCD",
    "remoteStagingRoot": "/tmp/papernexus-import-staging",
    "trigger": "mcp"
  },
  "papers": [
    {
      "paperId": "iclr2025-oral-data-shapley",
      "source": "/absolute/local/path/to/paper.pdf",
      "sourceKind": "pdf",
      "identifiers": {
        "doi": "10.48550/arXiv.2401.12345"
      },
      "sourceProvider": "filesystem"
    }
  ]
}
```

Rules:

- `version` must be `1`
- `papers` must be non-empty
- each paper must include `source`
- each paper must include at least one precise identifier through an `identifiers` object or equivalent per-paper fields
- strong paper identity prefers `doi`, `arxivId`, `pmid`, or `pmcid`
- `isbn` and `issn` are stored as metadata but are not preferred article identity keys
- `paperId` is strongly recommended
- only add manifest-scoped connection overrides when one batch truly needs different staging behavior from the default environment
- optional per-paper overrides: `remoteDir`, `serverFilePath`, `taskId`
- recommended per-paper metadata: `identifiers.doi`, `identifiers.arxivId`, `identifiers.pmid`, `identifiers.pmcid`, `identifiers.isbn`, `identifiers.issn`, `sourceProvider`
- `source` is the local file path on the agent machine
- `serverFilePath` is only for files that already exist on the remote PaperNexus server
- if a server-home path is known, store it as `~/...`, not `/home/<user>/...`
- do not copy a local `/Users/...` path into `serverFilePath`

## Shell Fallback Workflow

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py template

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --manifest "/absolute/path/batch-import.json" \
  submit

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --manifest "/absolute/path/batch-import.json" \
  status

python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
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

Graph availability has a build delay. Do not claim a paper is in the graph when only `submitted=true`, `synced=false`, `deduped`, or `resolved`.
Only graph tools such as `research_lookup`, `research_briefing`, and `idea_catalyst mode=graph` can see the paper after the corresponding task reports `status=completed` and `stage=completed`.

## Batch Tracking Rules

- Use `status` during uploads to read a live batch snapshot.
- Use `wait` when you need a terminal batch result; it polls all tasks round-robin instead of waiting one paper at a time.
- Prefer `paperId` in the manifest so registry matching stays stable across retries.
- During uploads, read `summary.remaining`, `summary.overallPercent`, and each paper's `progress.percent`.
- Worker-side import batching does not change wrapper arguments; it only makes multiple task ids finish together when the server chooses a logical batch.
- If one paper is stuck, inspect it with `python3 SKILL/PaperNexusBatchImport/scripts/pn_import_queue.py status --paper-id "<paperId>"` or `log --paper-id "<paperId>"`.
