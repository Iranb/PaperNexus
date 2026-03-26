# Architecture

PaperNexus is a local-first research graph system built around reusable per-paper state, a staged graph build pipeline, and a long-horizon enhancement layer.

## Mental Model

Think of the system as four layers:

1. raw paper sources
2. reusable per-paper cache and snapshots
3. authoritative graph plus lite read view
4. asynchronous enhancement overlays

## Core Graph Model

The graph is centered on `Paper` and a set of research-semantic node types.

Common node types include:

- `Paper`
- `Problem`
- `Method`
- `Claim`
- `Finding`
- `Evidence`
- `Limitation`
- `Assumption`
- `Dataset`
- `Benchmark`
- `Metric`
- `FutureDirection`

These nodes are connected by typed relations such as:

- `SOLVES`
- `USES`
- `CLAIMS`
- `SUPPORTED_BY`
- `EVALUATES_ON`
- `BENCHMARKED_ON`
- `REPORTS`
- `HAS_LIMITATION`
- `ASSUMES`
- `CITES`
- `SIMILAR_TO`
- `CONTRADICTS`

The graph is intended to support both:

- paper-centered inspection
- concept-centered query, impact tracing, and brainstorming

## Paper-Local Semantic Layer

Before graph commit, each paper goes through a paper-local semantic representation.

That representation can include:

- parsed markdown structure
- heuristic semantic candidates
- LLM-enriched semantic objects
- relation extraction results
- provenance and confidence fields

This design is what makes interruption recovery practical.

## Authoritative Graph And Lite View

PaperNexus stores two graph views:

### Authoritative Graph

The main graph is stored in:

- `graph.kuzu` when Kuzu is available
- `graph.json` as JSON fallback

This is the full graph and source of truth for the corpus.

### Lite Graph

The lite view is stored in:

- `graph.lite.json`
- `graph.lite.state.json`

The lite view is optimized for:

- search
- dashboard loading
- interactive query helpers

It is materialized incrementally from the authoritative graph.

## Staged Graph Build

The graph build is intentionally split before final commit.

Why this matters:

- large corpora are expensive
- LLM and PDF parsing are slow
- a single interrupted run should not lose all progress

So PaperNexus now keeps staged graph outputs under:

```text
.papernexus/staged/
```

That makes `build-graph`, `merge-graph`, and `write-index` independently resumable.

## Merge And Canonicalization

The merge stage sits between graph build and final commit.

Its current role is to:

- merge similar `Dataset` nodes
- merge similar `Benchmark` nodes
- preserve aliases and aggregated mentions
- optionally use LLM checking to remove low-value evaluation nodes

This stage exists because brainstorm-quality graph nodes need stricter admission and cleaner canonical names than raw extraction alone can provide.

## Enhancement Overlays

PaperNexus does not stop at the base graph. It also maintains asynchronous enhancement overlays.

Current overlays include:

- theory
- storyline
- reflection

### Theory Overlay

Focuses on:

- assumptions
- theorem-like support
- proof ideas
- mechanisms
- limitations
- failure modes

### Storyline Overlay

Focuses on:

- problem
- gap
- idea
- method
- evidence
- contribution
- limitation

### Reflection Overlay

Focuses on:

- `Innovation`
- `Experiment`
- `Outcome`
- `Reflection`

These overlays are meant to enrich the graph over time without blocking the main research workflow.

## Background Services

There are two long-running service roles:

- `watch`
- `serve`

`watch` monitors file changes and triggers incremental refresh.

`serve` runs the local dashboard/API and enhancement worker.

`papernexus service install` installs both by default on macOS via `launchd`.

## Repository Map

Important implementation files:

- `src/cli/index.js`
- `src/core/ingestion/pipeline.js`
- `src/core/llm/ollama.js`
- `src/core/graph/merge-similar.js`
- `src/storage/corpus-store.js`
- `src/storage/kuzu-store.js`
- `src/storage/lite-view.js`
- `src/core/enhancements/worker.js`
- `src/server/http.js`
- `src/server/api.js`

## Design Goals

The current architecture is optimized for:

- local-first operation
- resumable staged processing
- cache reuse before recomputation
- non-blocking enhancement layers
- graph-backed research exploration
- support for brainstorming, theory support, storyline sketching, and reflection
