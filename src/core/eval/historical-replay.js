import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { createPaperIdentity, normalizePaperIdentifiers, paperIdentifiersOverlap } from '../../lib/paper-identifiers.js';
import { jaccardSimilarity, stableHash, unique } from '../../lib/utils.js';

export const IDEA_CATALYST_HISTORICAL_REPLAY_VERSION = 'idea-catalyst-historical-replay-v1';

const DEFAULT_CUTOFFS = [5, 10, 20];
const DEFAULT_THRESHOLDS = {
  mustCiteRecallAtK: 0.8,
  mustCiteRecallAtKImprovement: 0,
  noveltyImprovement: 0,
  claimGroundingF1: 0.7,
  claimGroundingF1Improvement: 0,
  unsupportedClaimRateReduction: 0,
  claimSourceSpanCompleteness: 1,
  storylineTraceCoverage: 1,
  storylineTraceCoverageImprovement: 0,
  historicalReplayImprovement: 0,
  minMajorMetricImprovements: 0,
  futureLeakageCount: 0,
  sourceBackedUngroundedClaims: 0
};

const NOVELTY_DIMENSIONS = [
  'novelty',
  'significance',
  'feasibility',
  'grounding',
  'must_cite_completeness',
  'temporal_validity'
];
const STORYLINE_ALLOWED_TRACE_TYPES = new Set([
  'claim',
  'contribution claim',
  'novelty claim',
  'challenge',
  'takeaway',
  'review concern'
]);

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

