import { isDeepStrictEqual } from 'node:util';
import { decisionError } from './decision-contracts.js';
import { scientificState, assessmentValidity } from './hypothesis-assessment.js';
import { latestRuns } from './decision-store.js';
import { evidenceKey } from './decision-evidence.js';

export function revisitContext(state) {
  const validRunIds = new Set(state.assessments.filter(a => assessmentValidity(a, state).status === 'current')
    .flatMap(a => a.rows.filter(r => r.assessment_gate.valid).map(r => r.run_record_id)));
  return {
    evidence: state.evidence_snapshots.map(s => ({ source_id: s.ref.source_id, version: s.source_version, admitted: s.admitted })),
    hypotheses: scientificState(state).map(h => ({ hypothesis_id: h.hypothesis_id, version: h.version, status: h.status })),
    resolved_actions: latestRuns(state.runs).filter(r => r.status === 'completed' && validRunIds.has(r.record_id)).map(r => r.action_id),
    budget: state.budget, exploration_limit: state.exploration_limit || null
  };
}

export function mergeOpportunities(state, candidates) {
  for (const candidate of candidates) {
    const existing = state.opportunities.find(o => o.candidate_id === candidate.candidate_id);
    if (existing) Object.assign(existing, candidate, { status: existing.status, revisit_baseline: existing.revisit_baseline });
    else state.opportunities.push({ ...candidate, status: 'active', scientific_status: 'untested', reason: 'Candidate retained for evidence review.', revisit_conditions: candidate.revisit_conditions || [], revisit_baseline: revisitContext(state) });
  }
}

export function updateOpportunities(state, changes) {
  for (const change of changes) {
    if (change.op === 'set_budget') {
      if (!change.budget) throw decisionError('invalid_input', 'set_budget requires budget');
      state.budget = change.budget;
      if (change.exploration_limit) state.exploration_limit = change.exploration_limit;
    } else if (change.op === 'set_goal_phase') {
      if (!change.goal_phase) throw decisionError('invalid_input', 'set_goal_phase requires goal_phase');
      state.goal_phase = change.goal_phase;
    } else {
      if (change.candidate) mergeOpportunities(state, [change.candidate]);
      const opportunity = state.opportunities.find(o => o.candidate_id === change.candidate_id);
      if (!opportunity) throw decisionError('invalid_reference', 'Unknown candidate_id');
      if (change.op === 'set_revisit_conditions' && !change.revisit_conditions) throw decisionError('invalid_input', 'Missing revisit_conditions');
      if (change.revisit_conditions) opportunity.revisit_conditions = change.revisit_conditions;
      if (change.op !== 'set_revisit_conditions') opportunity.status = { park: 'parked', reactivate: 'active', retire: 'retired' }[change.op];
      opportunity.reason = change.reason;
      opportunity.last_evaluated_revision = state.revision;
      opportunity.revisit_baseline = revisitContext(state);
    }
    state.history.push({ revision: state.revision + 1, ...change });
  }
}

export function evaluateRevisitTriggers(state) {
  const now = revisitContext(state);
  const events = [];
  for (const opportunity of state.opportunities) {
    if (opportunity.status !== 'parked') continue;
    const before = opportunity.revisit_baseline;
    const triggers = (opportunity.revisit_conditions || []).filter(condition => {
      if (condition.type === 'new_admitted_evidence') return now.evidence.some(e => e.admitted && (!condition.source_id || e.source_id === condition.source_id)
        && !before.evidence.some(p => p.source_id === e.source_id && p.version === e.version && p.admitted));
      if (condition.type === 'dependency_resolved') return Boolean(condition.action_id && now.resolved_actions.includes(condition.action_id) && !before.resolved_actions.includes(condition.action_id));
      if (condition.type === 'competing_hypothesis_weakened') return now.hypotheses.some(h => h.hypothesis_id === condition.hypothesis_id
        && ['weakened_in_scope', 'excluded_in_scope'].includes(h.status) && !before.hypotheses.some(p => isDeepStrictEqual(p, h)));
      return condition.type === 'budget_or_resource_changed' && (!isDeepStrictEqual(now.budget, before.budget) || !isDeepStrictEqual(now.exploration_limit, before.exploration_limit));
    });
    if (triggers.length) {
      opportunity.status = 'active';
      opportunity.reason = 'A registered revisit condition changed; scientific support still requires assessment.';
      opportunity.revisit_baseline = now;
      const event = { candidate_id: opportunity.candidate_id, revision: state.revision + 1, triggers, status: 'needs_evaluation' };
      events.push(event);
      state.revisit_events.push(event);
    }
  }
  return events;
}

export function evidenceRequests(state) {
  return state.opportunities.filter(o => o.status !== 'retired').flatMap(opportunity => {
    const missing = (opportunity.evidence_refs || []).filter(ref => !state.evidence_snapshots.some(s => s.key === evidenceKey(ref) && s.admitted));
    const requests = [];
    if (missing.length || !opportunity.evidence_refs?.length) requests.push({
      candidate_id: opportunity.candidate_id, reason: 'Find an admitted source for this specific mechanism; sparse coverage is not a global research gap.', missing_sources: missing,
      tool_call: { tool: 'literature_review', arguments: { operation: 'search', query: [state.objective, opportunity.mechanism || opportunity.subproblem].filter(Boolean).join(' '), limit: 5 } }
    });
    if (opportunity.bridge_evidence === false) requests.push({ candidate_id: opportunity.candidate_id,
      reason: 'Check which assumptions allow this mechanism to transfer to the target problem.',
      tool_call: { tool: 'idea_generation', arguments: { operation: 'evaluate', query: state.objective, candidateMechanism: opportunity.mechanism || opportunity.minimum_next_step || opportunity.candidate_id } } });
    return requests;
  });
}
