import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateHumanBlindEvaluationLabels,
  buildHumanBlindEvaluationPack,
  HUMAN_BLIND_EVAL_VERSION,
  prepareHumanBlindEvaluation
} from '../src/core/eval/human-blind-eval.js';

function packet(label, score) {
  return {
    system_label: label,
    model_name: `${label}-model`,
    proposal: {
      title: `Grounded proposal ${score}`,
      summary: 'Uses claim-level evidence and must-cite coverage.'
    },
    internal_notes: `hidden ${label} reviewer notes`,
    provider_trace: {
      model: `${label}-trace-model`
    },
    evidence_export: {
      must_cite_set: [{ title: 'Anchor method', doi: '10.1000/anchor' }],
      contribution_claims: [{
        claim_id: 'claim:1',
        claim_text: 'The proposal improves grounding.',
        source_span_ids: ['span:1']
      }]
    }
  };
}

function inputFixture(options = {}) {
  const fixture = {
    name: 'human-blind-mini',
    cases: [{
      id: 'case:1',
      topic: 'grounded idea evaluation',
      baseline: packet('baseline', 1),
      candidate: packet('candidate', 2)
    }]
  };
  if (options.fullComparators) {
    fixture.cases[0].p0 = packet('p0', 1.2);
    fixture.cases[0].p1 = packet('p1', 1.5);
    fixture.cases[0].ablations = {
      without_claim_graph: packet('without_claim_graph', 0.8)
    };
  }
  return fixture;
}

function labelsFor(packOrAnswerKey, sides = [], assignmentPack = null) {
  const answerKey = packOrAnswerKey.answerKey || packOrAnswerKey;
  const assignments = assignmentPack || packOrAnswerKey.assignments || {};
  const assignmentsByPairRole = new Map();
  for (const assignment of assignments.assignments || []) {
    const key = `${assignment.pair_id}:${assignment.reviewer_role}`;
    if (!assignmentsByPairRole.has(key)) assignmentsByPairRole.set(key, []);
    assignmentsByPairRole.get(key).push(assignment);
  }
  const roles = ['domain_expert', 'domain_expert', 'domain_expert', 'methodology', 'reproducibility'];
  return answerKey.pairs
    .filter((pair) => pair.target_side)
    .flatMap((pair, pairIndex) => {
      const targetSide = pair.target_side;
      const comparatorSide = targetSide === 'left' ? 'right' : 'left';
      const roleCursor = {};
      return roles.map((role, index) => {
        const selected = sides[index] === 'target' ? targetSide : comparatorSide;
        const roleKey = `${pair.pair_id}:${role}`;
        const roleIndex = roleCursor[role] || 0;
        const assignment = assignmentsByPairRole.get(roleKey)?.[roleIndex];
        roleCursor[role] = roleIndex + 1;
        return {
          pair_id: pair.pair_id,
          ...(assignment ? { assignment_id: assignment.assignment_id } : {}),
          reviewer_id: `human:${pairIndex + 1}:${index + 1}`,
          reviewer_role: role,
          reviewer_source: 'human',
          selected_side: selected,
          confidence: index === 0 ? 0.8 : 1,
          scores: {
            [targetSide]: {
              novelty: sides[index] === 'target' ? 5 : 3,
              significance: 4,
              feasibility: 4,
              grounding: 5,
              storyline_coherence: 4,
              must_cite_completeness: 5
            },
            [comparatorSide]: {
              novelty: sides[index] === 'target' ? 3 : 5,
              significance: 3,
              feasibility: 3,
              grounding: 2,
              storyline_coherence: 3,
              must_cite_completeness: 2
            }
          },
          major_concerns: index === 0 ? ['Check evidence transfer risk.'] : []
        };
      });
    });
}

test('human blind pack masks system labels and keeps deterministic side assignment', () => {
  const first = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-mini',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const second = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-mini',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });

  assert.equal(first.contractVersion, HUMAN_BLIND_EVAL_VERSION);
  assert.deepEqual(first.blindPack.pairs, second.blindPack.pairs);
  assert.deepEqual(first.assignments.assignments, second.assignments.assignments);
  assert.equal(first.blindPack.packets.length, 2);
  assert.equal(first.assignments.assignment_count, 5);

  const blinded = JSON.stringify({
    blindPack: first.blindPack,
    assignments: first.assignments
  });
  assert.equal(blinded.includes('candidate'), false);
  assert.equal(blinded.includes('baseline'), false);
  assert.equal(blinded.includes('internal_notes'), false);
  assert.equal(blinded.includes('provider_trace'), false);
  assert.deepEqual(Object.keys(first.blindPack.packets[0].payload).sort(), ['evidence_export', 'proposal']);
  assert.match(JSON.stringify(first.answerKey), /candidate/);
  assert.match(JSON.stringify(first.answerKey), /baseline/);
});

