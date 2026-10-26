import { isDeepStrictEqual } from 'node:util';
import { assessMechanismTest, predictionBasis } from './mechanism-analysis.js';
import { predictionRange } from './decision-contracts.js';
import { latestRuns } from './decision-store.js';
import { selectComparisonMeasurement, inferenceValidity } from './comparison-assessment.js';

export function compareProtocol(action, run) {
  const unknown = [], mismatches = [];
  for (const field of action.required_protocol_fields || []) {
    if (action.protocol?.[field] === undefined || run.protocol?.[field] === undefined) unknown.push(field);
    else if (!isDeepStrictEqual(action.protocol[field], run.protocol[field])) mismatches.push(field);
  }
  return { status: mismatches.length ? 'mismatch' : unknown.length ? 'unknown' : 'matched', unknown, mismatches };
}

export function comparisonLabel(run, protocol) {
  if (run.comparison?.kind === 'paper_reported') {
    return run.comparison.source_ref?.evidence_origin === 'paper_reported' && run.comparison.protocol_verified === true && protocol.status === 'matched'
      ? 'vs paper-reported baseline' : 'paper-report comparison not established';
  }
  return run.comparison?.kind === 'matched_reproduced' && protocol.status === 'matched' && run.baseline?.reproduced === true
    && run.comparison.protocol_verified === true && ['manifest_verified', 'synthetic_fixture'].includes(run.verification?.status)
    ? 'vs matched reproduced baseline' : run.comparison ? 'vs reproduced baseline' : 'paper-report comparison not established';
}

