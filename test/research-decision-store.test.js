import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { decisionPaths, readDecisionState } from '../src/core/research/decision-store.js';
import { executeResearchDecisionOperation } from '../src/core/research/decision-service.js';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('A12 dry run creates no overlay, lost-response replay returns its receipt before revision checking', async t => {
  const f = await createDecisionFixture(t);
  const args = { operation: 'init', project: 'quality-vs-count', requestId: 'init', payload: f.input.init };
  await executeResearchDecisionOperation(f.root, { ...args, dryRun: true });
  await assert.rejects(fs.stat(decisionPaths(f.root, args.project).root), { code: 'ENOENT' });
  await executeResearchDecisionOperation(f.root, args);
  await executeResearchDecisionOperation(f.root, { operation: 'update_opportunities', project: args.project, requestId: 'phase', expectedRevision: 1,
    payload: { changes: [{ op: 'set_goal_phase', goal_phase: 'performance_validation', reason: 'explicit stage change' }] } });
  const replay = await executeResearchDecisionOperation(f.root, args);
  assert.equal(replay.revision, 1); assert.equal(replay.current_revision, 2); assert.equal(replay.replayed, true);
  await assert.rejects(executeResearchDecisionOperation(f.root, { ...args, payload: { ...args.payload, objective: 'different' } }), /request_conflict/);
  const recovered = await executeResearchDecisionOperation(f.root, { operation: 'status', project: args.project, requestId: 'init' });
  assert.equal(recovered.result.receipt.response.revision, 1);
});

test('A12 concurrent writes accept one revision and failed atomic write leaves original state intact', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const revision = f.revision();
  const update = requestId => ({ operation: 'update_opportunities', project: 'quality-vs-count', requestId, expectedRevision: revision,
    payload: { changes: [{ op: 'set_goal_phase', goal_phase: 'performance_validation', reason: 'test transition' }] } });
  const results = await Promise.allSettled(['a', 'b'].map(id => executeResearchDecisionOperation(f.root, update(id))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /revision_conflict/);
  const before = await readDecisionState(f.root, 'quality-vs-count');
  await assert.rejects(executeResearchDecisionOperation(f.root, { ...update('failed-write'), expectedRevision: before.revision }, {
    writeState: async () => { throw new Error('fixture write interruption'); }
  }), /fixture write interruption/);
  assert.deepEqual(await readDecisionState(f.root, 'quality-vs-count'), before);
});

test('A12 damaged state is explicit and interrupted export can be retried without changing state', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const revision = f.revision();
  const failed = await f.call('export', undefined, { outputDir: f.refs[0].artifact_path });
  assert.equal(failed.result.status, 'export_pending');
  assert.equal(failed.revision, revision);
  const exported = await f.call('export', undefined, { outputDir: f.root + '/reports' });
  assert.equal(exported.result.status, 'exported');
  assert.match(await fs.readFile(f.root + '/reports/research-decision-report.md', 'utf8'), /Research decision/);
  await fs.writeFile(decisionPaths(f.root, 'quality-vs-count').statePath, '{');
  await assert.rejects(f.call('status'), /state_corrupt/);
});
