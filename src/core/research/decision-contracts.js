import { isDeepStrictEqual } from 'node:util';

export const DECISION_VERSION = 'papernexus-research-decision-v1';
export const POLICY_VERSION = 'discriminating-action-v4';
export const MUTATIONS = ['init', 'register_hypotheses', 'register_actions', 'record_run', 'assess_results', 'update_opportunities', 'refresh_evidence'];
export const OPERATIONS = [...MUTATIONS, 'status', 'recommend_next', 'export', 'evidence_view'];
export const ACTION_TYPES = ['read_source', 'search_literature', 'inspect_code', 'profile_cost', 'repair_baseline', 'diagnostic', 'controlled_experiment', 'replicate', 'scale_test'];
export const EXPERIMENT_TYPES = ['controlled_experiment', 'replicate', 'scale_test'];

const text = { type: 'string', minLength: 1, maxLength: 8000 };
const number = { type: 'number' };
const positive = { type: 'integer', minimum: 1 };
const object = (properties, required = [], extra = false) => ({ type: 'object', properties, required, additionalProperties: extra });
const array = (items, minItems = 0) => ({ type: 'array', items, minItems });
const choice = (values) => ({ type: 'string', enum: values });
const record = { type: 'object', additionalProperties: true };
const strings = array(text);
export const EVIDENCE_REF_SCHEMA = object({
  evidence_origin: choice(['paper_reported', 'external_measured', 'code_inspected', 'agent_inferred', 'search_absence', 'synthetic_fixture']),
  source_id: text, source_version: text, locator: text, paper_id: text, source_key: text, artifact_path: text,
  repository: text, code_revision: text, file_path: text, symbol: text, observation: text
}, ['evidence_origin', 'source_id', 'source_version', 'locator']);
const refs = array(EVIDENCE_REF_SCHEMA);
const inferenceTarget = choice(['fixed_model', 'training_procedure']);
const evidenceRole = choice(['observation', 'proxy', 'target']);
const reference = { oneOf: [
  object({ kind: { const: 'run_record' }, record_id: text }, ['kind', 'record_id']),
  object({ kind: choice(['external_manifest', 'paper_report']), source_ref: EVIDENCE_REF_SCHEMA,
    protocol_locator: text, measurements_locator: text }, ['kind', 'source_ref', 'protocol_locator', 'measurements_locator'])
] };
const evaluationPlan = object({
  comparators: array(object({ comparison_id: text, role: choice(['original', 'control', 'paper']), reference,
    required_protocol_fields: array(text, 1) }, ['comparison_id', 'role', 'reference', 'required_protocol_fields']), 1),
  outcomes: array(object({ quantity: text, unit: text, direction: choice(['higher', 'lower']), role: choice(['primary', 'guardrail', 'diagnostic']),
    evidence_role: evidenceRole,
    minimum_effect: { type: 'number', minimum: 0 }, max_regression: { type: 'number', minimum: 0 }, comparison_ids: array(text, 1)
  }, ['quantity', 'unit', 'direction', 'role', 'comparison_ids']), 1), inference_target: inferenceTarget
}, ['comparators', 'outcomes']);
const versionRef = object({ hypothesis_id: text, version: positive }, ['hypothesis_id', 'version']);
const expected = { oneOf: [
  object({ kind: { const: 'interval' }, lower: number, upper: number }, ['kind', 'lower', 'upper']),
  object({ kind: choice(['lower_bound', 'upper_bound']), value: number }, ['kind', 'value'])
] };
const prediction = object({
  prediction_id: text, quantity: text, unit: text, expected, minimum_meaningful_effect: { type: 'number', minimum: 0 },
  basis: object({ kind: choice(['empirical', 'derivation', 'assumption']), rationale: text, evidence_refs: refs }, ['kind', 'rationale', 'evidence_refs']),
  conditions: record, competing_hypothesis_ids: strings, comparison_id: text, inference_target: inferenceTarget,
  evidence_role: evidenceRole, proxy_for: strings
}, ['prediction_id', 'quantity', 'unit', 'expected', 'minimum_meaningful_effect']);
const hypothesis = object({
  hypothesis_id: text, version: positive, statement: text, mechanism: text, scope: record,
  intervention: text, control: text, candidate_refs: strings, evidence_refs: refs, assumptions: strings,
  alternative_hypothesis_ids: strings, predictions: array(prediction),
  mechanism_evidence: object({
    components: array(object({ id: text, kind: choice(['source_claim', 'code_component', 'sample_population', 'loss_term', 'observable']),
      statement: text, evidence_refs: refs, graph_node_id: text, quantity: text, unit: text }, ['id', 'kind', 'statement', 'evidence_refs'])),
    links: array(object({ from: text, to: text, relation: choice(['implements', 'changes_population', 'proposes_effect', 'observed_with']),
      status: choice(['source_supported', 'code_observed', 'measured_association', 'hypothesized']), evidence_refs: refs,
      graph_relation_ids: strings, required_controls: strings
    }, ['from', 'to', 'relation', 'status', 'evidence_refs']))
  }, ['components', 'links']),
  falsification_rule: object({ necessary_prediction_ids: strings, requires_confirmatory_analysis: { type: 'boolean' } }, ['necessary_prediction_ids'])
}, ['hypothesis_id', 'version', 'statement']);
const cost = object({
  gpu_hours: array(object({ resource: text, amount: { type: 'number', minimum: 0 } }, ['resource', 'amount'])),
  cpu_hours: { type: 'number', minimum: 0 },
  money: array(object({ currency: text, amount: { type: 'number', minimum: 0 } }, ['currency', 'amount'])),
  provider_calls: { type: 'integer', minimum: 0 }, wait_hours: { type: 'number', minimum: 0 }
});
export const BUDGET_SCHEMA = object({
  gpu_hours: array(object({ resource: text, limit: { type: 'number', minimum: 0 } }, ['resource', 'limit'])),
  cpu_hours: object({ limit: { type: 'number', minimum: 0 } }, ['limit']),
  money: array(object({ currency: text, limit: { type: 'number', minimum: 0 } }, ['currency', 'limit'])),
  provider_calls: object({ limit: { type: 'integer', minimum: 0 } }, ['limit'])
});
const analysis = object({
  analysis_set_id: text, primary_outcome: text, look_policy: choice(['fixed_final', 'sequential_adjusted', 'exploratory']),
  multiplicity: choice(['single_primary', 'adjusted', 'uncontrolled']), adjustment_ref: text, stopping_rule: text,
  primary_comparison_id: text, family: array(object({ comparison_id: text, quantity: text }, ['comparison_id', 'quantity']))
}, ['analysis_set_id', 'primary_outcome', 'look_policy', 'multiplicity', 'stopping_rule']);
const action = object({
  action_id: text, version: positive, type: choice(ACTION_TYPES), title: text,
  hypothesis_versions: array(versionRef), prediction_ids: strings, protocol: record, required_protocol_fields: strings,
  intervention: text, held_constant: strings, measurements: strings, validity_checks: strings,
  precision: object({ max_interval_width: { type: 'number', exclusiveMinimum: 0 },
    anticipated_interval_width: { type: 'number', exclusiveMinimum: 0 }, basis_refs: refs, inference_target: inferenceTarget }),
  evaluation_plan: evaluationPlan,
  intervention_components: array(object({ component_id: text, hypothesis_id: text, hypothesis_version: positive, held_constant: strings },
    ['component_id', 'hypothesis_id', 'hypothesis_version', 'held_constant'])),
  controlled_components: array(object({ component_id: text, hypothesis_id: text, hypothesis_version: positive, check: text },
    ['component_id', 'hypothesis_id', 'hypothesis_version', 'check'])),
  information_targets: array(object({ hypothesis_id: text, hypothesis_version: positive,
    kind: choice(['prediction_basis', 'precision', 'path', 'control', 'proxy_bridge', 'target_measurement']), prediction_id: text, component_id: text },
    ['hypothesis_id', 'hypothesis_version', 'kind'])),
  analysis, estimated_cost: object({ lower: cost, upper: cost }, ['upper']),
  stopping_rule: text, result_branches: array(object({ when: text, next: text }, ['when', 'next'])),
  prerequisites: array(object({ hypothesis_id: text, hypothesis_version: positive, status: choice(['supported_in_scope', 'excluded_in_scope', 'weakened_in_scope', 'inconclusive', 'conflicted']), action_id: text })),
  evidence_refs: refs, exploration: { type: 'boolean' }, candidate_id: text, reason: text,
  tool_call: object({ tool: choice(['literature_review', 'lineage_analysis', 'idea_generation']), arguments: record }, ['tool', 'arguments'])
}, ['action_id', 'version', 'type', 'title']);
const measurement = object({
  prediction_id: text, quantity: text, unit: text, estimate: number,
  value_kind: choice(['absolute', 'difference']), value_unit: text, candidate_estimate: number, reference_estimate: number,
  interval: object({ lower: number, upper: number }, ['lower', 'upper']),
  uncertainty: object({ method: text, level: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    independent_unit: text, unit_count: positive, calculation_ref: text, inference_target: inferenceTarget, independent_run_refs: strings,
    review: object({ status: choice(['reviewed', 'unreviewed']), reviewer: text, reference: text }, ['status'])
  }), independent_group: text
}, ['quantity', 'unit', 'estimate']);
const run = object({
  record_id: text, executor_id: text, run_id: text, attempt_id: text, source_revision: positive,
  supersedes_record_id: text, status: choice(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown_after_timeout']),
  action_id: text, action_version: positive, registration_receipt: text,
  started_at: text, ended_at: text, protocol: record, analysis, measurements: array(measurement),
  intervention_checks: array(object({ check: text, passed: { type: 'boolean' }, reference: text }, ['check', 'passed', 'reference'])),
  baseline: object({ reproduced: { type: 'boolean' }, shortfall: number, reference: text }),
  comparison: object({ kind: choice(['paper_reported', 'reproduced', 'matched_reproduced']), source_ref: EVIDENCE_REF_SCHEMA, protocol_verified: { type: 'boolean' } }, ['kind']),
  comparisons: array(object({ comparison_id: text, reference, kind: choice(['paper_reported', 'reproduced', 'matched_reproduced']),
    protocol: record, verification_refs: refs, measurements: array(measurement, 1)
  }, ['comparison_id', 'reference', 'kind', 'measurements']), 1),
  actual_cost: cost, cost_final: { type: 'boolean' }, manifest_path: text, artifact_refs: refs,
  evidence_origin: choice(['external_measured', 'synthetic_fixture']), independent_group: text,
  recommendation_ref: record, reason: text
}, ['record_id', 'executor_id', 'run_id', 'attempt_id', 'source_revision', 'status', 'action_id', 'action_version', 'evidence_origin']);
const condition = object({
  type: choice(['new_admitted_evidence', 'dependency_resolved', 'competing_hypothesis_weakened', 'budget_or_resource_changed']),
  source_id: text, hypothesis_id: text, action_id: text
}, ['type']);
const candidate = object({
  candidate_id: text, source_domain: text, mechanism: text, subproblem: text, evidence_cluster: text,
  evidence_refs: refs, bridge_evidence: { type: 'boolean' }, artifact_path: text, source_version: text,
  revisit_conditions: array(condition), minimum_next_step: text
}, ['candidate_id']);
const phase = choice(['mechanism_validation', 'performance_validation']);
const exploration = object({ max_actions: { type: 'integer', minimum: 0 }, ...BUDGET_SCHEMA.properties });
export const PAYLOAD_SCHEMAS = {
  init: object({ objective: text, goal_phase: phase, budget: BUDGET_SCHEMA, exploration_limit: exploration }, ['objective', 'goal_phase', 'budget']),
  register_hypotheses: object({ hypotheses: array(hypothesis, 1) }, ['hypotheses']),
  register_actions: object({ actions: array(action, 1) }, ['actions']),
  record_run: object({ run }, ['run']),
  assess_results: object({ run_record_ids: array(text, 1), hypothesis_versions: array(versionRef, 1), analysis_annotations: array(object({
    hypothesis_id: text, scope: record, reasoning: text, evidence_refs: refs
  }, ['hypothesis_id', 'scope', 'reasoning', 'evidence_refs'])) }, ['run_record_ids', 'hypothesis_versions']),
  recommend_next: object({ action_ids: strings }),
  update_opportunities: object({ changes: array(object({
    op: choice(['park', 'reactivate', 'retire', 'set_revisit_conditions', 'set_budget', 'set_goal_phase']),
    reason: text, candidate_id: text, candidate, revisit_conditions: array(condition), budget: BUDGET_SCHEMA,
    exploration_limit: exploration, goal_phase: phase
  }, ['op', 'reason']), 1) }, ['changes']),
  refresh_evidence: object({ source_refs: refs, candidate_refs: array(candidate) })
};
export const REQUEST_PROPERTIES = {
  operation: choice(OPERATIONS), corpus: text, project: text, requestId: text,
  expectedRevision: { type: 'integer', minimum: 0 }, responseMode: choice(['full', 'summary']),
  dryRun: { type: 'boolean' }, payload: record, entityId: text, assessmentId: text, outputDir: text,
  query: text, limit: { type: 'integer', minimum: 1, maximum: 50 }, includeHistory: { type: 'boolean' }
};
export const REQUEST_FIELDS = Object.fromEntries(OPERATIONS.map(operation => [operation, [
  'operation', 'corpus', 'project', 'responseMode', 'dryRun',
  ...(MUTATIONS.includes(operation) ? ['requestId', 'expectedRevision', 'payload'] : []),
  ...(operation === 'status' ? ['requestId', 'entityId'] : []),
  ...(operation === 'export' ? ['assessmentId', 'outputDir'] : []),
  ...(operation === 'recommend_next' ? ['payload'] : []),
  ...(operation === 'evidence_view' ? ['query', 'limit', 'includeHistory'] : [])
]]));

export function decisionError(code, message, details) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

export function assertSchema(value, schema, at = 'request') {
  const fail = detail => { throw decisionError('invalid_input', `${at}: ${detail}`); };
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(item => { try { assertSchema(value, item, at); return true; } catch { return false; } });
    if (matches.length !== 1) fail('does not match an allowed shape');
    return;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail('unexpected value');
  if (schema.enum && !schema.enum.includes(value)) fail(`expected ${schema.enum.join('|')}`);
  if (schema.type === 'string' && (typeof value !== 'string' || value.trim().length < (schema.minLength || 0))) fail('expected nonempty string');
  if (schema.type === 'string' && value.length > (schema.maxLength ?? Infinity)) fail('string exceeds maximum length');
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail('expected boolean');
  if (['number', 'integer'].includes(schema.type)) {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('expected finite number');
    if (schema.minimum !== undefined && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('below exclusive minimum');
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail('above exclusive maximum');
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0)) fail('expected array with required entries');
    value.forEach((item, i) => assertSchema(item, schema.items, `${at}[${i}]`));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) assertSchema(item, schema.properties[key], `${at}.${key}`);
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`);
    }
  }
}

export function validateDecisionRequest(args) {
  assertSchema(args, object(REQUEST_PROPERTIES, ['operation', 'project']));
  for (const key of Object.keys(args)) if (!REQUEST_FIELDS[args.operation].includes(key)) throw decisionError('invalid_input', `${key} is not allowed for ${args.operation}`);
  if (MUTATIONS.includes(args.operation)) {
    assertSchema(args.requestId, text, 'requestId');
    if (args.operation !== 'init' && !Number.isInteger(args.expectedRevision)) throw decisionError('invalid_input', 'expectedRevision is required');
  }
  if (PAYLOAD_SCHEMAS[args.operation]) assertSchema(args.payload || {}, PAYLOAD_SCHEMAS[args.operation], 'payload');
  const payload = args.payload || {};
  if (payload.run?.comparisons && (payload.run.comparison || payload.run.baseline)) throw decisionError('invalid_input', 'comparisons cannot be combined with legacy comparison/baseline');
  for (const ref of collectEntityEvidence(payload.run || {})) validateCodeReference(ref);
  for (const budget of [payload.budget, payload.exploration_limit, ...(payload.changes || []).flatMap(c => [c.budget, c.exploration_limit]), payload.run?.actual_cost]) validateResourceEntries(budget);
  for (const action of payload.actions || []) {
    validateResourceEntries(action.estimated_cost?.lower);
    validateResourceEntries(action.estimated_cost?.upper);
    const lower = action.estimated_cost?.lower, upper = action.estimated_cost?.upper;
    for (const [field, key] of [['gpu_hours', 'resource'], ['money', 'currency']]) for (const entry of lower?.[field] || []) {
      const ceiling = upper?.[field]?.find(item => item[key] === entry[key]);
      if (!ceiling || entry.amount > ceiling.amount) throw decisionError('invalid_input', `estimated_cost.${field}: lower exceeds upper or has no matching upper`);
    }
    for (const field of ['cpu_hours', 'provider_calls', 'wait_hours']) if (lower?.[field] !== undefined && (upper?.[field] === undefined || lower[field] > upper[field])) throw decisionError('invalid_input', `estimated_cost.${field}: lower exceeds upper or has no matching upper`);
  }
  return args;
}

export function validateResourceEntries(resource) {
  for (const [field, key] of [['gpu_hours', 'resource'], ['money', 'currency']]) {
    const entries = resource?.[field] || [];
    if (new Set(entries.map(item => item[key])).size !== entries.length) throw decisionError('invalid_input', `duplicate resource in ${field}`);
  }
}

export function predictionRange(prediction) {
  const range = prediction.expected;
  return range.kind === 'interval' ? [range.lower, range.upper]
    : range.kind === 'lower_bound' ? [range.value, Infinity] : [-Infinity, range.value];
}

export function validateHypothesisSet(hypotheses, existing = [], measurementIds = []) {
  const ids = new Set([...existing, ...hypotheses].map(h => h.hypothesis_id));
  const keys = new Set();
  return hypotheses.map(h => {
    const key = `${h.hypothesis_id}@${h.version}`;
    if (keys.has(key)) throw decisionError('invalid_input', `duplicate hypothesis ${key}`);
    keys.add(key);
    for (const id of h.alternative_hypothesis_ids || []) if (!ids.has(id) || id === h.hypothesis_id) throw decisionError('invalid_reference', `alternative ${id}`);
    const predictions = h.predictions || [];
    if (new Set(predictions.map(p => p.prediction_id)).size !== predictions.length) throw decisionError('invalid_input', 'duplicate prediction_id');
    for (const p of predictions) if (predictionRange(p)[0] > predictionRange(p)[1]) throw decisionError('invalid_input', 'reversed prediction interval');
    for (const p of predictions) {
      if (p.proxy_for?.length && p.evidence_role !== 'proxy') throw decisionError('invalid_input', 'proxy_for requires a proxy prediction');
      if (new Set(p.proxy_for || []).size !== (p.proxy_for || []).length) throw decisionError('invalid_input', 'duplicate proxy target');
      for (const id of p.proxy_for || []) if (!predictions.some(target => target.prediction_id === id && target.evidence_role === 'target')) {
        throw decisionError('invalid_reference', `proxy target ${id} must name a target prediction in the same hypothesis`);
      }
    }
    for (const id of h.falsification_rule?.necessary_prediction_ids || []) if (!predictions.some(p => p.prediction_id === id)) throw decisionError('invalid_reference', `necessary prediction ${id}`);
    const components = h.mechanism_evidence?.components || [];
    if (new Set(components.map(c => c.id)).size !== components.length) throw decisionError('invalid_input', 'duplicate mechanism component');
    if (components.some(c => predictions.some(p => p.prediction_id === c.id) || measurementIds.includes(c.id))) throw decisionError('invalid_input', 'mechanism component identity overlaps a prediction or measurement');
    for (const c of components) if (Boolean(c.quantity) !== Boolean(c.unit)) throw decisionError('invalid_input', 'observable quantity and unit must be supplied together');
    const endpoints = new Set([...components.map(c => c.id), ...predictions.map(p => p.prediction_id), ...measurementIds]);
    for (const link of h.mechanism_evidence?.links || []) {
      if (!endpoints.has(link.from) || !endpoints.has(link.to)) throw decisionError('invalid_reference', 'mechanism link endpoint');
      if (link.from === link.to) throw decisionError('invalid_input', 'mechanism link cannot reference itself');
      for (const id of link.required_controls || []) if (!components.some(c => c.id === id)) throw decisionError('invalid_reference', `required control ${id}`);
      if (link.status !== 'hypothesized' && !link.evidence_refs.length) throw decisionError('invalid_input', 'observed mechanism links require evidence');
    }
    collectEntityEvidence(h).forEach(validateCodeReference);
    const missing = ['mechanism', 'intervention', 'control'].filter(k => !h[k]);
    if (!Object.keys(h.scope || {}).length) missing.push('scope');
    if (!predictions.length) missing.push('predictions');
    if (!h.evidence_refs?.length) missing.push('evidence_refs');
    if (!h.alternative_hypothesis_ids?.length) missing.push('alternative_hypothesis_ids');
    return { ...h, predictions, prediction_ids: predictions.map(p => p.prediction_id), design_status: missing.length ? 'draft' : 'testable', missing_fields: missing };
  });
}

export function validateActionPlan(action, hypotheses) {
  const missing = ['intervention', 'stopping_rule'].filter(k => !action[k]);
  for (const key of ['hypothesis_versions', 'held_constant', 'measurements', 'result_branches']) if (!action[key]?.length) missing.push(key);
  if (EXPERIMENT_TYPES.includes(action.type)) {
    for (const key of ['validity_checks', 'required_protocol_fields']) if (!action[key]?.length) missing.push(key);
    if (!action.analysis) missing.push('analysis');
    if (!action.precision?.max_interval_width) missing.push('precision.max_interval_width');
  }
  const bound = (action.hypothesis_versions || []).map(ref => {
    const h = hypotheses.find(item => item.hypothesis_id === ref.hypothesis_id && item.version === ref.version);
    if (!h) throw decisionError('invalid_reference', `hypothesis ${ref.hypothesis_id}@${ref.version}`);
    return h;
  });
  collectEntityEvidence(action).forEach(validateCodeReference);
  for (const item of action.intervention_components || []) {
    const h = bound.find(h => h.hypothesis_id === item.hypothesis_id && h.version === item.hypothesis_version);
    if (!h?.mechanism_evidence?.components.some(c => c.id === item.component_id)) throw decisionError('invalid_reference', `intervention component ${item.component_id}`);
  }
  const controls = new Set();
  for (const item of action.controlled_components || []) {
    const h = bound.find(h => h.hypothesis_id === item.hypothesis_id && h.version === item.hypothesis_version);
    if (!h?.mechanism_evidence?.components.some(c => c.id === item.component_id)) throw decisionError('invalid_reference', `controlled component ${item.component_id}`);
    const key = JSON.stringify([item.hypothesis_id, item.hypothesis_version, item.component_id]);
    if (controls.has(key)) throw decisionError('invalid_input', 'duplicate controlled component');
    controls.add(key);
    if (!action.validity_checks?.includes(item.check)) throw decisionError('invalid_reference', `control check ${item.check}`);
    if (action.intervention_components?.some(c => c.hypothesis_id === item.hypothesis_id && c.hypothesis_version === item.hypothesis_version && c.component_id === item.component_id)) throw decisionError('invalid_input', 'a component cannot be both changed and held constant');
  }
  for (const target of action.information_targets || []) {
    const h = bound.find(h => h.hypothesis_id === target.hypothesis_id && h.version === target.hypothesis_version);
    if (!h) throw decisionError('invalid_reference', 'information target hypothesis');
    if (target.kind === 'control') {
      if (target.prediction_id || !h.mechanism_evidence?.components.some(c => c.id === target.component_id)) throw decisionError('invalid_reference', 'information target control');
    } else {
      const prediction = h.predictions.find(p => p.prediction_id === target.prediction_id);
      if (target.component_id || !prediction) throw decisionError('invalid_reference', 'information target prediction');
      if (target.kind === 'proxy_bridge' && !prediction.proxy_for?.length) throw decisionError('invalid_reference', 'information target requires a declared proxy link');
      if (target.kind === 'target_measurement' && prediction.evidence_role !== 'target') throw decisionError('invalid_reference', 'information target requires a target prediction');
    }
  }
  const plan = action.evaluation_plan;
  if (plan) {
    const ids = plan.comparators.map(c => c.comparison_id);
    if (new Set(ids).size !== ids.length) throw decisionError('invalid_input', 'duplicate comparison_id');
    for (const outcome of plan.outcomes) for (const id of outcome.comparison_ids) if (!ids.includes(id)) throw decisionError('invalid_reference', `outcome comparison ${id}`);
    if (!plan.outcomes.some(o => o.role === 'primary')) missing.push('evaluation_plan.primary_outcome');
    for (const outcome of plan.outcomes) {
      if (outcome.role === 'primary' && outcome.minimum_effect === undefined) missing.push(`evaluation_plan.minimum_effect:${outcome.quantity}`);
      if (outcome.role === 'guardrail' && outcome.max_regression === undefined) missing.push(`evaluation_plan.max_regression:${outcome.quantity}`);
    }
    if (!plan.inference_target) missing.push('evaluation_plan.inference_target');
    if (!ids.includes(action.analysis?.primary_comparison_id)) missing.push('analysis.primary_comparison_id');
    for (const item of action.analysis?.family || []) if (!plan.outcomes.some(o => o.quantity === item.quantity && o.comparison_ids.includes(item.comparison_id))) throw decisionError('invalid_reference', 'analysis family outside evaluation plan');
    for (const p of bound.flatMap(h => h.predictions).filter(p => action.prediction_ids?.includes(p.prediction_id))) {
      const outcomes = plan.outcomes.filter(o => o.quantity === p.quantity && o.unit === p.unit && (!p.comparison_id || o.comparison_ids.includes(p.comparison_id)));
      if (p.evidence_role && outcomes.some(o => o.evidence_role && o.evidence_role !== p.evidence_role)) throw decisionError('invalid_input', 'prediction and outcome evidence roles differ');
      if (p.comparison_id && !ids.includes(p.comparison_id)) throw decisionError('invalid_reference', `prediction comparison ${p.comparison_id}`);
      if (!p.comparison_id && plan.outcomes.filter(o => o.quantity === p.quantity).flatMap(o => o.comparison_ids).length !== 1) missing.push(`prediction_comparison:${p.prediction_id}`);
    }
  }
  for (const h of bound) for (const [field, expectedValue] of Object.entries(h.scope || {})) {
    if (!isDeepStrictEqual(action.protocol?.[field], expectedValue)) missing.push(`scope.${h.hypothesis_id}.${field}`);
  }
  for (const field of action.required_protocol_fields || []) if (action.protocol?.[field] === undefined) missing.push(`protocol.${field}`);
  for (const id of action.prediction_ids || []) if (!bound.some(h => h.prediction_ids.includes(id))) throw decisionError('invalid_reference', `prediction ${id}`);
  for (const p of bound.flatMap(h => h.predictions).filter(p => action.prediction_ids?.includes(p.prediction_id))) {
    if (!action.measurements?.includes(p.quantity)) missing.push(`measurement.${p.prediction_id}`);
    for (const [field, value] of Object.entries(p.conditions || {})) if (!isDeepStrictEqual(action.protocol?.[field], value)) missing.push(`prediction_condition.${p.prediction_id}.${field}`);
  }
  for (const prerequisite of action.prerequisites || []) {
    if (!prerequisite.hypothesis_id && !prerequisite.action_id) throw decisionError('invalid_input', 'A prerequisite must name a hypothesis or action');
    if (prerequisite.hypothesis_id && !prerequisite.status) throw decisionError('invalid_input', 'A hypothesis prerequisite requires status');
  }
  if (EXPERIMENT_TYPES.includes(action.type) && !action.prediction_ids?.length) missing.push('prediction_ids');
  return { ...action, design_status: missing.length ? 'draft' : 'testable', missing_fields: missing };
}

export function collectEntityEvidence(entity) {
  return [...(entity.evidence_refs || []), ...(entity.artifact_refs || []), ...(entity.precision?.basis_refs || []),
    ...(entity.predictions || []).flatMap(p => p.basis?.evidence_refs || []),
    ...(entity.mechanism_evidence?.components || []).flatMap(c => c.evidence_refs || []),
    ...(entity.mechanism_evidence?.links || []).flatMap(c => c.evidence_refs || []),
    ...(entity.evaluation_plan?.comparators || []).flatMap(c => c.reference?.source_ref ? [c.reference.source_ref] : []),
    ...(entity.comparisons || []).flatMap(c => [...(c.reference?.source_ref ? [c.reference.source_ref] : []), ...(c.verification_refs || [])])];
}

export function validateCodeReference(ref) {
  if (ref.evidence_origin !== 'code_inspected') return;
  for (const key of ['artifact_path', 'repository', 'code_revision', 'file_path', 'observation']) {
    if (!ref[key]) throw decisionError('invalid_input', `code_inspected requires ${key}`);
  }
}

export function measurementReferences(runs) {
  return runs.flatMap(run => [
    ...(run.measurements || []).map(m => ({ id: `measurement:${run.record_id}/${m.quantity}/${m.unit}`, record_id: run.record_id, measurement: m, scope: run.protocol })),
    ...(run.comparisons || []).flatMap(c => c.measurements.map(m => ({ id: `comparison:${run.record_id}/${c.comparison_id}/${m.quantity}/${m.unit}`,
      record_id: run.record_id, comparison_id: c.comparison_id, measurement: m, scope: run.protocol })))
  ]);
}
