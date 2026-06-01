# Scripts & SKILL Wrapper Reference

This page is generated from the top-level `scripts/` directory plus skill-local script wrappers under `SKILL/**/scripts`. Examples use placeholder corpus names, paper ids, and paths; replace them with values from your active PaperNexus server.

| Script | Purpose |
| --- | --- |
| [`SKILL/PaperNexus/scripts/pn_agent_materials.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_agent_materials.py) | Canonical skill wrapper for read-only Agent material packs and paper material views. |
| [`SKILL/PaperNexus/scripts/pn_batch_import.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_batch_import.py) | Canonical skill wrapper for manifest-based batch imports. |
| [`SKILL/PaperNexus/scripts/pn_common.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_common.py) | Pn Common implementation. |
| [`SKILL/PaperNexus/scripts/pn_corpus_refresh.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_corpus_refresh.py) | Skill wrapper for corpus-scale materialize, analyze, LLM optimize, and optimize refresh workflows. |
| [`SKILL/PaperNexus/scripts/pn_graph_query.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_graph_query.py) | Canonical skill wrapper for remote query, context, impact, ideas, and brainstorming. |
| [`SKILL/PaperNexus/scripts/pn_import_queue.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_import_queue.py) | Canonical skill wrapper for queue status, progress, logs, and wait operations. |
| [`SKILL/PaperNexus/scripts/pn_import_submit.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_import_submit.py) | Canonical skill wrapper for remote import submission. |
| [`SKILL/PaperNexus/scripts/pn_paper_index.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_paper_index.py) | Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id. |
| [`SKILL/PaperNexus/scripts/pn_research_chains.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_research_chains.py) | Canonical skill wrapper for evidence, reflection, and research brief retrieval. |
| [`SKILL/PaperNexus/scripts/pn_resilient_discovery.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_resilient_discovery.py) | Pn Resilient Discovery implementation. |
| [`SKILL/PaperNexus/scripts/pn_stage_sync.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexus/scripts/pn_stage_sync.py) | Canonical skill wrapper for staging local files to a remote PaperNexus server. |
| [`SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py) | Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows. |
| [`SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py) | Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup. |
| [`SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py) | Skill wrapper for submitting one local or staged paper into the remote import queue. |
| [`SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py) | Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval. |
| [`SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py) | Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path. |
| [`SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py) | Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows. |
| [`SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py) | Skill wrapper for corpus-scale materialize, analyze, LLM optimize, and optimize refresh workflows. |
| [`SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py) | Run one-shot cross-domain ideation through the remote MCP surface. |
| [`SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py) | Resolve the current live corpus name through remote HTTP MCP. |
| [`SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py) | Skill wrapper for force-refreshing one already-indexed paper or duplicate group. |
| [`SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py) | Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id. |
| [`SKILL/PaperNexusReflection/scripts/pn_batch_import.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusReflection/scripts/pn_batch_import.py) | Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows. |
| [`SKILL/PaperNexusReflection/scripts/pn_import_queue.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusReflection/scripts/pn_import_queue.py) | Skill wrapper for import queue list, status, log, and wait operations. |
| [`SKILL/PaperNexusReflection/scripts/pn_import_submit.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusReflection/scripts/pn_import_submit.py) | Skill wrapper for submitting one local or staged paper into the remote import queue. |
| [`SKILL/PaperNexusReflection/scripts/pn_research_chains.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusReflection/scripts/pn_research_chains.py) | Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval. |
| [`SKILL/PaperNexusReflection/scripts/pn_stage_sync.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusReflection/scripts/pn_stage_sync.py) | Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path. |
| [`SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py) | Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup. |
| [`SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py`](https://github.com/papernexus/PaperNexus/blob/main/SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py) | Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval. |
| [`scripts/apply-ingestion-graph-mutations.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/apply-ingestion-graph-mutations.mjs) | Apply Ingestion Graph Mutations implementation. |
| [`scripts/audit-graph-provenance.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/audit-graph-provenance.mjs) | Audit Graph Provenance implementation. |
| [`scripts/benchmark-graph-ranking-ablation.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/benchmark-graph-ranking-ablation.mjs) | Benchmark Graph Ranking Ablation implementation. |
| [`scripts/benchmark-graph-v2-delta.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/benchmark-graph-v2-delta.mjs) | Benchmark Graph V2 Delta implementation. |
| [`scripts/diagnose-graph-identity.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/diagnose-graph-identity.mjs) | Diagnose Graph Identity implementation. |
| [`scripts/docling_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/docling_to_markdown.py) | Docling To Markdown implementation. |
| [`scripts/evaluate-graph-link-prediction.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/evaluate-graph-link-prediction.mjs) | Evaluate Graph Link Prediction implementation. |
| [`scripts/generate-docs-reference.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/generate-docs-reference.mjs) | Generate VitePress reference pages from code, config, and repository structure. |
| [`scripts/generate-graph-ablation-artifact-contract.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/generate-graph-ablation-artifact-contract.mjs) | Generate Graph Ablation Artifact Contract implementation. |
| [`scripts/generate-graph-quality-report.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/generate-graph-quality-report.mjs) | Generate Graph Quality Report implementation. |
| [`scripts/generate-paper-claim-report.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/generate-paper-claim-report.mjs) | Generate Paper Claim Report implementation. |
| [`scripts/graph_manage/delete_and_rebuild_all.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/graph_manage/delete_and_rebuild_all.sh) | Delete And Rebuild All implementation. |
| [`scripts/graph_manage/delete_graph_index.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/graph_manage/delete_graph_index.sh) | Delete Graph Index implementation. |
| [`scripts/graph_manage/delete_graph_index_snapshot.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/graph_manage/delete_graph_index_snapshot.sh) | Delete Graph Index Snapshot implementation. |
| [`scripts/inspect-graph-ablation-candidates.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/inspect-graph-ablation-candidates.mjs) | Inspect Graph Ablation Candidates implementation. |
| [`scripts/install-service.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/install-service.sh) | Install platform-specific background services for watch and serve. |
| [`scripts/manage-service.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/manage-service.sh) | Inspect and control installed services on supported platforms. |
| [`scripts/markitdown_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/markitdown_to_markdown.py) | Standalone MarkItDown PDF-to-markdown bridge. |
| [`scripts/markpdfdown_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/markpdfdown_to_markdown.py) | Markpdfdown To Markdown implementation. |
| [`scripts/opendataloader_pdf_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/opendataloader_pdf_to_markdown.py) | Standalone OpenDataLoader PDF-to-markdown bridge. |
| [`scripts/paddleocr_vl_to_markdown.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/paddleocr_vl_to_markdown.py) | Standalone PaddleOCR-VL PDF-to-markdown bridge. |
| [`scripts/pm2-papernexus-serve.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pm2-papernexus-serve.sh) | Run the serve process under PM2 and inspect recent import-focused logs. |
| [`scripts/pn_batch_import.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_batch_import.py) | Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows. |
| [`scripts/pn_common.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_common.py) | Pn Common implementation. |
| [`scripts/pn_graph_query.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_graph_query.py) | Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup. |
| [`scripts/pn_import_queue.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_import_queue.py) | Skill wrapper for import queue list, status, log, and wait operations. |
| [`scripts/pn_import_submit.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_import_submit.py) | Skill wrapper for submitting one local or staged paper into the remote import queue. |
| [`scripts/pn_paper_index.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_paper_index.py) | Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id. |
| [`scripts/pn_research_chains.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_research_chains.py) | Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval. |
| [`scripts/pn_stage_sync.py`](https://github.com/papernexus/PaperNexus/blob/main/scripts/pn_stage_sync.py) | Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path. |
| [`scripts/prepare-aliyun-batch-inference.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-aliyun-batch-inference.mjs) | Prepare Aliyun Batch Inference implementation. |
| [`scripts/prepare-citation-intents.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-citation-intents.mjs) | Prepare Citation Intents implementation. |
| [`scripts/prepare-claim-extraction.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-claim-extraction.mjs) | Prepare Claim Extraction implementation. |
| [`scripts/prepare-coci-citation-graph.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-coci-citation-graph.mjs) | Prepare Coci Citation Graph implementation. |
| [`scripts/prepare-docs-sync-release-evidence.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-docs-sync-release-evidence.mjs) | Prepare Docs Sync Release Evidence implementation. |
| [`scripts/prepare-engineering-release-evidence.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-engineering-release-evidence.mjs) | Prepare Engineering Release Evidence implementation. |
| [`scripts/prepare-graph-ablation-artifact.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-graph-ablation-artifact.mjs) | Prepare Graph Ablation Artifact implementation. |
| [`scripts/prepare-graph-link-prediction.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-graph-link-prediction.mjs) | Prepare Graph Link Prediction implementation. |
| [`scripts/prepare-graph-reasoning-report.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-graph-reasoning-report.mjs) | Prepare Graph Reasoning Report implementation. |
| [`scripts/prepare-grobid-tei-citation-contexts.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-grobid-tei-citation-contexts.mjs) | Prepare Grobid Tei Citation Contexts implementation. |
| [`scripts/prepare-human-blind-eval.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-human-blind-eval.mjs) | Prepare Human Blind Eval implementation. |
| [`scripts/prepare-idea-catalyst-release-gate.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-idea-catalyst-release-gate.mjs) | Prepare Idea Catalyst Release Gate implementation. |
| [`scripts/prepare-idea-catalyst-replay-dataset.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-idea-catalyst-replay-dataset.mjs) | Prepare Idea Catalyst Replay Dataset implementation. |
| [`scripts/prepare-innovation-sidecar-release-evidence.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-innovation-sidecar-release-evidence.mjs) | Prepare Innovation Sidecar Release Evidence implementation. |
| [`scripts/prepare-innovation-writeback.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-innovation-writeback.mjs) | Prepare Innovation Writeback implementation. |
| [`scripts/prepare-release-evidence-bundle.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-release-evidence-bundle.mjs) | Prepare Release Evidence Bundle implementation. |
| [`scripts/prepare-replay-release-evidence-skeleton.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-replay-release-evidence-skeleton.mjs) | Prepare Replay Release Evidence Skeleton implementation. |
| [`scripts/prepare-s2orc-citation-contexts.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-s2orc-citation-contexts.mjs) | Prepare S2orc Citation Contexts implementation. |
| [`scripts/prepare-scientific-embedding-release-evidence.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-scientific-embedding-release-evidence.mjs) | Prepare Scientific Embedding Release Evidence implementation. |
| [`scripts/prepare-scientific-embeddings.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/prepare-scientific-embeddings.mjs) | Prepare Scientific Embeddings implementation. |
| [`scripts/reinstall.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/reinstall.sh) | Reinstall implementation. |
| [`scripts/run-engineering-control-acceptance.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-engineering-control-acceptance.mjs) | Run Engineering Control Acceptance implementation. |
| [`scripts/run-fixed-corpus-retrieval-suite.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-fixed-corpus-retrieval-suite.mjs) | Run Fixed Corpus Retrieval Suite implementation. |
| [`scripts/run-graph-ablation-paper-claim-pipeline.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-graph-ablation-paper-claim-pipeline.mjs) | Run Graph Ablation Paper Claim Pipeline implementation. |
| [`scripts/run-idea-catalyst-ablation-suite.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-idea-catalyst-ablation-suite.mjs) | Run Idea Catalyst Ablation Suite implementation. |
| [`scripts/run-idea-catalyst-historical-replay.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-idea-catalyst-historical-replay.mjs) | Run Idea Catalyst Historical Replay implementation. |
| [`scripts/run-idea-catalyst-replay-suite.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-idea-catalyst-replay-suite.mjs) | Run Idea Catalyst Replay Suite implementation. |
| [`scripts/run-ingestion-orchestrator.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-ingestion-orchestrator.mjs) | Run Ingestion Orchestrator implementation. |
| [`scripts/run-litsearch-retrieval-pipeline.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-litsearch-retrieval-pipeline.mjs) | Run Litsearch Retrieval Pipeline implementation. |
| [`scripts/run-small-public-benchmarks.sh`](https://github.com/papernexus/PaperNexus/blob/main/scripts/run-small-public-benchmarks.sh) | Run Small Public Benchmarks implementation. |
| [`scripts/summarize-benchmark-runs.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/summarize-benchmark-runs.mjs) | Summarize Benchmark Runs implementation. |
| [`scripts/sweep-fixed-corpus-scan-limit.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/sweep-fixed-corpus-scan-limit.mjs) | Sweep Fixed Corpus Scan Limit implementation. |
| [`scripts/sweep-identity-normalization.mjs`](https://github.com/papernexus/PaperNexus/blob/main/scripts/sweep-identity-normalization.mjs) | Sweep Identity Normalization implementation. |
| [`scripts/test-pdf-to-markdown.js`](https://github.com/papernexus/PaperNexus/blob/main/scripts/test-pdf-to-markdown.js) | Test Pdf To Markdown implementation. |

## Skill Wrapper Examples

### SKILL/PaperNexus/scripts/pn_agent_materials.py

Canonical skill wrapper for read-only Agent material packs and paper material views.

```bash
python3 SKILL/PaperNexus/scripts/pn_agent_materials.py --corpus "<corpus>" research-material-pack --project "<project>" --target-domain "medical imaging" --target-problem "domain-shifted semi-supervised segmentation" --limit 6
```

```bash
python3 SKILL/PaperNexus/scripts/pn_agent_materials.py --corpus "<corpus>" paper-material-view --doi "10.48550/arXiv.2401.12345" --chunk-limit 8
```

```bash
python3 SKILL/PaperNexus/scripts/pn_agent_materials.py --corpus "<corpus>" workflow-state --project "<project>" --action update --current-stage "evidence_expansion"
```

### SKILL/PaperNexus/scripts/pn_batch_import.py

Canonical skill wrapper for manifest-based batch imports.

```bash
python3 SKILL/PaperNexus/scripts/pn_batch_import.py template > /absolute/path/batch-import.json
```

```bash
python3 SKILL/PaperNexus/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" submit
```

```bash
python3 SKILL/PaperNexus/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status
```

### SKILL/PaperNexus/scripts/pn_corpus_refresh.py

Skill wrapper for corpus-scale materialize, analyze, LLM optimize, and optimize refresh workflows.

```bash
python3 SKILL/PaperNexus/scripts/pn_corpus_refresh.py --corpus "<corpus>" --mode llm_optimize --semantic-extraction llm-assisted --llm-batch-size 16
```

```bash
python3 SKILL/PaperNexus/scripts/pn_corpus_refresh.py --corpus "<corpus>" --mode optimize --changed-source-key "<sourceKey>" --batch-size 16 --json
```

### SKILL/PaperNexus/scripts/pn_graph_query.py

Canonical skill wrapper for remote query, context, impact, ideas, and brainstorming.

```bash
python3 SKILL/PaperNexus/scripts/pn_graph_query.py --corpus "<corpus>" query "open-world semi-supervised learning" --limit 8
```

```bash
python3 SKILL/PaperNexus/scripts/pn_graph_query.py --corpus "<corpus>" context "Office-Home dataset" --layers EvaluationLayer --layer-mode any
```

```bash
python3 SKILL/PaperNexus/scripts/pn_graph_query.py --corpus "<corpus>" brainstorm "domain-shifted semi-supervised learning" --mode converge --limit 6
```

### SKILL/PaperNexus/scripts/pn_import_queue.py

Canonical skill wrapper for queue status, progress, logs, and wait operations.

```bash
python3 SKILL/PaperNexus/scripts/pn_import_queue.py --corpus "<corpus>" list --limit 20
```

```bash
python3 SKILL/PaperNexus/scripts/pn_import_queue.py --corpus "<corpus>" status --paper-id "<paperId>"
```

```bash
python3 SKILL/PaperNexus/scripts/pn_import_queue.py --corpus "<corpus>" wait --paper-id "<paperId>" --timeout 1800 --interval 15
```

### SKILL/PaperNexus/scripts/pn_import_submit.py

Canonical skill wrapper for remote import submission.

```bash
python3 SKILL/PaperNexus/scripts/pn_import_submit.py --corpus "<corpus>" --source "/absolute/path/paper.pdf" --doi "10.48550/arXiv.2401.12345"
```

```bash
python3 SKILL/PaperNexus/scripts/pn_import_submit.py --corpus "<corpus>" --server-file-path "~/papernexus-import-staging/paper.pdf" --source-provider manual --json
```

### SKILL/PaperNexus/scripts/pn_paper_index.py

Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id.

```bash
python3 SKILL/PaperNexus/scripts/pn_paper_index.py --corpus "<corpus>" --doi "10.48550/arXiv.2401.12345"
```

```bash
python3 SKILL/PaperNexus/scripts/pn_paper_index.py --corpus "<corpus>" --source-key "<sourceKey>" --json
```

```bash
python3 SKILL/PaperNexus/scripts/pn_paper_index.py --corpus "<corpus>" --paper-title "Example Paper Title"
```

### SKILL/PaperNexus/scripts/pn_research_chains.py

Canonical skill wrapper for evidence, reflection, and research brief retrieval.

```bash
python3 SKILL/PaperNexus/scripts/pn_research_chains.py --corpus "<corpus>" evidence-chain "open-set domain adaptation" --limit 5
```

```bash
python3 SKILL/PaperNexus/scripts/pn_research_chains.py --corpus "<corpus>" reflection-chain "failed pseudo-labeling assumptions" --limit 5
```

```bash
python3 SKILL/PaperNexus/scripts/pn_research_chains.py --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```

### SKILL/PaperNexus/scripts/pn_stage_sync.py

Canonical skill wrapper for staging local files to a remote PaperNexus server.

```bash
python3 SKILL/PaperNexus/scripts/pn_stage_sync.py --corpus "<corpus>" --ssh-target "<user@server>" --remote-dir "~/papernexus-import-staging" "/absolute/path/paper.pdf"
```

```bash
python3 SKILL/PaperNexus/scripts/pn_stage_sync.py --corpus "<corpus>" --mode incremental "/absolute/path/paper-folder" --json
```

### SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py

Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows.

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py template > /absolute/path/batch-import.json
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" submit
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status
```

### SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py

Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup.

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --corpus "<corpus>" query "open-world semi-supervised learning" --limit 8
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --corpus "<corpus>" context "Office-Home dataset" --layers EvaluationLayer --layer-mode any
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_graph_query.py --corpus "<corpus>" brainstorm "domain-shifted semi-supervised learning" --mode converge --limit 6
```

### SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py

Skill wrapper for submitting one local or staged paper into the remote import queue.

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py --corpus "<corpus>" --source "/absolute/path/paper.pdf" --doi "10.48550/arXiv.2401.12345"
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_import_submit.py --corpus "<corpus>" --server-file-path "~/papernexus-import-staging/paper.pdf" --source-provider manual --json
```

### SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py

Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval.

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --corpus "<corpus>" evidence-chain "open-set domain adaptation" --limit 5
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --corpus "<corpus>" reflection-chain "failed pseudo-labeling assumptions" --limit 5
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_research_chains.py --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```

### SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py

Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path.

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py --corpus "<corpus>" --ssh-target "<user@server>" --remote-dir "~/papernexus-import-staging" "/absolute/path/paper.pdf"
```

```bash
python3 SKILL/PaperNexusAgenticReasoning/scripts/pn_stage_sync.py --corpus "<corpus>" --mode incremental "/absolute/path/paper-folder" --json
```

### SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py

Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows.

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py template > /absolute/path/batch-import.json
```

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" submit
```

```bash
python3 SKILL/PaperNexusBatchImport/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status
```

### SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py

Skill wrapper for corpus-scale materialize, analyze, LLM optimize, and optimize refresh workflows.

```bash
python3 SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py --corpus "<corpus>" --mode llm_optimize --semantic-extraction llm-assisted --llm-batch-size 16
```

```bash
python3 SKILL/PaperNexusCorpusRefresh/scripts/pn_corpus_refresh.py --corpus "<corpus>" --mode optimize --changed-source-key "<sourceKey>" --batch-size 16 --json
```

### SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py

Run one-shot cross-domain ideation through the remote MCP surface.

```bash
python3 SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py --corpus "<corpus>" --problem "open-world semi-supervised learning under domain shift" --target-domain "medical imaging" --mode graph --limit 8
```

```bash
python3 SKILL/PaperNexusIdeaCatalyst/scripts/pn_idea_catalyst.py --corpus "<corpus>" --problem "uncertainty-aware pseudo-labeling" --target-domain "robot learning" --mode hybrid --output-mode packet_bundle --include-analysis
```

### SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py

Resolve the current live corpus name through remote HTTP MCP.

```bash
python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py --json
```

```bash
python3 SKILL/PaperNexusMainGraphName/scripts/pn_main_graph_name.py --corpus "<fallback-corpus>"
```

### SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py

Skill wrapper for force-refreshing one already-indexed paper or duplicate group.

```bash
python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py --corpus "<corpus>" --paper-id "<paperId>" --semantic-extraction llm-assisted
```

```bash
python3 SKILL/PaperNexusPaperRefresh/scripts/pn_paper_refresh.py --corpus "<corpus>" --paper-title "Example Paper Title" --no-rebuild-pdf-markdown
```

### SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py

Skill wrapper for precise paper lookup by DOI, arXiv ID, source key, title, or canonical id.

```bash
python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py --corpus "<corpus>" --doi "10.48550/arXiv.2401.12345"
```

```bash
python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py --corpus "<corpus>" --source-key "<sourceKey>" --json
```

```bash
python3 SKILL/PaperNexusPrecisePaperIndex/scripts/pn_paper_index.py --corpus "<corpus>" --paper-title "Example Paper Title"
```

### SKILL/PaperNexusReflection/scripts/pn_batch_import.py

Skill wrapper for manifest-based multi-paper import submission, status, and wait workflows.

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py template > /absolute/path/batch-import.json
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" submit
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_batch_import.py --corpus "<corpus>" --manifest "/absolute/path/batch-import.json" status
```

### SKILL/PaperNexusReflection/scripts/pn_import_queue.py

Skill wrapper for import queue list, status, log, and wait operations.

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --corpus "<corpus>" list --limit 20
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --corpus "<corpus>" status --paper-id "<paperId>"
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_queue.py --corpus "<corpus>" wait --paper-id "<paperId>" --timeout 1800 --interval 15
```

### SKILL/PaperNexusReflection/scripts/pn_import_submit.py

Skill wrapper for submitting one local or staged paper into the remote import queue.

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --corpus "<corpus>" --source "/absolute/path/paper.pdf" --doi "10.48550/arXiv.2401.12345"
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_import_submit.py --corpus "<corpus>" --server-file-path "~/papernexus-import-staging/paper.pdf" --source-provider manual --json
```

### SKILL/PaperNexusReflection/scripts/pn_research_chains.py

Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval.

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --corpus "<corpus>" evidence-chain "open-set domain adaptation" --limit 5
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --corpus "<corpus>" reflection-chain "failed pseudo-labeling assumptions" --limit 5
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_research_chains.py --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```

### SKILL/PaperNexusReflection/scripts/pn_stage_sync.py

Skill wrapper for syncing local PDFs or Markdown files to a server-visible staging path.

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_stage_sync.py --corpus "<corpus>" --ssh-target "<user@server>" --remote-dir "~/papernexus-import-staging" "/absolute/path/paper.pdf"
```

```bash
python3 SKILL/PaperNexusReflection/scripts/pn_stage_sync.py --corpus "<corpus>" --mode incremental "/absolute/path/paper-folder" --json
```

### SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py

Skill wrapper for graph query, context, impact, ideas, and brainstorm lookup.

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py --corpus "<corpus>" query "open-world semi-supervised learning" --limit 8
```

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py --corpus "<corpus>" context "Office-Home dataset" --layers EvaluationLayer --layer-mode any
```

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_graph_query.py --corpus "<corpus>" brainstorm "domain-shifted semi-supervised learning" --mode converge --limit 6
```

### SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py

Skill wrapper for path traces, evidence chains, reflection chains, and brief retrieval.

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --corpus "<corpus>" evidence-chain "open-set domain adaptation" --limit 5
```

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --corpus "<corpus>" reflection-chain "failed pseudo-labeling assumptions" --limit 5
```

```bash
python3 SKILL/PaperNexusResearchChains/scripts/pn_research_chains.py --corpus "<corpus>" paper-enhancement --paper-id "<paperId>"
```
