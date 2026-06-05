export const PAPERNEXUS_TOOLS = [
  {
    name: 'list_corpora',
    description: 'List all locally indexed academic-paper corpora available to PaperNexus.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'corpus_status',
    description: 'Show corpus stats and top research problems for a specific corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        }
      },
      required: []
    }
  },
  {
    name: 'corpus_sources',
    description: 'Return source manifest entries plus per-paper graph-index and source-span provenance so remote clients can reconcile which papers are materialized in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        }
      },
      required: []
    }
  },
  {
    name: 'query',
    description: 'Search already committed research knowledge-graph state for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions. Use literature_discovery for fresh keyword/topic discovery before papers are ingested.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language or keyword query.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of grouped semantic result buckets to return.',
          default: 5
        },
        layers: {
          type: 'string',
          description: 'Optional comma-separated layer filter, for example ProblemLayer,MethodLayer.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'context',
    description: 'Get the local graph neighborhood of a paper, problem, method, claim, finding, limitation, assumption, evidence, dataset, benchmark, metric, or future-direction node.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Node name or exact node id.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        layers: {
          type: 'string',
          description: 'Optional comma-separated layer filter.'
        },
        layerMode: {
          type: 'string',
          enum: ['any', 'intra', 'cross'],
          description: 'Restrict context edges to any, intra-layer, or cross-layer edges.',
          default: 'any'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'impact',
    description: 'Traverse research graph edges to inspect upstream or downstream impact across problems, methods, claims, findings, limitations, assumptions, evidence, datasets, and benchmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Node name or exact node id.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream'],
          description: 'Traverse incoming or outgoing edges.',
          default: 'upstream'
        },
        maxDepth: {
          type: 'number',
          description: 'Traversal depth.',
          default: 3
        },
        layers: {
          type: 'string',
          description: 'Optional comma-separated layer filter.'
        },
        layerMode: {
          type: 'string',
          enum: ['any', 'intra', 'cross'],
          description: 'Restrict impact traversal to any, intra-layer, or cross-layer edges.',
          default: 'any'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'ideas',
    description: 'Generate candidate research directions from problem, limitation, evidence-gap, and method-transfer patterns in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Target research topic or problem statement.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of research opportunities to return.',
          default: 5
        },
        layers: {
          type: 'string',
          description: 'Optional comma-separated layer filter.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'brainstorm',
    description: 'Run a diverge or converge brainstorming pass over the multilayer research graph to surface similar problems, related concepts, constraints, transferable methods, and converged directions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Target topic, problem statement, or research question.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        mode: {
          type: 'string',
          enum: ['diverge', 'converge'],
          description: 'Use diverge to expand the search space or converge to rank candidate directions.',
          default: 'diverge'
        },
        maxHops: {
          type: 'number',
          description: 'Maximum traversal hops for brainstorming expansion.',
          default: 2
        },
        limit: {
          type: 'number',
          description: 'Maximum number of converged directions or idea candidates.',
          default: 5
        },
        layers: {
          type: 'string',
          description: 'Optional comma-separated layer filter, for example ProblemLayer,MethodLayer,ConstraintLayer.'
        },
        layerMode: {
          type: 'string',
          enum: ['any', 'intra', 'cross'],
          description: 'Restrict brainstorming to any, intra-layer, or cross-layer edges.',
          default: 'any'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'domain_distance',
    description: 'Compute the graph-derived domain distance matrix for an indexed corpus, optionally centered on a target domain.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        targetDomain: {
          type: 'string',
          description: 'Optional domain name to return ranked distances from.'
        }
      },
      required: []
    }
  },
  {
    name: 'extract_takeaways',
    description: 'Extract structured cross-domain takeaways from bridge nodes for a target domain and conceptual challenges.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        targetDomain: {
          type: 'string',
          description: 'The target research domain.'
        },
        agnosticChallenges: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain-agnostic challenge formulations to retrieve takeaways for.'
        },
        limit: {
          type: 'number',
          default: 8
        },
        minDomainDistance: {
          type: 'number',
          default: 0.3
        }
      },
      required: ['targetDomain', 'agnosticChallenges']
    }
  },
  {
    name: 'interdisciplinary_potential',
    description: 'Rank source domains by interdisciplinary potential using community structure, cross-domain bridges, and structured takeaways.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        targetDomain: {
          type: 'string',
          description: 'The target research domain.'
        },
        query: {
          type: 'string',
          description: 'Research problem statement or target challenge.'
        },
        agnosticChallenges: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional domain-agnostic challenge formulations.'
        },
        excludeProximalDomains: {
          type: 'boolean',
          default: true
        },
        limit: {
          type: 'number',
          default: 5
        }
      },
      required: ['targetDomain', 'query']
    }
  },
  {
    name: 'research_lookup',
    description: 'Run high-level lookup operations over already committed graph state using one remote HTTP MCP surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, interdisciplinary potential, and method atlas lookups. Use literature_discovery first for fresh keyword literature search; graph lookup only sees imported papers after import tasks reach status=completed and stage=completed.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'query',
            'context',
            'impact',
            'ideas',
            'brainstorm',
            'paper_index',
            'domain_distance',
            'extract_takeaways',
            'interdisciplinary_potential',
            'cross_domain_evidence',
            'method_lineage',
            'method_evidence',
            'method_registry',
            'research_answer'
          ]
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        query: {
          type: 'string',
          description: 'Topic, node anchor, or challenge text used by the selected lookup operation.'
        },
        paperId: {
          type: 'string',
          description: 'Exact internal paper id used by the paper_index operation.'
        },
        canonicalId: {
          type: 'string',
          description: 'Exact canonical paper identity key such as arxiv:..., doi:..., pmid:..., pmcid:..., or title:...'
        },
        sourceId: {
          type: 'string',
          description: 'Exact source artifact identity key.'
        },
        sourceKey: {
          type: 'string',
          description: 'Exact manifest sourceKey used by the paper_index operation.'
        },
        source: {
          type: 'string',
          description: 'Exact source/input path used by the paper_index operation.'
        },
        paperTitle: {
          type: 'string',
          description: 'Exact normalized paper title used by the paper_index operation.'
        },
        identifier: {
          type: 'string',
          description: 'Generic identifier string used by the paper_index operation.'
        },
        identifierType: {
          type: 'string',
          enum: ['doi', 'arxivId', 'pmid', 'pmcid', 'isbn', 'issn'],
          description: 'Optional explicit identifier type used with `identifier` for paper_index.'
        },
        doi: {
          type: 'string',
          description: 'Exact DOI used by the paper_index operation.'
        },
        arxivId: {
          type: 'string',
          description: 'Exact arXiv ID used by the paper_index operation.'
        },
        pmid: {
          type: 'string',
          description: 'Exact PMID used by the paper_index operation.'
        },
        pmcid: {
          type: 'string',
          description: 'Exact PMCID used by the paper_index operation.'
        },
        isbn: {
          type: 'string',
          description: 'Exact ISBN used by the paper_index operation.'
        },
        issn: {
          type: 'string',
          description: 'Exact ISSN used by the paper_index operation.'
        },
        identifiers: {
          type: 'object',
          additionalProperties: true,
          description: 'Structured identifier block used by the paper_index operation.'
        },
        targetDomain: {
          type: 'string',
          description: 'Target domain used by domain-distance and interdisciplinary operations.'
        },
        mechanisms: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Optional mechanism filters for cross_domain_evidence and research_answer.'
        },
        method: {
          type: 'string',
          description: 'Method name, alias, or Method node id used by method_lineage, method_evidence, and research_answer.'
        },
        methodName: {
          type: 'string',
          description: 'Alternative method selector used by method_lineage, method_evidence, and research_answer.'
        },
        sourceMethod: {
          type: 'string',
          description: 'Source/newer method selector used by method_evidence pair lookup.'
        },
        targetMethod: {
          type: 'string',
          description: 'Target/predecessor or paired method selector used by method_evidence pair lookup.'
        },
        edgeId: {
          type: 'string',
          description: 'Exact method evolution relationship id used by method_evidence.'
        },
        relationshipId: {
          type: 'string',
          description: 'Alternative relationship id used by method_evidence.'
        },
        citationRelationshipId: {
          type: 'string',
          description: 'Citation relationship id used to resolve a projected method DAG edge in method_evidence.'
        },
        candidateId: {
          type: 'string',
          description: 'Method evolution candidate id used by method_evidence.'
        },
        includeCandidates: {
          type: 'boolean',
          description: 'Include candidate or rejected method evidence edges in method_evidence output.',
          default: false
        },
        strictDirection: {
          type: 'boolean',
          description: 'Require sourceMethod -> targetMethod ordering for method_evidence pair lookup.',
          default: false
        },
        mode: {
          type: 'string',
          enum: ['cross_domain_evidence', 'method_lineage', 'both'],
          description: 'Answer mode used by research_answer.'
        },
        direction: {
          type: 'string',
          enum: ['backward', 'forward', 'both'],
          description: 'Lineage traversal direction for method_lineage.',
          default: 'backward'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum method lineage traversal depth.',
          default: 3
        },
        numSourceDomains: {
          type: 'number',
          description: 'Maximum source domains considered by cross_domain_evidence.',
          default: 3
        },
        relevanceThreshold: {
          type: 'number',
          description: 'Evidence threshold used by cross_domain_evidence.',
          default: 3
        },
        includePacketBundle: {
          type: 'boolean',
          description: 'Include the raw catalyst packet bundle in cross_domain_evidence output.',
          default: false
        },
        agnosticChallenges: {
          type: 'array',
          items: { type: 'string' }
        },
        excludeProximalDomains: {
          type: 'boolean',
          default: true
        },
        limit: {
          type: 'number'
        },
        minDomainDistance: {
          type: 'number'
        },
        options: {
          type: 'object',
          additionalProperties: true,
          description: 'Operation-specific options such as limit, layers, layerMode, mode, maxDepth, or maxHops.'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'research_briefing',
    description: 'Run typed chain, brief, and paper-enhancement retrieval through one remote HTTP MCP tool surface.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'path_trace',
            'evidence_chain',
            'reflection_chain',
            'paper_enhancement',
            'theory_brief',
            'storyline_brief',
            'research_brief',
            'brainstorm_brief'
          ]
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        query: {
          type: 'string',
          description: 'Query text for chain or brief retrieval.'
        },
        from: {
          type: 'string',
          description: 'Starting anchor for path-trace.'
        },
        to: {
          type: 'string',
          description: 'Ending anchor for path-trace.'
        },
        paperId: {
          type: 'string',
          description: 'Paper id for paper-enhancement retrieval.'
        },
        options: {
          type: 'object',
          additionalProperties: true,
          description: 'Operation-specific options such as limit, layers, maxDepth, maxPaths, direction, or mode.'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'import_workflow',
    description: 'Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed. The MCP serve import worker defaults to progressive logical batching with imports.batchEnabled=true, batchInitialTasks=4, and batchMaxTasks=16 unless server config explicitly disables or overrides it.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait', 'submit_async', 'async_status', 'async_wait'],
          description: 'Use queue_progress/status/wait to track graph-build latency after import submission. wait blocks until task completion by default, can target graph-visible or semantic-complete readiness, and submit_async starts a background import_workflow operation returning a jobId for async_status/async_wait.'
        },
        asyncOperation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait'],
          description: 'Normal import_workflow operation to run in the background when operation=submit_async.'
        },
        async_operation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait'],
          description: 'Snake_case alias for asyncOperation.'
        },
        targetOperation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait'],
          description: 'Alias for asyncOperation when operation=submit_async.'
        },
        target_operation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait'],
          description: 'Snake_case alias for targetOperation.'
        },
        jobId: {
          type: 'string',
          description: 'Background import_workflow job id returned by submit_async or by a normal operation with async=true; required for async_status or async_wait.'
        },
        job_id: {
          type: 'string',
          description: 'Snake_case alias for jobId.'
        },
        executionMode: {
          type: 'string',
          enum: ['sync', 'async', 'asynchronous', 'background', 'queued', 'queue'],
          description: 'When set to an async/background mode on a normal import_workflow operation, submit it as a background job instead of blocking.'
        },
        execution_mode: {
          type: 'string',
          enum: ['sync', 'async', 'asynchronous', 'background', 'queued', 'queue'],
          description: 'Snake_case alias for executionMode.'
        },
        runMode: {
          type: 'string',
          enum: ['sync', 'async', 'asynchronous', 'background', 'queued', 'queue'],
          description: 'Alias for executionMode.'
        },
        run_mode: {
          type: 'string',
          enum: ['sync', 'async', 'asynchronous', 'background', 'queued', 'queue'],
          description: 'Snake_case alias for runMode.'
        },
        async: {
          type: 'boolean',
          description: 'Alias for executionMode=async on a normal import_workflow operation.'
        },
        asynchronous: {
          type: 'boolean',
          description: 'Boolean alias for async.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        taskId: {
          type: 'string',
          description: 'Import task id for single-task status, progress, log, or wait.'
        },
        task_id: {
          type: 'string',
          description: 'Snake_case alias for taskId.'
        },
        paperId: {
          type: 'string',
          description: 'Optional paper id used to resolve a task when taskId is omitted.'
        },
        paper_id: {
          type: 'string',
          description: 'Snake_case alias for paperId.'
        },
        source: {
          type: 'string',
          description: 'Optional source path used to resolve a task when taskId is omitted.'
        },
        serverFilePath: {
          type: 'string',
          description: 'Absolute file path on the PaperNexus server for submit.'
        },
        server_file_path: {
          type: 'string',
          description: 'Snake_case alias for serverFilePath.'
        },
        identifiers: {
          type: 'object',
          additionalProperties: true,
          description: 'Per-paper identifier block for submit, containing one or more of DOI, arXiv ID, PMID, PMCID, ISBN, or ISSN.'
        },
        doi: {
          type: 'string',
          description: 'DOI for a single-paper submit request.'
        },
        arxivId: {
          type: 'string',
          description: 'arXiv ID for a single-paper submit request.'
        },
        arxiv_id: {
          type: 'string',
          description: 'Snake_case alias for arxivId.'
        },
        pmid: {
          type: 'string',
          description: 'PMID for a single-paper submit request.'
        },
        pmcid: {
          type: 'string',
          description: 'PMCID for a single-paper submit request.'
        },
        isbn: {
          type: 'string',
          description: 'ISBN for a single-paper submit request.'
        },
        issn: {
          type: 'string',
          description: 'ISSN for a single-paper submit request.'
        },
        sourceProvider: {
          type: 'string',
          description: 'Optional source provider/origin label used to build sourceId.'
        },
        source_provider: {
          type: 'string',
          description: 'Snake_case alias for sourceProvider.'
        },
        processingProfile: {
          type: 'string',
          enum: ['full', 'fast-md-structural', 'fast-md-background-semantic', 'long-context-full-md'],
          description: 'Optional import processing profile for submit. Use fast-md-background-semantic for markdown graph-visible ingest with background semantic enrichment.'
        },
        processing_profile: {
          type: 'string',
          enum: ['full', 'fast-md-structural', 'fast-md-background-semantic', 'long-context-full-md'],
          description: 'Snake_case alias for processingProfile.'
        },
        importProfile: {
          type: 'string',
          enum: ['full', 'fast-md-structural', 'fast-md-background-semantic', 'long-context-full-md'],
          description: 'Alias for processingProfile.'
        },
        import_profile: {
          type: 'string',
          enum: ['full', 'fast-md-structural', 'fast-md-background-semantic', 'long-context-full-md'],
          description: 'Snake_case alias for importProfile.'
        },
        completionPolicy: {
          type: 'string',
          enum: ['full', 'graph-visible', 'semantic-complete'],
          description: 'Optional completion policy for submit. graph-visible lets fast markdown imports complete when local structural graph visibility is ready.'
        },
        completion_policy: {
          type: 'string',
          enum: ['full', 'graph-visible', 'semantic-complete'],
          description: 'Snake_case alias for completionPolicy.'
        },
        importExecutionMode: {
          type: 'string',
          enum: ['serial', 'dag'],
          description: 'Optional internal import execution mode for submit. This is distinct from executionMode=sync|async, which only controls whether the MCP tool call waits.'
        },
        import_execution_mode: {
          type: 'string',
          enum: ['serial', 'dag'],
          description: 'Snake_case alias for importExecutionMode.'
        },
        importsExecutionMode: {
          type: 'string',
          enum: ['serial', 'dag'],
          description: 'Alias for importExecutionMode.'
        },
        imports_execution_mode: {
          type: 'string',
          enum: ['serial', 'dag'],
          description: 'Snake_case alias for importsExecutionMode.'
        },
        llmContextWindowTokens: {
          type: 'number',
          minimum: 1,
          description: 'Optional task-level LLM context window declaration for submit. Use 1000000 for the default long-context markdown optimization path.'
        },
        llm_context_window_tokens: {
          type: 'number',
          minimum: 1,
          description: 'Snake_case alias for llmContextWindowTokens.'
        },
        contextWindowTokens: {
          type: 'number',
          minimum: 1,
          description: 'Alias for llmContextWindowTokens.'
        },
        context_window_tokens: {
          type: 'number',
          minimum: 1,
          description: 'Snake_case alias for contextWindowTokens.'
        },
        llmExtractionStrategy: {
          type: 'string',
          enum: ['long-context-first', 'chunk-first', 'auto'],
          description: 'Optional task-level markdown LLM extraction strategy. long-context-first is the default optimized path for 1M-context models.'
        },
        llm_extraction_strategy: {
          type: 'string',
          enum: ['long-context-first', 'chunk-first', 'auto'],
          description: 'Snake_case alias for llmExtractionStrategy.'
        },
        llmLongContextMaxPapersPerCall: {
          type: 'number',
          minimum: 1,
          description: 'Optional task-level cap for how many markdown papers are packed into one long-context LLM call.'
        },
        llm_long_context_max_papers_per_call: {
          type: 'number',
          minimum: 1,
          description: 'Snake_case alias for llmLongContextMaxPapersPerCall.'
        },
        llmBatchConcurrency: {
          type: 'number',
          minimum: 1,
          description: 'Optional task-level LLM batch concurrency for provider-backed semantic enrichment.'
        },
        llm_batch_concurrency: {
          type: 'number',
          minimum: 1,
          description: 'Snake_case alias for llmBatchConcurrency.'
        },
        batchConcurrency: {
          type: 'number',
          minimum: 1,
          description: 'Alias for llmBatchConcurrency.'
        },
        batch_concurrency: {
          type: 'number',
          minimum: 1,
          description: 'Snake_case alias for batchConcurrency.'
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          }
        },
        trigger: {
          type: 'string',
          default: 'mcp'
        },
        limit: {
          type: 'number'
        },
        taskIds: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          ],
          description: 'Optional task ids for batch status/progress lookup or queue_progress filtering. Accepts an array or a comma/space-separated string.'
        },
        task_ids: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          ],
          description: 'Snake_case alias for taskIds. Accepts an array or a comma/space-separated string.'
        },
        includeSemanticQueue: {
          type: 'boolean',
          description: 'When operation=queue_progress, include the background semantic-enrichment queue summary and recent jobs. Defaults to true.'
        },
        include_semantic_queue: {
          type: 'boolean',
          description: 'Snake_case alias for includeSemanticQueue.'
        },
        semanticJobLimit: {
          type: 'number',
          description: 'When operation=queue_progress and includeSemanticQueue is true, limit recent semantic-enrichment jobs returned.',
          default: 5
        },
        semantic_job_limit: {
          type: 'number',
          description: 'Snake_case alias for semanticJobLimit.',
          default: 5
        },
        recentSemanticJobLimit: {
          type: 'number',
          description: 'Alias for semanticJobLimit.',
          default: 5
        },
        recent_semantic_job_limit: {
          type: 'number',
          description: 'Snake_case alias for recentSemanticJobLimit.',
          default: 5
        },
        eventTail: {
          type: 'number',
          description: 'When operation=queue_progress, include this many recent import task event ledger entries for the active task.',
          default: 5
        },
        event_tail: {
          type: 'number',
          description: 'Snake_case alias for eventTail.',
          default: 5
        },
        recentEventLimit: {
          type: 'number',
          description: 'Alias for eventTail.',
          default: 5
        },
        recent_event_limit: {
          type: 'number',
          description: 'Snake_case alias for recentEventLimit.',
          default: 5
        },
        dagTail: {
          type: 'number',
          description: 'When operation=queue_progress, include this many recent import DAG event ledger entries for the active task. Defaults to eventTail.',
          default: 5
        },
        dag_tail: {
          type: 'number',
          description: 'Snake_case alias for dagTail.',
          default: 5
        },
        recentDagEventLimit: {
          type: 'number',
          description: 'Alias for dagTail.',
          default: 5
        },
        recent_dag_event_limit: {
          type: 'number',
          description: 'Snake_case alias for recentDagEventLimit.',
          default: 5
        },
        includeDagComparison: {
          type: 'boolean',
          description: 'When operation=queue_progress, include the active task DAG comparison report. Defaults to true.'
        },
        include_dag_comparison: {
          type: 'boolean',
          description: 'Snake_case alias for includeDagComparison.'
        },
        timeout: {
          type: 'number',
          description: 'Maximum seconds to wait for completion when operation is wait. By default this also includes the downstream authoritative graph sync job for completed imports.',
          default: 1800
        },
        interval: {
          type: 'number',
          description: 'Polling interval in seconds when operation is wait.',
          default: 2
        },
        waitForAuthoritativeSync: {
          type: 'boolean',
          description: 'When operation is wait, keep waiting after the import task completes until its authoritative graph sync job is completed, failed, or superseded. Defaults to true.'
        },
        wait_for_authoritative_sync: {
          type: 'boolean',
          description: 'Snake_case alias for waitForAuthoritativeSync.'
        },
        waitUntil: {
          type: 'string',
          enum: ['task-completed', 'graph-visible', 'semantic-complete', 'authoritative-sync'],
          description: 'When operation is wait, choose the readiness target. task-completed preserves the legacy task terminal wait; graph-visible returns after structural graph visibility for fast markdown imports; semantic-complete waits for background 1M long-context semantic enrichment to reach a terminal lifecycle; authoritative-sync waits for downstream graph sync.'
        },
        wait_until: {
          type: 'string',
          enum: ['task-completed', 'graph-visible', 'semantic-complete', 'authoritative-sync'],
          description: 'Snake_case alias for waitUntil.'
        },
        waitTarget: {
          type: 'string',
          enum: ['task-completed', 'graph-visible', 'semantic-complete', 'authoritative-sync'],
          description: 'Alias for waitUntil.'
        },
        wait_target: {
          type: 'string',
          enum: ['task-completed', 'graph-visible', 'semantic-complete', 'authoritative-sync'],
          description: 'Snake_case alias for waitTarget.'
        },
        waitForGraphVisibility: {
          type: 'boolean',
          description: 'Shortcut for operation=wait with waitUntil=graph-visible. Useful for fast-md-background-semantic bursts where graph queries can start before 1M long-context semantic enrichment finishes.'
        },
        wait_for_graph_visibility: {
          type: 'boolean',
          description: 'Snake_case alias for waitForGraphVisibility.'
        },
        waitForSemanticCompletion: {
          type: 'boolean',
          description: 'Shortcut for operation=wait with waitUntil=semantic-complete. Useful when the caller needs background default 1M long-context semantic enrichment to finish before using semantic graph evidence.'
        },
        wait_for_semantic_completion: {
          type: 'boolean',
          description: 'Snake_case alias for waitForSemanticCompletion.'
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Maximum milliseconds for operation=async_wait to poll before returning the latest job state.',
          default: 60000
        },
        wait_timeout_ms: {
          type: 'number',
          description: 'Snake_case alias for waitTimeoutMs when operation=async_wait.',
          default: 60000
        },
        timeoutMs: {
          type: 'number',
          description: 'Alias for waitTimeoutMs when operation=async_wait.'
        },
        timeout_ms: {
          type: 'number',
          description: 'Snake_case alias for timeoutMs.'
        },
        pollIntervalMs: {
          type: 'number',
          description: 'Polling interval in milliseconds when operation=async_wait.',
          default: 500
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Snake_case alias for pollIntervalMs.',
          default: 500
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'literature_discovery',
    description: 'Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. operation=search is a bounded metadata-only interactive path with a default deadline, query caps, partial results, and diagnostics; use operation=submit plus progress/report polling for broad or long-running searches so MCP client timeouts do not lose server-side state. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers. Inline import processing defaults to progressive logical batching with importBatchEnabled=true, importBatchInitialTasks=4, and importBatchMaxTasks=16.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['plan', 'search', 'resolve', 'run', 'import', 'ingest', 'import_and_process', 'submit', 'progress', 'supplement', 'status', 'report', 'list'],
          default: 'run',
          description: 'plan/search/run/resolve produce discovery artifacts and do not by themselves make papers graph-visible. submit starts a background search/run/resolve/import job and returns a runId for progress/report polling. progress returns the running snapshot. import submits resolved full text to the import queue. ingest/import_and_process also process imports inline, but graph visibility still depends on completed import tasks. status/report/list inspect persisted discovery runs.'
        },
        discoveryOperation: {
          type: 'string',
          enum: ['search', 'resolve', 'run', 'import', 'ingest', 'import_and_process'],
          description: 'When operation=submit, the actual discovery operation to run in the background. Defaults to search.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Required except for plan.'
        },
        topic: {
          type: 'string',
          description: 'Research topic, question, related-work paragraph, seed concept, or paper title.'
        },
        query: {
          type: 'string',
          description: 'Alias for topic.'
        },
        seedPapers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              canonicalId: { type: 'string' },
              doi: { type: 'string' },
              arxivId: { type: 'string' },
              pmid: { type: 'string' },
              pmcid: { type: 'string' },
              year: { type: 'number' },
              venue: { type: 'string' },
              markdownUrl: { type: 'string' },
              markdownUrls: {
                type: 'array',
                items: { type: 'string' }
              },
              pdfUrl: { type: 'string' },
              bestOaUrl: { type: 'string' },
              sourceHints: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          },
          description: 'Client-supplied seed papers. PaperNexus treats these as remote discovery/source-resolution inputs and may query by seed title or identifiers before import.'
        },
        entitySeeds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              context: { type: 'string' },
              sourceTitle: { type: 'string' }
            }
          },
          description: 'Client-supplied research entities extracted from seed papers, such as datasets, benchmarks, metrics, tasks, or methods. They are used as additional discovery queries, not imported as papers.'
        },
        datasetSeeds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              context: { type: 'string' },
              sourceTitle: { type: 'string' }
            }
          },
          description: 'Alias for dataset-oriented entity seeds discovered in seed PDFs or source indexes.'
        },
        benchmarkSeeds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              context: { type: 'string' },
              sourceTitle: { type: 'string' }
            }
          },
          description: 'Alias for benchmark-oriented entity seeds discovered in seed PDFs or source indexes.'
        },
        seedTexts: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  sourceTitle: { type: 'string' }
                }
              }
            ]
          },
          description: 'Plain text or markdown extracted from seed papers. PaperNexus extracts dataset, benchmark, metric, task, and similar research entities and uses them as additional discovery queries.'
        },
        maxSeedPapers: {
          type: 'number',
          description: 'Maximum client-supplied seed papers accepted into the discovery candidate set.',
          default: 100
        },
        maxSeedQueries: {
          type: 'number',
          description: 'Maximum seed-title/identifier queries added to the provider plan.',
          default: 40
        },
        maxSeedEntities: {
          type: 'number',
          description: 'Maximum client-supplied research entities accepted into the discovery query set.',
          default: 80
        },
        maxExtractedEntities: {
          type: 'number',
          description: 'Maximum research entities extracted from supplied seed text or source index text.',
          default: 80
        },
        maxEntityQueries: {
          type: 'number',
          description: 'Maximum dataset/benchmark/entity queries added to the provider plan.',
          default: 40
        },
        depth: {
          type: 'string',
          enum: ['quick', 'default', 'deep'],
          default: 'deep'
        },
        discipline: {
          type: 'string',
          description: 'Optional discipline hint such as computer-science, biomedicine, physics-math, chemistry-materials, economics-social-science, humanities-law, or chinese-scholarship.'
        },
        providers: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Provider allow-list. Default providers are openalex, semantic_scholar, crossref, and arxiv. Implemented opt-in providers include papers_cool, pasa, europe_pmc, pubmed, dblp, and core; unpaywall is used during source resolution.'
        },
        maxQueries: {
          type: 'number',
          description: 'Maximum query families to execute after LLM planning and deterministic fallback expansion. For operation=search, defaults by searchMode are quick=4, balanced=6, and deep=10.'
        },
        searchMode: {
          type: 'string',
          enum: ['quick', 'balanced', 'deep'],
          description: 'Latency/recall profile for operation=search. quick uses the smallest budget and query cap; balanced is a moderate bounded search; deep is the default broader profile aligned with the 10-minute HTTP MCP request budget.',
          default: 'deep'
        },
        searchBudgetMs: {
          type: 'number',
          description: 'Soft wall-clock budget for operation=search. Defaults by searchMode are quick=25000, balanced=45000, and deep=600000. When exhausted, PaperNexus stops scheduling new provider queries and returns partial metadata results with diagnostics.',
          default: 600000
        },
        maxQueriesPerProvider: {
          type: 'number',
          description: 'Maximum generated discovery queries sent to each provider. For operation=search, defaults to 2 in quick mode and 3 in balanced/deep mode.'
        },
        returnPartial: {
          type: 'boolean',
          description: 'Return completed provider results with partial/diagnostics metadata when budget, timeout, query cap, or provider rate-limit truncates discovery.',
          default: true
        },
        planningMode: {
          type: 'string',
          enum: ['rule_based', 'llm_augmented'],
          description: 'Query planning mode. operation=search defaults to rule_based unless llmQueryPlanner=true or planningMode=llm_augmented is explicit; non-search discovery keeps the configured LLM planner behavior.'
        },
        llmQueryPlanner: {
          type: 'boolean',
          description: 'Use the configured LLM to split the topic into orthogonal literature-search queries before deterministic query expansion. Defaults to true for non-search discovery; operation=search defaults to false unless explicitly enabled. Missing, timing out, or failing LLM config falls back to deterministic planning.',
          default: true
        },
        maxLlmQueries: {
          type: 'number',
          description: 'Maximum LLM-planned orthogonal queries inserted before deterministic expansion. Defaults by depth are quick=3, default=4, deep=8; operation=search caps these to quick=2, balanced=2, and deep=4.',
          default: 4
        },
        llmProvider: {
          type: 'string',
          description: 'Optional LLM provider override for query planning, such as deepseek, openai, anthropic, or ollama. Defaults to PaperNexus llm config.'
        },
        llmModel: {
          type: 'string',
          description: 'Optional LLM model override for query planning. Defaults to PaperNexus llm config.'
        },
        llmBaseUrl: {
          type: 'string',
          description: 'Optional LLM API base URL override for query planning. Defaults to PaperNexus llm config.'
        },
        maxResultsPerQuery: {
          type: 'number',
          description: 'Maximum provider results per query.',
          default: 20
        },
        maxCandidates: {
          type: 'number',
          description: 'Maximum merged candidates retained in the run. Defaults by depth: quick=80, default=240, deep=3000.'
        },
        providerConcurrency: {
          type: 'number',
          description: 'Maximum concurrent literature search providers. Capped at 4.',
          default: 4
        },
        providerRequestSchedulerDelayMs: {
          type: 'number',
          description: 'Optional shared scheduler delay between request starts for providers that do not have a provider-specific delay.',
          default: 0
        },
        providerRequestMaxConcurrent: {
          type: 'number',
          description: 'Maximum concurrent HTTP requests per generic provider inside the shared discovery scheduler.',
          default: 4
        },
        discoveryRequestCache: {
          type: 'boolean',
          description: 'Enable in-process discovery HTTP response caching for successful deterministic provider requests.',
          default: false
        },
        discoveryRequestCacheTtlMs: {
          type: 'number',
          description: 'TTL for the opt-in in-process discovery request cache.',
          default: 0
        },
        openAlexRequestDelayMs: {
          type: 'number',
          description: 'Optional shared scheduler delay between OpenAlex request starts. Defaults to 0 unless configured by environment.',
          default: 0
        },
        openAlexMaxConcurrent: {
          type: 'number',
          description: 'Maximum concurrent OpenAlex HTTP requests inside the shared discovery scheduler.',
          default: 4
        },
        semanticScholarRequestDelayMs: {
          type: 'number',
          description: 'Optional Semantic Scholar request-start delay shared across search and citation expansion. Defaults to the existing Semantic Scholar delay configuration.',
          default: 1000
        },
        semanticScholarMaxConcurrent: {
          type: 'number',
          description: 'Maximum concurrent Semantic Scholar HTTP requests inside the shared discovery scheduler.',
          default: 1
        },
        papersCoolBaseUrl: {
          type: 'string',
          description: 'Optional papers.cool base URL override. Defaults to https://papers.cool.'
        },
        papersCoolSort: {
          type: 'number',
          description: 'papers.cool search ordering: 0 for time order, 1 for reading-star order.',
          default: 0
        },
        papersCoolMaxQueries: {
          type: 'number',
          description: 'Maximum discovery queries sent to papers.cool per run to avoid over-querying the local/web provider.',
          default: 4
        },
        pasaApiBaseUrl: {
          type: 'string',
          description: 'Optional PASA paper-agent API base URL override. Defaults to https://pasa-agent.ai/paper-agent/api/v1.'
        },
        pasaRequestTimeoutMs: {
          type: 'number',
          description: 'Maximum timeout in milliseconds for one PASA API request.',
          default: 20000
        },
        pasaTimeoutSeconds: {
          type: 'number',
          description: 'Maximum PASA polling time per query.',
          default: 30
        },
        pasaPollIntervalSeconds: {
          type: 'number',
          description: 'PASA polling interval per query.',
          default: 1
        },
        pasaMaxQueries: {
          type: 'number',
          description: 'Maximum discovery queries sent to PASA per run because PASA is slower and rate-limited.',
          default: 2
        },
        maxDownloads: {
          type: 'number',
          description: 'Maximum legal open source downloads attempted during resolution. Markdown is attempted before PDF when available.',
          default: 12
        },
        downloadConcurrency: {
          type: 'number',
          description: 'Maximum concurrent legal Markdown/PDF source-resolution downloads. Capped at 4.',
          default: 4
        },
        preferMarkdown: {
          type: 'boolean',
          description: 'When true (default), resolve and ingest explicit Markdown sources before trying PDF fallback. Generated third-party arXiv Markdown URLs require generateArxivMarkdownSources=true.',
          default: true
        },
        generateArxivMarkdownSources: {
          type: 'boolean',
          description: 'When true, generate third-party arXiv Markdown fallback URLs for candidates with an arXiv ID before falling back to arXiv PDF.',
          default: false
        },
        markdownStagingRoot: {
          type: 'string',
          description: 'Optional local directory for downloaded discovery Markdown sources. Defaults to the corpus discovery markdown staging directory.'
        },
        pdfStagingRoot: {
          type: 'string',
          description: 'Optional local directory for downloaded discovery PDF fallback sources. Defaults to the corpus discovery PDF staging directory.'
        },
        allowDownloads: {
          type: 'boolean',
          description: 'When false, keep Markdown/PDF URLs and institutional access hints but do not download files.',
          default: true
        },
        candidateId: {
          type: 'string',
          description: 'Candidate id to supplement in a persisted discovery run.'
        },
        canonicalId: {
          type: 'string',
          description: 'Canonical paper id to supplement in a persisted discovery run, such as arxiv:2501.00001 or doi:10.xxxx/example.'
        },
        sourcePath: {
          type: 'string',
          description: 'For operation=supplement, absolute local .md, .markdown, or .pdf path on the PaperNexus server.'
        },
        sourceKind: {
          type: 'string',
          enum: ['markdown', 'pdf'],
          description: 'Optional explicit source kind for operation=supplement.'
        },
        sourceProvider: {
          type: 'string',
          description: 'Optional full-text source provider for operation=supplement, such as hf, arxiv2md-api, markxiv, arxiv2md, or manual_supplement.'
        },
        markdownUrl: {
          type: 'string',
          description: 'For seeds or operation=supplement, HTTP(S) URL that returns validated paper Markdown.'
        },
        pdfUrl: {
          type: 'string',
          description: 'For seeds or operation=supplement, HTTP(S) URL that returns a valid PDF fallback.'
        },
        paperMetadata: {
          type: 'object',
          description: 'For operation=supplement, optional title/authors/year/identifier corrections to merge before import.'
        },
        citationExpansion: {
          type: 'boolean',
          description: 'Expand top seed papers through Semantic Scholar references/citations. Defaults to true only for depth=deep.',
          default: false
        },
        maxCitationSeeds: {
          type: 'number',
          description: 'Maximum seed papers used for citation expansion.',
          default: 3
        },
        maxCitationsPerSeed: {
          type: 'number',
          description: 'Maximum references and citations retained per seed during citation expansion.',
          default: 5
        },
        openAlexRelatedExpansion: {
          type: 'boolean',
          description: 'Expand top seed papers through OpenAlex related_works during citation expansion.',
          default: true
        },
        maxRelatedPerSeed: {
          type: 'number',
          description: 'Maximum OpenAlex related_works retained per seed during citation expansion.',
          default: 5
        },
        importResolved: {
          type: 'boolean',
          description: 'Submit resolved local full-text sources to the import queue after discovery. This accepts work into the queue; use processImports or import_workflow wait/status before treating papers as graph-visible.',
          default: false
        },
        processImports: {
          type: 'boolean',
          description: 'After submitting resolved sources, synchronously run the import worker so downloaded PDFs are parsed and fast-committed into the graph. Use this only when the caller intentionally wants to wait for graph visibility; it can be long-running.',
          default: false
        },
        importBatchEnabled: {
          type: 'boolean',
          description: 'Enable worker-side logical batching for inline import processing triggered by ingest, import_and_process, or processImports. Defaults to true for MCP so multiple submitted tasks can share one LLM optimization and fast commit. Server background workers use the same default unless imports.batchEnabled is explicitly set.',
          default: true
        },
        importBatchMaxTasks: {
          type: 'number',
          description: 'Maximum import tasks to reserve into one logical batch during inline import processing. Defaults to 16 and is hard-capped at 16.',
          default: 16
        },
        importBatchInitialTasks: {
          type: 'number',
          description: 'Initial progressive import batch target used before queued work proves sustained. Defaults to 4.',
          default: 4
        },
        importBatchProgressive: {
          type: 'boolean',
          description: 'Grow inline import batch targets from importBatchInitialTasks up to importBatchMaxTasks while pending work remains. Defaults to true.',
          default: true
        },
        importBatchCoalesceMs: {
          type: 'number',
          description: 'Optional milliseconds to wait before reserving an underfilled inline import batch. Defaults to 0 for immediate processing; use a small backlog value to let bursts fill the logical batch.',
          default: 0
        },
        importBatchCoalescePollMs: {
          type: 'number',
          description: 'Polling interval in milliseconds while waiting for importBatchCoalesceMs to fill an underfilled inline import batch.'
        },
        importMaxPasses: {
          type: 'number',
          description: 'Maximum import queue tasks to process inline when processImports is true. Defaults to the number of newly submitted tasks.',
          default: 20
        },
        maxImported: {
          type: 'number',
          description: 'Maximum resolved full-text sources to submit when importResolved is true. Metadata-only candidates remain in discovery artifacts but are not graph-visible until materialized through import.',
          default: 20
        },
        semanticExtraction: {
          type: 'string',
          enum: ['auto', 'heuristic-only', 'llm-assisted', 'llm-primary'],
          description: 'Optional semantic extraction mode for inline import processing.'
        },
        pdfParser: {
          type: 'string',
          enum: ['markitdown', 'markpdfdown', 'opendataloader', 'docling', 'marker', 'mineru', 'paddleocr-vl'],
          description: 'Optional PDF parser override for inline import processing.'
        },
        pdfCommand: {
          type: 'string',
          description: 'Optional generic PDF parser command override for inline import processing.'
        },
        doclingCommand: {
          type: 'string',
          description: 'Optional Docling command override for inline import processing.'
        },
        pythonCommand: {
          type: 'string',
          description: 'Optional Python command override for inline import processing.'
        },
        mailto: {
          type: 'string',
          description: 'Contact email used for polite API calls and Unpaywall. If omitted, literatureDiscovery.mailto, PAPERNEXUS_DISCOVERY_MAILTO, or PAPERNEXUS_IDENTIFIER_RESOLUTION_MAILTO is used when available.'
        },
        openAlexApiKey: {
          type: 'string',
          description: 'Optional OpenAlex API key. If omitted, literatureDiscovery.openAlexApiKey, openAlexApiKeyFile, OPENALEX_API_KEY, or ~/.papernexus/openalex_api_key is used when available.'
        },
        openAlexApiKeyFile: {
          type: 'string',
          description: 'Optional local file containing the OpenAlex API key. Supports ~/ paths and can also be configured as literatureDiscovery.openAlexApiKeyFile.'
        },
        semanticScholarApiKey: {
          type: 'string',
          description: 'Optional Semantic Scholar Graph API key. If omitted, literatureDiscovery.semanticScholarApiKey, SEMANTIC_SCHOLAR_API_KEY, or S2_API_KEY is used when available.'
        },
        coreApiKey: {
          type: 'string',
          description: 'Optional CORE API key. If omitted, literatureDiscovery.coreApiKey or CORE_API_KEY is used when available.'
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-request timeout in milliseconds.',
          default: 8000
        },
        retryCount: {
          type: 'number',
          description: 'Retry count for transient provider failures such as HTTP 429 and 5xx responses.',
          default: 1
        },
        retryBackoffMs: {
          type: 'number',
          description: 'Base retry backoff in milliseconds for transient provider failures.',
          default: 250
        },
        providerRequestDelayMs: {
          type: 'number',
          description: 'Minimum delay between consecutive queries sent to the same provider. Set to 0 for fast local tests; keep nonzero for public APIs to reduce HTTP 429s.',
          default: 250
        },
        maxRetryAfterMs: {
          type: 'number',
          description: 'Maximum Retry-After delay respected before a provider request fails fast.',
          default: 10000
        },
        institutionalResolverBaseUrl: {
          type: 'string',
          description: 'Optional campus library/OpenURL resolver URL. PaperNexus records resolver hints; it does not bypass authentication or paywalls.'
        },
        institutionalAccessMode: {
          type: 'string',
          enum: ['hints-only', 'browser', 'headless-browser', 'browser-session'],
          description: 'Authorized institutional access handling mode. Use headless-browser/browser-session to try a Playwright persistent browser profile after open-access download paths fail; SSO and captcha pages are recorded as manual barriers, not thrown.',
          default: 'hints-only'
        },
        browserProfileDir: {
          type: 'string',
          description: 'Optional browser user data directory for institutional browser-session downloads. Defaults to the selected browser channel profile root, such as Microsoft Edge User Data.'
        },
        browserProfileName: {
          type: 'string',
          description: 'Browser profile name inside browserProfileDir for browser-session downloads.',
          default: 'Default'
        },
        browserChannel: {
          type: 'string',
          description: 'Playwright browser channel for browser-session downloads, usually msedge or chrome.',
          default: 'msedge'
        },
        browserExecutablePath: {
          type: 'string',
          description: 'Optional Chromium/Chrome executable path for browser-session downloads. When set, it overrides browserChannel; useful on headless servers with a Playwright browser cache.'
        },
        browserHeadless: {
          type: 'boolean',
          description: 'Run the persistent browser-session downloader in headless mode.',
          default: true
        },
        browserDownloadTimeoutMs: {
          type: 'number',
          description: 'Per-page/per-request timeout for browser-session PDF download attempts.',
          default: 12000
        },
        browserAuthHosts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Institution SSO host fragments that should be recorded as manual auth redirects during browser-session downloads.'
        },
        browserAuthUrlFragments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Institution SSO URL fragments that should be recorded as manual auth redirects during browser-session downloads.'
        },
        browserAuthPageTitles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Institution SSO page-title fragments that should be recorded as manual auth redirects during browser-session downloads.'
        },
        runId: {
          type: 'string',
          description: 'Discovery run id for progress/status/report or supplement operations. If omitted for progress/status/report, the latest run/progress snapshot is used.'
        },
        limit: {
          type: 'number',
          description: 'Maximum runs returned by list.'
        },
        persist: {
          type: 'boolean',
          description: 'Persist discovery artifacts under the corpus .papernexus directory.',
          default: true
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'literature_discovery_progress',
    description: 'Read persisted literature_discovery progress snapshots without starting provider search, materializing reports, or touching the import queue. Returns current stage/status, candidate counts, stale-progress detection, conservative ETA when the discovery budget is known, and a default 5-minute next-poll recommendation for agents that should schedule a wakeup instead of blocking.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        runId: {
          type: 'string',
          description: 'Specific literature discovery run id. If omitted, returns latest/recent progress snapshots.'
        },
        limit: {
          type: 'number',
          description: 'Maximum progress snapshots returned when runId is omitted.',
          default: 10
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed discovery runs in recent progress summaries when runId is omitted.',
          default: true
        },
        pollIntervalMinutes: {
          type: 'number',
          description: 'Recommended next polling interval for non-terminal runs. Defaults to 5 minutes so agents can schedule a timer instead of synchronous polling.',
          default: 5
        },
        staleAfterMinutes: {
          type: 'number',
          description: 'Mark a non-terminal progress snapshot stale when updatedAt is older than this many minutes.',
          default: 10
        }
      },
      required: []
    }
  },
  {
    name: 'idea_catalyst',
    description: 'Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle with v2 innovation artifacts: must-cite set, novelty certificate, review packet, storyline DAG, and counterfactual falsification plans.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        problem: {
          type: 'string',
          description: 'Research problem statement to analyze.'
        },
        targetDomain: {
          type: 'string',
          description: 'Target domain that needs cross-domain inspiration.'
        },
        mode: {
          type: 'string',
          enum: ['graph', 'live_discovery', 'hybrid'],
          default: 'graph',
          description: 'graph uses the existing indexed corpus. live_discovery runs the paper-faithful Semantic Scholar Snippets workflow. hybrid returns graph output plus live discovery output.'
        },
        liveDiscovery: {
          type: 'boolean',
          default: false,
          description: 'Alias for mode=live_discovery.'
        },
        fineGrainedDomain: {
          type: 'string',
          description: 'Optional finer-grained target domain label used in the staged packet bundle.'
        },
        coarseGrainedDomain: {
          type: 'string',
          description: 'Optional coarse-grained target domain label used in the staged packet bundle.'
        },
        mechanisms: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ]
        },
        numSourceDomains: {
          type: 'number',
          default: 3
        },
        numQuestions: {
          type: 'number',
          default: 4,
          description: 'Maximum target-domain research questions in live_discovery mode.'
        },
        maxPapersPerQuery: {
          type: 'number',
          default: 20,
          description: 'Maximum Semantic Scholar snippet results per target/source query in live_discovery mode.'
        },
        sourceRelevanceThreshold: {
          type: 'number',
          default: 0.5,
          description: 'Paper-level relevance majority threshold for retaining a source domain in live_discovery mode.'
        },
        targetFieldOfStudy: {
          type: 'string',
          description: 'Optional Semantic Scholar coarse field override for the target domain, such as Computer Science or Medicine.'
        },
        year: {
          type: 'string',
          description: 'Optional Semantic Scholar publication year filter for live_discovery mode, such as 2018-2024 or -2023.'
        },
        publicationDateOrYear: {
          type: 'string',
          description: 'Optional Semantic Scholar publication date/year range for live_discovery mode.'
        },
        insertedBefore: {
          type: 'string',
          description: 'Optional Semantic Scholar index insertion cutoff for live_discovery mode.'
        },
        timeCutoff: {
          type: 'string',
          description: 'Optional temporal cutoff used to flag future-leakage in must-cite and novelty artifacts, such as 2024 or 2018-2024.'
        },
        mustCiteK: {
          type: 'number',
          default: 8,
          description: 'Maximum number of must-cite prior-art entries to surface in v2 innovation artifacts.'
        },
        reviewerPanel: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Optional reviewer roles for the structured review packet, for example novelty, methods, reproducibility, outsider.'
        },
        storylineMode: {
          type: 'string',
          description: 'Optional storyline DAG mode. Defaults to claim_review_storyline.'
        },
        writeBack: {
          type: 'boolean',
          default: false,
          description: 'When true, generates a schema-aware innovation writeback preview from v2 artifacts. The default is dry-run validation; it does not save unless writeBackApply=true, writeBackMode=apply, or writeBackDryRun=false.'
        },
        writeBackDryRun: {
          type: 'boolean',
          default: true,
          description: 'When writeBack=true, keep graph mutation writeback in preview mode. Set false only for an explicit apply.'
        },
        writeBackApply: {
          type: 'boolean',
          default: false,
          description: 'Explicitly apply validated writeback mutations to the corpus graph when writeBack=true.'
        },
        writeBackMode: {
          type: 'string',
          enum: ['dry_run', 'apply'],
          default: 'dry_run',
          description: 'Controlled writeback mode for v2 innovation artifacts.'
        },
        writeBackActor: {
          type: 'string',
          description: 'Short actor label recorded on writeback mutation audit properties.'
        },
        allowWeakEvidence: {
          type: 'boolean',
          default: false,
          description: 'Allow weakly grounded innovation artifacts to emit preview operations. Defaults false so ungrounded claims, untraceable story beats, and future leakage block writeback.'
        },
        counterfactualBudget: {
          type: 'number',
          default: 2,
          description: 'Maximum number of counterfactual falsification plans to produce.'
        },
        relevanceThreshold: {
          type: 'number',
          default: 3
        },
        limit: {
          type: 'number',
          default: 8
        },
        outputMode: {
          type: 'string',
          enum: ['idea_fragments', 'packet_bundle'],
          default: 'idea_fragments'
        },
        selectionMode: {
          type: 'string',
          enum: ['default', 'topk', 'mmr', 'submodular', 'dpp'],
          default: 'default',
          description: 'Optional post-generation selector. Use mmr, submodular, or dpp to return a graph-grounded diversity rerank with selection_trace.'
        },
        selectionK: {
          type: 'number',
          default: 3,
          description: 'Maximum idea fragments returned when selectionMode is topk, mmr, submodular, or dpp.'
        },
        mmrLambda: {
          type: 'number',
          default: 0.65,
          description: 'MMR relevance/diversity tradeoff for selectionMode=mmr. Higher values favor utility over diversity.'
        },
        minEvidenceTier: {
          type: 'string',
          enum: ['strong', 'moderate'],
          default: 'moderate',
          description: 'Minimum evidence tier admitted by the selector evidence gate.'
        },
        requireBridgePath: {
          type: 'boolean',
          default: false,
          description: 'When true, the selector rejects candidates without bridge path provenance.'
        },
        includeAnalysis: {
          type: 'boolean',
          default: false
        }
      },
      required: ['problem', 'targetDomain']
    }
  },
  {
    name: 'agent_materials',
    description: 'Assemble Agent-facing research materials from committed graph/source state and manage project-level Agent overlay memory. Material operations return role-grouped packs, single-paper views, source discovery plans, negative evidence, experiment-cost snippets, innovation evidence/storyline packs, import requisitions, research-controller artifacts, and episode-local proposal graph sessions without making raw corpus graph mutations; overlay operations store paper roles, evidence carts, workflow state, and controller state outside the raw corpus graph.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['research_material_pack', 'innovation_evidence_pack', 'source_discovery_plan', 'paper_material_view', 'paper_role_overlay', 'evidence_cart', 'workflow_state', 'negative_evidence_pack', 'experiment_cost_materials', 'import_requisition_pack', 'research_controller', 'proposal_graph_session'],
          description: 'Material backend operation to run. Overlay operations write only project overlay files, never the raw corpus graph.'
        },
        action: {
          type: 'string',
          enum: ['add', 'update', 'list', 'remove', 'get', 'export', 'status', 'init_task', 'run_round', 'generate_decomposition', 'review_decomposition', 'generate_candidates', 'propose_edges', 'judge_batch', 'select_batch', 'expand_evidence', 'execute_material_requests', 'record_material_results', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'generate_experiment_plan', 'validate_gcd_mvp'],
          description: 'Sub-action for paper_role_overlay, evidence_cart, workflow_state, or research_controller. Defaults: list for role/evidence operations, get for workflow_state, status for research_controller.'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview write-capable overlay operations without writing files.',
          default: false
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        project: {
          type: 'string',
          description: 'Research project id used to label material packs and isolate project overlay memory. For research_controller, omitted GCD tasks default to gcd-research-controller and other tasks default to research-controller.'
        },
        targetDomain: {
          type: 'string',
          description: 'Target research domain for source discovery and material pack grouping.'
        },
        targetProblem: {
          type: 'string',
          description: 'Research problem statement used to generate target, near-source, and far-source material queries.'
        },
        problem: {
          type: 'string',
          description: 'Research problem statement for proposal_graph_session; aliases targetProblem and query.'
        },
        runId: {
          type: 'string',
          description: 'Optional stable run id for proposal_graph_session artifacts.'
        },
        maxRounds: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum proposal graph controller rounds for proposal_graph_session.',
          default: 3
        },
        temporalCutoff: {
          type: 'string',
          description: 'Optional temporal cutoff recorded in proposal graph session input.'
        },
        proposalActions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          },
          description: 'Optional round-0 role actions for proposal_graph_session. Actions are validated against the initial frozen graph snapshot before merge.'
        },
        proposalSlates: {
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true
              }
            },
            {
              type: 'object',
              additionalProperties: true
            }
          ],
          description: 'Optional proposal_graph_session role slates by round. Omitted round_id or snapshot_id fields are filled from the current frozen snapshot; explicit stale snapshot ids are rejected.'
        },
        proposalRoleId: {
          type: 'string',
          description: 'Role id attached to proposalActions when proposal_graph_session wraps them into the first-round slate.'
        },
        evidenceRefs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          },
          description: 'Optional evidence references preloaded into the proposal graph session.'
        },
        evidenceExport: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional evidence export attached to a committed proposal bundle.'
        },
        allowLiveDiscovery: {
          type: 'boolean',
          description: 'Proposal graph session metadata flag for explicit live-discovery opt-in. The proposal controller itself does not run live discovery implicitly.',
          default: false
        },
        allowImports: {
          type: 'boolean',
          description: 'Proposal graph session metadata flag for explicit import opt-in. The proposal controller itself does not submit imports implicitly.',
          default: false
        },
        ideaComponents: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Optional components for innovation_evidence_pack composition-collision audit, for example Absorb, Separate, Buffer, non-identifiable reporting, or prior/capacity calibration.'
        },
        coverageAreas: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Optional coverage taxonomy override for innovation_evidence_pack evidence-sufficiency audit. Defaults to GCD, domain-shift GCD, open-world discovery, selective prediction, conformal risk, certified decision, label-shift-aware TTA, and calibration.'
        },
        query: {
          type: 'string',
          description: 'Alias or fallback query for operations that accept targetProblem or paper lookup text.'
        },
        constraints: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Venue, compute, data, task, or application constraints used when generating material queries.'
        },
        mode: {
          type: 'string',
          enum: ['quick', 'planning', 'deep'],
          description: 'Research-controller mode. quick initializes graph-only scouting artifacts, planning is the default controller pass, and deep is reserved for explicitly enabled evidence expansion.'
        },
        selector: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional research-controller selector settings. The MVP writes top-k, MMR, and greedy-submodular selection traces; set mmr_lambda to tune the MMR ablation/fallback.'
        },
        mmrLambda: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Optional lambda for the research-controller MMR selector trace. Higher values favor utility over diversity.'
        },
        budget: {
          type: 'object',
          additionalProperties: true,
          description: 'Research-controller budget caps, for example max_candidate_nodes, max_edge_judgments, max_agent_calls, max_provider_queries, max_imports, and max_selected_candidates.'
        },
        judge: {
          type: 'object',
          additionalProperties: true,
          description: 'Research-controller judge configuration. MVP uses a single model and stores judge output as evidence only.'
        },
        maxPairwisePreferences: {
          type: 'integer',
          minimum: 0,
          description: 'Maximum bounded pairwise preference comparisons requested from the research-controller judge batch.'
        },
        externalInputs: {
          type: 'object',
          additionalProperties: true,
          description: 'Research-controller external inputs such as subproblem_hints, seed_papers, human_notes, and rejected_directions.'
        },
        approveExperimentPlanning: {
          type: 'boolean',
          description: 'For research_controller action=generate_experiment_plan, explicit approval to write a plan-only experiment artifact. This does not run experiments.',
          default: false
        },
        approveMaterialRequestExecution: {
          type: 'boolean',
          description: 'For research_controller action=execute_material_requests, explicit approval to execute planned agent_materials material requests. Provider/live/literature/import opt-ins still require the separate allow* approval flags.',
          default: false
        },
        allowProviderMaterialOptIns: {
          type: 'boolean',
          description: 'For research_controller action=execute_material_requests, allow approved material requests to pass requested provider evidence, live discovery, or literature-discovery evidence opt-ins to the nested material executor. Does not permit import submission.',
          default: false
        },
        allowImportSubmission: {
          type: 'boolean',
          description: 'For research_controller action=execute_material_requests, allow approved import_requisition/literature material requests to submit imports when the request explicitly asked for import submission.',
          default: false
        },
        allowImportProcessing: {
          type: 'boolean',
          description: 'For research_controller action=execute_material_requests, allow approved literature material requests to process submitted imports when the request explicitly asked for import processing.',
          default: false
        },
        materialRequestExecutionApproval: {
          type: 'object',
          additionalProperties: true,
          description: 'Approval metadata for research_controller material request execution, such as approver, source, note, and granular allow_provider_evidence / allow_live_discovery_evidence / allow_literature_discovery / allow_import_submission / allow_import_processing flags.'
        },
        approvedMaterialRequestIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allow-list of planned material request ids that may be executed by research_controller action=execute_material_requests.'
        },
        maxMaterialRequests: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum material requests to execute in one research_controller action=execute_material_requests call.'
        },
        experimentPlanApproval: {
          type: 'object',
          additionalProperties: true,
          description: 'Approval metadata for research_controller experiment-plan generation, such as approver, source, and note.'
        },
        maxExperimentPlans: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of plan-only experiment plans generated from reviewed solution sketches.'
        },
        maxGpuHours: {
          type: 'number',
          minimum: 0,
          description: 'Optional planning budget constraint recorded in experiment plans. No compute is launched.'
        },
        providerPolicy: {
          type: 'object',
          additionalProperties: true,
          description: 'Research-controller provider policy. Provider evidence, literature discovery, import submission, and configured controller LLM calls default to disabled unless explicitly enabled. For single-model provider calls, set enable_controller_llm=true plus controller_llm model/base_url or environment equivalents and a positive max_provider_queries budget.'
        },
        subproblemHints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional research-controller subproblem hints used during deterministic foundation initialization.'
        },
        overwrite: {
          type: 'boolean',
          description: 'When research_controller action=init_task, regenerate foundation artifacts even when controller-state.json already exists.',
          default: false
        },
        autoDiscoverSources: {
          type: 'boolean',
          description: 'Compatibility flag for material-pack workflows. Source discovery is generated by default and remains read-only unless routed to import tools.',
          default: true
        },
        preferDomains: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Preferred source domains for source_discovery_plan and research_material_pack.'
        },
        excludeDomains: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Source domains to exclude from the graph-native near/far source router.'
        },
        nearSourceDomains: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Explicit domains to treat as near-source method domains.'
        },
        farSourceDomains: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Explicit domains to treat as far-source story domains.'
        },
        minDomainDistance: {
          type: 'number',
          description: 'Minimum domain distance for source-router candidates before they are marked as proximal leakage.',
          default: 0
        },
        maxProximalResults: {
          type: 'number',
          description: 'Maximum number of below-minDomainDistance source domains kept with proximal_leakage=true.',
          default: 2
        },
        sourceDomainLimit: {
          type: 'number',
          description: 'Maximum source domains returned by the graph-native source router.',
          default: 8
        },
        includeProviderEvidence: {
          type: 'boolean',
          description: 'Opt in to bounded read-only Semantic Scholar snippet evidence for source_discovery_plan, research_material_pack, import_requisition_pack, and negative_evidence_pack. Default false to avoid implicit network calls.',
          default: false
        },
        providerEvidenceLimit: {
          type: 'number',
          description: 'Maximum Semantic Scholar snippet hits retained per provider-evidence query.',
          default: 3
        },
        persistProviderEvidence: {
          type: 'boolean',
          description: 'When includeProviderEvidence is true, persist returned provider snippets into the project evidence cart. Requires project; default false.',
          default: false
        },
        providerEvidencePersistLimit: {
          type: 'number',
          description: 'Maximum provider evidence snippets persisted into the project evidence cart when persistProviderEvidence=true.',
          default: 20
        },
        providerEvidenceQueryLimit: {
          type: 'number',
          description: 'Maximum generated queries sent to the provider-evidence layer.',
          default: 6
        },
        providerEvidenceTimeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds for each provider-evidence request.',
          default: 12000
        },
        providerEvidenceFallbackToAbstract: {
          type: 'boolean',
          description: 'When true, hydrate degenerate provider snippets with paper abstracts when available.',
          default: false
        },
        includeLiveDiscoveryEvidence: {
          type: 'boolean',
          description: 'Opt in to bounded idea_catalyst live_discovery evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit LLM and network calls.',
          default: false
        },
        runLiveIdeaCatalystIfNeeded: {
          type: 'boolean',
          description: 'Opt in to running bounded idea_catalyst live_discovery only when requested roles are sparse in the committed graph. Default false to avoid implicit LLM and network calls.',
          default: false
        },
        liveDiscoveryFallbackIfSparse: {
          type: 'boolean',
          description: 'Alias for runLiveIdeaCatalystIfNeeded; runs live discovery only when committed-graph role evidence is sparse.',
          default: false
        },
        liveDiscoverySparseRoleThreshold: {
          type: 'number',
          description: 'Number of sparse requested roles required before runLiveIdeaCatalystIfNeeded triggers live discovery.',
          default: 1
        },
        liveDiscoverySparseMinScore: {
          type: 'number',
          description: 'Minimum committed-graph search score counted as non-sparse for runLiveIdeaCatalystIfNeeded.',
          default: 0.05
        },
        persistLiveDiscoveryEvidence: {
          type: 'boolean',
          description: 'When includeLiveDiscoveryEvidence is true, persist returned live-discovery spans/fragments into the project evidence cart. Requires project; default false.',
          default: false
        },
        liveDiscoveryNumQuestions: {
          type: 'number',
          description: 'Maximum target research questions used by opt-in live discovery evidence.',
          default: 1
        },
        liveDiscoverySourceDomainLimit: {
          type: 'number',
          description: 'Maximum source domains used by opt-in live discovery evidence.',
          default: 2
        },
        liveDiscoveryMaxPapersPerQuery: {
          type: 'number',
          description: 'Maximum Semantic Scholar snippet papers retrieved per live-discovery query.',
          default: 5
        },
        liveDiscoverySourceRelevanceThreshold: {
          type: 'number',
          description: 'Paper-level source relevance ratio threshold used by opt-in live discovery evidence.',
          default: 0.5
        },
        liveDiscoveryIdeaFragmentLimit: {
          type: 'number',
          description: 'Maximum idea fragments retained from opt-in live discovery evidence.',
          default: 3
        },
        liveDiscoveryPersistLimit: {
          type: 'number',
          description: 'Maximum live-discovery spans/fragments persisted into the project evidence cart when persistLiveDiscoveryEvidence=true.',
          default: 20
        },
        liveDiscoveryTimeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds for each live-discovery provider request.',
          default: 12000
        },
        includeLiteratureDiscoveryEvidence: {
          type: 'boolean',
          description: 'Opt in to bounded literature_discovery search/resolve evidence for source_discovery_plan, research_material_pack, and import_requisition_pack. Default false to avoid implicit network/download work.',
          default: false
        },
        runLiteratureDiscoveryIfSparse: {
          type: 'boolean',
          description: 'Opt in to running bounded literature_discovery only when requested roles are sparse in the committed graph. Default false.',
          default: false
        },
        literatureDiscoveryFallbackIfSparse: {
          type: 'boolean',
          description: 'Alias for runLiteratureDiscoveryIfSparse; runs literature_discovery only when committed-graph role evidence is sparse.',
          default: false
        },
        literatureDiscoverySeedProviderPapers: {
          type: 'boolean',
          description: 'When both provider evidence and literature-discovery evidence are enabled, pass provider snippet hits into literature_discovery as exact seed papers. Default false.',
          default: false
        },
        literatureDiscoveryProviderSeedLimit: {
          type: 'number',
          description: 'Maximum provider evidence hits passed into literature_discovery as exact seed papers.',
          default: 8
        },
        literatureDiscoverySeedLivePapers: {
          type: 'boolean',
          description: 'When both live-discovery and literature-discovery evidence are enabled, pass live-discovery supporting papers into literature_discovery as exact seed papers. Default false.',
          default: false
        },
        literatureDiscoveryLiveSeedLimit: {
          type: 'number',
          description: 'Maximum live-discovery supporting papers passed into literature_discovery as exact seed papers.',
          default: 8
        },
        literatureDiscoveryResolveSources: {
          type: 'boolean',
          description: 'Resolve legal full-text sources during opt-in literature discovery evidence. Default true; set false for metadata-only discovery.',
          default: true
        },
        literatureDiscoveryAllowDownloads: {
          type: 'boolean',
          description: 'Allow opt-in literature discovery source resolution to stage legal markdown/open-PDF downloads. Default true when literature discovery evidence is enabled.',
          default: true
        },
        submitLiteratureDiscoveryImports: {
          type: 'boolean',
          description: 'Submit resolved literature_discovery full-text sources to the import queue from agent_materials. Default false; use import_workflow wait/status before treating submitted papers as graph-visible.',
          default: false
        },
        processLiteratureDiscoveryImports: {
          type: 'boolean',
          description: 'After submitting resolved literature_discovery sources, synchronously run the import worker so imports can become graph-visible. Default false because this can be long-running.',
          default: false
        },
        literatureDiscoveryMaxQueries: {
          type: 'number',
          description: 'Maximum generated literature_discovery queries when opt-in evidence is enabled.',
          default: 4
        },
        literatureDiscoveryMaxResultsPerQuery: {
          type: 'number',
          description: 'Maximum provider results retained per literature_discovery query when opt-in evidence is enabled.',
          default: 8
        },
        literatureDiscoveryMaxCandidates: {
          type: 'number',
          description: 'Maximum merged literature_discovery candidates retained when opt-in evidence is enabled.',
          default: 16
        },
        literatureDiscoveryMaxDownloads: {
          type: 'number',
          description: 'Maximum legal full-text downloads staged by opt-in literature_discovery source resolution.',
          default: 6
        },
        literatureDiscoveryMaxImported: {
          type: 'number',
          description: 'Maximum resolved full-text sources submitted when submitLiteratureDiscoveryImports is true.',
          default: 4
        },
        literatureDiscoveryImportMaxPasses: {
          type: 'number',
          description: 'Maximum import worker passes when processLiteratureDiscoveryImports is true.',
          default: 4
        },
        literatureDiscoveryImportBatchEnabled: {
          type: 'boolean',
          description: 'Enable worker-side logical batching for inline literature_discovery import processing triggered by processLiteratureDiscoveryImports.',
          default: true
        },
        literatureDiscoveryImportBatchMaxTasks: {
          type: 'number',
          description: 'Maximum import tasks to reserve into one logical batch for inline literature_discovery import processing.',
          default: 8
        },
        timeWindow: {
          type: 'string',
          description: 'Optional time-window label recorded in negative_evidence_pack filters.'
        },
        roles: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Requested material roles, for example target_prior, near_source_method, far_source_story, novelty_risk, or baseline_candidate.'
        },
        role: {
          type: 'string',
          description: 'Single-role alias for roles.'
        },
        roleId: {
          type: 'string',
          description: 'Stable project overlay role id for paper_role_overlay update/remove.'
        },
        layer: {
          type: 'string',
          description: 'Optional source layer for paper role overlay, for example target_domain, near_source, or far_source.'
        },
        judgmentType: {
          type: 'string',
          description: 'Optional Agent judgment type saved in project overlay, for example closest_prior or novelty_risk_note.'
        },
        confidence: {
          type: 'string',
          description: 'Optional Agent confidence label for project overlay entries.'
        },
        supportingEvidenceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence ids supporting a paper role overlay entry.'
        },
        paperId: {
          type: 'string',
          description: 'Paper id for paper_material_view.'
        },
        paperTitle: {
          type: 'string',
          description: 'Paper title for paper_material_view or seed matching.'
        },
        title: {
          type: 'string',
          description: 'Alias for paperTitle.'
        },
        sourceKey: {
          type: 'string',
          description: 'Manifest sourceKey for paper_material_view.'
        },
        sourceType: {
          type: 'string',
          description: 'Evidence-cart source type, for example chunk, graph_node, table, figure, query, or negative_evidence.'
        },
        sourceId: {
          type: 'string',
          description: 'Evidence-cart source id, such as a chunk id, graph node id, or external query id.'
        },
        evidenceId: {
          type: 'string',
          description: 'Stable evidence-cart id for remove or cross-linking from paper_role_overlay.'
        },
        itemType: {
          type: 'string',
          description: 'Evidence-cart item type, for example snippet, table, figure, mechanism, paper, or negative_evidence.'
        },
        text: {
          type: 'string',
          description: 'Evidence-cart text or short material excerpt.'
        },
        tags: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' }
            }
          ],
          description: 'Evidence-cart tags.'
        },
        provenance: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          },
          description: 'Evidence-cart provenance records.'
        },
        notes: {
          type: 'string',
          description: 'Human or Agent notes for overlay entries.'
        },
        actor: {
          type: 'string',
          description: 'Short label for the Agent or user writing overlay state.'
        },
        workflowState: {
          type: 'object',
          additionalProperties: true,
          description: 'Workflow state patch for workflow_state action=update.'
        },
        hypothesis: {
          type: 'string',
          description: 'Current project hypothesis for workflow_state action=update.'
        },
        currentStage: {
          type: 'string',
          description: 'Current workflow stage label for workflow_state action=update.'
        },
        acceptedDirections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Accepted research directions for workflow_state action=update.'
        },
        rejectedDirections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Rejected research directions for workflow_state action=update.'
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Open questions for workflow_state action=update.'
        },
        neededMaterials: {
          type: 'array',
          items: { type: 'string' },
          description: 'Needed materials for workflow_state action=update.'
        },
        identifier: {
          type: 'string',
          description: 'Generic DOI, arXiv id, PMID, or other identifier for paper lookup.'
        },
        doi: {
          type: 'string',
          description: 'DOI for paper lookup or seed matching.'
        },
        arxivId: {
          type: 'string',
          description: 'arXiv id for paper lookup or seed matching.'
        },
        pmid: {
          type: 'string',
          description: 'PMID for paper lookup or seed matching.'
        },
        pmcid: {
          type: 'string',
          description: 'PMCID for paper lookup or seed matching.'
        },
        seedPapers: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true
          },
          description: 'Optional user- or Agent-provided candidate papers. Missing seeds become import requisitions in the MVP.'
        },
        limit: {
          type: 'number',
          description: 'Maximum candidates per role or generated query group.',
          default: 5
        },
        chunkLimit: {
          type: 'number',
          description: 'Maximum chunk records returned by paper_material_view.',
          default: 8
        },
        includeCostLlmExtraction: {
          type: 'boolean',
          description: 'Opt in to bounded LLM structured extraction for experiment_cost_materials. Default false to avoid implicit LLM calls.',
          default: false
        },
        costLlmRecordLimit: {
          type: 'number',
          description: 'Maximum paper material records sent to the opt-in experiment-cost LLM extractor.',
          default: 16
        },
        costLlmMaxInputChars: {
          type: 'number',
          description: 'Maximum characters from paper material records sent to the opt-in experiment-cost LLM extractor.',
          default: 12000
        },
        costLlmProvider: {
          type: 'string',
          description: 'Optional LLM provider override for opt-in experiment-cost extraction, for example deepseek, ollama, openai, or anthropic.'
        },
        costLlmModel: {
          type: 'string',
          description: 'Optional LLM model override for opt-in experiment-cost extraction.'
        },
        costLlmBaseUrl: {
          type: 'string',
          description: 'Optional LLM base URL override for opt-in experiment-cost extraction, including OpenAI-compatible Qwen endpoints.'
        },
        costLlmApiKeyEnv: {
          type: 'string',
          description: 'Optional environment variable name containing the API key for opt-in experiment-cost extraction.'
        },
        costLlmTimeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds for the opt-in experiment-cost LLM extraction request.',
          default: 45000
        },
        costLlmMaxTokens: {
          type: 'number',
          description: 'Maximum output tokens requested from the opt-in experiment-cost LLM extractor.',
          default: 1600
        },
        outputDir: {
          type: 'string',
          description: 'Optional server-local directory for JSON/Markdown exports. Omit for pure read-only response.'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'mutate_graph',
    description: 'Apply an ordered batch of graph node and relationship mutations with schema-aware validation. Supports dry-run previews before writing to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        actor: {
          type: 'string',
          description: 'Short label for the editing agent or workflow.'
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, validate and preview the mutation without saving changes.',
          default: true
        },
        operations: {
          type: 'array',
          description: 'Mutation operations to apply in order.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: [
                  'upsert_node',
                  'delete_node',
                  'upsert_relationship',
                  'delete_relationship',
                  'create_node',
                  'update_node',
                  'create_relationship',
                  'update_relationship',
                  'create',
                  'create_edge'
                ],
                description: 'Mutation action. create/update/create_edge aliases map to upsert. Bare "create" auto-detects node vs relationship from fields.'
              },
              id: {
                type: 'string',
                description: 'Optional explicit node or relationship id.'
              },
              match: {
                type: 'object',
                description: 'Node reference for update/delete. Use {id} or {type,name}.',
                additionalProperties: true
              },
              type: {
                type: 'string',
                description: 'Node type for node operations, or relationship type for relationship operations. Aliases: nodeType (for nodes), edgeType or relationType (for relationships).'
              },
              nodeType: {
                type: 'string',
                description: 'Alias for type in node operations.'
              },
              edgeType: {
                type: 'string',
                description: 'Alias for type in relationship operations.'
              },
              name: {
                type: 'string',
                description: 'Node name for node upserts.'
              },
              properties: {
                type: 'object',
                description: 'Arbitrary node or relationship properties to merge.',
                additionalProperties: true
              },
              replaceProperties: {
                type: 'boolean',
                description: 'Replace properties instead of merging them.',
                default: false
              },
              source: {
                type: 'object',
                description: 'Relationship source reference. Use {id} or {type,name}.',
                additionalProperties: true
              },
              target: {
                type: 'object',
                description: 'Relationship target reference. Use {id} or {type,name}.',
                additionalProperties: true
              },
              from: {
                type: ['object', 'string'],
                description: 'Alias for source. Can be {id} or {type,name} object, or a name string.'
              },
              to: {
                type: ['object', 'string'],
                description: 'Alias for target. Can be {id} or {type,name} object, or a name string.'
              },
              bidirectional: {
                type: 'boolean',
                description: 'For symmetric relations like COMBINES_WITH or RELATED_TO, also create/delete the reverse edge.',
                default: false
              }
            },
            required: ['action']
          }
        }
      },
      required: ['operations']
    }
  },
  {
    name: 'runtime_init',
    description: 'Initialize or update the PaperNexus runtime config non-interactively over MCP, equivalent to papernexus init for server-side paths. This writes config only; call create_corpus for the first graph build.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceInputs: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the MCP server. Omit or pass an empty array to initialize an empty corpus config.'
        },
        sources: {
          type: ['array', 'string'],
          description: 'Alias for sourceInputs. Strings may be comma-separated.'
        },
        corpus: {
          type: 'string',
          description: 'Friendly corpus name to write into analyze.name and global.corpus.'
        },
        corpusName: {
          type: 'string',
          description: 'Alias for corpus.'
        },
        indexDir: {
          type: ['string', 'array'],
          items: {
            type: 'string'
          },
          description: 'Directory where the generated .papernexus index should live, or an array of worker-scanned index roots. Defaults to the existing storage.indexDir/storage.indexDirs or ~/.papernexus/index-store.'
        },
        indexDirs: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Multiple PaperNexus index roots to persist as storage.indexDirs so one serve worker can scan several corpora.'
        },
        rootPath: {
          type: 'string',
          description: 'Alias for indexDir.'
        },
        configPath: {
          type: 'string',
          description: 'Optional runtime config path to create or update. If omitted, the default PaperNexus runtime config is used.'
        },
        pdfParser: {
          type: 'string',
          enum: ['markitdown', 'markpdfdown', 'opendataloader', 'docling', 'marker', 'mineru', 'paddleocr-vl'],
          description: 'Default PDF parser to write into analyze.pdfParser.',
          default: 'markitdown'
        },
        serveHost: {
          type: 'string',
          description: 'Default serve host to write into serve.host.',
          default: '127.0.0.1'
        },
        servePort: {
          type: 'number',
          description: 'Default serve port to write into serve.port.',
          default: 4821
        },
        serveMcpEnabled: {
          type: 'boolean',
          description: 'When provided, write serve.mcp.enabled for HTTP MCP serving.'
        },
        serveMcpPath: {
          type: 'string',
          description: 'When provided, write serve.mcp.path. Relative values are normalized with a leading slash.'
        },
        llm: {
          type: 'object',
          description: 'Optional LLM config metadata. Raw API keys are intentionally rejected; use apiKeyEnv or keychain metadata.',
          properties: {
            provider: {
              type: 'string',
              enum: ['ollama', 'openai', 'deepseek', 'anthropic'],
              description: 'LLM provider.'
            },
            model: {
              type: 'string',
              description: 'Model identifier exposed by the provider.'
            },
            baseUrl: {
              type: 'string',
              description: 'Provider API base URL.'
            },
            relations: {
              type: 'boolean',
              description: 'Enable LLM-assisted relation extraction.'
            },
            apiKeyEnv: {
              type: 'string',
              description: 'Environment variable name containing the API key.'
            },
            apiKeySource: {
              type: 'string',
              enum: ['keychain'],
              description: 'Secure API key source metadata.'
            },
            apiKeyService: {
              type: 'string',
              description: 'Keychain service name when apiKeySource is keychain.'
            },
            apiKeyAccount: {
              type: 'string',
              description: 'Keychain account name when apiKeySource is keychain.'
            },
            sshHost: {
              type: 'string',
              description: 'Optional SSH host for remote LLM access.'
            },
            timeoutMs: {
              type: 'number',
              description: 'Optional LLM request timeout.'
            },
            batchSize: {
              type: 'number',
              description: 'Optional LLM batch size.'
            },
            maxTokens: {
              type: 'number',
              description: 'Optional LLM max tokens.'
            }
          },
          additionalProperties: false
        }
      },
      required: ['corpus']
    }
  },
  {
    name: 'create_corpus',
    description: 'Create the first committed corpus graph over MCP from server-visible source files/directories or create an empty graph when no sources are provided, equivalent to the first papernexus analyze --name run. Source-backed builds default to a background job to avoid MCP client timeouts; use operation=status or operation=wait with the returned jobId. Use refresh_corpus for later maintenance.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceInputs: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional PaperNexus server-visible source directories or files containing PDFs/Markdown. MCP does not upload local files; paths must already exist from the MCP server perspective. Do not pass workstation-only paths such as /Users/... unless that path exists on the server. If omitted, configured sources.inputs are used; if no inputs are configured, an empty corpus graph is created.'
        },
        sources: {
          type: ['array', 'string'],
          description: 'Alias for sourceInputs. Strings may be comma-separated.'
        },
        sourceRoot: {
          type: 'string',
          description: 'Alias for a single source input path.'
        },
        inputPath: {
          type: 'string',
          description: 'Alias for a single source input path.'
        },
        corpus: {
          type: 'string',
          description: 'Friendly corpus name. If omitted, configured analyze.name or global.corpus is used.'
        },
        corpusName: {
          type: 'string',
          description: 'Alias for corpus.'
        },
        rootPath: {
          type: 'string',
          description: 'Index root where the .papernexus directory is created. If omitted, configured storage.indexDir or the analyze default is used.'
        },
        indexDir: {
          type: 'string',
          description: 'Alias for rootPath.'
        },
        configPath: {
          type: 'string',
          description: 'Optional runtime config path to read defaults from.'
        },
        force: {
          type: 'boolean',
          description: 'Force a full build even if cached corpus state exists.',
          default: false
        },
        semanticExtraction: {
          type: 'string',
          enum: ['auto', 'heuristic-only', 'llm-assisted', 'llm-primary'],
          description: 'Optional semantic extraction override for the first build.'
        },
        rebuildPdfMarkdown: {
          type: 'boolean',
          description: 'When true, force PDF markdown regeneration during the first build.'
        },
        pdfParser: {
          type: 'string',
          enum: ['markitdown', 'markpdfdown', 'opendataloader', 'docling', 'marker', 'mineru', 'paddleocr-vl'],
          description: 'Optional PDF parser override for the first build.'
        },
        pdfCommand: {
          type: 'string',
          description: 'Optional generic PDF parser command override for the first build.'
        },
        concurrency: {
          type: 'number',
          description: 'Optional source analysis concurrency override.'
        },
        analyzeConcurrency: {
          type: 'number',
          description: 'Alias for concurrency.'
        },
        llmBatchSize: {
          type: 'number',
          description: 'Optional LLM batch size override.'
        },
        batchSize: {
          type: 'number',
          description: 'Alias for llmBatchSize.'
        },
        operation: {
          type: 'string',
          enum: ['build', 'submit', 'status', 'wait'],
          description: 'build starts a create operation, submit always starts it as a background job, status returns a submitted job, and wait polls a submitted job until completion or waitTimeoutMs.',
          default: 'build'
        },
        executionMode: {
          type: 'string',
          enum: ['auto', 'sync', 'async'],
          description: 'Execution mode for operation=build. auto runs empty corpus creation synchronously and source-backed builds asynchronously to avoid MCP client timeouts.',
          default: 'auto'
        },
        async: {
          type: 'boolean',
          description: 'Alias for executionMode=async when true and executionMode=sync when false.'
        },
        waitForCompletion: {
          type: 'boolean',
          description: 'When false, alias for executionMode=async; when true, alias for executionMode=sync.'
        },
        jobId: {
          type: 'string',
          description: 'Background create_corpus job id returned by an async build; required for operation=status or operation=wait.'
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Maximum milliseconds for operation=wait to poll before returning the latest job state.',
          default: 600000
        },
        pollIntervalMs: {
          type: 'number',
          description: 'Polling interval for operation=wait.',
          default: 500
        }
      }
    }
  },
  {
    name: 'refresh_corpus',
    description: 'Run corpus-scale maintenance over an indexed corpus: incremental/full analyze, Stage 1 snapshot materialization, Stage 2 batch LLM optimization, or Stage 2-5 optimize from cached snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or root path. Omit to use the default corpus.'
        },
        mode: {
          type: 'string',
          enum: ['analyze', 'materialize', 'llm_optimize', 'optimize'],
          description: 'Maintenance mode. analyze commits an updated graph, materialize writes Stage 1 snapshots only, llm_optimize runs Stage 2 batch LLM optimization over cached snapshots, and optimize resumes from cached snapshots to commit stages 2-5.',
          default: 'analyze'
        },
        incremental: {
          type: 'boolean',
          description: 'Analyze mode only. When true (default), reuse unchanged sources and only refresh detected deltas. When false, force-refresh all tracked sources before recommitting the graph.',
          default: true
        },
        force: {
          type: 'boolean',
          description: 'Force the selected maintenance mode even when cached state looks reusable.',
          default: false
        },
        semanticExtraction: {
          type: 'string',
          enum: ['auto', 'heuristic-only', 'llm-assisted', 'llm-primary'],
          description: 'Optional semantic extraction override for analyze, llm_optimize, optimize, or refresh-materialize compatibility flows.'
        },
        rebuildPdfMarkdown: {
          type: 'boolean',
          description: 'When true, force PDF markdown regeneration before re-materialization for affected PDF sources.'
        },
        llmBatchSize: {
          type: 'number',
          description: 'Optional Stage 2 batch size override for llm_optimize or optimize.'
        },
        batchSize: {
          type: 'number',
          description: 'Alias for llmBatchSize.'
        },
        changedSourceKeys: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional sourceKey scope for llm_optimize or optimize. When provided, only those manifest sources are refreshed during Stage 2 before the rest of the corpus state is reused.'
        }
      }
    }
  },
  {
    name: 'refresh_paper_graph',
    description: 'Force-refresh the graph content for one paper or one canonical duplicate group without rebuilding the whole corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or root path. Omit to use the default corpus.'
        },
        paperId: {
          type: 'string',
          description: 'Exact paperId to refresh.'
        },
        sourceKey: {
          type: 'string',
          description: 'Exact manifest sourceKey to refresh.'
        },
        source: {
          type: 'string',
          description: 'Exact source/input path on the server. Accepts absolute paths or ~/... paths.'
        },
        paperTitle: {
          type: 'string',
          description: 'Exact normalized paper title to refresh.'
        },
        includeDuplicateGroup: {
          type: 'boolean',
          description: 'When true (default), refresh and recanonicalize the entire duplicate/canonical group that contains the selected paper.',
          default: true
        },
        rebuildPdfMarkdown: {
          type: 'boolean',
          description: 'When true (default), force PDF markdown regeneration for matched PDF sources before graph refresh.',
          default: true
        },
        semanticExtraction: {
          type: 'string',
          enum: ['auto', 'heuristic-only', 'llm-assisted', 'llm-primary'],
          description: 'Optional semantic extraction mode override for the refresh run.'
        }
      }
    }
  }
];
