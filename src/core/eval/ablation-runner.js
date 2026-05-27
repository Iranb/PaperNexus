import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import { runIdeaCatalystHistoricalReplay } from './historical-replay.js';

export const IDEA_CATALYST_ABLATION_RUNNER_VERSION = 'idea-catalyst-ablation-runner-v1';

export const DEFAULT_IDEA_CATALYST_ABLATIONS = [
  {
    id: 'full',
    label: 'Full candidate packet',
    control: true,
    description: 'Runs the candidate packet without ablation.'
  },
  {
    id: 'without_must_cite',
    label: 'Remove must-cite set',
    description: 'Drops must-cite obligations to measure retrieval and prior-art coverage contribution.'
  },
  {
    id: 'without_claim_graph',
    label: 'Remove claim graph',
    description: 'Drops contribution claims and claim-level evidence to measure grounding contribution.'
  },
  {
    id: 'without_reviewer_panel',
    label: 'Remove reviewer panel',
    description: 'Drops reviewer simulation packets and major concerns.'
  },
  {
    id: 'without_meta_reviewer',
    label: 'Remove meta-reviewer',
    description: 'Drops meta-review, recommendation, and decision synthesis fields.'
  },
  {
    id: 'without_storyline_dag',
    label: 'Remove storyline DAG',
    description: 'Drops storyline DAG beats and edges to measure narrative audit contribution.'
  },
  {
    id: 'without_temporal_cutoff',
    label: 'Remove temporal cutoff',
    description: 'Drops historical cutoff metadata and temporal validity checks.'
  },
  {
    id: 'without_coci_openalex',
    label: 'Remove COCI/OpenAlex support',
    description: 'Drops OpenAlex/COCI-backed citation and identifier support fields.'
  },
  {
    id: 'without_graphrag_summaries',
    label: 'Remove GraphRAG summaries',
    description: 'Drops graph/community/global-local summary artifacts.'
  },
  {
    id: 'without_link_prediction_signal',
    label: 'Remove graph link-prediction signal',
    description: 'Drops predicted bridge edges and bridge rerank signals to measure downstream link-prediction contribution.'
  },
  {
    id: 'without_counterfactual_planner',
    label: 'Remove counterfactual planner',
    description: 'Drops counterfactual and falsification plan artifacts.'
  }
];

const ABLATION_EFFECT_EXPECTATIONS = {
  without_must_cite: {
    metric: 'must_cite_recall_at_k',
    gate: 'must_cite_recall_at_k',
    expectedDirection: 'decrease'
  },
  without_claim_graph: {
    metric: 'claim_source_span_completeness',
    gate: 'claim_grounding',
    expectedDirection: 'decrease'
  },
  without_storyline_dag: {
    metric: 'storyline_trace_coverage',
    gate: 'storyline_traceability',
    expectedDirection: 'decrease'
  },
  without_temporal_cutoff: {
    metric: 'historical_score',
    gate: 'historical_replay_beats_live_discovery',
    expectedDirection: 'decrease_or_gate_not_passed'
  },
  without_link_prediction_signal: {
    metric: 'bridge_rerank_recall_at_k',
    gate: 'bridge_rerank_recall_at_k',
    expectedDirection: 'decrease'
  }
};
const REPORT_REQUIRED_ABLATION_IDS = new Set(DEFAULT_IDEA_CATALYST_ABLATIONS
  .filter((entry) => !entry.control)
  .map((entry) => entry.id));

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'boolean') return value;
  return Boolean(compactText(value));
}

function countArray(value) {
  return asArray(value).filter(hasValue).length;
}

function countPresence(...values) {
  return values.filter(hasValue).length;
}

