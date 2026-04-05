import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import {
  enrichGraphWithDomainAndMechanismNodes,
  queryCrossDomainBridges
} from '../src/core/graph/domain-bridges.js';
import { extractTakeawaysFromBridgeNodes } from '../src/core/graph/takeaway-extraction.js';

test('extractTakeawaysFromBridgeNodes returns structured source-domain takeaways grounded in bridge evidence', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'takeaway:psych-1',
    type: NODE_TYPES.TAKEAWAY,
    name: 'reflective prompts stabilize belief updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      paperTitles: ['Belief Updating Under Uncertainty'],
      text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      evidenceText: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'challenge:psych-1',
    type: NODE_TYPES.CHALLENGE,
    name: 'adaptive belief calibration under asymmetric feedback',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addRelationship({
    id: 'rel:takeaway-addresses',
    sourceId: 'takeaway:psych-1',
    targetId: 'challenge:psych-1',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);

  const bridgeResult = queryCrossDomainBridges(graph, {
    targetDomain: 'Education',
    agnosticChallenges: ['reduce confirmation bias during tutoring feedback'],
    minDomainDistance: 0,
    limit: 5
  });
  const result = extractTakeawaysFromBridgeNodes(graph, {
    targetDomain: 'Education',
    agnosticChallenges: ['reduce confirmation bias during tutoring feedback'],
    bridgeNodes: bridgeResult.bridgeNodes
  });

  assert.ok(Array.isArray(result.takeaways));
  assert.ok(result.takeaways.length > 0);
  const takeaway = result.takeaways.find((entry) => (
    entry.concept === 'reflective prompts stabilize belief updating'
  ));
  assert.ok(takeaway);
  assert.equal(takeaway.source_domain, 'Psychology');
  assert.equal(takeaway.concept, 'reflective prompts stabilize belief updating');
  assert.equal(takeaway.mechanism, 'metacontrol policy');
  assert.ok(Array.isArray(takeaway.kg_evidence.paper_titles));
  assert.match(takeaway.kg_evidence.evidence_text, /Reflective prompts/i);
});
