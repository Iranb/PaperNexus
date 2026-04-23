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

Default client assumption:

- OpenClaw or Codex already has a PaperNexus MCP server configured
- the configured server name is `papernexus-remote`
- live graph reads should use that MCP server directly
- literal IPs, MCP URLs, and bearer tokens do not belong in SKILL instructions

Preferred MCP tools:

- `list_corpora`
- `research_lookup`
- `research_briefing`
- `idea_catalyst`
- `import_workflow`
- `refresh_paper_graph`

Shell fallback wrappers:

- `python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py`
- `python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py`
- `python3 SKILL/PaperNexus/scripts/pn_paper_index.py`
- `python3 SKILL/PaperNexus/scripts/pn_batch_import.py`
- `python3 SKILL/PaperNexus/scripts/pn_stage_sync.py`
- `python3 SKILL/PaperNexus/scripts/pn_import_submit.py`
- `python3 SKILL/PaperNexus/scripts/pn_import_queue.py`
- `python3 SKILL/PaperNexus/scripts/pn_graph_query.py`
- `python3 SKILL/PaperNexus/scripts/pn_research_chains.py`

These wrappers exist for shell-only fallback and local file staging. They should inherit connection details from the active PaperNexus setup and should never hardcode IPs in skill examples.

## Remote Path Contract

All server-owned filesystem paths must use a portable PaperNexus server form:

- prefer `~/.papernexus/...` over `/home/<user>/.papernexus/...`
- prefer `~/uploads/...` over `/home/<user>/uploads/...`
- `/tmp/...` stays `/tmp/...`

Rules:

- when MCP or HTTP metadata shows a server-home path, treat the `~` form as canonical
- do not rewrite the `~` form back into a guessed `/home/...` absolute path
- if a wrapper accepts a server path, it accepts both absolute and `~/...` forms, but SKILL examples should use `~/...`
- let the PaperNexus framework expand `~` on the server side

## MCP Tool Mapping

For OpenClaw-native use, call these tools on the configured `papernexus-remote` server directly:

- `research_lookup`
  Use for `query`, `context`, `impact`, `ideas`, `brainstorm`, and `paper_index`
- `research_briefing`
  Use for `path-trace`, `evidence-chain`, `reflection-chain`, `theory-brief`, `storyline-brief`, `research-brief`, `brainstorm-brief`, and `paper-enhancement`
- `import_workflow`
  Use for queue submit, status, progress, log, and wait operations after a file is already on the server
  Important operations: `submit`, `status`, `progress`, `queue_progress`, `log`, `wait`
- `idea_catalyst`
  Use for cross-domain ideation
- `refresh_paper_graph`
  Use to force-refresh one already-indexed paper or one duplicate group
- `list_corpora`
  Use to resolve the current corpus when the active corpus is not explicit

## Remote Import Checklist

1. Resolve the active corpus before touching the graph.
   If the current corpus name is unknown, query `list_corpora` on `papernexus-remote` first.
2. Understand the path boundary:
   `import_workflow submit` sends `serverFilePath` to the remote PaperNexus server, so that path must exist on the server machine, not on the agent's local filesystem.
   If the path is under the server user's home directory, keep it in `~/...` form instead of copying the raw `/home/...` prefix.
3. If the paper is already on the server machine, use `--server-file-path`.
   Before submitting, prefer an exact `paper_index` lookup by DOI / arXiv ID / PMID / PMCID when the identifier is available.
4. If the paper is local to the agent machine, do not call `import_workflow submit` with the local path directly. Stage it with:
   `python3 SKILL/PaperNexus/scripts/pn_import_submit.py --source <local-file> --doi <doi>`
   The wrapper will:
   - detect that the source is local
   - `ssh`/`rsync` it to remote staging
   - call remote `import_workflow submit` with the staged `serverFilePath`
   Only pass `--ssh-target` when the local staging environment has not already been configured.
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

- Every uploaded paper must include at least one precise identifier.
- Strong paper identity prefers DOI, arXiv ID, PMID, or PMCID.
- ISBN / ISSN are stored, but by themselves they do not replace article-level identity.
- Never pass a local workstation path like `/Users/<user>/.../paper.pdf` as remote `serverFilePath`.
- `serverFilePath` is only valid for files already present on the remote PaperNexus server.
- If a remote metadata response shows `~/.papernexus/...`, keep that exact `~`-prefixed path when calling wrappers again.
- For local files, use `pn_import_submit.py --source ...` or `pn_batch_import.py submit` so the wrapper can upload first.
- For batch work, prefer one manifest and one wrapper call, not ad-hoc loops of raw MCP submits.

## Minimal Remote Examples

For OpenClaw-native live graph work, prefer direct MCP tool calls against the configured `papernexus-remote` server.

Use shell examples only when local file staging or shell-only execution is required.

```bash
python3 SKILL/PaperNexus/scripts/pn_import_submit.py \
  --corpus "<corpus>" \
  --paper-id "data-shapley-iclr-2025" \
  --doi "10.48550/arXiv.2401.12345" \
  --source-provider "filesystem" \
  --source "/absolute/path/paper.pdf"

python3 SKILL/PaperNexus/scripts/pn_paper_index.py \
  --corpus "<corpus>" \
  --doi "10.48550/arXiv.2401.12345" \
  --json

python3 SKILL/PaperNexus/scripts/pn_import_queue.py \
  --corpus "<corpus>" \
  status --paper-id "data-shapley-iclr-2025"

python3 SKILL/PaperNexus/scripts/pn_import_queue.py \
  --corpus "<corpus>" \
  wait --paper-id "data-shapley-iclr-2025" --timeout 1800 --interval 15

python3 SKILL/PaperNexus/scripts/pn_batch_import.py \
  --corpus "<corpus>" \
  --manifest "/absolute/path/batch-import.json" \
  status

python3 SKILL/PaperNexus/scripts/pn_graph_query.py \
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

## Single-Paper Graph Repair

If one already-indexed paper has stale graph content, a bad title, or a parser-correctable snapshot issue, prefer the `refresh_paper_graph` MCP tool.
Use the dedicated wrapper only in shell-only fallback flows:

```bash
python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py \
  --corpus "<corpus>" \
  --paper-id "<paper-id>" \
  --json
```

Rules:

- use this only for already-indexed papers
- do not use it as an upload path
- it refreshes one paper or one duplicate group, not the entire corpus
- `--source` may be a server PDF path or a server Markdown path; a PDF source reruns the parser path
- default behavior is to include the canonical duplicate group and rebuild PDF markdown before fast-committing the graph update

## Repo-Local Exception

Repo-local CLI commands are only for isolated development or fixture testing. They are not the control plane for a live user graph.
