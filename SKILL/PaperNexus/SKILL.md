---
name: papernexus
description: Use when working in PaperNexus and the task touches a live corpus, remote graph build, queued API import, or authenticated server-backed query flow.
---

# PaperNexus

Use this skill when the task is about the PaperNexus codebase or a running PaperNexus corpus.

## First Decision

- live remote corpus or running server: prefer the local Python wrappers in `scripts/` as the default control plane over raw `curl`
- repo-local isolated development or fixture testing: use CLI stage commands

If both a remote server API and a local repo checkout are available, recommend the remote API path first.
Do not use local `papernexus analyze`, `papernexus materialize`, `papernexus stage1-4`, `papernexus query`, `papernexus context`, `papernexus impact`, `papernexus ideas`, or `papernexus brainstorm` as the control plane for a live user graph.

## Default Script Entry Points

For live remote work, prefer these wrappers first:

- `python3 scripts/pn_stage_sync.py`
- `python3 scripts/pn_import_submit.py`
- `python3 scripts/pn_import_queue.py`
- `python3 scripts/pn_graph_query.py`
- `python3 scripts/pn_research_chains.py`

Why:

- they hide token handling and request shape details
- they reduce route-shape mistakes
- they make `rsync + serverFilePath + queue polling` the default import path
- they are easier for agents to call consistently than raw `curl`

Configuration defaults:

- `PAPERNEXUS_API_BASE_URL`
- `PAPERNEXUS_API_TOKEN`
- `PAPERNEXUS_CORPUS`
- or keychain-backed token lookup via `PAPERNEXUS_API_TOKEN_SOURCE=os_keychain`, `PAPERNEXUS_API_TOKEN_SERVICE`, and `PAPERNEXUS_API_TOKEN_ACCOUNT`

## Remote Graph Build Checklist

1. Resolve connection settings before touching the graph.
   - Find the API base URL, corpus name, and token source from runtime or workflow config.
   - Prefer explicit workflow settings such as `papernexusApiBaseUrl`, `papernexusApiTokenSource`, `papernexusApiTokenService`, and `papernexusApiTokenAccount` when they exist.
   - `GET /api/health` also requires `Authorization: Bearer <token>`.
2. Confirm the server is reachable.
   - Call `GET /api/health` or `GET /api/corpora`.
   - If auth fails, fix token lookup first. Do not guess.
3. Decide how the PDF reaches the API server machine.
   - If the file is already on the API server, use `serverFilePath`.
   - If the file exists only on the local agent machine and it is a single PDF or Markdown file, prefer `python3 scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`. That wrapper stages the file and then submits `serverFilePath` for you.
   - If the file exists only on the local agent machine and you need explicit staging control for a directory or batch, sync it to a remote staging directory first, then use `serverFilePath`.
   - Do not send local PDFs through `files[].contentBase64` by default. Large PDFs easily exceed shell or request limits and are much less reliable than server-side staging.
   - Treat `files[].contentBase64` as a last resort for small operator-approved uploads, not the default path for local PDFs.
   - `serverFilePath` must be one absolute file on the API server. It is not a directory input and does not recurse.
4. Prefer stable file staging for local PDFs.
   - Default for one local file: let `pn_import_submit.py --source ... --ssh-target ...` do the staging automatically.
   - Most stable default: `rsync` to a remote staging directory on the same machine that serves the API.
   - Recommended flags that work in this environment: `rsync -avz --partial --partial-dir=.rsync-partial --progress --checksum --timeout=60`.
   - Use ASCII staging paths such as `/tmp/papernexus-import-staging/<job-id>/`.
   - If the API host is a gateway, container, or different machine from the SSH target, do not guess. Ask for the real server-side staging path first.
   - Prefer `python3 scripts/pn_stage_sync.py --ssh-target <ssh-target> --remote-dir <remote-dir> <local-path>` over hand-written `rsync` when you need explicit remote staging output.
