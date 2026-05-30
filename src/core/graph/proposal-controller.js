import fs from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../../lib/utils.js';
import {
  CLAIM_LABELS,
  PROPOSAL_EDGE_TYPES,
  PROPOSAL_NODE_TYPES,
  activeEdgesByType,
  activeNodesByType,
  createGraphSnapshot,
  createProposalGraph,
  markProposalGraphCommitted,
  mergeValidatedActions,
  proposalGraphHash,
  validateActionSlate,
  validateProposalGraph
} from './proposal-graph.js';
import { synthesizeProposalBundle } from './proposal-synthesis.js';

export const PROPOSAL_CONTROLLER_VERSION = 'papernexus-proposal-controller-v1';
export const PROPOSAL_SESSION_MANIFEST_VERSION = 'papernexus-proposal-session-manifest-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, Number(numeric.toFixed(4))));
}

function contentHash(value, length = 20) {
  return stableHash(JSON.stringify(value), length);
}

function deterministicId(prefix, payload, length = 16) {
  return `${prefix}:${contentHash(payload, length)}`;
}

function slatesForRound(source, round, roundId) {
  if (!source) return [];
  if (Array.isArray(source)) {
    const indexed = source[round];
    if (Array.isArray(indexed)) return indexed;
    if (round === 0 && source.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) {
      return source;
    }
    return [];
  }
  if (typeof source === 'object') {
    return asArray(source[round] || source[String(round)] || source[roundId]);
  }
  return [];
}

function hydrateSnapshotTokens(value, snapshot = {}) {
  if (Array.isArray(value)) return value.map((entry) => hydrateSnapshotTokens(entry, snapshot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      hydrateSnapshotTokens(entry, snapshot)
    ]));
  }
  if (typeof value !== 'string') return value;
  if (['__problem_node_id__', '$problem_node_id', '{problem_node_id}'].includes(value)) {
    return snapshot.problem_node_id;
  }
  return value.replaceAll('{problem_node_id}', snapshot.problem_node_id || '');
}

function hydrateSlateForSnapshot(slate = {}, snapshot = {}, roundId = '') {
  return {
    ...slate,
    round_id: compactText(slate.round_id || slate.roundId) || roundId,
    snapshot_id: compactText(slate.snapshot_id || slate.snapshotId) || snapshot.snapshot_id,
    role_id: compactText(slate.role_id || slate.roleId) || 'ConfiguredRole',
    actions: hydrateSnapshotTokens(asArray(slate.actions), snapshot)
  };
}

function nodeMap(graph = {}) {
  return new Map(asArray(graph.nodes).map((node) => [node.id, node]));
}

function hasAnyByType(graph, type) {
  return activeNodesByType(graph, type).length > 0;
}

function isHighSeverity(node = {}) {
  return ['high', 'critical', 'blocker'].includes(compactText(node.severity || node.properties?.severity).toLowerCase());
}

function arrayLikePresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(compactText(value));
}

function evalPlanReady(plan = {}) {
  const props = plan.properties || {};
  return arrayLikePresent(props.datasets || props.data_requirements || props.dataRequirements)
    && arrayLikePresent(props.baselines)
    && arrayLikePresent(props.metrics)
    && arrayLikePresent(props.ablations)
    && arrayLikePresent(props.leakage_controls || props.leakageControls)
    && Boolean(props.falsifier || props.falsifiers || props.falsification_condition || props.falsificationCondition);
}

function isRepaired(graph = {}, nodeId = '') {
  return activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.REPAIRS)
    .some((edge) => edge.target === nodeId);
}

function hasGrounding(graph = {}, nodeId = '') {
  return activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.GROUNDED_IN)
    .some((edge) => edge.source === nodeId);
}

function hasPriorContrast(graph = {}) {
  return activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.OVERLAPS_PRIOR).length > 0
    || activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.REQUIRES_EVIDENCE).some((edge) => {
      const target = nodeMap(graph).get(edge.target);
      return target?.type === PROPOSAL_NODE_TYPES.EVIDENCE_NEED;
    });
}

