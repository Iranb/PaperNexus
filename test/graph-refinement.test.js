import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { scoreDomainDistance } from '../src/core/graph/domain-taxonomy.js';
import { NODE_TYPES, EDGE_TYPES } from '../src/core/graph/schema.js';
import { postIngestionRefinement } from '../src/core/ingestion/graph-precompute.js';

test('postIngestionRefinement propagates domain tags, merges near-duplicate mechanisms, refreshes transferability, and adds transfer edges', () => {
  const graph = createKnowledgeGraph();

  graph.addNode({
    id: 'paper:psych',
    type: NODE_TYPES.PAPER,
    name: 'Reflective Prompt Transfer for Belief Updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology']
    }
  });
  graph.addNode({
    id: 'paper:edu',
    type: NODE_TYPES.PAPER,
    name: 'Reducing Confirmation Bias in Tutoring',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education']
    }
  });
  graph.addNode({
    id: 'method:psych-reflective',
    type: NODE_TYPES.METHOD,
    name: 'reflective prompt controller',
    properties: {
      paperTitles: ['Reflective Prompt Transfer for Belief Updating'],
      abstractMechanismObjects: [
        {
          name: 'attention mechanism',
          mechanismType: 'control-policy',
          mechanismCategory: 'adaptive-control'
        }
      ]
    }
  });
  graph.addNode({
    id: 'problem:edu-bias',
    type: NODE_TYPES.PROBLEM,
    name: 'confirmation bias in tutoring feedback',
    properties: {
      paperTitles: ['Reducing Confirmation Bias in Tutoring'],
      abstractMechanismObjects: [
        {
          name: 'attention-based mechanism',
          mechanismType: 'control-policy',
          mechanismCategory: 'adaptive-control'
        }
      ]
    }
  });

  graph.addRelationship({
    id: 'rel:paper-method',
    sourceId: 'paper:psych',
    targetId: 'method:psych-reflective',
    type: EDGE_TYPES.USES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:paper-problem',
    sourceId: 'paper:edu',
    targetId: 'problem:edu-bias',
    type: EDGE_TYPES.SOLVES,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  const beforeMechanisms = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM).length;

  const refinement = postIngestionRefinement(graph);
  const methodNode = graph.getNode('method:psych-reflective');
  const problemNode = graph.getNode('problem:edu-bias');
  const mechanismNodes = graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM);

  assert.ok(beforeMechanisms >= 2);
  assert.equal(refinement.contractVersion, 'idea-catalyst-post-ingestion-refinement-v1');
  assert.equal(methodNode.properties.fieldOfStudy, 'Psychology');
  assert.equal(problemNode.properties.fieldOfStudy, 'Education');
  assert.ok(methodNode.properties.domainTags.includes('Psychology'));
  assert.ok(problemNode.properties.domainTags.includes('Education'));
  assert.equal(mechanismNodes.length, 1);
  assert.equal(mechanismNodes[0].properties.domainCount, 2);
  assert.equal(mechanismNodes[0].properties.transferPotential, 'medium');
  assert.ok(graph.relationships.some((relationship) => (
    relationship.type === EDGE_TYPES.TRANSFERABLE_TO
      && relationship.sourceId === 'method:psych-reflective'
      && relationship.targetId === 'problem:edu-bias'
      && relationship.properties?.relationSource === 'idea-catalyst-transfer-enrichment'
  )));
  assert.ok(refinement.summary.mergedMechanismCount >= 1);
  assert.ok(refinement.summary.transferableEdgeCount >= 1);
  assert.ok(scoreDomainDistance(refinement.domainDistanceMatrix, 'Education', 'Psychology') > 0);
});