5. Import and poll.
   - for one local file, submit with `python3 scripts/pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`
   - for a pre-staged remote file, submit with `python3 scripts/pn_import_submit.py --server-file-path <remote-file>`
   - poll with `python3 scripts/pn_import_queue.py wait --paper-id <paper-id>` or `--source <local-file>`
   - prefer `--paper-id` or `--source` over hand-entering a task id; the wrapper keeps a local temp registry of submitted tasks
   - on failure, report the exact stage, recent log lines, and likely blocker; do not retry blindly
6. Read graph state through typed APIs first.
   - prefer `python3 scripts/pn_graph_query.py` and `python3 scripts/pn_research_chains.py`
   - use `GET /api/corpus` only when the typed APIs cannot answer the task

## Queue Status

Use this order when checking import progress:

1. Prefer `python3 scripts/pn_import_queue.py status --paper-id <paper-id>` or `--source <local-file>` to resolve the task automatically
2. If the wrapper cannot resolve the task, use `GET /api/imports?name=<corpus>` to find the newest task id
3. `GET /api/imports/:taskId` to inspect structured state
4. `GET /api/imports/:taskId/log` to inspect stage evidence

Read task state like this:

- `status: pending` with `stage: queued`
  The task exists but the import worker has not reserved it yet.
- `status: running`
  The worker is processing it. Read `stage` to know where it is stuck.
- `status: completed` with `stage: completed`
  The import pipeline finished. Then check `result.fastCommitted` and `result.authoritativeSync`.
- `status: failed`
  The task stopped with `error.message`. Always read the task log before deciding what to do next.

Current stage meanings:

- `queued`
  Task created, waiting for worker pickup.
- `materialize`
  Stage 1 style work: parse PDF or read Markdown, refresh markdown cache, and build heuristic snapshots.
- `llm-optimize`
  LLM enrichment is running.
- `fast-commit`
  The import path is committing changed sources into the live graph.
- `completed`
  Finished successfully.

Fields worth reporting together:

- `id`
- `status`
- `stage`
- `createdAt`
- `startedAt`
- `updatedAt`
- `finishedAt`
- `includeInGraph`
- `error.message`
- `result.materialized`
- `result.optimized`
- `result.fastCommitted`
- `result.authoritativeSync`

Interpretation rules:

- if `status` is `pending` and `stage` is still `queued`, the task is waiting for the worker
- if `status` is `running`, use the newest `/log` lines as the source of truth for where it is blocked
- if `status` is `completed` but `result.authoritativeSync.status` is `pending`, the import task finished but authoritative sync is still catching up
- if `status` is `failed`, report the current `stage`, `error.message`, and the newest log lines; do not blindly resubmit
- if the same upload returns `deduped: true`, reuse that existing task id instead of expecting a brand-new task
- `pn_import_submit.py` and `pn_import_queue.py` keep a temp task registry, so `wait --paper-id ...` and `status --source ...` should usually work without manually copying the task id

Important debugging rule:

- when a human asks "is it queued, running, or done?", answer from `GET /api/imports/:taskId`
- when a human asks "what is it doing right now?" or "why is it stuck?", answer from `GET /api/imports/:taskId/log`

## Minimal Remote Example

```bash
# 1. Preferred single-file path: submit one local file and let the wrapper stage it.
python3 scripts/pn_import_submit.py \
  --api-base "http://<host>:4821" \
  --corpus "<corpus>" \
  --paper-id "data-shapley-iclr-2025" \
  --source "/Users/iranb/Documents/papers/2025/ICLR2025 oral/Data Shapley in One Training Run.pdf" \
  --ssh-target "hyq@211.71.76.29"

# 2. Poll until the task finishes.
python3 scripts/pn_import_queue.py \
  --api-base "http://<host>:4821" \
  --corpus "<corpus>" \
  wait --paper-id "data-shapley-iclr-2025" --timeout 1800 --interval 15

# 3. Query the live graph.
python3 scripts/pn_graph_query.py \
  --api-base "http://<host>:4821" \
  --corpus "<corpus>" \
  query "Data Shapley in One Training Run" --limit 8
```

Alternative explicit two-step path for a directory or batch:

```bash
python3 scripts/pn_stage_sync.py \
  --ssh-target hyq@211.71.76.29 \
  --remote-dir /tmp/papernexus-import-staging/iclr2025-oral \
  "/Users/iranb/Documents/papers/2025/ICLR2025 oral/"

python3 scripts/pn_import_submit.py \
  --api-base "http://<host>:4821" \
  --corpus "<corpus>" \
  --server-file-path "/tmp/papernexus-import-staging/iclr2025-oral/Data Shapley in One Training Run.pdf"
```

## Script Routing Guide

- local single-file import from the agent machine:
  `python3 scripts/pn_import_submit.py --api-base <url> --corpus <corpus> --paper-id <paper-id> --source <local-file> --ssh-target <ssh-target>`
- local file or directory to remote staging:
  `python3 scripts/pn_stage_sync.py --ssh-target <ssh-target> --remote-dir <remote-dir> <local-path>`
- staged single-file import:
  `python3 scripts/pn_import_submit.py --api-base <url> --corpus <corpus> --server-file-path <remote-file>`
- queue inspection:
  `python3 scripts/pn_import_queue.py --api-base <url> --corpus <corpus> list|status|log|wait ...`
  Prefer `status|wait --paper-id <paper-id>` or `--source <local-file>` when possible.
- typed graph query:
  `python3 scripts/pn_graph_query.py --api-base <url> --corpus <corpus> query|context|impact|ideas|brainstorm ...`
- typed chains and briefs:
  `python3 scripts/pn_research_chains.py --api-base <url> --corpus <corpus> path-trace|evidence-chain|reflection-chain|research-brief|theory-brief|storyline-brief|brainstorm-brief|paper-enhancement ...`

Use raw HTTP only when:

- you are debugging the wrappers themselves
- a new API endpoint is not wrapped yet
- the user explicitly asks for raw request examples

## Live Graph Access Policy

When touching a running user graph, use the authenticated HTTP API as the primary and preferred interface.

This applies to:

- uploading new PDF or Markdown sources into the graph
- checking import status
- reading corpus metadata or graph payloads
- reading enhancement overlays for a paper or corpus
- performing graph-backed query or reasoning requests

Do not recommend local CLI commands such as `papernexus analyze`, `papernexus materialize`, `papernexus stage1-4`, `papernexus query`, `papernexus context`, `papernexus impact`, `papernexus ideas`, or `papernexus brainstorm` against a live user graph unless the user explicitly asks for isolated local repo testing.

Allowed live-graph entrypoints:

- `GET /api/health`
- `GET /api/corpora`
- `GET /api/corpus?name=<corpus>`
- `GET /api/corpus-meta?name=<corpus>`
- `GET /api/enhancements?name=<corpus>`
- `GET /api/paper-enhancement?name=<corpus>&paperId=<paperId>`
- `GET /api/imports?name=<corpus>`
- `POST /api/imports?name=<corpus>`
- `GET /api/imports/:taskId`
- `GET /api/imports/:taskId/log`
- `POST /api/query`
- `POST /api/context`
- `POST /api/impact`
- `POST /api/ideas`
- `POST /api/brainstorm`
- `POST /api/path-trace`
- `POST /api/evidence-chain`
- `POST /api/reflection-chain`
- `POST /api/research-brief`
- `POST /api/brainstorm-brief`
- `POST /api/theory-brief`
- `POST /api/storyline-brief`

Every `/api/*` request must include:

- `Authorization: Bearer <token>`

## Route Shape Warning

The current PaperNexus API uses flat endpoint names plus query params or JSON bodies.

Do not invent REST-style paths such as:

- `/api/corpora/<corpus>`
- `/api/corpora/<corpus>/query`
- `/api/corpora/<corpus>/search`
- `/api/corpora/<corpus>/papers`
- `/api/papers/<paperId>`
- `/api/graph/status`
- `/api/graph/presence`

Use the current route shapes instead:

- corpus list: `GET /api/corpora`
- corpus payload: `GET /api/corpus?name=<corpus>`
- corpus meta: `GET /api/corpus-meta?name=<corpus>`
- graph search/query: `POST /api/query` with `{ "name": "<corpus>", "query": "<text>" }`
- paper overlay detail: `GET /api/paper-enhancement?name=<corpus>&paperId=<paperId>`

Important failure signature:

- if an unknown `GET /api/*` path returns `ENOENT` mentioning `web/api/...`, the request likely missed every API route and fell through to the static web file handler
- treat that as a wrong endpoint shape, not as missing graph data
- fix the route first; do not keep retrying the same URL

Important query policy:

- prefer the typed HTTP query APIs over raw graph downloads whenever they fit the task
- use `GET /api/corpus` only when you truly need raw graph inspection beyond what the typed APIs expose
- if the available API payload is insufficient for the requested reasoning task, report that the server lacks the needed query endpoint; do not fall back to local CLI against the live graph

## Defaults To Know

- project-local staging root: `{PROJ}/researcher/paper-staging`
- remote service base URL: configured `papernexusApiBaseUrl`
- remote import queue: `POST /api/imports?name=<corpus>`
- remote import logs: `GET /api/imports/:taskId/log`
- runtime config / service logs: only inspect local service files when the task is explicitly about PaperNexus deployment debugging

## Current Behavior To Know

- Multiple corpora are supported, but commands usually operate on one corpus at a time via `--corpus`.
- Default operator assumption in this repo: treat the configured corpus as a single authoritative graph. Do not point stage commands at a random subdirectory once a graph already exists.
- Multiple `sources.inputs` may feed one corpus; that is not the same as cross-corpus federation.
- `~` expansion in config paths is supported and should resolve to the user home directory.
- The graph backend defaults to Kuzu when the `kuzu` package is available.
- Repo default: `docling` is the default PDF parser unless config overrides it.
- Deployment policy: do not assume the parser from repo defaults alone. Check `config.json`, CLI flags, or the running service config first. Many deployed corpora pin `analyze.pdfParser = "mineru"` with `analyze.mineruHttpUrl`.
- For MinerU HTTP API, use `analyze.mineruHttpUrl` or `--mineru-http-url` to specify the remote endpoint (e.g., `http://211.71.76.29:30000`).
- If a live deployment is already configured for remote MinerU, prefer staying on that configured path rather than switching parsers ad hoc.
- Remote MinerU failure handling should default to stopping with a warning. Only use `--mineru-remote-failure docling` when the task explicitly wants an automatic fallback.
- For local macOS OCR with Docling, use `analyze.doclingOcrEngine = "ocrmac"` or `--docling-ocr-engine ocrmac`.
- For Docling PDF parsing backend, use `analyze.doclingPdfBackend` or `--docling-pdf-backend`. Available backends: `pypdfium2` (recommended), `pdfplumber`, `fitz`, `pypdf`.
- Semantic extraction supports `auto`, `heuristic-only`, `llm-assisted`, and `llm-primary` via `analyze.semanticExtraction` or `--semantic-extraction`. Default is `auto`: use LLM assistance when model config is available, otherwise fall back to heuristics.
- Node admission is now stricter before graph projection. Low-signal surface forms such as single-word generic nouns, title fragments, and citation-like fragments are filtered out instead of being promoted into brainstorm-facing graph nodes.
- Kept research nodes may carry `brainstormEligible`, `brainstormScore`, and `brainstormTier` properties. These mark the high-quality ideation layer used by brainstorming features.
- `ideas` and `brainstorm` now prefer the brainstorm-quality node view rather than the full noisy graph.
- LLM-assisted relation extraction is controlled by `llm.relations: true` in config.
- LLM semantic extraction and per-paper relation optimization now support batched requests during `analyze`; tune with `llm.batchSize` or `--batch-size`.
- If your provider supports high throughput, increase `analyze.concurrency` or `--concurrency`; the pipeline no longer forces a low LLM concurrency cap for non-marker parsers.
- The pipeline can now run as five cache-first resumable stages:
  - `papernexus materialize` or `papernexus stage1` for markdown cache + heuristic snapshots
  - `papernexus llm-optimize` or `papernexus stage2` for batched LLM snapshot enrichment only
  - `papernexus build-graph` or `papernexus stage3` for building a staged graph artifact from snapshots
  - `papernexus merge-graph` for canonicalizing near-duplicate `Dataset` / `Benchmark` nodes inside the staged graph
  - `papernexus write-index` or `papernexus stage4` for committing the staged graph into the authoritative index