export function assessObservation(hypothesis, action, run, runs = [], { mechanismAnalysis, evidenceSnapshots = [] } = {}) {
  const mechanismTest = mechanismAnalysis ? assessMechanismTest({ ...action,
    hypothesis_versions: [{ hypothesis_id: hypothesis.hypothesis_id, version: hypothesis.version }] }, mechanismAnalysis, { run })
    : { status: 'needs_input', reason_codes: ['mechanism_analysis_unavailable'] };
  const protocol = compareProtocol(action, run);
  const reasons = [];
  if (run.status !== 'completed') reasons.push('run_not_completed');
  if (protocol.status !== 'matched') reasons.push(`protocol_${protocol.status}`);
  if (action.design_status !== 'testable') reasons.push('action_design_incomplete');
  if (hypothesis.design_status !== 'testable') reasons.push('hypothesis_design_incomplete');
  for (const [field, value] of Object.entries(hypothesis.scope || {})) {
    if (run.protocol?.[field] === undefined) reasons.push(`scope_unknown:${field}`);
    else if (!isDeepStrictEqual(run.protocol[field], value)) reasons.push(`scope_mismatch:${field}`);
  }
  if (run.baseline?.reproduced === false) reasons.push('baseline_not_reproduced');
  for (const check of action.validity_checks || []) {
    const observed = run.intervention_checks?.find(item => item.check === check);
    if (!observed) reasons.push(`missing_intervention_check:${check}`);
    else if (!observed.passed) reasons.push(`intervention_not_applied:${check}`);
  }
  const bound = action.hypothesis_versions?.some(ref => ref.hypothesis_id === hypothesis.hypothesis_id && ref.version === hypothesis.version);
  const prospectivity = bound ? run.prospectivity : 'retrospective';
  const analysis = run.analysis;
  const analysisMatches = analysis && action.analysis && isDeepStrictEqual(analysis, action.analysis);
  const plannedAnalysis = analysisMatches && ['fixed_final', 'sequential_adjusted'].includes(analysis.look_policy)
    && ['single_primary', 'adjusted'].includes(analysis.multiplicity)
    && ((analysis.look_policy !== 'sequential_adjusted' && analysis.multiplicity !== 'adjusted') || Boolean(analysis.adjustment_ref));
  const verified = ['manifest_verified', 'synthetic_fixture'].includes(run.verification?.status);
  const predictions = hypothesis.predictions.filter(p => action.measurements?.includes(p.quantity));
  return predictions.map(prediction => {
    const rowReasons = [...reasons];
    const basis = predictionBasis(prediction, evidenceSnapshots);
    const mechanismReady = basis.status === 'documented' && mechanismTest.status === 'ready';
    for (const [field, value] of Object.entries(prediction.conditions || {})) {
      if (!isDeepStrictEqual(run.protocol?.[field], value)) rowReasons.push(`prediction_condition_mismatch:${field}`);
    }
    const selected = selectComparisonMeasurement(run, action, prediction);
    const measurement = selected.measurement;
    rowReasons.push(...selected.reasons);
    const target = prediction.inference_target || action.evaluation_plan?.inference_target || action.precision?.inference_target;
    const inference = inferenceValidity(measurement, target, runs);
    const interval = measurement?.interval;
    let relation = 'inconclusive';
    if (!measurement) rowReasons.push('missing_measurement');
    else if (!interval) rowReasons.push('missing_uncertainty_interval');
    else if (interval.lower > interval.upper || measurement.estimate < interval.lower || measurement.estimate > interval.upper) rowReasons.push('invalid_measurement_interval');
    const valid = rowReasons.length === 0;
    if (valid) {
      const [lower, upper] = predictionRange(prediction);
      relation = interval.upper < lower || interval.lower > upper ? 'inconsistent'
        : interval.lower >= lower && interval.upper <= upper ? 'compatible' : 'inconclusive';
    }
    const uncertainty = measurement?.uncertainty;
    const uncertaintyReviewed = Boolean(uncertainty?.method && uncertainty.level > 0 && uncertainty.level < 1
      && uncertainty.independent_unit && uncertainty.unit_count > 0 && uncertainty.calculation_ref
      && uncertainty.review?.status === 'reviewed' && uncertainty.review.reviewer && uncertainty.review.reference);
    const precisionSufficient = interval && action.precision?.max_interval_width !== undefined
      && interval.upper - interval.lower <= action.precision.max_interval_width;
    const primary = analysis?.primary_outcome === prediction.quantity
      && (!run.comparisons || analysis.primary_comparison_id === selected.comparison?.comparison_id);
    const adjusted = analysis?.multiplicity === 'adjusted' && (!run.comparisons
      || analysis.family?.some(f => f.comparison_id === selected.comparison?.comparison_id && f.quantity === prediction.quantity));
    const confirmatory = mechanismReady && valid && verified && prospectivity === 'registered_before_run' && plannedAnalysis
      && action.prediction_ids?.includes(prediction.prediction_id)
      && (primary || adjusted) && uncertaintyReviewed && precisionSufficient && (!target || inference.status === 'supported');
    const necessary = hypothesis.falsification_rule?.necessary_prediction_ids?.includes(prediction.prediction_id) === true;
    let status = !valid ? 'unassessable' : relation === 'compatible' ? 'compatible' : 'inconclusive';
    if (relation === 'inconsistent' && mechanismReady && valid && verified && uncertaintyReviewed) status = confirmatory && necessary ? 'excluded_in_scope' : 'weakened_in_scope';
    return {
      hypothesis_id: hypothesis.hypothesis_id, hypothesis_version: hypothesis.version,
      prediction_id: prediction.prediction_id, quantity: prediction.quantity, unit: prediction.unit,
      expected: prediction.expected, scope: hypothesis.scope,
      run_record_id: run.record_id, action_id: action.action_id, action_version: action.version,
      evidence_origin: run.evidence_origin,
      independent_group: measurement?.independent_group || run.independent_group || JSON.stringify([run.executor_id, run.run_id, run.attempt_id]),
      relation, status: !mechanismReady && valid ? 'inconclusive' : status, measurement: measurement || null,
      comparison: selected.comparison?.label || comparisonLabel(run, protocol), comparison_id: selected.comparison?.comparison_id || null,
      inference, baseline_shortfall: run.baseline?.shortfall ?? null,
      assessment_gate: { valid, mechanism_test: mechanismTest, prediction_basis: basis, confirmatory: Boolean(confirmatory), necessary_prediction: necessary,
        protocol, prospectivity, uncertainty_reviewed: uncertaintyReviewed, precision_sufficient: Boolean(precisionSufficient),
        analysis_matches_plan: Boolean(analysisMatches), analysis_rule_valid: Boolean(plannedAnalysis),
        provenance: run.verification, reason_codes: rowReasons,
        limitations: [...mechanismTest.reason_codes, basis.status !== 'documented' && `prediction_basis_${basis.status}`, !verified && 'provided_measurements_unverified', prospectivity !== 'registered_before_run' && prospectivity,
          ...inference.reason_codes, !uncertaintyReviewed && 'uncertainty_not_reviewed', !precisionSufficient && 'insufficient_precision', !plannedAnalysis && 'exploratory_or_unverified_analysis',
          run.comparisons && !primary && !adjusted && 'secondary_comparison_not_confirmatory'].filter(Boolean)
      }
    };
  });
}

