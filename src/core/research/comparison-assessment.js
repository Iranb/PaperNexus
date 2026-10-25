import { isDeepStrictEqual } from 'node:util';
import { decisionError } from './decision-contracts.js';
import { attemptKey, latestRuns } from './decision-store.js';

export function referenceProtocol(candidate, reference, fields = []) {
  const unknown = [], mismatches = [];
  for (const field of fields) {
    if (candidate?.[field] === undefined || reference?.[field] === undefined) unknown.push(field);
    else if (!isDeepStrictEqual(candidate[field], reference[field])) mismatches.push(field);
  }
  if (!fields.length) unknown.push('required_protocol_fields');
  return { status: mismatches.length ? 'mismatch' : unknown.length ? 'unknown' : 'matched', unknown, mismatches };
}

export function comparisonDependencyChanges(run, state, currentEvidence = state.evidence_snapshots) {
  const current = new Set(latestRuns(state.runs).map(r => r.record_id));
  return (run.verification?.comparisons || []).flatMap(ref => {
    if (ref.record_id && !current.has(ref.record_id)) return [`superseded_reference:${ref.record_id}`];
    const saved = ref.evidence_snapshot;
    if (saved && !isDeepStrictEqual(saved, currentEvidence.find(s => s.key === saved.key))) return [`changed_comparator:${ref.comparison_id}`];
    return [];
  });
}

export function validateComparisons(run, action, references) {
  if (!run.comparisons) return;
  if (!action.evaluation_plan) throw decisionError('invalid_reference', 'comparisons require a registered evaluation_plan');
  const ids = new Set(), candidateValues = new Map();
  for (const comparison of run.comparisons) {
    if (ids.has(comparison.comparison_id)) throw decisionError('invalid_input', 'duplicate comparison_id');
    ids.add(comparison.comparison_id);
    const planned = action.evaluation_plan.comparators.find(c => c.comparison_id === comparison.comparison_id);
    if (!planned || !isDeepStrictEqual(planned.reference, comparison.reference)) throw decisionError('invalid_reference', 'comparison reference differs from the registered comparator');
    if ((planned.role === 'paper') !== (comparison.kind === 'paper_reported') || (planned.role === 'paper') !== (comparison.reference.kind === 'paper_report')) throw decisionError('invalid_input', 'paper comparator kind mismatch');
    if (comparison.protocol && !isDeepStrictEqual(comparison.protocol, run.protocol)) throw decisionError('invalid_input', 'comparison candidate protocol differs from run protocol');
    const reference = references.find(r => r.comparison_id === comparison.comparison_id);
    const quantities = new Set();
    for (const m of comparison.measurements) {
      const key = JSON.stringify([m.quantity, m.unit]);
      if (quantities.has(key)) throw decisionError('invalid_input', 'duplicate comparison measurement');
      quantities.add(key);
      if (!m.value_kind) throw decisionError('invalid_input', 'comparison measurement requires value_kind');
      if (!action.evaluation_plan.outcomes.some(o => o.quantity === m.quantity && o.unit === m.unit && o.comparison_ids.includes(comparison.comparison_id))) throw decisionError('invalid_reference', 'measurement outside evaluation_plan');
      if (m.value_kind !== 'difference') continue;
      if (!Number.isFinite(m.candidate_estimate) || !Number.isFinite(m.reference_estimate) || !m.value_unit) throw decisionError('invalid_input', 'difference requires candidate_estimate, reference_estimate and value_unit');
      if (m.unit !== m.value_unit && !(m.value_unit === 'percent' && ['pp', 'percentage_points'].includes(m.unit))) throw decisionError('invalid_input', 'unsupported difference units');
      if (Math.abs(m.estimate - (m.candidate_estimate - m.reference_estimate)) > 1e-9) throw decisionError('invalid_input', 'difference must equal candidate minus reference');
      const absolute = reference?.measurements?.find(r => r.quantity === m.quantity && r.unit === m.value_unit && r.value_kind !== 'difference');
      if (absolute && absolute.estimate !== m.reference_estimate) throw decisionError('invalid_input', 'reference estimate differs from referenced measurement');
      const candidateKey = JSON.stringify([m.quantity, m.value_unit]);
      if (candidateValues.has(candidateKey) && candidateValues.get(candidateKey) !== m.candidate_estimate) throw decisionError('invalid_input', 'same run has conflicting candidate estimates');
      candidateValues.set(candidateKey, m.candidate_estimate);
    }
  }
}

