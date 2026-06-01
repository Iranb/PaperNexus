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
- `pn_resilient_discovery.py`
- `pn_paper_index.py`
- `pn_graph_query.py`
- `pn_research_chains.py`
- `pn_idea_catalyst.py`

## Typical Single-Paper Flow

1. resolve the remote MCP URL, token, and current corpus name
2. if the source file is local, upload it to the server with staging
3. submit the remote import task
4. query progress by `paperId`, `source`, or `taskId`
5. only declare success when `import_workflow wait` returns the task as `completed` at the final stage and the downstream authoritative sync status is terminal

Every uploaded paper now needs at least one precise identifier:

- DOI
- arXiv ID
- PMID
- PMCID
- ISBN
- ISSN

Before importing, use the precise paper index when possible to avoid re-uploading an already-indexed paper and to backfill identifiers onto older entries.

PaperNexus now distinguishes:

- `canonicalId`: same paper identity
- `sourceId`: same fulltext artifact identity

## Keyword Discovery Before Graph Commit

Keyword literature research enters the system through the `literature_discovery` MCP tool, not through graph lookup tools.

The important boundary is that discovery and graph ingestion are intentionally asynchronous:

- `literature_discovery plan` and `search` produce query plans and metadata candidates; they do not mutate the graph.
- `literature_discovery run` / `resolve` can persist discovery artifacts and legal source-resolution results; the graph still may not contain those papers.
- `literature_discovery import` or `importResolved=true` submits resolved full text to the import queue.
- `literature_discovery ingest`, `import_and_process`, or `processImports=true` asks PaperNexus to process imports inline, defaulting to progressive worker-side logical batching with `importBatchEnabled=true`, `importBatchInitialTasks=4`, and `importBatchMaxTasks=16`; this can still be long-running because parsing, semantic extraction, fast commit, and authoritative graph sync can lag behind discovery.
- `import_workflow submit` only accepts tasks into the queue; the MCP serve import worker defaults to `imports.batchEnabled=true`, `batchProgressive=true`, `batchInitialTasks=4`, and `batchMaxTasks=16`, so multiple pending tasks can share one graph commit unless server config explicitly disables batching.
- `research_lookup`, `research_briefing`, and `idea_catalyst mode=graph` only see papers safely after the corresponding `import_workflow wait` has returned `status=completed`, `stage=completed`, and an authoritative sync status of `completed` or `superseded`.

For interactive search, prefer `operation=search`. It is metadata-only by default and has explicit latency profiles: `quick` uses a 25s budget and 4 query cap, `balanced` uses a 45s budget and 6 query cap, and `deep` is the MCP default broader profile with a bounded 10-minute budget and 10 query cap, aligned with the default HTTP MCP request timeout. Search-mode LLM query planning is rule-based by default; if explicitly enabled, it is capped to 8s/12s/18s for quick/balanced/deep and returns deterministic planning fallback on timeout or failure. This keeps discovery an optional upstream substrate instead of a blocking graph path.

For broad or high-risk discovery, prefer `literature_discovery operation=submit` and then poll `progress`, `report`, and `list`. If a client-side wait limit or transport failure happens after a submit attempt, record the local state as `unknown_after_timeout`; do not call it successful or failed until remote state has been reconciled. The shell fallback wrapper `pn_resilient_discovery.py` implements this ledger pattern without changing MCP tool schemas.

For source-discovery or AutoResearch ideation work, split broad searches into `target`, `near`, and `far` lanes. The lane split makes target-domain priors, near-source methods, and far-source transfer candidates independently retryable, and it prevents one slow lane from hiding the state of the others.

For `$autoreskill` idea construction, the recommended client-side path is:

1. run target / near / far discovery lanes with durable submit/poll ledgers
2. screen candidates into `PAPER_SELECTION_SCORECARD.json`
3. route usable papers to import, material view, or split-reading evidence
4. capture proposal graph or material evidence through MCP
5. compile local GOE artifacts: `EVIDENCE_GRAPH_PROJECTION.json`, `IDEA_BUILD_BRIEF.json/md`, `GOE_IDEA_AUDIT.json`, and `IDEA_TRACK_SEEDS.json`

The GOE files are local AutoResearch artifacts. They are useful for resumable ideation and ScientistOne-style provenance, but they do not replace MCP queue/status evidence and they do not make metadata-only discovery graph-grounded.

Discovery and material paper lists are publication-date aware: dated candidates are returned newest-first, year-only metadata is used when no full date exists, and undated records keep stable fallback ordering. This is an ordering rule only; it does not change import readiness or graph visibility.

Agents should therefore report interim results precisely:

- use "discovered" for candidates in a discovery report
- use "submitted" for accepted import tasks
- use "in graph" only after import queue completion and authoritative sync readiness

