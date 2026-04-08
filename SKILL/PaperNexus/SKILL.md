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

- `python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py`
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
  Important operations: `submit`, `status`, `progress`, `queue_progress`, `log`, `wait`
- `idea_catalyst`
  Used by `SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`

## Remote Import Checklist

1. Resolve `mcp-url`, token, and corpus before touching the graph.
   If the current corpus name is unknown, query it first with:
   `python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py --mcp-url <mcp-url>`
2. Understand the path boundary:
   `import_workflow submit` sends `serverFilePath` to the remote PaperNexus server, so that path must exist on the server machine, not on the agent's local filesystem.
3. If the paper is already on the server machine, use `--server-file-path`.
4. If the paper is local to the agent machine, do not call `import_workflow submit` with the local path directly. Stage it with:
   `python3 SKILL/PaperNexus/scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`
   The wrapper will:
   - detect that the source is local
   - `ssh`/`rsync` it to remote staging
   - call remote `import_workflow submit` with the staged `serverFilePath`
5. For two or more files, prefer one JSON manifest plus:
   `python3 SKILL/PaperNexus/scripts/pn_batch_import.py --manifest <json> submit`
6. Single-paper progress:
   `python3 SKILL/PaperNexus/scripts/pn_import_queue.py status --paper-id <paperId>`
   or
   `python3 SKILL/PaperNexus/scripts/pn_import_queue.py wait --paper-id <paperId> --timeout 1800 --interval 15`
7. Batch progress:
   `python3 SKILL/PaperNexus/scripts/pn_batch_import.py --manifest <json> status`
   because it uses one remote `queue_progress` snapshot instead of guessing by time
8. Only claim graph sync succeeded when the task is `status=completed` and `stage=completed`.

Do not default to base64 uploads for large PDFs. Prefer `rsync`-style staging and `serverFilePath`.

## Upload Rules

- Never pass a local macOS path like `/Users/iranb/.../paper.pdf` as remote `serverFilePath`.
- `serverFilePath` is only valid for files already present on the remote PaperNexus server.
- For local files, use `pn_import_submit.py --source ...` or `pn_batch_import.py submit` so the wrapper can upload first.
- For batch work, prefer one manifest and one wrapper call, not ad-hoc loops of raw MCP submits.

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
  status --paper-id "data-shapley-iclr-2025"

python3 SKILL/PaperNexus/scripts/pn_import_queue.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  wait --paper-id "data-shapley-iclr-2025" --timeout 1800 --interval 15

python3 SKILL/PaperNexus/scripts/pn_batch_import.py \
  --mcp-url "http://<host>:4821/mcp" \
  --corpus "<corpus>" \
  --manifest "/absolute/path/batch-import.json" \
  status

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
- `task.progress.percent`: per-task overall progress, not just terminal state
- `task.progress.stagePercent`: progress inside the current stage
- `task.progress.queuePosition`: current unfinished-queue position for that task
- `summary.remaining`: unfinished tasks in the current batch or queue snapshot
- `summary.overallPercent`: aggregate progress across the returned task set

Only call a paper synchronized when the returned task state says it is completed.

## Repo-Local Exception

Repo-local CLI commands are only for isolated development or fixture testing. They are not the control plane for a live user graph.
