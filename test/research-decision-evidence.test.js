import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { saveSourceManifest } from '../src/storage/corpus-store.js';
import { decisionPaths } from '../src/core/research/decision-store.js';
import { createDecisionFixture } from './fixtures/research-decision/scenarios.js';

test('A17 actual paper admission changes block decisions and invalidate prior assessments', async t => {
  const f = await createDecisionFixture(t);
  const graph = createKnowledgeGraph(), sources = [];
  for (const id of ['quality', 'count']) {
    const sourcePath = path.join(f.root, `${id}.md`);
    await fs.writeFile(sourcePath, `# Selection mechanism ${id}\n\n## Method\nA matched selection contrast.\n`);
    const paperId = `paper:${id}`;
    sources.push({ sourceKey: id, paperId, paperTitle: `Selection mechanism ${id}`, sourcePath, kind: 'markdown' });
    graph.addNode({ id: paperId, type: 'Paper', name: `Selection mechanism ${id}`, properties: { sourcePath } });
  }
  await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  await saveSourceManifest(f.root, { sources });
  f.input.hypotheses.forEach((h, i) => { const id = i ? 'count' : 'quality'; h.evidence_refs = [{ evidence_origin: 'paper_reported', source_id: `paper:${id}`, paper_id: `paper:${id}`, source_key: id, source_version: id, locator: 'Method' }]; });
  await f.seed();
  assert.equal((await f.call('recommend_next')).result.decision.action_id, 'E1');
  await f.call('record_run', { run: f.run() }); await f.assess();
  sources[0].sourcePurpose = 'test';
  await saveSourceManifest(f.root, { sources });
  assert.ok((await f.call('recommend_next')).result.stale_dependencies.length);
  await assert.rejects(f.assess(), /stale_dependencies/);
  const refreshed = (await f.call('refresh_evidence', {})).result;
  assert.equal(refreshed.assessment_validity[0].status, 'stale');
  const status = (await f.call('status')).result;
  assert.equal(status.evidence_snapshots.find(s => s.ref.source_id === 'paper:quality').admitted, false);
});

test('A01 existing controller candidates retain coverage and the original record', async t => {
  const f = await createDecisionFixture(t); await f.seed();
  const candidate = { record_type: 'candidate_node', candidate_id: 'controller-transfer', title: 'Adaptive selection', subproblem: { name: 'Noisy evidence' }, evidence: { paper_ids: ['paper:quality'] }, source_domain: 'control', source_papers: [{ paper_id: 'paper:quality' }] };
  await saveSourceManifest(f.root, { sources: [{ sourceKey: 'quality-source', paperId: 'paper:quality', sourcePath: path.join(f.root, 'quality.md') }] });
  await fs.writeFile(path.join(decisionPaths(f.root, 'quality-vs-count').root, 'candidate-graph.jsonl'), `${JSON.stringify(candidate)}\n`);
  const result = (await f.call('refresh_evidence', {})).result;
  const saved = result.opportunities.find(o => o.candidate_id === candidate.candidate_id);
  assert.equal(saved.source_domain, 'control');
  assert.equal(saved.subproblem, 'Noisy evidence');
  assert.deepEqual(saved.controller_candidate, candidate);
  assert.equal(saved.evidence_refs[0].source_version, 'quality-source');
  assert.ok(result.evidence_requests.some(r => r.candidate_id === candidate.candidate_id));
});
