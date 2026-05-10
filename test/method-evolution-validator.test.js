import test from 'node:test';
import assert from 'node:assert/strict';

import { EDGE_TYPES } from '../src/core/graph/schema.js';
import {
  applyStrongEdgeConflictValidation,
  assessMethodEvolutionEvidenceCompleteness,
  validateMethodEvolutionCandidate
} from '../src/core/ingestion/method-evolution-validator.js';

function createStrongCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate:strong',
    edgeType: EDGE_TYPES.IMPROVES_METHOD,
    sourceMethodId: overrides.sourceMethodId || 'method:source',
    targetMethodId: overrides.targetMethodId || 'method:target',
    exactQuote: 'Source improves Target by replacing recurrent bottlenecks.',
    citationContext: 'Source improves Target by replacing recurrent bottlenecks.',
    quoteValidationContext: 'Source improves Target by replacing recurrent bottlenecks.',
    semanticConfidence: 0.84,
    confidence: 0.92,
    temporalDirection: 'source-after-target',
    resolutionStatus: 'resolved-paper-method',
    bottleneck: {
      dimension: 'parallelization',
      description: 'Target is bottlenecked by sequential recurrence.'
    },
    mechanism: {
      dimension: 'bottleneck-mitigation',
      description: 'Source replaces the recurrent component.'
    },
    tradeoff: {
      dimension: 'implementation-complexity',
      description: ''
    },
    ...overrides
  };
}

test('validateMethodEvolutionCandidate requires complete strong-edge evidence', () => {
  const candidate = createStrongCandidate({
    mechanism: {
      dimension: 'bottleneck-mitigation',
      description: ''
    }
  });

  const result = validateMethodEvolutionCandidate(candidate);

  assert.equal(result.validationStatus, 'candidate');
  assert.equal(result.validatorStatus, 'blocked');
  assert.equal(result.evidenceCompleteness.status, 'incomplete');
  assert.deepEqual(result.evidenceCompleteness.missingFields, ['mechanism.description']);
  assert.ok(result.validationReasons.includes('missing_evidence_mechanism_description'));
});

test('validateMethodEvolutionCandidate passes authoritative strong edges with minimal evidence', () => {
  const result = validateMethodEvolutionCandidate(createStrongCandidate());

  assert.equal(result.validationStatus, 'authoritative');
  assert.equal(result.validatorStatus, 'passed');
  assert.equal(result.evidenceCompleteness.status, 'complete');
  assert.deepEqual(result.validationReasons, []);
});

test('context method citations do not require strong-edge evidence completeness', () => {
  const result = validateMethodEvolutionCandidate({
    id: 'candidate:compare',
    edgeType: EDGE_TYPES.COMPARES_METHOD,
    sourceMethodId: 'method:source',
    targetMethodId: 'method:target',
    citationContext: 'Source compares against Target.',
    semanticConfidence: 0.62,
    temporalDirection: 'unknown',
    resolutionStatus: 'resolved-paper-method'
  });

  assert.equal(result.validationStatus, 'validated');
  assert.equal(result.validatorStatus, 'passed');
  assert.equal(result.evidenceCompleteness.status, 'not_required');
  assert.equal(result.validationReasons.includes('missing_exact_quote'), false);
});

test('applyStrongEdgeConflictValidation demotes both directions of a strong conflict', () => {
  const records = [
    {
      ...createStrongCandidate({
        id: 'candidate:a-to-b',
        sourceMethodId: 'method:a',
        targetMethodId: 'method:b'
      }),
      ...validateMethodEvolutionCandidate(createStrongCandidate({
        id: 'candidate:a-to-b',
        sourceMethodId: 'method:a',
        targetMethodId: 'method:b'
      }))
    },
    {
      ...createStrongCandidate({
        id: 'candidate:b-to-a',
        sourceMethodId: 'method:b',
        targetMethodId: 'method:a'
      }),
      ...validateMethodEvolutionCandidate(createStrongCandidate({
        id: 'candidate:b-to-a',
        sourceMethodId: 'method:b',
        targetMethodId: 'method:a'
      }))
    }
  ];

  const result = applyStrongEdgeConflictValidation(records);

  assert.equal(result.length, 2);
  assert.ok(result.every((candidate) => candidate.validationStatus === 'candidate'));
  assert.ok(result.every((candidate) => (
    candidate.validatorReasons.includes('conflicting_strong_method_direction')
  )));
});
