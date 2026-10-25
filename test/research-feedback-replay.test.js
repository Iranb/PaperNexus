import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateResearchFeedback } from '../scripts/evaluate-research-feedback.mjs';

const input = path.resolve('test/fixtures/research-feedback/measured');
async function directory(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-feedback-replay-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return path.join(parent, 'output');
}

test('F01/F14 measured HTTP replay survives a lost record response and charges each historic attempt once', async t => {
  const output = await directory(t);
  await assert.rejects(evaluateResearchFeedback({ input, output, seed: 17, onStep: ({ index }) => { if (index === 4) throw new Error('fixture lost response'); } }), /lost response/);
  assert.equal((await evaluateResearchFeedback({ input, output, seed: 17 })).saved_status, 'incomplete');
  await assert.rejects(evaluateResearchFeedback({ input, output, seed: 18, resume: true }), /Resume input/);
  const report = await evaluateResearchFeedback({ input, output, seed: 17, resume: true });
  assert.equal(report.status, 'passed');
  assert.equal(report.historical_run_cost.attempts, 2);
  assert.equal(report.validation_cost.gpu_hours, 0);
  const trace = JSON.parse(await fs.readFile(path.join(output, 'trace.json')));
  assert.equal(trace.find(t => t.index === 4).response.recovered_from_receipt, true);
  const before = await fs.readFile(path.join(output, 'evaluation.json'), 'utf8');
  assert.equal((await evaluateResearchFeedback({ input, output, seed: 17, resume: true })).status, 'existing_output');
  assert.equal(await fs.readFile(path.join(output, 'evaluation.json'), 'utf8'), before);
});

test('ablation preparation preserves identical source facts and separates blind labels from visible materials', async t => {
  const output = await directory(t);
  const report = await evaluateResearchFeedback({ input, output, seed: 17, mode: 'prepare-ablation' });
  assert.equal(report.status, 'prepared'); assert.equal(report.calls_executed, 0);
  const labels = JSON.parse(await fs.readFile(path.join(output, 'evaluation-only', 'labels.json')));
  for (const phase of ['after-complete-results', 'after-error-decomposition', 'before-restoration-result']) {
    const packets = labels.filter(l => l.packet.startsWith(phase));
    const read = async condition => JSON.parse(await fs.readFile(path.join(output, 'visible', packets.find(p => p.condition === condition).packet, 'input.json')));
    const a = await read('A'), b = await read('B'), c = await read('C');
    assert.deepEqual(a.source_ids, b.source_ids); assert.deepEqual(b.source_ids, c.source_ids);
    assert.deepEqual(b.material, c.material.facts);
    assert.match(a.material, /43.0628731998595/);
    assert.match(a.material, /39.620653319283456/);
    assert.ok(!JSON.stringify(c).includes('stable_improvement_claim_allowed":true'));
  }
});
