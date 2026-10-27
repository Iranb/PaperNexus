import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJson, writeText } from '../../lib/fs.js';
import { loadSourceManifest } from '../../storage/corpus-store.js';
import { POLICY_VERSION, DECISION_VERSION, MUTATIONS, decisionError, validateDecisionRequest, validateHypothesisSet, validateActionPlan, collectEntityEvidence, measurementReferences } from './decision-contracts.js';
import { decisionPaths, readDecisionState, mutateDecisionState, findRequestReceipt, latestRuns, latestVersions, attemptKey } from './decision-store.js';
import { inspectEvidence, evidenceKey, changedEvidence, mergeEvidenceSnapshots, verifyRunManifest, inspectComparisonReferences } from './decision-evidence.js';
import { buildMechanismAnalysis } from './mechanism-analysis.js';
import { assessObservation, compareExplanations, scientificState, assessmentValidity } from './hypothesis-assessment.js';
import { budgetLedger, recommendNextAction } from './action-policy.js';
import { mergeOpportunities, updateOpportunities, evaluateRevisitTriggers, evidenceRequests } from './opportunity-memory.js';
import { buildProjectEvidence } from './project-evidence.js';
import { assessComparisons, comparisonDependencyChanges } from './comparison-assessment.js';

export function selectHypotheses(state, versions) {
  return versions.map(ref => {
    const h = state.hypotheses.find(item => item.hypothesis_id === ref.hypothesis_id && item.version === ref.version);
    if (!h) throw decisionError('invalid_reference', `Unknown hypothesis ${ref.hypothesis_id}@${ref.version}`);
    return h;
  });
}

export function selectRuns(state, ids) {
  return [...new Set(ids)].map(id => {
    const run = state.runs.find(item => item.record_id === id);
    if (!run) throw decisionError('invalid_reference', `Unknown run record ${id}`);
    if (!latestRuns(state.runs).some(r => r.record_id === id)) throw decisionError('stale_dependencies', `Run ${id} was superseded`);
    return run;
  });
}

export function decisionDependencies(state, args) {
  if (args.operation === 'assess_results') {
    const runs = selectRuns(state, args.payload.run_record_ids);
    const hypotheses = selectHypotheses(state, args.payload.hypothesis_versions);
    const actions = runs.map(run => state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version));
    return [...hypotheses, ...actions, ...runs].flatMap(item => item.evidence_keys || []);
  }
  const actions = latestVersions(state.actions, 'action_id').filter(a => !args.payload?.action_ids || args.payload.action_ids.includes(a.action_id));
  return [...actions, ...actions.flatMap(a => selectHypotheses(state, a.hypothesis_versions || [])),
    ...state.assessments.flatMap(a => a.evidence_snapshots || [])].flatMap(item => item.evidence_keys || (item.key ? [item.key] : []));
}

export function runEvidenceRefs(run) {
  return [...collectEntityEvidence(run), ...(run.comparison?.source_ref ? [run.comparison.source_ref] : []),
    ...(run.manifest_path ? [{ evidence_origin: 'external_measured', source_id: `${run.executor_id}/${run.run_id}/${run.attempt_id}`,
      source_version: String(run.source_revision), locator: 'manifest', artifact_path: run.manifest_path }] : [])];
}

export function registrationProspectivity(state, action, run) {
  const start = Date.parse(run.started_at);
  const registered = Date.parse(action.created_at);
  if (Number.isFinite(start) && start < registered) return 'retrospective';
  const receipt = state.receipts.find(r => r.request_id === run.registration_receipt);
  return receipt && receipt.request_id === action.registered_request_id && Number.isFinite(start) && start >= registered
    ? 'registered_before_run' : 'unknown';
}

