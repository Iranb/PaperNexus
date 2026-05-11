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
    description: 'Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks. This is the authoritative readiness check after literature_discovery import: graph queries should only assume visibility after the relevant task reports status=completed and stage=completed.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait'],
          description: 'Use queue_progress/status/wait to track graph-build latency after import submission. wait blocks until terminal state or timeout.'
        },
        corpus: {
          type: 'string',
          description: 'Corpus name or indexed root path. Optional if only one corpus is indexed.'
        },
        taskId: {
          type: 'string',
          description: 'Import task id for status, log, or wait.'
        },
        paperId: {
          type: 'string',
          description: 'Optional paper id used to resolve a task when taskId is omitted.'
        },
        source: {
          type: 'string',
          description: 'Optional source path used to resolve a task when taskId is omitted.'
        },
        serverFilePath: {
          type: 'string',
          description: 'Absolute file path on the PaperNexus server for submit.'
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
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Optional task ids used to filter queue_progress snapshots.'
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
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'literature_discovery',
    description: 'Discover papers from keywords or a topic, merge multi-provider metadata, resolve legal open full text or institutional access hints, persist coverage artifacts, and optionally submit or process resolved files into the graph import queue. Discovery artifacts are available before graph ingestion; use import_workflow status/wait before expecting research_lookup or other graph tools to see newly found papers.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['plan', 'search', 'resolve', 'run', 'import', 'ingest', 'import_and_process', 'supplement', 'status', 'report', 'list'],
          default: 'run',
          description: 'plan/search/run/resolve produce discovery artifacts and do not by themselves make papers graph-visible. import submits resolved full text to the import queue. ingest/import_and_process also process imports inline, but graph visibility still depends on completed import tasks. status/report/list inspect persisted discovery runs.'
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
          default: 'default'
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
          description: 'Maximum query families to execute after LLM planning and deterministic fallback expansion.'
        },
        llmQueryPlanner: {
          type: 'boolean',
          description: 'Use the configured LLM to split the topic into orthogonal literature-search queries before deterministic query expansion. Defaults to true; missing or failing LLM config falls back to deterministic planning.',
          default: true
        },
        maxLlmQueries: {
          type: 'number',
          description: 'Maximum LLM-planned orthogonal queries inserted before deterministic expansion. Defaults by depth: quick=3, default=4, deep=8.',
          default: 4
        },
        llmProvider: {
          type: 'string',
          description: 'Optional LLM provider override for query planning, such as openai, anthropic, or ollama. Defaults to PaperNexus llm config.'
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
          description: 'Contact email used for polite API calls and Unpaywall.'
        },
        openAlexApiKey: {
          type: 'string',
          description: 'Optional OpenAlex API key. If omitted, openAlexApiKeyFile, OPENALEX_API_KEY, or ~/.papernexus/openalex_api_key is used when available.'
        },
        openAlexApiKeyFile: {
          type: 'string',
          description: 'Optional local file containing the OpenAlex API key. Supports ~/ paths. Useful when the key should not be configured in the shell.'
        },
        coreApiKey: {
          type: 'string',
          description: 'Optional CORE API key. If omitted, CORE can also be enabled with CORE_API_KEY in the environment.'
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
          enum: ['hints-only'],
          description: 'Authorized institutional access handling mode. Current implementation records hints only.',
          default: 'hints-only'
        },
        runId: {
          type: 'string',
          description: 'Discovery run id for status/report or supplement operations. If omitted for status/report, the latest run is used.'
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
    name: 'idea_catalyst',
    description: 'Run a challenge-aware interdisciplinary ideation pass over the graph and return either idea fragments or a staged packet bundle.',
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
        includeAnalysis: {
          type: 'boolean',
          default: false
        }
      },
      required: ['problem', 'targetDomain']
    }
  },
  {
    name: 'mutate_graph',
    description: 'Create, update, or delete graph nodes and relationships with schema-aware validation. Supports dry-run previews before writing to disk.',
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
    name: 'refresh_corpus',
    description: 'Trigger incremental re-analysis of a corpus to pick up new or changed papers. Returns the updated corpus status after refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        corpus: {
          type: 'string',
          description: 'Corpus name or root path. Omit to use the default corpus.'
        },
        incremental: {
          type: 'boolean',
          description: 'When true (default), only process papers added since last analysis. When false, rebuild the entire graph.',
          default: true
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if no changes detected.',
          default: false
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
