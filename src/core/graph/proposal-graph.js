import { stableHash, unique } from '../../lib/utils.js';

export const PROPOSAL_GRAPH_SCHEMA_VERSION = 'papernexus-proposal-graph-v1';
export const PROPOSAL_PATCH_CONTRACT_VERSION = 'papernexus-proposal-patch-v1';

export const PROPOSAL_NODE_TYPES = Object.freeze({
  PROBLEM: 'Problem',
  RESEARCH_QUESTION: 'ResearchQuestion',
  HYPOTHESIS: 'Hypothesis',
  MECHANISM: 'Mechanism',
  METHOD: 'Method',
  COMPONENT: 'Component',
  ASSUMPTION: 'Assumption',
  RISK: 'Risk',
  NOVELTY_CLAIM: 'NoveltyClaim',
  EVIDENCE_NEED: 'EvidenceNeed',
  EVIDENCE_ATTACHMENT: 'EvidenceAttachment',
  EVAL_PLAN: 'EvalPlan',
  REPAIR: 'Repair',
  STORY_BEAT: 'StoryBeat'
});

export const PROPOSAL_EDGE_TYPES = Object.freeze({
  SUPPORTS: 'supports',
  CONTRADICTS: 'contradicts',
  DEPENDS_ON: 'depends_on',
  REQUIRES_EVIDENCE: 'requires_evidence',
  REPAIRS: 'repairs',
  REFINES: 'refines',
  TRANSFERS_FROM: 'transfers_from',
  OVERLAPS_PRIOR: 'overlaps_prior',
  EVALUATED_BY: 'evaluated_by',
  FALSIFIED_BY: 'falsified_by',
  GROUNDED_IN: 'grounded_in',
  MUST_CITE: 'must_cite',
  STORYLINE_NEXT: 'storyline_next'
});

export const PROPOSAL_ACTION_TYPES = Object.freeze({
  ADD_NODE: 'add_node',
  ADD_EDGE: 'add_edge',
  ATTACH_EVIDENCE: 'attach_evidence',
  ADD_SUPPORT_EDGE: 'add_support_edge',
  ADD_CONTRADICTION_EDGE: 'add_contradiction_edge',
  ADD_DEPENDENCY_EDGE: 'add_dependency_edge',
  ADD_PRIOR_OVERLAP: 'add_prior_overlap',
  PROPOSE_REPAIR: 'propose_repair',
  REVISE_NODE_TEXT: 'revise_node_text',
  NARROW_CLAIM: 'narrow_claim',
  ADD_EVAL_PLAN: 'add_eval_plan',
  ADD_FALSIFIER: 'add_falsifier',
  MARK_SPECULATIVE: 'mark_speculative',
  REJECT_CLAIM: 'reject_claim',
  SKIP: 'skip'
});

export const CLAIM_LABELS = Object.freeze({
  EVIDENCE_SUPPORTED: 'evidence-supported',
  AGENT_INFERRED: 'agent-inferred',
  SPECULATIVE: 'speculative',
  REJECTED: 'rejected'
});

const NODE_TYPE_SET = new Set(Object.values(PROPOSAL_NODE_TYPES));
const EDGE_TYPE_SET = new Set(Object.values(PROPOSAL_EDGE_TYPES));
const ACTION_TYPE_SET = new Set(Object.values(PROPOSAL_ACTION_TYPES));

const EDGE_RULES = {
  [PROPOSAL_EDGE_TYPES.GROUNDED_IN]: {
    targetTypes: [PROPOSAL_NODE_TYPES.EVIDENCE_ATTACHMENT]
  },
  [PROPOSAL_EDGE_TYPES.MUST_CITE]: {
    targetTypes: [PROPOSAL_NODE_TYPES.EVIDENCE_ATTACHMENT]
  },
  [PROPOSAL_EDGE_TYPES.EVALUATED_BY]: {
    targetTypes: [PROPOSAL_NODE_TYPES.EVAL_PLAN]
  },
  [PROPOSAL_EDGE_TYPES.FALSIFIED_BY]: {
    targetTypes: [PROPOSAL_NODE_TYPES.EVAL_PLAN]
  },
  [PROPOSAL_EDGE_TYPES.REPAIRS]: {
    sourceTypes: [PROPOSAL_NODE_TYPES.REPAIR]
  },
  [PROPOSAL_EDGE_TYPES.STORYLINE_NEXT]: {
    sourceTypes: [PROPOSAL_NODE_TYPES.STORY_BEAT],
    targetTypes: [PROPOSAL_NODE_TYPES.STORY_BEAT]
  }
};

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = canonicalize(value[key]);
    return acc;
  }, {});
}

