# MCP Tool Reference

This page is generated from [`src/mcp/tools.js`](https://github.com/Iranb/PaperNexus/blob/main/src/mcp/tools.js). It documents the public MCP surface that remote and local clients should rely on.

## Tool Index

| Tool | Description |
| --- | --- |
| [`list_corpora`](#tool-list_corpora) | List all locally indexed academic-paper corpora available to PaperNexus. |
| [`corpus_status`](#tool-corpus_status) | Show corpus stats and top research problems for a specific corpus. |
| [`corpus_sources`](#tool-corpus_sources) | Return the current source manifest entries for a corpus so remote clients can reconcile which papers are already materialized in the graph. |
| [`query`](#tool-query) | Search a research knowledge graph for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. |
| [`context`](#tool-context) | Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node. |
| [`impact`](#tool-impact) | Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks. |
| [`ideas`](#tool-ideas) | Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph. |
| [`brainstorm`](#tool-brainstorm) | Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions. |
| [`domain_distance`](#tool-domain_distance) | Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain. |
| [`extract_takeaways`](#tool-extract_takeaways) | Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges. |
| [`interdisciplinary_potential`](#tool-interdisciplinary_potential) | Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways. |
| [`research_lookup`](#tool-research_lookup) | Run high-level graph lookup operations over remote HTTP MCP using one tool surface for query, context, impact, ideas, brainstorming, domain distance, takeaway extraction, and interdisciplinary potential. |
| [`research_briefing`](#tool-research_briefing) | Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface. |
| [`import_workflow`](#tool-import_workflow) | Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. |
| [`idea_catalyst`](#tool-idea_catalyst) | Run a one-shot interdisciplinary ideation pass over the graph and return either idea fragments or a data-starvation requisition. |
| [`mutate_graph`](#tool-mutate_graph) | Create, update, or delete graph nodes and relationships with schema-aware validation. Supports dry-run previews before writing to disk. |
| [`refresh_corpus`](#tool-refresh_corpus) | Trigger incremental re-analysis of a corpus to pick up new or changed papers. Returns the updated corpus status after refresh. |

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

Return the current source manifest entries for a corpus so remote clients can reconcile which papers are already materialized in the graph.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |

## Tool: query

<a id="tool-query"></a>

Search a research knowledge graph for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions.

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

Run high-level graph lookup operations over remote HTTP MCP using one tool surface for query, context, impact, ideas, brainstorming, domain distance, takeaway extraction, and interdisciplinary potential.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (query, context, impact, ideas, brainstorm, domain_distance, extract_takeaways, interdisciplinary_potential) |  |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `query` | optional | string | Topic, node anchor, or challenge text used by the selected lookup operation. |
| `targetDomain` | optional | string | Target domain used by domain-distance and interdisciplinary operations. |
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

Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (submit, list, status, progress, queue_progress, log, wait) |  |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `taskId` | optional | string | Import task id for status, log, or wait. |
| `paperId` | optional | string | Optional paper id used to resolve a task when taskId is omitted. |
| `source` | optional | string | Optional source path used to resolve a task when taskId is omitted. |
| `serverFilePath` | optional | string | Absolute file path on the PaperNexus server for submit. |
| `files` | optional | array |  |
| `trigger` | optional | string |  |
| `limit` | optional | number |  |
| `taskIds` | optional | array | Optional task ids used to filter queue_progress snapshots. |
| `timeout` | optional | number | Maximum seconds to wait for completion when operation is wait. |
| `interval` | optional | number | Polling interval in seconds when operation is wait. |

## Tool: idea_catalyst

<a id="tool-idea_catalyst"></a>

Run a one-shot interdisciplinary ideation pass over the graph and return either idea fragments or a data-starvation requisition.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `problem` | required | string | Research problem statement to analyze. |
| `targetDomain` | required | string | Target domain that needs cross-domain inspiration. |
| `mechanisms` | optional | string \| array |  |
| `numSourceDomains` | optional | number |  |
| `relevanceThreshold` | optional | number |  |
| `limit` | optional | number |  |

## Tool: mutate_graph

<a id="tool-mutate_graph"></a>

Create, update, or delete graph nodes and relationships with schema-aware validation. Supports dry-run previews before writing to disk.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `actor` | optional | string | Short label for the editing agent or workflow. |
| `dryRun` | optional | boolean | When true, validate and preview the mutation without saving changes. |
| `operations` | required | array | Mutation operations to apply in order. |

## Tool: refresh_corpus

<a id="tool-refresh_corpus"></a>

Trigger incremental re-analysis of a corpus to pick up new or changed papers. Returns the updated corpus status after refresh.

### Input Schema

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or root path. Omit to use the default corpus. |
| `incremental` | optional | boolean | When true (default), only process papers added since last analysis. When false, rebuild the entire graph. |
| `force` | optional | boolean | Force re-analysis even if no changes detected. |
