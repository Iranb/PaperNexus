import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { slugify, stableHash } from '../src/lib/utils.js';

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function buildCorpusId(name, rootPath) {
  return `corpus:${slugify(name)}:${stableHash(rootPath)}`;
}

function createSemanticPaper(overrides = {}) {
  return {
    paperId: 'paper:new',
    paperTitle: 'New Paper',
    sourceKey: 'source:new',
    sourcePath: '/tmp/new-paper.md',
    sourceMarkdownPath: '/tmp/new-paper.md',
    sourcePdfPath: null,
    sourceKind: 'markdown',
    sourceFingerprint: 'fp:new',
    authors: ['Researcher Example'],
    abstract: 'We study generalized category discovery with prototype alignment.',
    problems: [
      {
        name: 'Generalized Category Discovery',
        text: 'generalized category discovery',
        evidenceText: 'We study generalized category discovery.',
        sectionRole: 'abstract',
        confidence: 0.82
      }
    ],
    methods: [
      {
        name: 'prototype alignment',
        text: 'prototype alignment',
        evidenceText: 'We propose prototype alignment.',
        sectionRole: 'abstract',
        confidence: 0.84
      }
    ],
    datasets: [],
    benchmarks: [],
    metrics: [],
    claims: [
      {
        name: 'Prototype alignment improves generalized category discovery.',
        text: 'Prototype alignment improves generalized category discovery.',
        evidenceText: 'Prototype alignment improves generalized category discovery.',
        sectionRole: 'abstract',
        confidence: 0.8
      }
    ],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [
      {
        text: 'We report evidence on a category discovery benchmark.',
        section: 'Results',
        sectionHeading: 'Results',
        sectionRole: 'results',
        confidence: 0.76,
        linkedDatasets: [],
        linkedMetrics: []
      }
    ],
    futureDirections: [],
    llmRelations: [],
    ...overrides
  };
}

test('buildGraphDeltaPayload returns only changed-paper graph updates for a new paper', async () => {
  const corpusName = 'delta-test';
  const rootPath = '/tmp/delta-test';
  const corpusId = buildCorpusId(corpusName, rootPath);
  const committedGraph = createKnowledgeGraph();

  committedGraph.addNode({
    id: corpusId,
    type: NODE_TYPES.CORPUS,
    name: corpusName,
    properties: {
      layer: 'CorpusLayer',
      rootPath
    }
  });
  committedGraph.addNode({
    id: 'paper:old',
    type: NODE_TYPES.PAPER,
    name: 'Old Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:old',
      paperTitle: 'Old Paper'
    }
  });
  committedGraph.addRelationship(createRelationship(corpusId, 'paper:old', EDGE_TYPES.CONTAINS));

  const delta = await buildGraphDeltaPayload({
    corpusName,
    rootPath,
    committedGraph,
    semanticPapers: [createSemanticPaper()]
  });

  assert.deepEqual(delta.changedSourceKeys, ['source:new']);
  assert.deepEqual(delta.deleteNodeIds, []);
  assert.deepEqual(delta.deleteRelationshipIds, []);
  assert.ok(delta.upsertNodes.some((node) => node.id === 'paper:new'));
  assert.ok(delta.upsertNodes.some((node) => node.type === NODE_TYPES.PROBLEM));
  assert.ok(delta.upsertNodes.every((node) => node.id !== 'paper:old'));
  assert.ok(delta.upsertRelationships.some((relationship) => (
    relationship.sourceId === corpusId && relationship.targetId === 'paper:new'
  )));
});

test('buildGraphDeltaPayload incrementally merges an existing global node for the changed paper', async () => {
  const corpusName = 'delta-test';
  const rootPath = '/tmp/delta-test';
  const committedGraph = createKnowledgeGraph();
  const existingProblemId = `problem:${slugify('Generalized Category Discovery')}:${stableHash(`${NODE_TYPES.PROBLEM}:Generalized Category Discovery`)}`;

  committedGraph.addNode({
    id: existingProblemId,
    type: NODE_TYPES.PROBLEM,
    name: 'Generalized Category Discovery',
    properties: {
      layer: 'ProblemLayer',
      normalized: 'generalized category discovery',
      paperTitles: ['Old Paper'],
      aliases: ['Generalized Category Discovery'],
      mentionCount: 1,
      confidence: 0.72
    }
  });

  const delta = await buildGraphDeltaPayload({
    corpusName,
    rootPath,
    committedGraph,
    semanticPapers: [createSemanticPaper()]
  });

  const mergedProblem = delta.upsertNodes.find((node) => node.id === existingProblemId);
  assert.ok(mergedProblem);
  assert.deepEqual(mergedProblem.properties.paperTitles, ['New Paper', 'Old Paper']);
  assert.equal(mergedProblem.properties.mentionCount, 2);
  assert.ok(mergedProblem.properties.aliases.includes('Generalized Category Discovery'));
});
