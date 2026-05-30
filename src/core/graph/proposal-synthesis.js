import {
  CLAIM_LABELS,
  PROPOSAL_EDGE_TYPES,
  PROPOSAL_NODE_TYPES,
  activeEdgesByType,
  activeNodesByType
} from './proposal-graph.js';

export const PROPOSAL_BUNDLE_VERSION = 'papernexus-full-paper-idea-proposal-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstNode(graph, type) {
  return activeNodesByType(graph, type)[0] || null;
}

function textOf(node, fallback = '') {
  return compactText(node?.text || node?.title || fallback);
}

function nodeMap(graph = {}) {
  return new Map(asArray(graph.nodes).map((node) => [node.id, node]));
}

function evidenceForNode(graph = {}, nodeId = '') {
  const nodes = nodeMap(graph);
  const grounded = activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.GROUNDED_IN)
    .filter((edge) => edge.source === nodeId)
    .map((edge) => nodes.get(edge.target))
    .filter(Boolean);
  const mustCite = activeEdgesByType(graph, PROPOSAL_EDGE_TYPES.MUST_CITE)
    .filter((edge) => edge.source === nodeId)
    .map((edge) => nodes.get(edge.target))
    .filter(Boolean);
  return [...grounded, ...mustCite]
    .filter((node, index, all) => node?.id && all.findIndex((entry) => entry.id === node.id) === index);
}

function nodeClaimLabel(node = {}) {
  return compactText(node.claim_label || node.properties?.claim_label || CLAIM_LABELS.AGENT_INFERRED)
    || CLAIM_LABELS.AGENT_INFERRED;
}

function evalPlanJson(node = {}) {
  const props = node.properties || {};
  return {
    title: node.title,
    datasets: asArray(props.datasets || props.data_requirements || props.dataRequirements),
    baselines: asArray(props.baselines),
    metrics: asArray(props.metrics),
    ablations: asArray(props.ablations),
    leakage_controls: asArray(props.leakage_controls || props.leakageControls),
    falsification_condition: compactText(props.falsification_condition || props.falsificationCondition),
    claim_label: nodeClaimLabel(node)
  };
}

function evidenceJson(node = {}) {
  const props = node.properties || {};
  return {
    evidence_id: props.evidence_id || node.id,
    source_span_id: props.source_span_id || '',
    paper_id: props.paper_id || '',
    paper_title: props.paper_title || node.title || '',
    citation_context: props.citation_context || node.text || '',
    evidence_tier: props.evidence_tier || 'moderate',
    url: props.url || ''
  };
}

function buildAbstract({ problem, hypothesis, method, mechanism }) {
  return compactText(
    `This proposal addresses ${textOf(problem, 'the target problem')} by testing ${textOf(hypothesis, 'a falsifiable hypothesis')}. `
    + `It proposes ${textOf(method, 'a method')} using ${textOf(mechanism, 'a transfer mechanism')} and keeps unsupported claims explicit.`
  );
}

function buildMarkdown(proposal) {
  const lines = [
    `# ${proposal.working_title}`,
    '',
    '## Abstract',
    proposal.abstract,
    '',
    '## Problem And Target Domain',
    proposal.problem_and_target_domain,
    '',
    '## Core Hypothesis',
    `${proposal.core_hypothesis.text} [${proposal.core_hypothesis.claim_label}]`,
    '',
    '## Proposed Method',
    proposal.proposed_method.text,
    '',
    '## Mechanism Of Expected Improvement',
    proposal.mechanism_of_expected_improvement.text,
    '',
    '## Novelty Contrast',
    proposal.novelty_contrast.text,
    '',
    '## Expected Contributions',
    ...proposal.expected_contributions.map((entry) => `- ${entry.text} [${entry.claim_label}]`),
    '',
    '## Evaluation Plan',
    ...proposal.evaluation_plan.map((entry) => (
      `- ${entry.title}: datasets=${entry.datasets.join(', ') || 'TBD'}; baselines=${entry.baselines.join(', ') || 'TBD'}; metrics=${entry.metrics.join(', ') || 'TBD'}; ablations=${entry.ablations.join(', ') || 'TBD'}; leakage_controls=${entry.leakage_controls.join(', ') || 'TBD'}; falsifier=${entry.falsification_condition || 'TBD'}`
    )),
    '',
    '## Risks And Limitations',
    ...proposal.risks_and_limitations.map((entry) => `- ${entry.text} [severity=${entry.severity || 'unknown'}]`),
    '',
    '## Must-Cite Evidence',
    ...proposal.must_cite_evidence.map((entry) => `- ${entry.paper_title || entry.evidence_id}: ${entry.citation_context || entry.evidence_tier}`),
    '',
    '## Claim Evidence Labels',
    ...proposal.claims.map((entry) => `- ${entry.id}: ${entry.claim_label}`),
    '',
    '## Remaining Evidence Needs',
    ...(proposal.remaining_evidence_needs.length
      ? proposal.remaining_evidence_needs.map((entry) => `- ${entry.text}`)
      : ['- None recorded in the committed subgraph.']),
    ''
  ];
  return `${lines.join('\n')}\n`;
}