export function appendRun(state, run, verification, requestId) {
  const action = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
  if (!action) throw decisionError('invalid_reference', 'Run must reference an existing action version');
  const existing = state.runs.find(r => r.record_id === run.record_id || (attemptKey(r) === attemptKey(run) && r.source_revision === run.source_revision));
  if (existing) {
    const input = state.receipts.find(r => r.request_id === existing.accepted_request_id)?.request.payload.run;
    if (!isDeepStrictEqual(input, run)) throw decisionError('run_record_conflict', 'Record or source revision already has different contents');
    return { run_record_id: existing.record_id, duplicate: true, budget: budgetLedger(state) };
  }
  const prior = latestRuns(state.runs).find(r => attemptKey(r) === attemptKey(run));
  if (prior) {
    if (prior.action_id !== run.action_id || prior.action_version !== run.action_version) throw decisionError('run_record_conflict', 'An attempt cannot change action version');
    if (run.source_revision > prior.source_revision && run.supersedes_record_id !== prior.record_id) throw decisionError('invalid_reference', 'A newer attempt record must supersede the latest record_id');
    if (run.source_revision > prior.source_revision && ['completed', 'failed', 'cancelled'].includes(prior.status) && ['queued', 'running'].includes(run.status)) throw decisionError('invalid_input', 'Restarted execution requires a new attempt_id');
  }
  const superseded = state.runs.find(r => r.record_id === run.supersedes_record_id);
  if (superseded && attemptKey(superseded) !== attemptKey(run)) throw decisionError('invalid_reference', 'A run may only supersede the same attempt');
  let recommendationSnapshot = null;
  if (run.recommendation_ref) {
    const current = recommendNextAction(state, { actionIds: run.recommendation_ref.scope_action_ids });
    recommendationSnapshot = isDeepStrictEqual(current.recommendation_ref, run.recommendation_ref)
      ? current : { status: 'unverified_stale_reference', provided_ref: run.recommendation_ref };
  }
  state.runs.push({ ...run, verification, prospectivity: registrationProspectivity(state, action, run),
    evidence_keys: [...new Set([...runEvidenceRefs(run).map(evidenceKey), ...(verification.comparisons || []).flatMap(c => c.evidence_keys || [])])], accepted_request_id: requestId,
    recorded_at: new Date().toISOString(), recommendation_snapshot: recommendationSnapshot });
  return { run_record_id: run.record_id, duplicate: false, current_record: latestRuns(state.runs).find(r => attemptKey(r) === attemptKey(run)).record_id,
    verification, budget: budgetLedger(state), scientific_assessment: 'pending' };
}

export async function controllerCandidates(rootPath, project) {
  const filePath = path.join(decisionPaths(rootPath, project).root, 'candidate-graph.jsonl');
  let raw;
  try { raw = await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const manifest = await loadSourceManifest(rootPath);
  return raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)).filter(c => c.record_type === 'candidate_node').map(c => ({
    candidate_id: c.candidate_id, source_domain: c.source_domain || '', mechanism: c.mechanism || c.title || c.name || '',
    subproblem: c.subproblem_id || c.subproblem?.name || c.subproblem || '', evidence_cluster: c.evidence_cluster || (c.evidence?.paper_ids || []).join(','),
    evidence_refs: [...(c.evidence_refs || []).filter(ref => ref.evidence_origin && ref.source_id && ref.source_version && ref.locator),
      ...(c.source_papers || []).flatMap(paper => (manifest.sources || []).filter(entry => (entry.paperId || entry.paper_id) === paper.paper_id).map(entry => {
        const sourceKey = entry.sourceKey || entry.source_key || entry.canonicalSourceKey;
        return sourceKey ? { evidence_origin: 'paper_reported', source_id: paper.paper_id, paper_id: paper.paper_id, source_key: sourceKey,
          source_version: sourceKey, locator: c.source_span_refs?.[0]?.span_id || 'paper' } : null;
      }).filter(Boolean))],
    bridge_evidence: c.bridge_evidence === true, artifact_path: filePath, source_version: String(c.updated_at || c.version || 'controller-current'),
    controller_candidate: c
  }));
}

