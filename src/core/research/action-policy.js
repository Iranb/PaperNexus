import { POLICY_VERSION, predictionRange, EXPERIMENT_TYPES } from './decision-contracts.js';
import { isDeepStrictEqual } from 'node:util';
import { attemptKey, latestRuns, latestVersions } from './decision-store.js';
import { scientificState, assessmentValidity } from './hypothesis-assessment.js';

export function resourceAmounts(cost = {}) {
  const amounts = {};
  for (const entry of cost.gpu_hours || []) amounts[`gpu_hours:${entry.resource}`] = entry.amount;
  for (const entry of cost.money || []) amounts[`money:${entry.currency}`] = entry.amount;
  for (const key of ['cpu_hours', 'provider_calls']) if (cost[key] !== undefined) amounts[key] = cost[key];
  return amounts;
}

export function budgetLimits(budget = {}) {
  const limits = {};
  for (const entry of budget.gpu_hours || []) limits[`gpu_hours:${entry.resource}`] = entry.limit;
  for (const entry of budget.money || []) limits[`money:${entry.currency}`] = entry.limit;
  for (const key of ['cpu_hours', 'provider_calls']) if (budget[key]) limits[key] = budget[key].limit;
  return limits;
}

export function budgetLedger(state, { exploration = false } = {}) {
  const limits = budgetLimits(exploration ? state.exploration_limit : state.budget);
  const attempts = latestRuns(state.runs).filter(run => !exploration || state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version)?.exploration);
  const keys = new Set(Object.keys(limits));
  for (const run of attempts) for (const key of Object.keys(resourceAmounts(run.actual_cost))) keys.add(key);
  const dimensions = Object.fromEntries([...keys].map(key => [key, { limit: limits[key] ?? null, spent: 0, committed: 0, uncertain: false, unknown_attempts: [] }]));
  for (const run of attempts) {
    const action = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
    const actual = resourceAmounts(run.actual_cost);
    const upper = resourceAmounts(action?.estimated_cost?.upper);
    const unresolved = ['queued', 'running', 'unknown_after_timeout'].includes(run.status) || run.cost_final !== true;
    for (const [key, balance] of Object.entries(dimensions)) {
      if (actual[key] !== undefined) balance.spent += actual[key];
      if (unresolved && upper[key] !== undefined) balance.committed += Math.max(0, upper[key] - (actual[key] || 0));
      else if ((unresolved && upper[key] === undefined) || actual[key] === undefined) {
        balance.uncertain = true;
        balance.unknown_attempts.push(attemptKey(run));
      }
    }
  }
  for (const balance of Object.values(dimensions)) balance.remaining = balance.limit === null || balance.uncertain ? null : balance.limit - balance.spent - balance.committed;
  return { dimensions, attempts: attempts.length,
    over_budget: Object.values(dimensions).some(b => b.limit !== null && b.spent + b.committed > b.limit),
    uncertain: Object.values(dimensions).some(b => b.uncertain), authority: 'Latest cumulative external attempt records; recommendations reserve no resources.' };
}

export function actionBudgetGate(action, state, ledger = budgetLedger(state)) {
  const reasons = [];
  const upper = resourceAmounts(action.estimated_cost?.upper);
  if (!action.estimated_cost) reasons.push('unknown_cost');
  for (const [key, balance] of Object.entries(ledger.dimensions)) {
    if (balance.limit === null) continue;
    if (upper[key] === undefined) reasons.push(`unknown_cost:${key}`);
    else if (upper[key] > 0 && balance.remaining === null) reasons.push(`uncertain_balance:${key}`);
    else if (upper[key] > Math.max(0, balance.remaining ?? 0)) reasons.push(`budget_exceeded:${key}`);
  }
  for (const [key, amount] of Object.entries(upper)) if (amount > 0 && ledger.dimensions[key]?.limit == null) reasons.push(`unspecified_resource_limit:${key}`);
  if (action.exploration) {
    if (!state.exploration_limit) reasons.push('exploration_limit_not_set');
    else {
      const exploration = budgetLedger(state, { exploration: true });
      const limits = budgetLimits(state.exploration_limit);
      if (state.exploration_limit.max_actions === undefined && !Object.keys(limits).length) reasons.push('exploration_limit_not_set');
      if (state.exploration_limit.max_actions !== undefined && exploration.attempts >= state.exploration_limit.max_actions) reasons.push('exploration_action_limit');
      for (const [key, limit] of Object.entries(limits)) {
        if (upper[key] === undefined || exploration.dimensions[key]?.remaining === null || upper[key] > Math.max(0, exploration.dimensions[key].remaining)) reasons.push(`exploration_budget:${key}`);
      }
    }
  }
  return { allowed: !reasons.length, reason_codes: reasons, estimated_upper: action.estimated_cost?.upper || null, based_on_revision: state.revision };
}

