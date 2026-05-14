# MCP Tool Reference

This page is generated from [`src/mcp/tools.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tools.js). It documents the public MCP surface that remote and local clients should rely on.

## Tool Index

| Tool | Description |
| --- | --- |
| [`list_corpora`](#tool-list_corpora) | List all locally indexed academic-paper corpora available to PaperNexus. |
| [`corpus_status`](#tool-corpus_status) | Show corpus stats and top research problems for a specific corpus. |
| [`corpus_sources`](#tool-corpus_sources) | Return source manifest entries plus per-paper graph-index and source-span provenance so remote clients can reconcile which papers are materialized in the graph. |
| [`query`](#tool-query) | Search already committed research knowledge-graph state for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. Use literature_discovery for fresh keyword/topic discovery before papers are ingested. |
| [`context`](#tool-context) | Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node. |
| [`impact`](#tool-impact) | Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks. |
| [`ideas`](#tool-ideas) | Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph. |
| [`brainstorm`](#tool-brainstorm) | Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions. |
| [`domain_distance`](#tool-domain_distance) | Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain. |
| [`extract_takeaways`](#tool-extract_takeaways) | Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges. |
| [`interdisciplinary_potential`](#tool-interdisciplinary_potential) | Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways. |
| [`research_lookup`](#tool-research_lookup) | Run high-level lookup operations over already committed graph state using one remote HTTP MCP surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, interdisciplinary potential, and method atlas lookups. Use literature_discovery first for fresh keyword literature search; graph lookup only sees imported papers after import tasks reach status=completed and stage=completed. |
| [`research_briefing`](#tool-research_briefing) | Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface. |
| [`import_workflow`](#tool-import_workflow) | Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to logical batching with imports.batchEnabled=true and batchMaxTasks=4 unless server config explicitly disables or overrides it. |
| [`literature_discovery`](#tool-literature_discovery) | Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to logical batching with importBatchEnabled=true and importBatchMaxTasks=4. |
| [`idea_catalyst`](#tool-idea_catalyst) | Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle. |
| [`mutate_graph`](#tool-mutate_graph) | Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk. |
| [`refresh_corpus`](#tool-refresh_corpus) | Run corpus-scale maintenance over an indexed corpus: incremental/full analyze, Stage 1 snapshot materialization, Stage 2 batch LLM optimization, or Stage 2-5 optimize from cached snapshots. |
| [`refresh_paper_graph`](#tool-refresh_paper_graph) | Force-refresh the graph content for one paper or one canonical duplicate group without rebuilding the whole corpus. |

## Tool: list_corpora

<a id="tool-list_corpora"></a>

List all locally indexed academic-paper corpora available to PaperNexus.

### Input Schema

This tool takes no arguments.

## Tool: corpus_status

<a id="tool-corpus_status"></a>

Show corpus stats and top research problems for a specific corpus.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |

## Tool: corpus_sources

<a id="tool-corpus_sources"></a>

Return source manifest entries plus per-paper graph-index and source-span provenance so remote clients can reconcile which papers are materialized in the graph.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |

## Tool: query

<a id="tool-query"></a>

Search already committed research knowledge-graph state for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. Use literature_discovery for fresh keyword/topic discovery before papers are ingested.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Natural-language or keyword query. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `limit` | optional | number | Maximum number of grouped semantic result buckets to return. |
| `layers` | optional | string | Optional comma-separated layer filter, for example ProblemLayer,MethodLayer. |

## Tool: context

<a id="tool-context"></a>

Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Node name or exact node id. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `layers` | optional | string | Optional comma-separated layer filter. |
| `layerMode` | optional | string (any, intra, cross) | Restrict context edges to any, intra-layer, or cross-layer edges. |

## Tool: impact

<a id="tool-impact"></a>

Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Node name or exact node id. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `direction` | optional | string (upstream, downstream) | Traverse incoming or outgoing edges. |
| `maxDepth` | optional | number | Traversal depth. |
| `layers` | optional | string | Optional comma-separated layer filter. |
| `layerMode` | optional | string (any, intra, cross) | Restrict impact traversal to any, intra-layer, or cross-layer edges. |

## Tool: ideas

<a id="tool-ideas"></a>

Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Target research topic or problem statement. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `limit` | optional | number | Maximum number of research opportunities to return. |
| `layers` | optional | string | Optional comma-separated layer filter. |

## Tool: brainstorm

<a id="tool-brainstorm"></a>

Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Target topic, problem statement, or research question. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `mode` | optional | string (diverge, converge) | Use diverge to expand the search space or converge to rank candidate directions. |
| `maxHops` | optional | number | Maximum traversal hops for brainstorming expansion. |
| `limit` | optional | number | Maximum number of converged directions or idea candidates. |
| `layers` | optional | string | Optional comma-separated layer filter, for example ProblemLayer,MethodLayer,ConstraintLayer. |
| `layerMode` | optional | string (any, intra, cross) | Restrict brainstorming to any, intra-layer, or cross-layer edges. |

## Tool: domain_distance

<a id="tool-domain_distance"></a>

Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | optional | string | Optional domain name to return ranked distances from. |

## Tool: extract_takeaways

<a id="tool-extract_takeaways"></a>

Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | required | string | The target research domain. |
| `agnosticChallenges` | required | array | Domain-agnostic challenge formulations to retrieve takeaways for. |
| `limit` | optional | number |  |
| `minDomainDistance` | optional | number |  |

## Tool: interdisciplinary_potential

<a id="tool-interdisciplinary_potential"></a>

Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | required | string | The target research domain. |
| `query` | required | string | Research problem statement or target challenge. |
| `agnosticChallenges` | optional | array | Optional domain-agnostic challenge formulations. |
| `excludeProximalDomains` | optional | boolean |  |
| `limit` | optional | number |  |

## Tool: research_lookup

<a id="tool-research_lookup"></a>

Run high-level lookup operations over already committed graph state using one remote HTTP MCP surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, interdisciplinary potential, and method atlas lookups. Use literature_discovery first for fresh keyword literature search; graph lookup only sees imported papers after import tasks reach status=completed and stage=completed.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (query, context, impact, ideas, brainstorm, paper_index, domain_distance, extract_takeaways, interdisciplinary_potential, cross_domain_evidence, method_lineage, method_evidence, method_registry, research_answer) |  |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `query` | optional | string | Topic, node anchor, or challenge text used by the selected lookup operation. |
| `paperId` | optional | string | Exact internal paper id used by the paper_index operation. |
| `canonicalId` | optional | string | Exact canonical paper identity key such as arxiv:..., doi:..., pmid:..., pmcid:..., or title:... |
| `sourceId` | optional | string | Exact source artifact identity key. |
| `sourceKey` | optional | string | Exact manifest sourceKey used by the paper_index operation. |
| `source` | optional | string | Exact source/input path used by the paper_index operation. |
| `paperTitle` | optional | string | Exact normalized paper title used by the paper_index operation. |
| `identifier` | optional | string | Generic identifier string used by the paper_index operation. |
| `identifierType` | optional | string (doi, arxivId, pmid, pmcid, isbn, issn) | Optional explicit identifier type used with `identifier` for paper_index. |
| `doi` | optional | string | Exact DOI used by the paper_index operation. |
| `arxivId` | optional | string | Exact arXiv ID used by the paper_index operation. |
| `pmid` | optional | string | Exact PMID used by the paper_index operation. |
| `pmcid` | optional | string | Exact PMCID used by the paper_index operation. |
| `isbn` | optional | string | Exact ISBN used by the paper_index operation. |
| `issn` | optional | string | Exact ISSN used by the paper_index operation. |
| `identifiers` | optional | object | Structured identifier block used by the paper_index operation. |
| `targetDomain` | optional | string | Target domain used by domain-distance and interdisciplinary operations. |
| `mechanisms` | optional | string \| array | Optional mechanism filters for cross_domain_evidence and research_answer. |
| `method` | optional | string | Method name, alias, or Method node id used by method_lineage, method_evidence, and research_answer. |
| `methodName` | optional | string | Alternative method selector used by method_lineage, method_evidence, and research_answer. |
| `sourceMethod` | optional | string | Source/newer method selector used by method_evidence pair lookup. |
| `targetMethod` | optional | string | Target/predecessor or paired method selector used by method_evidence pair lookup. |
| `edgeId` | optional | string | Exact method evolution relationship id used by method_evidence. |
| `relationshipId` | optional | string | Alternative relationship id used by method_evidence. |
| `citationRelationshipId` | optional | string | Citation relationship id used to resolve a projected method DAG edge in method_evidence. |
| `candidateId` | optional | string | Method evolution candidate id used by method_evidence. |
| `includeCandidates` | optional | boolean | Include candidate or rejected method evidence edges in method_evidence output. |
| `strictDirection` | optional | boolean | Require sourceMethod -&gt; targetMethod ordering for method_evidence pair lookup. |
| `mode` | optional | string (cross_domain_evidence, method_lineage, both) | Answer mode used by research_answer. |
| `direction` | optional | string (backward, forward, both) | Lineage traversal direction for method_lineage. |
| `maxDepth` | optional | number | Maximum method lineage traversal depth. |
| `numSourceDomains` | optional | number | Maximum source domains considered by cross_domain_evidence. |
| `relevanceThreshold` | optional | number | Evidence threshold used by cross_domain_evidence. |
| `includePacketBundle` | optional | boolean | Include the raw catalyst packet bundle in cross_domain_evidence output. |
| `agnosticChallenges` | optional | array |  |
| `excludeProximalDomains` | optional | boolean |  |
| `limit` | optional | number |  |
| `minDomainDistance` | optional | number |  |
| `options` | optional | object | Operation-specific options such as limit, layers, layerMode, mode, maxDepth, or maxHops. |

## Tool: research_briefing

<a id="tool-research_briefing"></a>

Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (path_trace, evidence_chain, reflection_chain, paper_enhancement, theory_brief, storyline_brief, research_brief, brainstorm_brief) |  |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `query` | optional | string | Query text for chain or brief retrieval. |
| `from` | optional | string | Starting anchor for path-trace. |
| `to` | optional | string | Ending anchor for path-trace. |
| `paperId` | optional | string | Paper id for paper-enhancement retrieval. |
| `options` | optional | object | Operation-specific options such as limit, layers, maxDepth, maxPaths, direction, or mode. |

## Tool: import_workflow

<a id="tool-import_workflow"></a>

Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to logical batching with imports.batchEnabled=true and batchMaxTasks=4 unless server config explicitly disables or overrides it.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (submit, list, status, progress, queue_progress, log, wait) | Use queue_progress/status/wait to track graph-build latency after import submission. wait blocks until terminal state or timeout. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `taskId` | optional | string | Import task id for status, log, or wait. |
| `paperId` | optional | string | Optional paper id used to resolve a task when taskId is omitted. |
| `source` | optional | string | Optional source path used to resolve a task when taskId is omitted. |
| `serverFilePath` | optional | string | Absolute file path on the PaperNexus server for submit. |
| `identifiers` | optional | object | Per-paper identifier block for submit, containing one or more of DOI, arXiv ID, PMID, PMCID, ISBN, or ISSN. |
| `doi` | optional | string | DOI for a single-paper submit request. |
| `arxivId` | optional | string | arXiv ID for a single-paper submit request. |
| `pmid` | optional | string | PMID for a single-paper submit request. |
| `pmcid` | optional | string | PMCID for a single-paper submit request. |
| `isbn` | optional | string | ISBN for a single-paper submit request. |
| `issn` | optional | string | ISSN for a single-paper submit request. |
| `sourceProvider` | optional | string | Optional source provider/origin label used to build sourceId. |
| `files` | optional | array |  |
| `trigger` | optional | string |  |
| `limit` | optional | number |  |
| `taskIds` | optional | array | Optional task ids used to filter queue_progress snapshots. |
| `timeout` | optional | number | Maximum seconds to wait for completion when operation is wait. By default this also includes the downstream authoritative graph sync job for completed imports. |
| `interval` | optional | number | Polling interval in seconds when operation is wait. |
| `waitForAuthoritativeSync` | optional | boolean | When operation is wait, keep waiting after the import task completes until its authoritative graph sync job is completed, failed, or superseded. Defaults to true. |

## Tool: literature_discovery

<a id="tool-literature_discovery"></a>

Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to logical batching with importBatchEnabled=true and importBatchMaxTasks=4.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (plan, search, resolve, run, import, ingest, import_and_process, supplement, status, report, list) | plan/search/run/resolve produce discovery artifacts and do not by themselves make papers graph-visible. import submits resolved full text to the import queue. ingest/import_and_process also process imports inline, but graph visibility still depends on completed import tasks. status/report/list inspect persisted discovery runs. |
| `corpus` | optional | string | Corpus name or indexed root path. Required except for plan. |
| `topic` | optional | string | Research topic, question, related-work paragraph, seed concept, or paper title. |
| `query` | optional | string | Alias for topic. |
| `seedPapers` | optional | array | Client-supplied seed papers. PaperNexus treats these as remote discovery/source-resolution inputs and may query by seed title or identifiers before import. |
| `entitySeeds` | optional | array | Client-supplied research entities extracted from seed papers, such as datasets, benchmarks, metrics, tasks, or methods. They are used as additional discovery queries, not imported as papers. |
| `datasetSeeds` | optional | array | Alias for dataset-oriented entity seeds discovered in seed PDFs or source indexes. |
| `benchmarkSeeds` | optional | array | Alias for benchmark-oriented entity seeds discovered in seed PDFs or source indexes. |
| `seedTexts` | optional | array | Plain text or markdown extracted from seed papers. PaperNexus extracts dataset, benchmark, metric, task, and similar research entities and uses them as additional discovery queries. |
| `maxSeedPapers` | optional | number | Maximum client-supplied seed papers accepted into the discovery candidate set. |
| `maxSeedQueries` | optional | number | Maximum seed-title/identifier queries added to the provider plan. |
| `maxSeedEntities` | optional | number | Maximum client-supplied research entities accepted into the discovery query set. |
| `maxExtractedEntities` | optional | number | Maximum research entities extracted from supplied seed text or source index text. |
| `maxEntityQueries` | optional | number | Maximum dataset/benchmark/entity queries added to the provider plan. |
| `depth` | optional | string (quick, default, deep) |  |
| `discipline` | optional | string | Optional discipline hint such as computer-science, biomedicine, physics-math, chemistry-materials, economics-social-science, humanities-law, or chinese-scholarship. |
| `providers` | optional | string \| array | Provider allow-list. Default providers are openalex, semantic_scholar, crossref, and arxiv. Implemented opt-in providers include papers_cool, pasa, europe_pmc, pubmed, dblp, and core; unpaywall is used during source resolution. |
| `maxQueries` | optional | number | Maximum query families to execute after LLM planning and deterministic fallback expansion. |
| `llmQueryPlanner` | optional | boolean | Use the configured LLM to split the topic into orthogonal literature-search queries before deterministic query expansion. Defaults to true; missing or failing LLM config falls back to deterministic planning. |
| `maxLlmQueries` | optional | number | Maximum LLM-planned orthogonal queries inserted before deterministic expansion. Defaults by depth: quick=3, default=4, deep=8. |
| `llmProvider` | optional | string | Optional LLM provider override for query planning, such as openai, anthropic, or ollama. Defaults to PaperNexus llm config. |
| `llmModel` | optional | string | Optional LLM model override for query planning. Defaults to PaperNexus llm config. |
| `llmBaseUrl` | optional | string | Optional LLM API base URL override for query planning. Defaults to PaperNexus llm config. |
| `maxResultsPerQuery` | optional | number | Maximum provider results per query. |
| `maxCandidates` | optional | number | Maximum merged candidates retained in the run. Defaults by depth: quick=80, default=240, deep=3000. |
| `providerConcurrency` | optional | number | Maximum concurrent literature search providers. Capped at 4. |
| `providerRequestSchedulerDelayMs` | optional | number | Optional shared scheduler delay between request starts for providers that do not have a provider-specific delay. |
| `providerRequestMaxConcurrent` | optional | number | Maximum concurrent HTTP requests per generic provider inside the shared discovery scheduler. |
| `discoveryRequestCache` | optional | boolean | Enable in-process discovery HTTP response caching for successful deterministic provider requests. |
| `discoveryRequestCacheTtlMs` | optional | number | TTL for the opt-in in-process discovery request cache. |
| `openAlexRequestDelayMs` | optional | number | Optional shared scheduler delay between OpenAlex request starts. Defaults to 0 unless configured by environment. |
| `openAlexMaxConcurrent` | optional | number | Maximum concurrent OpenAlex HTTP requests inside the shared discovery scheduler. |
| `semanticScholarRequestDelayMs` | optional | number | Optional Semantic Scholar request-start delay shared across search and citation expansion. Defaults to the existing Semantic Scholar delay configuration. |
| `semanticScholarMaxConcurrent` | optional | number | Maximum concurrent Semantic Scholar HTTP requests inside the shared discovery scheduler. |
| `papersCoolBaseUrl` | optional | string | Optional papers.cool base URL override. Defaults to https://papers.cool. |
| `papersCoolSort` | optional | number | papers.cool search ordering: 0 for time order, 1 for reading-star order. |
| `papersCoolMaxQueries` | optional | number | Maximum discovery queries sent to papers.cool per run to avoid over-querying the local/web provider. |
| `pasaApiBaseUrl` | optional | string | Optional PASA paper-agent API base URL override. Defaults to https://pasa-agent.ai/paper-agent/api/v1. |
| `pasaRequestTimeoutMs` | optional | number | Maximum timeout in milliseconds for one PASA API request. |
| `pasaTimeoutSeconds` | optional | number | Maximum PASA polling time per query. |
| `pasaPollIntervalSeconds` | optional | number | PASA polling interval per query. |
| `pasaMaxQueries` | optional | number | Maximum discovery queries sent to PASA per run because PASA is slower and rate-limited. |
| `maxDownloads` | optional | number | Maximum legal open source downloads attempted during resolution. Markdown is attempted before PDF when available. |
| `downloadConcurrency` | optional | number | Maximum concurrent legal Markdown/PDF source-resolution downloads. Capped at 4. |
| `preferMarkdown` | optional | boolean | When true (default), resolve and ingest explicit Markdown sources before trying PDF fallback. Generated third-party arXiv Markdown URLs require generateArxivMarkdownSources=true. |
| `generateArxivMarkdownSources` | optional | boolean | When true, generate third-party arXiv Markdown fallback URLs for candidates with an arXiv ID before falling back to arXiv PDF. |
| `markdownStagingRoot` | optional | string | Optional local directory for downloaded discovery Markdown sources. Defaults to the corpus discovery markdown staging directory. |
| `pdfStagingRoot` | optional | string | Optional local directory for downloaded discovery PDF fallback sources. Defaults to the corpus discovery PDF staging directory. |
| `allowDownloads` | optional | boolean | When false, keep Markdown/PDF URLs and institutional access hints but do not download files. |
| `candidateId` | optional | string | Candidate id to supplement in a persisted discovery run. |
| `canonicalId` | optional | string | Canonical paper id to supplement in a persisted discovery run, such as arxiv:2501.00001 or doi:10.xxxx/example. |
| `sourcePath` | optional | string | For operation=supplement, absolute local .md, .markdown, or .pdf path on the PaperNexus server. |
| `sourceKind` | optional | string (markdown, pdf) | Optional explicit source kind for operation=supplement. |
| `sourceProvider` | optional | string | Optional full-text source provider for operation=supplement, such as hf, arxiv2md-api, markxiv, arxiv2md, or manual_supplement. |
| `markdownUrl` | optional | string | For seeds or operation=supplement, HTTP(S) URL that returns validated paper Markdown. |
| `pdfUrl` | optional | string | For seeds or operation=supplement, HTTP(S) URL that returns a valid PDF fallback. |
| `paperMetadata` | optional | object | For operation=supplement, optional title/authors/year/identifier corrections to merge before import. |
| `citationExpansion` | optional | boolean | Expand top seed papers through Semantic Scholar references/citations. Defaults to true only for depth=deep. |
| `maxCitationSeeds` | optional | number | Maximum seed papers used for citation expansion. |
| `maxCitationsPerSeed` | optional | number | Maximum references and citations retained per seed during citation expansion. |
| `openAlexRelatedExpansion` | optional | boolean | Expand top seed papers through OpenAlex related_works during citation expansion. |
| `maxRelatedPerSeed` | optional | number | Maximum OpenAlex related_works retained per seed during citation expansion. |
| `importResolved` | optional | boolean | Submit resolved local full-text sources to the import queue after discovery. This accepts work into the queue; use processImports or import_workflow wait/status before treating papers as graph-visible. |
| `processImports` | optional | boolean | After submitting resolved sources, synchronously run the import worker so downloaded PDFs are parsed and fast-committed into the graph. Use this only when the caller intentionally wants to wait for graph visibility; it can be long-running. |
| `importBatchEnabled` | optional | boolean | Enable worker-side logical batching for inline import processing triggered by ingest, import_and_process, or processImports. Defaults to true for MCP so multiple submitted tasks can share one LLM optimization and fast commit. Server background workers use the same default unless imports.batchEnabled is explicitly set. |
| `importBatchMaxTasks` | optional | number | Maximum import tasks to reserve into one logical batch during inline import processing. Defaults to 4. |
| `importMaxPasses` | optional | number | Maximum import queue tasks to process inline when processImports is true. Defaults to the number of newly submitted tasks. |
| `maxImported` | optional | number | Maximum resolved full-text sources to submit when importResolved is true. Metadata-only candidates remain in discovery artifacts but are not graph-visible until materialized through import. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction mode for inline import processing. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Optional PDF parser override for inline import processing. |
| `pdfCommand` | optional | string | Optional generic PDF parser command override for inline import processing. |
| `doclingCommand` | optional | string | Optional Docling command override for inline import processing. |
| `pythonCommand` | optional | string | Optional Python command override for inline import processing. |
| `mailto` | optional | string | Contact email used for polite API calls and Unpaywall. |
| `openAlexApiKey` | optional | string | Optional OpenAlex API key. If omitted, openAlexApiKeyFile, OPENALEX_API_KEY, or ~/.papernexus/openalex_api_key is used when available. |
| `openAlexApiKeyFile` | optional | string | Optional local file containing the OpenAlex API key. Supports ~/ paths. Useful when the key should not be configured in the shell. |
| `coreApiKey` | optional | string | Optional CORE API key. If omitted, CORE can also be enabled with CORE_API_KEY in the environment. |
| `timeoutMs` | optional | number | Per-request timeout in milliseconds. |
| `retryCount` | optional | number | Retry count for transient provider failures such as HTTP 429 and 5xx responses. |
| `retryBackoffMs` | optional | number | Base retry backoff in milliseconds for transient provider failures. |
| `providerRequestDelayMs` | optional | number | Minimum delay between consecutive queries sent to the same provider. Set to 0 for fast local tests; keep nonzero for public APIs to reduce HTTP 429s. |
| `maxRetryAfterMs` | optional | number | Maximum Retry-After delay respected before a provider request fails fast. |
| `institutionalResolverBaseUrl` | optional | string | Optional campus library/OpenURL resolver URL. PaperNexus records resolver hints; it does not bypass authentication or paywalls. |
| `institutionalAccessMode` | optional | string (hints-only, browser, headless-browser, browser-session) | Authorized institutional access handling mode. Use headless-browser/browser-session to try a Playwright persistent browser profile after open-access download paths fail; SSO and captcha pages are recorded as manual barriers, not thrown. |
| `browserProfileDir` | optional | string | Optional browser user data directory for institutional browser-session downloads. Defaults to the selected browser channel profile root, such as Microsoft Edge User Data. |
| `browserProfileName` | optional | string | Browser profile name inside browserProfileDir for browser-session downloads. |
| `browserChannel` | optional | string | Playwright browser channel for browser-session downloads, usually msedge or chrome. |
| `browserExecutablePath` | optional | string | Optional Chromium/Chrome executable path for browser-session downloads. When set, it overrides browserChannel; useful on headless servers with a Playwright browser cache. |
| `browserHeadless` | optional | boolean | Run the persistent browser-session downloader in headless mode. |
| `browserDownloadTimeoutMs` | optional | number | Per-page/per-request timeout for browser-session PDF download attempts. |
| `browserAuthHosts` | optional | array | Institution SSO host fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `browserAuthUrlFragments` | optional | array | Institution SSO URL fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `browserAuthPageTitles` | optional | array | Institution SSO page-title fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `runId` | optional | string | Discovery run id for status/report or supplement operations. If omitted for status/report, the latest run is used. |
| `limit` | optional | number | Maximum runs returned by list. |
| `persist` | optional | boolean | Persist discovery artifacts under the corpus .papernexus directory. |

## Tool: idea_catalyst

<a id="tool-idea_catalyst"></a>

Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `problem` | required | string | Research problem statement to analyze. |
| `targetDomain` | required | string | Target domain that needs cross-domain inspiration. |
| `mode` | optional | string (graph, live_discovery, hybrid) | graph uses the existing indexed corpus. live_discovery runs the paper-faithful Semantic Scholar Snippets workflow. hybrid returns graph output plus live discovery output. |
| `liveDiscovery` | optional | boolean | Alias for mode=live_discovery. |
| `fineGrainedDomain` | optional | string | Optional finer-grained target domain label used in the staged packet bundle. |
| `coarseGrainedDomain` | optional | string | Optional coarse-grained target domain label used in the staged packet bundle. |
| `mechanisms` | optional | string \| array |  |
| `numSourceDomains` | optional | number |  |
| `numQuestions` | optional | number | Maximum target-domain research questions in live_discovery mode. |
| `maxPapersPerQuery` | optional | number | Maximum Semantic Scholar snippet results per target/source query in live_discovery mode. |
| `sourceRelevanceThreshold` | optional | number | Paper-level relevance majority threshold for retaining a source domain in live_discovery mode. |
| `targetFieldOfStudy` | optional | string | Optional Semantic Scholar coarse field override for the target domain, such as Computer Science or Medicine. |
| `year` | optional | string | Optional Semantic Scholar publication year filter for live_discovery mode, such as 2018-2024 or -2023. |
| `publicationDateOrYear` | optional | string | Optional Semantic Scholar publication date/year range for live_discovery mode. |
| `insertedBefore` | optional | string | Optional Semantic Scholar index insertion cutoff for live_discovery mode. |
| `relevanceThreshold` | optional | number |  |
| `limit` | optional | number |  |
| `outputMode` | optional | string (idea_fragments, packet_bundle) |  |
| `includeAnalysis` | optional | boolean |  |

## Tool: mutate_graph

<a id="tool-mutate_graph"></a>

Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `actor` | optional | string | Short label for the editing agent or workflow. |
| `dryRun` | optional | boolean | When true, validate and preview the mutation without saving changes. |
| `operations` | required | array | Mutation operations to apply in order. |

## Tool: refresh_corpus

<a id="tool-refresh_corpus"></a>

Run corpus-scale maintenance over an indexed corpus: incremental/full analyze, Stage 1 snapshot materialization, Stage 2 batch LLM optimization, or Stage 2-5 optimize from cached snapshots.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or root path. Omit to use the default corpus. |
| `mode` | optional | string (analyze, materialize, llm_optimize, optimize) | Maintenance mode. analyze commits an updated graph, materialize writes Stage 1 snapshots only, llm_optimize runs Stage 2 batch LLM optimization over cached snapshots, and optimize resumes from cached snapshots to commit stages 2-5. |
| `incremental` | optional | boolean | Analyze mode only. When true (default), reuse unchanged sources and only refresh detected deltas. When false, force-refresh all tracked sources before recommitting the graph. |
| `force` | optional | boolean | Force the selected maintenance mode even when cached state looks reusable. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction override for analyze, llm_optimize, optimize, or refresh-materialize compatibility flows. |
| `rebuildPdfMarkdown` | optional | boolean | When true, force PDF markdown regeneration before re-materialization for affected PDF sources. |
| `llmBatchSize` | optional | number | Optional Stage 2 batch size override for llm_optimize or optimize. |
| `batchSize` | optional | number | Alias for llmBatchSize. |
| `changedSourceKeys` | optional | array | Optional sourceKey scope for llm_optimize or optimize. When provided, only those manifest sources are refreshed during Stage 2 before the rest of the corpus state is reused. |

## Tool: refresh_paper_graph

<a id="tool-refresh_paper_graph"></a>

Force-refresh the graph content for one paper or one canonical duplicate group without rebuilding the whole corpus.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or root path. Omit to use the default corpus. |
| `paperId` | optional | string | Exact paperId to refresh. |
| `sourceKey` | optional | string | Exact manifest sourceKey to refresh. |
| `source` | optional | string | Exact source/input path on the server. Accepts absolute paths or ~/... paths. |
| `paperTitle` | optional | string | Exact normalized paper title to refresh. |
| `includeDuplicateGroup` | optional | boolean | When true (default), refresh and recanonicalize the entire duplicate/canonical group that contains the selected paper. |
| `rebuildPdfMarkdown` | optional | boolean | When true (default), force PDF markdown regeneration for matched PDF sources before graph refresh. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction mode override for the refresh run. |