function unresolvedContradictions(graph = {}) {
  return activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.CONTRADICTS)
    .filter((edge) => !isRepaired(graph, edge.source) && !isRepaired(graph, edge.target));
}

function unresolvedHighRisks(graph = {}) {
  return activeNodesByType(graph, PROPOSAL_NODE_TYPES.RISK)
    .filter((node) => isHighSeverity(node) && !node.properties?.limitation && !isRepaired(graph, node.id));
}

function connectedActiveSubgraphHasRequiredTypes(graph = {}, requiredTypes = []) {
  const nodes = asArray(graph.nodes).filter((node) => node.status !== 'rejected');
  const ids = new Set(nodes.map((node) => node.id));
  const problem = nodes.find((node) => node.type === PROPOSAL_NODE_TYPES.PROBLEM);
  if (!problem) return false;
  const adjacency = new Map();
  for (const id of ids) adjacency.set(id, new Set());
  for (const edge of asArray(graph.edges)) {
    if (edge.status === 'rejected' || !ids.has(edge.source) || !ids.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set();
  const queue = [problem.id];
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) || []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  const connectedTypes = new Set(nodes.filter((node) => visited.has(node.id)).map((node) => node.type));
  return requiredTypes.every((type) => connectedTypes.has(type));
}

export function computeProposalMaturity(graph = {}) {
  const requiredTypes = [
    PROPOSAL_NODE_TYPES.PROBLEM,
    PROPOSAL_NODE_TYPES.HYPOTHESIS,
    PROPOSAL_NODE_TYPES.MECHANISM,
    PROPOSAL_NODE_TYPES.METHOD,
    PROPOSAL_NODE_TYPES.NOVELTY_CLAIM,
    PROPOSAL_NODE_TYPES.EVAL_PLAN,
    PROPOSAL_NODE_TYPES.RISK
  ];
  const presentRequiredTypes = requiredTypes.filter((type) => hasAnyByType(graph, type));
  const evidenceClaimNodes = asArray(graph.nodes).filter((node) => (
    node.status !== 'rejected'
    && node.claim_label === CLAIM_LABELS.EVIDENCE_SUPPORTED
  ));
  const ungroundedEvidenceClaims = evidenceClaimNodes.filter((node) => !hasGrounding(graph, node.id));
  const readyEvalPlans = activeNodesByType(graph, PROPOSAL_NODE_TYPES.EVAL_PLAN).filter(evalPlanReady);
  const falsificationRoutes = activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.FALSIFIED_BY);
  const contradictions = unresolvedContradictions(graph);
  const highRisks = unresolvedHighRisks(graph);
  const connectedRequired = connectedActiveSubgraphHasRequiredTypes(graph, requiredTypes);
  const hasStory = hasAnyByType(graph, PROPOSAL_NODE_TYPES.STORY_BEAT);
  const hasNoveltyContrast = hasPriorContrast(graph);

  const completenessScore = presentRequiredTypes.length / requiredTypes.length;
  const groundingScore = evidenceClaimNodes.length
    ? (evidenceClaimNodes.length - ungroundedEvidenceClaims.length) / evidenceClaimNodes.length
    : 1;
  const contradictionLoad = Math.min(1, contradictions.length / 3);
  const noveltyRisk = hasNoveltyContrast ? 0 : 1;
  const feasibilityScore = highRisks.length ? Math.max(0, 1 - highRisks.length / 3) : 1;
  const evaluationReadiness = readyEvalPlans.length && falsificationRoutes.length ? 1 : 0;
  const storyCoherence = hasStory ? 1 : 0.5;
  const diversityPreservation = 1;
  const evidenceCost = activeNodesByType(graph, PROPOSAL_NODE_TYPES.EVIDENCE_NEED).length > 3 ? 0.5 : 1;

  return {
    controller_version: PROPOSAL_CONTROLLER_VERSION,
    graph_hash: proposalGraphHash(graph),
    required_types: requiredTypes,
    present_required_types: presentRequiredTypes,
    missing_required_types: requiredTypes.filter((type) => !presentRequiredTypes.includes(type)),
    connected_required_subgraph: connectedRequired,
    ungrounded_evidence_claim_ids: ungroundedEvidenceClaims.map((node) => node.id),
    unresolved_contradiction_edge_ids: contradictions.map((edge) => edge.id),
    unresolved_high_risk_ids: highRisks.map((node) => node.id),
    ready_eval_plan_ids: readyEvalPlans.map((node) => node.id),
    falsification_edge_ids: falsificationRoutes.map((edge) => edge.id),
    has_novelty_contrast: hasNoveltyContrast,
    has_storyline: hasStory,
    scores: {
      grounding_score: normalizeScore(groundingScore),
      contradiction_load: normalizeScore(contradictionLoad),
      completeness_score: normalizeScore(completenessScore),
      novelty_risk: normalizeScore(noveltyRisk),
      feasibility_score: normalizeScore(feasibilityScore),
      evaluation_readiness: normalizeScore(evaluationReadiness),
      story_coherence: normalizeScore(storyCoherence),
      diversity_preservation: normalizeScore(diversityPreservation),
      evidence_cost: normalizeScore(evidenceCost)
    }
  };
}

