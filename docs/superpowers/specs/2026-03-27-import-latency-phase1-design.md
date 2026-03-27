# Import Latency Phase 1 Design

## Goal

Reduce cold-start import latency for API PDF ingestion by:
- adding structured timing around the PDF materialization path
- caching MinerU HTTP reachability checks for a short TTL
- warming the MinerU backend when the serve process starts

## Problem

Recent remote measurements against the live import API showed that `POST /api/imports` itself is fast, while the background import worker spends almost all time in `materialize`. The first PDF after startup took much longer than subsequent PDFs, which strongly suggests MinerU cold-start overhead. The current code also probes the MinerU HTTP endpoint before each PDF parse, adding avoidable latency on the hot path.

## Scope

This phase changes only the early PDF materialization path and serve startup behavior.

In scope:
- structured materialization timing fields persisted on import tasks
- MinerU reachability probe caching with a bounded TTL
- optional MinerU startup warmup in `serve`
- tests for the new timing and warmup behavior

Out of scope:
- multi-worker import queue changes
- content-addressed markdown cache reuse
- parser selection changes between MinerU, Docling, and Marker

## Design

### 1. Structured materialization timing

The import worker should persist a `materializeTimings` object into `task.result.materialized`, including:
- `totalMs`
- `pdfToMarkdownMs`
- `markdownReadMs`
- `markdownParseMs`
- `semanticSnapshotMs`
- nested parser timings when available, especially for MinerU:
  - `probeHttpMs`
  - `pdfReadMs`
  - `mineruRequestMs`
  - `markdownWriteMs`

The pipeline already returns `materialized.meta.paperCount`; this phase extends the materialization result so import-task consumers can see which part of `materialize` dominated.

### 2. MinerU probe TTL cache

`probeHttpEndpoint()` should be wrapped by a small in-memory cache keyed by URL. Successful and failed reachability results should be reused for a short TTL so a burst of imports does not re-probe the same MinerU endpoint on every PDF.

Design choices:
- cache key: resolved MinerU HTTP URL
- default TTL: 15 seconds
- cache is process-local and intentionally ephemeral
- explicit opt-out via `mineruProbeCacheTtlMs: 0`
- failed parses should invalidate the cached reachability entry before surfacing the error

### 3. Serve-time MinerU warmup

When the serve process starts and import worker support is enabled, a background warmup task should run once per configured MinerU HTTP URL. The warmup should:
- respect the same timeout guard as normal MinerU calls
- be best-effort and never block server startup
- log success/failure with clear `[serve]` prefixes
- avoid duplicate warmups for the same URL in a single process

Phase 1 warmup only probes the backend and does not submit a synthetic PDF. This is intentionally conservative; if the backend still shows a large cold-start tax after this change, the next iteration can upgrade warmup to a lightweight parse.

## Risks

- Probe caching can briefly mask a just-changed backend status during the TTL window. Keeping the TTL short limits this risk.
- Warmup logs must stay non-fatal so serve startup does not become brittle.
- Timing collection must be additive and not change materialization semantics.

## Validation

- Unit tests prove probe caching avoids repeated probes and can be disabled.
- Unit tests prove MinerU parser timings are surfaced in conversion results.
- HTTP serve tests prove warmup runs in the background and logs expected states.
- Manual remote benchmark compares:
  - cold first import
  - hot sequential imports
  - repeated import dedupe path
