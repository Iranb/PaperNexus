import { isDeepStrictEqual } from 'node:util';

export const DECISION_VERSION = 'papernexus-research-decision-v1';
export const POLICY_VERSION = 'discriminating-action-v1';
export const MUTATIONS = ['init', 'register_hypotheses', 'register_actions', 'record_run', 'assess_results', 'update_opportunities', 'refresh_evidence'];
export const OPERATIONS = [...MUTATIONS, 'status', 'recommend_next', 'export'];
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
  evidence_origin: choice(['paper_reported', 'external_measured', 'agent_inferred', 'search_absence', 'synthetic_fixture']),
  source_id: text, source_version: text, locator: text, paper_id: text, source_key: text, artifact_path: text
}, ['evidence_origin', 'source_id', 'source_version', 'locator']);
const refs = array(EVIDENCE_REF_SCHEMA);
const versionRef = object({ hypothesis_id: text, version: positive }, ['hypothesis_id', 'version']);
const expected = { oneOf: [
  object({ kind: { const: 'interval' }, lower: number, upper: number }, ['kind', 'lower', 'upper']),
  object({ kind: choice(['lower_bound', 'upper_bound']), value: number }, ['kind', 'value'])
] };
const prediction = object({
  prediction_id: text, quantity: text, unit: text, expected, minimum_meaningful_effect: { type: 'number', minimum: 0 },
  conditions: record, competing_hypothesis_ids: strings
}, ['prediction_id', 'quantity', 'unit', 'expected', 'minimum_meaningful_effect']);
const hypothesis = object({
  hypothesis_id: text, version: positive, statement: text, mechanism: text, scope: record,
  intervention: text, control: text, candidate_refs: strings, evidence_refs: refs, assumptions: strings,
  alternative_hypothesis_ids: strings, predictions: array(prediction),
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
  multiplicity: choice(['single_primary', 'adjusted', 'uncontrolled']), adjustment_ref: text, stopping_rule: text
}, ['analysis_set_id', 'primary_outcome', 'look_policy', 'multiplicity', 'stopping_rule']);
const action = object({
  action_id: text, version: positive, type: choice(ACTION_TYPES), title: text,
  hypothesis_versions: array(versionRef), prediction_ids: strings, protocol: record, required_protocol_fields: strings,
  intervention: text, held_constant: strings, measurements: strings, validity_checks: strings,
  precision: object({ max_interval_width: { type: 'number', exclusiveMinimum: 0 } }),
  analysis, estimated_cost: object({ lower: cost, upper: cost }, ['upper']),
  stopping_rule: text, result_branches: array(object({ when: text, next: text }, ['when', 'next'])),
  prerequisites: array(object({ hypothesis_id: text, hypothesis_version: positive, status: choice(['supported_in_scope', 'excluded_in_scope', 'weakened_in_scope', 'inconclusive', 'conflicted']), action_id: text })),
  evidence_refs: refs, exploration: { type: 'boolean' }, candidate_id: text, reason: text,
  tool_call: object({ tool: choice(['literature_review', 'lineage_analysis', 'idea_generation']), arguments: record }, ['tool', 'arguments'])
}, ['action_id', 'version', 'type', 'title']);
const measurement = object({
  prediction_id: text, quantity: text, unit: text, estimate: number,
  interval: object({ lower: number, upper: number }, ['lower', 'upper']),
  uncertainty: object({ method: text, level: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    independent_unit: text, unit_count: positive, calculation_ref: text,
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
  dryRun: { type: 'boolean' }, payload: record, entityId: text, assessmentId: text, outputDir: text
};
export const REQUEST_FIELDS = Object.fromEntries(OPERATIONS.map(operation => [operation, [
  'operation', 'corpus', 'project', 'responseMode', 'dryRun',
  ...(MUTATIONS.includes(operation) ? ['requestId', 'expectedRevision', 'payload'] : []),
  ...(operation === 'status' ? ['requestId', 'entityId'] : []),
  ...(operation === 'export' ? ['assessmentId', 'outputDir'] : []),
  ...(operation === 'recommend_next' ? ['payload'] : [])
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

export function validateHypothesisSet(hypotheses, existing = []) {
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
    for (const id of h.falsification_rule?.necessary_prediction_ids || []) if (!predictions.some(p => p.prediction_id === id)) throw decisionError('invalid_reference', `necessary prediction ${id}`);
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
