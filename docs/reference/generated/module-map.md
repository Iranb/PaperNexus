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
| [`src/mcp/tool-agent-materials.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tool-agent-materials.js) | Handler for the Agent-facing material backend MCP tool. |
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
| [`src/storage/chunk-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/chunk-store.js) | Chunk Store implementation. |
| [`src/storage/corpus-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/corpus-store.js) | Persistent corpus graph, meta, manifest, and mutation write path. |
| [`src/storage/enhancement-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/enhancement-store.js) | Persistent enhancement queue and overlay job state. |
| [`src/storage/import-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/import-store.js) | Queued import task persistence, logs, progress, and queue snapshots. |
| [`src/storage/kuzu-commit-receipt-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/kuzu-commit-receipt-store.js) | Kuzu Commit Receipt Store implementation. |
| [`src/storage/kuzu-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/kuzu-store.js) | Kuzu Store implementation. |
| [`src/storage/lite-view.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/lite-view.js) | Incremental lite-graph materialized view and token index maintenance. |
| [`src/storage/llm-rate-limit-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/llm-rate-limit-store.js) | LLM Rate Limit Store implementation. |
| [`src/storage/pdf-parse-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/pdf-parse-store.js) | Pdf Parse Store implementation. |
| [`src/storage/provenance-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/provenance-store.js) | Provenance Store implementation. |
| [`src/storage/registry-reconcile.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/registry-reconcile.js) | Registry Reconcile implementation. |
| [`src/storage/registry.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/registry.js) | Global registry of indexed corpora. |
| [`src/storage/run-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/run-store.js) | Run Store implementation. |
| [`src/storage/trace-store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/storage/trace-store.js) | Trace Store implementation. |

## Core

| File | Responsibility |
| --- | --- |
| [`src/core/authoritative-sync/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/authoritative-sync/worker.js) | Authoritative sync queue processor for full graph state. |
| [`src/core/benchmarks/retrieval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/benchmarks/retrieval.js) | Retrieval implementation. |
| [`src/core/benchmarks/task-evaluation.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/benchmarks/task-evaluation.js) | Task Evaluation implementation. |
| [`src/core/control/pipeline-invariants.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/control/pipeline-invariants.js) | Pipeline Invariants implementation. |
| [`src/core/discovery/browser-session-download.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/browser-session-download.js) | Browser Session Download implementation. |
| [`src/core/discovery/citation-expansion.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/citation-expansion.js) | Citation Expansion implementation. |
| [`src/core/discovery/download-manifest.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/download-manifest.js) | Download Manifest implementation. |
| [`src/core/discovery/entities.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/entities.js) | Entities implementation. |
| [`src/core/discovery/import-bridge.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/import-bridge.js) | Import Bridge implementation. |
| [`src/core/discovery/llm-query-planner.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/llm-query-planner.js) | LLM Query Planner implementation. |
| [`src/core/discovery/merge.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/merge.js) | Merge implementation. |
| [`src/core/discovery/providers.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/providers.js) | Providers implementation. |
| [`src/core/discovery/query-planner.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/query-planner.js) | Query Planner implementation. |
| [`src/core/discovery/request-scheduler.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/request-scheduler.js) | Request Scheduler implementation. |
| [`src/core/discovery/s2-rate-limit.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/s2-rate-limit.js) | S2 Rate Limit implementation. |
| [`src/core/discovery/semantic-scholar-snippets.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/semantic-scholar-snippets.js) | Semantic Scholar Snippets implementation. |
| [`src/core/discovery/source-resolution.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/source-resolution.js) | Source Resolution implementation. |
| [`src/core/discovery/store.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/store.js) | Store implementation. |
| [`src/core/discovery/venue-registry.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/venue-registry.js) | Venue Registry implementation. |
| [`src/core/discovery/workflow.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/discovery/workflow.js) | Workflow implementation. |
| [`src/core/enhancements/extract.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/enhancements/extract.js) | Extract implementation. |
| [`src/core/enhancements/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/enhancements/worker.js) | Background enhancement worker and metadata backfill loop. |
| [`src/core/eval/ablation-runner.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/ablation-runner.js) | Ablation Runner implementation. |
| [`src/core/eval/docs-sync-release-evidence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/docs-sync-release-evidence.js) | Docs Sync Release Evidence implementation. |
| [`src/core/eval/engineering-release-evidence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/engineering-release-evidence.js) | Engineering Release Evidence implementation. |
| [`src/core/eval/graph-link-prediction-eval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/graph-link-prediction-eval.js) | Graph Link Prediction Eval implementation. |
| [`src/core/eval/graph-reasoning-report.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/graph-reasoning-report.js) | Graph Reasoning Report implementation. |
| [`src/core/eval/historical-replay.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/historical-replay.js) | Historical Replay implementation. |
| [`src/core/eval/human-blind-eval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/human-blind-eval.js) | Human Blind Eval implementation. |
| [`src/core/eval/innovation-sidecar-release-evidence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/innovation-sidecar-release-evidence.js) | Innovation Sidecar Release Evidence implementation. |
| [`src/core/eval/release-evidence-bundle.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/release-evidence-bundle.js) | Release Evidence Bundle implementation. |
| [`src/core/eval/release-gate-manifest.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/release-gate-manifest.js) | Release Gate Manifest implementation. |
| [`src/core/eval/replay-adapters.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/replay-adapters.js) | Replay Adapters implementation. |
| [`src/core/eval/replay-release-skeleton.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/replay-release-skeleton.js) | Replay Release Skeleton implementation. |
| [`src/core/eval/replay-suite.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/replay-suite.js) | Replay Suite implementation. |
| [`src/core/eval/scientific-embedding-release-evidence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/eval/scientific-embedding-release-evidence.js) | Scientific Embedding Release Evidence implementation. |
| [`src/core/graph/abstract-mechanisms.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/abstract-mechanisms.js) | Abstract Mechanisms implementation. |
| [`src/core/graph/analogy.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/analogy.js) | Structural analogy and motif matching over graph-native concepts. |
| [`src/core/graph/brainstorm-view.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/brainstorm-view.js) | Brainstorm View implementation. |
| [`src/core/graph/bridge-retrieval.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/bridge-retrieval.js) | Challenge-aware cross-domain bridge retrieval. |
| [`src/core/graph/catalyst-adapter.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/catalyst-adapter.js) | Idea-Catalyst graph adapter and higher-order ideation contract. |
| [`src/core/graph/challenges.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/challenges.js) | Challenge normalization and graph projection helpers. |
| [`src/core/graph/claim-linking.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/claim-linking.js) | Claim Linking implementation. |
| [`src/core/graph/counterfactual-search.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/counterfactual-search.js) | Counterfactual Search implementation. |
| [`src/core/graph/delta-commit.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/delta-commit.js) | Delta Commit implementation. |
| [`src/core/graph/diversity-selection.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/diversity-selection.js) | Diversity Selection implementation. |
| [`src/core/graph/domain-bridges.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/domain-bridges.js) | Cross-domain bridge construction, takeaways, and transferable edge enrichment. |
| [`src/core/graph/domain-taxonomy.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/domain-taxonomy.js) | Graph-derived domain taxonomy and distance computation. |
| [`src/core/graph/graph.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/graph.js) | Graph implementation. |
| [`src/core/graph/idea-catalyst-evidence-export.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/idea-catalyst-evidence-export.js) | Idea Catalyst Evidence Export implementation. |
| [`src/core/graph/idea-catalyst-live.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/idea-catalyst-live.js) | Idea Catalyst Live implementation. |
| [`src/core/graph/idea-catalyst-packets.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/idea-catalyst-packets.js) | Idea Catalyst Packets implementation. |
| [`src/core/graph/idea-scoring.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/idea-scoring.js) | Idea Scoring implementation. |
| [`src/core/graph/innovation-artifact-utils.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/innovation-artifact-utils.js) | Innovation Artifact Utils implementation. |
| [`src/core/graph/innovation-contracts.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/innovation-contracts.js) | Innovation Contracts implementation. |
| [`src/core/graph/innovation-writeback.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/innovation-writeback.js) | Innovation Writeback implementation. |
| [`src/core/graph/interdisciplinary-potential.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/interdisciplinary-potential.js) | Interdisciplinary Potential implementation. |
| [`src/core/graph/interdisciplinary-ranking.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/interdisciplinary-ranking.js) | Explainable interdisciplinary potential ranking. |
| [`src/core/graph/lite.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/lite.js) | Lite implementation. |
| [`src/core/graph/merge-similar.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/merge-similar.js) | Merge Similar implementation. |
| [`src/core/graph/method-evolution-benchmark.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/method-evolution-benchmark.js) | Method Evolution Benchmark implementation. |
| [`src/core/graph/model-assisted-innovation.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/model-assisted-innovation.js) | Model Assisted Innovation implementation. |
| [`src/core/graph/mutations.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/mutations.js) | Mutations implementation. |
| [`src/core/graph/novelty-scoring.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/novelty-scoring.js) | Novelty Scoring implementation. |
| [`src/core/graph/prior-art-contrast.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/prior-art-contrast.js) | Prior Art Contrast implementation. |
| [`src/core/graph/proposal-controller.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/proposal-controller.js) | Proposal Controller implementation. |
| [`src/core/graph/proposal-graph.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/proposal-graph.js) | Proposal Graph implementation. |
| [`src/core/graph/proposal-synthesis.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/proposal-synthesis.js) | Proposal Synthesis implementation. |
| [`src/core/graph/research-intelligence.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/research-intelligence.js) | Research Intelligence implementation. |
| [`src/core/graph/research-questions.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/research-questions.js) | Research question normalization and graph projection helpers. |
| [`src/core/graph/reviewer-simulation.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/reviewer-simulation.js) | Reviewer Simulation implementation. |
| [`src/core/graph/rules.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/rules.js) | Rules implementation. |
| [`src/core/graph/schema.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/schema.js) | Schema implementation. |
| [`src/core/graph/storyline-dag.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/storyline-dag.js) | Storyline Dag implementation. |
| [`src/core/graph/summary.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/summary.js) | Summary implementation. |
| [`src/core/graph/takeaway-extraction.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/takeaway-extraction.js) | Takeaway Extraction implementation. |
| [`src/core/graph/takeaways.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph/takeaways.js) | Graph-native Takeaway and IdeaFragment normalization helpers. |
| [`src/core/graph-v2/migration.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/graph-v2/migration.js) | Migration implementation. |
| [`src/core/imports/worker.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/imports/worker.js) | Asynchronous upload/import queue worker. |
| [`src/core/index/graph-link-prediction.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/index/graph-link-prediction.js) | Graph Link Prediction implementation. |
| [`src/core/index/scientific-embeddings.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/index/scientific-embeddings.js) | Scientific Embeddings implementation. |
| [`src/core/ingestion/citation-intent.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/citation-intent.js) | Citation Intent implementation. |
| [`src/core/ingestion/claim-extraction.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/claim-extraction.js) | Claim Extraction implementation. |
| [`src/core/ingestion/coci.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/coci.js) | Coci implementation. |
| [`src/core/ingestion/graph-mutation-executor.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/graph-mutation-executor.js) | Graph Mutation Executor implementation. |
| [`src/core/ingestion/graph-postprocess.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/graph-postprocess.js) | Graph Postprocess implementation. |
| [`src/core/ingestion/graph-precompute.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/graph-precompute.js) | Graph Precompute implementation. |
| [`src/core/ingestion/grobid-tei.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/grobid-tei.js) | Grobid Tei implementation. |
| [`src/core/ingestion/identifier-resolution.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/identifier-resolution.js) | Identifier Resolution implementation. |
| [`src/core/ingestion/markdown.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/markdown.js) | Markdown implementation. |
| [`src/core/ingestion/method-evolution-overlay.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/method-evolution-overlay.js) | Method Evolution Overlay implementation. |
| [`src/core/ingestion/method-evolution-validator.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/method-evolution-validator.js) | Method Evolution Validator implementation. |
| [`src/core/ingestion/parser-orchestrator.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/parser-orchestrator.js) | Parser Orchestrator implementation. |
| [`src/core/ingestion/pdf-parser.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/pdf-parser.js) | PDF-to-markdown parser integration layer for MarkItDown, Docling, Marker, MinerU, and related helpers. |
| [`src/core/ingestion/pipeline.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/pipeline.js) | Main staged build pipeline from sources to graph commit. |
| [`src/core/ingestion/s2orc.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/ingestion/s2orc.js) | S2orc implementation. |
| [`src/core/llm/ollama.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/ollama.js) | Ollama implementation. |
| [`src/core/llm/prompts/research-relations-v1.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/prompts/research-relations-v1.js) | Research Relations V1 implementation. |
| [`src/core/llm/prompts/semantic-objects-v2.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/llm/prompts/semantic-objects-v2.js) | Semantic Objects V2 implementation. |
| [`src/core/materials/agent-materials.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/materials/agent-materials.js) | Agent-facing material pack, paper material view, source discovery plan, and import requisition assembly. |
| [`src/core/materials/project-overlay.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/materials/project-overlay.js) | Project-level Agent overlay storage for paper roles, evidence carts, and workflow state. |
| [`src/core/materials/research-controller.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/materials/research-controller.js) | Research Controller implementation. |
| [`src/core/search/brainstorm-communities.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/search/brainstorm-communities.js) | Brainstorm Communities implementation. |
| [`src/core/search/search.js`](https://github.com/papernexus/PaperNexus/blob/main/src/core/search/search.js) | Query, context, impact, idea, and brainstorming retrieval logic. |

## Web

| File | Responsibility |
| --- | --- |
| [`web/app.js`](https://github.com/papernexus/PaperNexus/blob/main/web/app.js) | Single-page browser UI client logic. |
| [`web/index.html`](https://github.com/papernexus/PaperNexus/blob/main/web/index.html) | Index implementation. |
| [`web/styles.css`](https://github.com/papernexus/PaperNexus/blob/main/web/styles.css) | Dashboard styling. |
