import { assessMechanismTest, buildMechanismAnalysis } from './mechanism-analysis.js';
import { readDecisionState } from './decision-store.js';
import { inspectEvidence, changedEvidence, inspectComparisonReferences } from './decision-evidence.js';
import { buildProjectEvidence } from './project-evidence.js';
import { referenceProtocol } from './comparison-assessment.js';

export async function readProjectEvidence(rootPath, project, options = {}) {
  const state = await readDecisionState(rootPath, project);
  if (!state) return { state: null, view: { status: 'not_initialized', project, based_on_revision: 0 } };
  const current = await inspectEvidence(rootPath, state.evidence_snapshots.map(s => s.ref));
  const stale = changedEvidence(state.evidence_snapshots, current);
  return { state, view: buildProjectEvidence(state, { ...options, currentEvidence: current, staleSourceKeys: stale }) };
}

export function evaluateProjectAction(state, view, args) {
  const actions = state?.actions.filter(a => a.action_id === args.actionId) || [];
  const action = args.actionVersion ? actions.find(a => a.version === args.actionVersion) : actions.at(-1);
  const reasons = [];
  const mechanismTest = action ? assessMechanismTest(action, buildMechanismAnalysis(state, {
    hypothesisVersions: action.hypothesis_versions, staleSourceKeys: view.evidence_freshness?.stale_dependencies || [] })) : null;
  if (!state) reasons.push('project_not_initialized');
  if (!action) reasons.push('registered_action_not_found');
  if (action) {
    reasons.push(...action.missing_fields.map(f => `missing:${f}`));
    const hypotheses = action.hypothesis_versions.map(ref => state.hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version));
    if (!hypotheses.length || hypotheses.some(h => h.design_status !== 'testable')) reasons.push('explanations_not_testable');
    const keys = [...(action.evidence_keys || []), ...hypotheses.flatMap(h => h.evidence_keys || [])];
    if (!keys.length || keys.some(k => !state.evidence_snapshots.find(s => s.key === k)?.admitted)) reasons.push('source_not_admitted');
    if (keys.some(k => view.evidence_freshness.stale_dependencies.includes(k))) reasons.push('stale_dependencies');
    if (!action.estimated_cost?.upper) reasons.push('cost_basis_missing');
    if (!action.validity_checks?.length) reasons.push('validity_checks_missing');
    if (!action.prediction_ids?.length) reasons.push('measurable_predictions_missing');
    if (args.purpose === 'mechanism_diagnosis') {
      reasons.push(...(mechanismTest?.reason_codes || []));
      if (!action.intervention || !action.held_constant?.length || hypotheses.some(h => !h.control)) reasons.push('intervention_or_control_missing');
      if (!hypotheses.some(h => h.alternative_hypothesis_ids?.length)) reasons.push('competing_explanation_missing');
    } else {
      const plan = action.evaluation_plan;
      if (!plan?.comparators.some(c => c.role === 'original')) reasons.push('original_baseline_missing');
      if (!plan?.outcomes.some(o => o.role === 'primary')) reasons.push('primary_target_missing');
      if (!plan?.outcomes.some(o => o.role === 'guardrail')) reasons.push('guardrail_missing');
      if (!plan?.inference_target) reasons.push('inference_target_missing');
      if (!action.analysis?.primary_comparison_id) reasons.push('primary_comparison_missing');
    }
  }
  const observations = view.observations?.filter(o => o.action_id === action?.action_id && o.action_version === action?.version) || [];
  const status = observations.at(-1)?.comparisons.status || 'not_assessed';
  return { purpose: args.purpose, action_id: args.actionId, action_version: action?.version || args.actionVersion || null,
    task_gate: { status: reasons.length ? 'needs_input' : 'ready_for_design', reason_codes: [...new Set(reasons)], evidence_refs: action?.evidence_keys || [] },
    mechanism_test: mechanismTest, novelty_claim_allowed: false, performance_claim_status: status, project_evidence: view,
    next_step: reasons.length ? 'Resolve the named design or evidence gaps in a new registered action version.' : 'Use research_decision/recommend_next to select among registered actions; the external executor owns execution authorization.',
    execution_authority: 'Design readiness does not authorize execution.',
    limitations: ['This task gate does not perform a novelty audit or establish semantic equivalence with prior work.'] };
}

export async function evaluateProject(rootPath, args) {
  const { state, view } = await readProjectEvidence(rootPath, args.project, { limit: 50 });
  const result = evaluateProjectAction(state, view, args);
  const action = state?.actions.find(a => a.action_id === result.action_id && a.version === result.action_version);
  if (action?.evaluation_plan) {
    try {
      const references = await inspectComparisonReferences(rootPath, state, action, { comparisons: action.evaluation_plan.comparators.map(c => ({
        comparison_id: c.comparison_id, reference: c.reference, kind: c.role === 'paper' ? 'paper_reported' : 'reproduced', measurements: []
      })) }, refs => inspectEvidence(rootPath, refs));
      for (const reference of references) {
        const planned = action.evaluation_plan.comparators.find(c => c.comparison_id === reference.comparison_id);
        const alignment = referenceProtocol(action.protocol, reference.protocol, planned.required_protocol_fields);
        if (!reference.resolved || !reference.admitted) result.task_gate.reason_codes.push(`comparator_unverified:${reference.comparison_id}`);
        if (alignment.status !== 'matched') result.task_gate.reason_codes.push(`comparator_protocol_${alignment.status}:${reference.comparison_id}`);
      }
    } catch (error) {
      if (!['invalid_reference', 'invalid_input'].includes(error.code)) throw error;
      result.task_gate.reason_codes.push('comparator_reference_unavailable');
    }
    if (result.task_gate.reason_codes.length) {
      result.task_gate.status = 'needs_input';
      result.next_step = 'Resolve the named design or comparator evidence gaps in a new registered action version.';
    }
  }
  return result;
}