export function decisionStatus(state, args = {}) {
  if (args.requestId) {
    const receipt = state.receipts.find(r => r.request_id === args.requestId);
    return receipt ? { status: 'committed', receipt, current_revision: state.revision } : { status: 'request_not_found', request_id: args.requestId };
  }
  if (args.entityId) return { status: 'ready', entities: [...state.hypotheses, ...state.actions, ...state.opportunities, ...state.runs].filter(item =>
    [item.hypothesis_id, item.action_id, item.candidate_id, item.record_id].includes(args.entityId)) };
  const { receipts, ...data } = state;
  return { status: 'ready', ...data, receipt_count: receipts.length,
    budget: budgetLedger(state), scientific_state: scientificState(state),
    assessment_validity: state.assessments.map(a => ({ assessment_id: a.assessment_id, ...assessmentValidity(a, state) })),
    evidence_requests: evidenceRequests(state), freshness: 'Stored snapshots; recommend_next and assess_results check their live dependencies.' };
}

export function decisionMarkdown(state, assessment, staleSourceKeys = []) {
  const scientific = scientificState(state, staleSourceKeys).filter(h => !assessment || assessment.hypothesis_versions.some(ref => ref.hypothesis_id === h.hypothesis_id && ref.version === h.version));
  const lines = [`# Research decision: ${state.project}`, '', state.objective, '', `Revision: ${state.revision}`, `Goal: ${state.goal_phase}`, '',
    '## Explanations', '', ...scientific.map(h => `- ${h.hypothesis_id} v${h.version}: ${h.status}. Scope: ${JSON.stringify(h.scope)}. Evidence groups: ${(h.evidence_groups || []).join(', ')}`),
    '', '## Observations', ''];
  for (const h of scientific) for (const row of h.rows || []) lines.push(`- ${row.run_record_id} / ${row.prediction_id}: ${row.relation}; ${row.comparison}. Evidence role: ${row.evidence_role}. Origin: ${row.evidence_origin}. Gate: ${JSON.stringify(row.assessment_gate)}.`);
  lines.push('', '## Comparisons', '');
  const view = buildProjectEvidence(state, { limit: Number.MAX_SAFE_INTEGER, staleSourceKeys });
  for (const run of latestRuns(state.runs)) {
    const action = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
    const comparison = view.comparison_summary.find(c => c.run_record_id === run.record_id);
    if (!comparison.comparisons.length) continue;
    lines.push(`- ${run.record_id}: ${comparison.status}; performance claim: ${comparison.performance_claim.status}; inference: ${comparison.inference_target || 'unknown'}.`);
    for (const row of comparison.comparisons) lines.push(`  - ${row.comparison_id} / ${row.quantity}: ${row.measurement?.estimate ?? 'unknown'} ${row.unit}; ${row.label}; ${row.result} (${row.outcome_role}, ${row.evidence_role}).`);
    lines.push(`  - Performance evidence: ${comparison.performance_claim.reason_codes.join(', ') || 'registered target comparisons'}.`);
    lines.push(`  - Limitations: ${comparison.limitations.join(', ')}.`);
  }
  lines.push('', '## Mechanism evidence', '', `Policy: ${POLICY_VERSION}`, '',
    ...view.mechanism_analysis.evidence_gaps.map(g => `- ${g.hypothesis_id}@${g.hypothesis_version}/${g.prediction_id || g.component_id}: ${g.reason}. ${g.next_step}`),
    ...view.mechanism_analysis.limitations.map(l => `- ${l}`));
  lines.push('', '## Evidence chain', '',
    ...view.mechanism_analysis.hypotheses.map(h => `- ${h.hypothesis_id}@${h.version}: target ${h.evidence_chain.target_status}. ${h.evidence_chain.boundary}`),
    ...view.mechanism_analysis.research_gaps.map(g => `- ${g.hypothesis_id}@${g.hypothesis_version}/${g.prediction_id}: ${g.reason}. ${g.next_step}`));
  lines.push('', '## Budget', '', '| Resource | Limit | Spent | Committed | Remaining |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [key, b] of Object.entries(budgetLedger(state).dimensions)) lines.push(`| ${key} | ${b.limit ?? 'unspecified'} | ${b.spent} | ${b.committed} | ${b.remaining ?? 'unknown'} |`);
  lines.push('', '## Opportunities', '', ...state.opportunities.map(o => `- ${o.candidate_id}: ${o.status}. ${o.reason}`), '', '## Evidence requests', '', ...evidenceRequests(state).map(r => `- ${r.candidate_id}: ${r.reason}`), '',
    '## Boundaries', '', 'External executor records own measurements and job state. Recommendations do not authorize execution. Synthetic fixtures demonstrate software behavior; real research utility has not been validated.', '');
  return lines.join('\n');
}

export async function executeResearchDecisionOperation(rootPath, args, options = {}) {
  validateDecisionRequest(args);
  const initial = await readDecisionState(rootPath, args.project);
  if (MUTATIONS.includes(args.operation)) {
    const replay = findRequestReceipt(initial, args);
    if (replay) return replay;
  }
  if (!initial && args.operation !== 'init') {
    if (MUTATIONS.includes(args.operation)) throw decisionError('not_initialized', 'Initialize this project first');
    return { revision: 0, result: { status: 'not_initialized', project: args.project } };
  }
  const loadEvidence = options.inspectEvidence || (refs => inspectEvidence(rootPath, refs));
  if (args.operation === 'evidence_view') {
    const current = await loadEvidence(initial.evidence_snapshots.map(s => s.ref));
    const stale = changedEvidence(initial.evidence_snapshots, current);
    return { revision: initial.revision, result: buildProjectEvidence(initial, { ...args, staleSourceKeys: stale, currentEvidence: current }) };
  }
  if (args.operation === 'status') return { revision: initial.revision, result: decisionStatus(initial, args) };
  if (args.operation === 'export') {
    const current = await loadEvidence(initial.evidence_snapshots.map(s => s.ref));
    const stale = changedEvidence(initial.evidence_snapshots, current);
    const assessment = args.assessmentId ? initial.assessments.find(a => a.assessment_id === args.assessmentId) : null;
    if (args.assessmentId && !assessment) throw decisionError('invalid_reference', 'Unknown assessmentId');
    const result = { status: 'exported', based_on_revision: initial.revision,
      json: assessment ? { ...assessment, validity: assessmentValidity(assessment, initial, stale), current_policy_version: POLICY_VERSION,
        current_scientific_state: scientificState(initial, stale).filter(h => assessment.hypothesis_versions.some(ref => ref.hypothesis_id === h.hypothesis_id && ref.version === h.version)) } : { ...decisionStatus(initial),
        project_evidence: buildProjectEvidence(initial, { limit: Number.MAX_SAFE_INTEGER, staleSourceKeys: stale, currentEvidence: current }) },
      markdown: decisionMarkdown(initial, assessment, stale) };
    if (args.outputDir && !args.dryRun) {
      try {
        const directory = path.resolve(args.outputDir);
        await writeJson(path.join(directory, 'research-decision-report.json'), result.json);
        await writeText(path.join(directory, 'research-decision-report.md'), result.markdown);
        result.output_directory = directory;
      } catch (error) { result.status = 'export_pending'; result.reason = error.message; }
    }
    return { revision: initial.revision, result };
  }
  if (args.operation === 'recommend_next') {
    const keys = new Set(decisionDependencies(initial, args));
    const saved = initial.evidence_snapshots.filter(s => keys.has(s.key));
    const current = await loadEvidence(saved.map(s => s.ref));
    const stale = changedEvidence(saved, current);
    return { revision: initial.revision, result: { ...recommendNextAction(initial, { actionIds: args.payload?.action_ids, staleSourceKeys: stale }),
      stale_dependencies: stale, evidence_versions: current, next_input: stale.length ? 'refresh_evidence' : null } };
  }
  const payload = args.payload || {};
  let refs = [], candidates = [], verification = null;
  if (args.operation === 'register_hypotheses') refs = payload.hypotheses.flatMap(collectEntityEvidence);
  if (args.operation === 'register_actions') refs = payload.actions.flatMap(collectEntityEvidence);
  if (args.operation === 'record_run') {
    refs = runEvidenceRefs(payload.run); verification = await verifyRunManifest(rootPath, payload.run);
    const action = initial.actions.find(a => a.action_id === payload.run.action_id && a.version === payload.run.action_version);
    if (!action) throw decisionError('invalid_reference', 'Run must reference an existing action version');
    if (payload.run.comparisons) verification.comparisons = await inspectComparisonReferences(rootPath, initial, action, payload.run, loadEvidence);
    for (const c of payload.run.comparisons || []) if (c.reference.kind === 'run_record') {
      const source = initial.runs.find(r => r.record_id === c.reference.record_id);
      refs.push(...runEvidenceRefs(source));
    }
  }
  if (args.operation === 'refresh_evidence') {
    candidates = [...await controllerCandidates(rootPath, args.project), ...(payload.candidate_refs || [])];
    refs = [...initial.evidence_snapshots.map(s => s.ref), ...(payload.source_refs || []), ...candidates.flatMap(c => c.evidence_refs || [])];
  }
  if (args.operation === 'update_opportunities') refs = payload.changes.flatMap(c => c.candidate?.evidence_refs || []);
  if (args.operation === 'assess_results') {
    const keys = new Set(decisionDependencies(initial, args));
    refs = initial.evidence_snapshots.filter(s => keys.has(s.key)).map(s => s.ref);
    for (const note of payload.analysis_annotations || []) {
      if (!payload.hypothesis_versions.some(h => h.hypothesis_id === note.hypothesis_id)) throw decisionError('invalid_reference', 'Annotation hypothesis is outside this assessment');
      for (const ref of note.evidence_refs) if (!keys.has(evidenceKey(ref))) throw decisionError('invalid_reference', 'Annotation must cite an assessment dependency');
    }
  }
  const snapshots = await loadEvidence(refs);
  if (args.operation === 'assess_results') {
    const stale = changedEvidence(initial.evidence_snapshots, snapshots);
    if (stale.length) throw decisionError('stale_dependencies', 'Refresh changed sources before assessment', stale);
    const comparatorChanges = selectRuns(initial, payload.run_record_ids).flatMap(run => comparisonDependencyChanges(run, initial));
    if (comparatorChanges.length) throw decisionError('stale_dependencies', 'Submit a new run source revision with the corrected comparator before assessment', comparatorChanges);
    const refreshed = await loadEvidence(refs);
    if (changedEvidence(snapshots, refreshed).length) throw decisionError('stale_dependencies', 'Sources changed during assessment preparation');
  }
  return mutateDecisionState(rootPath, args, state => {
    const revision = state.revision + 1;
    const now = new Date().toISOString();
    mergeEvidenceSnapshots(state, snapshots);
    if (args.operation === 'init') {
      Object.assign(state, payload, { created_at: now });
      return { status: 'initialized', project: state.project, budget: budgetLedger(state) };
    }
    if (args.operation === 'register_hypotheses' || args.operation === 'register_actions') {
      const hypothesisMode = args.operation === 'register_hypotheses';
      const field = hypothesisMode ? 'hypotheses' : 'actions';
      const idField = hypothesisMode ? 'hypothesis_id' : 'action_id';
      const measurements = measurementReferences(latestRuns(state.runs));
      const values = hypothesisMode ? validateHypothesisSet(payload.hypotheses, state.hypotheses, measurements.map(m => m.id)) : payload.actions.map(a => validateActionPlan(a, state.hypotheses));
      for (const item of values) {
        const latest = latestVersions(state[field], idField).find(prior => prior[idField] === item[idField]);
        if (item.version !== (latest?.version || 0) + 1) throw decisionError('invalid_version', `${item[idField]} requires a new consecutive version`);
        const referencedRuns = measurements.filter(m => item.mechanism_evidence?.links.some(l => l.from === m.id || l.to === m.id)).map(m => state.runs.find(r => r.record_id === m.record_id));
        const record = { ...item, registered_request_id: args.requestId, registered_revision: revision, created_at: now,
          ...(hypothesisMode ? { run_record_ids: [...new Set(referencedRuns.map(r => r.record_id))] } : {}),
          evidence_keys: [...new Set([...collectEntityEvidence(item).map(evidenceKey), ...referencedRuns.flatMap(r => r.evidence_keys || [])])] };
        state[field].push(record);
        if (hypothesisMode) state.predictions.push(...record.predictions.map(p => ({ ...p, hypothesis_id: record.hypothesis_id, hypothesis_version: record.version, registered_revision: revision })));
      }
      return { status: 'registered', [field]: values, source_admission: snapshots.map(s => ({ key: s.key, admitted: s.admitted, verification: s.verification })) };
    }
    if (args.operation === 'record_run') return appendRun(state, payload.run, verification, args.requestId);
    if (args.operation === 'assess_results') {
      const runs = selectRuns(state, payload.run_record_ids);
      const hypotheses = selectHypotheses(state, payload.hypothesis_versions);
      const missing = snapshots.filter(s => !s.admitted);
      if (missing.length) return { status: 'needs_input', assessment_gate: { allowed: false, reason_codes: ['source_not_admitted'], sources: missing }, next_step: 'Supply or repair the specific source references.' };
      const mechanismAnalysis = buildMechanismAnalysis(state, { currentEvidence: snapshots, hypothesisVersions: payload.hypothesis_versions });
      const rows = compareExplanations(runs.flatMap(run => {
        const action = state.actions.find(a => a.action_id === run.action_id && a.version === run.action_version);
        return hypotheses.flatMap(h => assessObservation(h, action, run, state.runs, { mechanismAnalysis, evidenceSnapshots: snapshots }));
      }), hypotheses);
      const assessment = { policy_version: POLICY_VERSION, assessment_id: `assessment:${revision}`, created_at: now, based_on_revision: state.revision,
        run_record_ids: runs.map(r => r.record_id), hypothesis_versions: payload.hypothesis_versions,
        reference_record_ids: [...hypotheses.flatMap(h => h.run_record_ids || []), ...runs.flatMap(r => (r.comparisons || []).filter(c => c.reference.kind === 'run_record').map(c => c.reference.record_id))],
        comparison_summary: runs.map(r => assessComparisons(state.actions.find(a => a.action_id === r.action_id && a.version === r.action_version), r, state.runs)),
        evidence_keys: snapshots.map(s => s.key), evidence_snapshots: snapshots, rows,
        analysis_annotations: (payload.analysis_annotations || []).map(a => ({ ...a, evidence_origin: 'agent_inferred', authority: 'annotation_only' })) };
      state.assessments.push(assessment);
      assessment.hypotheses = scientificState(state);
      return { status: rows.length ? 'assessed' : 'unassessable', assessment,
        assessment_gate: { allowed: rows.some(r => r.assessment_gate.valid), confirmatory: rows.some(r => r.assessment_gate.confirmatory),
          reason_codes: rows.length ? [...new Set(rows.flatMap(r => r.assessment_gate.reason_codes))] : ['no_matching_measurements'] },
        unmodeled_explanation: rows.length > 0 && rows.every(r => r.assessment_gate.confirmatory && r.relation === 'inconsistent'),
        revisit_events: evaluateRevisitTriggers(state) };
    }
    if (args.operation === 'update_opportunities') updateOpportunities(state, payload.changes);
    if (args.operation === 'refresh_evidence') mergeOpportunities(state, candidates);
    const events = evaluateRevisitTriggers(state);
    return { status: 'updated', opportunities: state.opportunities, revisit_events: events, evidence_requests: evidenceRequests(state),
      evidence_snapshots: snapshots, assessment_validity: state.assessments.map(a => ({ assessment_id: a.assessment_id, ...assessmentValidity(a, state) })), budget: budgetLedger(state) };
  }, options);
}
