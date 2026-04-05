import test from 'node:test';
import assert from 'node:assert/strict';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { NODE_TYPES } from '../src/core/graph/schema.js';
import { deriveDomainCommunityProfile } from '../src/core/search/brainstorm-communities.js';

test('deriveDomainCommunityProfile surfaces dominant domains and cross-domain bridge pressure from community context', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'problem:edu-bias',
    type: NODE_TYPES.PROBLEM,
    name: 'confirmation bias in tutoring feedback',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education']
    }
  });
  graph.addNode({
    id: 'limitation:edu-feedback',
    type: NODE_TYPES.LIMITATION,
    name: 'feedback loops amplify tutor priors',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education']
    }
  });
  graph.addNode({
    id: 'method:psych-reflective',
    type: NODE_TYPES.METHOD,
    name: 'reflective prompt control policy',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology']
    }
  });
  graph.addNode({
    id: 'takeaway:psych-belief',
    type: NODE_TYPES.TAKEAWAY,
    name: 'reflective prompts stabilize belief updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology']
    }
  });

  const profile = deriveDomainCommunityProfile(graph, {
    communities: [
      {
        id: 'community:education',
        nodeIds: ['problem:edu-bias', 'limitation:edu-feedback']
      },
      {
        id: 'community:psychology',
        nodeIds: ['method:psych-reflective', 'takeaway:psych-belief']
      }
    ],
    crossCommunityBridges: [
      {
        kind: 'problem_method',
        sourceId: 'problem:edu-bias',
        targetId: 'method:psych-reflective',
        score: 4.2
      },
      {
        kind: 'limitation_method',
        sourceId: 'limitation:edu-feedback',
        targetId: 'method:psych-reflective',
        score: 2.6
      }
    ],
    latentNeighbors: [
      {
        id: 'takeaway:psych-belief',
        type: NODE_TYPES.TAKEAWAY
      }
    ],
    boundaryNodes: [
      {
        id: 'limitation:edu-feedback',
        type: NODE_TYPES.LIMITATION
      }
    ],
    stats: {
      fallback: false
    }
  });

  assert.equal(profile.contractVersion, 'idea-catalyst-domain-community-profile-v1');
  assert.equal(profile.communityDomains['community:education'].Education.count, 2);
  assert.equal(profile.communityDomains['community:psychology'].Psychology.count, 2);
  assert.equal(profile.crossDomainBridges.length, 2);
  assert.equal(profile.crossDomainBridges[0].bridgeType, 'cross-domain');
  assert.equal(profile.crossDomainBridges[0].sourceDomain, 'Education');
  assert.equal(profile.crossDomainBridges[0].targetDomain, 'Psychology');
  assert.ok(profile.domainBridgeScores.Psychology > 0);
  assert.equal(profile.domainLatentNeighborCounts.Psychology, 1);
  assert.equal(profile.domainBoundaryCounts.Education, 1);
  assert.equal(profile.topBridgeDomains[0].domain, 'Psychology');
  assert.ok(profile.topBridgeDomains[0].communityBridgeWeight >= 4.2);
});