export function compareExplanations(rows, hypotheses) {
  return rows.map(row => {
    const hypothesis = hypotheses.find(h => h.hypothesis_id === row.hypothesis_id && h.version === row.hypothesis_version);
    const alternatives = rows.filter(other => other.run_record_id === row.run_record_id && other.quantity === row.quantity && other.unit === row.unit && other.comparison_id === row.comparison_id
      && hypothesis.alternative_hypothesis_ids?.includes(other.hypothesis_id));
    const compatible = alternatives.filter(other => other.relation === 'compatible' && other.assessment_gate.valid).map(other => other.hypothesis_id);
    const differentiated = alternatives.filter(other => other.relation === 'inconsistent' && other.assessment_gate.confirmatory).filter(other => {
      const [lo, hi] = predictionRange({ expected: row.expected });
      const [altLo, altHi] = predictionRange({ expected: other.expected });
      return !(lo <= altLo && hi >= altHi);
    }).map(other => other.hypothesis_id);
    return { ...row,
      status: row.relation === 'compatible' && row.assessment_gate.confirmatory && differentiated.length ? 'supported_in_scope' : row.status,
      compatible_alternatives: compatible, distinguished_from: differentiated,
      conclusion: row.assessment_gate.valid ? `Observation is ${row.relation} with ${row.prediction_id} within the registered scope.` : 'Resolve the listed execution, protocol or measurement gaps before scientific assessment.'
    };
  });
}

export function assessmentValidity(assessment, state, staleSourceKeys = []) {
  const current = new Set(latestRuns(state.runs).map(run => run.record_id));
  const reasons = assessment.run_record_ids.filter(id => !current.has(id)).map(id => `superseded_run:${id}`);
  for (const id of assessment.reference_record_ids || []) if (!current.has(id)) reasons.push(`superseded_reference:${id}`);
  for (const key of assessment.evidence_keys || []) {
    const saved = assessment.evidence_snapshots?.find(item => item.key === key);
    const now = state.evidence_snapshots.find(item => item.key === key);
    if (staleSourceKeys.includes(key) || !isDeepStrictEqual(saved, now)) reasons.push(`changed_source:${key}`);
  }
  return { status: reasons.length ? 'stale' : 'current', reasons };
}

export function scientificState(state, staleSourceKeys = []) {
  const uniqueRows = new Map();
  for (const assessment of state.assessments) {
    if (assessmentValidity(assessment, state, staleSourceKeys).status !== 'current') continue;
    for (const row of assessment.rows) {
      const hypothesis = state.hypotheses.find(h => h.hypothesis_id === row.hypothesis_id && h.version === row.hypothesis_version);
      const prediction = hypothesis?.predictions.find(p => p.prediction_id === row.prediction_id);
      const basis = prediction && predictionBasis(prediction, state.evidence_snapshots, staleSourceKeys);
      const current = basis?.status === 'documented' && row.assessment_gate.mechanism_test?.status === 'ready';
      const derived = current ? row : { ...row, status: row.assessment_gate.valid ? 'inconclusive' : 'unassessable', distinguished_from: [],
        conclusion: 'The observation remains available; mechanism assessment requires current prediction grounds and control checks.',
        assessment_gate: { ...row.assessment_gate, confirmatory: false, limitations: [...new Set([...(row.assessment_gate.limitations || []),
          basis?.status !== 'documented' ? `prediction_basis_${basis?.status || 'missing'}` : 'mechanism_reassessment_required'])] } };
      uniqueRows.set(JSON.stringify([row.run_record_id, row.hypothesis_id, row.hypothesis_version, row.prediction_id]), derived);
    }
  }
  const groups = new Map();
  for (const row of uniqueRows.values()) {
    const key = JSON.stringify([row.hypothesis_id, row.hypothesis_version]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const conflict = rows.some(a => rows.some(b => a.prediction_id === b.prediction_id && a.run_record_id !== b.run_record_id
      && [a, b].every(r => r.assessment_gate.mechanism_test?.status === 'ready' && r.assessment_gate.prediction_basis?.status === 'documented' && r.assessment_gate.valid && r.assessment_gate.uncertainty_reviewed
        && ['manifest_verified', 'synthetic_fixture'].includes(r.assessment_gate.provenance?.status))
      && a.relation === 'compatible' && b.relation === 'inconsistent'));
    const statuses = rows.map(row => row.status);
    const status = conflict ? 'conflicted' : ['excluded_in_scope', 'supported_in_scope', 'weakened_in_scope', 'inconclusive', 'compatible', 'unassessable'].find(s => statuses.includes(s));
    return { hypothesis_id: rows[0].hypothesis_id, version: rows[0].hypothesis_version, status,
      evidence_groups: [...new Set(rows.map(row => row.independent_group))], rows,
      scope: rows[0].scope, inference_boundary: 'Registered predictions and conditions only; explanations need not be exhaustive or mutually exclusive.' };
  });
}