function normalizeKey(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clamp01(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function average(values = [], fallback = null) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return fallback;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function divide(numerator, denominator, fallback = 0) {
  return denominator ? numerator / denominator : fallback;
}

function roundMetric(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : null;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
}

function firstArray(...values) {
  return values.find(Array.isArray) || [];
}

function extractPacket(value = {}) {
  const raw = asObject(value);
  const result = asObject(raw.result);
  const evidenceExport = asObject(raw.evidence_export || raw.evidenceExport);
  return {
    ...raw,
    ...result,
    ...evidenceExport,
    result,
    evidence_export: evidenceExport
  };
}

function normalizePaper(value = {}, fallbackId = '') {
  const raw = typeof value === 'string' ? { id: value, title: value } : asObject(value);
  const title = compactText(raw.title || raw.paperTitle || raw.paper_title || raw.name || raw.display_name);
  const identifiers = normalizePaperIdentifiers({
    ...asObject(raw.identifiers),
    ...raw
  });
  const identity = createPaperIdentity({
    identifiers,
    title,
    normalizedTitle: raw.normalizedTitle || raw.normalized_title
  });
  return {
    ...raw,
    id: compactText(raw.id || raw.paperId || raw.paper_id || raw.paper_key || raw.paperKey || fallbackId || identity.canonicalId),
    paper_key: compactText(raw.paper_key || raw.paperKey || raw.id || raw.paperId || raw.paper_id),
    title,
    year: Number.isFinite(Number(raw.year || raw.publication_year || raw.publicationYear))
      ? Number(raw.year || raw.publication_year || raw.publicationYear)
      : null,
    identifiers,
    ...identity
  };
}

function paperAliases(paper = {}) {
  const normalized = normalizePaper(paper);
  return unique([
    normalized.id,
    normalized.paper_key,
    normalized.canonicalId,
    normalized.normalizedTitle,
    normalized.title,
    ...(Array.isArray(normalized.identityAliases) ? normalized.identityAliases : [])
  ].map(normalizeKey).filter(Boolean));
}

function papersMatch(left = {}, right = {}) {
  const normalizedLeft = normalizePaper(left);
  const normalizedRight = normalizePaper(right);
  if (paperIdentifiersOverlap(normalizedLeft, normalizedRight)) return true;

  const rightAliases = new Set(paperAliases(normalizedRight));
  if (paperAliases(normalizedLeft).some((alias) => rightAliases.has(alias))) return true;

  const leftTitle = compactText(normalizedLeft.normalizedTitle || normalizedLeft.title);
  const rightTitle = compactText(normalizedRight.normalizedTitle || normalizedRight.title);
  return Boolean(leftTitle && rightTitle && jaccardSimilarity(leftTitle, rightTitle) >= 0.96);
}

function collectGoldMustCite(caseInput = {}) {
  const gold = asObject(caseInput.gold || caseInput.expected || caseInput.labels);
  return firstArray(
    gold.must_cite_set,
    gold.mustCiteSet,
    gold.must_cite,
    gold.mustCite,
    gold.relevant,
    gold.papers,
    caseInput.goldMustCite,
    caseInput.gold_must_cite,
    caseInput.relevant
  ).map((entry, index) => normalizePaper(entry, `gold:${index}`));
}

function collectPredictedMustCite(packet = {}) {
  return firstArray(
    packet.must_cite_set,
    packet.mustCiteSet,
    packet.evidence_export?.must_cite_set,
    packet.result?.must_cite_set
  ).map((entry, index) => normalizePaper(entry, `predicted:${index}`));
}

export function evaluateMustCiteRecall(packetInput = {}, caseInput = {}, options = {}) {
  const packet = extractPacket(packetInput);
  const predicted = collectPredictedMustCite(packet);
  const gold = collectGoldMustCite(caseInput);
  const cutoffs = asArray(options.cutoffs || caseInput.cutoffs || DEFAULT_CUTOFFS)
    .map((value) => Math.max(1, Number.parseInt(value, 10)))
    .filter(Number.isFinite);
  const metrics = {};

  for (const cutoff of cutoffs) {
    const top = predicted.slice(0, cutoff);
    const hits = gold.filter((goldPaper) => top.some((candidate) => papersMatch(candidate, goldPaper))).length;
    metrics[`recall@${cutoff}`] = roundMetric(divide(hits, gold.length, 0));
  }

  return {
    evaluated: gold.length > 0,
    gold_count: gold.length,
    predicted_count: predicted.length,
    metrics,
    first_full_recall_cutoff: cutoffs.find((cutoff) => metrics[`recall@${cutoff}`] >= 1) || null
  };
}

function getNoveltyCertificate(packet = {}) {
  return firstObject(
    packet.novelty_certificate,
    packet.noveltyCertificate,
    packet.evidence_export?.novelty_certificate,
    packet.result?.novelty_certificate
  );
}

function collectGoldNovelty(caseInput = {}) {
  const gold = asObject(caseInput.gold || caseInput.expected || caseInput.labels);
  return firstObject(
    gold.novelty_certificate,
    gold.noveltyCertificate,
    gold.novelty,
    caseInput.goldNovelty,
    caseInput.gold_novelty
  );
}

export function evaluateNoveltyCertificate(packetInput = {}, caseInput = {}) {
  const packet = extractPacket(packetInput);
  const certificate = getNoveltyCertificate(packet);
  const gold = collectGoldNovelty(caseInput);
  const dimensions = NOVELTY_DIMENSIONS.filter((field) => Number.isFinite(Number(certificate[field])));
  const goldDimensions = dimensions.filter((field) => Number.isFinite(Number(gold[field])));
  const rawScores = dimensions.map((field) => clamp01(certificate[field]));
  const absoluteAgreement = goldDimensions.map((field) => 1 - Math.abs(clamp01(certificate[field]) - clamp01(gold[field])));
  return {
    evaluated: dimensions.length > 0,
    gold_evaluated: goldDimensions.length > 0,
    dimensions,
    gold_dimensions: goldDimensions,
    score: roundMetric(goldDimensions.length ? average(absoluteAgreement, 0) : average(rawScores, 0)),
    raw_average: roundMetric(average(rawScores, 0)),
    absolute_error: goldDimensions.length
      ? roundMetric(average(goldDimensions.map((field) => Math.abs(clamp01(certificate[field]) - clamp01(gold[field]))), 0))
      : null,
    future_leakage_count: Number.isFinite(Number(certificate.future_leakage_count ?? certificate.futureLeakageCount))
      ? Number(certificate.future_leakage_count ?? certificate.futureLeakageCount)
      : 0
  };
}

function collectClaims(packet = {}) {
  return firstArray(
    packet.contribution_claims,
    packet.contributionClaims,
    packet.evidence_export?.contribution_claims,
    packet.result?.contribution_claims
  );
}

function collectGoldClaims(caseInput = {}) {
  const gold = asObject(caseInput.gold || caseInput.expected || caseInput.labels);
  return firstArray(
    gold.claims,
    gold.contribution_claims,
    gold.contributionClaims,
    caseInput.goldClaims,
    caseInput.gold_claims
  );
}

function claimText(claim = {}) {
  return compactText(claim.claim_text || claim.claimText || claim.text || claim.statement || claim.claim || claim.title);
}

function claimId(claim = {}) {
  return compactText(claim.claim_id || claim.claimId || claim.id);
}

function claimHasSourceSpan(claim = {}) {
  return asArray(claim.source_span_ids || claim.sourceSpanIds || claim.source_spans || claim.sourceSpans).length > 0;
}

function claimExpectedSupported(claim = {}) {
  const label = normalizeKey(claim.label || claim.verdict || claim.expectedLabel || claim.expected_label || claim.supported);
  if (['false', 'no', 'refuted', 'unsupported', 'not supported', 'insufficient'].includes(label)) return false;
  if (claim.supported === false || claim.source_backed === false || claim.sourceBacked === false) return false;
  return true;
}

function findMatchingClaim(goldClaim = {}, claims = []) {
  const goldId = claimId(goldClaim);
  const goldText = claimText(goldClaim);
  return claims.find((claim) => {
    if (goldId && claimId(claim) === goldId) return true;
    const candidateText = claimText(claim);
    return Boolean(goldText && candidateText && jaccardSimilarity(goldText, candidateText) >= 0.8);
  }) || null;
}

export function evaluateClaimGrounding(packetInput = {}, caseInput = {}) {
  const packet = extractPacket(packetInput);
  const claims = collectClaims(packet);
  const goldClaims = collectGoldClaims(caseInput);
  const ungrounded = claims.filter((claim) => !claimHasSourceSpan(claim));
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const goldClaim of goldClaims) {
    const expectedSupported = claimExpectedSupported(goldClaim);
    const matched = findMatchingClaim(goldClaim, claims);
    const predictedSupported = Boolean(matched && claimHasSourceSpan(matched));
    if (expectedSupported && predictedSupported) truePositive += 1;
    if (!expectedSupported && predictedSupported) falsePositive += 1;
    if (expectedSupported && !predictedSupported) falseNegative += 1;
  }

  const precision = divide(truePositive, truePositive + falsePositive, goldClaims.length ? 0 : null);
  const recall = divide(truePositive, truePositive + falseNegative, goldClaims.length ? 0 : null);
  const f1 = precision === null || recall === null || precision + recall === 0 ? (goldClaims.length ? 0 : null) : (2 * precision * recall) / (precision + recall);
  const evidenceStatus = normalizeKey(packet.evidence_status || packet.evidenceStatus);

  return {
    evaluated: claims.length > 0 || goldClaims.length > 0,
    gold_evaluated: goldClaims.length > 0,
    claim_count: claims.length,
    gold_claim_count: goldClaims.length,
    ungrounded_claim_count: ungrounded.length,
    source_span_completeness: roundMetric(claims.length ? (claims.length - ungrounded.length) / claims.length : 0),
    source_backed_ungrounded_claim_count: evidenceStatus === 'source backed' ? ungrounded.length : 0,
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    f1: roundMetric(f1)
  };
}

function getStorylineDAG(packet = {}) {
  return firstObject(
    packet.storyline_dag,
    packet.storylineDAG,
    packet.storylineDag,
    packet.evidence_export?.storyline_dag,
    packet.result?.storyline_dag
  );
}

function beatTraceRefs(beat = {}) {
  return [
    ...asArray(beat.trace_refs || beat.traceRefs).filter(storylineTraceRefIsAllowed),
    ...asArray(beat.claim_ids || beat.claimIds),
    ...asArray(beat.challenge_ids || beat.challengeIds),
    ...asArray(beat.takeaway_ids || beat.takeawayIds),
    ...asArray(beat.review_concern_ids || beat.reviewConcernIds)
  ].filter(Boolean);
}

function storylineTraceRefType(ref) {
  if (typeof ref === 'string') {
    const [prefix] = ref.split(':');
    return normalizeKey(prefix);
  }
  if (ref && typeof ref === 'object') {
    return normalizeKey(ref.kind || ref.type || ref.ref_type || ref.refType || ref.role || ref.category);
  }
  return '';
}

function storylineTraceRefIsAllowed(ref) {
  return STORYLINE_ALLOWED_TRACE_TYPES.has(storylineTraceRefType(ref));
}

export function evaluateStorylineTraceability(packetInput = {}) {
  const packet = extractPacket(packetInput);
  const storyline = getStorylineDAG(packet);
  const beats = asArray(storyline.beats);
  const traceable = beats.filter((beat) => beatTraceRefs(beat).length > 0);
  return {
    evaluated: beats.length > 0,
    beat_count: beats.length,
    traceable_beat_count: traceable.length,
    trace_coverage: roundMetric(beats.length ? traceable.length / beats.length : 0),
    unsupported_beats: asArray(storyline.unsupported_beats || storyline.unsupportedBeats)
  };
}

function collectPotentiallyTemporalPapers(packet = {}) {
  return [
    ...collectPredictedMustCite(packet),
    ...firstArray(packet.supporting_papers, packet.supportingPapers, packet.evidence_export?.supporting_papers)
      .map((entry, index) => normalizePaper(entry, `supporting:${index}`))
  ];
}

function collectSignalEdges(...values) {
  return values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
      return firstArray(
        value.signals,
        value.predicted_bridge_edges,
        value.predictedBridgeEdges,
        value.bridge_edges,
        value.bridgeEdges,
        value.predicted_edges,
        value.predictedEdges,
        value.edges,
        value.links
      );
    }
    return [];
  });
}