function contentHash(value, length = 20) {
  return stableHash(JSON.stringify(canonicalize(value)), length);
}

function deterministicId(prefix, payload, length = 18) {
  return `${prefix}:${contentHash(payload, length)}`;
}

function normalizeProvenance(provenance = [], fallback = null) {
  const entries = asArray(provenance)
    .map((entry) => (entry && typeof entry === 'object' ? entry : null))
    .filter(Boolean);
  if (!entries.length && fallback) return [fallback];
  return entries;
}

function normalizeProperties(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

export function normalizeEvidenceRef(ref = {}, index = 0) {
  const evidenceId = compactText(
    ref.evidence_id
    || ref.evidenceId
    || ref.source_span_id
    || ref.sourceSpanId
    || ref.span_id
    || ref.spanId
    || ref.paper_id
    || ref.paperId
    || ref.paper_key
    || ref.paperKey
    || ref.id
  ) || deterministicId('evidence', { ref, index }, 16);

  return {
    evidence_id: evidenceId,
    source_span_id: compactText(ref.source_span_id || ref.sourceSpanId || ref.span_id || ref.spanId),
    paper_id: compactText(ref.paper_id || ref.paperId || ref.paper_key || ref.paperKey),
    paper_title: compactText(ref.paper_title || ref.paperTitle || ref.title),
    citation_context: compactText(ref.citation_context || ref.citationContext || ref.snippet || ref.text),
    evidence_tier: compactText(ref.evidence_tier || ref.evidenceTier || ref.tier || 'moderate'),
    url: compactText(ref.url || ref.source_url || ref.sourceUrl),
    provenance: normalizeProvenance(ref.provenance, {
      kind: 'evidence_ref',
      ref: evidenceId
    })
  };
}

export function normalizeProposalNode(node = {}, fallback = {}) {
  const type = compactText(node.type || fallback.type);
  const title = compactText(node.title || node.label || node.name || fallback.title || fallback.label);
  const text = compactText(node.text || node.description || fallback.text || title);
  const id = compactText(node.id) || deterministicId(`node:${type || 'unknown'}`, { type, title, text, properties: node.properties });
  return {
    id,
    type,
    title: title || id,
    text: text || title || id,
    status: compactText(node.status || fallback.status || 'active'),
    claim_label: compactText(node.claim_label || node.claimLabel || fallback.claim_label || fallback.claimLabel),
    severity: compactText(node.severity || fallback.severity),
    properties: normalizeProperties({ ...(fallback.properties || {}), ...(node.properties || {}) }),
    provenance: normalizeProvenance(node.provenance, fallback.provenance?.[0] || {
      kind: 'deterministic_fallback',
      reason: 'node-normalization'
    })
  };
}

export function normalizeProposalEdge(edge = {}, fallback = {}) {
  const type = compactText(edge.type || fallback.type);
  const source = compactText(edge.source || edge.source_id || edge.sourceId || fallback.source);
  const target = compactText(edge.target || edge.target_id || edge.targetId || fallback.target);
  const id = compactText(edge.id) || deterministicId(`edge:${type || 'unknown'}`, { type, source, target, label: edge.label });
  return {
    id,
    type,
    source,
    target,
    label: compactText(edge.label || fallback.label),
    status: compactText(edge.status || fallback.status || 'active'),
    properties: normalizeProperties({ ...(fallback.properties || {}), ...(edge.properties || {}) }),
    provenance: normalizeProvenance(edge.provenance, fallback.provenance?.[0] || {
      kind: 'deterministic_fallback',
      reason: 'edge-normalization'
    })
  };
}

export function createProposalGraph(input = {}) {
  const runId = compactText(input.run_id || input.runId) || deterministicId('proposal-run', {
    problem: input.problem,
    targetDomain: input.targetDomain || input.target_domain
  }, 12);
  const targetDomain = compactText(input.targetDomain || input.target_domain);
  const problemText = compactText(input.problem || input.title || 'Unspecified research problem');
  const problemNode = normalizeProposalNode({
    id: compactText(input.problemNodeId) || deterministicId('problem', { problemText, targetDomain }, 14),
    type: PROPOSAL_NODE_TYPES.PROBLEM,
    title: problemText,
    text: problemText,
    properties: {
      target_domain: targetDomain,
      temporal_cutoff: compactText(input.temporalCutoff || input.temporal_cutoff)
    },
    provenance: [{
      kind: 'user_input',
      ref: 'problem'
    }]
  });
  const evidenceNodes = asArray(input.evidenceRefs || input.evidence_refs)
    .map((ref, index) => evidenceRefToNode(normalizeEvidenceRef(ref, index)));
  const graph = {
    schema_version: PROPOSAL_GRAPH_SCHEMA_VERSION,
    run_id: runId,
    round: 0,
    status: 'draft',
    problem_node_id: problemNode.id,
    committed_subgraph_id: null,
    nodes: [problemNode, ...evidenceNodes],
    edges: [],
    metadata: {
      target_domain: targetDomain,
      created_at: compactText(input.createdAt || input.created_at) || new Date(0).toISOString()
    }
  };
  return createGraphSnapshot(graph, { round: 0 });
}

export function evidenceRefToNode(ref = {}) {
  const normalized = normalizeEvidenceRef(ref);
  return normalizeProposalNode({
    id: normalized.evidence_id.startsWith('evidence:')
      ? normalized.evidence_id
      : `evidence:${contentHash(normalized.evidence_id, 14)}`,
    type: PROPOSAL_NODE_TYPES.EVIDENCE_ATTACHMENT,
    title: normalized.paper_title || normalized.paper_id || normalized.evidence_id,
    text: normalized.citation_context || normalized.paper_title || normalized.evidence_id,
    properties: normalized,
    provenance: normalized.provenance
  });
}

export function sortProposalGraph(graph = {}) {
  return {
    ...graph,
    nodes: [...asArray(graph.nodes)].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    edges: [...asArray(graph.edges)].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  };
}

export function proposalGraphHash(graph = {}) {
  const sorted = sortProposalGraph(graph);
  return contentHash({
    schema_version: sorted.schema_version,
    run_id: sorted.run_id,
    round: sorted.round,
    status: sorted.status,
    committed_subgraph_id: sorted.committed_subgraph_id || null,
    nodes: sorted.nodes,
    edges: sorted.edges
  }, 24);
}

export function createGraphSnapshot(graph = {}, options = {}) {
  const round = Number.isFinite(Number(options.round)) ? Number(options.round) : Number(graph.round || 0);
  const sorted = sortProposalGraph({
    ...graph,
    round
  });
  const graphHash = proposalGraphHash(sorted);
  return {
    ...sorted,
    graph_hash: graphHash,
    snapshot_id: compactText(options.snapshotId || options.snapshot_id) || `snapshot:${round}:${graphHash}`
  };
}

function nodeById(graph = {}) {
  return new Map(asArray(graph.nodes).map((node) => [node.id, node]));
}

function edgeById(graph = {}) {
  return new Map(asArray(graph.edges).map((edge) => [edge.id, edge]));
}

function validateEdgeCompatibility(edge, nodes) {
  const errors = [];
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  const rule = EDGE_RULES[edge.type];
  if (!rule) return errors;
  if (rule.sourceTypes && !rule.sourceTypes.includes(source?.type)) {
    errors.push(`Edge ${edge.id} type ${edge.type} cannot start from ${source?.type || '<missing>'}.`);
  }
  if (rule.targetTypes && !rule.targetTypes.includes(target?.type)) {
    errors.push(`Edge ${edge.id} type ${edge.type} cannot target ${target?.type || '<missing>'}.`);
  }
  return errors;
}

export function validateProposalGraph(graph = {}) {
  const errors = [];
  if (graph.schema_version !== PROPOSAL_GRAPH_SCHEMA_VERSION) {
    errors.push(`Unsupported proposal graph schema ${graph.schema_version || '<missing>'}.`);
  }
  const nodes = nodeById(graph);
  const seenNodes = new Set();
  for (const node of asArray(graph.nodes)) {
    if (!node.id) errors.push('Node is missing id.');
    if (seenNodes.has(node.id)) errors.push(`Duplicate node id ${node.id}.`);
    seenNodes.add(node.id);
    if (!NODE_TYPE_SET.has(node.type)) errors.push(`Invalid node type ${node.type || '<missing>'} for ${node.id || '<missing>'}.`);
    if (!asArray(node.provenance).length) errors.push(`Node ${node.id || '<missing>'} is missing provenance.`);
  }

  const seenEdges = new Set();
  for (const edge of asArray(graph.edges)) {
    if (!edge.id) errors.push('Edge is missing id.');
    if (seenEdges.has(edge.id)) errors.push(`Duplicate edge id ${edge.id}.`);
    seenEdges.add(edge.id);
    if (!EDGE_TYPE_SET.has(edge.type)) errors.push(`Invalid edge type ${edge.type || '<missing>'} for ${edge.id || '<missing>'}.`);
    if (!nodes.has(edge.source)) errors.push(`Edge ${edge.id || '<missing>'} source ${edge.source || '<missing>'} does not exist.`);
    if (!nodes.has(edge.target)) errors.push(`Edge ${edge.id || '<missing>'} target ${edge.target || '<missing>'} does not exist.`);
    if (!asArray(edge.provenance).length) errors.push(`Edge ${edge.id || '<missing>'} is missing provenance.`);
    errors.push(...validateEdgeCompatibility(edge, nodes));
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

function normalizeAction(action = {}, slate = {}, index = 0) {
  const actionType = compactText(action.type || action.action_type || (slate.skip ? PROPOSAL_ACTION_TYPES.SKIP : ''));
  const actionId = compactText(action.action_id || action.actionId || action.id) || deterministicId('action', {
    round_id: slate.round_id,
    snapshot_id: slate.snapshot_id,
    role_id: slate.role_id,
    action,
    index
  }, 16);
  return {
    ...action,
    action_id: actionId,
    type: actionType,
    round_id: compactText(action.round_id || action.roundId || slate.round_id),
    snapshot_id: compactText(action.snapshot_id || action.snapshotId || slate.snapshot_id),
    role_id: compactText(action.role_id || action.roleId || slate.role_id)
  };
}

function validateActionAgainstGraph(action, graph, plannedNodeIds = new Set()) {
  const errors = [];
  const nodes = nodeById(graph);
  const hasNodeRef = (nodeId) => nodes.has(nodeId) || plannedNodeIds.has(nodeId);
  if (!ACTION_TYPE_SET.has(action.type)) errors.push(`Unsupported action type ${action.type || '<missing>'}.`);
  if (action.snapshot_id && action.snapshot_id !== graph.snapshot_id) {
    errors.push(`Action ${action.action_id} targets stale snapshot ${action.snapshot_id}; expected ${graph.snapshot_id}.`);
  }

  const targetId = compactText(action.target_id || action.targetId || action.target);
  const sourceId = compactText(action.source_id || action.sourceId || action.source);
  const requireTarget = () => {
    if (!targetId || !hasNodeRef(targetId)) errors.push(`Action ${action.action_id} references missing target ${targetId || '<missing>'}.`);
  };
  const requirePair = () => {
    if (!sourceId || !hasNodeRef(sourceId)) errors.push(`Action ${action.action_id} references missing source ${sourceId || '<missing>'}.`);
    requireTarget();
  };

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_NODE) {
    const node = normalizeProposalNode(action.node || action.payload || {}, {
      provenance: [{ kind: 'role_action', action_id: action.action_id, role_id: action.role_id }]
    });
    if (!NODE_TYPE_SET.has(node.type)) errors.push(`Action ${action.action_id} adds invalid node type ${node.type || '<missing>'}.`);
  } else if (action.type === PROPOSAL_ACTION_TYPES.ADD_EDGE) {
    const edge = normalizeProposalEdge(action.edge || action.payload || {}, {
      source: sourceId,
      target: targetId,
      provenance: [{ kind: 'role_action', action_id: action.action_id, role_id: action.role_id }]
    });
    if (!EDGE_TYPE_SET.has(edge.type)) errors.push(`Action ${action.action_id} adds invalid edge type ${edge.type || '<missing>'}.`);
    if (!edge.source || !hasNodeRef(edge.source)) {
      errors.push(`Action ${action.action_id} references missing source ${edge.source || '<missing>'}.`);
    }
    if (!edge.target || !hasNodeRef(edge.target)) {
      errors.push(`Action ${action.action_id} references missing target ${edge.target || '<missing>'}.`);
    }
  } else if ([
    PROPOSAL_ACTION_TYPES.ADD_SUPPORT_EDGE,
    PROPOSAL_ACTION_TYPES.ADD_CONTRADICTION_EDGE,
    PROPOSAL_ACTION_TYPES.ADD_DEPENDENCY_EDGE
  ].includes(action.type)) {
    requirePair();
  } else if ([
    PROPOSAL_ACTION_TYPES.ATTACH_EVIDENCE,
    PROPOSAL_ACTION_TYPES.ADD_PRIOR_OVERLAP,
    PROPOSAL_ACTION_TYPES.PROPOSE_REPAIR,
    PROPOSAL_ACTION_TYPES.REVISE_NODE_TEXT,
    PROPOSAL_ACTION_TYPES.NARROW_CLAIM,
    PROPOSAL_ACTION_TYPES.ADD_EVAL_PLAN,
    PROPOSAL_ACTION_TYPES.ADD_FALSIFIER,
    PROPOSAL_ACTION_TYPES.MARK_SPECULATIVE,
    PROPOSAL_ACTION_TYPES.REJECT_CLAIM
  ].includes(action.type)) {
    requireTarget();
  }

  return errors;
}

export function validateActionSlate(slate = {}, graph = {}) {
  const slateId = compactText(slate.slate_id || slate.slateId) || deterministicId('slate', {
    round_id: slate.round_id,
    snapshot_id: slate.snapshot_id,
    role_id: slate.role_id,
    actions: slate.actions,
    skip: slate.skip
  }, 16);
  const errors = [];
  if (!compactText(slate.round_id || slate.roundId)) errors.push(`Slate ${slateId} is missing round_id.`);
  if (!compactText(slate.role_id || slate.roleId)) errors.push(`Slate ${slateId} is missing role_id.`);
  const snapshotId = compactText(slate.snapshot_id || slate.snapshotId);
  if (snapshotId !== graph.snapshot_id) {
    errors.push(`Slate ${slateId} targets snapshot ${snapshotId || '<missing>'}; expected ${graph.snapshot_id}.`);
  }

  const rawActions = slate.skip ? [] : asArray(slate.actions);
  const plannedNodeIds = new Set(rawActions
    .filter((action) => compactText(action.type || action.action_type) === PROPOSAL_ACTION_TYPES.ADD_NODE)
    .map((action) => normalizeProposalNode(action.node || action.payload || {}).id)
    .filter(Boolean));
  const validActions = [];
  const invalidActions = [];
  rawActions.forEach((rawAction, index) => {
    const action = normalizeAction(rawAction, {
      round_id: compactText(slate.round_id || slate.roundId),
      snapshot_id: snapshotId,
      role_id: compactText(slate.role_id || slate.roleId)
    }, index);
    const actionErrors = validateActionAgainstGraph(action, graph, plannedNodeIds);
    if (actionErrors.length) {
      invalidActions.push({
        action,
        errors: actionErrors
      });
    } else {
      validActions.push(action);
    }
  });

  return {
    slate_id: slateId,
    round_id: compactText(slate.round_id || slate.roundId),
    snapshot_id: snapshotId,
    role_id: compactText(slate.role_id || slate.roleId),
    role_version: compactText(slate.role_version || slate.roleVersion),
    skip: Boolean(slate.skip),
    self_reported_confidence: Number.isFinite(Number(slate.self_reported_confidence ?? slate.selfReportedConfidence))
      ? Number(slate.self_reported_confidence ?? slate.selfReportedConfidence)
      : null,
    evidence_refs: asArray(slate.evidence_refs || slate.evidenceRefs),
    guardrail_flags: asArray(slate.guardrail_flags || slate.guardrailFlags),
    valid: errors.length === 0 && invalidActions.length === 0,
    errors,
    valid_actions: validActions,
    invalid_actions: invalidActions
  };
}

function actionProvenance(action, decisionId = '') {
  return [{
    kind: 'role_action',
    action_id: action.action_id,
    role_id: action.role_id,
    round_id: action.round_id,
    controller_decision_id: decisionId
  }];
}

function appendNode(graph, node, patch) {
  const existing = nodeById(graph).get(node.id);
  if (existing) {
    graph.nodes = graph.nodes.map((item) => item.id === node.id
      ? {
          ...item,
          provenance: unique([
            ...asArray(item.provenance).map((entry) => JSON.stringify(entry)),
            ...asArray(node.provenance).map((entry) => JSON.stringify(entry))
          ]).map((entry) => JSON.parse(entry))
        }
      : item);
    patch.reused_node_ids.push(node.id);
    return node.id;
  }
  graph.nodes.push(node);
  patch.added_node_ids.push(node.id);
  return node.id;
}

function appendEdge(graph, edge, patch) {
  const existing = edgeById(graph).get(edge.id);
  if (existing) {
    patch.reused_edge_ids.push(edge.id);
    return edge.id;
  }
  graph.edges.push(edge);
  patch.added_edge_ids.push(edge.id);
  return edge.id;
}

function createEvidenceNodeForAction(action, patch) {
  const evidenceRef = normalizeEvidenceRef(action.evidence_ref || action.evidenceRef || action.evidence || {}, 0);
  const node = evidenceRefToNode(evidenceRef);
  node.provenance = actionProvenance(action, patch.edit_decision_id);
  return node;
}

function createEdgeForAction(action, type, source, target, patch, properties = {}) {
  return normalizeProposalEdge({
    type,
    source,
    target,
    properties,
    provenance: actionProvenance(action, patch.edit_decision_id)
  });
}

function patchNode(graph, targetId, patchFn, patch) {
  graph.nodes = graph.nodes.map((node) => {
    if (node.id !== targetId) return node;
    const updated = patchFn(node);
    patch.updated_node_ids.push(targetId);
    return updated;
  });
}

function applyAction(nextGraph, action, patch, seenTextRevisionTargets) {
  const targetId = compactText(action.target_id || action.targetId || action.target);
  const sourceId = compactText(action.source_id || action.sourceId || action.source);
  const properties = normalizeProperties(action.properties || action.payload?.properties);

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_NODE) {
    appendNode(nextGraph, normalizeProposalNode(action.node || action.payload || {}, {
      provenance: actionProvenance(action, patch.edit_decision_id)
    }), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_EDGE) {
    appendEdge(nextGraph, normalizeProposalEdge(action.edge || action.payload || {}, {
      source: sourceId,
      target: targetId,
      provenance: actionProvenance(action, patch.edit_decision_id)
    }), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ATTACH_EVIDENCE || action.type === PROPOSAL_ACTION_TYPES.ADD_PRIOR_OVERLAP) {
    const evidenceNode = createEvidenceNodeForAction(action, patch);
    appendNode(nextGraph, evidenceNode, patch);
    appendEdge(nextGraph, createEdgeForAction(
      action,
      action.type === PROPOSAL_ACTION_TYPES.ADD_PRIOR_OVERLAP ? PROPOSAL_EDGE_TYPES.OVERLAPS_PRIOR : PROPOSAL_EDGE_TYPES.GROUNDED_IN,
      targetId,
      evidenceNode.id,
      patch,
      properties
    ), patch);
    if (action.must_cite || action.mustCite) {
      appendEdge(nextGraph, createEdgeForAction(action, PROPOSAL_EDGE_TYPES.MUST_CITE, targetId, evidenceNode.id, patch), patch);
    }
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_SUPPORT_EDGE) {
    appendEdge(nextGraph, createEdgeForAction(action, PROPOSAL_EDGE_TYPES.SUPPORTS, sourceId, targetId, patch, properties), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_CONTRADICTION_EDGE) {
    appendEdge(nextGraph, createEdgeForAction(action, PROPOSAL_EDGE_TYPES.CONTRADICTS, sourceId, targetId, patch, properties), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_DEPENDENCY_EDGE) {
    appendEdge(nextGraph, createEdgeForAction(action, PROPOSAL_EDGE_TYPES.DEPENDS_ON, sourceId, targetId, patch, properties), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.ADD_EVAL_PLAN || action.type === PROPOSAL_ACTION_TYPES.ADD_FALSIFIER) {
    const plan = normalizeProposalNode(action.eval_plan || action.evalPlan || action.plan || action.payload || {}, {
      type: PROPOSAL_NODE_TYPES.EVAL_PLAN,
      title: action.type === PROPOSAL_ACTION_TYPES.ADD_FALSIFIER ? 'Falsification plan' : 'Evaluation plan',
      properties: {
        ...(action.type === PROPOSAL_ACTION_TYPES.ADD_FALSIFIER ? { falsifier: true } : {})
      },
      provenance: actionProvenance(action, patch.edit_decision_id)
    });
    appendNode(nextGraph, plan, patch);
    appendEdge(nextGraph, createEdgeForAction(
      action,
      action.type === PROPOSAL_ACTION_TYPES.ADD_FALSIFIER ? PROPOSAL_EDGE_TYPES.FALSIFIED_BY : PROPOSAL_EDGE_TYPES.EVALUATED_BY,
      targetId,
      plan.id,
      patch,
      properties
    ), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.PROPOSE_REPAIR) {
    const repair = normalizeProposalNode(action.repair || action.payload || {}, {
      type: PROPOSAL_NODE_TYPES.REPAIR,
      title: compactText(action.title) || 'Repair proposal',
      text: compactText(action.text || action.reason) || 'Repair proposed by role action.',
      provenance: actionProvenance(action, patch.edit_decision_id)
    });
    appendNode(nextGraph, repair, patch);
    appendEdge(nextGraph, createEdgeForAction(action, PROPOSAL_EDGE_TYPES.REPAIRS, repair.id, targetId, patch, properties), patch);
    return;
  }

  if ([PROPOSAL_ACTION_TYPES.REVISE_NODE_TEXT, PROPOSAL_ACTION_TYPES.NARROW_CLAIM].includes(action.type)) {
    if (seenTextRevisionTargets.has(targetId)) {
      patch.conflicts.push({
        action_id: action.action_id,
        target_id: targetId,
        reason: 'conflicting_text_revision'
      });
      return;
    }
    seenTextRevisionTargets.add(targetId);
    const nextText = compactText(action.text || action.new_text || action.newText || action.narrowed_text || action.narrowedText);
    patchNode(nextGraph, targetId, (node) => ({
      ...node,
      text: nextText || node.text,
      properties: {
        ...node.properties,
        previous_text: node.text,
        revision_action_id: action.action_id,
        ...(action.type === PROPOSAL_ACTION_TYPES.NARROW_CLAIM ? { narrowed: true } : {})
      },
      provenance: [...asArray(node.provenance), ...actionProvenance(action, patch.edit_decision_id)]
    }), patch);
    return;
  }

  if (action.type === PROPOSAL_ACTION_TYPES.MARK_SPECULATIVE || action.type === PROPOSAL_ACTION_TYPES.REJECT_CLAIM) {
    patchNode(nextGraph, targetId, (node) => ({
      ...node,
      status: action.type === PROPOSAL_ACTION_TYPES.REJECT_CLAIM ? 'rejected' : node.status,
      claim_label: action.type === PROPOSAL_ACTION_TYPES.REJECT_CLAIM ? CLAIM_LABELS.REJECTED : CLAIM_LABELS.SPECULATIVE,
      properties: {
        ...node.properties,
        label_reason: compactText(action.reason || action.rationale)
      },
      provenance: [...asArray(node.provenance), ...actionProvenance(action, patch.edit_decision_id)]
    }), patch);
  }
}

export function mergeValidatedActions(graph = {}, actions = [], options = {}) {
  const beforeGraph = createGraphSnapshot(graph, { round: graph.round || 0 });
  const patch = {
    patch_contract_version: PROPOSAL_PATCH_CONTRACT_VERSION,
    patch_id: deterministicId('proposal-patch', {
      snapshot_id: beforeGraph.snapshot_id,
      actions: actions.map((action) => action.action_id)
    }, 16),
    round_id: compactText(options.round_id || options.roundId),
    edit_decision_id: compactText(options.edit_decision_id || options.editDecisionId),
    before_snapshot_id: beforeGraph.snapshot_id,
    before_graph_hash: beforeGraph.graph_hash,
    selected_action_ids: actions.map((action) => action.action_id),
    added_node_ids: [],
    reused_node_ids: [],
    updated_node_ids: [],
    added_edge_ids: [],
    reused_edge_ids: [],
    conflicts: []
  };
  const nextGraph = {
    ...beforeGraph,
    round: Number(beforeGraph.round || 0) + 1,
    nodes: beforeGraph.nodes.map((node) => ({ ...node, properties: { ...node.properties }, provenance: [...asArray(node.provenance)] })),
    edges: beforeGraph.edges.map((edge) => ({ ...edge, properties: { ...edge.properties }, provenance: [...asArray(edge.provenance)] })),
    metadata: { ...(beforeGraph.metadata || {}) }
  };
  const seenTextRevisionTargets = new Set();
  const actionOrder = (action) => (action.type === PROPOSAL_ACTION_TYPES.ADD_NODE ? 0 : 1);
  const sortedActions = [...actions].sort((left, right) => (
    actionOrder(left) - actionOrder(right)
    || String(left.action_id).localeCompare(String(right.action_id))
  ));
  for (const action of sortedActions) {
    applyAction(nextGraph, action, patch, seenTextRevisionTargets);
  }
  const afterGraph = createGraphSnapshot(nextGraph, { round: nextGraph.round });
  patch.after_snapshot_id = afterGraph.snapshot_id;
  patch.after_graph_hash = afterGraph.graph_hash;
  const validation = validateProposalGraph(afterGraph);
  patch.validation = validation;
  return {
    graph: afterGraph,
    patch
  };
}

export function markProposalGraphCommitted(graph = {}, decision = {}) {
  const committedSubgraphId = compactText(decision.committed_subgraph_id)
    || deterministicId('committed-subgraph', { graph_hash: graph.graph_hash }, 14);
  return createGraphSnapshot({
    ...graph,
    status: 'committed',
    committed_subgraph_id: committedSubgraphId,
    metadata: {
      ...(graph.metadata || {}),
      committed_at_round_id: decision.round_id || null,
      commit_decision_id: decision.commit_decision_id || null
    }
  }, {
    round: graph.round || 0
  });
}

export function activeNodesByType(graph = {}, type) {
  return asArray(graph.nodes).filter((node) => node.type === type && node.status !== 'rejected');
}

export function activeEdgesByType(graph = {}, type) {
  return asArray(graph.edges).filter((edge) => edge.type === type && edge.status !== 'rejected');
}