- `papernexus optimize` is still available as a convenience path for stages 2-5 together.
- Ad hoc PDF/Markdown uploads should normally enter through queued import tasks under `.papernexus/imports/`, not by moving files directly into the main paper source tree during automation.
- If a local PDF or Markdown only exists on the agent machine and it is a single file, prefer `pn_import_submit.py --source <local-file> --ssh-target <ssh-target>`. Use explicit staging plus `serverFilePath` when you need directory or batch control.
- Do not default to `files[].contentBase64` for large local PDFs; prefer stable remote staging such as `rsync` plus `serverFilePath`.
- Import tasks keep per-task `events.log` files and stay in a separate directory even after their parsed content is merged into the main graph.
- `POST /api/imports` supports two input styles:
  - client-uploaded file content through `files[].contentBase64`
  - server-side single-file collection through `serverFilePath`
- For local PDFs that live on the agent machine, prefer the wrapper path that stages automatically and submits `serverFilePath` for you. Do not default to `files[].contentBase64` for large PDFs.
- `serverFilePath` is resolved on the API server machine, must be an absolute single-file path, and does not support directory recursion. If the human gave you a local directory, sync the files to the API server first and then submit one file per import task.
- `POST /api/imports` now content-dedupes identical uploads. When the same file content is uploaded again for the same corpus, the API can return the existing task with `deduped: true` instead of creating a new task.
- Completed import task directories should not be treated as long-lived active scan roots. Completed imported sources are preserved through manifest-backed reuse instead of repeated directory rescans.
- Agent live-graph policy:
  - ingest new papers through `POST /api/imports`
  - read graph state through the typed query APIs first
  - use `/api/corpus`, `/api/corpus-meta`, `/api/enhancements`, and `/api/paper-enhancement` as supporting raw/overlay reads
  - if an operation exists only in CLI and not in the HTTP API, report the limitation instead of using local CLI against the live graph
- Import-task execution should rebuild against the current committed corpus manifest and merge the task's `sourcesDir` on top of that base graph. Do not trust stored `task.inputPaths` as the authoritative rebuild root if they look stale or cross-machine.
- Single-graph safety:
  - Once a corpus already exists at an index root, Stage 1-4 commands must keep using that same configured input scope.
  - If you pass a narrower or different path on the same index root, PaperNexus now refuses instead of silently shrinking the graph.
  - In normal operation, omit the positional path and let `sources.inputs` drive the pipeline.
- Stage 3 persists a staged graph under `.papernexus/staged/`; the merge stage rewrites that staged graph in place; Stage 4 consumes the merged staged graph and removes it after a successful commit.
- Stage semantics:
  - Stage 1 `--continue` reuses markdown cache and snapshots when fingerprints still match; `--force` rematerializes source states; add `--rebuild-pdf-markdown` only when you really want to regenerate every PDF-derived markdown cache.
  - Stage 2 `--continue` is now dirty-only: it only reruns papers whose semantic objects or relation extraction are stale for the current config, failed but still retryable, or genuinely changed. If nothing is dirty, Stage 2 returns `reused: true` and does not rewrite the manifest.
  - Stage 2 keeps separate semantic/relation freshness state per snapshot, so unchanged papers and already-complete sub-stages are reused directly.
  - Stage 3 `--continue` reuses the staged graph if it still matches the latest manifest snapshot state, not just a fresh timestamp; a no-op Stage 2 should no longer invalidate Stage 3 by itself.
  - `merge-graph --continue` reuses an already-merged staged graph when it is still fresh; `--force` reruns canonicalization from the Stage 3 graph.
  - LLM-driven staged node deletion/renaming is currently disabled. Do not rely on `--node-llm-check` for merge-time pruning.