When graph build is delayed, use `literature_discovery status` / `report` for the paper list and `import_workflow queue_progress`, `status`, or `wait` for graph-readiness. `import_workflow wait` now waits for the authoritative sync job by default; pass `waitForAuthoritativeSync=false` only when you intentionally want raw import-task completion. Do not rerun graph queries just because discovery finished.

Timeout-resilient shell fallback:

```bash
python3 SKILL/PaperNexus/scripts/pn_resilient_discovery.py \
  --corpus "<corpus>" \
  --workflow-id "<project-or-run-id>" \
  --ledger "/absolute/path/resilient-discovery-ledger.json" \
  submit --lane target --lane near --lane far --topic "<research topic>"

python3 SKILL/PaperNexus/scripts/pn_resilient_discovery.py \
  --corpus "<corpus>" \
  --workflow-id "<project-or-run-id>" \
  --ledger "/absolute/path/resilient-discovery-ledger.json" \
  poll

python3 SKILL/PaperNexus/scripts/pn_resilient_discovery.py \
  --corpus "<corpus>" \
  --workflow-id "<project-or-run-id>" \
  --ledger "/absolute/path/resilient-discovery-ledger.json" \
  queue
```

Recommended server-side inspection command:

```bash
cd ~/PaperNexus
~/miniconda3/bin/node ./src/cli/index.js imports status --corpus demo-corpus
```

For a single task:

```bash
~/miniconda3/bin/node ./src/cli/index.js imports log --corpus demo-corpus --task-id imp:... --tail 40
```

## Typical Batch Flow

1. prepare one manifest JSON
2. call the batch wrapper once
3. inspect queue progress snapshots instead of sleeping blindly
4. use batch `status` or `wait` to track the whole set
5. fall back to single-task log inspection only when one paper is stuck

## What To Do When A Remote Import Looks Stuck

Remote imports now expose enough state to avoid guesswork.

Use this order:

1. inspect queue progress
2. check whether any task is actually `running`
3. if a PDF task started, inspect parser state under `~/.papernexus/pdf-parser/`
4. if nothing is `running`, inspect the import worker / `serve` process

Do not assume that “MCP is reachable” means “the import queue worker is healthy”.

## Historical Backlog Handling

The current system can quarantine stale pending import tasks out of the active queue instead of deleting them.

That matters for remote agents because it means:

- new resubmissions do not have to sit forever behind abandoned queue entries
- historical tasks can still be audited later
- queue cleanup can be made safe by default

When a task was quarantined, the authoritative record is per-corpus under:

```text
<corpus-root>/.papernexus/imports/quarantine/<batch-id>/
```

## Failed Task Recovery

Remote agents often treat `failed` as a hard stop. PaperNexus now avoids that for recoverable import states.

Before reserving normal work, the import worker scans failed tasks.

If the uploaded PDF/Markdown still exists and retry limits allow it, the task is reset to:

```text
pending / queued
```

If an equivalent later task already completed, the old failed task is changed to:

```text
completed / completed
```

with recovery metadata:

```json
{
  "recovery": {
    "status": "superseded",
    "supersededByTaskIds": ["imp:..."]
  }
}
```

That means an agent should treat `completed / completed` with `recovery.status = superseded` as a successful terminal state. The historical error remains in `events.log` for audit, but it is no longer the live workflow outcome.

This is especially important after duplicate submissions or old concurrent-commit failures. A task can have an old error log and still be safe to continue if its final task status is completed.

## Parser-Level Diagnostics For Remote Uploads

For PDF uploads, task logs alone may not tell you whether the parser is:

- still converting
- waiting for GPU
- already in fallback
- abandoned due to a restart

That state now lives in the parser runtime store:

```text
~/.papernexus/pdf-parser/
```

This is the preferred source when one remote import is “stuck” but the queue summary is too coarse.

## Recent Log Inspection

Operationally, the fastest way to see what happened to a recent upload is now:

```bash
bash scripts/pm2-papernexus-serve.sh recent
```

This focuses on import-related log lines instead of dumping all service output.

The native import CLI is usually better when you know the corpus or task id:

```bash
papernexus imports running --corpus demo-corpus
papernexus imports log --corpus demo-corpus --task-id imp:... --tail 80
```

The PM2 `recent` command is best when you do not yet know which task id matters.

## Maintenance Guidance

If remote import behavior changes, the docs maintenance order should be:

1. update the canonical skill wrapper under `SKILL/PaperNexus/scripts`
2. regenerate or update references
3. update this narrative page if the conceptual workflow changed

## Read Next

- [Imports And Queue](/pipeline/imports-and-queue)
- [Literature Discovery](/literature-discovery/)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
- [Operations Overview](/operations/)
