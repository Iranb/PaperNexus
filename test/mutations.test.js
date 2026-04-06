import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { applyGraphMutations } from '../src/core/graph/mutations.js';
import { NODE_TYPES, getNodeLayer } from '../src/core/graph/schema.js';

function makeNode(id, type, name, properties = {}) {
  return {
    id,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      ...properties
    }
  };
}

test('graph mutations create schema-valid nodes and relationships', () => {
  const graph = createKnowledgeGraph();
  graph.addNode(makeNode('problem:1', NODE_TYPES.PROBLEM, 'class imbalance in semi-supervised learning'));

  const result = applyGraphMutations(graph, [
    {
      action: 'create_node',
      type: 'Method',
      name: 'distribution-aware pseudo labeling',
      properties: {
        aliases: ['DAPL']
      }
    },
    {
      action: 'create_relationship',
      source: { type: 'Method', name: 'distribution-aware pseudo labeling' },
      target: { id: 'problem:1' },
      type: 'APPLIES_TO'
    }
  ], {
    actor: 'mutation-test'
  });

  assert.equal(graph.nodeCount, 1, 'original graph should stay unchanged');
  assert.equal(result.graph.nodeCount, 2);
  assert.equal(result.graph.relationshipCount, 1);
  assert.equal(result.summary.nodesCreated, 1);
  assert.equal(result.summary.relationshipsCreated, 1);

  const methodMatches = result.graph.getSearchCandidates('distribution aware pseudo labeling');
  assert.ok(methodMatches.some((node) => node.type === NODE_TYPES.METHOD));

  const createdMethod = result.graph.nodes.find((node) => node.type === NODE_TYPES.METHOD);
  assert.equal(createdMethod.properties.createdBy, 'mutation-test');
  assert.equal(createdMethod.properties.editSource, 'agent-rule');

  const relation = result.graph.relationships[0];
  assert.equal(relation.type, 'APPLIES_TO');
  assert.equal(relation.properties.layerPath, 'MethodLayer->ProblemLayer');
});

test('graph mutations update search indexes and reject invalid relations', () => {
  const graph = createKnowledgeGraph();
  graph.addNode(makeNode('method:1', NODE_TYPES.METHOD, 'entropy minimization baseline'));
  graph.addNode(makeNode('claim:1', NODE_TYPES.CLAIM, 'improves robustness under label scarcity'));

  const updated = applyGraphMutations(graph, [
    {
      action: 'update_node',
      id: 'method:1',
      name: 'entropy-guided consistency training'
    }
  ], {
    actor: 'mutation-test'
  });

  assert.equal(updated.summary.nodesUpdated, 1);
  assert.equal(updated.graph.getSearchCandidates('entropy-guided').length, 1);
  assert.equal(updated.graph.getSearchCandidates('baseline').length, 0);

  assert.throws(() => {
    applyGraphMutations(updated.graph, [
      {
        action: 'create_relationship',
        source: { id: 'method:1' },
        target: { id: 'claim:1' },
        type: 'APPLIES_TO'
      }
    ]);
  }, /Invalid relationship/);
});

test('graph mutations can create and delete bidirectional symmetric relationships', () => {
  const graph = createKnowledgeGraph();
  graph.addNode(makeNode('method:1', NODE_TYPES.METHOD, 'consistency regularization'));
  graph.addNode(makeNode('method:2', NODE_TYPES.METHOD, 'class-aware thresholding'));

  const created = applyGraphMutations(graph, [
    {
      action: 'create_relationship',
      source: { id: 'method:1' },
      target: { id: 'method:2' },
      type: 'COMBINES_WITH',
      bidirectional: true
    }
  ]);

  assert.equal(created.graph.relationshipCount, 2);
  assert.equal(created.summary.relationshipsCreated, 2);

  const deleted = applyGraphMutations(created.graph, [
    {
      action: 'delete_relationship',
      source: { id: 'method:1' },
      target: { id: 'method:2' },
      type: 'COMBINES_WITH',
      bidirectional: true
    }
  ]);

  assert.equal(deleted.graph.relationshipCount, 0);
  assert.equal(deleted.summary.relationshipsDeleted, 2);
});

test('graph mutations dedupe create_edge retries that use edgeType aliases', () => {
  const graph = createKnowledgeGraph();
  graph.addNode(makeNode('claim:1', NODE_TYPES.CLAIM, 'support routing improves stability'));
  graph.addNode(makeNode('finding:1', NODE_TYPES.FINDING, 'finding_exp_1'));

  const created = applyGraphMutations(graph, [
    {
      action: 'create_edge',
      edgeType: 'SUPPORTED_BY',
      from: 'claim:1',
      to: 'finding:1',
      properties: {
        experimentId: 'exp-1',
        confidence: 0.71
      }
    }
  ], {
    actor: 'mutation-test'
  });

  assert.equal(created.graph.relationshipCount, 1);
  assert.equal(created.summary.relationshipsCreated, 1);
  assert.equal(created.summary.relationshipsUpdated, 0);

  const retried = applyGraphMutations(created.graph, [
    {
      action: 'create_edge',
      edgeType: 'SUPPORTED_BY',
      from: 'claim:1',
      to: 'finding:1',
      properties: {
        experimentId: 'exp-1',
        confidence: 0.93
      }
    }
  ], {
    actor: 'mutation-test'
  });

  assert.equal(retried.graph.relationshipCount, 1);
  assert.equal(retried.summary.relationshipsCreated, 0);
  assert.equal(retried.summary.relationshipsUpdated, 1);
  assert.equal(retried.graph.relationships[0].properties.confidence, 0.93);
});