export function comparisonViews(run, action) {
  return (run.comparisons || []).map(c => {
    const planned = action.evaluation_plan?.comparators.find(p => p.comparison_id === c.comparison_id);
    const reference = run.verification?.comparisons?.find(r => r.comparison_id === c.comparison_id);
    const protocol = referenceProtocol(run.protocol, reference?.protocol, planned?.required_protocol_fields);
    const measurementsResolved = c.measurements.every(m => m.value_kind === 'difference' && reference?.measurements?.some(r =>
      r.quantity === m.quantity && r.unit === m.value_unit && r.value_kind !== 'difference' && Number.isFinite(r.estimate) && r.estimate === m.reference_estimate));
    const verified = reference?.admitted === true && reference?.resolved === true && measurementsResolved;
    const matched = protocol.status === 'matched' && verified;
    return { ...c, role: planned?.role, reference_snapshot: reference || null, protocol_alignment: protocol,
      reference_verified: verified, matched,
      label: c.kind === 'paper_reported' ? matched ? 'vs paper-reported baseline' : 'paper-report comparison not established'
        : c.kind === 'matched_reproduced' && matched ? 'vs matched reproduced baseline' : 'vs reproduced baseline' };
  });
}

export function selectComparisonMeasurement(run, action, prediction) {
  if (!run.comparisons) return { measurement: run.measurements?.find(m => m.quantity === prediction.quantity && m.unit === prediction.unit), reasons: [] };
  const eligible = comparisonViews(run, action).filter(c => !prediction.comparison_id || c.comparison_id === prediction.comparison_id)
    .flatMap(c => c.measurements.filter(m => m.quantity === prediction.quantity && m.unit === prediction.unit).map(measurement => ({ comparison: c, measurement })));
  if (eligible.length !== 1) return { reasons: [eligible.length ? 'ambiguous_comparison' : 'missing_comparison_measurement'] };
  const selected = eligible[0];
  return { ...selected, reasons: selected.comparison.matched ? [] : ['comparison_reference_not_matched'] };
}

export function inferenceValidity(measurement, target, runs = []) {
  if (!target) return { status: 'unknown', inference_target: measurement?.uncertainty?.inference_target || null, reason_codes: ['inference_target_not_registered'] };
  const u = measurement?.uncertainty;
  const reasons = [];
  if (u?.inference_target !== target) reasons.push('inference_target_mismatch');
  const refs = u?.independent_run_refs || [];
  if (target === 'training_procedure') {
    const resolved = refs.map(id => latestRuns(runs).find(r => r.record_id === id));
    const identities = new Set(resolved.filter(Boolean).map(attemptKey));
    const groups = new Set(resolved.filter(Boolean).map(r => r.independent_group).filter(Boolean));
    if (refs.length < 2 || identities.size !== refs.length || groups.size !== refs.length
      || resolved.some(r => !r || r.status !== 'completed' || !['external_measured', 'synthetic_fixture'].includes(r.evidence_origin)
        || !['manifest_verified', 'synthetic_fixture'].includes(r.verification?.status))
      || u?.unit_count !== identities.size || !['seed', 'training_run'].includes(u?.independent_unit)) reasons.push('independent_training_runs_not_established');
  }
  return { status: reasons.length ? 'insufficient' : 'supported', inference_target: target, independent_run_refs: refs, reason_codes: reasons };
}

export function confirmatoryAnalysis(action, run, comparisonId, quantity) {
  const analysis = run.analysis;
  return Boolean(analysis && isDeepStrictEqual(analysis, action.analysis) && run.prospectivity === 'registered_before_run'
    && ['manifest_verified', 'synthetic_fixture'].includes(run.verification?.status)
    && ['fixed_final', 'sequential_adjusted'].includes(analysis.look_policy)
    && (analysis.look_policy !== 'sequential_adjusted' || analysis.adjustment_ref)
    && (analysis.multiplicity === 'single_primary'
      ? analysis.primary_comparison_id === comparisonId && analysis.primary_outcome === quantity
      : analysis.multiplicity === 'adjusted' && analysis.adjustment_ref && analysis.family?.some(f => f.comparison_id === comparisonId && f.quantity === quantity)));
}

