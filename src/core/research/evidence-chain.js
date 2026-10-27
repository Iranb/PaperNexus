export function buildEvidenceChain(hypothesis, rows = []) {
  const predictions = (hypothesis.predictions || []).map(prediction => {
    const observed = rows.filter(row => row.prediction_id === prediction.prediction_id && row.measurement);
    return { prediction_id: prediction.prediction_id, quantity: prediction.quantity, unit: prediction.unit,
      evidence_role: prediction.evidence_role || 'unspecified',
      status: observed.some(row => row.assessment_gate.valid) ? 'observed' : observed.length ? 'unassessable' : 'not_measured',
      observations: observed.map(row => ({ run_record_id: row.run_record_id, relation: row.relation, status: row.status,
        valid: row.assessment_gate.valid, confirmatory: row.assessment_gate.confirmatory,
        comparison_id: row.comparison_id, inference_target: row.inference?.inference_target || null })) };
  });
  const targets = predictions.filter(p => p.evidence_role === 'target');
  const proxyLinks = (hypothesis.predictions || []).flatMap(p => (p.proxy_for || []).map(targetId => {
    const proxy = predictions.find(item => item.prediction_id === p.prediction_id);
    const target = predictions.find(item => item.prediction_id === targetId);
    return { proxy_prediction_id: p.prediction_id, target_prediction_id: targetId,
      joint_run_record_ids: [...new Set(proxy.observations.filter(o => o.valid && target.observations.some(t => t.valid && t.run_record_id === o.run_record_id)).map(o => o.run_record_id))],
      inference_status: 'not_established' };
  }));
  const gap = (kind, predictionId, reason, nextStep) => ({ hypothesis_id: hypothesis.hypothesis_id,
    hypothesis_version: hypothesis.version, kind, prediction_id: predictionId, reason, next_step: nextStep });
  return { target_status: !targets.length ? 'not_registered' : targets.every(p => p.status === 'observed') ? 'observed'
      : targets.some(p => p.status === 'observed') ? 'partially_observed' : 'not_measured',
    predictions, proxy_links: proxyLinks,
    research_gaps: [
      ...targets.filter(p => p.status !== 'observed').map(p => gap('target_measurement', p.prediction_id, 'target_not_measured',
        'Measure the target under its registered protocol; a proxy result does not determine the target result.')),
      ...predictions.filter(p => proxyLinks.some(link => link.proxy_prediction_id === p.prediction_id)).map(p => gap('proxy_bridge', p.prediction_id,
        'proxy_target_link_unvalidated', 'Test whether changes in this proxy predict the declared target, with matched interventions and relevant independent units.'))
    ],
    boundary: 'Evidence roles are declared by the researcher. Proxy results and joint measurements do not establish a proxy-to-target relationship. Necessary predictions constrain the registered hypothesis, not unmeasured target performance.' };
}