function normalizeAblationId(value = '') {
  const id = compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'ablation';
  if (['without_claim_spans', 'without_source_spans'].includes(id)) return 'without_claim_graph';
  if (['without_storyline_trace', 'without_storyline'].includes(id)) return 'without_storyline_dag';
  if (['without_counterfactual', 'without_counterfactuals'].includes(id)) return 'without_counterfactual_planner';
  if (['without_openalex_coci', 'without_coci', 'without_openalex'].includes(id)) return 'without_coci_openalex';
  if ([
    'without_link_prediction',
    'without_link_prediction_signals',
    'without_graph_link_prediction',
    'without_bridge_rerank',
    'without_bridge_rerank_signals'
  ].includes(id)) return 'without_link_prediction_signal';
  return id;
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fileHashRecord(role = '', filePath = '', extra = {}) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const stats = await fs.stat(absolutePath);
  return {
    role,
    path: absolutePath,
    size: stats.size,
    mtime_ms: stats.mtimeMs,
    sha256: await sha256File(absolutePath),
    ...extra
  };
}

function packetEnvelopes(packet = {}) {
  return [
    packet,
    isObject(packet.result) ? packet.result : null,
    isObject(packet.evidence_export || packet.evidenceExport) ? (packet.evidence_export || packet.evidenceExport) : null
  ].filter(Boolean);
}

function countLinkPredictionTargets(envelope = {}) {
  const bridgeRetrieval = envelope.bridge_retrieval || envelope.bridgeRetrieval;
  const bridgeRerank = envelope.bridge_rerank_signals || envelope.bridgeRerankSignals;
  const bridgeRetrievalSignals = isObject(bridgeRetrieval)
    ? (bridgeRetrieval.bridge_rerank_signals || bridgeRetrieval.bridgeRerankSignals)
    : {};
  return countArray(bridgeRerank?.signals)
    + countArray(envelope.link_prediction_signals || envelope.linkPredictionSignals)
    + countArray(envelope.predicted_bridge_edges || envelope.predictedBridgeEdges)
    + countPresence(envelope.graph_link_prediction, envelope.graphLinkPrediction, envelope.link_prediction, envelope.linkPrediction)
    + (isObject(bridgeRetrieval) ? (
      countArray(bridgeRetrieval.candidate_bridge_paths || bridgeRetrieval.candidateBridgePaths)
      + countArray(bridgeRetrievalSignals?.signals)
      + countArray(bridgeRetrieval.link_prediction_signals || bridgeRetrieval.linkPredictionSignals)
    ) : 0);
}

function countCociOpenAlexTargets(envelope = {}) {
  const citationContexts = asArray(envelope.citation_contexts || envelope.citationContexts)
    .filter((entry) => /(openalex|coci|opencitations)/i.test(compactText(entry.source || entry.provider || entry.provenance || entry.dataset)));
  const mustCiteWithOpenIds = asArray(envelope.must_cite_set || envelope.mustCiteSet)
    .filter((entry) => isObject(entry) && [
      entry.openalex_id,
      entry.openAlexId,
      entry.openalex,
      entry.oci,
      entry.coci,
      entry.opencitations,
      entry.openCitations
    ].some(hasValue));
  return countPresence(envelope.openalex, envelope.openAlex, envelope.coci, envelope.opencitations, envelope.openCitations)
    + citationContexts.length
    + mustCiteWithOpenIds.length;
}

function countTemporalTargets(envelope = {}) {
  const certificate = envelope.novelty_certificate || envelope.noveltyCertificate;
  const temporalScore = Number(certificate?.temporal_validity ?? certificate?.temporalValidity);
  const futureLeakageCount = certificate?.future_leakage_count ?? certificate?.futureLeakageCount;
  return countPresence(envelope.time_cutoff, envelope.timeCutoff, envelope.temporal_cutoff, envelope.temporalCutoff)
    + (Number.isFinite(temporalScore) && temporalScore > 0 ? 1 : 0)
    + (futureLeakageCount !== undefined && futureLeakageCount !== null ? 1 : 0);
}

