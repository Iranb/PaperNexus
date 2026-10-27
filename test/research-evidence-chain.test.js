import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createFeedbackFixture } from './fixtures/research-feedback/scenarios.js';
import { createMechanismFixture } from './fixtures/research-decision/mechanisms.js';
import { validateActionPlan, validateHypothesisSet } from '../src/core/research/decision-contracts.js';
import { buildEvidenceChain } from '../src/core/research/evidence-chain.js';
import { executeTool } from '../src/mcp/core.js';
import { RESEARCH_SUMMARY_MAX_BYTES } from '../src/mcp/research-summary.js';

async function comparisonFixture(t, role) {
  const f = await createFeedbackFixture(t);
  f.input.hypotheses.forEach(h => {
    h.predictions[0].comparison_id = 'original';
    if (role) h.predictions[0].evidence_role = role;
  });
  f.action.evaluation_plan.outcomes.forEach((o, i) => {
    o.comparison_ids = ['original'];
    if (role) o.evidence_role = i ? 'target' : role;
  });
  Object.assign(f.action.analysis, { primary_comparison_id: 'original', multiplicity: 'adjusted', adjustment_ref: 'synthetic/joint-review',
    family: f.action.evaluation_plan.outcomes.map(o => ({ comparison_id: 'original', quantity: o.quantity })) });
  const positiveRun = () => {
    const run = f.feedbackRun(); run.comparisons = run.comparisons.filter(c => c.comparison_id === 'original');
    const m = run.comparisons[0].measurements[0];
    m.candidate_estimate = 45; m.estimate = 45 - m.reference_estimate;
    m.interval = { lower: m.estimate - 0.2, upper: m.estimate + 0.2 };
    return run;
  };
  return { ...f, positiveRun };
}

for (const role of ['observation', 'proxy', undefined]) test(`a positive ${role || 'unspecified'} primary cannot establish target performance`, async t => {
  const f = await comparisonFixture(t, role); await f.seed();
  await f.call('record_run', { run: f.positiveRun() });
  const comparison = (await f.assess()).result.assessment.comparison_summary[0];
  assert.equal(comparison.status, 'improved_in_scope');
  assert.equal(comparison.performance_claim.status, 'not_established');
  assert.ok(comparison.performance_claim.reason_codes.includes('target_outcome_not_registered'));
  const args = { operation: 'evaluate', purpose: 'performance_validation', project: 'quality-vs-count', corpus: f.root, actionId: 'E1', responseMode: 'full' };
  const full = await executeTool('idea_generation', args);
  assert.equal(full.result.performance_claim_status, 'not_established');
  assert.ok(full.result.task_gate.reason_codes.includes('primary_target_missing'));
  const summary = await executeTool('idea_generation', { ...args, responseMode: 'summary' });
  assert.equal(summary.presentation.evidence_gates.performance_claim_status, 'not_established');
  assert.deepEqual(summary.presentation.evidence_gates.performance_claim, full.result.performance_claim);
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) <= RESEARCH_SUMMARY_MAX_BYTES);
  assert.match((await f.call('export')).result.markdown, /performance claim: not_established/);
});

test('target improvement requires assessment and loses claim authority when its reference changes', async t => {
  const f = await comparisonFixture(t, 'target'); await f.seed();
  await f.call('record_run', { run: f.positiveRun() });
  assert.equal((await f.call('evidence_view')).result.comparison_summary[0].performance_claim.status, 'not_assessed');
  assert.equal((await f.assess()).result.assessment.comparison_summary[0].performance_claim.status, 'improved_in_scope');
  const args = { operation: 'evaluate', purpose: 'performance_validation', project: 'quality-vs-count', corpus: f.root, actionId: 'E1', responseMode: 'full' };
  assert.equal((await executeTool('idea_generation', args)).result.performance_claim_status, 'improved_in_scope');
  const file = f.comparators[0].reference.source_ref.artifact_path;
  const data = JSON.parse(await fs.readFile(file)); data.protocol.split = 'another-population';
  await fs.writeFile(file, JSON.stringify(data));
  const claim = (await executeTool('idea_generation', args)).result.performance_claim;
  assert.equal(claim.status, 'not_established');
  assert.ok(claim.reason_codes.includes('stale_dependencies'));
  assert.deepEqual(claim.claim_basis, []);
});

test('a missing target measurement remains unresolved despite a confirmatory proxy gain', async t => {
  const f = await comparisonFixture(t, 'proxy');
  f.action.evaluation_plan.outcomes.push({ quantity: 'final_accuracy', unit: 'pp', direction: 'higher', role: 'primary',
    evidence_role: 'target', minimum_effect: 1, comparison_ids: ['original'] });
  f.action.analysis.family.push({ comparison_id: 'original', quantity: 'final_accuracy' });
  await f.seed(); await f.call('record_run', { run: f.positiveRun() });
  const claim = (await f.assess()).result.assessment.comparison_summary[0].performance_claim;
  assert.equal(claim.status, 'not_established');
  assert.ok(claim.reason_codes.includes('target_outcome_not_measured'));
});

