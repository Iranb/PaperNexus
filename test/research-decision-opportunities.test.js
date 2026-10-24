import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('A01/A10 retain source diversity, request transfer evidence and revisit only changed conditions', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const refreshed = (await f.call('refresh_evidence', { candidate_refs: f.input.candidates })).result;
  assert.deepEqual(refreshed.opportunities.map(c => c.source_domain).sort(), ['far', 'near', 'target']);
  assert.ok(refreshed.evidence_requests.some(r => r.candidate_id === 'far' && /transfer/.test(r.reason)));
  await f.call('update_opportunities', { changes: [{ op: 'park', candidate_id: 'far', reason: 'Need admitted control source', revisit_conditions: [{ type: 'new_admitted_evidence', source_id: 'source:far' }] }] });
  assert.equal((await f.call('refresh_evidence', {})).result.revisit_events.length, 0);
  await fs.writeFile(f.refs[2].artifact_path, JSON.stringify({ source_id: 'source:far', source_version: '1', admitted: true }));
  const result = (await f.call('refresh_evidence', {})).result;
  assert.equal(result.revisit_events.length, 1);
  assert.equal(result.opportunities.find(o => o.candidate_id === 'far').scientific_status, 'untested');
  assert.equal((await f.call('refresh_evidence', {})).result.revisit_events.length, 0);
});

test('A10 weakening a competitor reopens a parked alternative without granting support', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  await f.call('refresh_evidence', { candidate_refs: f.input.candidates });
  await f.call('update_opportunities', { changes: [{ op: 'park', candidate_id: 'far', reason: 'Wait for quality control', revisit_conditions: [{ type: 'competing_hypothesis_weakened', hypothesis_id: 'Hq' }] }] });
  await f.call('record_run', { run: f.run() });
  const result = (await f.assess()).result;
  assert.equal(result.revisit_events[0].candidate_id, 'far');
});

test('A08/A17 changed source and corrected run invalidate dependent assessments without relying on refresh', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const run = f.run(); await f.call('record_run', { run }); await f.assess();
  await fs.writeFile(f.refs[0].artifact_path, JSON.stringify({ source_id: 'source:quality', source_version: '2', admitted: false }));
  const recommendation = (await f.call('recommend_next')).result;
  assert.ok(recommendation.stale_dependencies.length);
  await assert.rejects(f.assess(), /stale_dependencies/);
  const refresh = (await f.call('refresh_evidence', {})).result;
  assert.ok(refresh.assessment_validity.every(a => a.status === 'stale'));
  await f.call('record_run', { run: { ...run, record_id: 'corrected', source_revision: 2, supersedes_record_id: 'record-1', measurements: [] } });
  const status = (await f.call('status')).result;
  assert.ok(status.assessment_validity[0].reasons.some(reason => reason.startsWith('superseded_run:')));
  assert.equal(status.budget.dimensions['gpu_hours:fixture-gpu'].spent, 1.2);
});

test('A17 an admitted old source version cannot clear a new-version evidence request', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const ref = { ...f.refs[0], source_version: '2' };
  const candidate = { ...f.input.candidates[0], candidate_id: 'updated-source', evidence_refs: [ref] };
  const refreshed = (await f.call('refresh_evidence', { candidate_refs: [candidate] })).result;
  assert.equal(refreshed.evidence_requests.find(r => r.candidate_id === 'updated-source').missing_sources[0].source_version, '2');
});