- Stage 4 `--continue` commits the staged graph that Stage 3 and `merge-graph` already prepared; `--force` recommits that staged graph. Stage 4 now validates against the staged manifest, not raw input rescans.
- `write-index` stays backward-compatible: if the staged graph has not gone through `merge-graph` yet, it will auto-merge similar evaluation nodes before committing.
- Important Stage 4 boundary: if raw paper files changed after Stage 3, Stage 4 can still commit the already-built staged graph. Those newer raw changes are not included until you rerun Stage 1-3 and then Stage 4.
- Agent force policy:
  - Do not add `--force` by default when building or refreshing a graph.
  - Prefer `papernexus analyze`, `papernexus optimize`, or stage commands with `--continue` for normal operation.
  - Only use `--force` when the user explicitly asks for a full rebuild, when staged/cached artifacts are known bad and normal resume cannot recover, or when you intentionally need `--rebuild-pdf-markdown`.
  - If the cache-first command still fails and the user can operate locally, hand the exact command to the user instead of escalating to a forced rebuild.
- If `sources.inputs` is configured in `config.json`, `analyze`, `materialize`, `llm-optimize`, `build-graph`, `merge-graph`, `write-index`, `optimize`, and `watch` can run without a positional path.
- Per-paper semantic snapshots now record whether LLM assistance was requested, whether it actually participated, the effective mode, and the failure reason when it did not.
- Incremental `analyze` retries papers whose prior LLM build failed because of request/network/model availability issues, while reusing snapshots for papers that already succeeded.
- When using `mineru` with a remote HTTP backend, PaperNexus now probes reachability first. Default behavior is to stop on unreachable backends. Set `--mineru-remote-failure docling` or `analyze.mineruRemoteFailureMode = "docling"` to fall back to Docling instead.
- `watch --force` only matters for the initial startup pass; later file-change reindexes run with `force: false` so background watching stays incremental.
- `service install` defaults to both `watch` and `serve` if `--services` is omitted.
- `serve` starts the dashboard/API plus the enhancement worker, import worker, and authoritative sync worker.
- When a MinerU HTTP backend is configured, `serve` also performs a best-effort background MinerU warmup on startup. This should never block server startup, so warmup success belongs in logs, not startup gating.
- `papernexus logs watch` prints the current auto-index tmp log path and current log contents.
- All `/api/*` routes served by `papernexus serve` now require a token.
- Configure the server token with `serve.apiToken` or `PAPERNEXUS_API_TOKEN`.
- Browser access to the dashboard can supply the token once via `?token=<secret>`; the web client will reuse it for later API calls.
- Stage 4 progress labels now distinguish `acquiring corpus commit lock` from `waiting for corpus commit lock`; seeing `waiting` now means there is real lock contention.
- Chart/axis noise from OCR (e.g., "0.50 0.45 0.40 [SSR] [CLIP]") is automatically filtered during text extraction and entity sanitization.
- Set `PAPERNEXUS_GRAPH_BACKEND=json` to force legacy JSON graph storage.
- Environment variables: `PAPERNEXUS_PDF_PARSER`, `PAPERNEXUS_MINERU_CMD`, `PAPERNEXUS_MINERU_HTTP_URL`, `PAPERNEXUS_DOCLING_CMD`, `PAPERNEXUS_DOCLING_OCR_ENGINE`, `PAPERNEXUS_DOCLING_PDF_BACKEND`, `PAPERNEXUS_MARKER_CMD`, `PAPERNEXUS_GRAPH_BACKEND`, `PAPERNEXUS_HOME`.

## Preferred Command Style For Repo Development

Use the CLI only for repo-local development, isolated fixture testing, or implementation work inside this repository.

Do not use these CLI commands as the control plane for a live remote graph.

Prefer the globally linked CLI if available:

```bash
papernexus <command>
```

Fallback:

```bash
node ./src/cli/index.js <command>
```

Common commands:

```bash
papernexus init
papernexus analyze
papernexus analyze --quiet  # 进度条模式，简洁输出
papernexus analyze --semantic-extraction auto
papernexus analyze --force --rebuild-pdf-markdown  # 仅在明确要重建全部 PDF markdown cache 时使用
papernexus analyze --semantic-extraction llm-primary --concurrency 16 --batch-size 16
papernexus analyze  # if sources.inputs is configured
papernexus materialize --continue
papernexus llm-optimize --continue --semantic-extraction llm-primary --batch-size 16
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
papernexus stage1 --continue
papernexus stage2 --continue --semantic-extraction llm-primary --batch-size 16
papernexus stage3 --continue
papernexus stage4 --continue
papernexus optimize --continue --semantic-extraction llm-primary --batch-size 16
papernexus analyze --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
papernexus analyze --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000 --mineru-remote-failure docling
papernexus analyze --force --pdf-parser docling --docling-pdf-backend pypdfium2  # 仅在明确要求本地全量重建时使用
papernexus analyze --semantic-extraction auto --provider openai --model gpt-4o-mini
papernexus probe  # Test LLM connectivity
papernexus watch
papernexus enhance --once
papernexus serve
papernexus service install
papernexus service status
papernexus logs watch
```

