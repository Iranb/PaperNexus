---
name: papernexus-paper-refresh
description: Use when an already-indexed PaperNexus paper has stale graph content and one paper or one duplicate group must be force-refreshed over remote HTTP MCP.
---

# PaperNexus Paper Refresh

Use this skill when one already-indexed paper needs a forced graph refresh without rebuilding the whole corpus.

## Live Graph Policy

- use remote HTTP MCP only
- do not call raw `/api/*`
- do not run whole-corpus `refresh_corpus` when the task is to repair one paper
- do not guess source paths from local folders; reuse the server-side source path or sourceKey already known to the graph

Entry point:

```bash
python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  --paper-id "<paper-id>" \
  [--source-key "<source-key>"] \
  [--source "~/.../paper.pdf"] \
  [--paper-title "<exact title>"] \
  [--semantic-extraction auto] \
  [--json]
```

## Selector Rules

- prefer `--paper-id` when it is stable and known
- otherwise prefer `--source-key`
- `--source` must be a server path already known to PaperNexus, not a local workstation path
- `--paper-title` is exact-match only; use it only when the title is unique

At least one selector is required:

- `--paper-id`
- `--source-key`
- `--source`
- `--paper-title`

## Refresh Rules

- this tool force-rematerializes the matched paper and then incrementally fast-commits only the affected paper group
- by default it refreshes the whole canonical duplicate group for the selected paper
- by default it also rebuilds PDF markdown before refreshing graph content
- do not disable duplicate-group refresh unless you are debugging a specific manifest edge case

Useful flags:

- `--no-include-duplicate-group`
- `--no-rebuild-pdf-markdown`
- `--semantic-extraction heuristic-only|auto|llm-assisted|llm-primary`

## Output Contract

Important fields:

- `contractVersion`
- `matchedEntries`
- `affectedEntries`
- `refreshedSourceKeys`
- `affectedSourceKeys`
- `removedEntries`
- `fastCommit.stage`
- `fastCommit.reused`

Success criteria:

- `contractVersion == "paper-graph-refresh-v1"`
- `refreshedSourceKeys` is non-empty
- `fastCommit.reused == false`

If `removedEntries` is non-empty, report that clearly because part of the paper group could not be recovered.

## Example

```bash
python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py \
  --mcp-url "http://211.71.76.29:4821/mcp" \
  --corpus "GCD" \
  --paper-id "2305.18909" \
  --json
```
