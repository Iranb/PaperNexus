# Pipeline Overview

PaperNexus uses a **cache-first staged build pipeline** rather than one giant opaque rebuild step.

## The Five Stages

```text
raw sources
  -> materialize
  -> llm-optimize
  -> build-graph
  -> merge-graph
  -> write-index
```

Each stage exists because it solves a different operational problem.

## Stage Outputs At A Glance

| Stage | Primary Output | Why It Exists |
| --- | --- | --- |
| `materialize` | markdown cache, semantic snapshots, source-manifest updates | isolate slow source parsing and paper-local preprocessing |
| `llm-optimize` | enriched snapshots and relation data | improve semantic quality without touching raw parsing |
| `build-graph` | staged graph | convert snapshot objects into graph-native nodes and edges |
| `merge-graph` | canonicalized staged graph | reduce noisy duplicates before commit |
| `write-index` | authoritative graph, lite graph, meta, queue updates | publish graph state and refresh interactive views |

### Materialize

This stage prepares paper-local reusable state.

It is responsible for:

- scanning source inputs
- converting PDFs to markdown when needed
- copying provided markdown into the markdown cache
- generating semantic snapshot structures

Materialize is the boundary between raw files and reusable semantic state.

### LLM Optimize

This stage enriches cached snapshots without redoing PDF parsing.

It is responsible for:

- semantic extraction
- relation extraction
- challenge, mechanism, takeaway, and catalyst metadata enrichment

This is the stage you rerun when semantic quality changes but raw sources have not.

### Build Graph

This stage projects semantic snapshot objects into a staged multilayer graph.

It is where paper-local state becomes graph-native state.

### Merge Graph

This stage canonicalizes known near-duplicate structures such as datasets and benchmarks before final commit.

### Write Index

This is the commit stage.

It is responsible for:

- writing authoritative graph state
- refreshing the lite graph
- writing meta and manifests
- updating registry state
- queuing enhancement and authoritative sync follow-up work where needed

## Parser Integration Boundary

The pipeline can integrate multiple parser families, but it treats them as a source-preparation concern rather than a whole-system architectural branch. In practice, that means parser choice should not change the rest of the graph engine contract.

Current parser families include:

- OpenDataLoader
- Docling
- Marker
- MinerU
- PaddleOCR-VL

Their job is to deliver reliable markdown or parsed paper structure into the same downstream snapshot flow.

## Failure Boundaries

One reason the staged model is maintainable is that each stage has a narrow failure surface.

- if PDF parsing fails, the problem belongs near `materialize`
- if semantic extraction is low-quality, the problem belongs near `llm-optimize`
- if node or edge shape is wrong, the problem belongs near graph build or graph precompute
- if the graph looks stale after a fast update, the problem belongs near `write-index`, delta logic, or authoritative sync

This makes debugging far more direct than in monolithic systems where every failure looks like “analyze failed.”

## Why The Pipeline Is Split

The split is not cosmetic. It gives PaperNexus these operational properties:

- resumability
- cheaper reruns when only some stages need refreshing
- better import queue recovery
- better observability when a stage fails
- room for queue workers to reuse snapshot work without blindly rebuilding everything

## Incremental Refresh Philosophy

PaperNexus tries to avoid full rebuilds when the change scope is small.

Examples:

- import tasks reuse existing manifest inputs and only add changed sources
- lite graph state is updated through delta logic
- derived graph summaries such as `domainDistanceMatrix` are refreshed alongside incremental commits
- authoritative sync jobs replay prepared deltas instead of recomputing the entire corpus from scratch

## Background Workers

The pipeline also appears in background workers:

- import worker
- enhancement worker
- authoritative sync worker

Those workers do not invent a new processing model. They orchestrate the same staged data model in asynchronous form.

## Maintainability Rule

When adding new graph-native semantics, the maintenance question should always be:

1. where is the paper-local representation stored?
2. at which stage is it introduced?
3. how does it survive incremental commit?
4. how is it exposed through lite state, meta, MCP, and UI?

That question is what keeps new features aligned with the staged architecture instead of becoming one-off side channels.

## Read Next

- [Imports And Queue](/pipeline/imports-and-queue)
- [Graph Overview](/graph/)
- [Generated CLI Reference](/reference/generated/cli)