function normalizeBridgeEdge(edge = {}) {
  const raw = typeof edge === 'string' ? { id: edge, source_id: edge.split('->')[0], target_id: edge.split('->')[1] } : asObject(edge);
  const sourceId = compactText(raw.source_id || raw.sourceId || raw.source || raw.from || raw.head || raw.u);
  const targetId = compactText(raw.target_id || raw.targetId || raw.target || raw.to || raw.tail || raw.v);
  const type = compactText(raw.predicted_edge_type || raw.predictedEdgeType || raw.edge_type || raw.edgeType || raw.type || raw.relation);
  return {
    ...raw,
    source_id: sourceId,
    target_id: targetId,
    edge_type: type,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : null,
    rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : null
  };
}

function bridgeEdgeKey(edge = {}) {
  const normalized = normalizeBridgeEdge(edge);
  if (!normalized.source_id || !normalized.target_id) return '';
  const endpoints = [normalizeKey(normalized.source_id), normalizeKey(normalized.target_id)].sort();
  return endpoints.join('<->');
}

function collectGoldBridgeEdges(caseInput = {}) {
  const gold = asObject(caseInput.gold || caseInput.expected || caseInput.labels);
  return collectSignalEdges(
    gold.bridge_edges,
    gold.bridgeEdges,
    gold.bridge_rerank_edges,
    gold.bridgeRerankEdges,
    gold.link_prediction_edges,
    gold.linkPredictionEdges,
    gold.predicted_bridge_edges,
    gold.predictedBridgeEdges,
    caseInput.goldBridgeEdges,
    caseInput.gold_bridge_edges
  ).map(normalizeBridgeEdge).filter((edge) => bridgeEdgeKey(edge));
}

function collectPredictedBridgeEdges(packetInput = {}) {
  const packet = extractPacket(packetInput);
  return collectSignalEdges(
    packet.bridge_rerank_signals,
    packet.bridgeRerankSignals,
    packet.link_prediction_signals,
    packet.linkPredictionSignals,
    packet.predicted_bridge_edges,
    packet.predictedBridgeEdges,
    packet.graph_link_prediction,
    packet.graphLinkPrediction,
    packet.evidence_export?.bridge_rerank_signals,
    packet.evidence_export?.predicted_bridge_edges,
    packet.result?.bridge_rerank_signals,
    packet.result?.predicted_bridge_edges
  )
    .map(normalizeBridgeEdge)
    .filter((edge) => bridgeEdgeKey(edge))
    .sort((left, right) => {
      const leftRank = Number.isFinite(left.rank) ? left.rank : Number.POSITIVE_INFINITY;
      const rightRank = Number.isFinite(right.rank) ? right.rank : Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return (right.score || 0) - (left.score || 0);
    });
}