export function actionDiscrimination(action, hypotheses, conclusions) {
  const bound = (action.hypothesis_versions || []).map(ref => hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version)).filter(Boolean);
  const pairs = [], potential = [];
  for (let i = 0; i < bound.length; i++) for (let j = i + 1; j < bound.length; j++) {
    const a = bound[i], b = bound[j];
    if (!a.alternative_hypothesis_ids?.includes(b.hypothesis_id) && !b.alternative_hypothesis_ids?.includes(a.hypothesis_id)) continue;
    if ([a, b].some(h => conclusions.find(c => c.hypothesis_id === h.hypothesis_id && c.version === h.version)?.status === 'excluded_in_scope')) continue;
    for (const p of a.predictions) for (const q of b.predictions) {
      if (p.quantity !== q.quantity || p.unit !== q.unit || !action.measurements?.includes(p.quantity)
        || !action.prediction_ids?.includes(p.prediction_id) || !action.prediction_ids?.includes(q.prediction_id)) continue;
      const [alo, ahi] = predictionRange(p), [blo, bhi] = predictionRange(q);
      if (alo === blo && ahi === bhi) continue;
      const gap = Math.max(blo - ahi, alo - bhi);
      const entry = { hypotheses: [a.hypothesis_id, b.hypothesis_id], quantity: p.quantity, predictions: [p.prediction_id, q.prediction_id], separation: Number.isFinite(gap) ? Math.max(0, gap) : null };
      if (gap > 0 && action.precision?.max_interval_width <= gap) pairs.push(entry);
      else potential.push({ ...entry, required_precision: gap > 0 ? `interval width <= ${gap}` : 'Predictions overlap; identify a discriminating condition or measurement.' });
    }
  }
  return { distinguishes: pairs, potentially_discriminating: potential };
}

