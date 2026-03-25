import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { createLiteGraphPayload } from '../src/core/graph/lite.js';
import { saveLiteGraphMaterializedView } from '../src/storage/lite-view.js';

test('createLiteGraphPayload preserves layer metadata and truncates large fields', () => {
  const graph = createKnowledgeGraph();
  const largeAbstract = 'A'.repeat(900);
  const largeEvidence = 'B'.repeat(500);

  graph.addNode({
    id: 'paper:1',
    type: 'Paper',
    name: 'Large Paper',
    properties: {
      layer: 'DocumentLayer',
      abstract: largeAbstract,
      paperTitle: 'Large Paper',
      paperTitles: ['Large Paper', 'Neighbor Paper'],
      aliases: ['large paper system']
    }
  });

  graph.addNode({
    id: 'problem:1',
    type: 'Problem',
    name: 'class imbalance',
    properties: {
      layer: 'ProblemLayer',
      text: 'Class imbalance in semi-supervised learning',
      brainstormEligible: true,
      brainstormScore: 0.87,
      brainstormTier: 'high'
    }
  });

  graph.addRelationship({
    id: 'rel:1',
    sourceId: 'paper:1',
    targetId: 'problem:1',
    type: 'SOLVES',
    properties: {
      sourceLayer: 'DocumentLayer',
      targetLayer: 'ProblemLayer',
      layerScope: 'cross-layer',
      layerPath: 'DocumentLayer->ProblemLayer',
      evidenceText: largeEvidence,
      relationSource: 'heuristic'
    }
  });

  const payload = createLiteGraphPayload(graph);

  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.relationships.length, 1);
  assert.equal(payload.nodes[0].properties.layer, 'DocumentLayer');
  assert.ok(payload.nodes[0].properties.abstract.length < largeAbstract.length);
  assert.match(payload.nodes[0].properties.abstract, /\.\.\.$/);
  assert.ok(payload.relationships[0].properties.evidenceText.length < largeEvidence.length);
  assert.match(payload.relationships[0].properties.evidenceText, /\.\.\.$/);
  assert.equal(payload.relationships[0].properties.layerPath, 'DocumentLayer->ProblemLayer');
  assert.equal(payload.nodes[1].properties.brainstormEligible, true);
  assert.equal(payload.views.brainstorm.nodeCount, 1);
  assert.deepEqual(payload.views.brainstorm.nodeIds, ['problem:1']);
  assert.ok(payload.indexes.searchTokens.large.includes('paper:1'));
  assert.ok(payload.indexes.searchTokens.imbalance.includes('problem:1'));
  assert.ok(payload.views.brainstorm.indexes.searchTokens.imbalance.includes('problem:1'));
});

test('saveLiteGraphMaterializedView updates shared lite nodes incrementally across source changes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-lite-view-'));
  const liteGraphPath = path.join(tempRoot, 'graph.lite.json');
  const liteStatePath = path.join(tempRoot, 'graph.lite.state.json');

  try {
    const initialGraph = createKnowledgeGraph();
    initialGraph.addNode({
      id: 'paper:a',
      type: 'Paper',
      name: 'Paper A',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:a',
        paperTitle: 'Paper A'
      }
    });
    initialGraph.addNode({
      id: 'paper:b',
      type: 'Paper',
      name: 'Paper B',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:b',
        paperTitle: 'Paper B'
      }
    });
    initialGraph.addNode({
      id: 'problem:shared',
      type: 'Problem',
      name: 'shared problem',
      properties: {
        layer: 'ProblemLayer',
        paperTitles: ['Paper A', 'Paper B'],
        text: 'Shared problem context'
      }
    });
    initialGraph.addRelationship({
      id: 'rel:a',
      sourceId: 'paper:a',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:a',
        sourcePaperTitle: 'Paper A',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });
    initialGraph.addRelationship({
      id: 'rel:b',
      sourceId: 'paper:b',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:b',
        sourcePaperTitle: 'Paper B',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });

    await saveLiteGraphMaterializedView(tempRoot, initialGraph, {
      liteGraphPath,
      liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:a',
          paperId: 'paper:a',
          paperTitle: 'Paper A',
          sourceFingerprint: 'a:1'
        },
        {
          sourceKey: 'source:b',
          paperId: 'paper:b',
          paperTitle: 'Paper B',
          sourceFingerprint: 'b:1'
        }
      ]
    });

    const updatedGraph = createKnowledgeGraph();
    updatedGraph.addNode({
      id: 'paper:b',
      type: 'Paper',
      name: 'Paper B',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:b',
        paperTitle: 'Paper B'
      }
    });
    updatedGraph.addNode({
      id: 'problem:shared',
      type: 'Problem',
      name: 'shared problem',
      properties: {
        layer: 'ProblemLayer',
        paperTitles: ['Paper B'],
        text: 'Shared problem context'
      }
    });
    updatedGraph.addRelationship({
      id: 'rel:b',
      sourceId: 'paper:b',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:b',
        sourcePaperTitle: 'Paper B',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });

    await saveLiteGraphMaterializedView(tempRoot, updatedGraph, {
      liteGraphPath,
      liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:b',
          paperId: 'paper:b',
          paperTitle: 'Paper B',
          sourceFingerprint: 'b:1'
        }
      ]
    });

    const payload = JSON.parse(await fs.readFile(liteGraphPath, 'utf8'));
    const state = JSON.parse(await fs.readFile(liteStatePath, 'utf8'));
    const sharedProblem = payload.nodes.find((node) => node.id === 'problem:shared');

    assert.equal(payload.nodes.some((node) => node.id === 'paper:a'), false);
    assert.equal(payload.relationships.some((relationship) => relationship.id === 'rel:a'), false);
    assert.deepEqual(sharedProblem.properties.paperTitles, ['Paper B']);
    assert.equal(state.sources['source:a'], undefined);
    assert.deepEqual(state.sources['source:b'].nodeIds.sort(), ['paper:b', 'problem:shared']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