test('human blind aggregation stays incomplete without required human reviewer roles', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-incomplete',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const pair = pack.answerKey.pairs[0];
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: [{
      pair_id: pair.pair_id,
      reviewer_id: 'human:1',
      reviewer_role: 'domain_expert',
      reviewer_source: 'human',
      selected_side: pair.target_side,
      confidence: 1
    }]
  });

  assert.equal(aggregation.status, 'incomplete');
  assert.equal(aggregation.label_counts.valid_human_target_pair, 1);
  assert.equal(aggregation.reviewer_protocol.sufficient_reviewers, false);
  assert.equal(aggregation.reviewer_protocol.independent_reviewers, false);
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.equal(aggregation.releaseReadiness.releaseCandidate, false);
});

test('human blind aggregation rejects role-sufficient labels that reuse reviewer identities across slots', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-duplicate-reviewers',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const labels = labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator']);
  labels[3].reviewer_id = labels[0].reviewer_id;
  labels[4].reviewer_id = labels[1].reviewer_id;
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels
  });
  const pairProtocol = aggregation.reviewer_protocol.pairs[0];

  assert.equal(aggregation.status, 'incomplete');
  assert.equal(aggregation.reviewer_protocol.sufficient_reviewers, false);
  assert.equal(aggregation.reviewer_protocol.independent_reviewers, false);
  assert.equal(pairProtocol.role_counts.domain_expert, 3);
  assert.equal(pairProtocol.role_counts.methodology, 1);
  assert.equal(pairProtocol.role_counts.reproducibility, 1);
  assert.equal(pairProtocol.distinct_reviewer_count, 3);
  assert.equal(pairProtocol.required_distinct_reviewer_count, 5);
  assert.deepEqual(pairProtocol.duplicate_reviewer_ids, ['human:1:1', 'human:1:2']);
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.equal(
    aggregation.releaseReadiness.checks.find((entry) => entry.name === 'reviewer_identity_independence_satisfied').status,
    'incomplete'
  );
});

test('human blind release readiness requires baseline, P0, P1, and ablation comparisons', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-missing-comparators',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator'])
  });

  assert.equal(aggregation.status, 'passed');
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.deepEqual(aggregation.comparison_protocol.covered_comparison_families, ['baseline']);
  assert.deepEqual(aggregation.comparison_protocol.missing_comparison_families, ['p0', 'p1', 'ablation']);
  assert.equal(
    aggregation.releaseReadiness.checks.find((entry) => entry.name === 'comparison_coverage_satisfied').status,
    'incomplete'
  );
});

test('human blind aggregation passes at the 60 percent independent human preference threshold', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture({ fullComparators: true }),
    runId: 'blind-pass',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator'])
  });

  assert.equal(aggregation.status, 'passed');
  assert.equal(aggregation.releaseReadiness.status, 'ready_for_release_gate');
  assert.equal(aggregation.releaseReadiness.releaseCandidate, true);
  assert.equal(aggregation.target_preference_rate, 0.6);
  assert.equal(aggregation.reviewer_protocol.sufficient_reviewers, true);
  assert.equal(aggregation.reviewer_protocol.independent_reviewers, true);
  assert.equal(aggregation.comparison_protocol.complete, true);
  assert.deepEqual(aggregation.comparison_protocol.covered_comparison_families, ['ablation', 'baseline', 'p0', 'p1']);
  assert.equal(aggregation.review_form_protocol.complete, true);
  assert.equal(aggregation.per_dimension.novelty.count, 20);
  assert.equal(aggregation.inter_reviewer_agreement.pair_count, 4);
});

test('human blind release readiness requires completed labels to bind generated assignments', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture({ fullComparators: true }),
    runId: 'blind-assignment-required',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const labelsWithoutAssignmentIds = labelsFor(pack.answerKey, ['target', 'target', 'target', 'comparator', 'comparator']);
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: labelsWithoutAssignmentIds
  });

  assert.equal(aggregation.status, 'passed');
  assert.equal(aggregation.assignment_protocol.complete, false);
  assert.equal(aggregation.assignment_protocol.missing_assignment_id_label_count, 20);
  assert.equal(aggregation.assignment_protocol.missing_required_assignments.length, 20);
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.equal(
    aggregation.releaseReadiness.checks.find((entry) => entry.name === 'assignment_coverage_satisfied').status,
    'incomplete'
  );
});

test('human blind release readiness requires blinding protocol audit', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture({ fullComparators: true }),
    runId: 'blind-audit-required',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const missingAudit = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    protocol: pack.protocol,
    labels: labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator'])
  });
  const leakedPack = {
    ...pack.blindPack,
    packets: [{
      ...pack.blindPack.packets[0],
      payload: {
        ...pack.blindPack.packets[0].payload,
        system_label: 'candidate',
        internal_notes: 'leaked reviewer-visible notes'
      }
    }, ...pack.blindPack.packets.slice(1)]
  };
  const leakedAudit = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: leakedPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator'])
  });

  assert.equal(missingAudit.status, 'passed');
  assert.equal(missingAudit.releaseReadiness.status, 'incomplete');
  assert.equal(
    missingAudit.releaseReadiness.checks.find((entry) => entry.name === 'blinding_protocol_satisfied').status,
    'incomplete'
  );
  assert.deepEqual(missingAudit.blinding_protocol.missing_public_artifacts, ['blind_pack', 'assignments']);
  assert.equal(leakedAudit.releaseReadiness.status, 'incomplete');
  assert.equal(leakedAudit.blinding_protocol.complete, false);
  assert.ok(leakedAudit.blinding_protocol.forbidden_public_fields.some((entry) => entry.endsWith('system_label')));
  assert.ok(leakedAudit.blinding_protocol.unexpected_public_payload_fields.some((entry) => entry.endsWith('internal_notes')));
});