export function evaluateProposalCommit(graph = {}, options = {}) {
  const maturity = computeProposalMaturity(graph);
  const blockingReasons = [];
  if (!maturity.connected_required_subgraph) blockingReasons.push('required_subgraph_not_connected');
  if (maturity.missing_required_types.length) blockingReasons.push('missing_required_node_types');
  if (maturity.ungrounded_evidence_claim_ids.length) blockingReasons.push('ungrounded_evidence_supported_claims');
  if (maturity.unresolved_contradiction_edge_ids.length) blockingReasons.push('unresolved_contradictions');
  if (maturity.unresolved_high_risk_ids.length) blockingReasons.push('unresolved_high_severity_risks');
  if (!maturity.ready_eval_plan_ids.length) blockingReasons.push('evaluation_plan_not_ready');
  if (!maturity.falsification_edge_ids.length) blockingReasons.push('missing_falsification_route');
  if (!maturity.has_novelty_contrast) blockingReasons.push('missing_novelty_contrast');
  if (!maturity.has_storyline) blockingReasons.push('missing_storyline');

  const status = blockingReasons.length ? 'continue' : 'committed';
  const decision = {
    controller_version: PROPOSAL_CONTROLLER_VERSION,
    commit_decision_id: deterministicId('commit-decision', {
      graph_hash: graph.graph_hash,
      round_id: options.round_id || options.roundId,
      blockingReasons
    }),
    round_id: compactText(options.round_id || options.roundId),
    snapshot_id: graph.snapshot_id,
    graph_hash: graph.graph_hash,
    status,
    committed_subgraph_id: status === 'committed'
      ? deterministicId('committed-subgraph', { graph_hash: graph.graph_hash }, 14)
      : null,
    scores: maturity.scores,
    blocking_reasons: blockingReasons,
    decision_reasons: blockingReasons.length
      ? blockingReasons.map((reason) => ({ code: reason, severity: 'blocking' }))
      : [{ code: 'all_commit_gates_passed', severity: 'info' }],
    maturity
  };
  return decision;
}

export function validateRoleSlates(slates = [], graph = {}) {
  return asArray(slates).map((slate) => validateActionSlate(slate, graph));
}

