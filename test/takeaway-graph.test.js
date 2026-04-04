import test from 'node:test';
import assert from 'node:assert/strict';

import { precomputePaperGraphFragment } from '../src/core/ingestion/graph-precompute.js';

test('precomputePaperGraphFragment emits EvidenceSnippet, Takeaway, and IdeaFragment primitives with support edges', () => {
  const fragment = precomputePaperGraphFragment({
    paperId: 'paper-psych-1',
    paperTitle: 'Belief Updating Under Uncertainty',
    sourcePath: '/tmp/paper.md',
    sourceMarkdownPath: '/tmp/paper.md',
    sourcePdfPath: '/tmp/paper.pdf',
    sourceKind: 'markdown',
    sourceFingerprint: 'fp-psych-1',
    authors: [],
    abstract: 'We study reflective prompts for belief calibration.',
    fieldOfStudy: 'Psychology',
    fieldCandidates: ['Psychology', 'Education'],
    domainTags: ['Psychology'],
    abstractMechanisms: ['metacontrol policy'],
    abstractMechanismObjects: [
      {
        name: 'metacontrol policy',
        mechanismType: 'control-policy',
        mechanismCategory: 'adaptive-control',
        description: 'adaptive trade-off between persistence and flexibility'
      }
    ],
    problems: [
      {
        name: 'belief calibration under uncertainty',
        text: 'belief calibration under uncertainty',
        confidence: 0.95
      }
    ],
    methods: [],
    claims: [],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [],
    futureDirections: [],
    benchmarks: [],
    datasets: [],
    metrics: [],
    researchQuestions: [
      {
        name: 'how can interactive systems stabilize belief updates?',
        domainSpecificText: 'How can psychology experiments stabilize belief updates under uncertainty?',
        domainAgnosticText: 'How can interactive systems stabilize belief updates?'
      }
    ],
    openChallenges: [
      {
        name: 'adaptive belief calibration under asymmetric feedback',
        domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
        domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into biased feedback loops.',
        challengeType: 'mixed',
        relatedMechanisms: ['metacontrol policy']
      }
    ],
    takeaways: [
      {
        name: 'reflective prompts stabilize belief updating',
        text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
        relatedMechanisms: ['metacontrol policy'],
        relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
        supportingSnippets: [
          {
            text: 'Reflective prompts improve uncertainty-aware belief revision.',
            sectionHeading: 'Discussion',
            sectionRole: 'discussion'
          }
        ]
      }
    ],
    ideaFragments: [
      {
        name: 'tutoring feedback prompt scaffold',
        text: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
        targetDomain: 'Education',
        sourceDomains: ['Psychology'],
        relatedMechanisms: ['metacontrol policy'],
        sourceTakeaways: ['reflective prompts stabilize belief updating'],
        addressesChallenges: ['adaptive belief calibration under asymmetric feedback'],
        supportingSnippets: [
          {
            text: 'Reflective prompts improve uncertainty-aware belief revision.',
            sectionHeading: 'Discussion',
            sectionRole: 'discussion'
          }
        ]
      }
    ],
    llmRelations: []
  });

  assert.ok(fragment.globalContributions.some((entry) => entry.node.type === 'Takeaway'));
  assert.ok(fragment.globalContributions.some((entry) => entry.node.type === 'IdeaFragment'));
  assert.ok(fragment.paperScopedContributions.some((entry) => entry.node.type === 'EvidenceSnippet'));

  assert.ok(fragment.localRelationships.some((relationship) => relationship.type === 'HAS_TAKEAWAY'));
  assert.ok(fragment.localRelationships.some((relationship) => relationship.type === 'RECONTEXTUALIZES_TO'));
  assert.ok(fragment.localRelationships.some((relationship) => relationship.type === 'ADDRESSES'));
  assert.ok(fragment.localRelationships.some((relationship) => relationship.type === 'SUPPORTED_BY_SNIPPET'));
});
