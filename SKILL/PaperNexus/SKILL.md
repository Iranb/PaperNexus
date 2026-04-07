---
name: papernexus
description: Use when working in PaperNexus and the task touches a live corpus, remote graph build, queued import, or authenticated remote query flow. Skills must use remote HTTP MCP, not the legacy HTTP API.
---

# PaperNexus

Use this skill when the task is about a live PaperNexus corpus or the PaperNexus codebase.

## Live Graph Policy

For a running user graph, the control plane is:

- remote HTTP MCP only
- no raw `/api/*` calls
- no stdio/local MCP for live graph work
- no local CLI graph reads against the live graph

Default runtime settings:

- `PAPERNEXUS_MCP_URL`
- `PAPERNEXUS_API_TOKEN`
- `PAPERNEXUS_CORPUS`

Preferred wrappers:

- `python3 SKILL/PaperNexus/scripts/pn_batch_import.py`
- `python3 SKILL/PaperNexus/scripts/pn_stage_sync.py`
- `python3 SKILL/PaperNexus/scripts/pn_import_submit.py`
- `python3 SKILL/PaperNexus/scripts/pn_import_queue.py`
- `python3 SKILL/PaperNexus/scripts/pn_graph_query.py`
- `python3 SKILL/PaperNexus/scripts/pn_research_chains.py`

These wrappers talk to the remote HTTP MCP surface and hide JSON-RPC, task lookup, and staging details.

## MCP Tool Mapping

The wrappers are thin adapters over these remote MCP tools:

- `research_lookup`
  Used by `pn_graph_query.py` for `query`, `context`, `impact`, `ideas`, and `brainstorm`
- `research_briefing`
  Used by `pn_research_chains.py` for `path-trace`, `evidence-chain`, `reflection-chain`, `theory-brief`, `storyline-brief`, `research-brief`, `brainstorm-brief`, and `paper-enhancement`
- `import_workflow`
  Used by `pn_import_submit.py`, `pn_import_queue.py`, and `pn_batch_import.py`
- `idea_catalyst`
  Used by `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`

## Remote Import Checklist

1. Resolve `mcp-url`, token, and corpus before touching the graph.
2. If the paper is already on the server machine, use `--server-file-path`.
3. If the paper is local to the agent machine, stage it with:
   `python3 SKILL/PaperNexus/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`
4. For two or more files, prefer one JSON manifest plus:
   `python3 SKILL/PaperNexus/scripts/pn_batch_import.py --manifest <json> submit`
5. Track progress with:
   `python3 SKILL/PaperNexus/scripts/pn_import_queue.py status|log|wait`

Do not default to base64 uploads for large PDFs. Prefer `rsync`-style staging and `serverFilePath`.

## Minimal Remote Examples

```bash
python3 SKILL/PaperNexus/scripts/pn_import_submit.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  --paper-id "data-shapley-iclr-2025" \
  --source "/absolute/path/paper.pdf" \
  --ssh-target "hyq@<host>"

python3 SKILL/PaperNexus/scripts/pn_import_queue.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  wait --paper-id "data-shapley-iclr-2025" --timeout 1800 --interval 15

python3 SKILL/PaperNexus/scripts/pn_graph_query.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  query "Data Shapley in One Training Run" --limit 8
```

## Queue Reading Rules

- `pending` plus `queued`: task exists but the import worker has not picked it up
- `running`: read `stage` and recent `log`
- `completed` plus `completed`: safe to query the graph
- `failed`: report `stage`, `error`, and recent log lines before retrying

Only call a paper synchronized when the returned task state says it is completed.

## Repo-Local Exception

Repo-local CLI commands are only for isolated development or fixture testing. They are not the control plane for a live user graph.