export function selectProposalActions(validationResults = [], options = {}) {
  const editDecisionId = deterministicId('edit-decision', {
    validationResults: validationResults.map((result) => ({
      slate_id: result.slate_id,
      valid_actions: result.valid_actions.map((action) => action.action_id),
      invalid_actions: result.invalid_actions.map((entry) => entry.action.action_id)
    })),
    policy: options.policy || 'deterministic-accept-valid'
  });
  const acceptedActions = [];
  const decisions = [];
  for (const result of validationResults) {
    for (const action of result.valid_actions) {
      acceptedActions.push(action);
      decisions.push({
        edit_decision_id: editDecisionId,
        action_id: action.action_id,
        role_id: action.role_id,
        decision: 'accepted',
        reason_codes: ['valid_action'],
        score: 1
      });
    }
    for (const invalid of result.invalid_actions) {
      decisions.push({
        edit_decision_id: editDecisionId,
        action_id: invalid.action.action_id,
        role_id: invalid.action.role_id,
        decision: 'rejected',
        reason_codes: ['schema_validation_failed', ...invalid.errors],
        score: 0
      });
    }
    for (const error of result.errors) {
      decisions.push({
        edit_decision_id: editDecisionId,
        action_id: null,
        role_id: result.role_id,
        decision: 'rejected',
        reason_codes: ['slate_validation_failed', error],
        score: 0
      });
    }
    if (result.skip) {
      decisions.push({
        edit_decision_id: editDecisionId,
        action_id: null,
        role_id: result.role_id,
        decision: 'deferred',
        reason_codes: ['role_skipped'],
        score: 0
      });
    }
  }
  return {
    edit_decision_id: editDecisionId,
    accepted_actions: acceptedActions,
    decisions
  };
}

export function replayProposalActionTrace(input = {}, roleTrace = [], options = {}) {
  const runId = compactText(input.run_id || input.runId) || deterministicId('proposal-run', {
    problem: input.problem,
    target_domain: input.targetDomain || input.target_domain
  }, 12);
  let graph = createProposalGraph({
    run_id: runId,
    problem: input.problem,
    target_domain: input.targetDomain || input.target_domain,
    temporal_cutoff: input.temporalCutoff || input.temporal_cutoff,
    evidence_refs: input.evidenceRefs || input.evidence_refs || []
  });
  const grouped = new Map();
  for (const validation of asArray(roleTrace)) {
    const roundId = compactText(validation.round_id || validation.roundId);
    if (!roundId) continue;
    if (!grouped.has(roundId)) grouped.set(roundId, {
      actions: [],
      edit_decision_id: compactText(validation.edit_decision_id || validation.editDecisionId)
    });
    const group = grouped.get(roundId);
    if (!group.edit_decision_id) group.edit_decision_id = compactText(validation.edit_decision_id || validation.editDecisionId);
    group.actions.push(...asArray(validation.valid_actions));
  }
  const patches = [];
  const commitDecisions = [];
  let proposalBundle = null;
  let finalStatus = 'diagnosis';
  const orderedRounds = [...grouped.keys()].sort();
  for (const [index, roundId] of orderedRounds.entries()) {
    const snapshot = createGraphSnapshot(graph, { round: graph.round || index });
    const group = grouped.get(roundId);
    const actions = group.actions;
    const merged = mergeValidatedActions(snapshot, actions, {
      round_id: roundId,
      edit_decision_id: group.edit_decision_id || deterministicId('replay-edit-decision', {
        round_id: roundId,
        action_ids: actions.map((action) => action.action_id)
      })
    });
    graph = merged.graph;
    patches.push(merged.patch);
    const commitDecision = evaluateProposalCommit(graph, { round_id: roundId });
    commitDecisions.push(commitDecision);
    if (commitDecision.status === 'committed') {
      graph = markProposalGraphCommitted(graph, commitDecision);
      proposalBundle = synthesizeProposalBundle(graph, {
        commitDecision,
        evidenceExport: options.evidenceExport || options.evidence_export || {}
      });
      finalStatus = 'committed';
      break;
    }
  }
  return {
    input,
    graph,
    patches,
    commit_decisions: commitDecisions,
    proposal_bundle: proposalBundle,
    final_status: finalStatus,
    round_count: commitDecisions.length
  };
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeJsonl(filePath, entries = []) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
}