export function evaluateBridgeRerankSignal(packetInput = {}, caseInput = {}, options = {}) {
  const predicted = collectPredictedBridgeEdges(packetInput);
  const gold = collectGoldBridgeEdges(caseInput);
  const cutoffs = asArray(options.cutoffs || caseInput.cutoffs || DEFAULT_CUTOFFS)
    .map((value) => Math.max(1, Number.parseInt(value, 10)))
    .filter(Number.isFinite);
  const goldKeys = new Set(gold.map(bridgeEdgeKey).filter(Boolean));
  const metrics = {};

  for (const cutoff of cutoffs) {
    const topKeys = new Set(predicted.slice(0, cutoff).map(bridgeEdgeKey).filter(Boolean));
    const hits = [...goldKeys].filter((key) => topKeys.has(key)).length;
    metrics[`recall@${cutoff}`] = roundMetric(divide(hits, goldKeys.size, 0));
  }

  return {
    evaluated: goldKeys.size > 0,
    gold_edge_count: goldKeys.size,
    predicted_edge_count: predicted.length,
    metrics,
    first_full_recall_cutoff: cutoffs.find((cutoff) => metrics[`recall@${cutoff}`] >= 1) || null
  };
}

export function evaluateTemporalCutoff(packetInput = {}, caseInput = {}) {
  const packet = extractPacket(packetInput);
  const cutoff = Number(caseInput.timeCutoff || caseInput.time_cutoff || caseInput.cutoffYear || caseInput.cutoff_year);
  const certificate = getNoveltyCertificate(packet);
  const declaredFutureLeakage = Number(certificate.future_leakage_count ?? certificate.futureLeakageCount ?? 0);
  const futurePapers = Number.isFinite(cutoff)
    ? collectPotentiallyTemporalPapers(packet).filter((paper) => Number.isFinite(Number(paper.year)) && Number(paper.year) > cutoff)
    : [];
  const temporalStatusFuture = collectPredictedMustCite(packet)
    .filter((entry) => normalizeKey(entry.temporal_status || entry.temporalStatus) === 'future leakage');
  const futureLeakageCount = Math.max(
    Number.isFinite(declaredFutureLeakage) ? declaredFutureLeakage : 0,
    futurePapers.length + temporalStatusFuture.length
  );
  return {
    evaluated: Number.isFinite(cutoff),
    time_cutoff: Number.isFinite(cutoff) ? cutoff : null,
    future_leakage_count: futureLeakageCount,
    future_paper_count: futurePapers.length,
    temporal_status_future_count: temporalStatusFuture.length
  };
}

function evaluatePacket(packetInput = {}, caseInput = {}, options = {}) {
  const mustCite = evaluateMustCiteRecall(packetInput, caseInput, options);
  const novelty = evaluateNoveltyCertificate(packetInput, caseInput);
  const claimGrounding = evaluateClaimGrounding(packetInput, caseInput);
  const storyline = evaluateStorylineTraceability(packetInput);
  const bridgeRerank = evaluateBridgeRerankSignal(packetInput, caseInput, options);
  const temporal = evaluateTemporalCutoff(packetInput, caseInput);
  const historicalComponents = [
    mustCite.evaluated ? mustCite.metrics[`recall@${options.primaryCutoff}`] : null,
    novelty.evaluated ? novelty.score : null,
    claimGrounding.evaluated ? claimGrounding.source_span_completeness : null,
    storyline.evaluated ? storyline.trace_coverage : null,
    bridgeRerank.evaluated ? bridgeRerank.metrics[`recall@${options.primaryCutoff}`] : null,
    temporal.evaluated ? (temporal.future_leakage_count === 0 ? 1 : 0) : null
  ].filter((value) => value !== null && Number.isFinite(Number(value)));

  return {
    must_cite: mustCite,
    novelty,
    claim_grounding: claimGrounding,
    storyline,
    bridge_rerank: bridgeRerank,
    temporal,
    historical_score: roundMetric(average(historicalComponents, null))
  };
}

function normalizeCase(caseInput = {}, index = 0) {
  const candidatePacket = firstObject(
    caseInput.candidate,
    caseInput.candidatePacket,
    caseInput.candidate_packet,
    caseInput.system,
    caseInput.systemPacket,
    caseInput.system_packet,
    caseInput.packet
  );
  const baselinePacket = firstObject(
    caseInput.baseline,
    caseInput.baselinePacket,
    caseInput.baseline_packet,
    caseInput.liveDiscoveryBaseline,
    caseInput.live_discovery_baseline
  );
  return {
    ...caseInput,
    id: compactText(caseInput.id || caseInput.case_id || caseInput.caseId || `case:${index + 1}`),
    dataset: compactText(caseInput.dataset || caseInput.benchmark || caseInput.source || 'custom'),
    candidatePacket,
    baselinePacket
  };
}

function normalizeBenchmark(input = {}) {
  const raw = asObject(input);
  const cases = firstArray(raw.cases, raw.replays, raw.queries, raw.items);
  return {
    name: compactText(raw.name || raw.dataset || 'idea-catalyst-historical-replay'),
    format: compactText(raw.format || raw.dataset_format || raw.datasetFormat || 'custom'),
    cases: cases.map(normalizeCase)
  };
}

function resolvePrimaryCutoff(cutoffs = []) {
  const numeric = cutoffs.map((value) => Math.max(1, Number.parseInt(value, 10))).filter(Number.isFinite);
  if (numeric.includes(20)) return 20;
  return numeric.at(-1) || 20;
}

function nestedMetric(root = {}, pathParts = []) {
  return pathParts.reduce((value, key) => value?.[key], root);
}

function aggregateRootMetric(caseResults = [], rootName = 'candidate', pathParts = []) {
  const values = caseResults
    .map((entry) => nestedMetric(entry[rootName], pathParts))
    .map(Number)
    .filter(Number.isFinite);
  return roundMetric(average(values, null));
}

function aggregateCaseMetric(caseResults = [], pathParts = []) {
  return aggregateRootMetric(caseResults, 'candidate', pathParts);
}

function aggregateBaselineMetric(caseResults = [], pathParts = []) {
  return aggregateRootMetric(caseResults, 'baseline', pathParts);
}