test('a target gain against a weak control preserves the loss against the original', async t => {
  const f = await createFeedbackFixture(t);
  f.input.hypotheses.forEach(h => { h.predictions[0].evidence_role = 'target'; });
  f.action.evaluation_plan.outcomes.forEach(o => { o.evidence_role = 'target'; });
  Object.assign(f.action.analysis, { multiplicity: 'adjusted', adjustment_ref: 'synthetic/joint-review',
    family: f.action.evaluation_plan.outcomes.flatMap(o => o.comparison_ids.map(comparison_id => ({ comparison_id, quantity: o.quantity }))) });
  await f.seed();
  const run = f.feedbackRun(); run.comparisons.find(c => c.comparison_id === 'control').measurements[0].interval.lower = 1;
  await f.call('record_run', { run });
  const comparison = (await f.assess()).result.assessment.comparison_summary[0];
  assert.equal(comparison.performance_claim.status, 'partial_recovery');
  assert.equal(comparison.comparisons.find(r => r.role === 'original' && r.outcome_role === 'primary').result, 'below_target');
});

test('every primary target needs its own original comparison', async t => {
  const f = await comparisonFixture(t, 'target');
  f.action.evaluation_plan.outcomes.push({ quantity: 'second_target', unit: 'pp', direction: 'higher', role: 'primary',
    evidence_role: 'target', minimum_effect: 1, comparison_ids: ['control'] });
  await f.seed(); await f.call('record_run', { run: f.positiveRun() });
  const comparison = (await f.assess()).result.assessment.comparison_summary[0];
  assert.equal(comparison.performance_claim.status, 'not_established');
  assert.ok(comparison.performance_claim.reason_codes.includes('original_target_comparison_missing'));
  const evaluation = await executeTool('idea_generation', { operation: 'evaluate', purpose: 'performance_validation',
    project: 'quality-vs-count', corpus: f.root, actionId: 'E1', responseMode: 'full' });
  assert.ok(evaluation.result.task_gate.reason_codes.includes('original_target_comparison_missing'));
});

test('proxy exclusion leaves target performance open and prioritizes its declared bridge diagnostic', async t => {
  const f = await createMechanismFixture(t);
  for (const h of f.input.hypotheses) {
    h.predictions[0].evidence_role = 'proxy'; h.predictions[0].proxy_for = [h.predictions[1].prediction_id];
    h.predictions[1].evidence_role = 'target';
  }
  f.input.actions.push({ ...structuredClone(f.input.actions[1]), action_id: 'Z-proxy-bridge', type: 'diagnostic',
    title: 'Check proxy-to-target inference', information_targets: [{ hypothesis_id: 'Hq', hypothesis_version: 1, kind: 'proxy_bridge', prediction_id: 'Pq' }] });
  await f.seed(); await f.call('record_run', { run: f.run() }); await f.assess();
  const state = (await f.call('status')).result.scientific_state;
  assert.equal(state.find(h => h.hypothesis_id === 'Hq').status, 'excluded_in_scope');
  assert.ok(state.every(h => h.evidence_chain.target_status === 'not_measured'));
  const next = (await f.call('recommend_next')).result;
  assert.equal(next.decision.action_id, 'Z-proxy-bridge');
  assert.equal(next.decision.selection_basis.matched_information_targets[0].kind, 'proxy_bridge');
  assert.equal(next.decision.mechanism_test.status, 'ready');
  assert.ok(next.mechanism_analysis.research_gaps.some(g => g.reason === 'target_not_measured'));
  assert.match((await f.call('export')).result.markdown, /target not_measured/);
});

test('observing proxy and target together does not validate their relationship', () => {
  const h = { hypothesis_id: 'H', version: 1, predictions: [
    { prediction_id: 'purity', evidence_role: 'observation' },
    { prediction_id: 'gradient', evidence_role: 'proxy', proxy_for: ['accuracy'] },
    { prediction_id: 'accuracy', evidence_role: 'target' }
  ] };
  const rows = h.predictions.map(p => ({ prediction_id: p.prediction_id, run_record_id: 'same-run', measurement: { estimate: 1 },
    relation: 'compatible', status: 'compatible', assessment_gate: { valid: true, confirmatory: false } }));
  const chain = buildEvidenceChain(h, rows);
  assert.equal(chain.target_status, 'observed');
  assert.deepEqual(chain.proxy_links[0].joint_run_record_ids, ['same-run']);
  assert.equal(chain.proxy_links[0].inference_status, 'not_established');
  assert.ok(!chain.research_gaps.some(g => g.kind === 'target_measurement'));
  assert.ok(chain.research_gaps.some(g => g.kind === 'proxy_bridge'));
  rows[2].assessment_gate.valid = false;
  assert.equal(buildEvidenceChain(h, rows).target_status, 'not_measured');
});

test('evidence roles reject invalid proxy links and contradictory prediction/outcome declarations', async t => {
  const f = await createFeedbackFixture(t);
  const h = f.input.hypotheses[0]; h.predictions[0].proxy_for = ['missing'];
  assert.throws(() => validateHypothesisSet(f.input.hypotheses), /requires a proxy/);
  h.predictions[0].evidence_role = 'proxy';
  assert.throws(() => validateHypothesisSet(f.input.hypotheses), /proxy target/);
  delete h.predictions[0].proxy_for;
  f.action.evaluation_plan.outcomes[0].evidence_role = 'target';
  const validated = validateHypothesisSet(f.input.hypotheses);
  assert.throws(() => validateActionPlan(f.action, validated), /evidence roles differ/);
});