function countAblationTargetsInPacket(packet = {}, ablationId = '') {
  let count = 0;
  for (const envelope of packetEnvelopes(packet)) {
    if (ablationId === 'without_must_cite') {
      count += countArray(envelope.must_cite_set || envelope.mustCiteSet);
    } else if (ablationId === 'without_claim_graph') {
      count += countArray(envelope.contribution_claims || envelope.contributionClaims)
        + countArray(envelope.claims)
        + countPresence(envelope.claim_graph, envelope.claimGraph)
        + countArray(envelope.claim_evidence || envelope.claimEvidence);
    } else if (ablationId === 'without_reviewer_panel') {
      const review = envelope.review_packet || envelope.reviewPacket;
      count += countPresence(review, envelope.reviewer_panel, envelope.reviewerPanel)
        + countArray(review?.reviewers)
        + countArray(review?.panel)
        + countArray(review?.reviewer_panel || review?.reviewerPanel)
        + countArray(review?.major_concerns || review?.majorConcerns)
        + countArray(envelope.review_concerns || envelope.reviewConcerns);
    } else if (ablationId === 'without_meta_reviewer') {
      const review = envelope.review_packet || envelope.reviewPacket;
      count += countPresence(
        review?.meta_review,
        review?.metaReview,
        review?.meta_reviewer,
        review?.metaReviewer,
        review?.final_recommendation,
        review?.finalRecommendation,
        review?.decision,
        envelope.meta_review,
        envelope.metaReview,
        envelope.meta_reviewer,
        envelope.metaReviewer
      );
    } else if (ablationId === 'without_storyline_dag') {
      const storyline = envelope.storyline_dag || envelope.storylineDAG || envelope.storylineDag;
      count += countArray(storyline?.beats) + countArray(storyline?.edges);
    } else if (ablationId === 'without_temporal_cutoff') {
      count += countTemporalTargets(envelope);
    } else if (ablationId === 'without_coci_openalex') {
      count += countCociOpenAlexTargets(envelope);
    } else if (ablationId === 'without_graphrag_summaries') {
      count += countArray(envelope.graph_summaries || envelope.graphSummaries)
        + countArray(envelope.graphrag_summaries || envelope.graphRagSummaries)
        + countArray(envelope.community_summaries || envelope.communitySummaries)
        + countPresence(envelope.global_summary, envelope.globalSummary, envelope.local_summary, envelope.localSummary);
    } else if (ablationId === 'without_link_prediction_signal') {
      count += countLinkPredictionTargets(envelope);
    } else if (ablationId === 'without_counterfactual_planner') {
      count += countArray(envelope.counterfactuals)
        + countArray(envelope.falsification_plans || envelope.falsificationPlans)
        + countPresence(envelope.counterfactual_planner, envelope.counterfactualPlanner);
    }
  }
  return count;
}

function caseCandidate(entry = {}) {
  return entry.candidate ?? entry.candidatePacket ?? entry.candidate_packet ?? entry.system ?? entry.packet ?? {};
}

function countAblationTargetsInBenchmark(benchmark = {}, ablationId = '') {
  return asArray(benchmark.cases || benchmark.replays || benchmark.items || benchmark.queries).reduce((total, entry) => {
    const caseTemporalTargets = ablationId === 'without_temporal_cutoff'
      ? countPresence(entry.timeCutoff, entry.time_cutoff, entry.cutoffYear, entry.cutoff_year)
      : 0;
    return total + caseTemporalTargets + countAblationTargetsInPacket(caseCandidate(entry), ablationId);
  }, 0);
}

function buildAblationAudit(originalBenchmark = {}, ablatedBenchmark = {}, ablation = {}) {
  const id = normalizeAblationId(ablation.id || ablation.name);
  if (id === 'full' || ablation.control) {
    return {
      target_id: id,
      status: 'control',
      target_present_before: true,
      target_removed: true,
      before_count: null,
      after_count: null
    };
  }
  const beforeCount = countAblationTargetsInBenchmark(originalBenchmark, id);
  const afterCount = countAblationTargetsInBenchmark(ablatedBenchmark, id);
  const targetPresentBefore = beforeCount > 0;
  const targetRemoved = targetPresentBefore && afterCount === 0;
  return {
    target_id: id,
    status: targetRemoved ? 'passed' : (targetPresentBefore ? 'failed' : 'not_evaluable'),
    target_present_before: targetPresentBefore,
    target_removed: targetRemoved,
    before_count: beforeCount,
    after_count: afterCount
  };
}

