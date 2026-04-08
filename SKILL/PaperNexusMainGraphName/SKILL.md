---
name: papernexus-main-graph-name
description: Use when an agent needs to identify the current live PaperNexus corpus name before remote imports, queue inspection, or graph queries.
---

# PaperNexus Main Graph Name

Use this skill when the task is to find the current live PaperNexus graph name over remote HTTP MCP.

## Live Graph Policy

- use remote HTTP MCP only
- do not call raw `/api/*`
- do not guess the corpus name from local folder names

Entry point:

```bash
python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py \
  --mcp-url "http://<host>:4821/mcp" \
  [--corpus "<corpus>"] \
  [--json]
```

## Resolution Rules

- if `--corpus` or `PAPERNEXUS_CORPUS` is already set, return that as the current graph name
- otherwise query remote `list_corpora`
- if the remote server has exactly one corpus, return it as the main graph name
- if the remote server has multiple corpora, do not guess; return the available names and tell the caller to pass `--corpus`

## Output Contract

Important fields:

- `primaryGraphName`
- `resolvedBy`
- `availableCorpora`
- `message`

Only treat the result as authoritative when:

- `primaryGraphName` is non-empty

If it is empty, the caller must choose a corpus explicitly before running imports or graph queries.
