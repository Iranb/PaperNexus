# Pipeline And Storage

PaperNexus is now designed as a cache-first staged pipeline rather than a single monolithic rebuild command.

## The Five Stages

```text
raw papers
  ->
materialize
  ->
llm-optimize
  ->
build-graph
  ->
merge-graph
  ->
write-index
```

## Stage Semantics

### 1. `materialize`

This stage:

- scans source inputs
- converts PDF to Markdown when needed
- copies source Markdown into the corpus markdown cache
- writes reusable semantic snapshots

This is the right stage when you want to ensure raw papers are converted and cached.

### 2. `llm-optimize`

This stage:

- loads reusable semantic snapshots
- runs LLM semantic extraction
- runs relation extraction
- rewrites snapshot state with richer paper-local semantics

This is the right stage when you want to refresh model-driven node and relation quality without touching PDF parsing again.

### 3. `build-graph`

This stage:

- loads semantic snapshots
- builds a staged graph
- runs graph precompute and postprocess logic
- writes the staged graph and staged metadata under the corpus staging directory

### 4. `merge-graph`

This stage:

- canonicalizes similar `Dataset` and `Benchmark` nodes
- merges aliases into a cleaner staged graph
- optionally performs `--node-llm-check`

The optional node LLM check is where low-value nodes such as `training dataset` can be dropped or renamed before the final commit.

### 5. `write-index`

This stage:

- acquires the corpus commit lock
- writes the authoritative graph
- writes the lite graph materialized view
- writes `meta.json` and `sources.json`
- updates the corpus registry
- enqueues enhancement work

## `--continue` And `--force`

Each stage supports resumable behavior, but the meaning of `--force` is stage-specific.

### `--continue`

Use this when you want to:

- reuse markdown cache
- reuse semantic snapshots
- reuse staged graph outputs
- recover after interruption

### `--force`

Use this when you want to:

- restage the current step from scratch
- ignore reusable outputs for that step
- rebuild the stage output deliberately

Important nuance:

- `materialize --force` reruns source materialization
- `materialize --force --rebuild-pdf-markdown` additionally forces fresh PDF-to-Markdown conversion
- `llm-optimize --force` reruns LLM enrichment without needing to redo PDF parsing
- `build-graph --force` rebuilds the staged graph from snapshots
- `merge-graph --force` reruns merge logic
- `write-index --force` recommits the staged graph

## Cache-First Behavior

PaperNexus now prefers reusable markdown cache and snapshots over redoing expensive parsing work.

### Markdown Cache

All reusable Markdown lives under the corpus:

```text
<index-root>/.papernexus/markdown/
```

This includes:

- PDF-derived Markdown
- copied source Markdown

The system updates the cache only when the corresponding source fingerprint changes, unless you explicitly force a rebuild.

### Semantic Snapshots

Paper-local snapshots live under:

```text
<index-root>/.papernexus/papers/
```

These snapshots are the checkpoint layer that makes `analyze`, `optimize`, and staged resumes practical after interruption.

### Staged Graph Files

Graph-build intermediates live under:

```text
<index-root>/.papernexus/staged/
```

This is what lets you run:

```bash
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
```

without repeating earlier work.

## Corpus Layout

Inside a corpus root, the main paths are:

```text
.papernexus/
  graph.kuzu
  graph.lite.json
  graph.lite.state.json
  meta.json
  sources.json
  markdown/
  papers/
  staged/
```

Key files:

- `graph.kuzu`: authoritative graph when Kuzu is available
- `graph.json`: JSON fallback authoritative graph
- `graph.lite.json`: light read-optimized graph
- `graph.lite.state.json`: incremental state for the lite graph materialized view
- `meta.json`: corpus-level summary
- `sources.json`: source manifest and staged metadata

## Locking Model

PaperNexus uses a corpus commit lock:

```text
<index-root>/.papernexus.lock
```

The important current behavior is:

- long-running per-paper work now tries to happen before the final commit lock
- the lock is mainly for the final corpus write
- interrupted runs can often resume because markdown cache and snapshots are already on disk

If a run is interrupted abruptly and the lock remains, clear it only after making sure no other PaperNexus process is still active.

## Duplicate Source Handling

A single corpus can include both PDF and Markdown inputs.

The system now:

- discovers both source types
- canonicalizes same-paper sources
- prefers high-quality Markdown when appropriate
- keeps source manifest provenance
- avoids duplicating one paper into the graph twice

## Merge Stage Behavior

The merge stage currently focuses on evaluation resources.

Examples:

- `Office-Home dataset` and `Office Home benchmarks`
- `Oxford Pets dataset` and `Oxford-Pet dataset`

The goal is not just string deduplication. It is to produce cleaner research resources for downstream query and brainstorm use.

## Node LLM Check

`--node-llm-check` is optional and disabled by default.

It runs during `merge-graph` and can:

- keep a node as-is
- rename a node
- drop a node if it is too generic to be useful

Typical use:

```bash
papernexus merge-graph --continue --node-llm-check
```

This is especially useful when you want to filter out vague evaluation labels before using the graph for brainstorming.

## Recommended Recovery Patterns

### Resume A Normal Interrupted Run

```bash
papernexus analyze
```

### Resume From Completed Stage 1

```bash
papernexus llm-optimize --continue
papernexus build-graph --continue
papernexus merge-graph --continue
papernexus write-index --continue
```

### Recommit An Already Built Staged Graph

```bash
papernexus write-index --continue
```

### Regenerate All PDF Markdown Cache

```bash
papernexus materialize --force --rebuild-pdf-markdown
```