function ablateMustCite(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.must_cite_set = [];
    envelope.mustCiteSet = [];
    if (isObject(envelope.novelty_certificate || envelope.noveltyCertificate)) {
      const certificate = envelope.novelty_certificate || envelope.noveltyCertificate;
      certificate.must_cite_completeness = 0;
      certificate.mustCiteCompleteness = 0;
      certificate.must_cite_count = 0;
      certificate.mustCiteCount = 0;
    }
  }
}

function ablateClaimSpans(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.evidence_status = 'weak_evidence';
    envelope.evidenceStatus = 'weak_evidence';
    const claims = asArray(envelope.contribution_claims || envelope.contributionClaims);
    for (const claim of claims) {
      claim.source_span_ids = [];
      claim.sourceSpanIds = [];
      claim.source_spans = [];
      claim.sourceSpans = [];
    }
    if (isObject(envelope.novelty_certificate || envelope.noveltyCertificate)) {
      const certificate = envelope.novelty_certificate || envelope.noveltyCertificate;
      certificate.grounding = 0;
      certificate.unsupported_claim_count = claims.length;
      certificate.unsupportedClaimCount = claims.length;
    }
  }
}

function ablateClaimGraph(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.evidence_status = 'weak_evidence';
    envelope.evidenceStatus = 'weak_evidence';
    envelope.contribution_claims = [];
    envelope.contributionClaims = [];
    envelope.claims = [];
    envelope.claim_graph = null;
    envelope.claimGraph = null;
    envelope.claim_evidence = [];
    envelope.claimEvidence = [];
    if (isObject(envelope.novelty_certificate || envelope.noveltyCertificate)) {
      const certificate = envelope.novelty_certificate || envelope.noveltyCertificate;
      certificate.grounding = 0;
      certificate.unsupported_claim_count = 0;
      certificate.unsupportedClaimCount = 0;
      certificate.claim_graph_present = false;
      certificate.claimGraphPresent = false;
    }
  }
}

function ablateReviewerPanel(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    const review = envelope.review_packet || envelope.reviewPacket;
    if (isObject(review)) {
      review.major_concerns = [];
      review.majorConcerns = [];
      review.panel = [];
      review.reviewers = [];
      review.reviewer_panel = [];
      review.reviewerPanel = [];
      review.recommendation = 'not_evaluated';
    }
    envelope.review_packet = null;
    envelope.reviewPacket = null;
    envelope.reviewer_panel = [];
    envelope.reviewerPanel = [];
    envelope.review_concerns = [];
    envelope.reviewConcerns = [];
  }
}

function ablateMetaReviewer(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    const review = envelope.review_packet || envelope.reviewPacket;
    if (isObject(review)) {
      review.meta_review = null;
      review.metaReview = null;
      review.meta_reviewer = null;
      review.metaReviewer = null;
      review.final_recommendation = null;
      review.finalRecommendation = null;
      review.decision = null;
    }
    envelope.meta_review = null;
    envelope.metaReview = null;
    envelope.meta_reviewer = null;
    envelope.metaReviewer = null;
  }
}

function ablateStorylineTrace(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    const storyline = envelope.storyline_dag || envelope.storylineDAG || envelope.storylineDag;
    if (!isObject(storyline)) continue;
    const unsupported = [];
    for (const beat of asArray(storyline.beats)) {
      beat.trace_refs = [];
      beat.traceRefs = [];
      beat.claim_ids = [];
      beat.claimIds = [];
      beat.challenge_ids = [];
      beat.challengeIds = [];
      beat.takeaway_ids = [];
      beat.takeawayIds = [];
      beat.review_concern_ids = [];
      beat.reviewConcernIds = [];
      beat.supported = false;
      if (beat.beat_id || beat.beatId) unsupported.push(beat.beat_id || beat.beatId);
    }
    storyline.unsupported_beats = unsupported;
    storyline.unsupportedBeats = unsupported;
  }
}

