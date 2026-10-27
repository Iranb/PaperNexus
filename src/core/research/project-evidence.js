import { buildMechanismAnalysis } from './mechanism-analysis.js';
import { latestRuns, latestVersions } from './decision-store.js';
import { assessmentValidity, scientificState } from './hypothesis-assessment.js';
import { budgetLedger } from './action-policy.js';
import { assessComparisons, comparisonDependencyChanges } from './comparison-assessment.js';
import { collectEntityEvidence, measurementReferences } from './decision-contracts.js';
import { evidenceKey } from './decision-evidence.js';

export function buildProjectEvidence(state, { query, limit = 10, includeHistory = false, staleSourceKeys = [], currentEvidence = [] } = {}) {
  const currentRuns = latestRuns(state.runs);
  const open = scientificState(state, staleSourceKeys);
  const currentIds = new Set(currentRuns.map(r => r.record_id));
  const validity = state.assessments.map(a => ({ assessment_id: a.assessment_id, ...assessmentValidity(a, state, staleSourceKeys) }));
  const validAssessments = state.assessments.filter(a => validity.find(v => v.assessment_id === a.assessment_id).status === 'current');
  const hypotheses = includeHistory ? state.hypotheses : latestVersions(state.hypotheses, 'hypothesis_id');
  const terms = query?.toLowerCase().split(/\s+/).filter(Boolean) || [];
  const matches = value => !terms.length || terms.some(term => JSON.stringify(value).toLowerCase().includes(term));
  const selectedHypotheses = hypotheses.filter(matches);
  const actionMatches = action => matches(action) || action?.hypothesis_versions?.some(ref => selectedHypotheses.some(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version));
  const allObservations = (includeHistory ? state.runs : currentRuns).map(run => {
    const action = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
    const references = (run.comparisons || []).filter(c => c.reference.kind === 'run_record').map(c => c.reference.record_id);
    const dependencies = [run, action, ...(action?.hypothesis_versions || []).map(ref => state.hypotheses.find(h => h.hypothesis_id === ref.hypothesis_id && h.version === ref.version))].filter(Boolean);
    const stale = dependencies.some(e => e.evidence_keys?.some(k => staleSourceKeys.includes(k)) || e.run_record_ids?.some(id => !currentIds.has(id))) || references.some(id => !currentIds.has(id))
      || comparisonDependencyChanges(run, state, currentEvidence.length ? currentEvidence : state.evidence_snapshots).length > 0;
    const assessments = validAssessments.filter(a => a.run_record_ids.includes(run.record_id));
    const status = !currentIds.has(run.record_id) ? 'historical' : stale ? 'stale' : ['failed', 'cancelled'].includes(run.status) ? 'operational_failure'
      : run.status !== 'completed' ? run.status : assessments.length ? 'assessed' : 'unassessed';
    const comparison = assessComparisons(action, run, currentRuns);
    if (stale || status === 'historical') {
      comparison.status = 'inconclusive';
      comparison.performance_claim = { ...comparison.performance_claim, status: 'not_established', claim_basis: [],
        reason_codes: [...comparison.performance_claim.reason_codes, 'stale_dependencies'] };
      comparison.limitations.push('stale_dependencies');
      comparison.comparisons = comparison.comparisons.map(row => ({ ...row, confirmatory: false, result: 'inconclusive' }));
    }
    if (status === 'unassessed' && comparison.status === 'improved_in_scope') comparison.status = 'not_assessed';
    if (status === 'unassessed') comparison.performance_claim = { ...comparison.performance_claim, status: 'not_assessed', claim_basis: [],
      reason_codes: [...comparison.performance_claim.reason_codes, 'run_not_assessed'] };
    return { record_id: run.record_id, executor_id: run.executor_id, run_id: run.run_id, attempt_id: run.attempt_id,
      source_revision: run.source_revision, status, execution_status: run.status, action_id: run.action_id, action_version: run.action_version,
      scope: run.protocol, evidence_origin: run.evidence_origin, measurements: run.measurements || [], comparisons: comparison,
      assessment_refs: assessments.map(a => a.assessment_id), prediction_refs: action?.prediction_ids || [],
      conclusions: stale ? [] : open.flatMap(h => h.rows.filter(r => r.run_record_id === run.record_id)),
      evidence_refs: dependencies.flatMap(collectEntityEvidence), source_refs: run.artifact_refs || [],
      query_match: matches(run) || actionMatches(action) };
  });
  const matched = allObservations.filter(o => o.query_match);
  const observations = matched.slice(0, limit).map(({ query_match, ...o }) => o);
  const visibleActions = state.actions.filter(a => observations.some(o => o.action_id === a.action_id && o.action_version === a.version) || actionMatches(a));
  const visibleHypotheses = hypotheses.filter(h => selectedHypotheses.includes(h) || visibleActions.some(a => a.hypothesis_versions?.some(r => r.hypothesis_id === h.hypothesis_id && r.version === h.version)));
  const nodes = [], edges = [];
  const addNode = node => { if (!nodes.some(n => n.id === node.id)) nodes.push(node); };
  const link = (from, to, relation, evidenceRefs, scope, status) => edges.push({ from, to, relation, evidence_refs: evidenceRefs, scope, status });
  const hypothesisId = h => `hypothesis:${h.hypothesis_id}@${h.version}`;
  const actionId = a => `action:${a.action_id}@${a.version}`;
  const mechanismPaths = [];
  const measurementRefs = measurementReferences(state.runs);
  for (const h of visibleHypotheses) {
    const id = hypothesisId(h), stale = h.evidence_keys?.some(k => staleSourceKeys.includes(k)) || h.run_record_ids?.some(id => !currentIds.has(id));
    addNode({ id, type: 'hypothesis', statement: h.statement, version: h.version, status: stale ? 'stale' : h.design_status });
    for (const ref of collectEntityEvidence(h)) {
      const sourceId = `source:${evidenceKey(ref)}`;
      addNode({ id: sourceId, type: 'source', ref });
      link(sourceId, id, 'informs', [ref], h.scope, stale ? 'stale' : 'registered_evidence');
    }
    for (const prediction of h.predictions || []) {
      addNode({ id: `${id}/prediction:${prediction.prediction_id}`, type: 'prediction', ...prediction });
      link(id, `${id}/prediction:${prediction.prediction_id}`, 'predicts', h.evidence_refs || [], h.scope, 'hypothesized');
    }
    const components = h.mechanism_evidence?.components || [];
    const endpoint = value => components.some(c => c.id === value) ? `${id}/component:${value}` : measurementRefs.some(m => m.id === value) ? value : `${id}/prediction:${value}`;
    for (const c of components) addNode({ ...c, id: endpoint(c.id), type: c.kind });
    for (const m of measurementRefs.filter(m => h.mechanism_evidence?.links.some(l => l.from === m.id || l.to === m.id))) addNode({ ...m, type: 'measurement', status: currentIds.has(m.record_id) ? 'current' : 'historical' });
    const links = (h.mechanism_evidence?.links || []).map(l => ({ ...l, from: endpoint(l.from), to: endpoint(l.to), scope: h.scope, status: stale ? 'stale' : l.status }));
    edges.push(...links);
    if (components.length) mechanismPaths.push({ hypothesis_id: h.hypothesis_id, version: h.version, components, links,
      status: stale ? 'stale' : 'registered', boundary: 'Code observations, measured associations and proposed effects retain their own evidence status; paths do not establish causality.' });
  }
  for (const a of visibleActions) {
    addNode({ id: actionId(a), type: 'action', title: a.title });
    for (const h of visibleHypotheses.filter(h => a.hypothesis_versions?.some(r => r.hypothesis_id === h.hypothesis_id && r.version === h.version))) link(actionId(a), hypothesisId(h), 'tests', a.evidence_refs || [], a.protocol, 'registered');
  }
  for (const o of observations) {
    const runId = `run:${o.record_id}`;
    addNode({ id: runId, type: 'run', status: o.status, evidence_origin: o.evidence_origin });
    link(`action:${o.action_id}@${o.action_version}`, runId, 'observed_execution', o.evidence_refs, o.scope, o.status);
    for (const row of o.comparisons.comparisons) {
      const id = `comparison:${row.measurement_id}`;
      addNode({ id, type: 'comparison', ...row });
      link(runId, id, 'measured', o.evidence_refs, o.scope, o.status);
    }
    for (const id of o.assessment_refs) {
      addNode({ id, type: 'assessment', status: 'current' });
      link(runId, id, 'assessed_by', [{ record_id: o.record_id }], o.scope, 'current');
    }
  }
  const snapshots = currentEvidence.length ? currentEvidence : state.evidence_snapshots;
  const sourceReadiness = snapshots.filter(s => s.ref.evidence_origin === 'paper_reported').map(s => ({ source_id: s.ref.source_id,
    source_version: s.source_version, admitted: s.admitted, graph_readiness: s.graph_readiness || null, status: staleSourceKeys.includes(s.key) ? 'stale' : 'current' }));
  const explanations = visibleHypotheses.map(h => ({ hypothesis_id: h.hypothesis_id, version: h.version, statement: h.statement, scope: h.scope,
    candidate_refs: h.candidate_refs || [], evidence_refs: collectEntityEvidence(h),
    ...(open.find(c => c.hypothesis_id === h.hypothesis_id && c.version === h.version) || { status: 'unassessed', rows: [] }) }));
  const compound = visibleActions.filter(a => (a.intervention_components || []).length > 1).map(a => ({ action_id: a.action_id, version: a.version,
    status: 'compound_intervention', changed_components: a.intervention_components, limitation: 'The joint intervention does not isolate each changed component.' }));
  return { status: 'ready', project: state.project, based_on_revision: state.revision,
    evidence_freshness: { status: staleSourceKeys.length ? 'stale' : 'current', stale_dependencies: staleSourceKeys, next_step: staleSourceKeys.length ? 'refresh_evidence' : null },
    observations, comparison_summary: observations.map(o => o.comparisons), open_explanations: explanations,
    mechanism_analysis: buildMechanismAnalysis(state, { currentEvidence: snapshots, staleSourceKeys, conclusions: open,
      hypothesisVersions: visibleHypotheses.map(h => ({ hypothesis_id: h.hypothesis_id, version: h.version })) }),
    mechanism_paths: mechanismPaths, compound_interventions: compound, source_readiness: sourceReadiness,
    evidence_requests: [...staleSourceKeys.map(key => ({ reason: 'changed_source', key, next_step: 'refresh_evidence' })),
      ...sourceReadiness.filter(s => s.graph_readiness?.status === 'source_only').map(s => ({ source_id: s.source_id, reason: 'semantic_node_missing', next_step: s.graph_readiness.next_step }))],
    nodes, edges, coverage: { matched: matched.length, returned: observations.length, total_runs: allObservations.length, truncated: matched.length > observations.length, limit, query: query || null },
    budget: budgetLedger(state), outstanding_runs: currentRuns.filter(r => ['queued', 'running', 'unknown_after_timeout'].includes(r.status)).map(r => ({ record_id: r.record_id, status: r.status })),
    assessment_validity: validity,
    limitations: ['Project observations are external experiment evidence, not paper-reported results.', 'Query matching selects records; it does not establish mechanism equivalence.'] };
}

