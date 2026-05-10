import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildMethodEvolutionGapAnalysis } from '../src/core/graph/research-intelligence.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  __methodEvolutionOverlayTestables,
  applyMethodEvolutionOverlayToGraph,
  buildMethodRegistry,
  buildMethodEvolutionOverlay,
  compactMethodEvolutionOverlayForPersistence,
  extractCitationContextsFromPaper
} from '../src/core/ingestion/method-evolution-overlay.js';

const quote = 'The Transformer improves sequence-to-sequence models by replacing recurrent architectures (Sutskever et al., 2014).';

function createLineagePapers(overrides = {}) {
  return [
    {
      paperId: 'paper:attention',
      paperTitle: 'Attention Is All You Need',
      publicationYear: overrides.sourceYear,
      methods: [
        {
          name: 'Transformer',
          aliases: ['self-attention network'],
          confidence: 0.94
        }
      ],
      references: [
        {
          id: 'reference:seq2seq',
          raw: 'Sutskever, I. et al. 2014. Sequence to Sequence Learning with Neural Networks.',
          titleGuess: 'Sequence to Sequence Learning with Neural Networks',
          year: '2014',
          leadAuthorLastName: 'Sutskever'
        }
      ],
      citationContexts: [
        {
          id: 'ctx:attention-seq2seq',
          paperId: 'paper:attention',
          paperTitle: 'Attention Is All You Need',
          sectionHeading: 'Introduction',
          sectionRole: 'introduction',
          citationRaw: 'Sutskever et al., 2014',
          citationStyle: 'author-year',
          referenceId: 'reference:seq2seq',
          referenceRaw: 'Sutskever, I. et al. 2014. Sequence to Sequence Learning with Neural Networks.',
          referenceTitleGuess: 'Sequence to Sequence Learning with Neural Networks',
          referenceYear: 2014,
          referenceLeadAuthorLastName: 'Sutskever',
          exactQuote: quote,
          citationContext: quote
        }
      ]
    },
    {
      paperId: 'paper:seq2seq',
      paperTitle: 'Sequence to Sequence Learning with Neural Networks',
      publicationYear: 2014,
      methods: [
        {
          name: 'Seq2Seq',
          aliases: ['sequence-to-sequence', 'sequence-to-sequence models'],
          confidence: 0.91
        }
      ],
      references: [],
      citationContexts: []
    }
  ];
}

function addMethodNode(graph, name, aliases = []) {
  graph.addNode({
    id: __methodEvolutionOverlayTestables.methodNodeId(name),
    type: NODE_TYPES.METHOD,
    name,
    properties: {
      aliases,
      layer: 'MethodLayer'
    }
  });
}

