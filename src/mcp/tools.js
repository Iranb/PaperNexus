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
  }
];
