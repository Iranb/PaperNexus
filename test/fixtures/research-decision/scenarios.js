import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCorpusPaths } from '../../../src/storage/corpus-store.js';
import { executeResearchDecisionOperation } from '../../../src/core/research/decision-service.js';

export const EXPECTATIONS = Object.freeze({ first_action: 'E1', negative_next_action: 'E3', inconclusive_next_action: 'E4', spent: 1.2, remaining: 4.8,
  negative_statuses: { Hq: 'excluded_in_scope', Hn: 'supported_in_scope' } });

export const OUTCOMES = Object.freeze({
  negative: { estimate: 0.1, interval: { lower: -0.2, upper: 0.4 } },
  wide: { estimate: 0.1, interval: { lower: -1.5, upper: 1.6 } },
  positive: { estimate: 1.4, interval: { lower: 1.2, upper: 1.6 } },
  unexplained: { estimate: 0.7, interval: { lower: 0.6, upper: 0.8 } }
});

export function scenarioInputs({ retrieval = false } = {}) {
  const quantity = retrieval ? 'recall_at_10_rerank_minus_matched_expansion' : 'novel_accuracy_quality_minus_matched_count';
  const headline = retrieval ? 'retrieval_headline_change' : 'headline_accuracy_change';
  const protocol = { protocol_id: 'matched-v1', dataset: retrieval ? 'synthetic-retrieval-v1' : 'synthetic-gcd-v1', split: 'fixed-test', labels: 'training-only',
    backbone: 'fixed-small-model', preprocessing: 'fixed-v1', augmentation: 'none', steps: 100, tuning_budget: 0,
    checkpoint_selection: 'final', metric_code: 'fixture-v1', metric_direction: 'higher', code_source: 'synthetic_fixture', command: 'fixture-only',
    environment: 'offline', independent_unit: 'seed', sample_count: 100 };
  const hypotheses = [
    { hypothesis_id: 'Hq', version: 1, statement: retrieval ? 'Reranking adds at least one point after matching retrieved count.' : 'Quality filtering adds at least one point after matching sample count.',
      mechanism: retrieval ? 'Relevance ordering changes the selected evidence.' : 'Removing incorrect pseudo-labels reduces training noise.',
      scope: { protocol_id: 'matched-v1', dataset: protocol.dataset }, intervention: 'mechanism-based selection', control: 'random selection of the same count',
      candidate_refs: ['near'], assumptions: ['same count, steps and split'], alternative_hypothesis_ids: ['Hn'],
      predictions: [
        { prediction_id: 'Pq', quantity, unit: 'percentage_points', expected: { kind: 'lower_bound', value: 1 }, minimum_meaningful_effect: 1 },
        { prediction_id: 'Pq-headline', quantity: headline, unit: 'percentage_points', expected: { kind: 'lower_bound', value: 0 }, minimum_meaningful_effect: 0.5 }
      ], falsification_rule: { necessary_prediction_ids: ['Pq'], requires_confirmatory_analysis: true } },
    { hypothesis_id: 'Hn', version: 1, statement: 'Count alone explains the improvement; the matched contrast is at most half a point.',
      mechanism: 'Changing the number of selected samples changes the result.', scope: { protocol_id: 'matched-v1', dataset: protocol.dataset },
      intervention: 'mechanism-based selection', control: 'random selection of the same count', candidate_refs: ['target'], assumptions: ['same count, steps and split'],
      alternative_hypothesis_ids: ['Hq'], predictions: [
        { prediction_id: 'Pn', quantity, unit: 'percentage_points', expected: { kind: 'interval', lower: -0.5, upper: 0.5 }, minimum_meaningful_effect: 0.5 },
        { prediction_id: 'Pn-headline', quantity: headline, unit: 'percentage_points', expected: { kind: 'lower_bound', value: 0 }, minimum_meaningful_effect: 0.5 }
      ], falsification_rule: { necessary_prediction_ids: ['Pn'], requires_confirmatory_analysis: true } }
  ];
  const action = (id, type, hours) => ({ action_id: id, version: 1, type, title: id,
    hypothesis_versions: [{ hypothesis_id: 'Hq', version: 1 }, { hypothesis_id: 'Hn', version: 1 }],
    prediction_ids: ['Pq', 'Pn'], protocol, required_protocol_fields: Object.keys(protocol),
    intervention: 'Apply mechanism-based selection and random selection at matched count.', held_constant: ['sample count', 'training steps', 'split'], measurements: [quantity],
    validity_checks: ['selection implemented and counts matched'], precision: { max_interval_width: 0.7 },
    analysis: { analysis_set_id: `fixed-${id}`, primary_outcome: quantity, look_policy: 'fixed_final', multiplicity: 'single_primary', stopping_rule: 'five independent seeds; final endpoint only' },
    estimated_cost: { upper: { gpu_hours: [{ resource: 'fixture-gpu', amount: hours }], provider_calls: 0 } },
    stopping_rule: 'Stop at the fixed endpoint; do not select the best seed.',
    result_branches: [{ when: 'contrast at least one point', next: 'replicate quality mechanism' }, { when: 'contrast inside half a point', next: 'replicate count explanation' }, { when: 'uncertainty overlaps both', next: 'improve precision' }] });
  const headlineAction = action('E0', 'controlled_experiment', 4);
  headlineAction.title = 'Large headline training';
  headlineAction.prediction_ids = ['Pq-headline', 'Pn-headline'];
  headlineAction.measurements = [headline];
  headlineAction.analysis.primary_outcome = headline;
  const control = action('E1', 'controlled_experiment', 1.5);
  control.title = 'Matched-count control';
  const scale = action('E2', 'scale_test', 3);
  scale.title = 'Scale the quality mechanism';
  scale.hypothesis_versions = [{ hypothesis_id: 'Hq', version: 1 }];
  scale.prediction_ids = ['Pq'];
  scale.prerequisites = [{ hypothesis_id: 'Hq', status: 'supported_in_scope' }];
  const replicate = action('E3', 'replicate', 1.5);
  replicate.title = 'Independent replication of the count explanation';
  replicate.hypothesis_versions = [{ hypothesis_id: 'Hn', version: 1 }];
  replicate.prediction_ids = ['Pn'];
  replicate.prerequisites = [{ hypothesis_id: 'Hn', status: 'supported_in_scope' }];
  const precision = action('E4', 'replicate', 2);
  precision.title = 'Precision follow-up after the first control';
  precision.prerequisites = [{ action_id: 'E1' }];
  precision.precision.max_interval_width = 0.4;
  return { quantity, headline, protocol, hypotheses, actions: [headlineAction, control, scale, replicate, precision],
    init: { objective: retrieval ? 'Separate reranking from retrieved-count explanations.' : 'Separate quality filtering from sample-count explanations.', goal_phase: 'mechanism_validation',
      budget: { gpu_hours: [{ resource: 'fixture-gpu', limit: 6 }], provider_calls: { limit: 0 } },
      exploration_limit: { max_actions: 1, gpu_hours: [{ resource: 'fixture-gpu', limit: 1 }], provider_calls: { limit: 0 } } },
    candidate_priority_baseline: [{ candidate_id: 'near', action_id: 'E0', controller_utility: 0.94 }, { candidate_id: 'target', action_id: 'E1', controller_utility: 0.81 }]
  };
}