function aggregateMetricImprovement(caseResults = [], pathParts = []) {
  const values = caseResults
    .map((entry) => {
      const candidateValue = Number(nestedMetric(entry.candidate, pathParts));
      const baselineValue = Number(nestedMetric(entry.baseline, pathParts));
      return Number.isFinite(candidateValue) && Number.isFinite(baselineValue)
        ? candidateValue - baselineValue
        : null;
    })
    .filter(Number.isFinite);
  return roundMetric(average(values, null));
}

function claimUnsupportedRate(claimGrounding = {}) {
  const claimCount = Number(claimGrounding?.claim_count);
  const ungroundedCount = Number(claimGrounding?.ungrounded_claim_count);
  if (!Number.isFinite(claimCount) || claimCount <= 0 || !Number.isFinite(ungroundedCount)) return null;
  return ungroundedCount / claimCount;
}

function aggregateUnsupportedClaimRate(caseResults = [], rootName = 'candidate') {
  const values = caseResults
    .map((entry) => claimUnsupportedRate(entry[rootName]?.claim_grounding))
    .filter(Number.isFinite);
  return roundMetric(average(values, null));
}

function aggregateUnsupportedClaimRateReduction(caseResults = []) {
  const values = caseResults
    .map((entry) => {
      const candidateRate = claimUnsupportedRate(entry.candidate?.claim_grounding);
      const baselineRate = claimUnsupportedRate(entry.baseline?.claim_grounding);
      return Number.isFinite(candidateRate) && Number.isFinite(baselineRate)
        ? baselineRate - candidateRate
        : null;
    })
    .filter(Number.isFinite);
  return roundMetric(average(values, null));
}

function numericThreshold(thresholds = {}, name = '') {
  const value = Number(thresholds[name]);
  return Number.isFinite(value) ? value : 0;
}

function majorMetricImprovementSummary(caseResults = [], thresholds = {}, primaryCutoff = 20) {
  const items = [
    {
      id: 'must_cite_recall_at_k',
      label: `must-cite Recall@${primaryCutoff}`,
      value: aggregateMetricImprovement(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]),
      threshold: numericThreshold(thresholds, 'mustCiteRecallAtKImprovement')
    },
    {
      id: 'novelty_score',
      label: 'novelty',
      value: aggregateMetricImprovement(
        caseResults.filter((entry) => entry.candidate.novelty.gold_evaluated && entry.baseline?.novelty?.gold_evaluated),
        ['novelty', 'score']
      ),
      threshold: numericThreshold(thresholds, 'noveltyImprovement')
    },
    {
      id: 'claim_grounding_f1',
      label: 'claim grounding F1',
      value: aggregateMetricImprovement(
        caseResults.filter((entry) => entry.candidate.claim_grounding.gold_evaluated && entry.baseline?.claim_grounding?.gold_evaluated),
        ['claim_grounding', 'f1']
      ),
      threshold: numericThreshold(thresholds, 'claimGroundingF1Improvement')
    },
    {
      id: 'unsupported_claim_rate',
      label: 'unsupported claim rate reduction',
      value: aggregateUnsupportedClaimRateReduction(caseResults),
      threshold: numericThreshold(thresholds, 'unsupportedClaimRateReduction')
    },
    {
      id: 'storyline_trace_coverage',
      label: 'storyline trace coverage',
      value: aggregateMetricImprovement(caseResults, ['storyline', 'trace_coverage']),
      threshold: numericThreshold(thresholds, 'storylineTraceCoverageImprovement')
    },
    {
      id: 'historical_score',
      label: 'historical score',
      value: aggregateMetricImprovement(caseResults, ['historical_score']),
      threshold: numericThreshold(thresholds, 'historicalReplayImprovement')
    }
  ].map((entry) => {
    const evaluated = Number.isFinite(Number(entry.value));
    const passed = evaluated && Number(entry.value) >= entry.threshold;
    return {
      ...entry,
      evaluated,
      status: evaluated ? (passed ? 'passed' : 'failed') : 'not_evaluable'
    };
  });
  const passedItems = items.filter((entry) => entry.status === 'passed');
  const evaluatedItems = items.filter((entry) => entry.evaluated);
  const minRequired = Math.max(0, Number.parseInt(thresholds.minMajorMetricImprovements || 0, 10) || 0);
  return {
    min_required: minRequired,
    evaluated_count: evaluatedItems.length,
    passed_count: passedItems.length,
    passed_metric_ids: passedItems.map((entry) => entry.id),
    items
  };
}

function countEvaluated(caseResults = [], predicate) {
  return caseResults.filter(predicate).length;
}

function buildGate(name, evaluated, ok, message, fields = {}) {
  return {
    name,
    status: evaluated ? (ok ? 'passed' : 'failed') : 'incomplete',
    ok: evaluated ? Boolean(ok) : false,
    message: evaluated ? (ok ? '' : message) : message,
    ...fields
  };
}