function ablateStorylineDag(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.storyline_dag = { beats: [], edges: [], unsupported_beats: [] };
    envelope.storylineDAG = { beats: [], edges: [], unsupportedBeats: [] };
    envelope.storylineDag = { beats: [], edges: [], unsupportedBeats: [] };
  }
}

function ablateTemporalCutoff(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    if (isObject(envelope.novelty_certificate || envelope.noveltyCertificate)) {
      const certificate = envelope.novelty_certificate || envelope.noveltyCertificate;
      certificate.temporal_validity = 0;
      certificate.temporalValidity = 0;
      certificate.future_leakage_count = null;
      certificate.futureLeakageCount = null;
    }
    envelope.time_cutoff = null;
    envelope.timeCutoff = null;
    envelope.temporal_cutoff = null;
    envelope.temporalCutoff = null;
  }
}

function ablateCociOpenAlex(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.openalex = null;
    envelope.openAlex = null;
    envelope.coci = null;
    envelope.opencitations = null;
    envelope.openCitations = null;
    envelope.citation_contexts = asArray(envelope.citation_contexts || envelope.citationContexts)
      .filter((entry) => {
        const source = compactText(entry.source || entry.provider || entry.provenance || entry.dataset).toLowerCase();
        return !/(openalex|coci|opencitations)/.test(source);
      });
    envelope.citationContexts = envelope.citation_contexts;
    envelope.must_cite_set = asArray(envelope.must_cite_set || envelope.mustCiteSet)
      .map((entry) => {
        if (!isObject(entry)) return entry;
        const next = { ...entry };
        delete next.openalex_id;
        delete next.openAlexId;
        delete next.oci;
        delete next.coci;
        delete next.opencitations;
        delete next.openCitations;
        return next;
      });
    envelope.mustCiteSet = envelope.must_cite_set;
  }
}

function ablateGraphRagSummaries(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.graph_summaries = [];
    envelope.graphSummaries = [];
    envelope.graphrag_summaries = [];
    envelope.graphRagSummaries = [];
    envelope.community_summaries = [];
    envelope.communitySummaries = [];
    envelope.global_summary = null;
    envelope.globalSummary = null;
    envelope.local_summary = null;
    envelope.localSummary = null;
  }
}

function stripLinkPredictionFromPaths(paths = []) {
  return asArray(paths).map((entry) => {
    if (!isObject(entry)) return entry;
    const next = { ...entry };
    delete next.link_prediction_score;
    delete next.linkPredictionScore;
    delete next.bridge_rerank_score;
    delete next.bridgeRerankScore;
    delete next.rerank_score;
    delete next.rerankScore;
    delete next.predicted_edge_score;
    delete next.predictedEdgeScore;
    delete next.predicted_bridge_edge_id;
    delete next.predictedBridgeEdgeId;
    return next;
  });
}

function ablateLinkPredictionSignal(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.bridge_rerank_signals = { signals: [] };
    envelope.bridgeRerankSignals = { signals: [] };
    envelope.link_prediction_signals = [];
    envelope.linkPredictionSignals = [];
    envelope.predicted_bridge_edges = [];
    envelope.predictedBridgeEdges = [];
    envelope.graph_link_prediction = null;
    envelope.graphLinkPrediction = null;
    envelope.link_prediction = null;
    envelope.linkPrediction = null;

    const bridgeRetrieval = envelope.bridge_retrieval || envelope.bridgeRetrieval;
    if (isObject(bridgeRetrieval)) {
      bridgeRetrieval.candidate_bridge_paths = stripLinkPredictionFromPaths(bridgeRetrieval.candidate_bridge_paths || bridgeRetrieval.candidateBridgePaths);
      bridgeRetrieval.candidateBridgePaths = bridgeRetrieval.candidate_bridge_paths;
      bridgeRetrieval.bridge_rerank_signals = { signals: [] };
      bridgeRetrieval.bridgeRerankSignals = { signals: [] };
      bridgeRetrieval.link_prediction_signals = [];
      bridgeRetrieval.linkPredictionSignals = [];
    }
  }
}