export function recommendNextAction(state, { actionIds, staleSourceKeys = [] } = {}) {
  const ledger = budgetLedger(state);
  const conclusions = scientificState(state, staleSourceKeys);
  const selected = latestVersions(state.actions, 'action_id').filter(a => !actionIds || actionIds.includes(a.action_id));
  const ids = new Set(selected.map(a => a.action_id));
  const allRuns = latestRuns(state.runs);
  const runs = allRuns.filter(r => ids.has(r.action_id));
  const base = { policy_version: POLICY_VERSION, based_on_revision: state.revision, goal_phase: state.goal_phase,
    execution_authority: 'Recommendation only. The external executor owns admission, authorization and job state.',
    budget: ledger, scientific_state: conclusions, alternatives: [], blocked_actions: [],
    unmodeled_explanation: conclusions.length > 0 && conclusions.every(c => ['excluded_in_scope', 'weakened_in_scope'].includes(c.status)) };
  const unknown = runs.filter(r => r.status === 'unknown_after_timeout');
  if (unknown.length) return { ...base, decision: { kind: 'reconcile_run', run_record_ids: unknown.map(r => r.record_id), reason: 'Reconcile existing attempts with their executor before another submission.' } };
  const pending = runs.filter(r => ['queued', 'running'].includes(r.status));
  if (pending.length) return { ...base, decision: { kind: 'await_run', run_record_ids: pending.map(r => r.record_id), reason: 'An accepted attempt is still outstanding.' } };
  const unassessed = runs.filter(r => {
    if (r.status !== 'completed') return false;
    const bound = state.actions.find(a => a.action_id === r.action_id && a.version === r.action_version).hypothesis_versions || [];
    const assessed = state.assessments.filter(a => a.run_record_ids.includes(r.record_id) && assessmentValidity(a, state, staleSourceKeys).status === 'current').flatMap(a => a.hypothesis_versions);
    return !bound.every(h => assessed.some(item => item.hypothesis_id === h.hypothesis_id && item.version === h.version));
  });
  if (unassessed.length) return { ...base, decision: { kind: 'assess_results', run_record_ids: unassessed.map(r => r.record_id), reason: 'Assess the available result before choosing another experiment.' } };
  const candidates = [];
  const diagnosticHypotheses = new Set([
    ...runs.filter(r => r.status === 'failed').flatMap(r => state.actions.find(a => a.action_id === r.action_id && a.version === r.action_version).hypothesis_versions || []).map(h => h.hypothesis_id),
    ...conclusions.filter(c => ['unassessable', 'conflicted'].includes(c.status)).map(h => h.hypothesis_id)
  ]);
  for (const action of selected) {
    const blocked = [...action.missing_fields.map(k => `missing:${k}`)];
    const bound = (action.hypothesis_versions || []).map(ref => state.hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version));
    if (bound.some(h => h.design_status !== 'testable')) blocked.push('draft_hypothesis');
    const evidenceKeys = [...(action.evidence_keys || []), ...bound.flatMap(h => h.evidence_keys || [])];
    for (const key of evidenceKeys) {
      if (staleSourceKeys.includes(key)) blocked.push('stale_dependencies');
      else if (!state.evidence_snapshots.find(s => s.key === key)?.admitted) blocked.push('needs_evidence');
    }
    if (runs.some(r => r.action_id === action.action_id && r.action_version === action.version)) blocked.push('attempt_already_recorded');
    for (const prerequisite of action.prerequisites || []) {
      const requiredVersion = prerequisite.hypothesis_version ?? bound.find(h => h.hypothesis_id === prerequisite.hypothesis_id)?.version
        ?? latestVersions(state.hypotheses, 'hypothesis_id').find(h => h.hypothesis_id === prerequisite.hypothesis_id)?.version;
      if (prerequisite.hypothesis_id && !conclusions.some(c => c.hypothesis_id === prerequisite.hypothesis_id && c.version === requiredVersion && c.status === prerequisite.status)) blocked.push(`unmet_hypothesis:${prerequisite.hypothesis_id}`);
      if (prerequisite.action_id && !allRuns.some(r => r.action_id === prerequisite.action_id && r.status === 'completed')) blocked.push(`unmet_action:${prerequisite.action_id}`);
    }
    const opportunity = state.opportunities.find(o => o.candidate_id === action.candidate_id);
    if (opportunity && opportunity.status !== 'active') blocked.push(`opportunity_${opportunity.status}`);
    const budgetGate = actionBudgetGate(action, state, ledger);
    blocked.push(...budgetGate.reason_codes);
    const discrimination = actionDiscrimination(action, state.hypotheses, conclusions);
    const diagnostic = ['read_source', 'search_literature', 'inspect_code', 'profile_cost', 'repair_baseline', 'diagnostic'].includes(action.type);
    if (base.unmodeled_explanation && !diagnostic) blocked.push('unmodeled_explanation_requires_revision');
    if (action.type === 'scale_test' && !bound.some(h => conclusions.some(c => c.hypothesis_id === h.hypothesis_id && c.version === h.version && c.status === 'supported_in_scope'))) blocked.push('mechanism_not_supported');
    if (state.goal_phase === 'mechanism_validation' && EXPERIMENT_TYPES.includes(action.type) && action.type !== 'replicate'
      && !discrimination.distinguishes.length && !discrimination.potentially_discriminating.length && action.type !== 'scale_test') blocked.push('does_not_distinguish_explanations');
    if (blocked.length) { base.blocked_actions.push({ action_id: action.action_id, reason_codes: [...new Set(blocked)], budget_gate: budgetGate }); continue; }
    const priority = diagnostic && bound.some(h => diagnosticHypotheses.has(h.hypothesis_id)) ? 0 : discrimination.distinguishes.length ? 1
      : action.type === 'replicate' && bound.some(h => conclusions.some(c => c.hypothesis_id === h.hypothesis_id && c.version === h.version && ['supported_in_scope', 'conflicted'].includes(c.status))) ? 1
      : discrimination.potentially_discriminating.length ? 2 : diagnostic ? 3 : 4;
    candidates.push({ action, priority, ...discrimination, budget_gate: budgetGate, costs: resourceAmounts(action.estimated_cost.upper) });
  }
  for (const candidate of candidates) {
    candidate.dominated_by = candidates.filter(other => other !== candidate && other.priority <= candidate.priority
      && other.action.type === candidate.action.type
      && isDeepStrictEqual(other.action.prerequisites || [], candidate.action.prerequisites || [])
      && isDeepStrictEqual(other.action.hypothesis_versions, candidate.action.hypothesis_versions)
      && candidate.distinguishes.every(pair => other.distinguishes.some(p => JSON.stringify(p.hypotheses) === JSON.stringify(pair.hypotheses) && p.quantity === pair.quantity))
      && candidate.potentially_discriminating.every(pair => [...other.distinguishes, ...other.potentially_discriminating].some(p => JSON.stringify(p.hypotheses) === JSON.stringify(pair.hypotheses) && p.quantity === pair.quantity))
      && JSON.stringify(Object.keys(candidate.costs).sort()) === JSON.stringify(Object.keys(other.costs).sort())
      && Object.keys(candidate.costs).every(k => other.costs[k] <= candidate.costs[k])
      && (other.priority < candidate.priority || Object.keys(candidate.costs).some(k => other.costs[k] < candidate.costs[k])))
      .map(other => other.action.action_id);
  }
  const eligible = candidates.filter(c => !c.dominated_by.length).sort((a, b) => a.priority - b.priority || a.action.action_id.localeCompare(b.action.action_id));
  const chosen = eligible[0];
  if (!chosen) return { ...base, decision: { kind: base.blocked_actions.some(a => a.reason_codes.some(r => /unknown|missing|stale|needs_evidence|draft|uncertain/.test(r))) ? 'needs_input' : 'stop',
    reason: base.unmodeled_explanation ? 'Revise explanations or measurements; none of the registered explanations accounts for the valid results.' : 'No registered action meets the evidence, design and budget conditions.',
    next_step: base.blocked_actions.some(a => a.reason_codes.some(r => r.startsWith('unknown_cost'))) ? 'Register a bounded profile_cost action.' : 'Resolve the listed gaps or park this direction.' } };
  return { ...base, decision: { kind: 'execute_action', action_id: chosen.action.action_id, action_version: chosen.action.version,
    hypothesis_ids: chosen.action.hypothesis_versions.map(ref => ref.hypothesis_id),
    reason: chosen.distinguishes.length ? 'This action separates registered competing predictions at the planned precision.'
      : chosen.potentially_discriminating.length ? 'This control can distinguish competing predictions; the remaining precision requirement is explicit.' : `The ${chosen.action.type} action addresses the current prerequisites.`,
    action: chosen.action, distinguishes: chosen.distinguishes, potentially_discriminating: chosen.potentially_discriminating,
    result_branches: chosen.action.result_branches, stopping_rule: chosen.action.stopping_rule },
    budget_gate: chosen.budget_gate,
    recommendation_ref: { project: state.project, revision: state.revision, policy_version: POLICY_VERSION, goal_phase: state.goal_phase,
      action_id: chosen.action.action_id, action_version: chosen.action.version, scope_action_ids: actionIds || selected.map(a => a.action_id) },
    alternatives: candidates.filter(c => c !== chosen).map(c => ({ action_id: c.action.action_id, dominated_by: c.dominated_by, estimated_upper: c.action.estimated_cost.upper, distinguishes: c.distinguishes,
      reason: c.dominated_by.length ? 'Same prerequisites and discrimination needs are covered at no greater cost.' : 'A feasible alternative; resource dimensions are not converted into an invented utility.' })) };
}
