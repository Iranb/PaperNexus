import { isDeepStrictEqual } from 'node:util';
import { collectEntityEvidence, measurementReferences } from './decision-contracts.js';
import { evidenceKey } from './decision-evidence.js';
import { latestRuns, latestVersions } from './decision-store.js';

const hypothesisKey = h => `${h.hypothesis_id}@${h.version ?? h.hypothesis_version}`;
const sameComponent = (a, b) => a.hypothesis_id === b.hypothesis_id && a.hypothesis_version === b.hypothesis_version && a.component_id === b.component_id;
const distinctRefs = refs => [...new Map(refs.map(ref => [evidenceKey(ref), ref])).values()];
const sortRecords = values => [...(values || [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function predictionBasis(prediction, snapshots = [], staleSourceKeys = []) {
  const basis = prediction.basis;
  const refs = basis?.evidence_refs || [];
  const unavailable = refs.filter(ref => !snapshots.some(s => s.key === evidenceKey(ref) && s.admitted)
    || ['agent_inferred', 'search_absence'].includes(ref.evidence_origin));
  const stale = refs.filter(ref => staleSourceKeys.includes(evidenceKey(ref)));
  const status = !basis ? 'missing' : basis.kind === 'assumption' ? 'assumed' : stale.length ? 'stale'
    : !basis.rationale?.trim() || !refs.length || unavailable.length ? 'missing' : 'documented';
  return { status, kind: basis?.kind || null, rationale: basis?.rationale || null, evidence_refs: refs,
    unavailable_refs: unavailable, stale_refs: stale,
    boundary: 'A documented prediction records its quantitative rationale and available sources; it is not an independently verified derivation.' };
}

export function buildMechanismAnalysis(state, { currentEvidence = state.evidence_snapshots, staleSourceKeys = [], hypothesisVersions, conclusions = [] } = {}) {
  const snapshots = currentEvidence;
  const hypotheses = hypothesisVersions ? state.hypotheses.filter(h => hypothesisVersions.some(ref => ref.hypothesis_id === h.hypothesis_id && ref.version === h.version))
    : latestVersions(state.hypotheses, 'hypothesis_id');
  const sourceKeys = new Set(hypotheses.flatMap(collectEntityEvidence).map(evidenceKey));
  const contexts = snapshots.filter(s => sourceKeys.has(s.key) && s.ref.evidence_origin === 'paper_reported').map(s => ({
    ...(s.mechanism_context || { nodes: [], relations: [], paths: [], coverage: { truncated: false } }),
    source_ref: s.ref, status: staleSourceKeys.includes(s.key) ? 'stale' : s.admitted ? 'current' : 'unavailable'
  }));
  const available = ref => !staleSourceKeys.includes(evidenceKey(ref)) && snapshots.some(s => s.key === evidenceKey(ref) && s.admitted)
    && !['agent_inferred', 'search_absence'].includes(ref.evidence_origin);
  const currentRunIds = new Set(latestRuns(state.runs).map(r => r.record_id));
  const measurements = measurementReferences(state.runs);
  const records = hypotheses.map(h => {
    const key = hypothesisKey(h), components = h.mechanism_evidence?.components || [];
    const stale = h.evidence_keys?.some(k => staleSourceKeys.includes(k)) || h.run_record_ids?.some(id => !currentRunIds.has(id));
    const componentBindings = components.map(c => ({ component_id: c.id, graph_node_id: c.graph_node_id || null,
      status: !c.graph_node_id ? 'not_linked' : contexts.some(s => s.status === 'current' && s.nodes.some(n => n.id === c.graph_node_id)
        && c.evidence_refs.some(ref => evidenceKey(ref) === evidenceKey(s.source_ref))) ? 'linked' : 'unverified' }));
    const links = (h.mechanism_evidence?.links || []).map((link, index) => {
      const expectedOrigin = { source_supported: 'paper_reported', code_observed: 'code_inspected', measured_association: 'external_measured' }[link.status];
      const citedContexts = contexts.filter(s => link.evidence_refs.some(ref => evidenceKey(ref) === evidenceKey(s.source_ref)));
      const graphFrom = components.find(c => c.id === link.from)?.graph_node_id;
      const graphTo = components.find(c => c.id === link.to)?.graph_node_id;
      const related = citedContexts.filter(s => s.status === 'current').flatMap(s => s.relations)
        .filter(r => link.graph_relation_ids?.includes(r.relationship_id) && r.status === 'source_anchored');
      const connected = new Set(graphFrom ? [graphFrom] : []);
      for (let i = 0; i < related.length; i++) for (const r of related) if (connected.has(r.from)) connected.add(r.to);
      const missingRelations = (link.graph_relation_ids || []).filter(id => !citedContexts.some(s => s.status === 'current'
        && s.relations.some(r => r.relationship_id === id && r.status === 'source_anchored')));
      const reasons = [stale && 'stale_dependencies',
        link.status !== 'hypothesized' && (!link.evidence_refs.length || !link.evidence_refs.every(available)) && 'source_not_available',
        expectedOrigin && !link.evidence_refs.some(ref => [expectedOrigin, 'synthetic_fixture'].includes(ref.evidence_origin)) && 'evidence_origin_mismatch',
        missingRelations.length && 'graph_relation_unverified',
        graphFrom && graphTo && link.graph_relation_ids?.length && !connected.has(graphTo) && 'graph_endpoints_not_connected'].filter(Boolean);
      return { ...link, link_id: `${key}/link:${index}`, evidence_status: reasons.length ? 'unverified' : 'current',
        reason_codes: reasons, missing_graph_relation_ids: missingRelations };
    });
    const paths = [], gaps = [], reachable = new Map();
    let truncated = false;
    for (const p of h.predictions || []) {
      const ancestors = new Set([p.prediction_id]), pending = [p.prediction_id];
      while (pending.length) {
        const node = pending.pop();
        for (const link of links.filter(l => l.to === node)) if (!ancestors.has(link.from)) { ancestors.add(link.from); pending.push(link.from); }
      }
      reachable.set(p.prediction_id, ancestors);
      const basis = predictionBasis(p, snapshots, staleSourceKeys);
      if (basis.status !== 'documented') gaps.push({ hypothesis_id: h.hypothesis_id, hypothesis_version: h.version,
        kind: 'prediction_basis', prediction_id: p.prediction_id, reason: `prediction_basis_${basis.status}`,
        next_step: 'Record the quantitative rationale and its source in a new hypothesis version, or keep this prediction explicitly exploratory.' });
      let expansions = 0;
      for (const root of components) {
        if (expansions >= 256 || paths.filter(path => path.prediction_id === p.prediction_id).length >= 24) { truncated = true; break; }
        if (!root.evidence_refs.length) continue;
        const queue = [{ node: root.id, links: [], visited: [root.id] }];
        while (queue.length) {
          const item = queue.shift();
          if (++expansions > 256 || item.links.length >= 6 || paths.filter(path => path.prediction_id === p.prediction_id).length >= 24) { truncated = true; break; }
          for (const link of links.filter(l => l.from === item.node && !item.visited.includes(l.to))) {
            if (paths.filter(path => path.prediction_id === p.prediction_id).length >= 24) { truncated = true; break; }
            const chain = [...item.links, link];
            if (link.to === p.prediction_id) {
              const componentIds = [...new Set(chain.flatMap(l => [l.from, l.to]).filter(id => components.some(c => c.id === id)))];
              const current = !stale && root.evidence_refs.every(available) && chain.every(l => l.evidence_status === 'current')
                && componentBindings.filter(c => componentIds.includes(c.component_id)).every(c => c.status !== 'unverified');
              paths.push({ path_id: `${key}/path:${paths.length}`, prediction_id: p.prediction_id,
                component_ids: componentIds, measurement_ids: [...new Set(chain.flatMap(l => [l.from, l.to]).filter(id => measurements.some(m => m.id === id)))], link_ids: chain.map(l => l.link_id),
                graph_relation_ids: [...new Set(chain.flatMap(l => l.graph_relation_ids || []))],
                required_controls: [...new Set(chain.flatMap(l => l.required_controls || []))],
                evidence_refs: distinctRefs([...root.evidence_refs, ...chain.flatMap(l => l.evidence_refs)]),
                status: current ? 'source_backed_hypothesis' : 'unverified' });
            } else if (components.some(c => c.id === link.to) || measurements.some(m => m.id === link.to)) {
              if (queue.length + expansions >= 256) truncated = true;
              else queue.push({ node: link.to, links: chain, visited: [...item.visited, link.to] });
            }
          }
        }
      }
      if (components.length && !paths.some(path => path.prediction_id === p.prediction_id && path.status === 'source_backed_hypothesis')) gaps.push({
        hypothesis_id: h.hypothesis_id, hypothesis_version: h.version, kind: 'path', prediction_id: p.prediction_id,
        reason: stale ? 'stale_dependencies' : 'mechanism_path_unverified', next_step: 'Connect a current source or code observation to this prediction and inspect the unresolved relation references.' });
    }
    const required = [...new Set(links.flatMap(l => l.required_controls || []))].map(id => ({ hypothesis_id: h.hypothesis_id,
      hypothesis_version: h.version, component_id: id,
      prediction_ids: (h.predictions || []).filter(p => links.some(l => l.required_controls?.includes(id) && reachable.get(p.prediction_id).has(l.to))).map(p => p.prediction_id),
      statement: components.find(c => c.id === id)?.statement,
      link_ids: links.filter(l => l.required_controls?.includes(id)).map(l => l.link_id),
      evidence_refs: distinctRefs([...(components.find(c => c.id === id)?.evidence_refs || []), ...links.filter(l => l.required_controls?.includes(id)).flatMap(l => l.evidence_refs)]) }));
    const rows = conclusions.find(c => c.hypothesis_id === h.hypothesis_id && c.version === h.version)?.rows || [];
    return { hypothesis_id: h.hypothesis_id, version: h.version, statement: h.statement, scope: h.scope,
      alternative_hypothesis_ids: h.alternative_hypothesis_ids || [], status: stale ? 'stale' : 'current',
      components, component_bindings: componentBindings, links, paths, control_requirements: required,
      predictions: (h.predictions || []).map(p => ({ prediction_id: p.prediction_id, quantity: p.quantity, unit: p.unit,
        comparison_id: p.comparison_id || null, expected: p.expected, basis: predictionBasis(p, snapshots, staleSourceKeys),
        observations: rows.filter(r => r.prediction_id === p.prediction_id).map(r => ({ record_id: r.run_record_id, relation: r.relation,
          status: r.status, scope: r.scope, confirmatory: r.assessment_gate?.confirmatory === true })) })),
      evidence_gaps: gaps, coverage: { max_path_length: 6, max_paths_per_prediction: 24, max_expansions_per_prediction: 256, truncated } };
  });
  return { version: 'mechanism-analysis-v1', based_on_revision: state.revision, hypotheses: records, source_context: contexts,
    evidence_gaps: records.flatMap(h => h.evidence_gaps),
    coverage: { hypotheses: records.length, truncated: records.some(h => h.coverage.truncated) || contexts.some(c => c.coverage.truncated) },
    limitations: ['Source-backed paths remain hypotheses, not causal identification.', 'Competing mechanisms can coexist; the registered alternatives need not be exhaustive.'] };
}

export function assessMechanismTest(action, analysis, { run } = {}) {
  const gaps = [], controls = [], paths = [], predictions = [];
  for (const ref of action.hypothesis_versions || []) {
    const h = analysis.hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version);
    if (!h) {
      gaps.push({ hypothesis_id: ref.hypothesis_id, hypothesis_version: ref.version, kind: 'path',
        reason: 'hypothesis_analysis_missing', next_step: 'Read mechanism evidence for this exact registered hypothesis version.' });
      continue;
    }
    const selected = h.predictions.filter(p => action.prediction_ids?.includes(p.prediction_id));
    predictions.push(...selected.map(p => ({ hypothesis_id: h.hypothesis_id, hypothesis_version: h.version, ...p })));
    gaps.push(...h.evidence_gaps.filter(g => selected.some(p => p.prediction_id === g.prediction_id)));
    const relevantPaths = h.paths.filter(path => selected.some(p => p.prediction_id === path.prediction_id));
    paths.push(...relevantPaths);
    for (const required of h.control_requirements.filter(c => selected.some(p => c.prediction_ids.includes(p.prediction_id)))) {
      const bound = action.controlled_components?.find(c => sameComponent(c, required));
      const check = bound && run?.intervention_checks?.find(c => c.check === bound.check);
      const status = !bound ? 'missing' : !action.validity_checks?.includes(bound.check) ? 'check_not_registered'
        : !run ? 'planned' : check?.passed === true ? 'passed' : 'not_verified';
      controls.push({ ...required, check: bound?.check || null, status });
      if (!['planned', 'passed'].includes(status)) gaps.push({ hypothesis_id: h.hypothesis_id, hypothesis_version: h.version,
        kind: 'control', component_id: required.component_id, reason: `required_control_${status}`,
        next_step: `Hold or match ${required.statement || required.component_id} and bind an operational check in a new action version.` });
    }
    for (const prediction of selected) if (h.components.length && !(action.intervention_components || [])
      .some(c => c.hypothesis_id === h.hypothesis_id && c.hypothesis_version === h.version && relevantPaths.some(p =>
        p.prediction_id === prediction.prediction_id && p.status === 'source_backed_hypothesis' && p.component_ids.includes(c.component_id)))) {
      gaps.push({ hypothesis_id: h.hypothesis_id, hypothesis_version: h.version, kind: 'path', prediction_id: prediction.prediction_id,
        reason: 'intervention_path_not_bound', next_step: 'Bind the changed component to a current source-backed path for this prediction.' });
    }
  }
  const reasonCodes = [...new Set(gaps.map(g => `${g.reason}:${g.hypothesis_id}@${g.hypothesis_version}/${g.prediction_id || g.component_id}`))];
  const pathInterventions = paths.map(path => {
    const changed = (action.intervention_components || []).filter(c => path.path_id.startsWith(`${c.hypothesis_id}@${c.hypothesis_version}/`));
    return { path_id: path.path_id, prediction_id: path.prediction_id,
      changed_components: changed.filter(c => path.component_ids.includes(c.component_id)),
      other_changed_components: changed.filter(c => !path.component_ids.includes(c.component_id)),
      required_controls: path.required_controls,
      attribution: changed.length > 1 ? 'joint_intervention; component effects require separate controls' : 'registered_intervention' };
  });
  return { status: reasonCodes.length ? 'needs_input' : 'ready', reason_codes: reasonCodes, evidence_gaps: gaps,
    predictions, paths, path_interventions: pathInterventions, control_requirements: controls,
    interpretation: paths.length ? 'source_backed_mechanism_design' : 'registered_prediction_design',
    boundary: 'Readiness describes the registered test and available evidence, not a verified causal explanation.' };
}

export function findReusableEvidence(action, state, conclusions = []) {
  if (action.type === 'replicate' || !action.intervention_components?.length) return [];
  const design = a => ({ type: a.type, protocol: a.protocol, hypothesis_versions: sortRecords(a.hypothesis_versions),
    prediction_ids: [...(a.prediction_ids || [])].sort(), intervention: a.intervention,
    intervention_components: sortRecords(a.intervention_components), controlled_components: sortRecords(a.controlled_components),
    held_constant: [...(a.held_constant || [])].sort(), measurements: [...(a.measurements || [])].sort(),
    required_protocol_fields: [...(a.required_protocol_fields || [])].sort(), validity_checks: [...(a.validity_checks || [])].sort(),
    evaluation_plan: a.evaluation_plan || null, precision: a.precision,
    analysis: a.analysis ? { ...a.analysis, analysis_set_id: null } : null, stopping_rule: a.stopping_rule });
  const expected = design(action);
  return latestRuns(state.runs).filter(run => {
    if (run.status !== 'completed' || !isDeepStrictEqual(run.protocol, action.protocol)) return false;
    const prior = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
    if (!prior || !isDeepStrictEqual(expected, design(prior))) return false;
    return (action.hypothesis_versions || []).every(ref => {
      const h = state.hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version);
      const rows = conclusions.find(c => c.hypothesis_id === ref.hypothesis_id && c.version === ref.version)?.rows || [];
      return h.predictions.filter(p => action.prediction_ids.includes(p.prediction_id)).every(p => rows.some(r => r.run_record_id === run.record_id
        && r.prediction_id === p.prediction_id && r.assessment_gate.valid && r.assessment_gate.confirmatory && ['compatible', 'inconsistent'].includes(r.relation)));
    });
  }).map(run => ({ record_id: run.record_id, action_id: run.action_id, action_version: run.action_version, scope: run.protocol,
    basis: 'same_registered_mechanism_controls_protocol_and_measurements', evidence_origin: run.evidence_origin,
    next_step: 'Inspect the existing assessment; register replicate when independent replication is the intended question.' }));
}