function ablateCounterfactualPlanner(packet = {}) {
  for (const envelope of packetEnvelopes(packet)) {
    envelope.counterfactuals = [];
    envelope.falsification_plans = [];
    envelope.falsificationPlans = [];
    envelope.counterfactual_planner = null;
    envelope.counterfactualPlanner = null;
  }
}

function applyBuiltInAblation(packet = {}, ablation = {}) {
  const id = normalizeAblationId(ablation.id || ablation.name);
  if (id === 'full' || ablation.control) return packet;
  if (id === 'without_must_cite') ablateMustCite(packet);
  if (id === 'without_claim_graph') ablateClaimGraph(packet);
  if (id === 'without_reviewer_panel') ablateReviewerPanel(packet);
  if (id === 'without_meta_reviewer') ablateMetaReviewer(packet);
  if (id === 'without_storyline_dag') ablateStorylineDag(packet);
  if (id === 'without_temporal_cutoff') ablateTemporalCutoff(packet);
  if (id === 'without_coci_openalex') ablateCociOpenAlex(packet);
  if (id === 'without_graphrag_summaries') ablateGraphRagSummaries(packet);
  if (id === 'without_link_prediction_signal') ablateLinkPredictionSignal(packet);
  if (id === 'without_counterfactual_planner') ablateCounterfactualPlanner(packet);
  return packet;
}

export function applyIdeaCatalystAblationToPacket(packet = {}, ablation = {}) {
  const next = cloneJson(packet || {});
  return applyBuiltInAblation(next, ablation);
}

export function applyIdeaCatalystAblationToBenchmark(benchmark = {}, ablation = {}) {
  const id = normalizeAblationId(ablation.id || ablation.name);
  const next = cloneJson(benchmark || {});
  next.cases = asArray(next.cases || next.replays || next.items || next.queries).map((entry) => {
    const candidate = entry.candidate ?? entry.candidatePacket ?? entry.candidate_packet ?? entry.system ?? entry.packet;
    const ablatedCandidate = applyIdeaCatalystAblationToPacket(candidate || {}, ablation);
    const ablatedEntry = {
      ...entry,
      candidate: ablatedCandidate,
      candidatePacket: ablatedCandidate,
      candidate_packet: ablatedCandidate
    };
    if (id === 'without_temporal_cutoff') {
      delete ablatedEntry.timeCutoff;
      delete ablatedEntry.time_cutoff;
      delete ablatedEntry.cutoffYear;
      delete ablatedEntry.cutoff_year;
      ablateTemporalCutoff(ablatedCandidate);
    }
    return ablatedEntry;
  });
  return next;
}

function normalizeAblations(ablations = []) {
  const entries = asArray(ablations).filter((entry) => isObject(entry) || compactText(entry));
  const normalized = entries.length
    ? entries.map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
    : DEFAULT_IDEA_CATALYST_ABLATIONS;
  const withControl = normalized.some((entry) => entry.control || compactText(entry.id || entry.name) === 'full')
    ? normalized
    : [DEFAULT_IDEA_CATALYST_ABLATIONS[0], ...normalized];
  return withControl.map((entry) => {
    const id = normalizeAblationId(entry.id || entry.name || entry.label);
    const defaults = DEFAULT_IDEA_CATALYST_ABLATIONS.find((item) => item.id === id) || {};
    return {
      ...defaults,
      ...entry,
      id,
      label: compactText(entry.label || defaults.label || id),
      description: compactText(entry.description || defaults.description || ''),
      control: Boolean(entry.control || defaults.control || id === 'full')
    };
  });
}

function metricDelta(value, controlValue) {
  const left = Number(value);
  const right = Number(controlValue);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Number((left - right).toFixed(6));
}

function gateStatusMap(report = {}) {
  return new Map(asArray(report.gates).map((gate) => [compactText(gate.name), compactText(gate.status || 'unknown')]));
}