export function assessComparisons(action, run, runs = []) {
  const plan = action.evaluation_plan;
  if (!plan || !run.comparisons) return { status: 'not_assessed', run_record_id: run.record_id, comparisons: [], limitations: ['no_multi_comparison_plan'] };
  const views = comparisonViews(run, action);
  const rows = plan.outcomes.flatMap(outcome => outcome.comparison_ids.map(comparisonId => {
    const comparison = views.find(c => c.comparison_id === comparisonId);
    const m = comparison?.measurements.find(m => m.quantity === outcome.quantity && m.unit === outcome.unit);
    const sign = outcome.direction === 'higher' ? 1 : -1;
    const estimate = m && m.value_kind === 'difference' ? sign * m.estimate : null;
    const threshold = outcome.role === 'guardrail' ? -(outcome.max_regression ?? 0) : outcome.minimum_effect ?? 0;
    const interval = m?.interval;
    const validInterval = interval && interval.lower <= m.estimate && m.estimate <= interval.upper;
    const lower = validInterval ? sign === 1 ? interval.lower : -interval.upper : null;
    const upper = validInterval ? sign === 1 ? interval.upper : -interval.lower : null;
    const inference = inferenceValidity(m, plan.inference_target, runs);
    const uncertainty = m?.uncertainty;
    const reviewed = uncertainty?.review?.status === 'reviewed' && uncertainty.review.reviewer && uncertainty.review.reference
      && uncertainty.method && uncertainty.level > 0 && uncertainty.level < 1 && uncertainty.calculation_ref && uncertainty.independent_unit && uncertainty.unit_count > 0;
    const requiredChecks = (action.validity_checks || []).every(check => run.intervention_checks?.some(c => c.check === check && c.passed));
    const candidateProtocol = referenceProtocol(run.protocol, action.protocol, action.required_protocol_fields);
    const supported = run.status === 'completed' && comparison?.matched && estimate !== null && validInterval && reviewed && requiredChecks
      && action.design_status === 'testable' && candidateProtocol.status === 'matched' && inference.status === 'supported'
      && interval.upper - interval.lower <= action.precision?.max_interval_width
      && confirmatoryAnalysis(action, run, comparisonId, outcome.quantity);
    return { comparison_id: comparisonId, role: comparison?.role || plan.comparators.find(c => c.comparison_id === comparisonId)?.role,
      quantity: outcome.quantity, unit: outcome.unit, outcome_role: outcome.role, direction: outcome.direction,
      measurement_id: `${run.record_id}/${comparisonId}/${outcome.quantity}/${outcome.unit}`, measurement: m || null,
      descriptive_result: estimate === null ? 'unknown' : estimate >= threshold ? 'meets_target' : 'below_target',
      result: !supported ? 'inconclusive' : lower >= threshold ? 'meets_target' : upper < threshold ? 'below_target' : 'inconclusive',
      confirmatory: Boolean(supported), inference, label: comparison?.label || 'comparison not established',
      protocol_alignment: comparison?.protocol_alignment || { status: 'unknown' } };
  }));
  const primary = rows.filter(r => r.outcome_role === 'primary'), guards = rows.filter(r => r.outcome_role === 'guardrail');
  const original = primary.filter(r => r.role === 'original'), controls = primary.filter(r => r.role === 'control');
  const partial = controls.some(r => r.descriptive_result === 'meets_target') && original.some(r => r.descriptive_result === 'below_target');
  const directedEffect = r => r.measurement?.value_kind === 'difference' ? r.measurement.estimate * (r.direction === 'higher' ? 1 : -1) : 0;
  const losses = rows.filter(r => r.outcome_role !== 'diagnostic' && directedEffect(r) < 0);
  const gains = rows.filter(r => r.outcome_role !== 'diagnostic' && directedEffect(r) > 0);
  const tradeoff = guards.some(r => r.result === 'below_target') || losses.some(l => gains.some(g => l.quantity !== g.quantity));
  const improved = original.length > 0 && original.every(r => r.result === 'meets_target') && guards.every(r => r.result === 'meets_target');
  return { status: tradeoff ? 'tradeoff' : partial ? 'partial_recovery' : improved ? 'improved_in_scope' : 'inconclusive',
    run_record_id: run.record_id, comparisons: rows, partial_recovery: partial,
    claim_basis: rows.filter(r => r.outcome_role !== 'diagnostic').map(r => r.measurement_id),
    inference_target: plan.inference_target || null,
    limitations: [...new Set([!improved && 'descriptive_changes_do_not_establish_improvement',
      ...rows.flatMap(r => r.inference.reason_codes), ...rows.filter(r => !r.confirmatory).map(r => `not_confirmatory:${r.comparison_id}/${r.quantity}`)].filter(Boolean))] };
}
