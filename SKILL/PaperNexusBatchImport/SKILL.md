---
name: papernexus-batch-import
description: Use when an agent needs to upload or track multiple local PDF or Markdown papers into a live PaperNexus corpus through a fixed JSON manifest and Python wrapper.
---

# PaperNexus Batch Import

Use this skill when the task is to ingest many local papers into a running PaperNexus server and keep queue tracking stable.

## Default Rule

For 2 or more files, prefer:

- `python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py`

Do not write ad-hoc shell loops over `pn_import_submit.py`, `curl`, or mixed `rsync + curl` snippets for batch jobs. The batch wrapper is the default control plane because it keeps one fixed manifest format, one status surface, and one local task registry.

## Fixed Manifest Format

Use one JSON file with this shape:

```json
{
  "version": 1,
  "defaults": {
    "apiBase": "http://211.71.76.29:4821",
    "corpus": "GCD",
    "sshTarget": "hyq@211.71.76.29",
    "remoteStagingRoot": "/tmp/papernexus-import-staging",
    "trigger": "api"
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
- `papers` must be a non-empty array
- each paper must include `source`
- `source` should be an absolute local file path when uploading from the agent machine
- `paperId` is strongly recommended because queue lookup is more reliable than filename-only matching
- `sourceKind` may be `pdf` or `markdown`; if omitted, the wrapper infers it from the suffix
- optional per-paper overrides: `remoteDir`, `serverFilePath`, `taskId`

## Default Workflow

1. Generate a template:

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py template
```

2. Fill one manifest file with local paper paths.

3. Submit the whole batch:

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --api-base "http://<host>:4821" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  submit
```

4. Check batch status:

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --api-base "http://<host>:4821" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  status
```

5. Wait until all tracked tasks finish:

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py \
  --api-base "http://<host>:4821" \
  --token "<token>" \
  --manifest "/absolute/path/batch-import.json" \
  wait --timeout 1800 --interval 15
```

## What The Wrapper Does

- stages local PDF or Markdown files to the remote server when needed
- submits each file through the authenticated import API
- stores `paperId/source -> taskId/status/stage` in the local temp registry
- supports batch `submit`, `status`, and `wait` without manually copying task ids
- returns one JSON response with `summary` and per-paper `items`

## Status Rules

Read the batch result like this:

- `summary.total`: papers in the manifest
- `summary.submitted`: tasks accepted by the API
- `summary.completed`: tasks that finished with `status=completed`
- `summary.running`: tasks still executing
- `summary.pending`: tasks still queued
- `summary.failed`: tasks that failed after submission
- `summary.submitFailed`: items that never reached a remote task

Per paper:

- `submitted=true` means the server accepted an import task
- `synced=true` means the import task reached `status=completed` and `stage=completed`
- `registry.matchedBy` explains whether lookup came from `paper-id`, `source`, `task-id`, or `remote-scan`

Do not claim a paper is in the graph when only `submitted=true`. Only call it synchronized when `synced=true`.

## Failure Policy

- if one item fails, report `paperId`, `status`, `stage`, and `error`
- prefer `status` or `wait` over resubmitting blindly
- if the same manifest is re-run, let the registry and remote task lookup resolve the task first
- use `--fail-fast` only when the operator explicitly wants the batch to stop on the first submit error

## Minimal Agent Policy

For batch ingestion:

- create one manifest file
- call `python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py submit`
- call `python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py status` or `wait`
- summarize from returned `summary` and `items`

Do not:

- hand-roll shell loops
- manually track task ids in prose
- say "uploaded but not synchronized" without citing returned task state