test('human blind release readiness requires complete review form labels', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-incomplete-review-form',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const labels = labelsFor(pack, ['target', 'target', 'target', 'comparator', 'comparator']);
  delete labels[0].scores;
  delete labels[1].confidence;
  delete labels[2].major_concerns;
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels
  });

  assert.equal(aggregation.status, 'passed');
  assert.equal(aggregation.review_form_protocol.complete, false);
  assert.equal(aggregation.review_form_protocol.missing_dimension_score_labels.length, 1);
  assert.equal(aggregation.review_form_protocol.missing_confidence_labels.length, 1);
  assert.equal(aggregation.review_form_protocol.missing_major_concerns_labels.length, 1);
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.equal(
    aggregation.releaseReadiness.checks.find((entry) => entry.name === 'review_form_completeness_satisfied').status,
    'incomplete'
  );
});

test('AI and author labels are excluded from release-pass evidence', () => {
  const pack = buildHumanBlindEvaluationPack({
    input: inputFixture(),
    runId: 'blind-non-human',
    seed: 'stable-seed',
    generatedAt: '2026-05-26T00:00:00.000Z'
  });
  const aiLabels = labelsFor(pack, ['target', 'target', 'target', 'target', 'target'])
    .map((label, index) => ({
      ...label,
      reviewer_id: `ai:${index + 1}`,
      reviewer_source: index === 0 ? 'author' : 'ai'
    }));
  const aggregation = aggregateHumanBlindEvaluationLabels({
    answerKey: pack.answerKey,
    blindPack: pack.blindPack,
    assignments: pack.assignments,
    protocol: pack.protocol,
    labels: aiLabels
  });

  assert.equal(aggregation.status, 'incomplete');
  assert.equal(aggregation.releaseReadiness.status, 'incomplete');
  assert.equal(aggregation.label_counts.valid_human, 0);
  assert.equal(aggregation.label_counts.excluded_non_human, 5);
  assert.equal(aggregation.excluded_labels.some((entry) => entry.reason === 'author_or_self_label'), true);
  assert.equal(aggregation.excluded_labels.some((entry) => entry.reason === 'ai_label'), true);
});

test('human blind preparation writes expected sandbox artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-human-blind-'));
  try {
    const inputPath = path.join(tempRoot, 'input.json');
    const labelsPath = path.join(tempRoot, 'labels.json');
    const outputDir = path.join(tempRoot, 'out');
    const input = inputFixture({ fullComparators: true });
    const seedPack = buildHumanBlindEvaluationPack({
      input,
      runId: 'blind-write',
      seed: 'stable-seed',
      generatedAt: '2026-05-26T00:00:00.000Z'
    });
    await fs.writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
    await fs.writeFile(labelsPath, `${JSON.stringify({ labels: labelsFor(seedPack, ['target', 'target', 'target', 'comparator', 'comparator']) }, null, 2)}\n`);

    const result = await prepareHumanBlindEvaluation({
      inputPath,
      labelsPath,
      outputDir,
      runId: 'blind-write',
      seed: 'stable-seed',
      generatedAt: '2026-05-26T00:00:00.000Z'
    });

    assert.equal(result.status, 'passed');
    const aggregation = JSON.parse(await fs.readFile(path.join(outputDir, 'aggregation.json'), 'utf8'));
    assert.equal(aggregation.status, 'passed');
    assert.equal(aggregation.releaseReadiness.status, 'ready_for_release_gate');
    assert.equal(aggregation.assignment_protocol.complete, true);
    assert.equal(aggregation.comparison_protocol.complete, true);
    assert.deepEqual(aggregation.inputs.map((entry) => entry.role).sort(), ['human_blind_cases', 'human_blind_labels']);
    assert.equal(aggregation.inputs.every((entry) => entry.sha256 && entry.path && entry.size_bytes > 0), true);
    assert.deepEqual(aggregation.blind_review_artifacts.map((entry) => entry.role).sort(), [
      'human_blind_answer_key',
      'human_blind_assignments',
      'human_blind_pack',
      'human_blind_review_form_schema'
    ]);
    assert.equal(aggregation.blind_review_artifacts.every((entry) => entry.sha256 && entry.path && entry.size_bytes > 0), true);
    assert.equal(result.inputs.length, 2);
    assert.equal(result.blindReviewArtifacts.length, 4);
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, 'blind-pack.json'), 'utf8')).contractVersion, HUMAN_BLIND_EVAL_VERSION);
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, 'assignments.json'), 'utf8')).assignment_count, 20);
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, 'review-form.schema.json'), 'utf8')).title, 'PaperNexus human blind pairwise review form');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
