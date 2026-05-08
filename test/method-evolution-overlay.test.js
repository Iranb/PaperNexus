import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildMethodEvolutionGapAnalysis } from '../src/core/graph/research-intelligence.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  __methodEvolutionOverlayTestables,
  applyMethodEvolutionOverlayToGraph,
  buildMethodEvolutionOverlay,
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
  assert.equal(edge.bottleneck.dimension, 'parallelization');
});

test('applyMethodEvolutionOverlayToGraph projects only validated layers for default method lineage queries', () => {
  const graph = createKnowledgeGraph();
  addMethodNode(graph, 'Transformer', ['self-attention network']);
  addMethodNode(graph, 'Seq2Seq', ['sequence-to-sequence']);

  const overlay = buildMethodEvolutionOverlay(createLineagePapers({ sourceYear: 2017 }));
  const projection = applyMethodEvolutionOverlayToGraph(graph, overlay);

  assert.equal(projection.relationshipCount, 1);
  assert.equal(projection.skipped.length, 0);
  assert.ok(graph.relationships.some((relationship) => relationship.type === EDGE_TYPES.IMPROVES_METHOD));

  const lineage = buildMethodEvolutionGapAnalysis(graph, {
    method: 'Transformer',
    direction: 'backward',
    maxDepth: 1
  });

  assert.equal(lineage.diagnostics.acceptedEdgeCount, 1);
  assert.equal(lineage.lineages[0].steps[1].methodName, 'Seq2Seq');
  assert.equal(lineage.lineages[0].steps[0].edgeToNext.evidence.quote, quote);
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