async function artifactHash(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return stableHash(content, 24);
}

async function writeSessionArtifacts(outputDir, state = {}) {
  const artifactPaths = {
    input: path.join(outputDir, 'input.json'),
    graph: path.join(outputDir, 'proposal-graph.json'),
    roleTrace: path.join(outputDir, 'role-action-trace.jsonl'),
    patches: path.join(outputDir, 'patches.jsonl'),
    editDecisions: path.join(outputDir, 'edit-decisions.jsonl'),
    commitDecisions: path.join(outputDir, 'commit-decisions.jsonl'),
    validation: path.join(outputDir, 'validation-report.json'),
    evidenceExport: path.join(outputDir, 'evidence-export.json'),
    proposalJson: path.join(outputDir, 'proposal.json'),
    proposalMarkdown: path.join(outputDir, 'proposal.md'),
    manifest: path.join(outputDir, 'proposal-session-manifest.json')
  };

  await writeJson(artifactPaths.input, state.input);
  await writeJson(artifactPaths.graph, state.graph);
  await writeJsonl(artifactPaths.roleTrace, state.role_trace);
  await writeJsonl(artifactPaths.patches, state.patches);
  await writeJsonl(artifactPaths.editDecisions, state.edit_decisions);
  await writeJsonl(artifactPaths.commitDecisions, state.commit_decisions);
  await writeJson(artifactPaths.validation, state.validation_report);
  await writeJson(artifactPaths.evidenceExport, state.evidence_export);
  if (state.proposal_bundle) {
    await writeJson(artifactPaths.proposalJson, state.proposal_bundle.proposal_json);
    await fs.writeFile(artifactPaths.proposalMarkdown, state.proposal_bundle.markdown, 'utf8');
  }

  const hashEntries = {};
  for (const [key, filePath] of Object.entries(artifactPaths)) {
    if (key === 'manifest') continue;
    try {
      hashEntries[key] = {
        path: filePath,
        hash: await artifactHash(filePath)
      };
    } catch {
      hashEntries[key] = {
        path: filePath,
        hash: null
      };
    }
  }

  const manifest = {
    manifest_version: PROPOSAL_SESSION_MANIFEST_VERSION,
    run_id: state.input.run_id,
    input_problem: state.input.problem,
    target_domain: state.input.target_domain,
    mode: 'proposal_graph',
    session_graph_schema_version: state.graph.schema_version,
    round_count: state.round_count,
    final_status: state.final_status,
    committed_subgraph_id: state.graph.committed_subgraph_id || null,
    proposal_artifact_paths: {
      proposal_md: state.proposal_bundle ? artifactPaths.proposalMarkdown : null,
      proposal_json: state.proposal_bundle ? artifactPaths.proposalJson : null,
      proposal_graph_json: artifactPaths.graph
    },
    evidence_export_paths: [artifactPaths.evidenceExport],
    controller_trace_paths: [
      artifactPaths.roleTrace,
      artifactPaths.editDecisions,
      artifactPaths.commitDecisions,
      artifactPaths.patches
    ],
    validation_report_paths: [artifactPaths.validation],
    artifact_hashes: hashEntries
  };
  await writeJson(artifactPaths.manifest, manifest);
  return {
    manifest,
    artifact_paths: artifactPaths
  };
}

