import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFixture, EXPECTATIONS } from './fixtures/research-decision/scenarios.js';

test('A04 headline improvement remains compatible with both explanations', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const run = f.run('positive', { action_id: 'E0', analysis: f.input.actions[0].analysis });
  run.measurements[0].quantity = f.input.headline;
  await f.call('record_run', { run });
  const result = (await f.assess()).result;
  assert.deepEqual(result.assessment.rows.map(r => r.status), ['compatible', 'compatible']);
  assert.deepEqual(result.assessment.rows[0].compatible_alternatives, ['Hn']);
});

test('A05 a precise registered counterexample excludes only the necessary prediction in scope', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run() });
  const result = (await f.assess()).result;
  assert.deepEqual(Object.fromEntries(result.assessment.hypotheses.map(h => [h.hypothesis_id, h.status])), EXPECTATIONS.negative_statuses);
  for (const row of result.assessment.rows) {
    assert.equal(row.assessment_gate.confirmatory, true);
    assert.equal(row.evidence_origin, 'synthetic_fixture');
    assert.deepEqual(row.scope, f.input.hypotheses[0].scope);
  }
});

test('A05 wide intervals do not turn absence of significance into exclusion', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run('wide') });
  const result = (await f.assess()).result;
  assert.ok(result.assessment.rows.every(r => r.status === 'inconclusive' && !r.assessment_gate.confirmatory));
});

test('A08 conflicting independent results remain conflicted without majority voting', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run() }); await f.assess();
  await f.call('record_run', { run: f.run('positive', { record_id: 'record-2', attempt_id: 'attempt-2', independent_group: 'new-seeds' }) });
  const result = (await f.assess(['record-2'])).result;
  assert.ok(result.assessment.hypotheses.every(h => h.status === 'conflicted'));
  await f.assess(['record-2']);
  const status = (await f.call('status')).result;
  assert.ok(status.scientific_state.every(h => h.evidence_groups.length === 2 && h.rows.length === 2));
});

test('A11 unexpected observations retain unmodeled explanations', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('record_run', { run: f.run('unexplained') });
  assert.equal((await f.assess()).result.unmodeled_explanation, true);
});

test('A18 correctly applied intervention with failed mediator prediction remains negative evidence', async t => {
  const f = await createDecisionFixture(t);
  const mediator = 'pseudo_label_precision_change';
  for (const h of f.input.hypotheses) h.predictions[0].quantity = mediator;
  for (const a of f.input.actions.filter(a => a.action_id !== 'E0')) {
    a.measurements = [mediator]; a.analysis.primary_outcome = mediator;
  }
  await f.seed();
  const applied = f.run(); applied.measurements[0].quantity = mediator;
  await f.call('record_run', { run: applied });
  assert.equal((await f.assess()).result.assessment.rows[0].status, 'excluded_in_scope');
  const failed = f.run('negative', { record_id: 'unapplied', attempt_id: 'unapplied', intervention_checks: [{ check: 'selection implemented and counts matched', passed: false, reference: 'synthetic/execution-failure' }] });
  failed.measurements[0].quantity = mediator;
  await f.call('record_run', { run: failed });
  const result = (await f.assess(['unapplied'])).result;
  assert.ok(result.assessment.rows.every(r => r.status === 'unassessable'));
});
