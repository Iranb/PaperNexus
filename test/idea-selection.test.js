import assert from 'node:assert/strict';
import test from 'node:test';

import { selectIdeas } from '../src/core/graph/diversity-selection.js';

test('selectIdeas returns an MMR selection trace with evidence gating', () => {
  const candidates = [{
    id: 'idea-a',
    title: 'Control theory bridge',
    source_domain: 'Control Theory',
    integration_mechanism: 'feedback stabilization',
    usefulness_score: 4.5,
    novelty_score: 4,
    bridge_path_ids: ['bridge-a'],
    source_spans: [{ span_id: 'span-a' }],
    evidence_tier: 'strong'
  }, {
    id: 'idea-b',
    title: 'Control theory duplicate bridge',
    source_domain: 'Control Theory',
    integration_mechanism: 'feedback stabilization',
    usefulness_score: 4.2,
    novelty_score: 3.8,
    bridge_path_ids: ['bridge-b'],
    source_spans: [{ span_id: 'span-b' }],
    evidence_tier: 'strong'
  }, {
    id: 'idea-c',
    title: 'Medical imaging bridge',
    source_domain: 'Medical Imaging',
    integration_mechanism: 'uncertainty calibration',
    usefulness_score: 3.7,
    novelty_score: 4.1,
    bridge_path_ids: ['bridge-c'],
    source_spans: [{ span_id: 'span-c' }],
    evidence_tier: 'moderate'
  }, {
    id: 'idea-d',
    title: 'Unsupported hunch',
    source_domain: 'Speculative Domain',
    integration_mechanism: 'unverified analogy',
    usefulness_score: 5,
    novelty_score: 5,
    evidence_tier: 'missing'
  }];

  const result = selectIdeas(candidates, {
    mode: 'mmr',
    k: 2,
    lambda: 0.55,
    minEvidenceTier: 'moderate',
    requireBridgePath: true
  });

  assert.equal(result.selection_trace.record_type, 'selection_trace');
  assert.equal(result.selection_trace.mode, 'mmr');
  assert.equal(result.selected.length, 2);
  assert.ok(result.selected_ids.includes('idea-a'));
  assert.ok(result.selected_ids.includes('idea-c'));
  assert.equal(result.selection_trace.rejected[0].candidate_id, 'idea-d');
  assert.equal(result.selection_trace.rejected[0].reason, 'evidence_tier_below_moderate');
  assert.ok(result.selection_trace.metrics.distinct_source_domain_count >= 2);
  assert.ok(result.selection_trace.selected.every((entry) => entry.selection_reason));
});

test('selectIdeas returns greedy submodular and DPP traces over the same evidence gate', () => {
  const candidates = [{
    id: 'idea-a',
    title: 'Control theory bridge',
    source_domain: 'Control Theory',
    integration_mechanism: 'feedback stabilization',
    usefulness_score: 4.5,
    novelty_score: 4,
    bridge_path_ids: ['bridge-a'],
    source_spans: [{ span_id: 'span-a' }],
    evidence_tier: 'strong'
  }, {
    id: 'idea-b',
    title: 'Control theory duplicate bridge',
    source_domain: 'Control Theory',
    integration_mechanism: 'feedback stabilization',
    usefulness_score: 4.2,
    novelty_score: 3.8,
    bridge_path_ids: ['bridge-b'],
    source_spans: [{ span_id: 'span-b' }],
    evidence_tier: 'strong'
  }, {
    id: 'idea-c',
    title: 'Medical imaging bridge',
    source_domain: 'Medical Imaging',
    integration_mechanism: 'uncertainty calibration',
    usefulness_score: 3.7,
    novelty_score: 4.1,
    bridge_path_ids: ['bridge-c'],
    source_spans: [{ span_id: 'span-c' }],
    evidence_tier: 'moderate'
  }, {
    id: 'idea-d',
    title: 'Unsupported hunch',
    source_domain: 'Speculative Domain',
    integration_mechanism: 'unverified analogy',
    usefulness_score: 5,
    novelty_score: 5,
    evidence_tier: 'missing'
  }];

  const submodular = selectIdeas(candidates, {
    mode: 'submodular',
    k: 2,
    minEvidenceTier: 'moderate',
    requireBridgePath: true
  });
  assert.equal(submodular.selection_trace.mode, 'submodular');
  assert.deepEqual(
    submodular.selection_trace.rejected.map((entry) => entry.candidate_id),
    ['idea-d']
  );
  assert.ok(submodular.selected_ids.includes('idea-c'));
  assert.ok(submodular.selection_trace.selected.every((entry) => entry.coverage_gain));

  const dpp = selectIdeas(candidates, {
    mode: 'dpp',
    k: 2,
    minEvidenceTier: 'moderate',
    requireBridgePath: true
  });
  assert.equal(dpp.selection_trace.mode, 'dpp');
  assert.equal(dpp.selected.length, 2);
  assert.equal(dpp.selection_trace.dpp_panels[0].selection_method, 'greedy_dpp_map');
  assert.ok(dpp.selection_trace.dpp_panels.length >= 2);
  assert.ok(dpp.selection_trace.metrics.average_pairwise_similarity <= 1);
  assert.deepEqual(
    dpp.selection_trace.rejected.map((entry) => entry.reason),
    ['evidence_tier_below_moderate']
  );
});