function buildAblationEffectAudit(ablation = {}, report = {}, controlReport = null, deltas = {}) {
  const id = normalizeAblationId(ablation.id || ablation.name);
  if (id === 'full' || ablation.control) {
    return {
      target_id: id,
      status: 'control',
      effect_required: false
    };
  }
  const expectation = ABLATION_EFFECT_EXPECTATIONS[id];
  if (!expectation) {
    if (REPORT_REQUIRED_ABLATION_IDS.has(id)) {
      return {
        target_id: id,
        status: 'incomplete',
        effect_required: true,
        reason: 'A measured downstream effect audit is required for release; the lightweight replay runner has no isolated metric for this ablation lane.'
      };
    }
    return {
      target_id: id,
      status: 'structural_only',
      effect_required: false,
      reason: 'No isolated historical-replay metric is defined for this ablation lane; artifact-removal audit remains required.'
    };
  }

  const gateStatuses = gateStatusMap(report);
  const relevantGateStatus = gateStatuses.get(expectation.gate) || 'missing';
  const delta = deltas[expectation.metric];
  const metricDegraded = Number.isFinite(Number(delta)) && Number(delta) < 0;
  const gateNotPassed = relevantGateStatus && !['passed', 'missing'].includes(relevantGateStatus);
  const gateMissing = relevantGateStatus === 'missing';
  const status = (metricDegraded || gateNotPassed)
    ? 'passed'
    : (gateMissing || delta === null ? 'incomplete' : 'failed');
  return {
    target_id: id,
    status,
    effect_required: true,
    target_metric: expectation.metric,
    expected_direction: expectation.expectedDirection,
    delta_from_control: delta,
    relevant_gate: expectation.gate,
    relevant_gate_status: relevantGateStatus,
    effect_observed: metricDegraded || gateNotPassed,
    effect_evidence: metricDegraded
      ? 'metric_degraded_vs_control'
      : gateNotPassed
        ? 'relevant_gate_not_passed_after_ablation'
        : gateMissing
          ? 'relevant_gate_missing'
          : 'no_degradation_observed',
    control_status: controlReport?.status || null,
    ablation_status: report.status || null
  };
}

function summarizeVariant(report = {}, ablation = {}, controlReport = null, audit = {}) {
  const metrics = asObject(report.metrics);
  const controlMetrics = asObject(controlReport?.metrics);
  const deltas = controlReport ? {
    must_cite_recall_at_k: metricDelta(metrics.must_cite_recall_at_k, controlMetrics.must_cite_recall_at_k),
    claim_source_span_completeness: metricDelta(metrics.claim_source_span_completeness, controlMetrics.claim_source_span_completeness),
    storyline_trace_coverage: metricDelta(metrics.storyline_trace_coverage, controlMetrics.storyline_trace_coverage),
    bridge_rerank_recall_at_k: metricDelta(metrics.bridge_rerank_recall_at_k, controlMetrics.bridge_rerank_recall_at_k),
    historical_score: metricDelta(metrics.historical_score, controlMetrics.historical_score)
  } : {};
  return {
    ablation_id: ablation.id,
    label: ablation.label,
    control: Boolean(ablation.control),
    status: report.status || 'unknown',
    artifact_removal_audit: audit,
    ablation_effect_audit: buildAblationEffectAudit(ablation, report, controlReport, deltas),
    gates_failed: asArray(report.gates).filter((gate) => gate.status === 'failed').map((gate) => gate.name),
    metrics,
    deltas_from_control: deltas
  };
}

function suiteStatus(controlReport = null, summaries = []) {
  if (!controlReport) return 'incomplete';
  if (controlReport.status === 'failed') return 'failed';
  if (controlReport.status === 'incomplete') return 'incomplete';
  const auditFailures = summaries
    .filter((entry) => !entry.control)
    .filter((entry) => entry.artifact_removal_audit?.status === 'failed');
  if (auditFailures.length) return 'failed';
  const incompleteAudits = summaries
    .filter((entry) => !entry.control)
    .filter((entry) => entry.artifact_removal_audit?.status !== 'passed');
  if (incompleteAudits.length) return 'incomplete';
  const effectFailures = summaries
    .filter((entry) => entry.ablation_effect_audit?.effect_required === true)
    .filter((entry) => entry.ablation_effect_audit?.status === 'failed');
  if (effectFailures.length) return 'failed';
  const incompleteEffects = summaries
    .filter((entry) => entry.ablation_effect_audit?.effect_required === true)
    .filter((entry) => entry.ablation_effect_audit?.status !== 'passed');
  if (incompleteEffects.length) return 'incomplete';
  const unexpectedImprovements = summaries
    .filter((entry) => !entry.control)
    .filter((entry) => Number(entry.deltas_from_control?.historical_score) > 0);
  return unexpectedImprovements.length ? 'failed' : 'passed';
}

