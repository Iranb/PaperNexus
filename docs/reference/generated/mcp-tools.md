# MCP Tool Reference

This page is generated from [`src/mcp/tools.js`](https://github.com/papernexus/PaperNexus/blob/main/src/mcp/tools.js). It documents the public MCP surface that remote and local clients should rely on.

## How To Read This Page

Each tool section lists the tool purpose first, followed by every currently exposed input field from the JSON schema and one or more copyable JSON payload examples. Nested fields use dot notation, and array item fields use `[]`, for example `operations[].action` or `llm.provider`. Fields marked `required in parent` are required only when their containing object or array item is provided.

## Tool Index

| Tool | Area | Required Args | Description |
| --- | --- | --- | --- |
| [`list_corpora`](#tool-list_corpora) | Graph & Research Lookup | None | List all locally indexed academic-paper corpora available to PaperNexus. |
| [`corpus_status`](#tool-corpus_status) | Graph & Research Lookup | None | Show corpus stats and top research problems for a specific corpus. |
| [`corpus_sources`](#tool-corpus_sources) | Graph & Research Lookup | None | Return source manifest entries plus per-paper graph-index and source-span provenance so remote clients can reconcile which papers are materialized in the graph. |
| [`query`](#tool-query) | Graph & Research Lookup | `query` | Search already committed research knowledge-graph state for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. Use literature_discovery for fresh keyword/topic discovery before papers are ingested. |
| [`context`](#tool-context) | Graph & Research Lookup | `query` | Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node. |
| [`impact`](#tool-impact) | Graph & Research Lookup | `query` | Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks. |
| [`ideas`](#tool-ideas) | Graph & Research Lookup | `query` | Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph. |
| [`brainstorm`](#tool-brainstorm) | Graph & Research Lookup | `query` | Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions. |
| [`domain_distance`](#tool-domain_distance) | Graph & Research Lookup | None | Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain. |
| [`extract_takeaways`](#tool-extract_takeaways) | Graph & Research Lookup | `targetDomain`, `agnosticChallenges` | Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges. |
| [`interdisciplinary_potential`](#tool-interdisciplinary_potential) | Graph & Research Lookup | `targetDomain`, `query` | Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways. |
| [`research_lookup`](#tool-research_lookup) | Graph & Research Lookup | `operation` | Run high-level lookup operations over already committed graph state using one remote HTTP MCP surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, interdisciplinary potential, and method atlas lookups. Use literature_discovery first for fresh keyword literature search; graph lookup only sees imported papers after import tasks reach status=completed and stage=completed. |
| [`research_briefing`](#tool-research_briefing) | Graph & Research Lookup | `operation` | Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface. |
| [`import_workflow`](#tool-import_workflow) | Discovery & Imports | `operation` | Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to progressive logical batching with imports.batchEnabled=true, batchInitialTasks=4, and batchMaxTasks=16 unless server config explicitly disables or overrides it. |
| [`literature_discovery`](#tool-literature_discovery) | Discovery & Imports | `operation` | Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. operation=search is a bounded metadata-only interactive path with a default deadline, query caps, partial results, and diagnostics; use operation=submit plus progress/report polling for broad or long-running searches so MCP client timeouts do not lose server-side state. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to progressive logical batching with importBatchEnabled=true, importBatchInitialTasks=4, and importBatchMaxTasks=16. |
| [`idea_catalyst`](#tool-idea_catalyst) | Ideation & Agent Materials | `problem`, `targetDomain` | Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle with v2 innovation artifacts: must-cite set, novelty certificate, review packet, storyline DAG, and counterfactual falsification plans. |
| [`agent_materials`](#tool-agent_materials) | Ideation & Agent Materials | `operation` | Assemble Agent-facing research materials from committed graph/source state and manage project-level Agent overlay memory. Material operations return role-grouped packs, single-paper views, source discovery plans, negative evidence, experiment-cost snippets, innovation evidence/storyline packs, import requisitions, research-controller artifacts, and episode-local proposal graph sessions without making raw corpus graph mutations; overlay operations store paper roles, evidence carts, workflow state, and controller state outside the raw corpus graph. |
| [`mutate_graph`](#tool-mutate_graph) | Operations & Maintenance | `operations` | Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk. |
| [`runtime_init`](#tool-runtime_init) | Operations & Maintenance | `corpus` | Initialize or update the PaperNexus runtime config non-interactively over MCP, equivalent to papernexus init for server-side paths. This writes config only; call create_corpus for the first graph build. |
| [`create_corpus`](#tool-create_corpus) | Operations & Maintenance | None | Create the first committed corpus graph over MCP from server-visible source files/directories or create an empty graph when no sources are provided, equivalent to the first papernexus analyze --name run. Source-backed builds default to a background job to avoid MCP client timeouts; use operation=status or operation=wait with the returned jobId. Use refresh_corpus for later maintenance. |
| [`refresh_corpus`](#tool-refresh_corpus) | Operations & Maintenance | None | Run corpus-scale maintenance over an indexed corpus: incremental/full analyze, Stage 1 snapshot materialization, Stage 2 batch LLM optimization, or Stage 2-5 optimize from cached snapshots. |
| [`refresh_paper_graph`](#tool-refresh_paper_graph) | Operations & Maintenance | None | Force-refresh the graph content for one paper or one canonical duplicate group without rebuilding the whole corpus. |

## Tool: list_corpora

<a id="tool-list_corpora"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** None

### Function

List all locally indexed academic-paper corpora available to PaperNexus.

### Parameters

This tool takes no arguments.

### Examples

**List all indexed corpora**

```json
{}
```

## Tool: corpus_status

<a id="tool-corpus_status"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** None

### Function

Show corpus stats and top research problems for a specific corpus.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |

### Examples

**Inspect one corpus**

```json
{
  "corpus": "demo-corpus"
}
```

## Tool: corpus_sources

<a id="tool-corpus_sources"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** None

### Function

Return source manifest entries plus per-paper graph-index and source-span provenance so remote clients can reconcile which papers are materialized in the graph.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |

### Examples

**List source files known to a corpus**

```json
{
  "corpus": "demo-corpus"
}
```

## Tool: query

<a id="tool-query"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `query`

### Function

Search already committed research knowledge-graph state for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. Use literature_discovery for fresh keyword/topic discovery before papers are ingested.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Natural-language or keyword query. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `limit` | optional | number | Maximum number of grouped semantic result buckets to return. Default: `5`. |
| `layers` | optional | string | Optional comma-separated layer filter, for example ProblemLayer,MethodLayer. |

### Examples

**Search committed graph knowledge**

```json
{
  "corpus": "demo-corpus",
  "query": "open-world semi-supervised learning",
  "layers": "ProblemLayer,MethodLayer",
  "limit": 5
}
```

## Tool: context

<a id="tool-context"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `query`

### Function

Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Node name or exact node id. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `layers` | optional | string | Optional comma-separated layer filter. |
| `layerMode` | optional | string (any, intra, cross) | Restrict context edges to any, intra-layer, or cross-layer edges. Default: `"any"`. Allowed values: `any`, `intra`, `cross`. |

### Examples

**Fetch a node neighborhood**

```json
{
  "corpus": "demo-corpus",
  "query": "Office-Home dataset",
  "layers": "EvaluationLayer",
  "layerMode": "any"
}
```

## Tool: impact

<a id="tool-impact"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `query`

### Function

Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Node name or exact node id. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `direction` | optional | string (upstream, downstream) | Traverse incoming or outgoing edges. Default: `"upstream"`. Allowed values: `upstream`, `downstream`. |
| `maxDepth` | optional | number | Traversal depth. Default: `3`. |
| `layers` | optional | string | Optional comma-separated layer filter. |
| `layerMode` | optional | string (any, intra, cross) | Restrict impact traversal to any, intra-layer, or cross-layer edges. Default: `"any"`. Allowed values: `any`, `intra`, `cross`. |

### Examples

**Traverse upstream evidence for an anchor**

```json
{
  "corpus": "demo-corpus",
  "query": "DomainNet",
  "direction": "upstream",
  "maxDepth": 2,
  "layerMode": "cross"
}
```

## Tool: ideas

<a id="tool-ideas"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `query`

### Function

Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Target research topic or problem statement. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `limit` | optional | number | Maximum number of research opportunities to return. Default: `5`. |
| `layers` | optional | string | Optional comma-separated layer filter. |

### Examples

**Generate graph-grounded research opportunities**

```json
{
  "corpus": "demo-corpus",
  "query": "robust open-set domain adaptation",
  "limit": 6
}
```

## Tool: brainstorm

<a id="tool-brainstorm"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `query`

### Function

Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `query` | required | string | Target topic, problem statement, or research question. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `mode` | optional | string (diverge, converge) | Use diverge to expand the search space or converge to rank candidate directions. Default: `"diverge"`. Allowed values: `diverge`, `converge`. |
| `maxHops` | optional | number | Maximum traversal hops for brainstorming expansion. Default: `2`. |
| `limit` | optional | number | Maximum number of converged directions or idea candidates. Default: `5`. |
| `layers` | optional | string | Optional comma-separated layer filter, for example ProblemLayer,MethodLayer,ConstraintLayer. |
| `layerMode` | optional | string (any, intra, cross) | Restrict brainstorming to any, intra-layer, or cross-layer edges. Default: `"any"`. Allowed values: `any`, `intra`, `cross`. |

### Examples

**Run convergent brainstorming from graph evidence**

```json
{
  "corpus": "demo-corpus",
  "query": "long-tailed recognition under domain shift",
  "mode": "converge",
  "maxHops": 2,
  "limit": 6
}
```

## Tool: domain_distance

<a id="tool-domain_distance"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** None

### Function

Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | optional | string | Optional domain name to return ranked distances from. |

### Examples

**Rank source domains by graph distance**

```json
{
  "corpus": "demo-corpus",
  "targetDomain": "medical imaging"
}
```

## Tool: extract_takeaways

<a id="tool-extract_takeaways"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `targetDomain`, `agnosticChallenges`

### Function

Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | required | string | The target research domain. |
| `agnosticChallenges` | required | array&lt;string&gt; | Domain-agnostic challenge formulations to retrieve takeaways for. |
| `limit` | optional | number | Default: `8`. |
| `minDomainDistance` | optional | number | Default: `0.3`. |

### Examples

**Extract transferable takeaways for a target domain**

```json
{
  "corpus": "demo-corpus",
  "targetDomain": "robot learning",
  "agnosticChallenges": [
    "label scarcity",
    "domain shift"
  ],
  "limit": 5
}
```

## Tool: interdisciplinary_potential

<a id="tool-interdisciplinary_potential"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `targetDomain`, `query`

### Function

Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `targetDomain` | required | string | The target research domain. |
| `query` | required | string | Research problem statement or target challenge. |
| `agnosticChallenges` | optional | array&lt;string&gt; | Optional domain-agnostic challenge formulations. |
| `excludeProximalDomains` | optional | boolean | Default: `true`. |
| `limit` | optional | number | Default: `5`. |

### Examples

**Score cross-domain transfer potential**

```json
{
  "corpus": "demo-corpus",
  "targetDomain": "medical imaging",
  "query": "uncertainty-aware adaptation with scarce labels",
  "agnosticChallenges": [
    "uncertain pseudo-labels",
    "domain shift"
  ],
  "excludeProximalDomains": true,
  "limit": 5
}
```

## Tool: research_lookup

<a id="tool-research_lookup"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `operation`

### Function

Run high-level lookup operations over already committed graph state using one remote HTTP MCP surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, interdisciplinary potential, and method atlas lookups. Use literature_discovery first for fresh keyword literature search; graph lookup only sees imported papers after import tasks reach status=completed and stage=completed.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (query, context, impact, ideas, brainstorm, paper_index, domain_distance, extract_takeaways, interdisciplinary_potential, cross_domain_evidence, method_lineage, method_evidence, method_registry, research_answer) | Allowed values: `query`, `context`, `impact`, `ideas`, `brainstorm`, `paper_index`, `domain_distance`, `extract_takeaways`, `interdisciplinary_potential`, `cross_domain_evidence`, `method_lineage`, `method_evidence`, `method_registry`, `research_answer`. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `query` | optional | string | Topic, node anchor, or challenge text used by the selected lookup operation. |
| `paperId` | optional | string | Exact internal paper id used by the paper_index operation. |
| `canonicalId` | optional | string | Exact canonical paper identity key such as arxiv:..., doi:..., pmid:..., pmcid:..., or title:... |
| `sourceId` | optional | string | Exact source artifact identity key. |
| `sourceKey` | optional | string | Exact manifest sourceKey used by the paper_index operation. |
| `source` | optional | string | Exact source/input path used by the paper_index operation. |
| `paperTitle` | optional | string | Exact normalized paper title used by the paper_index operation. |
| `identifier` | optional | string | Generic identifier string used by the paper_index operation. |
| `identifierType` | optional | string (doi, arxivId, pmid, pmcid, isbn, issn) | Optional explicit identifier type used with `identifier` for paper_index. Allowed values: `doi`, `arxivId`, `pmid`, `pmcid`, `isbn`, `issn`. |
| `doi` | optional | string | Exact DOI used by the paper_index operation. |
| `arxivId` | optional | string | Exact arXiv ID used by the paper_index operation. |
| `pmid` | optional | string | Exact PMID used by the paper_index operation. |
| `pmcid` | optional | string | Exact PMCID used by the paper_index operation. |
| `isbn` | optional | string | Exact ISBN used by the paper_index operation. |
| `issn` | optional | string | Exact ISSN used by the paper_index operation. |
| `identifiers` | optional | object | Structured identifier block used by the paper_index operation. |
| `targetDomain` | optional | string | Target domain used by domain-distance and interdisciplinary operations. |
| `mechanisms` | optional | string \| array&lt;string&gt; | Optional mechanism filters for cross_domain_evidence and research_answer. |
| `method` | optional | string | Method name, alias, or Method node id used by method_lineage, method_evidence, and research_answer. |
| `methodName` | optional | string | Alternative method selector used by method_lineage, method_evidence, and research_answer. |
| `sourceMethod` | optional | string | Source/newer method selector used by method_evidence pair lookup. |
| `targetMethod` | optional | string | Target/predecessor or paired method selector used by method_evidence pair lookup. |
| `edgeId` | optional | string | Exact method evolution relationship id used by method_evidence. |
| `relationshipId` | optional | string | Alternative relationship id used by method_evidence. |
| `citationRelationshipId` | optional | string | Citation relationship id used to resolve a projected method DAG edge in method_evidence. |
| `candidateId` | optional | string | Method evolution candidate id used by method_evidence. |
| `includeCandidates` | optional | boolean | Include candidate or rejected method evidence edges in method_evidence output. Default: `false`. |
| `strictDirection` | optional | boolean | Require sourceMethod -&gt; targetMethod ordering for method_evidence pair lookup. Default: `false`. |
| `mode` | optional | string (cross_domain_evidence, method_lineage, both) | Answer mode used by research_answer. Allowed values: `cross_domain_evidence`, `method_lineage`, `both`. |
| `direction` | optional | string (backward, forward, both) | Lineage traversal direction for method_lineage. Default: `"backward"`. Allowed values: `backward`, `forward`, `both`. |
| `maxDepth` | optional | number | Maximum method lineage traversal depth. Default: `3`. |
| `numSourceDomains` | optional | number | Maximum source domains considered by cross_domain_evidence. Default: `3`. |
| `relevanceThreshold` | optional | number | Evidence threshold used by cross_domain_evidence. Default: `3`. |
| `includePacketBundle` | optional | boolean | Include the raw catalyst packet bundle in cross_domain_evidence output. Default: `false`. |
| `agnosticChallenges` | optional | array&lt;string&gt; |  |
| `excludeProximalDomains` | optional | boolean | Default: `true`. |
| `limit` | optional | number |  |
| `minDomainDistance` | optional | number |  |
| `options` | optional | object | Operation-specific options such as limit, layers, layerMode, mode, maxDepth, or maxHops. |

### Examples

**Graph query through the multiplexed lookup surface**

```json
{
  "corpus": "demo-corpus",
  "operation": "query",
  "query": "graph-based semi-supervised learning",
  "limit": 5
}
```

**Precise paper lookup by DOI**

```json
{
  "corpus": "demo-corpus",
  "operation": "paper_index",
  "doi": "10.48550/arXiv.2401.12345"
}
```

**Method lineage lookup**

```json
{
  "corpus": "demo-corpus",
  "operation": "method_lineage",
  "method": "FixMatch",
  "direction": "both",
  "maxDepth": 3
}
```

## Tool: research_briefing

<a id="tool-research_briefing"></a>

**Area:** Graph & Research Lookup

**Required top-level arguments:** `operation`

### Function

Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (path_trace, evidence_chain, reflection_chain, paper_enhancement, theory_brief, storyline_brief, research_brief, brainstorm_brief) | Allowed values: `path_trace`, `evidence_chain`, `reflection_chain`, `paper_enhancement`, `theory_brief`, `storyline_brief`, `research_brief`, `brainstorm_brief`. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `query` | optional | string | Query text for chain or brief retrieval. |
| `from` | optional | string | Starting anchor for path-trace. |
| `to` | optional | string | Ending anchor for path-trace. |
| `paperId` | optional | string | Paper id for paper-enhancement retrieval. |
| `options` | optional | object | Operation-specific options such as limit, layers, maxDepth, maxPaths, direction, or mode. |

### Examples

**Build a concise research brief**

```json
{
  "corpus": "demo-corpus",
  "operation": "research_brief",
  "query": "open-set domain adaptation",
  "options": {
    "limit": 5,
    "layers": "ProblemLayer,MethodLayer,EvidenceLayer"
  }
}
```

**Inspect one paper enhancement bundle**

```json
{
  "corpus": "demo-corpus",
  "operation": "paper_enhancement",
  "paperId": "paper:example"
}
```

## Tool: import_workflow

<a id="tool-import_workflow"></a>

**Area:** Discovery & Imports

**Required top-level arguments:** `operation`

### Function

Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to progressive logical batching with imports.batchEnabled=true, batchInitialTasks=4, and batchMaxTasks=16 unless server config explicitly disables or overrides it.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (submit, list, status, progress, queue_progress, log, wait) | Use queue_progress/status/wait to track graph-build latency after import submission. wait blocks until terminal state or timeout. Allowed values: `submit`, `list`, `status`, `progress`, `queue_progress`, `log`, `wait`. |
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
| `files` | optional | array&lt;object&gt; |  |
| `trigger` | optional | string | Default: `"mcp"`. |
| `limit` | optional | number |  |
| `taskIds` | optional | array&lt;string&gt; | Optional task ids used to filter queue_progress snapshots. |
| `timeout` | optional | number | Maximum seconds to wait for completion when operation is wait. By default this also includes the downstream authoritative graph sync job for completed imports. Default: `1800`. |
| `interval` | optional | number | Polling interval in seconds when operation is wait. Default: `2`. |
| `waitForAuthoritativeSync` | optional | boolean | When operation is wait, keep waiting after the import task completes until its authoritative graph sync job is completed, failed, or superseded. Defaults to true. |

### Examples

**Submit one server-visible file**

```json
{
  "corpus": "demo-corpus",
  "operation": "submit",
  "serverFilePath": "~/papernexus-import-staging/demo/paper.pdf",
  "doi": "10.48550/arXiv.2401.12345",
  "sourceProvider": "manual"
}
```

**Check queue progress**

```json
{
  "corpus": "demo-corpus",
  "operation": "queue_progress",
  "limit": 20
}
```

**Wait for one task before graph lookup**

```json
{
  "corpus": "demo-corpus",
  "operation": "wait",
  "taskId": "imp:example",
  "timeout": 1800,
  "interval": 15,
  "waitForAuthoritativeSync": true
}
```

## Tool: literature_discovery

<a id="tool-literature_discovery"></a>

**Area:** Discovery & Imports

**Required top-level arguments:** `operation`

### Function

Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. operation=search is a bounded metadata-only interactive path with a default deadline, query caps, partial results, and diagnostics; use operation=submit plus progress/report polling for broad or long-running searches so MCP client timeouts do not lose server-side state. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to progressive logical batching with importBatchEnabled=true, importBatchInitialTasks=4, and importBatchMaxTasks=16.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (plan, search, resolve, run, import, ingest, import_and_process, submit, progress, supplement, status, report, list) | plan/search/run/resolve produce discovery artifacts and do not by themselves make papers graph-visible. submit starts a background search/run/resolve/import job and returns a runId for progress/report polling. progress returns the running snapshot. import submits resolved full text to the import queue. ingest/import_and_process also process imports inline, but graph visibility still depends on completed import tasks. status/report/list inspect persisted discovery runs. Default: `"run"`. Allowed values: `plan`, `search`, `resolve`, `run`, `import`, `ingest`, `import_and_process`, `submit`, `progress`, `supplement`, `status`, `report`, `list`. |
| `discoveryOperation` | optional | string (search, resolve, run, import, ingest, import_and_process) | When operation=submit, the actual discovery operation to run in the background. Defaults to search. Allowed values: `search`, `resolve`, `run`, `import`, `ingest`, `import_and_process`. |
| `corpus` | optional | string | Corpus name or indexed root path. Required except for plan. |
| `topic` | optional | string | Research topic, question, related-work paragraph, seed concept, or paper title. |
| `query` | optional | string | Alias for topic. |
| `seedPapers` | optional | array&lt;object&gt; | Client-supplied seed papers. PaperNexus treats these as remote discovery/source-resolution inputs and may query by seed title or identifiers before import. |
| `seedPapers[].title` | optional | string |  |
| `seedPapers[].canonicalId` | optional | string |  |
| `seedPapers[].doi` | optional | string |  |
| `seedPapers[].arxivId` | optional | string |  |
| `seedPapers[].pmid` | optional | string |  |
| `seedPapers[].pmcid` | optional | string |  |
| `seedPapers[].year` | optional | number |  |
| `seedPapers[].venue` | optional | string |  |
| `seedPapers[].markdownUrl` | optional | string |  |
| `seedPapers[].markdownUrls` | optional | array&lt;string&gt; |  |
| `seedPapers[].pdfUrl` | optional | string |  |
| `seedPapers[].bestOaUrl` | optional | string |  |
| `seedPapers[].sourceHints` | optional | array&lt;string&gt; |  |
| `entitySeeds` | optional | array&lt;object&gt; | Client-supplied research entities extracted from seed papers, such as datasets, benchmarks, metrics, tasks, or methods. They are used as additional discovery queries, not imported as papers. |
| `entitySeeds[].name` | optional | string |  |
| `entitySeeds[].kind` | optional | string |  |
| `entitySeeds[].context` | optional | string |  |
| `entitySeeds[].sourceTitle` | optional | string |  |
| `datasetSeeds` | optional | array&lt;object&gt; | Alias for dataset-oriented entity seeds discovered in seed PDFs or source indexes. |
| `datasetSeeds[].name` | optional | string |  |
| `datasetSeeds[].context` | optional | string |  |
| `datasetSeeds[].sourceTitle` | optional | string |  |
| `benchmarkSeeds` | optional | array&lt;object&gt; | Alias for benchmark-oriented entity seeds discovered in seed PDFs or source indexes. |
| `benchmarkSeeds[].name` | optional | string |  |
| `benchmarkSeeds[].context` | optional | string |  |
| `benchmarkSeeds[].sourceTitle` | optional | string |  |
| `seedTexts` | optional | array&lt;string \| object&gt; | Plain text or markdown extracted from seed papers. PaperNexus extracts dataset, benchmark, metric, task, and similar research entities and uses them as additional discovery queries. |
| `seedTexts[].text` | optional | string |  |
| `seedTexts[].sourceTitle` | optional | string |  |
| `maxSeedPapers` | optional | number | Maximum client-supplied seed papers accepted into the discovery candidate set. Default: `100`. |
| `maxSeedQueries` | optional | number | Maximum seed-title/identifier queries added to the provider plan. Default: `40`. |
| `maxSeedEntities` | optional | number | Maximum client-supplied research entities accepted into the discovery query set. Default: `80`. |
| `maxExtractedEntities` | optional | number | Maximum research entities extracted from supplied seed text or source index text. Default: `80`. |
| `maxEntityQueries` | optional | number | Maximum dataset/benchmark/entity queries added to the provider plan. Default: `40`. |
| `depth` | optional | string (quick, default, deep) | Default: `"deep"`. Allowed values: `quick`, `default`, `deep`. |
| `discipline` | optional | string | Optional discipline hint such as computer-science, biomedicine, physics-math, chemistry-materials, economics-social-science, humanities-law, or chinese-scholarship. |
| `providers` | optional | string \| array&lt;string&gt; | Provider allow-list. Default providers are openalex, semantic_scholar, crossref, and arxiv. Implemented opt-in providers include papers_cool, pasa, europe_pmc, pubmed, dblp, and core; unpaywall is used during source resolution. |
| `maxQueries` | optional | number | Maximum query families to execute after LLM planning and deterministic fallback expansion. For operation=search, defaults by searchMode are quick=4, balanced=6, and deep=10. |
| `searchMode` | optional | string (quick, balanced, deep) | Latency/recall profile for operation=search. quick uses the smallest budget and query cap; balanced is a moderate bounded search; deep is the default broader profile aligned with the 10-minute HTTP MCP request budget. Default: `"deep"`. Allowed values: `quick`, `balanced`, `deep`. |
| `searchBudgetMs` | optional | number | Soft wall-clock budget for operation=search. Defaults by searchMode are quick=25000, balanced=45000, and deep=600000. When exhausted, PaperNexus stops scheduling new provider queries and returns partial metadata results with diagnostics. Default: `600000`. |
| `maxQueriesPerProvider` | optional | number | Maximum generated discovery queries sent to each provider. For operation=search, defaults to 2 in quick mode and 3 in balanced/deep mode. |
| `returnPartial` | optional | boolean | Return completed provider results with partial/diagnostics metadata when budget, timeout, query cap, or provider rate-limit truncates discovery. Default: `true`. |
| `planningMode` | optional | string (rule_based, llm_augmented) | Query planning mode. operation=search defaults to rule_based unless llmQueryPlanner=true or planningMode=llm_augmented is explicit; non-search discovery keeps the configured LLM planner behavior. Allowed values: `rule_based`, `llm_augmented`. |
| `llmQueryPlanner` | optional | boolean | Use the configured LLM to split the topic into orthogonal literature-search queries before deterministic query expansion. Defaults to true for non-search discovery; operation=search defaults to false unless explicitly enabled. Missing, timing out, or failing LLM config falls back to deterministic planning. Default: `true`. |
| `maxLlmQueries` | optional | number | Maximum LLM-planned orthogonal queries inserted before deterministic expansion. Defaults by depth are quick=3, default=4, deep=8; operation=search caps these to quick=2, balanced=2, and deep=4. Default: `4`. |
| `llmProvider` | optional | string | Optional LLM provider override for query planning, such as deepseek, openai, anthropic, or ollama. Defaults to PaperNexus llm config. |
| `llmModel` | optional | string | Optional LLM model override for query planning. Defaults to PaperNexus llm config. |
| `llmBaseUrl` | optional | string | Optional LLM API base URL override for query planning. Defaults to PaperNexus llm config. |
| `maxResultsPerQuery` | optional | number | Maximum provider results per query. Default: `20`. |
| `maxCandidates` | optional | number | Maximum merged candidates retained in the run. Defaults by depth: quick=80, default=240, deep=3000. |
| `providerConcurrency` | optional | number | Maximum concurrent literature search providers. Capped at 4. Default: `4`. |
| `providerRequestSchedulerDelayMs` | optional | number | Optional shared scheduler delay between request starts for providers that do not have a provider-specific delay. Default: `0`. |
| `providerRequestMaxConcurrent` | optional | number | Maximum concurrent HTTP requests per generic provider inside the shared discovery scheduler. Default: `4`. |
| `discoveryRequestCache` | optional | boolean | Enable in-process discovery HTTP response caching for successful deterministic provider requests. Default: `false`. |
| `discoveryRequestCacheTtlMs` | optional | number | TTL for the opt-in in-process discovery request cache. Default: `0`. |
| `openAlexRequestDelayMs` | optional | number | Optional shared scheduler delay between OpenAlex request starts. Defaults to 0 unless configured by environment. Default: `0`. |
| `openAlexMaxConcurrent` | optional | number | Maximum concurrent OpenAlex HTTP requests inside the shared discovery scheduler. Default: `4`. |
| `semanticScholarRequestDelayMs` | optional | number | Optional Semantic Scholar request-start delay shared across search and citation expansion. Defaults to the existing Semantic Scholar delay configuration. Default: `1000`. |
| `semanticScholarMaxConcurrent` | optional | number | Maximum concurrent Semantic Scholar HTTP requests inside the shared discovery scheduler. Default: `1`. |
| `papersCoolBaseUrl` | optional | string | Optional papers.cool base URL override. Defaults to https://papers.cool. |
| `papersCoolSort` | optional | number | papers.cool search ordering: 0 for time order, 1 for reading-star order. Default: `0`. |
| `papersCoolMaxQueries` | optional | number | Maximum discovery queries sent to papers.cool per run to avoid over-querying the local/web provider. Default: `4`. |
| `pasaApiBaseUrl` | optional | string | Optional PASA paper-agent API base URL override. Defaults to https://pasa-agent.ai/paper-agent/api/v1. |
| `pasaRequestTimeoutMs` | optional | number | Maximum timeout in milliseconds for one PASA API request. Default: `20000`. |
| `pasaTimeoutSeconds` | optional | number | Maximum PASA polling time per query. Default: `30`. |
| `pasaPollIntervalSeconds` | optional | number | PASA polling interval per query. Default: `1`. |
| `pasaMaxQueries` | optional | number | Maximum discovery queries sent to PASA per run because PASA is slower and rate-limited. Default: `2`. |
| `maxDownloads` | optional | number | Maximum legal open source downloads attempted during resolution. Markdown is attempted before PDF when available. Default: `12`. |
| `downloadConcurrency` | optional | number | Maximum concurrent legal Markdown/PDF source-resolution downloads. Capped at 4. Default: `4`. |
| `preferMarkdown` | optional | boolean | When true (default), resolve and ingest explicit Markdown sources before trying PDF fallback. Generated third-party arXiv Markdown URLs require generateArxivMarkdownSources=true. Default: `true`. |
| `generateArxivMarkdownSources` | optional | boolean | When true, generate third-party arXiv Markdown fallback URLs for candidates with an arXiv ID before falling back to arXiv PDF. Default: `false`. |
| `markdownStagingRoot` | optional | string | Optional local directory for downloaded discovery Markdown sources. Defaults to the corpus discovery markdown staging directory. |
| `pdfStagingRoot` | optional | string | Optional local directory for downloaded discovery PDF fallback sources. Defaults to the corpus discovery PDF staging directory. |
| `allowDownloads` | optional | boolean | When false, keep Markdown/PDF URLs and institutional access hints but do not download files. Default: `true`. |
| `candidateId` | optional | string | Candidate id to supplement in a persisted discovery run. |
| `canonicalId` | optional | string | Canonical paper id to supplement in a persisted discovery run, such as arxiv:2501.00001 or doi:10.xxxx/example. |
| `sourcePath` | optional | string | For operation=supplement, absolute local .md, .markdown, or .pdf path on the PaperNexus server. |
| `sourceKind` | optional | string (markdown, pdf) | Optional explicit source kind for operation=supplement. Allowed values: `markdown`, `pdf`. |
| `sourceProvider` | optional | string | Optional full-text source provider for operation=supplement, such as hf, arxiv2md-api, markxiv, arxiv2md, or manual_supplement. |
| `markdownUrl` | optional | string | For seeds or operation=supplement, HTTP(S) URL that returns validated paper Markdown. |
| `pdfUrl` | optional | string | For seeds or operation=supplement, HTTP(S) URL that returns a valid PDF fallback. |
| `paperMetadata` | optional | object | For operation=supplement, optional title/authors/year/identifier corrections to merge before import. |
| `citationExpansion` | optional | boolean | Expand top seed papers through Semantic Scholar references/citations. Defaults to true only for depth=deep. Default: `false`. |
| `maxCitationSeeds` | optional | number | Maximum seed papers used for citation expansion. Default: `3`. |
| `maxCitationsPerSeed` | optional | number | Maximum references and citations retained per seed during citation expansion. Default: `5`. |
| `openAlexRelatedExpansion` | optional | boolean | Expand top seed papers through OpenAlex related_works during citation expansion. Default: `true`. |
| `maxRelatedPerSeed` | optional | number | Maximum OpenAlex related_works retained per seed during citation expansion. Default: `5`. |
| `importResolved` | optional | boolean | Submit resolved local full-text sources to the import queue after discovery. This accepts work into the queue; use processImports or import_workflow wait/status before treating papers as graph-visible. Default: `false`. |
| `processImports` | optional | boolean | After submitting resolved sources, synchronously run the import worker so downloaded PDFs are parsed and fast-committed into the graph. Use this only when the caller intentionally wants to wait for graph visibility; it can be long-running. Default: `false`. |
| `importBatchEnabled` | optional | boolean | Enable worker-side logical batching for inline import processing triggered by ingest, import_and_process, or processImports. Defaults to true for MCP so multiple submitted tasks can share one LLM optimization and fast commit. Server background workers use the same default unless imports.batchEnabled is explicitly set. Default: `true`. |
| `importBatchMaxTasks` | optional | number | Maximum import tasks to reserve into one logical batch during inline import processing. Defaults to 16 and is hard-capped at 16. Default: `16`. |
| `importBatchInitialTasks` | optional | number | Initial progressive import batch target used before queued work proves sustained. Defaults to 4. Default: `4`. |
| `importBatchProgressive` | optional | boolean | Grow inline import batch targets from importBatchInitialTasks up to importBatchMaxTasks while pending work remains. Defaults to true. Default: `true`. |
| `importMaxPasses` | optional | number | Maximum import queue tasks to process inline when processImports is true. Defaults to the number of newly submitted tasks. Default: `20`. |
| `maxImported` | optional | number | Maximum resolved full-text sources to submit when importResolved is true. Metadata-only candidates remain in discovery artifacts but are not graph-visible until materialized through import. Default: `20`. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction mode for inline import processing. Allowed values: `auto`, `heuristic-only`, `llm-assisted`, `llm-primary`. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Optional PDF parser override for inline import processing. Allowed values: `markitdown`, `markpdfdown`, `opendataloader`, `docling`, `marker`, `mineru`, `paddleocr-vl`. |
| `pdfCommand` | optional | string | Optional generic PDF parser command override for inline import processing. |
| `doclingCommand` | optional | string | Optional Docling command override for inline import processing. |
| `pythonCommand` | optional | string | Optional Python command override for inline import processing. |
| `mailto` | optional | string | Contact email used for polite API calls and Unpaywall. If omitted, literatureDiscovery.mailto, PAPERNEXUS_DISCOVERY_MAILTO, or PAPERNEXUS_IDENTIFIER_RESOLUTION_MAILTO is used when available. |
| `openAlexApiKey` | optional | string | Optional OpenAlex API key. If omitted, literatureDiscovery.openAlexApiKey, openAlexApiKeyFile, OPENALEX_API_KEY, or ~/.papernexus/openalex_api_key is used when available. |
| `openAlexApiKeyFile` | optional | string | Optional local file containing the OpenAlex API key. Supports ~/ paths and can also be configured as literatureDiscovery.openAlexApiKeyFile. |
| `semanticScholarApiKey` | optional | string | Optional Semantic Scholar Graph API key. If omitted, literatureDiscovery.semanticScholarApiKey, SEMANTIC_SCHOLAR_API_KEY, or S2_API_KEY is used when available. |
| `coreApiKey` | optional | string | Optional CORE API key. If omitted, literatureDiscovery.coreApiKey or CORE_API_KEY is used when available. |
| `timeoutMs` | optional | number | Per-request timeout in milliseconds. Default: `8000`. |
| `retryCount` | optional | number | Retry count for transient provider failures such as HTTP 429 and 5xx responses. Default: `1`. |
| `retryBackoffMs` | optional | number | Base retry backoff in milliseconds for transient provider failures. Default: `250`. |
| `providerRequestDelayMs` | optional | number | Minimum delay between consecutive queries sent to the same provider. Set to 0 for fast local tests; keep nonzero for public APIs to reduce HTTP 429s. Default: `250`. |
| `maxRetryAfterMs` | optional | number | Maximum Retry-After delay respected before a provider request fails fast. Default: `10000`. |
| `institutionalResolverBaseUrl` | optional | string | Optional campus library/OpenURL resolver URL. PaperNexus records resolver hints; it does not bypass authentication or paywalls. |
| `institutionalAccessMode` | optional | string (hints-only, browser, headless-browser, browser-session) | Authorized institutional access handling mode. Use headless-browser/browser-session to try a Playwright persistent browser profile after open-access download paths fail; SSO and captcha pages are recorded as manual barriers, not thrown. Default: `"hints-only"`. Allowed values: `hints-only`, `browser`, `headless-browser`, `browser-session`. |
| `browserProfileDir` | optional | string | Optional browser user data directory for institutional browser-session downloads. Defaults to the selected browser channel profile root, such as Microsoft Edge User Data. |
| `browserProfileName` | optional | string | Browser profile name inside browserProfileDir for browser-session downloads. Default: `"Default"`. |
| `browserChannel` | optional | string | Playwright browser channel for browser-session downloads, usually msedge or chrome. Default: `"msedge"`. |
| `browserExecutablePath` | optional | string | Optional Chromium/Chrome executable path for browser-session downloads. When set, it overrides browserChannel; useful on headless servers with a Playwright browser cache. |
| `browserHeadless` | optional | boolean | Run the persistent browser-session downloader in headless mode. Default: `true`. |
| `browserDownloadTimeoutMs` | optional | number | Per-page/per-request timeout for browser-session PDF download attempts. Default: `12000`. |
| `browserAuthHosts` | optional | array&lt;string&gt; | Institution SSO host fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `browserAuthUrlFragments` | optional | array&lt;string&gt; | Institution SSO URL fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `browserAuthPageTitles` | optional | array&lt;string&gt; | Institution SSO page-title fragments that should be recorded as manual auth redirects during browser-session downloads. |
| `runId` | optional | string | Discovery run id for progress/status/report or supplement operations. If omitted for progress/status/report, the latest run/progress snapshot is used. |
| `limit` | optional | number | Maximum runs returned by list. |
| `persist` | optional | boolean | Persist discovery artifacts under the corpus .papernexus directory. Default: `true`. |

### Examples

**Fast metadata discovery**

```json
{
  "corpus": "demo-corpus",
  "operation": "search",
  "topic": "open-world semi-supervised learning",
  "searchMode": "balanced",
  "maxQueries": 4,
  "maxResultsPerQuery": 10,
  "maxCandidates": 20
}
```

**Resolve sources and submit imports with progressive batching**

```json
{
  "corpus": "demo-corpus",
  "operation": "import",
  "topic": "uncertainty-aware domain adaptation",
  "importResolved": true,
  "processImports": true,
  "importBatchEnabled": true,
  "importBatchInitialTasks": 4,
  "importBatchMaxTasks": 16,
  "importBatchProgressive": true,
  "maxImported": 8
}
```

## Tool: idea_catalyst

<a id="tool-idea_catalyst"></a>

**Area:** Ideation & Agent Materials

**Required top-level arguments:** `problem`, `targetDomain`

### Function

Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle with v2 innovation artifacts: must-cite set, novelty certificate, review packet, storyline DAG, and counterfactual falsification plans.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `problem` | required | string | Research problem statement to analyze. |
| `targetDomain` | required | string | Target domain that needs cross-domain inspiration. |
| `mode` | optional | string (graph, live_discovery, hybrid) | graph uses the existing indexed corpus. live_discovery runs the paper-faithful Semantic Scholar Snippets workflow. hybrid returns graph output plus live discovery output. Default: `"graph"`. Allowed values: `graph`, `live_discovery`, `hybrid`. |
| `liveDiscovery` | optional | boolean | Alias for mode=live_discovery. Default: `false`. |
| `fineGrainedDomain` | optional | string | Optional finer-grained target domain label used in the staged packet bundle. |
| `coarseGrainedDomain` | optional | string | Optional coarse-grained target domain label used in the staged packet bundle. |
| `mechanisms` | optional | string \| array&lt;string&gt; |  |
| `numSourceDomains` | optional | number | Default: `3`. |
| `numQuestions` | optional | number | Maximum target-domain research questions in live_discovery mode. Default: `4`. |
| `maxPapersPerQuery` | optional | number | Maximum Semantic Scholar snippet results per target/source query in live_discovery mode. Default: `20`. |
| `sourceRelevanceThreshold` | optional | number | Paper-level relevance majority threshold for retaining a source domain in live_discovery mode. Default: `0.5`. |
| `targetFieldOfStudy` | optional | string | Optional Semantic Scholar coarse field override for the target domain, such as Computer Science or Medicine. |
| `year` | optional | string | Optional Semantic Scholar publication year filter for live_discovery mode, such as 2018-2024 or -2023. |
| `publicationDateOrYear` | optional | string | Optional Semantic Scholar publication date/year range for live_discovery mode. |
| `insertedBefore` | optional | string | Optional Semantic Scholar index insertion cutoff for live_discovery mode. |
| `timeCutoff` | optional | string | Optional temporal cutoff used to flag future-leakage in must-cite and novelty artifacts, such as 2024 or 2018-2024. |
| `mustCiteK` | optional | number | Maximum number of must-cite prior-art entries to surface in v2 innovation artifacts. Default: `8`. |
| `reviewerPanel` | optional | string \| array&lt;string&gt; | Optional reviewer roles for the structured review packet, for example novelty, methods, reproducibility, outsider. |
| `storylineMode` | optional | string | Optional storyline DAG mode. Defaults to claim_review_storyline. |
| `writeBack` | optional | boolean | When true, generates a schema-aware innovation writeback preview from v2 artifacts. The default is dry-run validation; it does not save unless writeBackApply=true, writeBackMode=apply, or writeBackDryRun=false. Default: `false`. |
| `writeBackDryRun` | optional | boolean | When writeBack=true, keep graph mutation writeback in preview mode. Set false only for an explicit apply. Default: `true`. |
| `writeBackApply` | optional | boolean | Explicitly apply validated writeback mutations to the corpus graph when writeBack=true. Default: `false`. |
| `writeBackMode` | optional | string (dry_run, apply) | Controlled writeback mode for v2 innovation artifacts. Default: `"dry_run"`. Allowed values: `dry_run`, `apply`. |
| `writeBackActor` | optional | string | Short actor label recorded on writeback mutation audit properties. |
| `allowWeakEvidence` | optional | boolean | Allow weakly grounded innovation artifacts to emit preview operations. Defaults false so ungrounded claims, untraceable story beats, and future leakage block writeback. Default: `false`. |
| `counterfactualBudget` | optional | number | Maximum number of counterfactual falsification plans to produce. Default: `2`. |
| `relevanceThreshold` | optional | number | Default: `3`. |
| `limit` | optional | number | Default: `8`. |
| `outputMode` | optional | string (idea_fragments, packet_bundle) | Default: `"idea_fragments"`. Allowed values: `idea_fragments`, `packet_bundle`. |
| `selectionMode` | optional | string (default, topk, mmr, submodular, dpp) | Optional post-generation selector. Use mmr, submodular, or dpp to return a graph-grounded diversity rerank with selection_trace. Default: `"default"`. Allowed values: `default`, `topk`, `mmr`, `submodular`, `dpp`. |
| `selectionK` | optional | number | Maximum idea fragments returned when selectionMode is topk, mmr, submodular, or dpp. Default: `3`. |
| `mmrLambda` | optional | number | MMR relevance/diversity tradeoff for selectionMode=mmr. Higher values favor utility over diversity. Default: `0.65`. |
| `minEvidenceTier` | optional | string (strong, moderate) | Minimum evidence tier admitted by the selector evidence gate. Default: `"moderate"`. Allowed values: `strong`, `moderate`. |
| `requireBridgePath` | optional | boolean | When true, the selector rejects candidates without bridge path provenance. Default: `false`. |
| `includeAnalysis` | optional | boolean | Default: `false`. |

### Examples

**Graph-grounded cross-domain idea generation**

```json
{
  "corpus": "demo-corpus",
  "problem": "open-world semi-supervised learning under domain shift",
  "targetDomain": "medical imaging",
  "mode": "graph",
  "numSourceDomains": 3,
  "numQuestions": 4,
  "outputMode": "idea_fragments",
  "limit": 8
}
```

## Tool: agent_materials

<a id="tool-agent_materials"></a>

**Area:** Ideation & Agent Materials

**Required top-level arguments:** `operation`

### Function

Assemble Agent-facing research materials from committed graph/source state and manage project-level Agent overlay memory. Material operations return role-grouped packs, single-paper views, source discovery plans, negative evidence, experiment-cost snippets, innovation evidence/storyline packs, import requisitions, research-controller artifacts, and episode-local proposal graph sessions without making raw corpus graph mutations; overlay operations store paper roles, evidence carts, workflow state, and controller state outside the raw corpus graph.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `operation` | required | string (research_material_pack, innovation_evidence_pack, source_discovery_plan, paper_material_view, paper_role_overlay, evidence_cart, workflow_state, negative_evidence_pack, experiment_cost_materials, import_requisition_pack, research_controller, proposal_graph_session) | Material backend operation to run. Overlay operations write only project overlay files, never the raw corpus graph. Allowed values: `research_material_pack`, `innovation_evidence_pack`, `source_discovery_plan`, `paper_material_view`, `paper_role_overlay`, `evidence_cart`, `workflow_state`, `negative_evidence_pack`, `experiment_cost_materials`, `import_requisition_pack`, `research_controller`, `proposal_graph_session`. |
| `action` | optional | string (add, update, list, remove, get, export, status, init_task, run_round, generate_decomposition, review_decomposition, generate_candidates, propose_edges, judge_batch, select_batch, expand_evidence, execute_material_requests, record_material_results, compose_solutions, design_review, compose_innovation_briefs, generate_experiment_plan, validate_gcd_mvp) | Sub-action for paper_role_overlay, evidence_cart, workflow_state, or research_controller. Defaults: list for role/evidence operations, get for workflow_state, status for research_controller. Allowed values: `add`, `update`, `list`, `remove`, `get`, `export`, `status`, `init_task`, `run_round`, `generate_decomposition`, `review_decomposition`, `generate_candidates`, `propose_edges`, `judge_batch`, `select_batch`, `expand_evidence`, `execute_material_requests`, `record_material_results`, `compose_solutions`, `design_review`, `compose_innovation_briefs`, `generate_experiment_plan`, `validate_gcd_mvp`. |
| `dryRun` | optional | boolean | Preview write-capable overlay operations without writing files. Default: `false`. |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `project` | optional | string | Research project id used to label material packs and isolate project overlay memory. For research_controller, omitted GCD tasks default to gcd-research-controller and other tasks default to research-controller. |
| `targetDomain` | optional | string | Target research domain for source discovery and material pack grouping. |
| `targetProblem` | optional | string | Research problem statement used to generate target, near-source, and far-source material queries. |
| `problem` | optional | string | Research problem statement for proposal_graph_session; aliases targetProblem and query. |
| `runId` | optional | string | Optional stable run id for proposal_graph_session artifacts. |
| `maxRounds` | optional | integer | Maximum proposal graph controller rounds for proposal_graph_session. Default: `3`. |
| `temporalCutoff` | optional | string | Optional temporal cutoff recorded in proposal graph session input. |
| `proposalActions` | optional | array&lt;object&gt; | Optional round-0 role actions for proposal_graph_session. Actions are validated against the initial frozen graph snapshot before merge. |
| `proposalSlates` | optional | array&lt;object&gt; \| object | Optional proposal_graph_session role slates by round. Omitted round_id or snapshot_id fields are filled from the current frozen snapshot; explicit stale snapshot ids are rejected. |
| `proposalRoleId` | optional | string | Role id attached to proposalActions when proposal_graph_session wraps them into the first-round slate. |
| `evidenceRefs` | optional | array&lt;object&gt; | Optional evidence references preloaded into the proposal graph session. |
| `evidenceExport` | optional | object | Optional evidence export attached to a committed proposal bundle. |
| `allowLiveDiscovery` | optional | boolean | Proposal graph session metadata flag for explicit live-discovery opt-in. The proposal controller itself does not run live discovery implicitly. Default: `false`. |
| `allowImports` | optional | boolean | Proposal graph session metadata flag for explicit import opt-in. The proposal controller itself does not submit imports implicitly. Default: `false`. |
| `ideaComponents` | optional | string \| array&lt;string&gt; | Optional components for innovation_evidence_pack composition-collision audit, for example Absorb, Separate, Buffer, non-identifiable reporting, or prior/capacity calibration. |
| `coverageAreas` | optional | string \| array&lt;string&gt; | Optional coverage taxonomy override for innovation_evidence_pack evidence-sufficiency audit. Defaults to GCD, domain-shift GCD, open-world discovery, selective prediction, conformal risk, certified decision, label-shift-aware TTA, and calibration. |
| `query` | optional | string | Alias or fallback query for operations that accept targetProblem or paper lookup text. |
| `constraints` | optional | string \| array&lt;string&gt; | Venue, compute, data, task, or application constraints used when generating material queries. |
| `mode` | optional | string (quick, planning, deep) | Research-controller mode. quick initializes graph-only scouting artifacts, planning is the default controller pass, and deep is reserved for explicitly enabled evidence expansion. Allowed values: `quick`, `planning`, `deep`. |
| `selector` | optional | object | Optional research-controller selector settings. The MVP writes top-k, MMR, and greedy-submodular selection traces; set mmr_lambda to tune the MMR ablation/fallback. |
| `mmrLambda` | optional | number | Optional lambda for the research-controller MMR selector trace. Higher values favor utility over diversity. |
| `budget` | optional | object | Research-controller budget caps, for example max_candidate_nodes, max_edge_judgments, max_agent_calls, max_provider_queries, max_imports, and max_selected_candidates. |
| `judge` | optional | object | Research-controller judge configuration. MVP uses a single model and stores judge output as evidence only. |
| `maxPairwisePreferences` | optional | integer | Maximum bounded pairwise preference comparisons requested from the research-controller judge batch. |
| `externalInputs` | optional | object | Research-controller external inputs such as subproblem_hints, seed_papers, human_notes, and rejected_directions. |
| `approveExperimentPlanning` | optional | boolean | For research_controller action=generate_experiment_plan, explicit approval to write a plan-only experiment artifact. This does not run experiments. Default: `false`. |
| `approveMaterialRequestExecution` | optional | boolean | For research_controller action=execute_material_requests, explicit approval to execute planned agent_materials material requests. Provider/live/literature/import opt-ins still require the separate allow* approval flags. Default: `false`. |
| `allowProviderMaterialOptIns` | optional | boolean | For research_controller action=execute_material_requests, allow approved material requests to pass requested provider evidence, live discovery, or literature-discovery evidence opt-ins to the nested material executor. Does not permit import submission. Default: `false`. |
| `allowImportSubmission` | optional | boolean | For research_controller action=execute_material_requests, allow approved import_requisition/literature material requests to submit imports when the request explicitly asked for import submission. Default: `false`. |
| `allowImportProcessing` | optional | boolean | For research_controller action=execute_material_requests, allow approved literature material requests to process submitted imports when the request explicitly asked for import processing. Default: `false`. |
| `materialRequestExecutionApproval` | optional | object | Approval metadata for research_controller material request execution, such as approver, source, note, and granular allow_provider_evidence / allow_live_discovery_evidence / allow_literature_discovery / allow_import_submission / allow_import_processing flags. |
| `approvedMaterialRequestIds` | optional | array&lt;string&gt; | Optional allow-list of planned material request ids that may be executed by research_controller action=execute_material_requests. |
| `maxMaterialRequests` | optional | integer | Maximum material requests to execute in one research_controller action=execute_material_requests call. |
| `experimentPlanApproval` | optional | object | Approval metadata for research_controller experiment-plan generation, such as approver, source, and note. |
| `maxExperimentPlans` | optional | integer | Maximum number of plan-only experiment plans generated from reviewed solution sketches. |
| `maxGpuHours` | optional | number | Optional planning budget constraint recorded in experiment plans. No compute is launched. |
| `providerPolicy` | optional | object | Research-controller provider policy. Provider evidence, literature discovery, import submission, and configured controller LLM calls default to disabled unless explicitly enabled. For single-model provider calls, set enable_controller_llm=true plus controller_llm model/base_url or environment equivalents and a positive max_provider_queries budget. |
| `subproblemHints` | optional | array&lt;string&gt; | Optional research-controller subproblem hints used during deterministic foundation initialization. |
| `overwrite` | optional | boolean | When research_controller action=init_task, regenerate foundation artifacts even when controller-state.json already exists. Default: `false`. |
| `autoDiscoverSources` | optional | boolean | Compatibility flag for material-pack workflows. Source discovery is generated by default and remains read-only unless routed to import tools. Default: `true`. |
| `preferDomains` | optional | string \| array&lt;string&gt; | Preferred source domains for source_discovery_plan and research_material_pack. |
| `excludeDomains` | optional | string \| array&lt;string&gt; | Source domains to exclude from the graph-native near/far source router. |
| `nearSourceDomains` | optional | string \| array&lt;string&gt; | Explicit domains to treat as near-source method domains. |
| `farSourceDomains` | optional | string \| array&lt;string&gt; | Explicit domains to treat as far-source story domains. |
| `minDomainDistance` | optional | number | Minimum domain distance for source-router candidates before they are marked as proximal leakage. Default: `0`. |
| `maxProximalResults` | optional | number | Maximum number of below-minDomainDistance source domains kept with proximal_leakage=true. Default: `2`. |
| `sourceDomainLimit` | optional | number | Maximum source domains returned by the graph-native source router. Default: `8`. |
| `includeProviderEvidence` | optional | boolean | Opt in to bounded read-only Semantic Scholar snippet evidence for source_discovery_plan, research_material_pack, import_requisition_pack, and negative_evidence_pack. Default false to avoid implicit network calls. Default: `false`. |
| `providerEvidenceLimit` | optional | number | Maximum Semantic Scholar snippet hits retained per provider-evidence query. Default: `3`. |
| `persistProviderEvidence` | optional | boolean | When includeProviderEvidence is true, persist returned provider snippets into the project evidence cart. Requires project; default false. Default: `false`. |
| `providerEvidencePersistLimit` | optional | number | Maximum provider evidence snippets persisted into the project evidence cart when persistProviderEvidence=true. Default: `20`. |
| `providerEvidenceQueryLimit` | optional | number | Maximum generated queries sent to the provider-evidence layer. Default: `6`. |
| `providerEvidenceTimeoutMs` | optional | number | Timeout in milliseconds for each provider-evidence request. Default: `12000`. |
| `providerEvidenceFallbackToAbstract` | optional | boolean | When true, hydrate degenerate provider snippets with paper abstracts when available. Default: `false`. |
| `includeLiveDiscoveryEvidence` | optional | boolean | Opt in to bounded idea_catalyst live_discovery evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit LLM and network calls. Default: `false`. |
| `runLiveIdeaCatalystIfNeeded` | optional | boolean | Opt in to running bounded idea_catalyst live_discovery only when requested roles are sparse in the committed graph. Default false to avoid implicit LLM and network calls. Default: `false`. |
| `liveDiscoveryFallbackIfSparse` | optional | boolean | Alias for runLiveIdeaCatalystIfNeeded; runs live discovery only when committed-graph role evidence is sparse. Default: `false`. |
| `liveDiscoverySparseRoleThreshold` | optional | number | Number of sparse requested roles required before runLiveIdeaCatalystIfNeeded triggers live discovery. Default: `1`. |
| `liveDiscoverySparseMinScore` | optional | number | Minimum committed-graph search score counted as non-sparse for runLiveIdeaCatalystIfNeeded. Default: `0.05`. |
| `persistLiveDiscoveryEvidence` | optional | boolean | When includeLiveDiscoveryEvidence is true, persist returned live-discovery spans/fragments into the project evidence cart. Requires project; default false. Default: `false`. |
| `liveDiscoveryNumQuestions` | optional | number | Maximum target research questions used by opt-in live discovery evidence. Default: `1`. |
| `liveDiscoverySourceDomainLimit` | optional | number | Maximum source domains used by opt-in live discovery evidence. Default: `2`. |
| `liveDiscoveryMaxPapersPerQuery` | optional | number | Maximum Semantic Scholar snippet papers retrieved per live-discovery query. Default: `5`. |
| `liveDiscoverySourceRelevanceThreshold` | optional | number | Paper-level source relevance ratio threshold used by opt-in live discovery evidence. Default: `0.5`. |
| `liveDiscoveryIdeaFragmentLimit` | optional | number | Maximum idea fragments retained from opt-in live discovery evidence. Default: `3`. |
| `liveDiscoveryPersistLimit` | optional | number | Maximum live-discovery spans/fragments persisted into the project evidence cart when persistLiveDiscoveryEvidence=true. Default: `20`. |
| `liveDiscoveryTimeoutMs` | optional | number | Timeout in milliseconds for each live-discovery provider request. Default: `12000`. |
| `includeLiteratureDiscoveryEvidence` | optional | boolean | Opt in to bounded literature_discovery search/resolve evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit network/download work. Default: `false`. |
| `runLiteratureDiscoveryIfSparse` | optional | boolean | Opt in to running bounded literature_discovery only when requested roles are sparse in the committed graph. Default false. Default: `false`. |
| `literatureDiscoveryFallbackIfSparse` | optional | boolean | Alias for runLiteratureDiscoveryIfSparse; runs literature_discovery only when committed-graph role evidence is sparse. Default: `false`. |
| `literatureDiscoverySeedProviderPapers` | optional | boolean | When both provider evidence and literature-discovery evidence are enabled, pass provider snippet hits into literature_discovery as exact seed papers. Default false. Default: `false`. |
| `literatureDiscoveryProviderSeedLimit` | optional | number | Maximum provider evidence hits passed into literature_discovery as exact seed papers. Default: `8`. |
| `literatureDiscoverySeedLivePapers` | optional | boolean | When both live-discovery and literature-discovery evidence are enabled, pass live-discovery supporting papers into literature_discovery as exact seed papers. Default false. Default: `false`. |
| `literatureDiscoveryLiveSeedLimit` | optional | number | Maximum live-discovery supporting papers passed into literature_discovery as exact seed papers. Default: `8`. |
| `literatureDiscoveryResolveSources` | optional | boolean | Resolve legal full-text sources during opt-in literature discovery evidence. Default true; set false for metadata-only discovery. Default: `true`. |
| `literatureDiscoveryAllowDownloads` | optional | boolean | Allow opt-in literature discovery source resolution to stage legal markdown/open-PDF downloads. Default true when literature discovery evidence is enabled. Default: `true`. |
| `submitLiteratureDiscoveryImports` | optional | boolean | Submit resolved literature_discovery full-text sources to the import queue from agent_materials. Default false; use import_workflow wait/status before treating submitted papers as graph-visible. Default: `false`. |
| `processLiteratureDiscoveryImports` | optional | boolean | After submitting resolved literature_discovery sources, synchronously run the import worker so imports can become graph-visible. Default false because this can be long-running. Default: `false`. |
| `literatureDiscoveryMaxQueries` | optional | number | Maximum generated literature_discovery queries when opt-in evidence is enabled. Default: `4`. |
| `literatureDiscoveryMaxResultsPerQuery` | optional | number | Maximum provider results retained per literature_discovery query when opt-in evidence is enabled. Default: `8`. |
| `literatureDiscoveryMaxCandidates` | optional | number | Maximum merged literature_discovery candidates retained when opt-in evidence is enabled. Default: `16`. |
| `literatureDiscoveryMaxDownloads` | optional | number | Maximum legal full-text downloads staged by opt-in literature_discovery source resolution. Default: `6`. |
| `literatureDiscoveryMaxImported` | optional | number | Maximum resolved full-text sources submitted when submitLiteratureDiscoveryImports is true. Default: `4`. |
| `literatureDiscoveryImportMaxPasses` | optional | number | Maximum import worker passes when processLiteratureDiscoveryImports is true. Default: `4`. |
| `literatureDiscoveryImportBatchEnabled` | optional | boolean | Enable worker-side logical batching for inline literature_discovery import processing triggered by processLiteratureDiscoveryImports. Default: `true`. |
| `literatureDiscoveryImportBatchMaxTasks` | optional | number | Maximum import tasks to reserve into one logical batch for inline literature_discovery import processing. Default: `8`. |
| `timeWindow` | optional | string | Optional time-window label recorded in negative_evidence_pack filters. |
| `roles` | optional | string \| array&lt;string&gt; | Requested material roles, for example target_prior, near_source_method, far_source_story, novelty_risk, or baseline_candidate. |
| `role` | optional | string | Single-role alias for roles. |
| `roleId` | optional | string | Stable project overlay role id for paper_role_overlay update/remove. |
| `layer` | optional | string | Optional source layer for paper role overlay, for example target_domain, near_source, or far_source. |
| `judgmentType` | optional | string | Optional Agent judgment type saved in project overlay, for example closest_prior or novelty_risk_note. |
| `confidence` | optional | string | Optional Agent confidence label for project overlay entries. |
| `supportingEvidenceIds` | optional | array&lt;string&gt; | Evidence ids supporting a paper role overlay entry. |
| `paperId` | optional | string | Paper id for paper_material_view. |
| `paperTitle` | optional | string | Paper title for paper_material_view or seed matching. |
| `title` | optional | string | Alias for paperTitle. |
| `sourceKey` | optional | string | Manifest sourceKey for paper_material_view. |
| `sourceType` | optional | string | Evidence-cart source type, for example chunk, graph_node, table, figure, query, or negative_evidence. |
| `sourceId` | optional | string | Evidence-cart source id, such as a chunk id, graph node id, or external query id. |
| `evidenceId` | optional | string | Stable evidence-cart id for remove or cross-linking from paper_role_overlay. |
| `itemType` | optional | string | Evidence-cart item type, for example snippet, table, figure, mechanism, paper, or negative_evidence. |
| `text` | optional | string | Evidence-cart text or short material excerpt. |
| `tags` | optional | string \| array&lt;string&gt; | Evidence-cart tags. |
| `provenance` | optional | array&lt;object&gt; | Evidence-cart provenance records. |
| `notes` | optional | string | Human or Agent notes for overlay entries. |
| `actor` | optional | string | Short label for the Agent or user writing overlay state. |
| `workflowState` | optional | object | Workflow state patch for workflow_state action=update. |
| `hypothesis` | optional | string | Current project hypothesis for workflow_state action=update. |
| `currentStage` | optional | string | Current workflow stage label for workflow_state action=update. |
| `acceptedDirections` | optional | array&lt;string&gt; | Accepted research directions for workflow_state action=update. |
| `rejectedDirections` | optional | array&lt;string&gt; | Rejected research directions for workflow_state action=update. |
| `openQuestions` | optional | array&lt;string&gt; | Open questions for workflow_state action=update. |
| `neededMaterials` | optional | array&lt;string&gt; | Needed materials for workflow_state action=update. |
| `identifier` | optional | string | Generic DOI, arXiv id, PMID, or other identifier for paper lookup. |
| `doi` | optional | string | DOI for paper lookup or seed matching. |
| `arxivId` | optional | string | arXiv id for paper lookup or seed matching. |
| `pmid` | optional | string | PMID for paper lookup or seed matching. |
| `pmcid` | optional | string | PMCID for paper lookup or seed matching. |
| `seedPapers` | optional | array&lt;object&gt; | Optional user- or Agent-provided candidate papers. Missing seeds become import requisitions in the MVP. |
| `limit` | optional | number | Maximum candidates per role or generated query group. Default: `5`. |
| `chunkLimit` | optional | number | Maximum chunk records returned by paper_material_view. Default: `8`. |
| `includeCostLlmExtraction` | optional | boolean | Opt in to bounded LLM structured extraction for experiment_cost_materials. Default false to avoid implicit LLM calls. Default: `false`. |
| `costLlmRecordLimit` | optional | number | Maximum paper material records sent to the opt-in experiment-cost LLM extractor. Default: `16`. |
| `costLlmMaxInputChars` | optional | number | Maximum characters from paper material records sent to the opt-in experiment-cost LLM extractor. Default: `12000`. |
| `costLlmProvider` | optional | string | Optional LLM provider override for opt-in experiment-cost extraction, for example deepseek, ollama, openai, or anthropic. |
| `costLlmModel` | optional | string | Optional LLM model override for opt-in experiment-cost extraction. |
| `costLlmBaseUrl` | optional | string | Optional LLM base URL override for opt-in experiment-cost extraction, including OpenAI-compatible Qwen endpoints. |
| `costLlmApiKeyEnv` | optional | string | Optional environment variable name containing the API key for opt-in experiment-cost extraction. |
| `costLlmTimeoutMs` | optional | number | Timeout in milliseconds for the opt-in experiment-cost LLM extraction request. Default: `45000`. |
| `costLlmMaxTokens` | optional | number | Maximum output tokens requested from the opt-in experiment-cost LLM extractor. Default: `1600`. |
| `outputDir` | optional | string | Optional server-local directory for JSON/Markdown exports. Omit for pure read-only response. |

### Examples

**Build a graph-first research material pack**

```json
{
  "corpus": "demo-corpus",
  "operation": "research_material_pack",
  "project": "openclaw-demo",
  "targetDomain": "medical imaging",
  "targetProblem": "domain-shifted semi-supervised segmentation",
  "mode": "planning",
  "roles": [
    "problem",
    "method",
    "evidence",
    "dataset"
  ],
  "limit": 6
}
```

**Read one paper material view**

```json
{
  "corpus": "demo-corpus",
  "operation": "paper_material_view",
  "doi": "10.48550/arXiv.2401.12345",
  "chunkLimit": 8
}
```

**Persist workflow state for an agent project**

```json
{
  "corpus": "demo-corpus",
  "operation": "workflow_state",
  "action": "update",
  "project": "openclaw-demo",
  "workflowState": {
    "currentStage": "evidence_expansion",
    "openQuestions": [
      "Which source domains provide robust pseudo-labeling evidence?"
    ]
  }
}
```

## Tool: mutate_graph

<a id="tool-mutate_graph"></a>

**Area:** Operations & Maintenance

**Required top-level arguments:** `operations`

### Function

Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or indexed root path. Optional if only one corpus is indexed. |
| `actor` | optional | string | Short label for the editing agent or workflow. |
| `dryRun` | optional | boolean | When true, validate and preview the mutation without saving changes. Default: `true`. |
| `operations` | required | array&lt;object&gt; | Mutation operations to apply in order. |
| `operations[].action` | required in parent | string (upsert_node, delete_node, upsert_relationship, delete_relationship, create_node, update_node, create_relationship, update_relationship, create, create_edge) | Mutation action. create/update/create_edge aliases map to upsert. Bare "create" auto-detects node vs relationship from fields. Allowed values: `upsert_node`, `delete_node`, `upsert_relationship`, `delete_relationship`, `create_node`, `update_node`, `create_relationship`, `update_relationship`, `create`, `create_edge`. |
| `operations[].id` | optional | string | Optional explicit node or relationship id. |
| `operations[].match` | optional | object | Node reference for update/delete. Use {id} or {type,name}. |
| `operations[].type` | optional | string | Node type for node operations, or relationship type for relationship operations. Aliases: nodeType (for nodes), edgeType or relationType (for relationships). |
| `operations[].nodeType` | optional | string | Alias for type in node operations. |
| `operations[].edgeType` | optional | string | Alias for type in relationship operations. |
| `operations[].name` | optional | string | Node name for node upserts. |
| `operations[].properties` | optional | object | Arbitrary node or relationship properties to merge. |
| `operations[].replaceProperties` | optional | boolean | Replace properties instead of merging them. Default: `false`. |
| `operations[].source` | optional | object | Relationship source reference. Use {id} or {type,name}. |
| `operations[].target` | optional | object | Relationship target reference. Use {id} or {type,name}. |
| `operations[].from` | optional | object \| string | Alias for source. Can be {id} or {type,name} object, or a name string. |
| `operations[].to` | optional | object \| string | Alias for target. Can be {id} or {type,name} object, or a name string. |
| `operations[].bidirectional` | optional | boolean | For symmetric relations like COMBINES_WITH or RELATED_TO, also create/delete the reverse edge. Default: `false`. |

### Examples

**Dry-run a curated node write**

```json
{
  "corpus": "demo-corpus",
  "actor": "docs-example",
  "dryRun": true,
  "operations": [
    {
      "action": "upsert_node",
      "type": "Problem",
      "name": "Label scarcity under domain shift",
      "properties": {
        "source": "manual-review",
        "confidence": "moderate"
      }
    }
  ]
}
```

**Dry-run a relationship write**

```json
{
  "corpus": "demo-corpus",
  "dryRun": true,
  "operations": [
    {
      "action": "upsert_relationship",
      "type": "ADDRESSES",
      "source": {
        "type": "Method",
        "name": "Consistency regularization"
      },
      "target": {
        "type": "Problem",
        "name": "Label scarcity under domain shift"
      },
      "properties": {
        "evidence": "manual-review"
      }
    }
  ]
}
```

## Tool: runtime_init

<a id="tool-runtime_init"></a>

**Area:** Operations & Maintenance

**Required top-level arguments:** `corpus`

### Function

Initialize or update the PaperNexus runtime config non-interactively over MCP, equivalent to papernexus init for server-side paths. This writes config only; call create_corpus for the first graph build.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `sourceInputs` | optional | array&lt;string&gt; | Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the MCP server. Omit or pass an empty array to initialize an empty corpus config. |
| `sources` | optional | array \| string | Alias for sourceInputs. Strings may be comma-separated. |
| `corpus` | required | string | Friendly corpus name to write into analyze.name and global.corpus. |
| `corpusName` | optional | string | Alias for corpus. |
| `indexDir` | optional | string | Directory where the generated .papernexus index should live. Defaults to the existing storage.indexDir or ~/.papernexus/index-store. |
| `rootPath` | optional | string | Alias for indexDir. |
| `configPath` | optional | string | Optional runtime config path to create or update. If omitted, the default PaperNexus runtime config is used. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Default PDF parser to write into analyze.pdfParser. Default: `"markitdown"`. Allowed values: `markitdown`, `markpdfdown`, `opendataloader`, `docling`, `marker`, `mineru`, `paddleocr-vl`. |
| `serveHost` | optional | string | Default serve host to write into serve.host. Default: `"127.0.0.1"`. |
| `servePort` | optional | number | Default serve port to write into serve.port. Default: `4821`. |
| `serveMcpEnabled` | optional | boolean | When provided, write serve.mcp.enabled for HTTP MCP serving. |
| `serveMcpPath` | optional | string | When provided, write serve.mcp.path. Relative values are normalized with a leading slash. |
| `llm` | optional | object | Optional LLM config metadata. Raw API keys are intentionally rejected; use apiKeyEnv or keychain metadata. |
| `llm.provider` | optional | string (ollama, openai, deepseek, anthropic) | LLM provider. Allowed values: `ollama`, `openai`, `deepseek`, `anthropic`. |
| `llm.model` | optional | string | Model identifier exposed by the provider. |
| `llm.baseUrl` | optional | string | Provider API base URL. |
| `llm.relations` | optional | boolean | Enable LLM-assisted relation extraction. |
| `llm.apiKeyEnv` | optional | string | Environment variable name containing the API key. |
| `llm.apiKeySource` | optional | string (keychain) | Secure API key source metadata. Allowed values: `keychain`. |
| `llm.apiKeyService` | optional | string | Keychain service name when apiKeySource is keychain. |
| `llm.apiKeyAccount` | optional | string | Keychain account name when apiKeySource is keychain. |
| `llm.sshHost` | optional | string | Optional SSH host for remote LLM access. |
| `llm.timeoutMs` | optional | number | Optional LLM request timeout. |
| `llm.batchSize` | optional | number | Optional LLM batch size. |
| `llm.maxTokens` | optional | number | Optional LLM max tokens. |

### Examples

**Initialize runtime metadata without raw secrets**

```json
{
  "corpus": "demo-corpus",
  "indexDir": "~/.papernexus/index-store/demo-corpus",
  "sourceInputs": [
    "~/papers/demo-corpus"
  ],
  "serveHost": "127.0.0.1",
  "servePort": 4821,
  "llm": {
    "provider": "openai",
    "model": "qwen-plus",
    "baseUrl": "https://api.example.com/v1",
    "relations": true,
    "apiKeyEnv": "PAPERNEXUS_LLM_API_KEY",
    "batchSize": 16
  }
}
```

## Tool: create_corpus

<a id="tool-create_corpus"></a>

**Area:** Operations & Maintenance

**Required top-level arguments:** None

### Function

Create the first committed corpus graph over MCP from server-visible source files/directories or create an empty graph when no sources are provided, equivalent to the first papernexus analyze --name run. Source-backed builds default to a background job to avoid MCP client timeouts; use operation=status or operation=wait with the returned jobId. Use refresh_corpus for later maintenance.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `sourceInputs` | optional | array&lt;string&gt; | Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the MCP server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the server. If omitted, configured sources.inputs are used; if no inputs are configured, an empty corpus graph is created. |
| `sources` | optional | array \| string | Alias for sourceInputs. Strings may be comma-separated. |
| `sourceRoot` | optional | string | Alias for a single source input path. |
| `inputPath` | optional | string | Alias for a single source input path. |
| `corpus` | optional | string | Friendly corpus name. If omitted, configured analyze.name or global.corpus is used. |
| `corpusName` | optional | string | Alias for corpus. |
| `rootPath` | optional | string | Index root where the .papernexus directory is created. If omitted, configured storage.indexDir or the analyze default is used. |
| `indexDir` | optional | string | Alias for rootPath. |
| `configPath` | optional | string | Optional runtime config path to read defaults from. |
| `force` | optional | boolean | Force a full build even if cached corpus state exists. Default: `false`. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction override for the first build. Allowed values: `auto`, `heuristic-only`, `llm-assisted`, `llm-primary`. |
| `rebuildPdfMarkdown` | optional | boolean | When true, force PDF markdown regeneration during the first build. |
| `pdfParser` | optional | string (markitdown, markpdfdown, opendataloader, docling, marker, mineru, paddleocr-vl) | Optional PDF parser override for the first build. Allowed values: `markitdown`, `markpdfdown`, `opendataloader`, `docling`, `marker`, `mineru`, `paddleocr-vl`. |
| `pdfCommand` | optional | string | Optional generic PDF parser command override for the first build. |
| `concurrency` | optional | number | Optional source analysis concurrency override. |
| `analyzeConcurrency` | optional | number | Alias for concurrency. |
| `llmBatchSize` | optional | number | Optional LLM batch size override. |
| `batchSize` | optional | number | Alias for llmBatchSize. |
| `operation` | optional | string (build, submit, status, wait) | build starts a create operation, submit always starts it as a background job, status returns a submitted job, and wait polls a submitted job until completion or waitTimeoutMs. Default: `"build"`. Allowed values: `build`, `submit`, `status`, `wait`. |
| `executionMode` | optional | string (auto, sync, async) | Execution mode for operation=build. auto runs empty corpus creation synchronously and source-backed builds asynchronously to avoid MCP client timeouts. Default: `"auto"`. Allowed values: `auto`, `sync`, `async`. |
| `async` | optional | boolean | Alias for executionMode=async when true and executionMode=sync when false. |
| `waitForCompletion` | optional | boolean | When false, alias for executionMode=async; when true, alias for executionMode=sync. |
| `jobId` | optional | string | Background create_corpus job id returned by an async build; required for operation=status or operation=wait. |
| `waitTimeoutMs` | optional | number | Maximum milliseconds for operation=wait to poll before returning the latest job state. Default: `600000`. |
| `pollIntervalMs` | optional | number | Polling interval for operation=wait. Default: `500`. |

### Examples

**Submit an asynchronous corpus build**

```json
{
  "operation": "submit",
  "corpus": "demo-corpus",
  "indexDir": "~/.papernexus/index-store/demo-corpus",
  "sourceInputs": [
    "~/papers/demo-corpus"
  ],
  "semanticExtraction": "llm-assisted",
  "llmBatchSize": 16,
  "executionMode": "async"
}
```

**Check an async build job**

```json
{
  "operation": "status",
  "jobId": "corpus-build:example"
}
```

## Tool: refresh_corpus

<a id="tool-refresh_corpus"></a>

**Area:** Operations & Maintenance

**Required top-level arguments:** None

### Function

Run corpus-scale maintenance over an indexed corpus: incremental/full analyze, Stage 1 snapshot materialization, Stage 2 batch LLM optimization, or Stage 2-5 optimize from cached snapshots.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or root path. Omit to use the default corpus. |
| `mode` | optional | string (analyze, materialize, llm_optimize, optimize) | Maintenance mode. analyze commits an updated graph, materialize writes Stage 1 snapshots only, llm_optimize runs Stage 2 batch LLM optimization over cached snapshots, and optimize resumes from cached snapshots to commit stages 2-5. Default: `"analyze"`. Allowed values: `analyze`, `materialize`, `llm_optimize`, `optimize`. |
| `incremental` | optional | boolean | Analyze mode only. When true (default), reuse unchanged sources and only refresh detected deltas. When false, force-refresh all tracked sources before recommitting the graph. Default: `true`. |
| `force` | optional | boolean | Force the selected maintenance mode even when cached state looks reusable. Default: `false`. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction override for analyze, llm_optimize, optimize, or refresh-materialize compatibility flows. Allowed values: `auto`, `heuristic-only`, `llm-assisted`, `llm-primary`. |
| `rebuildPdfMarkdown` | optional | boolean | When true, force PDF markdown regeneration before re-materialization for affected PDF sources. |
| `llmBatchSize` | optional | number | Optional Stage 2 batch size override for llm_optimize or optimize. |
| `batchSize` | optional | number | Alias for llmBatchSize. |
| `changedSourceKeys` | optional | array&lt;string&gt; | Optional sourceKey scope for llm_optimize or optimize. When provided, only those manifest sources are refreshed during Stage 2 before the rest of the corpus state is reused. |

### Examples

**Run corpus LLM optimization with max batch 16**

```json
{
  "corpus": "demo-corpus",
  "mode": "llm_optimize",
  "incremental": true,
  "semanticExtraction": "llm-assisted",
  "llmBatchSize": 16
}
```

**Refresh only changed source keys**

```json
{
  "corpus": "demo-corpus",
  "mode": "optimize",
  "changedSourceKeys": [
    "source:paper-a.pdf",
    "source:paper-b.pdf"
  ],
  "batchSize": 16
}
```

## Tool: refresh_paper_graph

<a id="tool-refresh_paper_graph"></a>

**Area:** Operations & Maintenance

**Required top-level arguments:** None

### Function

Force-refresh the graph content for one paper or one canonical duplicate group without rebuilding the whole corpus.

### Parameters

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `corpus` | optional | string | Corpus name or root path. Omit to use the default corpus. |
| `paperId` | optional | string | Exact paperId to refresh. |
| `sourceKey` | optional | string | Exact manifest sourceKey to refresh. |
| `source` | optional | string | Exact source/input path on the server. Accepts absolute paths or ~/... paths. |
| `paperTitle` | optional | string | Exact normalized paper title to refresh. |
| `includeDuplicateGroup` | optional | boolean | When true (default), refresh and recanonicalize the entire duplicate/canonical group that contains the selected paper. Default: `true`. |
| `rebuildPdfMarkdown` | optional | boolean | When true (default), force PDF markdown regeneration for matched PDF sources before graph refresh. Default: `true`. |
| `semanticExtraction` | optional | string (auto, heuristic-only, llm-assisted, llm-primary) | Optional semantic extraction mode override for the refresh run. Allowed values: `auto`, `heuristic-only`, `llm-assisted`, `llm-primary`. |

### Examples

**Force-refresh one known paper**

```json
{
  "corpus": "demo-corpus",
  "paperId": "paper:example",
  "includeDuplicateGroup": true,
  "rebuildPdfMarkdown": true,
  "semanticExtraction": "llm-assisted"
}
```

**Refresh by exact title when paperId is unknown**

```json
{
  "corpus": "demo-corpus",
  "paperTitle": "Example Paper Title",
  "includeDuplicateGroup": true,
  "semanticExtraction": "llm-primary"
}
```
