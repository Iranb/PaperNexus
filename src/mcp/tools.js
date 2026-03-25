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
                  'update_relationship'
                ],
                description: 'Mutation action. create/update aliases map to upsert.'
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
                description: 'Node type for node operations, or relationship type for relationship operations.'
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
  }
];
