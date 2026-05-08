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
    description: 'Return the current source manifest entries for a corpus so remote clients can reconcile which papers are already materialized in the graph.',
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
    description: 'Search a research knowledge graph for relevant papers, problems, methods, claims, findings, limitations, assumptions, evidence, datasets, benchmarks, metrics, and future directions.',
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
    description: 'Run high-level graph lookup operations over remote HTTP MCP using one tool surface for query, context, impact, ideas, brainstorming, exact paper index lookup, domain distance, takeaway extraction, and interdisciplinary potential.',
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
          description: 'Method name, alias, or Method node id used by method_lineage and research_answer.'
        },
        methodName: {
          type: 'string',
          description: 'Alternative method selector used by method_lineage and research_answer.'
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
    description: 'Drive the remote import queue through a single MCP tool that can submit, list, inspect, monitor progress, log, and wait on import tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['submit', 'list', 'status', 'progress', 'queue_progress', 'log', 'wait']
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
          description: 'Maximum seconds to wait for completion when operation is wait.',
          default: 1800
        },
        interval: {
          type: 'number',
          description: 'Polling interval in seconds when operation is wait.',
          default: 2
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
