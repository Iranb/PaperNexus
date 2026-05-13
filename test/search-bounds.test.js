import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { queryCrossDomainBridges, enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { buildCatalystQuery } from '../src/core/graph/catalyst-adapter.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { searchGraph, buildBrainstorm, buildImpact } from '../src/core/search/search.js';

function createSearchFixtureGraph(count = 80) {
  const graph = createKnowledgeGraph();
  for (let index = 0; index < count; index += 1) {
    graph.addNode({
      id: `paper:${index}`,
      type: NODE_TYPES.PAPER,
      name: `Experiment planning paper ${index}`,
      properties: {
        paperId: `paper:${index}`,
        paperTitle: `Experiment planning paper ${index}`,
        abstract: 'experiment planning graph retrieval'
      }
    });
  }
  return graph;
}

function createImpactFixtureGraph(length = 12) {
  const graph = createKnowledgeGraph();
  for (let index = 0; index < length; index += 1) {
    graph.addNode({
      id: `method:${index}`,
      type: NODE_TYPES.METHOD,
      name: `planning method ${index}`,
      properties: {}
    });
  }
  for (let index = 0; index < length - 1; index += 1) {
    graph.addRelationship({
      id: `rel:${index}`,
      sourceId: `method:${index}`,
      targetId: `method:${index + 1}`,
      type: EDGE_TYPES.RELATED_TO,
      properties: {}
    });
  }
  return graph;
}

function createCatalystFixtureGraph(count = 80) {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'problem:target',
    type: NODE_TYPES.PROBLEM,
    name: 'planning feedback problem',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['feedback control']
    }
  });

  for (let index = 0; index < count; index += 1) {
    graph.addNode({
      id: `method:source-${index}`,
      type: NODE_TYPES.METHOD,
      name: `planning feedback transfer method ${index}`,
      properties: {
        fieldOfStudy: `Source Domain ${index}`,
        domainTags: [`Source Domain ${index}`],
        abstractMechanisms: ['feedback control']
      }
    });
  }

  enrichGraphWithDomainAndMechanismNodes(graph);
  return graph;
}

test('graph search helpers clamp externally supplied traversal bounds', () => {
  const searchGraphFixture = createSearchFixtureGraph();
  const searchResult = searchGraph(searchGraphFixture, 'experiment planning', {
    limit: 9999
  });
  assert.equal(searchResult.groups.length, 50);

  const impactGraphFixture = createImpactFixtureGraph();
  const impact = buildImpact(impactGraphFixture, 'method:0', {
    direction: 'downstream',
    maxDepth: 9999
  });
  assert.equal(Math.max(...impact.byDepth.map((bucket) => bucket.depth)), 8);
  assert.equal(
    impact.byDepth.flatMap((bucket) => bucket.nodes).some((node) => node.id === 'method:9'),
    false
  );

  const brainstorm = buildBrainstorm(createKnowledgeGraph(), 'missing topic', {
    mode: 'diverge',
    maxHops: 9999
  });
  assert.equal(brainstorm.exploredHops, 4);
});

test('catalyst graph helpers clamp large result and source-domain bounds', () => {
  const graph = createCatalystFixtureGraph();
  const bridges = queryCrossDomainBridges(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'planning feedback',
    limit: 9999
  });
  assert.equal(bridges.bridgeNodes.length, 50);
  assert.equal(bridges.candidateDomains.length, 50);

  const catalyst = buildCatalystQuery(graph, {
    targetDomain: 'Education',
    abstractChallenge: 'planning feedback',
    mechanisms: ['feedback control'],
    limit: 9999,
    numSourceDomains: 9999
  });
  assert.equal(catalyst.bridgeNodes.length, 50);
  assert.equal(catalyst.packetBundle.cross_domain_queries.length, 12);
});
