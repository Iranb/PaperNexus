# Overview

PaperNexus is a **local-first, analysis-first research knowledge graph engine** for corpora of academic papers you already have on disk or upload through controlled import flows.

At a high level, the system takes raw paper files, converts them into reusable semantic snapshots, projects them into a multilayer graph, and then exposes that graph through a CLI, a browser dashboard, an authenticated HTTP server, and both local and remote MCP surfaces.

## The Mental Model

The system is easiest to understand as five cooperating layers:

1. **Source layer**
   Raw `.pdf`, `.md`, or `.markdown` files that belong to a corpus.
2. **Snapshot layer**
   Reusable per-paper markdown caches, semantic snapshots, and source manifests.
3. **Graph layer**
   The authoritative corpus graph plus a lightweight read-optimized graph projection.
4. **Queue and worker layer**
   Import queues, enhancement queues, failed-task recovery, parser-state persistence, and authoritative sync jobs that let the system refresh incrementally.
5. **Interface layer**
   CLI, browser UI, authenticated HTTP routes, MCP tools, and skill-local automation wrappers.

## Architectural Priorities

PaperNexus is built around a few strong design priorities.

### 1. Reuse Before Rebuild

Long-running paper analysis should not start from zero just because a later stage changed. The system therefore stores reusable markdown caches and semantic snapshots so expensive PDF parsing and semantic extraction can be resumed, refreshed, or replayed instead of repeated blindly.

### 2. Graph Construction Is Staged

Graph construction is explicitly staged:

- materialize
- llm-optimize
- build-graph
- merge-graph
- write-index

This is what makes recovery, partial reruns, and queue-based ingestion practical.

### 3. Imports Should Be Durable And Recoverable

Live uploads are operationally different from local one-shot `analyze` runs. PaperNexus therefore stores every import task, task log, uploaded source file, retry state, and quarantine event.

The current import worker can:

- retry failed tasks whose uploaded files still exist
- mark historical failed attempts as completed when an equivalent later task succeeded
- quarantine stale pending tasks without deleting evidence
- scope Stage 2 and fast commit to changed source keys

This keeps agents from stopping on stale transient failures and prevents one uploaded paper from forcing a full-corpus rebuild.

### 4. Live Graph Control Should Be Remote-MCP-First

For live, user-facing graph automation, the recommended control plane is the authenticated remote HTTP MCP endpoint exposed by `papernexus serve`. That keeps higher-level agents away from inventing raw API routes or mixing local-only and remote-only path assumptions.

### 5. The Knowledge Graph Is Not Just Search Indexing

The graph is used for:

- semantic retrieval
- local context and impact tracing
- idea generation
- challenge and mechanism abstraction
- domain bridge retrieval
- structural analogy
- interdisciplinary potential ranking

This makes the graph an analysis substrate, not just a storage format.

## System Boundaries

PaperNexus deliberately does **not** cover the entire automated research stack.

### What PaperNexus Owns

- ingesting already-provided papers
- converting PDF and Markdown into reusable semantic state
- building and refreshing a multilayer graph
- exposing graph-native query and ideation capabilities
- tracking import queue progress and background refresh state
- retrying or superseding recoverable import failures

### What Surrounding Systems Should Own

- finding new papers on the open web
- orchestrating multi-agent workflows across multiple external systems
- deciding when to fetch more literature
- writing long-form storyline or end-to-end research plans outside the graph engine

## Current Major Subsystems

The major codebase slices map closely to the runtime model:

- [`src/core/ingestion`](https://github.com/Iranb/PaperNexus/blob/main/src/core/ingestion/pipeline.js): staged source-to-snapshot and snapshot-to-graph pipeline
- [`src/core/graph`](https://github.com/Iranb/PaperNexus/blob/main/src/core/graph/schema.js): graph schema, domain and mechanism layers, catalyst-related reasoning, and delta logic
- [`src/core/search`](https://github.com/Iranb/PaperNexus/blob/main/src/core/search/search.js): search, context, impact, ideas, and brainstorming retrieval
- [`src/core/imports`](https://github.com/Iranb/PaperNexus/blob/main/src/core/imports/worker.js): asynchronous import worker and queue processing
- [`src/core/enhancements`](https://github.com/Iranb/PaperNexus/blob/main/src/core/enhancements/worker.js): background enhancement overlays and metadata backfill
- [`src/core/authoritative-sync`](https://github.com/Iranb/PaperNexus/blob/main/src/core/authoritative-sync/worker.js): authoritative graph sync
- [`src/storage`](https://github.com/Iranb/PaperNexus/blob/main/src/storage/corpus-store.js): persistent graph, manifests, lite view, and queue stores
- [`src/server`](https://github.com/Iranb/PaperNexus/blob/main/src/server/http.js): browser UI host, HTTP server, and API surface
- [`src/mcp`](https://github.com/Iranb/PaperNexus/blob/main/src/mcp/tools.js): stdio and remote HTTP MCP tools
- [`web`](https://github.com/Iranb/PaperNexus/blob/main/web/app.js): browser dashboard

## Read Next

- [Get Started](/get-started/)
- [Pipeline Overview](/pipeline/)
- [Import Recovery And Performance](/pipeline/import-recovery-and-performance)
- [Graph Overview](/graph/)
- [Reference Hub](/reference/)
