import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMethodAdaptations, classifyGapObservation } from '../src/core/graph/method-adaptation.js';
import { buildGapMap, buildMechanismToInterventionMap } from '../src/core/materials/agent-materials.js';

const problem = { id: 'gap', statement: 'Calibration fails under sparse feedback' };
const profiles = [
  { id: 'b', name: 'Protein folding', mechanisms: ['molecular dynamics'], problems: ['protein structure'] },
  { id: 'a', name: 'Feedback calibration', mechanisms: ['feedback control'], problems: ['sparse feedback'],
    assumptions: ['feedback available'], requirements: { labelsAvailable: true, maxLatencyMs: 20 },
    evidence: [{ source_id: 'chunk:1', quote: 'Uses sparse feedback for calibration.' }] }
];

test('method adaptation depends on source mechanisms and conditions, not profile order', () => {
  const options = { constraints: { labelsAvailable: true, maxLatencyMs: 40 } };
  const ranked = rankMethodAdaptations(problem, profiles, options);
  assert.deepEqual(ranked, rankMethodAdaptations(problem, [...profiles].reverse(), options));
  assert.deepEqual(ranked.candidates.map((c) => c.methodId), ['a']);
  assert.equal(ranked.candidates[0].status, 'hypothesis');
  assert.deepEqual(ranked.candidates[0].evidence, profiles[1].evidence);
  const conflict = rankMethodAdaptations(problem, profiles, { constraints: { labelsAvailable: false } });
  assert.equal(conflict.candidates.length, 0);
  assert.equal(conflict.excluded[0].status, 'incompatible');
  assert.equal(rankMethodAdaptations(problem, profiles.slice(0, 1)).status, 'needs_evidence');
  assert.equal(rankMethodAdaptations(problem, [{ ...profiles[1], evidence: [], assumptions: [], requirements: {} }])
    .candidates[0].status, 'needs_evidence');
});

test('claims require verification and traversal absence remains bounded', () => {
  assert.equal(classifyGapObservation({ type: 'Claim', statement: 'SOTA', evidence: [{ source_id: 'x' }] }).category, 'evidence_gap');
  assert.equal(classifyGapObservation({ type: 'Limitation', statement: 'Fails', evidence: [{ source_id: 'x' }] }).category, 'research_opportunity');
  assert.equal(classifyGapObservation({ truncated: true }).category, 'traversal_gap');
  const pack = { groups: [{ role: 'target_prior', items: [{ role: 'target_prior', title: 'Test', paper_id: 'p',
    graph_context: [{ node_type: 'Claim', node_name: 'Improves accuracy' }] }] }] };
  const gaps = buildGapMap(pack);
  assert.ok(gaps.length);
  assert.ok(gaps.every((gap) => gap.gap_type !== 'claim_evidence_mismatch'));
  assert.equal(gaps[0].category, 'evidence_gap');
  const fallback = buildGapMap({ groups: [{ role: 'target_prior', items: [{
    role: 'target_prior', title: 'A claim about robust performance', paper_id: 'fallback'
  }] }] });
  assert.equal(fallback[0].gap_type, 'source_verification_needed');
  assert.equal(fallback[0].category, 'extraction_gap');
});

test('material mechanism maps leave unrelated gaps unpaired', () => {
  const item = { role: 'near_source_method', title: 'Protein folding', paper_id: 'p',
    graph_context: [{ node_type: 'Method', node_name: 'Molecular dynamics' }] };
  const pack = { target_problem: 'Calibration', groups: [{ role: 'near_source_method', items: [item] }] };
  const map = buildMechanismToInterventionMap(pack, [{ gap_id: 'g', statement: 'Sparse feedback', source_spans: [] }]);
  assert.equal(map[0].suspected_mechanism, 'missing mechanism anchor');
  assert.equal(map[0].evidence_status, 'needs_evidence');
});