function buildGates(caseResults = [], thresholds = {}, primaryCutoff = 20) {
  const mustCiteEvaluated = countEvaluated(caseResults, (entry) => entry.candidate.must_cite.evaluated);
  const noveltyEvaluated = countEvaluated(caseResults, (entry) => entry.candidate.novelty.gold_evaluated && entry.baseline?.novelty?.gold_evaluated);
  const claimEvaluated = countEvaluated(caseResults, (entry) => entry.candidate.claim_grounding.evaluated);
  const storylineEvaluated = countEvaluated(caseResults, (entry) => entry.candidate.storyline.evaluated);
  const replayEvaluated = countEvaluated(caseResults, (entry) => entry.candidate.temporal.evaluated && entry.baseline?.historical_score !== null);
  const sourceBackedUngrounded = caseResults
    .reduce((sum, entry) => sum + (entry.candidate.claim_grounding.source_backed_ungrounded_claim_count || 0), 0);
  const futureLeakageCount = caseResults
    .reduce((sum, entry) => sum + (entry.candidate.temporal.future_leakage_count || 0), 0);
  const mustCiteRecall = aggregateCaseMetric(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]);
  const baselineMustCiteRecall = aggregateBaselineMetric(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]);
  const mustCiteRecallImprovement = aggregateMetricImprovement(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]);
  const claimGroundingF1 = aggregateCaseMetric(caseResults.filter((entry) => entry.candidate.claim_grounding.gold_evaluated), ['claim_grounding', 'f1']);
  const baselineClaimGroundingF1 = aggregateBaselineMetric(caseResults.filter((entry) => entry.baseline?.claim_grounding?.gold_evaluated), ['claim_grounding', 'f1']);
  const claimGroundingF1Improvement = aggregateMetricImprovement(
    caseResults.filter((entry) => entry.candidate.claim_grounding.gold_evaluated && entry.baseline?.claim_grounding?.gold_evaluated),
    ['claim_grounding', 'f1']
  );
  const claimCompleteness = aggregateCaseMetric(caseResults, ['claim_grounding', 'source_span_completeness']);
  const unsupportedClaimRate = aggregateUnsupportedClaimRate(caseResults, 'candidate');
  const baselineUnsupportedClaimRate = aggregateUnsupportedClaimRate(caseResults, 'baseline');
  const unsupportedClaimRateReduction = aggregateUnsupportedClaimRateReduction(caseResults);
  const storylineCoverage = aggregateCaseMetric(caseResults, ['storyline', 'trace_coverage']);
  const baselineStorylineCoverage = aggregateBaselineMetric(caseResults, ['storyline', 'trace_coverage']);
  const storylineCoverageImprovement = aggregateMetricImprovement(caseResults, ['storyline', 'trace_coverage']);
  const noveltyImprovements = caseResults
    .filter((entry) => entry.candidate.novelty.gold_evaluated && entry.baseline?.novelty?.gold_evaluated)
    .map((entry) => entry.candidate.novelty.score - entry.baseline.novelty.score)
    .filter(Number.isFinite);
  const historicalImprovements = caseResults
    .filter((entry) => entry.candidate.temporal.evaluated && entry.baseline?.historical_score !== null)
    .map((entry) => entry.candidate.historical_score - entry.baseline.historical_score)
    .filter(Number.isFinite);
  const mustCiteImprovementThreshold = Number(thresholds.mustCiteRecallAtKImprovement || 0);
  const claimF1ImprovementThreshold = Number(thresholds.claimGroundingF1Improvement || 0);
  const unsupportedRateReductionThreshold = Number(thresholds.unsupportedClaimRateReduction || 0);
  const majorMetricSummary = majorMetricImprovementSummary(caseResults, thresholds, primaryCutoff);

  return [
    buildGate(
      'must_cite_recall_at_k',
      mustCiteEvaluated > 0,
      mustCiteRecall >= thresholds.mustCiteRecallAtK
        && (
          mustCiteImprovementThreshold <= 0
            || (mustCiteRecallImprovement !== null && mustCiteRecallImprovement >= mustCiteImprovementThreshold)
        ),
      `must_cite_set Recall@${primaryCutoff} is below threshold`,
      {
        evaluated_cases: mustCiteEvaluated,
        recall_at_k: mustCiteRecall,
        baseline_recall_at_k: baselineMustCiteRecall,
        mean_improvement: mustCiteRecallImprovement,
        threshold: thresholds.mustCiteRecallAtK,
        improvement_threshold: mustCiteImprovementThreshold,
        k: primaryCutoff
      }
    ),
    buildGate(
      'novelty_beats_baseline',
      noveltyEvaluated > 0,
      average(noveltyImprovements, 0) >= thresholds.noveltyImprovement,
      'novelty certificate does not beat baseline on gold-labeled cases',
      { evaluated_cases: noveltyEvaluated, mean_improvement: roundMetric(average(noveltyImprovements, null)), threshold: thresholds.noveltyImprovement }
    ),
    buildGate(
      'claim_grounding',
      claimEvaluated > 0,
      sourceBackedUngrounded <= thresholds.sourceBackedUngroundedClaims
        && (
          claimGroundingF1 === null
            ? claimCompleteness >= thresholds.claimSourceSpanCompleteness
            : claimGroundingF1 >= thresholds.claimGroundingF1
        ),
      'claim grounding is below threshold or source_backed claims are ungrounded',
      {
        evaluated_cases: claimEvaluated,
        claim_grounding_f1: claimGroundingF1,
        baseline_claim_grounding_f1: baselineClaimGroundingF1,
        claim_grounding_f1_improvement: claimGroundingF1Improvement,
        unsupported_claim_rate: unsupportedClaimRate,
        baseline_unsupported_claim_rate: baselineUnsupportedClaimRate,
        unsupported_claim_rate_reduction: unsupportedClaimRateReduction,
        source_span_completeness: claimCompleteness,
        source_backed_ungrounded_claim_count: sourceBackedUngrounded,
        f1_threshold: thresholds.claimGroundingF1,
        f1_improvement_threshold: claimF1ImprovementThreshold,
        unsupported_rate_reduction_threshold: unsupportedRateReductionThreshold,
        completeness_threshold: thresholds.claimSourceSpanCompleteness
      }
    ),
    buildGate(
      'claim_grounding_release_lift',
      claimEvaluated > 0,
      (
        claimF1ImprovementThreshold <= 0
          || (claimGroundingF1Improvement !== null && claimGroundingF1Improvement >= claimF1ImprovementThreshold)
      ) && (
        unsupportedRateReductionThreshold <= 0
          || (unsupportedClaimRateReduction !== null && unsupportedClaimRateReduction >= unsupportedRateReductionThreshold)
      ),
      'claim F1 lift or unsupported claim rate reduction is below release threshold',
      {
        evaluated_cases: claimEvaluated,
        claim_grounding_f1: claimGroundingF1,
        baseline_claim_grounding_f1: baselineClaimGroundingF1,
        claim_grounding_f1_improvement: claimGroundingF1Improvement,
        unsupported_claim_rate: unsupportedClaimRate,
        baseline_unsupported_claim_rate: baselineUnsupportedClaimRate,
        unsupported_claim_rate_reduction: unsupportedClaimRateReduction,
        f1_improvement_threshold: claimF1ImprovementThreshold,
        unsupported_rate_reduction_threshold: unsupportedRateReductionThreshold,
        source_span_completeness: claimCompleteness,
        source_backed_ungrounded_claim_count: sourceBackedUngrounded
      }
    ),
    buildGate(
      'storyline_traceability',
      storylineEvaluated > 0,
      storylineCoverage >= thresholds.storylineTraceCoverage,
      'storyline_dag beat trace coverage is below threshold',
      {
        evaluated_cases: storylineEvaluated,
        trace_coverage: storylineCoverage,
        baseline_trace_coverage: baselineStorylineCoverage,
        mean_improvement: storylineCoverageImprovement,
        threshold: thresholds.storylineTraceCoverage,
        improvement_threshold: thresholds.storylineTraceCoverageImprovement
      }
    ),
    buildGate(
      'major_metrics_beat_baseline',
      true,
      majorMetricSummary.min_required <= 0
        || majorMetricSummary.passed_count >= majorMetricSummary.min_required,
      'fewer than the configured number of major metrics beat the baseline',
      {
        major_metric_improvement_count: majorMetricSummary.passed_count,
        evaluated_major_metric_count: majorMetricSummary.evaluated_count,
        min_major_metric_improvements: majorMetricSummary.min_required,
        passed_metric_ids: majorMetricSummary.passed_metric_ids,
        major_metric_improvements: majorMetricSummary.items
      }
    ),
    buildGate(
      'historical_replay_beats_live_discovery',
      replayEvaluated > 0,
      futureLeakageCount <= thresholds.futureLeakageCount
        && average(historicalImprovements, 0) >= thresholds.historicalReplayImprovement,
      'historical replay does not beat baseline under the strict time cutoff',
      {
        evaluated_cases: replayEvaluated,
        mean_improvement: roundMetric(average(historicalImprovements, null)),
        future_leakage_count: futureLeakageCount,
        improvement_threshold: thresholds.historicalReplayImprovement,
        future_leakage_threshold: thresholds.futureLeakageCount
      }
    )
  ];
}

