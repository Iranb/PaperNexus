import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChallengeVariantRecords } from '../src/core/graph/challenges.js';

test('buildChallengeVariantRecords preserves domain-specific and domain-agnostic variants for later bridge and analogy stages', () => {
  const variants = buildChallengeVariantRecords({
    name: 'adaptive belief calibration under asymmetric feedback',
    domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
    domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
    challengeType: 'mixed',
    relatedMechanisms: ['metacontrol policy']
  }, {
    fieldOfStudy: 'Education',
    domainTags: ['Education', 'Psychology']
  });

  assert.equal(variants.length, 2);
  const specific = variants.find((entry) => entry.abstractionLevel === 'specific');
  const agnostic = variants.find((entry) => entry.abstractionLevel === 'agnostic');

  assert.ok(specific);
  assert.ok(agnostic);
  assert.equal(specific.challengeType, 'mixed');
  assert.equal(agnostic.challengeType, 'mixed');
  assert.deepEqual(specific.relatedMechanisms, ['metacontrol policy']);
  assert.deepEqual(agnostic.relatedMechanisms, ['metacontrol policy']);
  assert.match(specific.bridgeRetrievalText, /interactive systems/i);
  assert.match(agnostic.analogyText, /interactive systems/i);
});
