import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('A06/A07 failed execution, baseline shortfall and protocol mismatch cannot refute a hypothesis', async t => {
  for (const change of [{ status: 'failed' }, { baseline: { reproduced: false, shortfall: 8, reference: 'synthetic/shortfall' } }, { protocol: { dataset: 'different' } }]) {
    const f = await createDecisionFixture(t); await f.seed();
    await f.call('record_run', { run: f.run('negative', change) });
    const result = (await f.assess()).result;
    assert.ok(result.assessment.rows.every(r => r.status === 'unassessable'));
    if (change.protocol) assert.ok(result.assessment.rows.every(r => r.comparison === 'vs reproduced baseline'));
    if (change.baseline) assert.equal(result.assessment.rows[0].baseline_shortfall, 8);
  }
});

test('A06/A16 retrospective or missing registration, selective analysis and unreviewed intervals prevent confirmation', async t => {
  const variations = [
    run => { run.started_at = '2000-01-01T00:00:00Z'; },
    run => { delete run.registration_receipt; },
    run => { run.analysis.look_policy = 'exploratory'; },
    run => { run.analysis.multiplicity = 'uncontrolled'; },
    run => { run.measurements[0].uncertainty.review.status = 'unreviewed'; }
  ];
  for (const vary of variations) {
    const f = await createDecisionFixture(t); await f.seed(); const run = f.run(); vary(run);
    await f.call('record_run', { run });
    const result = (await f.assess()).result;
    assert.ok(result.assessment.rows.every(r => !r.assessment_gate.confirmatory && r.status !== 'excluded_in_scope'));
  }
});

test('A07 external inline data stay unverified; explicit manifest round-trip verifies contents only', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const run = f.run('negative', { evidence_origin: 'external_measured' });
  await f.call('record_run', { run });
  let result = (await f.assess()).result;
  assert.ok(result.assessment.rows.every(r => r.status !== 'excluded_in_scope'));
  assert.equal(result.assessment.rows[0].assessment_gate.provenance.status, 'provided_unverified');
  const next = f.run('negative', { record_id: 'manifest-record', attempt_id: 'manifest-attempt' });
  const manifestPath = f.root + '/manifest.json';
  await fs.writeFile(manifestPath, JSON.stringify({ run: next }));
  await f.call('record_run', { run: { ...next, manifest_path: manifestPath } });
  result = (await f.assess(['manifest-record'])).result;
  assert.equal(result.assessment.rows[0].assessment_gate.provenance.status, 'synthetic_fixture');
  await assert.rejects(f.call('record_run', { run: { ...next, record_id: 'mismatch', manifest_path: manifestPath } }), /manifest_mismatch/);
});