test('buildMethodEvolutionOverlay creates authoritative method-evolution edges from citation context', () => {
  const overlay = buildMethodEvolutionOverlay(createLineagePapers({ sourceYear: 2017 }), {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(overlay.contractVersion, 'papernexus-method-evolution-overlay-v1');
  assert.equal(overlay.registry.methods.length, 2);
  assert.equal(overlay.candidates.length, 0);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.authoritative.length, 1);

  const edge = overlay.authoritative[0];
  assert.equal(edge.edgeType, EDGE_TYPES.IMPROVES_METHOD);
  assert.equal(edge.sourceMethodName, 'Transformer');
  assert.equal(edge.targetMethodName, 'Seq2Seq');
  assert.equal(edge.validationStatus, 'authoritative');
  assert.equal(edge.exactQuote, quote);
  assert.equal(edge.temporalDirection, 'source-after-target');
  assert.equal(edge.resolutionStatus, 'resolved-paper-method');
  assert.equal(edge.edgeStrength, 'strong');
  assert.equal(edge.dagEdgeType, EDGE_TYPES.VARIANT_OF);
  assert.equal(edge.dagDirection, 'citing-method-to-cited-method');
  assert.equal(edge.validatorStatus, 'passed');
  assert.equal(edge.evidenceCompleteness.status, 'complete');
  assert.equal(edge.bottleneck.dimension, 'parallelization');
  assert.equal(overlay.diagnostics.citationFunnel.evidenceCompleteCount, 1);

  const persisted = compactMethodEvolutionOverlayForPersistence(overlay);
  assert.equal(persisted.summary.acceptedEdgeCount, 1);
  assert.equal(persisted.summary.acceptedStrongEdgeCount, 1);
  assert.equal(persisted.summary.acceptedContextEdgeCount, 0);
  assert.equal(persisted.summary.quoteValidationPassRate, 1);
  assert.equal(persisted.summary.evidenceCompletenessRate, 1);
  assert.deepEqual(persisted.summary.topBottleneckDimensions, [
    { dimension: 'parallelization', count: 1 }
  ]);
});

test('applyMethodEvolutionOverlayToGraph projects only validated layers for default method lineage queries', () => {
  const graph = createKnowledgeGraph();
  addMethodNode(graph, 'Transformer', ['self-attention network']);
  addMethodNode(graph, 'Seq2Seq', ['sequence-to-sequence']);

  const overlay = buildMethodEvolutionOverlay(createLineagePapers({ sourceYear: 2017 }));
  const projection = applyMethodEvolutionOverlayToGraph(graph, overlay);

  assert.equal(projection.relationshipCount, 2);
  assert.equal(projection.skipped.length, 0);
  const projected = graph.relationships.find((relationship) => relationship.type === EDGE_TYPES.IMPROVES_METHOD);
  assert.ok(projected);
  assert.equal(projected.properties.dagEdgeType, EDGE_TYPES.VARIANT_OF);
  assert.equal(projected.properties.paperEdgeType, EDGE_TYPES.IMPROVES_METHOD);
  assert.equal(projected.properties.validatorStatus, 'passed');
  assert.equal(projected.properties.evidenceCompletenessStatus, 'complete');

  const dagProjected = graph.relationships.find((relationship) => relationship.type === EDGE_TYPES.VARIANT_OF);
  assert.ok(dagProjected);
  assert.equal(dagProjected.sourceId, __methodEvolutionOverlayTestables.methodNodeId('Transformer'));
  assert.equal(dagProjected.targetId, __methodEvolutionOverlayTestables.methodNodeId('Seq2Seq'));
  assert.equal(dagProjected.properties.methodEvolutionProjection, true);
  assert.equal(dagProjected.properties.paperEdgeType, EDGE_TYPES.IMPROVES_METHOD);
  assert.equal(projection.diagnostics.paperRelationshipCount, 1);
  assert.equal(projection.diagnostics.dagRelationshipCount, 1);

  const lineage = buildMethodEvolutionGapAnalysis(graph, {
    method: 'Transformer',
    direction: 'backward',
    maxDepth: 1
  });

  assert.equal(lineage.diagnostics.acceptedEdgeCount, 1);
  assert.equal(lineage.lineages[0].steps[1].methodName, 'Seq2Seq');
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.edgeType, EDGE_TYPES.VARIANT_OF);
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.paperEdgeType, EDGE_TYPES.IMPROVES_METHOD);
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.evidence.quote, quote);
});

test('uses-component citations project to COMPONENT_OF with component-to-method DAG direction', () => {
  const componentQuote = 'HybridRetriever uses BM25 as a retrieval component (Robertson et al., 1995).';
  const papers = [
    {
      paperId: 'paper:hybrid',
      paperTitle: 'Hybrid Retriever',
      publicationYear: 2022,
      methods: [{ name: 'HybridRetriever', confidence: 0.9 }],
      citationContexts: [
        {
          id: 'ctx:hybrid-bm25',
          paperId: 'paper:hybrid',
          paperTitle: 'Hybrid Retriever',
          sectionHeading: 'Method',
          sectionRole: 'method',
          citationRaw: 'Robertson et al., 1995',
          referenceRaw: 'Robertson et al. 1995. Okapi at TREC.',
          referenceTitleGuess: 'Okapi at TREC',
          referenceYear: 1995,
          exactQuote: componentQuote,
          citationContext: componentQuote
        }
      ]
    },
    {
      paperId: 'paper:bm25',
      paperTitle: 'Okapi at TREC',
      publicationYear: 1995,
      methods: [{ name: 'BM25', aliases: ['BM25 retrieval'], confidence: 0.9 }],
      citationContexts: []
    }
  ];
  const graph = createKnowledgeGraph();
  addMethodNode(graph, 'HybridRetriever');
  addMethodNode(graph, 'BM25', ['BM25 retrieval']);

  const overlay = buildMethodEvolutionOverlay(papers);
  assert.equal(overlay.validated.length, 1);
  assert.equal(overlay.validated[0].edgeType, EDGE_TYPES.USES_COMPONENT_METHOD);
  assert.equal(overlay.validated[0].dagEdgeType, EDGE_TYPES.COMPONENT_OF);
  assert.equal(overlay.validated[0].dagDirection, 'cited-component-to-citing-method');

  const projection = applyMethodEvolutionOverlayToGraph(graph, overlay);
  assert.equal(projection.relationshipCount, 2);
  const componentEdge = graph.relationships.find((relationship) => relationship.type === EDGE_TYPES.COMPONENT_OF);
  assert.ok(componentEdge);
  assert.equal(componentEdge.sourceId, __methodEvolutionOverlayTestables.methodNodeId('BM25'));
  assert.equal(componentEdge.targetId, __methodEvolutionOverlayTestables.methodNodeId('HybridRetriever'));
  assert.equal(componentEdge.properties.paperEdgeType, EDGE_TYPES.USES_COMPONENT_METHOD);

  const lineage = buildMethodEvolutionGapAnalysis(graph, {
    method: 'HybridRetriever',
    direction: 'backward',
    maxDepth: 1
  });

  assert.equal(lineage.diagnostics.acceptedEdgeCount, 1);
  assert.equal(lineage.lineages[0].steps[1].methodName, 'BM25');
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.edgeType, EDGE_TYPES.COMPONENT_OF);
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.paperEdgeType, EDGE_TYPES.USES_COMPONENT_METHOD);
});

