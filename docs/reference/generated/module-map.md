# Module Map Reference

This page is generated from the repository file tree. It is intended as a system map for maintainers who need to find where a behavior actually lives.

## Cli

| File | Responsibility |
| --- | --- |
| [`src/cli/index.js`](https://github.com/papernexus/PaperNexus/blob/main/src/cli/index.js) | Primary CLI entrypoint and command dispatcher. |

## MCP

| File | Responsibility |
| --- | --- |
| [`src/mcp/core.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/core.js) | Core implementation. |
| [`src/mcp/http.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/http.js) | Streamable HTTP MCP transport adapter and request dispatch. |
| [`src/mcp/prompts.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/prompts.js) | Prompts implementation. |
| [`src/mcp/resources.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/resources.js) | MCP resource definitions, including domain-taxonomy style resource payloads. |
| [`src/mcp/server.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/server.js) | MCP server assembly for stdio and streamable HTTP transports. |
| [`src/mcp/stdio.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/stdio.js) | Local stdio MCP transport entrypoint. |
| [`src/mcp/tool-idea-catalyst.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-idea-catalyst.js) | Handler for the one-shot idea-catalyst MCP tool. |
| [`src/mcp/tool-import-workflow.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-import-workflow.js) | Handler for submit, progress, queue, and wait operations over the import queue. |
| [`src/mcp/tool-literature-discovery.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-literature-discovery.js) | Tool Literature Discovery implementation. |
| [`src/mcp/tool-research-briefing.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-research-briefing.js) | Typed chain and brief retrieval surface for remote callers. |
| [`src/mcp/tool-research-lookup.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-research-lookup.js) | Lookup and brainstorming surface for remote callers. |
| [`src/mcp/tools.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tools.js) | Public MCP tool catalog and input schemas. |

## Server

| File | Responsibility |
| --- | --- |
| [`src/server/api.js`](https://github.com/papernexus/PaperNexus/blob/main/src/server/api.js) | Payload builders and request handlers behind the HTTP routes. |
| [`src/server/http.js`](https://github.com/papernexus/PaperNexus/blob/main/src/server/http.js) | Authenticated HTTP server, browser UI host, and remote MCP bootstrap. |

## Storage

| File | Responsibility |
| --- | --- |
| [`src/storage/authoritative-sync-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/authoritative-sync-store.js) | Persistent job queue for authoritative sync work. |
| [`src/storage/backup-archive.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/backup-archive.js) | Backup Archive implementation. |
| [`src/storage/corpus-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/corpus-store.js) | Persistent corpus graph, meta, manifest, and mutation write path. |
| [`src/storage/enhancement-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/enhancement-store.js) | Persistent enhancement queue and overlay job state. |
| [`src/storage/import-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/import-store.js) | Queued import task persistence, logs, progress, and queue snapshots. |
| [`src/storage/kuzu-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/kuzu-store.js) | Kuzu Store implementation. |
| [`src/storage/lite-view.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/lite-view.js) | Incremental lite-graph materialized view and token index maintenance. |
| [`src/storage/llm-rate-limit-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/llm-rate-limit-store.js) | LLM Rate Limit Store implementation. |
| [`src/storage/pdf-parse-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/pdf-parse-store.js) | Pdf Parse Store implementation. |
| [`src/storage/registry.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/registry.js) | Global registry of indexed corpora. |

## Core

| File | Responsibility |
| --- | --- |
| [`src/core/authoritative-sync/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/authoritative-sync/worker.js) | Authoritative sync queue processor for full graph state. |
| [`src/core/benchmarks/retrieval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/benchmarks/retrieval.js) | Retrieval implementation. |
| [`src/core/benchmarks/task-evaluation.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/benchmarks/task-evaluation.js) | Task Evaluation implementation. |
| [`src/core/discovery/citation-expansion.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/citation-expansion.js) | Citation Expansion implementation. |
| [`src/core/discovery/download-manifest.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/download-manifest.js) | Download Manifest implementation. |
| [`src/core/discovery/entities.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/entities.js) | Entities implementation. |
| [`src/core/discovery/import-bridge.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/import-bridge.js) | Import Bridge implementation. |
| [`src/core/discovery/llm-query-planner.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/llm-query-planner.js) | LLM Query Planner implementation. |
| [`src/core/discovery/merge.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/merge.js) | Merge implementation. |
| [`src/core/discovery/providers.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/providers.js) | Providers implementation. |
| [`src/core/discovery/query-planner.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/query-planner.js) | Query Planner implementation. |
| [`src/core/discovery/source-resolution.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/source-resolution.js) | Source Resolution implementation. |
| [`src/core/discovery/store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/store.js) | Store implementation. |
| [`src/core/discovery/venue-registry.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/venue-registry.js) | Venue Registry implementation. |
| [`src/core/discovery/workflow.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/workflow.js) | Workflow implementation. |
| [`src/core/enhancements/extract.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/enhancements/extract.js) | Extract implementation. |
| [`src/core/enhancements/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/enhancements/worker.js) | Background enhancement worker and metadata backfill loop. |
| [`src/core/graph/abstract-mechanisms.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/abstract-mechanisms.js) | Abstract Mechanisms implementation. |
| [`src/core/graph/analogy.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/analogy.js) | Structural analogy and motif matching over graph-native concepts. |
| [`src/core/graph/brainstorm-view.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/brainstorm-view.js) | Brainstorm View implementation. |
| [`src/core/graph/bridge-retrieval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/bridge-retrieval.js) | Challenge-aware cross-domain bridge retrieval. |
| [`src/core/graph/catalyst-adapter.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/catalyst-adapter.js) | Idea-Catalyst graph adapter and higher-order ideation contract. |
| [`src/core/graph/challenges.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/challenges.js) | Challenge normalization and graph projection helpers. |
| [`src/core/graph/delta-commit.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/delta-commit.js) | Delta Commit implementation. |
| [`src/core/graph/domain-bridges.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/domain-bridges.js) | Cross-domain bridge construction, takeaways, and transferable edge enrichment. |
| [`src/core/graph/domain-taxonomy.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/domain-taxonomy.js) | Graph-derived domain taxonomy and distance computation. |
| [`src/core/graph/graph.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/graph.js) | Graph implementation. |
| [`src/core/graph/idea-catalyst-packets.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/idea-catalyst-packets.js) | Idea Catalyst Packets implementation. |
| [`src/core/graph/interdisciplinary-potential.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/interdisciplinary-potential.js) | Interdisciplinary Potential implementation. |
| [`src/core/graph/interdisciplinary-ranking.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/interdisciplinary-ranking.js) | Explainable interdisciplinary potential ranking. |
| [`src/core/graph/lite.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/lite.js) | Lite implementation. |
| [`src/core/graph/merge-similar.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/merge-similar.js) | Merge Similar implementation. |
| [`src/core/graph/method-evolution-benchmark.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/method-evolution-benchmark.js) | Method Evolution Benchmark implementation. |
| [`src/core/graph/mutations.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/mutations.js) | Mutations implementation. |
| [`src/core/graph/research-intelligence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/research-intelligence.js) | Research Intelligence implementation. |
| [`src/core/graph/research-questions.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/research-questions.js) | Research question normalization and graph projection helpers. |
| [`src/core/graph/rules.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/rules.js) | Rules implementation. |
| [`src/core/graph/schema.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/schema.js) | Schema implementation. |
| [`src/core/graph/summary.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/summary.js) | Summary implementation. |
| [`src/core/graph/takeaway-extraction.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/takeaway-extraction.js) | Takeaway Extraction implementation. |
| [`src/core/graph/takeaways.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/takeaways.js) | Graph-native Takeaway and IdeaFragment normalization helpers. |
| [`src/core/imports/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/imports/worker.js) | Asynchronous upload/import queue worker. |
| [`src/core/ingestion/graph-postprocess.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/graph-postprocess.js) | Graph Postprocess implementation. |
| [`src/core/ingestion/graph-precompute.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/graph-precompute.js) | Graph Precompute implementation. |
| [`src/core/ingestion/identifier-resolution.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/identifier-resolution.js) | Identifier Resolution implementation. |
| [`src/core/ingestion/markdown.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/markdown.js) | Markdown implementation. |
| [`src/core/ingestion/method-evolution-overlay.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/method-evolution-overlay.js) | Method Evolution Overlay implementation. |
| [`src/core/ingestion/method-evolution-validator.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/method-evolution-validator.js) | Method Evolution Validator implementation. |
| [`src/core/ingestion/pdf-parser.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/pdf-parser.js) | PDF-to-markdown parser integration layer for MarkItDown, Docling, Marker, MinerU, and related helpers. |
| [`src/core/ingestion/pipeline.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/pipeline.js) | Main staged build pipeline from sources to graph commit. |
| [`src/core/llm/ollama.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/ollama.js) | Ollama implementation. |
| [`src/core/llm/prompts/research-relations-v1.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/prompts/research-relations-v1.js) | Research Relations V1 implementation. |
| [`src/core/llm/prompts/semantic-objects-v2.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/prompts/semantic-objects-v2.js) | Semantic Objects V2 implementation. |
| [`src/core/search/brainstorm-communities.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/search/brainstorm-communities.js) | Brainstorm Communities implementation. |
| [`src/core/search/search.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/search/search.js) | Query, context, impact, idea, and brainstorming retrieval logic. |

## Web

| File | Responsibility |
| --- | --- |
| [`web/app.js`](https://github.com/papernexus/PaperNexus/blob/main/web/app.js) | Single-page browser UI client logic. |
| [`web/index.html`](https://github.com/papernexus/PaperNexus/blob/main/web/index.html) | Index implementation. |
| [`web/styles.css`](https://github.com/papernexus/PaperNexus/blob/main/web/styles.css) | Dashboard styling. |