export function synthesizeProposalBundle(graph = {}, options = {}) {
  const commitDecision = options.commitDecision || options.commit_decision || {};
  if (graph.status !== 'committed' || commitDecision.status !== 'committed') {
    throw new Error('Cannot synthesize a full paper idea without a committed proposal graph.');
  }

  const problem = firstNode(graph, PROPOSAL_NODE_TYPES.PROBLEM);
  const hypothesis = firstNode(graph, PROPOSAL_NODE_TYPES.HYPOTHESIS);
  const mechanism = firstNode(graph, PROPOSAL_NODE_TYPES.MECHANISM);
  const method = firstNode(graph, PROPOSAL_NODE_TYPES.METHOD);
  const novelty = firstNode(graph, PROPOSAL_NODE_TYPES.NOVELTY_CLAIM);
  const components = activeNodesByType(graph, PROPOSAL_NODE_TYPES.COMPONENT);
  const risks = activeNodesByType(graph, PROPOSAL_NODE_TYPES.RISK);
  const evidenceNeeds = activeNodesByType(graph, PROPOSAL_NODE_TYPES.EVIDENCE_NEED);
  const evalPlans = activeNodesByType(graph, PROPOSAL_NODE_TYPES.EVAL_PLAN);
  const storyBeats = activeNodesByType(graph, PROPOSAL_NODE_TYPES.STORY_BEAT);
  const claimNodes = [
    hypothesis,
    method,
    mechanism,
    novelty,
    ...components
  ].filter(Boolean);
  const mustCiteEvidence = claimNodes.flatMap((node) => evidenceForNode(graph, node.id))
    .filter((node, index, all) => node?.id && all.findIndex((entry) => entry.id === node.id) === index)
    .map(evidenceJson);

  const proposal = {
    proposal_version: PROPOSAL_BUNDLE_VERSION,
    run_id: graph.run_id,
    committed_subgraph_id: graph.committed_subgraph_id,
    graph_hash: graph.graph_hash,
    working_title: novelty?.title || method?.title || `Proposal: ${problem?.title || 'Full Paper Idea'}`,
    abstract: buildAbstract({ problem, hypothesis, method, mechanism }),
    problem_and_target_domain: textOf(problem),
    core_hypothesis: {
      id: hypothesis?.id || '',
      text: textOf(hypothesis),
      claim_label: nodeClaimLabel(hypothesis)
    },
    proposed_method: {
      id: method?.id || '',
      text: textOf(method),
      components: components.map((node) => ({
        id: node.id,
        text: textOf(node),
        claim_label: nodeClaimLabel(node)
      })),
      claim_label: nodeClaimLabel(method)
    },
    mechanism_of_expected_improvement: {
      id: mechanism?.id || '',
      text: textOf(mechanism),
      claim_label: nodeClaimLabel(mechanism)
    },
    novelty_contrast: {
      id: novelty?.id || '',
      text: textOf(novelty),
      claim_label: nodeClaimLabel(novelty)
    },
    expected_contributions: storyBeats.length
      ? storyBeats.map((node) => ({
          id: node.id,
          text: textOf(node),
          claim_label: nodeClaimLabel(node)
        }))
      : claimNodes.map((node) => ({
          id: node.id,
          text: textOf(node),
          claim_label: nodeClaimLabel(node)
        })),
    evaluation_plan: evalPlans.map(evalPlanJson),
    risks_and_limitations: risks.map((node) => ({
      id: node.id,
      text: textOf(node),
      severity: node.severity || node.properties?.severity || '',
      claim_label: nodeClaimLabel(node)
    })),
    must_cite_evidence: mustCiteEvidence,
    claims: claimNodes.map((node) => ({
      id: node.id,
      type: node.type,
      text: textOf(node),
      claim_label: nodeClaimLabel(node),
      evidence_ids: evidenceForNode(graph, node.id).map((entry) => entry.id)
    })),
    remaining_evidence_needs: evidenceNeeds.map((node) => ({
      id: node.id,
      text: textOf(node)
    })),
    controller: {
      commit_decision_id: commitDecision.commit_decision_id,
      scores: commitDecision.scores,
      decision_reasons: commitDecision.decision_reasons
    },
    evidence_export: options.evidenceExport || options.evidence_export || {}
  };

  return {
    proposal_json: proposal,
    markdown: buildMarkdown(proposal)
  };
}
