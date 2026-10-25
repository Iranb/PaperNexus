import fs from 'node:fs/promises';
import path from 'node:path';
import { createDecisionFixture } from '../research-decision/scenarios.js';

export async function createFeedbackFixture(t, { retrieval = false } = {}) {
  const f = await createDecisionFixture(t, { retrieval });
  const quantity = retrieval ? 'recall_at_10' : 'NEW';
  const guard = retrieval ? 'query_latency' : 'OLD';
  const comparators = [];
  for (const [id, estimate] of [['original', 43.0628731998595], ['control', 39.620653319283456]]) {
    const artifactPath = path.join(f.root, `${id}-baseline.json`);
    const sourceRef = { evidence_origin: 'synthetic_fixture', source_id: `${id}-baseline`, source_version: '1', locator: 'measurements', artifact_path: artifactPath };
    await fs.writeFile(artifactPath, JSON.stringify({ source_id: sourceRef.source_id, source_version: '1', admitted: true,
      protocol: f.input.protocol, measurements: [{ quantity, unit: 'percent', estimate }, { quantity: guard, unit: 'percent', estimate: 42 }] }));
    comparators.push({ comparison_id: id, role: id, reference: { kind: 'external_manifest', source_ref: sourceRef, protocol_locator: 'protocol', measurements_locator: 'measurements' }, required_protocol_fields: Object.keys(f.input.protocol) });
  }
  for (const h of f.input.hypotheses) {
    h.predictions = [h.predictions[0]];
    Object.assign(h.predictions[0], { quantity, unit: 'pp', comparison_id: 'control', inference_target: 'fixed_model' });
  }
  const action = f.input.actions[1];
  action.measurements = [quantity, guard];
  action.precision.inference_target = 'fixed_model';
  action.analysis.primary_outcome = quantity;
  action.analysis.primary_comparison_id = 'control';
  action.evaluation_plan = { comparators, inference_target: 'fixed_model', outcomes: [
    { quantity, unit: 'pp', direction: 'higher', role: 'primary', minimum_effect: 1, comparison_ids: ['control', 'original'] },
    { quantity: guard, unit: 'pp', direction: retrieval ? 'lower' : 'higher', role: 'guardrail', max_regression: 2, comparison_ids: ['control', 'original'] }
  ] };
  f.input.actions = [action];
  const run = (overrides = {}) => {
    const value = 40.620653319283456;
    const base = f.run('negative');
    delete base.comparison; delete base.baseline;
    const uncertainty = { method: 'synthetic paired fixed-model interval', level: 0.95, independent_unit: 'image', unit_count: 100,
      inference_target: 'fixed_model', calculation_ref: 'synthetic/paired-images', review: { status: 'reviewed', reviewer: 'fixture-only', reference: 'synthetic/review' } };
    return { ...base, measurements: [], analysis: structuredClone(action.analysis), comparisons: comparators.map(c => {
      const referenceValue = c.comparison_id === 'control' ? 39.620653319283456 : 43.0628731998595;
      const estimate = value - referenceValue;
      return { comparison_id: c.comparison_id, reference: structuredClone(c.reference), kind: 'matched_reproduced', measurements: [
        { quantity, unit: 'pp', value_unit: 'percent', value_kind: 'difference', candidate_estimate: value, reference_estimate: referenceValue,
          estimate, interval: { lower: estimate - 0.2, upper: estimate + 0.2 }, uncertainty: structuredClone(uncertainty) },
        { quantity: guard, unit: 'pp', value_unit: 'percent', value_kind: 'difference', candidate_estimate: 42, reference_estimate: 42,
          estimate: 0, interval: { lower: -0.1, upper: 0.1 }, uncertainty: structuredClone(uncertainty) }
      ] };
    }), ...overrides };
  };
  return { ...f, feedbackRun: run, quantity, guard, action, comparators };
}