export async function createDecisionFixture(t, options = {}) {
  const root = options.root ? path.resolve(options.root) : await fs.mkdtemp(path.join(os.tmpdir(), 'pn-decision-'));
  if (options.root) await fs.mkdir(root, { recursive: true });
  t?.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'decision-fixture', rootPath: root }));
  const input = scenarioInputs(options);
  const refs = [];
  for (const id of ['quality', 'count', 'far']) {
    const artifactPath = path.join(root, `${id}.json`);
    await fs.writeFile(artifactPath, JSON.stringify({ source_id: `source:${id}`, source_version: '1', admitted: id !== 'far', evidence_origin: 'synthetic_fixture' }));
    refs.push({ evidence_origin: 'synthetic_fixture', source_id: `source:${id}`, source_version: '1', locator: `claims/${id}`, artifact_path: artifactPath });
  }
  input.hypotheses[0].evidence_refs = [refs[0]];
  input.hypotheses[1].evidence_refs = [refs[1]];
  for (const h of input.hypotheses) for (const p of h.predictions) p.basis = { kind: 'derivation',
    rationale: 'Synthetic fixture defines these intervals as its test oracle; no real research effect is asserted.', evidence_refs: h.evidence_refs };
  for (const action of input.actions) Object.assign(action.precision, { anticipated_interval_width: 0.4, basis_refs: [refs[0]] });
  input.candidates = [
    { candidate_id: 'target', source_domain: 'target', mechanism: 'count', subproblem: 'confounding', evidence_cluster: 'count', evidence_refs: [refs[1]], bridge_evidence: true },
    { candidate_id: 'near', source_domain: 'near', mechanism: 'quality', subproblem: 'selection', evidence_cluster: 'quality', evidence_refs: [refs[0]], bridge_evidence: true },
    { candidate_id: 'far', source_domain: 'far', mechanism: 'adaptive control', subproblem: 'stability', evidence_cluster: 'control', evidence_refs: [refs[2]], bridge_evidence: false }
  ];
  let revision = 0, counter = 0;
  const call = async (operation, payload, extra = {}, serviceOptions = {}) => {
    const mutations = ['init', 'register_hypotheses', 'register_actions', 'record_run', 'assess_results', 'update_opportunities', 'refresh_evidence'];
    const args = { operation, corpus: root, project: 'quality-vs-count', ...(payload === undefined ? {} : { payload }),
      ...(mutations.includes(operation) ? { requestId: `${operation}-${++counter}`, ...(operation === 'init' ? {} : { expectedRevision: revision }) } : {}), ...extra };
    const response = await executeResearchDecisionOperation(root, args, serviceOptions);
    revision = response.current_revision ?? response.revision;
    return response;
  };
  const seed = async () => {
    await call('init', input.init, { requestId: 'init-1' });
    await call('register_hypotheses', { hypotheses: input.hypotheses }, { requestId: 'hypotheses-1' });
    await call('register_actions', { actions: input.actions }, { requestId: 'actions-1' });
  };
  const run = (outcome = 'negative', overrides = {}) => ({
    record_id: 'record-1', executor_id: 'offline-fixture', run_id: 'control', attempt_id: 'attempt-1', source_revision: 1,
    status: 'completed', action_id: 'E1', action_version: 1, registration_receipt: 'actions-1', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    protocol: structuredClone(input.protocol), analysis: structuredClone(input.actions.find(a => a.action_id === 'E1').analysis),
    measurements: [{ quantity: input.quantity, unit: 'percentage_points', ...structuredClone(OUTCOMES[outcome]),
      uncertainty: { method: 'synthetic fixed endpoint interval', level: 0.95, independent_unit: 'seed', unit_count: 5,
        calculation_ref: 'synthetic/raw-seeds', review: { status: 'reviewed', reviewer: 'fixture-only', reference: 'synthetic/review' } } }],
    intervention_checks: [{ check: 'selection implemented and counts matched', passed: true, reference: 'synthetic/executor-log' }],
    baseline: { reproduced: true, shortfall: 0, reference: 'synthetic/baseline' }, comparison: { kind: 'matched_reproduced', protocol_verified: true },
    actual_cost: { gpu_hours: [{ resource: 'fixture-gpu', amount: 1.2 }], provider_calls: 0 }, cost_final: true,
    evidence_origin: 'synthetic_fixture', independent_group: 'independent-fixture-seeds', ...overrides
  });
  const assess = async (ids = ['record-1'], extra = {}) => call('assess_results', { run_record_ids: ids,
    hypothesis_versions: [{ hypothesis_id: 'Hq', version: 1 }, { hypothesis_id: 'Hn', version: 1 }], ...extra });
  return { root, paths, input, refs, call, seed, run, assess, revision: () => revision, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