async function loadBenchmark(params = {}) {
  if (isObject(params.benchmark)) return params.benchmark;
  if (isObject(params.input)) return params.input;
  const inputPath = compactText(params.inputPath || params.datasetPath || params.dataset_path);
  if (!inputPath) throw new Error('runIdeaCatalystAblationSuite requires benchmark, input, inputPath, or datasetPath.');
  return readJson(path.resolve(process.cwd(), inputPath));
}

export async function runIdeaCatalystAblationSuite(params = {}) {
  const inputPath = compactText(params.inputPath || params.datasetPath || params.dataset_path);
  const benchmark = await loadBenchmark(params);
  const ablations = normalizeAblations(params.ablations);
  const generatedAt = new Date().toISOString();
  const runId = compactText(params.runId || params.run_id)
    || `idea-catalyst-ablation-${stableHash(`${benchmark.name || 'benchmark'}:${generatedAt}`, 10)}`;
  const outputDir = compactText(params.outputDir || params.output_dir);
  if (outputDir) await ensureDir(path.resolve(process.cwd(), outputDir));

  const reports = [];
  for (const ablation of ablations) {
    const ablatedBenchmark = applyIdeaCatalystAblationToBenchmark(benchmark, ablation);
    const audit = buildAblationAudit(benchmark, ablatedBenchmark, ablation);
    const variantRunId = `${runId}-${ablation.id}`;
    const variantOutputDir = outputDir ? path.join(outputDir, ablation.id) : '';
    const report = await runIdeaCatalystHistoricalReplay({
      ...params,
      benchmark: ablatedBenchmark,
      datasetPath: undefined,
      inputPath: undefined,
      runId: variantRunId,
      outputDir: variantOutputDir || undefined
    });
    reports.push({ ablation, report, audit });
  }

  const control = reports.find((entry) => entry.ablation.control) || reports[0] || null;
  const summaries = await Promise.all(reports.map(async (entry) => {
    const summary = summarizeVariant(entry.report, entry.ablation, control?.report || null, entry.audit);
    const reportPath = compactText(entry.report.artifacts?.reportPath);
    if (!reportPath) return summary;
    return {
      ...summary,
      report_artifact: await fileHashRecord('ablation_variant_report', reportPath, {
        ablation_id: entry.ablation.id
      })
    };
  }));
  const inputs = inputPath
    ? [await fileHashRecord('ablation_benchmark', inputPath)]
    : [];
  const manifest = {
    contractVersion: IDEA_CATALYST_ABLATION_RUNNER_VERSION,
    runId,
    generatedAt,
    status: suiteStatus(control?.report || null, summaries),
    benchmark: {
      name: compactText(benchmark.name || benchmark.dataset || 'idea-catalyst-ablation'),
      format: compactText(benchmark.format || benchmark.dataset_format || benchmark.datasetFormat || 'custom'),
      case_count: asArray(benchmark.cases || benchmark.replays || benchmark.items || benchmark.queries).length
    },
    inputs,
    control_ablation_id: control?.ablation.id || null,
    ablations: summaries,
    report_count: reports.length
  };

  if (outputDir) {
    manifest.artifacts = {
      outputDir: path.resolve(process.cwd(), outputDir),
      manifestPath: path.join(path.resolve(process.cwd(), outputDir), 'ablation-manifest.json')
    };
    await writeJson(manifest.artifacts.manifestPath, manifest);
  }

  return manifest;
}