export function attachProjectEvidence(result, view) {
  const explanations = view.open_explanations || [];
  const assess = candidate => {
    const ids = [candidate.candidate_id, candidate.id, candidate.candidate_node_id, candidate.candidateNodeId, ...(candidate.candidate_refs || [])].filter(Boolean);
    const sources = [...(candidate.source_papers || []).map(p => p.paper_id), ...(candidate.evidence_refs || []).map(r => r.source_id), ...(candidate.source_paper_ids || []), ...(candidate.sourcePaperIds || [])];
    const linked = explanations.filter(h => h.candidate_refs.some(id => ids.includes(id)) || h.evidence_refs.some(ref => sources.includes(ref.source_id) || sources.includes(ref.paper_id)));
    const rows = linked.flatMap(h => h.rows || []);
    return { ...candidate, project_assessment: { status: !linked.length ? 'unlinked' : rows.length ? 'tested_in_scope' : 'not_tested',
      hypothesis_refs: linked.map(h => `${h.hypothesis_id}@${h.version}`), run_record_ids: [...new Set(rows.map(r => r.run_record_id))],
      prediction_ids: [...new Set(rows.map(r => r.prediction_id))], scopes: linked.map(h => h.scope),
      reason: !linked.length ? 'No registered candidate or source reference connects this candidate to project results.'
        : rows.length ? 'Use the scoped results to specify a new intervention, unresolved explanation or replication before repeating this candidate.' : 'Registered connection without an assessed result.' } };
  };
  const output = Array.isArray(result) ? { candidates: result.map(assess) } : { ...result };
  const annotate = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const annotated = { ...value };
    for (const key of ['ideas', 'candidates', 'candidate_packets', 'packets', 'ranked_candidates', 'rankedCandidates']) if (Array.isArray(annotated[key])) annotated[key] = annotated[key].map(assess);
    for (const key of ['result', 'packetBundle', 'packet_bundle', 'innovation_packet', 'interdisciplinary_ranking']) if (annotated[key]) annotated[key] = annotate(annotated[key]);
    return annotated;
  };
  return { ...annotate(output), project_evidence: view, mechanism_guidance: view.mechanism_analysis || null,
    research_focus: explanations.filter(h => h.rows?.length).map(h => ({ hypothesis_id: h.hypothesis_id, version: h.version, status: h.status, scope: h.scope,
      run_record_ids: [...new Set(h.rows.map(r => r.run_record_id))], prediction_ids: [...new Set(h.rows.map(r => r.prediction_id))],
      next_step: ['excluded_in_scope', 'weakened_in_scope'].includes(h.status) ? 'Revise the intervention or test a remaining explanation in this scope.' : 'Resolve remaining alternatives or obtain independent replication.' })),
    candidate_grouping: 'Explicit project links distinguish tested, untested and unlinked candidates; unrelated candidates retain their original order.' };
}