export async function runProposalGraphSession(input = {}) {
  const runId = compactText(input.run_id || input.runId) || deterministicId('proposal-run', {
    problem: input.problem,
    target_domain: input.targetDomain || input.target_domain
  }, 12);
  const sessionInput = {
    run_id: runId,
    problem: compactText(input.problem),
    target_domain: compactText(input.targetDomain || input.target_domain),
    max_rounds: Math.max(1, Math.floor(Number(input.maxRounds || input.max_rounds || 3))),
    temporal_cutoff: compactText(input.temporalCutoff || input.temporal_cutoff),
    allow_live_discovery: Boolean(input.allowLiveDiscovery || input.allow_live_discovery),
    allow_imports: Boolean(input.allowImports || input.allow_imports)
  };
  let graph = createProposalGraph({
    run_id: runId,
    problem: sessionInput.problem,
    target_domain: sessionInput.target_domain,
    temporal_cutoff: sessionInput.temporal_cutoff,
    evidence_refs: input.evidenceRefs || input.evidence_refs || []
  });
  const roleTrace = [];
  const patches = [];
  const editDecisions = [];
  const commitDecisions = [];
  const roleRunners = asArray(input.roleRunners || input.role_runners);
  const initialActions = asArray(input.proposalActions || input.proposal_actions || input.actions);
  const configuredSlates = input.proposalSlates
    || input.proposal_slates
    || input.fixtureSlates
    || input.fixture_slates;
  let proposalBundle = null;
  let finalStatus = 'diagnosis';

  for (let round = 0; round < sessionInput.max_rounds; round += 1) {
    const roundId = `round-${String(round).padStart(3, '0')}`;
    const snapshot = createGraphSnapshot(graph, { round: graph.round || round });
    const rawSlates = [];
    for (const runner of roleRunners) {
      rawSlates.push(await runner({
        round_id: roundId,
        snapshot,
        graph: snapshot,
        input: sessionInput
      }));
    }
    if (round === 0 && initialActions.length) {
      rawSlates.push(hydrateSlateForSnapshot({
        round_id: roundId,
        snapshot_id: snapshot.snapshot_id,
        role_id: compactText(input.proposalRoleId || input.proposal_role_id || input.role_id || input.roleId) || 'InitialProposalActions',
        actions: initialActions
      }, snapshot, roundId));
    }
    rawSlates.push(...slatesForRound(configuredSlates, round, roundId)
      .map((slate) => hydrateSlateForSnapshot(slate, snapshot, roundId)));
    const validationResults = validateRoleSlates(rawSlates, snapshot);
    const selection = selectProposalActions(validationResults, { round_id: roundId });
    roleTrace.push(...validationResults.map((result) => ({
      ...result,
      edit_decision_id: selection.edit_decision_id
    })));
    editDecisions.push(...selection.decisions);
    const merged = mergeValidatedActions(snapshot, selection.accepted_actions, {
      round_id: roundId,
      edit_decision_id: selection.edit_decision_id
    });
    graph = merged.graph;
    patches.push(merged.patch);
    const commitDecision = evaluateProposalCommit(graph, { round_id: roundId });
    commitDecisions.push(commitDecision);
    if (commitDecision.status === 'committed') {
      graph = markProposalGraphCommitted(graph, commitDecision);
      proposalBundle = synthesizeProposalBundle(graph, {
        commitDecision,
        evidenceExport: input.evidenceExport || input.evidence_export || {}
      });
      finalStatus = 'committed';
      break;
    }
  }

  const validationReport = {
    graph: validateProposalGraph(graph),
    final_commit_decision: commitDecisions[commitDecisions.length - 1] || null
  };
  const state = {
    input: sessionInput,
    graph,
    role_trace: roleTrace,
    patches,
    edit_decisions: editDecisions,
    commit_decisions: commitDecisions,
    validation_report: validationReport,
    evidence_export: input.evidenceExport || input.evidence_export || {
      evidence_export_version: 'papernexus-proposal-evidence-export-v1',
      evidence_refs: input.evidenceRefs || input.evidence_refs || []
    },
    proposal_bundle: proposalBundle,
    final_status: finalStatus,
    round_count: commitDecisions.length
  };

  if (input.outputDir || input.output_dir) {
    const artifactResult = await writeSessionArtifacts(input.outputDir || input.output_dir, state);
    return {
      ...state,
      ...artifactResult
    };
  }

  return state;
}
