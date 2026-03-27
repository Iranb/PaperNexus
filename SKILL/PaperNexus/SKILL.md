---
name: papernexus
description: Use this skill when working inside the PaperNexus repository to understand its CLI, corpus layout, storage backends, enhancement worker, and service workflow. Helpful for agents making code changes, running the CLI, debugging config/path issues, or operating PaperNexus as a local research graph system.
---

# PaperNexus

Use this skill when the task is about the PaperNexus codebase itself.

## What This Repo Is

PaperNexus is a local-first research knowledge graph system for papers.

Key capabilities:

- ingest PDF or Markdown sources
- use remote `mineru` over HTTP as the preferred default PDF-to-Markdown parser, with `docling` and `marker` as switchable fallbacks
- build and incrementally update a multilayer research graph
- store the authoritative graph in Kuzu by default
- keep a lite JSON graph for fast read paths
- run background theory/storyline enhancement workers
- expose CLI, local web UI, and MCP server workflows

## Important Paths

Assume these defaults unless the repo config says otherwise:

- paper source default: `/Users/iranb/.papernexus/papers`
- index root default: `/Users/iranb/.papernexus/index-store`
- runtime config default: `/Users/iranb/.papernexus/config.json`
- launchd logs: `/Users/iranb/.papernexus/logs`

Inside each corpus root, PaperNexus writes:

- `.papernexus/graph.kuzu` as the default authoritative graph
- `.papernexus/graph.lite.json` as the lite read index
- `.papernexus/meta.json`
- `.papernexus/sources.json`
- `.papernexus/papers/*.json` for per-paper semantic snapshots
- `.papernexus/markdown/` as the unified markdown working cache for both PDF-derived markdown and copied source markdown
- `.papernexus/imports/` for queued ad hoc upload tasks, task logs, and upload-specific source files

## Paper Markdown Storage Conventions

If full-paper Markdown files already exist, store them as source inputs under the paper source directory, not inside `.papernexus`.

Recommended location:

- `/Users/iranb/.papernexus/papers`

### File Naming

Prefer stable, readable ASCII filenames:

- use lowercase
- use hyphen-separated words
- avoid spaces
- avoid non-ASCII unless the source collection already uses them consistently
- prefer the paper title or a short normalized title
- add a year or venue suffix only when needed to disambiguate

Good examples:

- `retrieval-augmented-experiment-planning.md`
- `graph-augmented-literature-mapping.md`
- `self-refine-2023.md`

Avoid:

- `final version!!.md`
- `Paper Notes.md`
- `论文1.md` unless the whole collection consistently uses Chinese filenames

### Subdirectory Layout

PaperNexus can recurse through subdirectories, so organize for human maintenance first.

Recommended patterns:

- by topic
- by project
- by venue or year

Examples:

```text
/Users/iranb/.papernexus/papers/
  llm-reasoning/
    self-refine-2023.md
    reflexion-2023.md
  biomedical-discovery/
    graph-augmented-literature-mapping.md
  experiment-planning/
    retrieval-augmented-experiment-planning.md
```

Guidelines:

- keep one paper per Markdown file
- do not place generated graph artifacts under the paper source tree
- mixed PDF and Markdown source directories are supported; the ingestion pipeline now materializes both and dedupes same-paper pairs before graph construction
- both PDF inputs and raw Markdown inputs are cached under the corpus markdown cache so later analyzes can reuse the cached markdown path
- both `papernexus analyze` and `papernexus analyze --force` are cache-first now: they prefer the corpus markdown cache when the source fingerprint is unchanged, and only refresh the cache when the source file itself changed or the cache is missing
- if you need to force regeneration of every PDF-derived markdown cache, use `papernexus analyze --force --rebuild-pdf-markdown`
- prefer a clean source tree over deep nesting
- in `openclaw-research` workflow-owned literature graph refreshes, do **not** use `--force` or `--rebuild-pdf-markdown` unless a human explicitly requests a rebuild; prefer cache-first `papernexus analyze`, and if it fails, hand the exact command to the user

## Current Behavior To Know

- Multiple corpora are supported, but commands usually operate on one corpus at a time via `--corpus`.
- Default operator assumption in this repo: treat the configured corpus as a single authoritative graph. Do not point stage commands at a random subdirectory once a graph already exists.
- Multiple `sources.inputs` may feed one corpus; that is not the same as cross-corpus federation.
- `~` expansion in config paths is supported and should resolve to the user home directory.
- The graph backend defaults to Kuzu when the `kuzu` package is available.
- The default PDF parser is remote `mineru` in HTTP API mode; agents should prefer this path whenever a task needs PDF materialization.
- For MinerU HTTP API, use `analyze.mineruHttpUrl` or `--mineru-http-url` to specify the remote endpoint (e.g., `http://211.71.76.29:30000`).
- Agent policy: when the source is a PDF, try the remote MinerU path first; do not switch to local Docling or Marker unless the remote endpoint is unavailable or the task explicitly requires a local parser.
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
- Import tasks keep per-task `events.log` files and stay in a separate directory even after their parsed content is merged into the main graph.
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
- `papernexus logs watch` prints the current auto-index tmp log path and current log contents.
- All `/api/*` routes served by `papernexus serve` now require a token.
- Configure the server token with `serve.apiToken` or `PAPERNEXUS_API_TOKEN`.
- Browser access to the dashboard can supply the token once via `?token=<secret>`; the web client will reuse it for later API calls.
- Stage 4 progress labels now distinguish `acquiring corpus commit lock` from `waiting for corpus commit lock`; seeing `waiting` now means there is real lock contention.
- Chart/axis noise from OCR (e.g., "0.50 0.45 0.40 [SSR] [CLIP]") is automatically filtered during text extraction and entity sanitization.
- Set `PAPERNEXUS_GRAPH_BACKEND=json` to force legacy JSON graph storage.
- Environment variables: `PAPERNEXUS_PDF_PARSER`, `PAPERNEXUS_MINERU_CMD`, `PAPERNEXUS_MINERU_HTTP_URL`, `PAPERNEXUS_DOCLING_CMD`, `PAPERNEXUS_DOCLING_OCR_ENGINE`, `PAPERNEXUS_DOCLING_PDF_BACKEND`, `PAPERNEXUS_MARKER_CMD`, `PAPERNEXUS_GRAPH_BACKEND`, `PAPERNEXUS_HOME`.

## Preferred Command Style

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
papernexus status --corpus <name>
papernexus brainstorm "<topic>" --corpus <name>
papernexus brainstorm "<topic>" --corpus <name> --mode diverge
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
- If a task involves the Web API, do not assume anonymous access. Use the configured PaperNexus API token and include it as `Authorization: Bearer <token>` unless the user explicitly says another auth path is in place.
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

PaperNexus background services currently target macOS `launchd`.

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