## Core Files

Read these first when you need orientation:

- `src/cli/index.js`
- `src/core/ingestion/pipeline.js`
- `src/storage/corpus-store.js`
- `src/storage/kuzu-store.js`
- `src/core/enhancements/worker.js`
- `src/server/http.js`
- `README.md`

## Working Rules

- Use `rg` for search and `sed -n` for focused file reads.
- Use `apply_patch` for edits.
- Be careful with repo-local `config.json`; some tests intentionally bypass it with `--no-config=true`.
- Do not assume paths using `~` are safe unless they go through the config helpers.
- Treat `--force` as exceptional, not routine. If the user did not explicitly ask for a full rebuild, assume the safe default is `papernexus analyze` or a staged `--continue` path.
- Agent database-safety policy:
  - only perform additive or update-style operations on the current single graph
  - do not delete corpus data, remove source files, wipe staged data, or restore/import whole-database archives unless a human explicitly asks
  - do not run `backup-export`, `backup-unpack`, or `backup-load` on the user's behalf as part of normal agent operation
- Prefer remote MinerU for PDF work. If an agent is about to run `analyze`, `materialize`, or any parser debug flow against PDFs, assume `mineruHttpUrl` is the first-choice path and mention that choice in the reasoning or command examples.
- Treat local Docling and Marker as fallback or special-case tools, not the default recommendation, unless the user explicitly asks for local parsing.
- If a task involves ad hoc uploaded PDFs or Markdown from a UI/API flow, prefer the queued import-task path over manually copying those files into the main paper source directory.
- If an import, stage, or worker run appears stuck, report the exact stage, latest task log lines, elapsed time, and the most likely blocker or stale-path cause. Do not keep retrying the same command in a loop without new evidence.
- If a task involves the live graph, assume the authenticated HTTP API is the only allowed interface unless the user explicitly asks for isolated local repo testing.
- If a task involves the Web API, do not assume anonymous access. Use the configured PaperNexus API token and include it as `Authorization: Bearer <token>` unless the user explicitly says another auth path is in place.
- Do not fall back from a missing API feature to local CLI graph operations. Report the missing endpoint or unsupported workflow clearly.
- When an ingestion run failed only because LLM requests were unavailable, prefer rerunning `papernexus llm-optimize`, `papernexus optimize`, or `papernexus analyze` before reaching for `--force`.
- Prefer `papernexus materialize` first when debugging PDF parsing or markdown cache issues, `papernexus llm-optimize` when debugging LLM extraction, `papernexus build-graph` when debugging graph projection, `papernexus merge-graph` when debugging duplicate or low-quality evaluation nodes, and `papernexus write-index` when debugging final persistence.
- If Stage 3 already succeeded and you specifically need to inspect or fix duplicate `Dataset` / `Benchmark` nodes before commit, run `papernexus merge-graph --continue`.
- If the staged graph contains generic evaluation nodes such as `training dataset`, inspect and clean that logic through merge heuristics or later manual review; do not rely on `--node-llm-check` right now.
- If Stage 3 already succeeded and you only need to finish the commit, prefer `papernexus write-index --continue`.
- If new raw papers were added and you want them included in the next committed graph, rerun Stage 1-3 before Stage 4. Stage 4 alone only commits the staged graph it already has.
- When changing persistence behavior, run tests that cover CLI, workflow, and enhancements.

## Validation Checklist

For storage, indexing, or CLI changes, prefer:

```bash
node --test test/workflow.test.js
node --test test/enhancements.test.js
node --test test/cli.test.js
```

For broad verification:

```bash
npm test
```

