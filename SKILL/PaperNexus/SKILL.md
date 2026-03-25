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
- use `mineru` as the default PDF-to-Markdown parser via HTTP API, with `docling` and `marker` as switchable alternatives
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
- prefer a clean source tree over deep nesting

## Current Behavior To Know

- Multiple corpora are supported, but commands usually operate on one corpus at a time via `--corpus`.
- Multiple `sources.inputs` may feed one corpus; that is not the same as cross-corpus federation.
- `~` expansion in config paths is supported and should resolve to the user home directory.
- The graph backend defaults to Kuzu when the `kuzu` package is available.
- The default PDF parser is `mineru` with HTTP API mode; switch with `analyze.pdfParser` or `--pdf-parser docling|marker`.
- For MinerU HTTP API, use `analyze.mineruCommand` or `--mineru-http-url` to specify the remote endpoint (e.g., `http://211.71.76.29:30000`).
- For local macOS OCR with Docling, use `analyze.doclingOcrEngine = "ocrmac"` or `--docling-ocr-engine ocrmac`.
- For Docling PDF parsing backend, use `analyze.doclingPdfBackend` or `--docling-pdf-backend`. Available backends: `pypdfium2` (recommended), `pdfplumber`, `fitz`, `pypdf`.
- Semantic extraction supports `auto`, `heuristic-only`, `llm-assisted`, and `llm-primary` via `analyze.semanticExtraction` or `--semantic-extraction`. Default is `auto`: use LLM assistance when model config is available, otherwise fall back to heuristics.
- Node admission is now stricter before graph projection. Low-signal surface forms such as single-word generic nouns, title fragments, and citation-like fragments are filtered out instead of being promoted into brainstorm-facing graph nodes.
- Kept research nodes may carry `brainstormEligible`, `brainstormScore`, and `brainstormTier` properties. These mark the high-quality ideation layer used by brainstorming features.
- `ideas` and `brainstorm` now prefer the brainstorm-quality node view rather than the full noisy graph.
- LLM-assisted relation extraction is controlled by `llm.relations: true` in config.
- Per-paper semantic snapshots now record whether LLM assistance was requested, whether it actually participated, the effective mode, and the failure reason when it did not.
- Incremental `analyze` retries papers whose prior LLM build failed because of request/network/model availability issues, while reusing snapshots for papers that already succeeded.
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
papernexus analyze --force
papernexus analyze --force --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
papernexus analyze --force --pdf-parser docling --docling-pdf-backend pypdfium2
papernexus analyze --semantic-extraction auto --provider openai --model gpt-4o-mini
papernexus probe  # Test LLM connectivity
papernexus watch
papernexus status --corpus <name>
papernexus brainstorm "<topic>" --corpus <name>
papernexus brainstorm "<topic>" --corpus <name> --mode diverge
papernexus enhance --once
papernexus serve
papernexus service install --services watch,serve
papernexus service status --services watch,serve
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
- When an ingestion run failed only because LLM requests were unavailable, prefer rerunning `papernexus analyze <path>` before reaching for `--force`.
- When changing persistence behavior, run tests that cover CLI, workflow, backup, and enhancements.

## Validation Checklist

For storage, indexing, or CLI changes, prefer:

```bash
node --test test/workflow.test.js
node --test test/backup.test.js
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
papernexus service install --services watch,serve
```

Status:

```bash
papernexus service status --services watch,serve
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
