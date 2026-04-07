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

## Status Rules

- `summary.submitted`: tasks accepted by the server
- `summary.completed`: tasks with `status=completed`
- `summary.failed`: tasks that failed after submission
- `summary.submitFailed`: items that never became remote tasks

Per paper:

- `submitted=true` means the server accepted a task
- `synced=true` means the task reached `completed`
- `registry.matchedBy` explains whether task resolution came from `paper-id`, `source`, `task-id`, or `remote-scan`

Do not claim a paper is in the graph when only `submitted=true`.
