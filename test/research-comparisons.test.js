import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createFeedbackFixture } from './fixtures/research-feedback/scenarios.js';
import { inferenceValidity } from '../src/core/research/comparison-assessment.js';

test('F03/F04/F06 one attempt retains original and control comparisons without promoting a secondary readout', async t => {
  const f = await createFeedbackFixture(t);
  const secondary = { ...f.input.hypotheses[0].predictions[0], prediction_id: 'Pq-original', comparison_id: 'original' };
  f.input.hypotheses[0].predictions.push(secondary); f.action.prediction_ids.push(secondary.prediction_id);
  await f.seed();
  const run = f.feedbackRun();
  run.comparisons[1].measurements[0].interval.lower = 1;
  await f.call('record_run', { run });
  const assessed = (await f.assess()).result.assessment;
  assert.equal(assessed.comparison_summary[0].status, 'partial_recovery');
  const first = assessed.rows.find(r => r.prediction_id === 'Pq');
  const second = assessed.rows.find(r => r.prediction_id === 'Pq-original');
  assert.equal(first.measurement.estimate, 1);
  assert.ok(second.measurement.estimate < -2.44);
  assert.equal(first.assessment_gate.confirmatory, true);
  assert.equal(second.assessment_gate.confirmatory, false);
  assert.equal((await f.call('status')).result.budget.attempts, 1);
  assert.equal((await f.call('status')).result.budget.dimensions['gpu_hours:fixture-gpu'].spent, 1.2);
});

test('F02/F03 adding a comparison supersedes assessment without charging a second attempt', async t => {
  const f = await createFeedbackFixture(t); await f.seed();
  const run = f.feedbackRun(); run.comparisons = run.comparisons.filter(c => c.comparison_id === 'control');
  await f.call('record_run', { run }); await f.assess();
  await f.call('record_run', { run: f.feedbackRun({ record_id: 'record-2', source_revision: 2, supersedes_record_id: 'record-1' }) });
  const view = (await f.call('evidence_view')).result;
  assert.equal(view.budget.attempts, 1);
  assert.equal(view.budget.dimensions['gpu_hours:fixture-gpu'].spent, 1.2);
  assert.equal(view.assessment_validity[0].status, 'stale');
  assert.equal(view.observations[0].record_id, 'record-2');
  assert.equal(view.observations[0].status, 'unassessed');
});

test('F05 primary loss and guard gain form a tradeoff; proxy gain cannot replace the primary', async t => {
  const f = await createFeedbackFixture(t); await f.seed();
  const run = f.feedbackRun();
  for (const c of run.comparisons) {
    const m = c.measurements[0]; m.candidate_estimate = 38; m.estimate = 38 - m.reference_estimate; m.interval = { lower: m.estimate - 0.2, upper: m.estimate + 0.2 };
    const guard = c.measurements[1]; guard.candidate_estimate = 49; guard.estimate = 7; guard.interval = { lower: 6.8, upper: 7.2 };
  }
  run.measurements.push({ quantity: 'pseudo_label_precision', unit: 'pp', estimate: 11.2474 });
  await f.call('record_run', { run });
  assert.equal((await f.assess()).result.assessment.comparison_summary[0].status, 'tradeoff');
  assert.match((await f.call('export')).result.markdown, /tradeoff/);
});

test('F06 rejects conflicting references, ambiguous units and inconsistent differences', async t => {
  const f = await createFeedbackFixture(t); await f.seed();
  for (const change of [
    r => { r.comparisons[0].reference.source_ref.source_version = '9'; },
    r => { r.comparisons[0].measurements[0].unit = 'meters'; },
    r => { r.comparisons[0].measurements[0].estimate = 99; },
    r => { r.comparisons.push(r.comparisons[0]); },
    r => { r.baseline = { reproduced: true }; }
  ]) {
    const run = f.feedbackRun(); change(run);
    await assert.rejects(f.call('record_run', { run }), /invalid_input|invalid_reference/);
  }
});

test('F06 reference protocol, rather than just the candidate plan, controls matched status', async t => {
  const f = await createFeedbackFixture(t); await f.seed();
  const file = f.comparators[0].reference.source_ref.artifact_path;
  const data = JSON.parse(await fs.readFile(file)); data.protocol.split = 'different-population'; await fs.writeFile(file, JSON.stringify(data));
  await f.call('refresh_evidence');
  await f.call('record_run', { run: f.feedbackRun() });
  const view = (await f.call('evidence_view')).result;
  const row = view.comparison_summary[0].comparisons.find(r => r.comparison_id === 'original');
  assert.equal(row.label, 'vs reproduced baseline');
  assert.equal(row.protocol_alignment.status, 'mismatch');
  assert.equal(row.confirmatory, false);
});

test('F13 fixed-image intervals and repeated epochs do not support training-procedure inference', async t => {
  const f = await createFeedbackFixture(t);
  f.action.evaluation_plan.inference_target = 'training_procedure';
  f.input.hypotheses.forEach(h => { h.predictions[0].inference_target = 'training_procedure'; });
  await f.seed(); await f.call('record_run', { run: f.feedbackRun() });
  const assessed = (await f.assess()).result.assessment;
  assert.ok(assessed.rows.every(r => !r.assessment_gate.confirmatory));
  assert.ok(assessed.comparison_summary[0].comparisons.every(r => r.inference.status === 'insufficient'));
  assert.ok(assessed.rows[0].inference.reason_codes.includes('independent_training_runs_not_established'));
});