test('missing temporal evidence stays candidate-only and is not projected into default query graph', () => {
  const graph = createKnowledgeGraph();
  addMethodNode(graph, 'Transformer', ['self-attention network']);
  addMethodNode(graph, 'Seq2Seq', ['sequence-to-sequence']);

  const overlay = buildMethodEvolutionOverlay(createLineagePapers({ sourceYear: null }));
  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.candidates.length, 1);
  assert.ok(overlay.candidates[0].validationReasons.includes('missing_temporal_year'));

  const projection = applyMethodEvolutionOverlayToGraph(graph, overlay);
  assert.equal(projection.relationshipCount, 0);
});

test('quote validation rejects method evolution evidence that is not exact-matched in context', () => {
  const papers = createLineagePapers({ sourceYear: 2017 });
  papers[0].citationContexts[0] = {
    ...papers[0].citationContexts[0],
    exactQuote: 'The Transformer improves an unrelated baseline.',
    citationContext: quote
  };

  const overlay = buildMethodEvolutionOverlay(papers, {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.candidates.length, 1);
  assert.equal(overlay.candidates[0].exactMatch, false);
  assert.ok(overlay.candidates[0].validationReasons.includes('quote_not_exact_match'));
  assert.ok(overlay.diagnostics.candidateDiagnostics[0].validationReasons.includes('quote_not_exact_match'));
});

test('strong method evolution edges without an exact quote stay candidate-only', () => {
  const papers = createLineagePapers({ sourceYear: 2017 });
  delete papers[0].citationContexts[0].exactQuote;

  const overlay = buildMethodEvolutionOverlay(papers, {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.candidates.length, 1);
  assert.equal(overlay.candidates[0].exactQuote, '');
  assert.equal(overlay.candidates[0].exactMatch, false);
  assert.ok(overlay.candidates[0].validationReasons.includes('missing_exact_quote'));
  assert.ok(overlay.candidates[0].validatorReasons.includes('missing_exact_quote'));
});

test('conflicting strong method directions stay candidate-only', () => {
  const papers = [
    {
      paperId: 'paper:atlas-a',
      paperTitle: 'Atlas A',
      publicationYear: 2020,
      methods: [{ name: 'AtlasA', confidence: 0.91 }],
      citationContexts: [
        {
          id: 'ctx:atlas-a-to-b',
          paperId: 'paper:atlas-a',
          paperTitle: 'Atlas A',
          citationRaw: 'Beta et al., 2020',
          referenceRaw: 'Beta et al. 2020. Atlas B.',
          referenceTitleGuess: 'Atlas B',
          referenceYear: 2020,
          exactQuote: 'AtlasA improves AtlasB by reducing recurrent bottlenecks (Beta et al., 2020).',
          citationContext: 'AtlasA improves AtlasB by reducing recurrent bottlenecks (Beta et al., 2020).'
        }
      ]
    },
    {
      paperId: 'paper:atlas-b',
      paperTitle: 'Atlas B',
      publicationYear: 2020,
      methods: [{ name: 'AtlasB', confidence: 0.91 }],
      citationContexts: [
        {
          id: 'ctx:atlas-b-to-a',
          paperId: 'paper:atlas-b',
          paperTitle: 'Atlas B',
          citationRaw: 'Alpha et al., 2020',
          referenceRaw: 'Alpha et al. 2020. Atlas A.',
          referenceTitleGuess: 'Atlas A',
          referenceYear: 2020,
          exactQuote: 'AtlasB improves AtlasA by reducing recurrent bottlenecks (Alpha et al., 2020).',
          citationContext: 'AtlasB improves AtlasA by reducing recurrent bottlenecks (Alpha et al., 2020).'
        }
      ]
    }
  ];

  const overlay = buildMethodEvolutionOverlay(papers, {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.candidates.length, 2);
  assert.ok(overlay.candidates.every((candidate) => (
    candidate.validationReasons.includes('conflicting_strong_method_direction')
  )));
  assert.equal(overlay.diagnostics.citationFunnel.candidateCount, 2);
  assert.equal(overlay.diagnostics.citationFunnel.validatedCount, 0);
  assert.equal(overlay.diagnostics.citationFunnel.authoritativeCount, 0);
});

test('noisy citation extraction never throws and records diagnostics-compatible empty results', () => {
  const parsedPaper = {
    paperId: 'paper:noisy',
    paperTitle: 'Noisy PDF Parse',
    references: [
      {
        id: 'reference:1',
        raw: 'Broken reference 2019',
        year: '2019'
      }
    ],
    sections: [
      null,
      {
        heading: 'Method',
        role: 'method',
        chunks: [
          { text: '', citations: [{ raw: '[1]', referenceId: 'reference:1', style: 'numeric' }] },
          { text: 'This chunk has parser noise without usable citation text.', citations: 'not-an-array' }
        ]
      }
    ]
  };

  assert.doesNotThrow(() => extractCitationContextsFromPaper(parsedPaper));
  const extracted = extractCitationContextsFromPaper(parsedPaper);
  assert.equal(extracted.contexts.length, 0);
  assert.equal(extracted.diagnostics.sectionCount, 2);
  assert.equal(extracted.diagnostics.mentionCount, 1);
});

test('context-only method citation edges are retained without polluting lineage traversal', () => {
  const compareQuote = 'We compare the Transformer against sequence-to-sequence models (Sutskever et al., 2014).';
  const papers = createLineagePapers({ sourceYear: null });
  papers[0].citationContexts[0] = {
    ...papers[0].citationContexts[0],
    exactQuote: compareQuote,
    citationContext: compareQuote
  };

  const graph = createKnowledgeGraph();
  addMethodNode(graph, 'Transformer', ['self-attention network']);
  addMethodNode(graph, 'Seq2Seq', ['sequence-to-sequence', 'sequence-to-sequence models']);

  const overlay = buildMethodEvolutionOverlay(papers);
  assert.equal(overlay.candidates.length, 0);
  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.validated.length, 1);
  assert.equal(overlay.validated[0].edgeType, EDGE_TYPES.COMPARES_METHOD);
  assert.equal(overlay.validated[0].edgeStrength, 'context');
  assert.equal(overlay.validated[0].dagEdgeType, null);

  const projection = applyMethodEvolutionOverlayToGraph(graph, overlay);
  assert.equal(projection.relationshipCount, 1);
  const contextRelationship = graph.relationships.find((relationship) => relationship.type === EDGE_TYPES.COMPARES_METHOD);
  assert.ok(contextRelationship);
  assert.equal(contextRelationship.properties.methodEvolution, false);
  assert.equal(contextRelationship.properties.methodEvolutionContext, true);

  const lineage = buildMethodEvolutionGapAnalysis(graph, {
    method: 'Transformer',
    direction: 'backward',
    maxDepth: 1
  });
  assert.equal(lineage.lineages.length, 0);
  assert.equal(lineage.dataStarvation.status, 'starved');
});

test('method registry blocks generic alias surfaces and persists diagnostics', () => {
  const registry = buildMethodRegistry([
    {
      paperId: 'paper:sparse-router',
      paperTitle: 'Sparse Attention Router',
      publicationYear: 2025,
      methods: [
        {
          name: 'Sparse Attention Router',
          aliases: ['model', 'router attention'],
          confidence: 0.9
        }
      ]
    }
  ]);

  assert.equal(registry.methods.length, 1);
  assert.equal(registry.aliases.some((entry) => entry.alias === 'model'), false);
  assert.ok(registry.aliases.some((entry) => entry.alias === 'router attention'));
  assert.equal(registry.diagnostics.entryCount, 1);
  assert.equal(registry.diagnostics.blockedSurfaceCount, 1);
  assert.deepEqual(registry.diagnostics.blockedSurfaces[0], {
    alias: 'model',
    methodId: registry.methods[0].methodId,
    reason: 'generic_surface'
  });

  const persisted = compactMethodEvolutionOverlayForPersistence({
    generatedAt: '2026-05-08T00:00:00.000Z',
    registry,
    candidates: [],
    validated: [],
    authoritative: [],
    diagnostics: { errors: [], citationFunnel: {} }
  });
  assert.equal(persisted.summary.blockedAliasSurfaceCount, 1);
  assert.equal(persisted.registry.diagnostics.blockedSurfaceCount, 1);
});

test('ambiguous aliases are diagnosed and skipped during target method resolution', () => {
  const papers = [
    {
      paperId: 'paper:fusion',
      paperTitle: 'Fusion Reranker',
      publicationYear: 2022,
      methods: [{ name: 'Fusion Reranker', confidence: 0.91 }],
      citationContexts: [
        {
          id: 'ctx:fusion-atlascore',
          paperId: 'paper:fusion',
          paperTitle: 'Fusion Reranker',
          citationRaw: 'Smith et al., 2018',
          referenceRaw: 'Smith et al. 2018.',
          referenceYear: 2018,
          exactQuote: 'Fusion Reranker extends AtlasCore (Smith et al., 2018).',
          citationContext: 'Fusion Reranker extends AtlasCore (Smith et al., 2018).'
        }
      ]
    },
    {
      paperId: 'paper:atlas-graph',
      paperTitle: 'Atlas Graph Learner',
      publicationYear: 2018,
      methods: [{ name: 'Atlas Graph Learner', aliases: ['AtlasCore'] }]
    },
    {
      paperId: 'paper:atlas-memory',
      paperTitle: 'Atlas Memory Planner',
      publicationYear: 2018,
      methods: [{ name: 'Atlas Memory Planner', aliases: ['AtlasCore'] }]
    }
  ];

  const overlay = buildMethodEvolutionOverlay(papers, {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  const ambiguous = overlay.registry.diagnostics.ambiguousSurfaces.find((entry) => entry.alias === 'atlascore');
  assert.ok(ambiguous);
  assert.equal(ambiguous.methodIds.length, 2);
  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.candidates.length, 1);
  assert.equal(overlay.candidates[0].targetMethodId, null);
  assert.ok(overlay.candidates[0].targetStubId);
  assert.equal(overlay.candidates[0].resolutionStatus, 'stub-unresolved');
  assert.ok(overlay.candidates[0].validationReasons.includes('target_method_stub'));
});

test('negative method surfaces prevent alias false positives', () => {
  const papers = [
    {
      paperId: 'paper:retriever-fusion',
      paperTitle: 'Retriever Fusion',
      publicationYear: 2023,
      methods: [{ name: 'RetrieverFusion', confidence: 0.88 }],
      citationContexts: [
        {
          id: 'ctx:retriever-dense',
          paperId: 'paper:retriever-fusion',
          paperTitle: 'Retriever Fusion',
          citationRaw: 'Jones et al., 2019',
          referenceRaw: 'Jones et al. 2019.',
          referenceYear: 2019,
          exactQuote: 'RetrieverFusion adapts dense retrieval (Jones et al., 2019).',
          citationContext: 'RetrieverFusion adapts dense retrieval (Jones et al., 2019).'
        }
      ]
    },
    {
      paperId: 'paper:densenet',
      paperTitle: 'Densely Connected Convolutional Networks',
      publicationYear: 2017,
      methods: [
        {
          name: 'DenseNet',
          aliases: ['dense'],
          negativeSurfaces: ['dense retrieval']
        }
      ]
    }
  ];

  const overlay = buildMethodEvolutionOverlay(papers, {
    generatedAt: '2026-05-08T00:00:00.000Z'
  });

  assert.equal(overlay.validated.length, 0);
  assert.equal(overlay.authoritative.length, 0);
  assert.equal(overlay.candidates.length, 1);
  assert.equal(overlay.candidates[0].targetMethodId, null);
  assert.ok(overlay.candidates[0].targetStubId);
  assert.ok(overlay.candidates[0].validationReasons.includes('target_method_stub'));
});