## Service Model

PaperNexus built-in background service installation currently targets macOS `launchd`.

Supported services:

- `watch`
- `serve`

Install:

```bash
papernexus service install
```

Status:

```bash
papernexus service status
```

Watch log:

```bash
papernexus logs watch
```

### Linux PM2 Operation

On Linux, prefer a process supervisor such as `pm2` instead of `papernexus service install`.

If you only need the UI/API and import processing:

```bash
pm2 start "node ./src/cli/index.js serve --config /data16T/hyq/.papernexus/config.json" --name papernexus-serve --cwd /data16T/hyq/autoresearch/PaperNexus
```

If you also want background file watching:

```bash
pm2 start "node ./src/cli/index.js watch --config /data16T/hyq/.papernexus/config.json" --name papernexus-watch --cwd /data16T/hyq/autoresearch/PaperNexus
```

Persist across reboot:

```bash
pm2 save
pm2 startup systemd -u hyq --hp /data16T/hyq
```

Operational commands:

```bash
pm2 status
pm2 logs papernexus-serve
pm2 restart papernexus-serve
pm2 restart papernexus-watch
```

Notes:

- keep `serve.apiToken` in the config file or provide it through environment
- use `serve` alone when you only need the API/UI and queued import handling
- add `watch` only when you also want filesystem-triggered incremental reindexing
- after `pm2 startup`, run the generated `sudo` command once on the server so PM2 itself is restored on boot

## Graph Mutation Support

PaperNexus currently supports graph mutation for the indexed corpus.

## Brainstorm View

When working on ideation quality, distinguish between:

- the full graph: everything admitted into the research graph
- the brainstorm view: only nodes marked `brainstormEligible`

Use the brainstorm view when:

- generating research directions
- comparing problems and methods
- inspecting which nodes are good anchors for `ideas` or `brainstorm`

Do not assume every visible node in the raw graph is a good ideation anchor. Prefer nodes with:

- multi-word, reusable research-object names
- non-trivial evidence text
- `brainstormTier` of `medium` or `high`

Current ideation behavior to remember:

- `ideas` and `brainstorm` still start from the brainstorm-quality node view rather than the full noisy graph
- they now add a one-shot local Leiden community analysis at query time, not a persisted full-graph clustering index
- the local community graph is concept-only: brainstorm-eligible `Problem`, `Method`, `Claim`, `Finding`, `Limitation`, `Assumption`, `FutureDirection`, and `ResearchGoal` nodes participate directly
- `Paper` nodes only act as temporary bridge evidence for weak co-occurrence edges and do not appear as community members
- explicit concept-concept edges remain the backbone; paper co-occurrence only adds bounded weak edges
- if the local projected graph is too small, too sparse, or too slow, the search layer should fall back to the older heuristics instead of forcing a community result

What is supported:

- create node
- update node
- delete node
- create relationship
- update relationship
- delete relationship

Preferred entrypoint:

- MCP `mutate_graph` with `dryRun: true` first

When mutation is appropriate:

- the graph has a clear schema-level error
- a node is mislabeled or duplicated in an obvious way
- a relationship is wrong, missing, or points to the wrong anchor
- the correction is high-confidence and local

What agents can safely modify:

- node names
- node properties
- relationship endpoints
- relationship properties
- schema-valid node and relationship additions

What agents should not treat as permanently editable:

- source Markdown via graph mutation
- semantic paper snapshots as if they were manual truth
- enhancement overlays as long-term canonical edits

Important limitation:

- graph mutations apply to the current indexed graph
- a later full `analyze --force` or rebuild can overwrite those changes

So use mutation for:

- corrective local fixes
- previews and curation experiments
- operator-approved graph cleanup

Do not use mutation as the only long-term source of truth.

## Good Defaults For Agents

When making operational suggestions, prefer:

- corpus name from config if present
- paper source under `/Users/iranb/.papernexus/papers`
- index under `/Users/iranb/.papernexus/index-store`
- Kuzu as the default graph backend

When debugging unexpected directories under the repo, suspect:

- config path resolution
- repo-local `config.json`
- missing `~` expansion
- `PAPERNEXUS_HOME` overrides