test('F18 non-GCD metrics preserve comparator logic and lower-is-better guardrails', async t => {
  const f = await createFeedbackFixture(t, { retrieval: true }); await f.seed();
  const run = f.feedbackRun();
  for (const c of run.comparisons) Object.assign(c.measurements[1], { candidate_estimate: 50, estimate: 8, interval: { lower: 7.8, upper: 8.2 } });
  await f.call('record_run', { run });
  const summary = (await f.assess()).result.assessment.comparison_summary[0];
  assert.equal(summary.status, 'tradeoff');
  assert.ok(summary.comparisons.some(r => r.quantity === 'query_latency' && r.descriptive_result === 'below_target'));
});

test('F07 a paper comparator without verified paper provenance cannot establish a paper-report comparison', async t => {
  const f = await createFeedbackFixture(t);
  const comparator = f.comparators[0]; comparator.role = 'paper'; comparator.reference.kind = 'paper_report';
  await f.seed();
  const run = f.feedbackRun(); run.comparisons[0].kind = 'paper_reported';
  await f.call('record_run', { run });
  const row = (await f.call('evidence_view')).result.comparison_summary[0].comparisons.find(r => r.comparison_id === 'original');
  assert.equal(row.label, 'paper-report comparison not established'); assert.equal(row.confirmatory, false);
});

test('F13 repeated records or epochs do not increase the number of independent training units', () => {
  const run = { record_id: 'seed-0', executor_id: 'e', run_id: 'r', attempt_id: 'a', source_revision: 1, status: 'completed', evidence_origin: 'external_measured', independent_group: 'seed-0', verification: { status: 'manifest_verified' } };
  const measurement = { uncertainty: { inference_target: 'training_procedure', independent_unit: 'epoch', unit_count: 200, independent_run_refs: ['seed-0', 'seed-0'] } };
  assert.equal(inferenceValidity(measurement, 'training_procedure', [run]).status, 'insufficient');
  measurement.uncertainty = { inference_target: 'training_procedure', independent_unit: 'training_run', unit_count: 2, independent_run_refs: ['seed-0', 'seed-1'] };
  assert.equal(inferenceValidity(measurement, 'training_procedure', [run, { ...run, record_id: 'seed-1', run_id: 'r1', independent_group: 'seed-1' }]).status, 'supported');
});

test('F17 refreshed comparator artifacts still require a corrected run revision', async t => {
  const f = await createFeedbackFixture(t); await f.seed();
  await f.call('record_run', { run: f.feedbackRun() }); await f.assess();
  const file = f.comparators[0].reference.source_ref.artifact_path;
  const data = JSON.parse(await fs.readFile(file)); data.protocol.split = 'corrected-population'; await fs.writeFile(file, JSON.stringify(data));
  await f.call('refresh_evidence');
  await assert.rejects(f.assess(), /new run source revision/);
  const view = (await f.call('evidence_view')).result;
  assert.equal(view.observations[0].status, 'stale');
  assert.equal(view.comparison_summary[0].status, 'inconclusive');
  assert.match((await f.call('export')).result.markdown, /stale_dependencies/);
});

test('registered original targets and guards can establish improvement with a covered adjusted analysis', async t => {
  const f = await createFeedbackFixture(t);
  f.input.hypotheses.forEach(h => { h.predictions[0].comparison_id = 'original'; });
  f.action.evaluation_plan.outcomes.forEach(o => { o.comparison_ids = ['original']; });
  Object.assign(f.action.analysis, { primary_comparison_id: 'original', multiplicity: 'adjusted', adjustment_ref: 'synthetic/joint-interval-review',
    family: f.action.evaluation_plan.outcomes.map(o => ({ comparison_id: 'original', quantity: o.quantity })) });
  await f.seed();
  const run = f.feedbackRun(); run.comparisons = run.comparisons.filter(c => c.comparison_id === 'original');
  const m = run.comparisons[0].measurements[0]; m.candidate_estimate = 45; m.estimate = 45 - m.reference_estimate;
  m.interval = { lower: m.estimate - 0.2, upper: m.estimate + 0.2 };
  await f.call('record_run', { run });
  assert.equal((await f.call('evidence_view')).result.comparison_summary[0].status, 'not_assessed');
  assert.equal((await f.assess()).result.assessment.comparison_summary[0].status, 'improved_in_scope');
  assert.equal((await f.call('evidence_view')).result.comparison_summary[0].status, 'improved_in_scope');
});

test('missing primary or guard thresholds remain design gaps', async t => {
  const f = await createFeedbackFixture(t);
  delete f.action.evaluation_plan.outcomes[0].minimum_effect;
  delete f.action.evaluation_plan.outcomes[1].max_regression;
  await f.seed();
  const action = (await f.call('status')).result.actions[0];
  assert.equal(action.design_status, 'draft');
  assert.ok(action.missing_fields.includes('evaluation_plan.minimum_effect:NEW'));
  assert.ok(action.missing_fields.includes('evaluation_plan.max_regression:OLD'));
});
