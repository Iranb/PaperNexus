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
| [`import_workflow`](#tool-import_workflow) | Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to logical batching with imports.batchEnabled=true and batchMaxTasks=8 unless server config explicitly disables or overrides it. |
| [`literature_discovery`](#tool-literature_discovery) | Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. operation=search is a bounded metadata-only interactive path with a default deadline, query caps, partial results, and diagnostics; use explicit deep/full settings when recall matters more than latency. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to logical batching with importBatchEnabled=true and importBatchMaxTasks=8. |
| [`idea_catalyst`](#tool-idea_catalyst) | Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle with v2 innovation artifacts: must-cite set, novelty certificate, review packet, storyline DAG, and counterfactual falsification plans. |
| [`agent_materials`](#tool-agent_materials) | Assemble Agent-facing research materials from committed graph/source state and manage project-level Agent overlay memory. Material operations return role-grouped packs, single-paper views, source discovery plans, negative evidence, experiment-cost snippets, innovation evidence/storyline packs, import requisitions, and research-controller artifacts without making novelty judgments; overlay operations store paper roles, evidence carts, workflow state, and controller state outside the raw corpus graph. |
| [`mutate_graph`](#tool-mutate_graph) | Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk. |
| [`runtime_init`](#tool-runtime_init) | Initialize or update the PaperNexus runtime config non-interactively over MCP, equivalent to papernexus init for server-side paths. This writes config only; call create_corpus for the first graph build. |
| [`create_corpus`](#tool-create_corpus) | Create the first committed corpus graph over MCP from server-visible source files/directories or create an empty graph when no sources are provided, equivalent to the first papernexus analyze --name run. Source-backed builds default to a background job to avoid MCP client timeouts; use operation=status or operation=wait with the returned jobId. Use refresh_corpus for later maintenance. |
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

Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to logical batching with imports.batchEnabled=true and batchMaxTasks=8 unless server config explicitly disables or overrides it.

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

Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. operation=search is a bounded metadata-only interactive path with a default deadline, query caps, partial results, and diagnostics; use explicit deep/full settings when recall matters more than latency. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to logical batching with importBatchEnabled=true and importBatchMaxTasks=8.

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
| `maxQueries` | optional | number | Maximum query families to execute after LLM planning and deterministic fallback expansion. For operation=search, defaults by searchMode are quick=4, balanced=6, and deep=10. |
| `searchMode` | optional | string (quick, balanced, deep) | Latency/recall profile for operation=search. quick uses the smallest budget and query cap; balanced is the default bounded search; deep is broader but still bounded and returns partial diagnostics before the MCP outer timeout. |
| `searchBudgetMs` | optional | number | Soft wall-clock budget for operation=search. Defaults by searchMode are quick=25000, balanced=45000, and deep=90000. When exhausted, PaperNexus stops scheduling new provider queries and returns partial metadata results with diagnostics. |
| `maxQueriesPerProvider` | optional | number | Maximum generated discovery queries sent to each provider. For operation=search, defaults to 2 in quick mode and 3 in balanced/deep mode. |
| `returnPartial` | optional | boolean | Return completed provider results with partial/diagnostics metadata when budget, timeout, query cap, or provider rate-limit truncates discovery. |
| `planningMode` | optional | string (rule_based, llm_augmented) | Query planning mode. operation=search defaults to rule_based unless llmQueryPlanner=true or planningMode=llm_augmented is explicit; non-search discovery keeps the configured LLM planner behavior. |
| `llmQueryPlanner` | optional | boolean | Use the configured LLM to split the topic into orthogonal literature-search queries before deterministic query expansion. Defaults to true for non-search discovery; operation=search defaults to false unless explicitly enabled. Missing, timing out, or failing LLM config falls back to deterministic planning. |
| `maxLlmQueries` | optional | number | Maximum LLM-planned orthogonal queries inserted before deterministic expansion. Defaults by depth are quick=3, default=4, deep=8; operation=search caps these to quick=2, balanced=2, and deep=4. |
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
| `importBatchMaxTasks` | optional | number | Maximum import tasks to reserve into one logical batch during inline import processing. Defaults to 8. |
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

Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle with v2 innovation artifacts: must-cite set, novelty certificate, review packet, storyline DAG, and counterfactual falsification plans.

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
| `timeCutoff` | optional | string | Optional temporal cutoff used to flag future-leakage in must-cite and novelty artifacts, such as 2024 or 2018-2024. |
| `mustCiteK` | optional | number | Maximum number of must-cite prior-art entries to surface in v2 innovation artifacts. |
| `reviewerPanel` | optional | string \| array | Optional reviewer roles for the structured review packet, for example novelty, methods, reproducibility, outsider. |
| `storylineMode` | optional | string | Optional storyline DAG mode. Defaults to claim_review_storyline. |
| `writeBack` | optional | boolean | When true, generates a schema-aware innovation writeback preview from v2 artifacts. The default is dry-run validation; it does not save unless writeBackApply=true, writeBackMode=apply, or writeBackDryRun=false. |
| `writeBackDryRun` | optional | boolean | When writeBack=true, keep graph mutation writeback in preview mode. Set false only for an explicit apply. |
| `writeBackApply` | optional | boolean | Explicitly apply validated writeback mutations to the corpus graph when writeBack=true. |
| `writeBackMode` | optional | string (dry_run, apply) | Controlled writeback mode for v2 innovation artifacts. |
| `writeBackActor` | optional | string | Short actor label recorded on writeback mutation audit properties. |
| `allowWeakEvidence` | optional | boolean | Allow weakly grounded innovation artifacts to emit preview operations. Defaults false so ungrounded claims, untraceable story beats, and future leakage block writeback. |
| `counterfactualBudget` | optional | number | Maximum number of counterfactual falsification plans to produce. |
| `relevanceThreshold` | optional | number |  |
| `limit` | optional | number |  |
| `outputMode` | optional | string (idea_fragments, packet_bundle) |  |
| `selectionMode` | optional | string (default, topk, mmr, submodular, dpp) | Optional post-generation selector. Use mmr, submodular, or dpp to return a graph-grounded diversity rerank with selection_trace. |
| `selectionK` | optional | number | Maximum idea fragments returned when selectionMode is topk, mmr, submodular, or dpp. |
| `mmrLambda` | optional | number | MMR relevance/diversity tradeoff for selectionMode=mmr. Higher values favor utility over diversity. |
| `minEvidenceTier` | optional | string (strong, moderate) | Minimum evidence tier admitted by the selector evidence gate. |
| `requireBridgePath` | optional | boolean | When true, the selector rejects candidates without bridge path provenance. |
| `includeAnalysis` | optional | boolean |  |

## Tool: agent_materials

<a id="tool-agent_materials"></a>

Assemble Agent-facing research materials from committed graph/source state and manage project-level Agent overlay memory. Material operations return role-grouped packs, single-paper views, source discovery plans, negative evidence, experiment-cost snippets, innovation evidence/storyline packs, import requisitions, and research-controller artifacts without making novelty judgments; overlay operations store paper roles, evidence carts, workflow state, and controller state outside the raw corpus graph.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (research_material_pack, innovation_evidence_pack, source_discovery_plan, paper_material_view, paper_role_overlay, evidence_cart, workflow_state, negative_evidence_pack, experiment_cost_materials, import_requisition_pack, research_controller) | Material backend operation to run. Overlay operations write only project overlay files, never the raw corpus graph. |
| `action` | optional | string (add, update, list, remove, get, export, status, init_task, run_round, generate_decomposition, review_decomposition, generate_candidates, propose_edges, judge_batch, select_batch, expand_evidence, execute_material_requests, record_material_results, compose_solutions, design_review, compose_innovation_briefs, generate_experiment_plan, validate_gcd_mvp) | Sub-action for paper_role_overlay, evidence_cart, workflow_state, or research_controller. Defaults: list for role/evidence operations, get for workflow_state, status for research_controller. |
| `dryRun` | optional | boolean | Preview write-capable overlay operations without writing files. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `project` | optional | string | Research project id used to label material packs and isolate project overlay memory. For research_controller, omitted GCD tasks default to gcd-research-controller and other tasks default to research-controller. |
| `targetDomain` | optional | string | Target research domain for source discovery and material pack grouping. |
| `targetProblem` | optional | string | Research problem statement used to generate target, near-source, and far-source material queries. |
| `ideaComponents` | optional | string \| array | Optional components for innovation_evidence_pack composition-collision audit, for example Absorb, Separate, Buffer, non-identifiable reporting, or prior/capacity calibration. |
| `coverageAreas` | optional | string \| array | Optional coverage taxonomy override for innovation_evidence_pack evidence-sufficiency audit. Defaults to GCD, domain-shift GCD, open-world discovery, selective prediction, conformal risk, certified decision, label-shift-aware TTA, and calibration. |
| `query` | optional | string | Alias or fallback query for operations that accept targetProblem or paper lookup text. |
| `constraints` | optional | string \| array | Venue, compute, data, task, or application constraints used when generating material queries. |
| `mode` | optional | string (quick, planning, deep) | Research-controller mode. quick initializes graph-only scouting artifacts, planning is the default controller pass, and deep is reserved for explicitly enabled evidence expansion. |
| `selector` | optional | object | Optional research-controller selector settings. The MVP writes top-k, MMR, and greedy-submodular selection traces; set mmr_lambda to tune the MMR ablation/fallback. |
| `mmrLambda` | optional | number | Optional lambda for the research-controller MMR selector trace. Higher values favor utility over diversity. |
| `budget` | optional | object | Research-controller budget caps, for example max_candidate_nodes, max_edge_judgments, max_agent_calls, max_provider_queries, max_imports, and max_selected_candidates. |
| `judge` | optional | object | Research-controller judge configuration. MVP uses a single model and stores judge output as evidence only. |
| `maxPairwisePreferences` | optional | integer | Maximum bounded pairwise preference comparisons requested from the research-controller judge batch. |
| `externalInputs` | optional | object | Research-controller external inputs such as subproblem_hints, seed_papers, human_notes, and rejected_directions. |
| `approveExperimentPlanning` | optional | boolean | For research_controller action=generate_experiment_plan, explicit approval to write a plan-only experiment artifact. This does not run experiments. |
| `approveMaterialRequestExecution` | optional | boolean | For research_controller action=execute_material_requests, explicit approval to execute planned agent_materials material requests. Provider/live/literature/import opt-ins still require the separate allow* approval flags. |
| `allowProviderMaterialOptIns` | optional | boolean | For research_controller action=execute_material_requests, allow approved material requests to pass requested provider evidence, live discovery, or literature-discovery evidence opt-ins to the nested material executor. Does not permit import submission. |
| `allowImportSubmission` | optional | boolean | For research_controller action=execute_material_requests, allow approved import_requisition/literature material requests to submit imports when the request explicitly asked for import submission. |
| `allowImportProcessing` | optional | boolean | For research_controller action=execute_material_requests, allow approved literature material requests to process submitted imports when the request explicitly asked for import processing. |
| `materialRequestExecutionApproval` | optional | object | Approval metadata for research_controller material request execution, such as approver, source, note, and granular allow_provider_evidence / allow_live_discovery_evidence / allow_literature_discovery / allow_import_submission / allow_import_processing flags. |
| `approvedMaterialRequestIds` | optional | array | Optional allow-list of planned material request ids that may be executed by research_controller action=execute_material_requests. |
| `maxMaterialRequests` | optional | integer | Maximum material requests to execute in one research_controller action=execute_material_requests call. |
| `experimentPlanApproval` | optional | object | Approval metadata for research_controller experiment-plan generation, such as approver, source, and note. |
| `maxExperimentPlans` | optional | integer | Maximum number of plan-only experiment plans generated from reviewed solution sketches. |
| `maxGpuHours` | optional | number | Optional planning budget constraint recorded in experiment plans. No compute is launched. |
| `providerPolicy` | optional | object | Research-controller provider policy. Provider evidence, literature discovery, import submission, and configured controller LLM calls default to disabled unless explicitly enabled. For single-model provider calls, set enable_controller_llm=true plus controller_llm model/base_url or environment equivalents and a positive max_provider_queries budget. |
| `subproblemHints` | optional | array | Optional research-controller subproblem hints used during deterministic foundation initialization. |
| `overwrite` | optional | boolean | When research_controller action=init_task, regenerate foundation artifacts even when controller-state.json already exists. |
| `autoDiscoverSources` | optional | boolean | Compatibility flag for material-pack workflows. Source discovery is generated by default and remains read-only unless routed to import tools. |
| `preferDomains` | optional | string \| array | Preferred source domains for source_discovery_plan and research_material_pack. |
| `excludeDomains` | optional | string \| array | Source domains to exclude from the graph-native near/far source router. |
| `nearSourceDomains` | optional | string \| array | Explicit domains to treat as near-source method domains. |
| `farSourceDomains` | optional | string \| array | Explicit domains to treat as far-source story domains. |
| `minDomainDistance` | optional | number | Minimum domain distance for source-router candidates before they are marked as proximal leakage. |
| `maxProximalResults` | optional | number | Maximum number of below-minDomainDistance source domains kept with proximal_leakage=true. |
| `sourceDomainLimit` | optional | number | Maximum source domains returned by the graph-native source router. |
| `includeProviderEvidence` | optional | boolean | Opt in to bounded read-only Semantic Scholar snippet evidence for source_discovery_plan, research_material_pack, import_requisition_pack, and negative_evidence_pack. Default false to avoid implicit network calls. |
| `providerEvidenceLimit` | optional | number | Maximum Semantic Scholar snippet hits retained per provider-evidence query. |
| `persistProviderEvidence` | optional | boolean | When includeProviderEvidence is true, persist returned provider snippets into the project evidence cart. Requires project; default false. |
| `providerEvidencePersistLimit` | optional | number | Maximum provider evidence snippets persisted into the project evidence cart when persistProviderEvidence=true. |
| `providerEvidenceQueryLimit` | optional | number | Maximum generated queries sent to the provider-evidence layer. |
| `providerEvidenceTimeoutMs` | optional | number | Timeout in milliseconds for each provider-evidence request. |
| `providerEvidenceFallbackToAbstract` | optional | boolean | When true, hydrate degenerate provider snippets with paper abstracts when available. |
| `includeLiveDiscoveryEvidence` | optional | boolean | Opt in to bounded idea_catalyst live_discovery evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit LLM and network calls. |
| `runLiveIdeaCatalystIfNeeded` | optional | boolean | Opt in to running bounded idea_catalyst live_discovery only when requested roles are sparse in the committed graph. Default false to avoid implicit LLM and network calls. |
| `liveDiscoveryFallbackIfSparse` | optional | boolean | Alias for runLiveIdeaCatalystIfNeeded; runs live discovery only when committed-graph role evidence is sparse. |
| `liveDiscoverySparseRoleThreshold` | optional | number | Number of sparse requested roles required before runLiveIdeaCatalystIfNeeded triggers live discovery. |
| `liveDiscoverySparseMinScore` | optional | number | Minimum committed-graph search score counted as non-sparse for runLiveIdeaCatalystIfNeeded. |
| `persistLiveDiscoveryEvidence` | optional | boolean | When includeLiveDiscoveryEvidence is true, persist returned live-discovery spans/fragments into the project evidence cart. Requires project; default false. |
| `liveDiscoveryNumQuestions` | optional | number | Maximum target research questions used by opt-in live discovery evidence. |
| `liveDiscoverySourceDomainLimit` | optional | number | Maximum source domains used by opt-in live discovery evidence. |
| `liveDiscoveryMaxPapersPerQuery` | optional | number | Maximum Semantic Scholar snippet papers retrieved per live-discovery query. |
| `liveDiscoverySourceRelevanceThreshold` | optional | number | Paper-level source relevance ratio threshold used by opt-in live discovery evidence. |
| `liveDiscoveryIdeaFragmentLimit` | optional | number | Maximum idea fragments retained from opt-in live discovery evidence. |
| `liveDiscoveryPersistLimit` | optional | number | Maximum live-discovery spans/fragments persisted into the project evidence cart when persistLiveDiscoveryEvidence=true. |
| `liveDiscoveryTimeoutMs` | optional | number | Timeout in milliseconds for each live-discovery provider request. |
| `includeLiteratureDiscoveryEvidence` | optional | boolean | Opt in to bounded literature_discovery search/resolve evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit network/download work. |
| `runLiteratureDiscoveryIfSparse` | optional | boolean | Opt in to running bounded literature_discovery only when requested roles are sparse in the committed graph. Default false. |
| `literatureDiscoveryFallbackIfSparse` | optional | boolean | Alias for runLiteratureDiscoveryIfSparse; runs literature_discovery only when committed-graph role evidence is sparse. |
| `literatureDiscoverySeedProviderPapers` | optional | boolean | When both provider evidence and literature-discovery evidence are enabled, pass provider snippet hits into literature_discovery as exact seed papers. Default false. |
| `literatureDiscoveryProviderSeedLimit` | optional | number | Maximum provider evidence hits passed into literature_discovery as exact seed papers. |
| `literatureDiscoverySeedLivePapers` | optional | boolean | When both live-discovery and literature-discovery evidence are enabled, pass live-discovery supporting papers into literature_discovery as exact seed papers. Default false. |
| `literatureDiscoveryLiveSeedLimit` | optional | number | Maximum live-discovery supporting papers passed into literature_discovery as exact seed papers. |
| `literatureDiscoveryResolveSources` | optional | boolean | Resolve legal full-text sources during opt-in literature discovery evidence. Default true; set false for metadata-only discovery. |
| `literatureDiscoveryAllowDownloads` | optional | boolean | Allow opt-in literature discovery source resolution to stage legal markdown/open-PDF downloads. Default true when literature discovery evidence is enabled. |
| `submitLiteratureDiscoveryImports` | optional | boolean | Submit resolved literature_discovery full-text sources to the import queue from agent_materials. Default false; use import_workflow wait/status before treating submitted papers as graph-visible. |
| `processLiteratureDiscoveryImports` | optional | boolean | After submitting resolved literature_discovery sources, synchronously run the import worker so imports can become graph-visible. Default false because this can be long-running. |
| `literatureDiscoveryMaxQueries` | optional | number | Maximum generated literature_discovery queries when opt-in evidence is enabled. |
| `literatureDiscoveryMaxResultsPerQuery` | optional | number | Maximum provider results retained per literature_discovery query when opt-in evidence is enabled. |
| `literatureDiscoveryMaxCandidates` | optional | number | Maximum merged literature_discovery candidates retained when opt-in evidence is enabled. |
| `literatureDiscoveryMaxDownloads` | optional | number | Maximum legal full-text downloads staged by opt-in literature_discovery source resolution. |
| `literatureDiscoveryMaxImported` | optional | number | Maximum resolved full-text sources submitted when submitLiteratureDiscoveryImports is true. |
| `literatureDiscoveryImportMaxPasses` | optional | number | Maximum import worker passes when processLiteratureDiscoveryImports is true. |
| `literatureDiscoveryImportBatchEnabled` | optional | boolean | Enable worker-side logical batching for inline literature_discovery import processing triggered by processLiteratureDiscoveryImports. |
| `literatureDiscoveryImportBatchMaxTasks` | optional | number | Maximum import tasks to reserve into one logical batch for inline literature_discovery import processing. |
| `timeWindow` | optional | string | Optional time-window label recorded in negative_evidence_pack filters. |
| `roles` | optional | string \| array | Requested material roles, for example target_prior, near_source_method, far_source_story, novelty_risk, or baseline_candidate. |
| `role` | optional | string | Single-role alias for roles. |
| `roleId` | optional | string | Stable project overlay role id for paper_role_overlay update/remove. |
| `layer` | optional | string | Optional source layer for paper role overlay, for example target_domain, near_source, or far_source. |
| `judgmentType` | optional | string | Optional Agent judgment type saved in project overlay, for example closest_prior or novelty_risk_note. |
| `confidence` | optional | string | Optional Agent confidence label for project overlay entries. |
| `supportingEvidenceIds` | optional | array | Evidence ids supporting a paper role overlay entry. |
| `paperId` | optional | string | Paper id for paper_material_view. |
| `paperTitle` | optional | string | Paper title for paper_material_view or seed matching. |
| `title` | optional | string | Alias for paperTitle. |
| `sourceKey` | optional | string | Manifest sourceKey for paper_material_view. |
| `sourceType` | optional | string | Evidence-cart source type, for example chunk, graph_node, table, figure, query, or negative_evidence. |
| `sourceId` | optional | string | Evidence-cart source id, such as a chunk id, graph node id, or external query id. |
| `evidenceId` | optional | string | Stable evidence-cart id for remove or cross-linking from paper_role_overlay. |
| `itemType` | optional | string | Evidence-cart item type, for example snippet, table, figure, mechanism, paper, or negative_evidence. |
| `text` | optional | string | Evidence-cart text or short material excerpt. |
| `tags` | optional | string \| array | Evidence-cart tags. |
| `provenance` | optional | array | Evidence-cart provenance records. |
| `notes` | optional | string | Human or Agent notes for overlay entries. |
| `actor` | optional | string | Short label for the Agent or user writing overlay state. |
| `workflowState` | optional | object | Workflow state patch for workflow_state action=update. |
| `hypothesis` | optional | string | Current project hypothesis for workflow_state action=update. |
| `currentStage` | optional | string | Current workflow stage label for workflow_state action=update. |
| `acceptedDirections` | optional | array | Accepted research directions for workflow_state action=update. |
| `rejectedDirections` | optional | array | Rejected research directions for workflow_state action=update. |
| `openQuestions` | optional | array | Open questions for workflow_state action=update. |
| `neededMaterials` | optional | array | Needed materials for workflow_state action=update. |
| `identifier` | optional | string | Generic DOI, arXiv id, PMID, or other identifier for paper lookup. |
| `doi` | optional | string | DOI for paper lookup or seed matching. |
| `arxivId` | optional | string | arXiv id for paper lookup or seed matching. |
| `pmid` | optional | string | PMID for paper lookup or seed matching. |
| `pmcid` | optional | string | PMCID for paper lookup or seed matching. |
| `seedPapers` | optional | array | Optional user- or Agent-provided candidate papers. Missing seeds become import requisitions in the MVP. |
| `limit` | optional | number | Maximum candidates per role or generated query group. |
| `chunkLimit` | optional | number | Maximum chunk records returned by paper_material_view. |
| `includeCostLlmExtraction` | optional | boolean | Opt in to bounded LLM structured extraction for experiment_cost_materials. Default false to avoid implicit LLM calls. |
| `costLlmRecordLimit` | optional | number | Maximum paper material records sent to the opt-in experiment-cost LLM extractor. |
| `costLlmMaxInputChars` | optional | number | Maximum characters from paper material records sent to the opt-in experiment-cost LLM extractor. |
| `costLlmProvider` | optional | string | Optional LLM provider override for opt-in experiment-cost extraction, for example ollama, openai, or anthropic. |
| `costLlmModel` | optional | string | Optional LLM model override for opt-in experiment-cost extraction. |
| `costLlmBaseUrl` | optional | string | Optional LLM base URL override for opt-in experiment-cost extraction, including OpenAI-compatible Qwen endpoints. |
| `costLlmApiKeyEnv` | optional | string | Optional environment variable name containing the API key for opt-in experiment-cost extraction. |
| `costLlmTimeoutMs` | optional | number | Timeout in milliseconds for the opt-in experiment-cost LLM extraction request. |
| `costLlmMaxTokens` | optional | number | Maximum output tokens requested from the opt-in experiment-cost LLM extractor. |
| `outputDir` | optional | string | Optional server-local directory for JSON/Markdown exports. Omit for pure read-only response. |

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

## Tool: runtime_init

<a id="tool-runtime_init"></a>

Initialize or update the PaperNexus runtime config non-interactively over MCP, equivalent to papernexus init for server-side paths. This writes config only; call create_corpus for the first graph build.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `sourceInputs` | optional | array | Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the MCP server. Omit or pass an empty array to initialize an empty corpus config. |
| `sources` | optional | array,string | Alias for sourceInputs. Strings may be comma-separated. |
| `corpus` | required | string | Friendly corpus name to write into analyze.name and global.corpus. |
| `corpusName` | optional | string | Alias for corpus. |
| `indexDir` | optional | string | Directory where the generated .papernexus index should live. Defaults to the existing storage.indexDir or ~/.papernexus/index-store. |
| `rootPath` | optional | string | Alias for indexDir. |
| `configPath` | optional | string | Optional runtime config path to create or update. If omitted, the default PaperNexus runtime config is used. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Default PDF parser to write into analyze.pdfParser. |
| `serveHost` | optional | string | Default serve host to write into serve.host. |
| `servePort` | optional | number | Default serve port to write into serve.port. |
| `serveMcpEnabled` | optional | boolean | When provided, write serve.mcp.enabled for HTTP MCP serving. |
| `serveMcpPath` | optional | string | When provided, write serve.mcp.path. Relative values are normalized with a leading slash. |
| `llm` | optional | object | Optional LLM config metadata. Raw API keys are intentionally rejected; use apiKeyEnv or keychain metadata. |

## Tool: create_corpus

<a id="tool-create_corpus"></a>

Create the first committed corpus graph over MCP from server-visible source files/directories or create an empty graph when no sources are provided, equivalent to the first papernexus analyze --name run. Source-backed builds default to a background job to avoid MCP client timeouts; use operation=status or operation=wait with the returned jobId. Use refresh_corpus for later maintenance.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `sourceInputs` | optional | array | Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the MCP server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the server. If omitted, configured sources.inputs are used; if no inputs are configured, an empty corpus graph is created. |
| `sources` | optional | array,string | Alias for sourceInputs. Strings may be comma-separated. |
| `sourceRoot` | optional | string | Alias for a single source input path. |
| `inputPath` | optional | string | Alias for a single source input path. |
| `corpus` | optional | string | Friendly corpus name. If omitted, configured analyze.name or global.corpus is used. |
| `corpusName` | optional | string | Alias for corpus. |
| `rootPath` | optional | string | Index root where the .papernexus directory is created. If omitted, configured storage.indexDir or the analyze default is used. |
| `indexDir` | optional | string | Alias for rootPath. |
| `configPath` | optional | string | Optional runtime config path to read defaults from. |
| `force` | optional | boolean | Force a full build even if cached corpus state exists. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction override for the first build. |
| `rebuildPdfMarkdown` | optional | boolean | When true, force PDF markdown regeneration during the first build. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Optional PDF parser override for the first build. |
| `pdfCommand` | optional | string | Optional generic PDF parser command override for the first build. |
| `concurrency` | optional | number | Optional source analysis concurrency override. |
| `analyzeConcurrency` | optional | number | Alias for concurrency. |
| `llmBatchSize` | optional | number | Optional LLM batch size override. |
| `batchSize` | optional | number | Alias for llmBatchSize. |
| `operation` | optional | string (build, submit, status, wait) | build starts a create operation, submit always starts it as a background job, status returns a submitted job, and wait polls a submitted job until completion or waitTimeoutMs. |
| `executionMode` | optional | string (auto, sync, async) | Execution mode for operation=build. auto runs empty corpus creation synchronously and source-backed builds asynchronously to avoid MCP client timeouts. |
| `async` | optional | boolean | Alias for executionMode=async when true and executionMode=sync when false. |
| `waitForCompletion` | optional | boolean | When false, alias for executionMode=async; when true, alias for executionMode=sync. |
| `jobId` | optional | string | Background create_corpus job id returned by an async build; required for operation=status or operation=wait. |
| `waitTimeoutMs` | optional | number | Maximum milliseconds for operation=wait to poll before returning the latest job state. |
| `pollIntervalMs` | optional | number | Polling interval for operation=wait. |

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