function reportStatus(gates = []) {
  if (gates.some((gate) => gate.status === 'failed')) return 'failed';
  if (gates.some((gate) => gate.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

function createArtifacts(outputDir, runId) {
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  return {
    outputDir: absoluteOutputDir,
    reportPath: path.join(absoluteOutputDir, 'report.json'),
    reportMarkdownPath: path.join(absoluteOutputDir, 'report.md'),
    summaryTsvPath: path.join(absoluteOutputDir, 'summary.tsv'),
    manifestPath: path.join(absoluteOutputDir, 'manifest.json'),
    runId
  };
}

function renderSummaryTsv(report = {}) {
  const lines = ['case_id\tdataset\tmust_cite_recall\tclaim_f1\tstoryline_trace_coverage\tbridge_rerank_recall\thistorical_score\tbaseline_historical_score\tfuture_leakage_count'];
  for (const entry of report.case_results || []) {
    lines.push([
      entry.case_id,
      entry.dataset,
      entry.candidate.must_cite.metrics?.[`recall@${report.config.primaryCutoff}`] ?? '',
      entry.candidate.claim_grounding.f1 ?? '',
      entry.candidate.storyline.trace_coverage ?? '',
      entry.candidate.bridge_rerank.metrics?.[`recall@${report.config.primaryCutoff}`] ?? '',
      entry.candidate.historical_score ?? '',
      entry.baseline?.historical_score ?? '',
      entry.candidate.temporal.future_leakage_count ?? ''
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function renderIdeaCatalystHistoricalReplayReport(report = {}) {
  const lines = [
    `# Idea-Catalyst Historical Replay: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Gates',
    '',
    '| Gate | Status | Key Metric | Threshold |',
    '|---|---:|---:|---:|'
  ];

  for (const gate of report.gates || []) {
    const metric = gate.recall_at_k ?? gate.mean_improvement ?? gate.claim_grounding_f1 ?? gate.trace_coverage ?? gate.future_leakage_count ?? '';
    const threshold = gate.threshold ?? gate.f1_threshold ?? gate.completeness_threshold ?? gate.improvement_threshold ?? gate.future_leakage_threshold ?? '';
    lines.push(`| ${gate.name} | ${gate.status} | ${metric} | ${threshold} |`);
  }

  lines.push('', '## Cases', '', '| Case | Dataset | Historical Score | Baseline | Future Leakage |', '|---|---:|---:|---:|---:|');
  for (const entry of report.case_results || []) {
    lines.push(`| ${entry.case_id} | ${entry.dataset} | ${entry.candidate.historical_score ?? ''} | ${entry.baseline?.historical_score ?? ''} | ${entry.candidate.temporal.future_leakage_count ?? ''} |`);
  }
  return lines.join('\n');
}

export async function writeIdeaCatalystHistoricalReplayArtifacts(outputDir, report = {}, options = {}) {
  const runId = options.runId || report.runId || `idea-catalyst-replay-${stableHash(JSON.stringify(report.config || {}), 10)}`;
  const artifacts = createArtifacts(outputDir, runId);
  await ensureDir(artifacts.outputDir);
  const reportWithArtifacts = {
    ...report,
    artifacts
  };
  await writeJson(artifacts.reportPath, reportWithArtifacts);
  await writeText(artifacts.reportMarkdownPath, `${renderIdeaCatalystHistoricalReplayReport(reportWithArtifacts)}\n`);
  await writeText(artifacts.summaryTsvPath, renderSummaryTsv(reportWithArtifacts));
  await writeJson(artifacts.manifestPath, {
    contractVersion: IDEA_CATALYST_HISTORICAL_REPLAY_VERSION,
    runId,
    reportPath: artifacts.reportPath,
    summaryTsvPath: artifacts.summaryTsvPath,
    createdAt: report.generatedAt
  });
  return artifacts;
}

export async function runIdeaCatalystHistoricalReplay(params = {}) {
  const benchmark = normalizeBenchmark(params.benchmark || (params.datasetPath ? await readJson(params.datasetPath) : {}));
  const cutoffs = asArray(params.cutoffs || benchmark.cutoffs || DEFAULT_CUTOFFS)
    .map((value) => Math.max(1, Number.parseInt(value, 10)))
    .filter(Number.isFinite);
  const primaryCutoff = Number(params.primaryCutoff || params.primary_cutoff || resolvePrimaryCutoff(cutoffs));
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...asObject(params.thresholds)
  };
  const caseResults = benchmark.cases.map((caseInput) => {
    const candidate = evaluatePacket(caseInput.candidatePacket, caseInput, { cutoffs, primaryCutoff });
    const baseline = Object.keys(caseInput.baselinePacket || {}).length
      ? evaluatePacket(caseInput.baselinePacket, caseInput, { cutoffs, primaryCutoff })
      : null;
    return {
      case_id: caseInput.id,
      dataset: caseInput.dataset,
      time_cutoff: caseInput.timeCutoff || caseInput.time_cutoff || null,
      candidate,
      baseline
    };
  });
  const gates = buildGates(caseResults, thresholds, primaryCutoff);
  const majorMetricSummary = majorMetricImprovementSummary(caseResults, thresholds, primaryCutoff);
  const generatedAt = new Date().toISOString();
  const runId = compactText(params.runId || params.run_id)
    || `idea-catalyst-replay-${stableHash(`${benchmark.name}:${generatedAt}`, 10)}`;
  const report = {
    contractVersion: IDEA_CATALYST_HISTORICAL_REPLAY_VERSION,
    runId,
    status: reportStatus(gates),
    generatedAt,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      case_count: benchmark.cases.length
    },
    config: {
      cutoffs,
      primaryCutoff,
      thresholds
    },
    gates,
    metrics: {
      must_cite_recall_at_k: aggregateCaseMetric(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]),
      must_cite_recall_at_k_baseline: aggregateBaselineMetric(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]),
      must_cite_recall_at_k_improvement: aggregateMetricImprovement(caseResults, ['must_cite', 'metrics', `recall@${primaryCutoff}`]),
      novelty_score: aggregateCaseMetric(caseResults.filter((entry) => entry.candidate.novelty.gold_evaluated), ['novelty', 'score']),
      novelty_score_baseline: aggregateBaselineMetric(caseResults.filter((entry) => entry.baseline?.novelty?.gold_evaluated), ['novelty', 'score']),
      novelty_score_improvement: aggregateMetricImprovement(
        caseResults.filter((entry) => entry.candidate.novelty.gold_evaluated && entry.baseline?.novelty?.gold_evaluated),
        ['novelty', 'score']
      ),
      claim_grounding_f1: aggregateCaseMetric(caseResults.filter((entry) => entry.candidate.claim_grounding.gold_evaluated), ['claim_grounding', 'f1']),
      claim_grounding_f1_baseline: aggregateBaselineMetric(caseResults.filter((entry) => entry.baseline?.claim_grounding?.gold_evaluated), ['claim_grounding', 'f1']),
      claim_grounding_f1_improvement: aggregateMetricImprovement(
        caseResults.filter((entry) => entry.candidate.claim_grounding.gold_evaluated && entry.baseline?.claim_grounding?.gold_evaluated),
        ['claim_grounding', 'f1']
      ),
      unsupported_claim_rate: aggregateUnsupportedClaimRate(caseResults, 'candidate'),
      baseline_unsupported_claim_rate: aggregateUnsupportedClaimRate(caseResults, 'baseline'),
      unsupported_claim_rate_reduction: aggregateUnsupportedClaimRateReduction(caseResults),
      claim_source_span_completeness: aggregateCaseMetric(caseResults, ['claim_grounding', 'source_span_completeness']),
      storyline_trace_coverage: aggregateCaseMetric(caseResults, ['storyline', 'trace_coverage']),
      storyline_trace_coverage_baseline: aggregateBaselineMetric(caseResults, ['storyline', 'trace_coverage']),
      storyline_trace_coverage_improvement: aggregateMetricImprovement(caseResults, ['storyline', 'trace_coverage']),
      bridge_rerank_recall_at_k: aggregateCaseMetric(caseResults, ['bridge_rerank', 'metrics', `recall@${primaryCutoff}`]),
      historical_score: aggregateCaseMetric(caseResults, ['historical_score']),
      historical_score_baseline: aggregateBaselineMetric(caseResults, ['historical_score']),
      historical_score_improvement: aggregateMetricImprovement(caseResults, ['historical_score']),
      major_metric_improvement_count: majorMetricSummary.passed_count,
      evaluated_major_metric_count: majorMetricSummary.evaluated_count,
      major_metric_improvements: majorMetricSummary.items
    },
    case_results: caseResults
  };

  if (params.outputDir) {
    report.artifacts = await writeIdeaCatalystHistoricalReplayArtifacts(params.outputDir, report, { runId });
  }

  return report;
}
