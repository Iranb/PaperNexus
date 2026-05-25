import { jaccardSimilarity, stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { evidenceTierRank, normalizeIdeaCandidates } from './idea-scoring.js';

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeMode(value) {
  const mode = String(value || 'topk').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (mode === 'mmr') return 'mmr';
  if (mode === 'submodular' || mode === 'greedy_submodular') return 'submodular';
  if (mode === 'dpp') return 'dpp';
  return 'topk';
}

function evidenceGate(candidate = {}, minEvidenceTier = 'moderate', requireBridgePath = false) {
  if (evidenceTierRank(candidate.evidenceTier) < evidenceTierRank(minEvidenceTier)) {
    return `evidence_tier_below_${minEvidenceTier}`;
  }
  if (requireBridgePath && !candidate.bridgePathIds?.length) {
    return 'missing_bridge_path';
  }
  return null;
}

function sortByUtility(candidates = []) {
  return [...candidates].sort((left, right) => {
    if (right.utility !== left.utility) return right.utility - left.utility;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.candidateId.localeCompare(right.candidateId);
  });
}

function candidateSimilarity(left = {}, right = {}) {
  const tokenSimilarity = jaccardSimilarity(left.similarity_text || '', right.similarity_text || '');
  const sourceOverlap = overlapRatio(left.sourceDomains, right.sourceDomains);
  const mechanismOverlap = overlapRatio(left.mechanisms, right.mechanisms);
  const bridgeOverlap = overlapRatio(left.bridgePathIds, right.bridgePathIds);
  return Math.max(tokenSimilarity, sourceOverlap, mechanismOverlap, bridgeOverlap);
}

function overlapRatio(left = [], right = []) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function coverageGain(candidate = {}, selected = []) {
  const selectedDomains = new Set(selected.flatMap((entry) => entry.sourceDomains || []));
  const selectedMechanisms = new Set(selected.flatMap((entry) => entry.mechanisms || []));
  const selectedAspects = new Set(selected.flatMap((entry) => entry.targetAspects || []));
  return {
    source_domains: unique((candidate.sourceDomains || []).filter((value) => !selectedDomains.has(value))),
    mechanisms: unique((candidate.mechanisms || []).filter((value) => !selectedMechanisms.has(value))),
    target_aspects: unique((candidate.targetAspects || []).filter((value) => !selectedAspects.has(value)))
  };
}

function selectionRecord(candidate = {}, rank, fields = {}) {
  return {
    candidateId: candidate.candidateId,
    candidate_id: candidate.candidateId,
    rank,
    score: Number((fields.score ?? candidate.utility ?? 0).toFixed(4)),
    marginalGain: fields.marginalGain === undefined ? undefined : Number(fields.marginalGain.toFixed(4)),
    marginal_gain: fields.marginalGain === undefined ? undefined : Number(fields.marginalGain.toFixed(4)),
    redundancyPenalty: fields.redundancyPenalty === undefined ? undefined : Number(fields.redundancyPenalty.toFixed(4)),
    redundancy_penalty: fields.redundancyPenalty === undefined ? undefined : Number(fields.redundancyPenalty.toFixed(4)),
    coverageGain: fields.coverageGain || null,
    coverage_gain: fields.coverageGain || null,
    nearestSelectedCandidateId: fields.nearestSelectedCandidateId || null,
    nearest_selected_candidate_id: fields.nearestSelectedCandidateId || null,
    selectionReason: fields.selectionReason,
    selection_reason: fields.selectionReason
  };
}

function selectTopK(candidates = [], k = 3) {
  const selected = sortByUtility(candidates).slice(0, k);
  return {
    selected,
    records: selected.map((candidate, index) => selectionRecord(candidate, index + 1, {
      score: candidate.utility,
      marginalGain: candidate.utility,
      redundancyPenalty: 0,
      coverageGain: coverageGain(candidate, selected.slice(0, index)),
      selectionReason: 'highest_utility_after_evidence_gate'
    }))
  };
}

function selectMmr(candidates = [], k = 3, lambda = 0.65) {
  const remaining = sortByUtility(candidates);
  const selected = [];
  const records = [];
  while (selected.length < k && remaining.length) {
    const ranked = remaining.map((candidate) => {
      let nearestSelectedCandidateId = null;
      let maxSimilarity = 0;
      for (const selectedCandidate of selected) {
        const similarity = candidateSimilarity(candidate, selectedCandidate);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          nearestSelectedCandidateId = selectedCandidate.candidateId;
        }
      }
      const redundancyPenalty = (1 - lambda) * maxSimilarity;
      const marginalGain = (lambda * candidate.utility) - redundancyPenalty;
      return {
        candidate,
        nearestSelectedCandidateId,
        redundancyPenalty,
        marginalGain
      };
    }).sort((left, right) => {
      if (right.marginalGain !== left.marginalGain) return right.marginalGain - left.marginalGain;
      if (right.candidate.utility !== left.candidate.utility) return right.candidate.utility - left.candidate.utility;
      return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
    });
    const best = ranked[0];
    if (!best) break;
    selected.push(best.candidate);
    records.push(selectionRecord(best.candidate, selected.length, {
      score: best.marginalGain,
      marginalGain: best.marginalGain,
      redundancyPenalty: best.redundancyPenalty,
      coverageGain: coverageGain(best.candidate, selected.slice(0, -1)),
      nearestSelectedCandidateId: best.nearestSelectedCandidateId,
      selectionReason: selected.length === 1
        ? 'highest_utility_seed_after_evidence_gate'
        : 'maximal_marginal_relevance_against_selected_set'
    }));
    remaining.splice(remaining.findIndex((candidate) => candidate.candidateId === best.candidate.candidateId), 1);
  }
  return { selected, records };
}

function maxSimilarityToSelected(candidate = {}, selected = []) {
  let nearestSelectedCandidateId = null;
  let maxSimilarity = 0;
  for (const selectedCandidate of selected) {
    const similarity = candidateSimilarity(candidate, selectedCandidate);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      nearestSelectedCandidateId = selectedCandidate.candidateId;
    }
  }
  return { nearestSelectedCandidateId, maxSimilarity };
}

function coverageValue(gain = {}) {
  return Math.min(1, (
    (0.35 * Math.min(3, gain.source_domains?.length || 0))
    + (0.4 * Math.min(3, gain.mechanisms?.length || 0))
    + (0.25 * Math.min(3, gain.target_aspects?.length || 0))
  ) / 3);
}

function selectSubmodular(candidates = [], k = 3) {
  const remaining = sortByUtility(candidates);
  const selected = [];
  const records = [];
  while (selected.length < k && remaining.length) {
    const ranked = remaining.map((candidate) => {
      const gain = coverageGain(candidate, selected);
      const coverage = coverageValue(gain);
      const { nearestSelectedCandidateId, maxSimilarity } = maxSimilarityToSelected(candidate, selected);
      const redundancyPenalty = 0.15 * maxSimilarity;
      const marginalGain = (0.65 * candidate.utility) + (0.35 * coverage) - redundancyPenalty;
      return {
        candidate,
        coverageGain: gain,
        nearestSelectedCandidateId,
        redundancyPenalty,
        marginalGain
      };
    }).sort((left, right) => {
      if (right.marginalGain !== left.marginalGain) return right.marginalGain - left.marginalGain;
      if (right.candidate.utility !== left.candidate.utility) return right.candidate.utility - left.candidate.utility;
      return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
    });
    const best = ranked[0];
    if (!best) break;
    selected.push(best.candidate);
    records.push(selectionRecord(best.candidate, selected.length, {
      score: best.marginalGain,
      marginalGain: best.marginalGain,
      redundancyPenalty: best.redundancyPenalty,
      coverageGain: best.coverageGain,
      nearestSelectedCandidateId: best.nearestSelectedCandidateId,
      selectionReason: selected.length === 1
        ? 'highest_utility_seed_after_evidence_gate'
        : 'greedy_submodular_coverage_gain_after_evidence_gate'
    }));
    remaining.splice(remaining.findIndex((candidate) => candidate.candidateId === best.candidate.candidateId), 1);
  }
  return { selected, records };
}

function dppFeatureTokens(candidate = {}) {
  return unique(tokenizeWithoutStopwords([
    candidate.similarity_text || '',
    ...(candidate.sourceDomains || []),
    ...(candidate.mechanisms || []),
    ...(candidate.targetAspects || [])
  ].join(' '))).sort();
}

function cosineTokenSimilarity(leftTokens = [], rightTokens = []) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) intersection += 1;
  }
  return intersection / Math.sqrt(leftTokens.length * rightTokens.length);
}

function dppKernel(left = {}, right = {}, tokenCache = new Map()) {
  const leftQuality = Math.max(0.05, left.utility || 0);
  const rightQuality = Math.max(0.05, right.utility || 0);
  if (left.candidateId === right.candidateId) return (leftQuality * leftQuality) + 1e-6;
  const leftTokens = tokenCache.get(left.candidateId) || dppFeatureTokens(left);
  const rightTokens = tokenCache.get(right.candidateId) || dppFeatureTokens(right);
  tokenCache.set(left.candidateId, leftTokens);
  tokenCache.set(right.candidateId, rightTokens);
  return leftQuality * rightQuality * cosineTokenSimilarity(leftTokens, rightTokens);
}

function logDeterminant(matrix = []) {
  const n = matrix.length;
  if (!n) return 0;
  const work = matrix.map((row, rowIndex) => row.map((value, columnIndex) => (
    Number(value || 0) + (rowIndex === columnIndex ? 1e-8 : 0)
  )));
  let logDet = 0;
  for (let i = 0; i < n; i += 1) {
    let pivotRow = i;
    for (let row = i + 1; row < n; row += 1) {
      if (Math.abs(work[row][i]) > Math.abs(work[pivotRow][i])) pivotRow = row;
    }
    if (Math.abs(work[pivotRow][i]) < 1e-12) return Number.NEGATIVE_INFINITY;
    if (pivotRow !== i) [work[i], work[pivotRow]] = [work[pivotRow], work[i]];
    const pivot = work[i][i];
    if (pivot <= 0) return Number.NEGATIVE_INFINITY;
    logDet += Math.log(pivot);
    for (let row = i + 1; row < n; row += 1) {
      const factor = work[row][i] / pivot;
      for (let column = i; column < n; column += 1) {
        work[row][column] -= factor * work[i][column];
      }
    }
  }
  return logDet;
}

function dppLogDet(candidates = [], tokenCache = new Map()) {
  const matrix = candidates.map((left) => candidates.map((right) => dppKernel(left, right, tokenCache)));
  return logDeterminant(matrix);
}

function dppPanelFromSeed(candidates = [], k = 3, seedIndex = 0) {
  const ordered = sortByUtility(candidates);
  const seed = ordered[seedIndex];
  if (!seed) return null;
  const tokenCache = new Map();
  const selected = [seed];
  const remaining = ordered.filter((candidate) => candidate.candidateId !== seed.candidateId);
  let currentLogDet = dppLogDet(selected, tokenCache);
  while (selected.length < k && remaining.length) {
    const ranked = remaining.map((candidate) => {
      const nextSet = [...selected, candidate];
      const nextLogDet = dppLogDet(nextSet, tokenCache);
      return {
        candidate,
        nextLogDet,
        marginalGain: Number.isFinite(nextLogDet) ? nextLogDet - currentLogDet : Number.NEGATIVE_INFINITY
      };
    }).sort((left, right) => {
      if (right.marginalGain !== left.marginalGain) return right.marginalGain - left.marginalGain;
      return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
    });
    const best = ranked[0];
    if (!best || !Number.isFinite(best.marginalGain)) break;
    selected.push(best.candidate);
    currentLogDet = best.nextLogDet;
    remaining.splice(remaining.findIndex((candidate) => candidate.candidateId === best.candidate.candidateId), 1);
  }
  return {
    panel_id: `dpp-seed-${seedIndex + 1}`,
    selection_method: 'deterministic_seeded_dpp_greedy',
    seed_candidate_id: seed.candidateId,
    selected_candidate_ids: selected.map((candidate) => candidate.candidateId),
    log_determinant: Number(currentLogDet.toFixed(4))
  };
}

function selectDpp(candidates = [], k = 3) {
  const remaining = sortByUtility(candidates);
  const selected = [];
  const records = [];
  const tokenCache = new Map();
  let currentLogDet = 0;
  while (selected.length < k && remaining.length) {
    const ranked = remaining.map((candidate) => {
      const nextSet = [...selected, candidate];
      const nextLogDet = dppLogDet(nextSet, tokenCache);
      const marginalGain = Number.isFinite(nextLogDet) ? nextLogDet - currentLogDet : Number.NEGATIVE_INFINITY;
      const { nearestSelectedCandidateId, maxSimilarity } = maxSimilarityToSelected(candidate, selected);
      return {
        candidate,
        nearestSelectedCandidateId,
        redundancyPenalty: maxSimilarity,
        marginalGain,
        logDet: nextLogDet
      };
    }).sort((left, right) => {
      if (right.marginalGain !== left.marginalGain) return right.marginalGain - left.marginalGain;
      if (right.candidate.utility !== left.candidate.utility) return right.candidate.utility - left.candidate.utility;
      return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
    });
    const best = ranked[0];
    if (!best || !Number.isFinite(best.marginalGain)) break;
    selected.push(best.candidate);
    currentLogDet = best.logDet;
    records.push(selectionRecord(best.candidate, selected.length, {
      score: best.marginalGain,
      marginalGain: best.marginalGain,
      redundancyPenalty: best.redundancyPenalty,
      coverageGain: coverageGain(best.candidate, selected.slice(0, -1)),
      nearestSelectedCandidateId: best.nearestSelectedCandidateId,
      selectionReason: selected.length === 1
        ? 'highest_quality_dpp_seed_after_evidence_gate'
        : 'greedy_dpp_map_logdet_gain_after_evidence_gate'
    }));
    remaining.splice(remaining.findIndex((candidate) => candidate.candidateId === best.candidate.candidateId), 1);
  }
  return {
    selected,
    records,
    dpp_panels: uniqueDppPanels([{
      panel_id: 'dpp-map-primary',
      selection_method: 'greedy_dpp_map',
      selected_candidate_ids: selected.map((candidate) => candidate.candidateId),
      log_determinant: Number(currentLogDet.toFixed(4))
    }, ...[0, 1, 2].map((seedIndex) => dppPanelFromSeed(candidates, k, seedIndex)).filter(Boolean)])
  };
}

function uniqueDppPanels(panels = []) {
  const seen = new Set();
  const result = [];
  for (const panel of panels) {
    const key = (panel.selected_candidate_ids || []).join('|');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(panel);
  }
  return result;
}

export function selectIdeas(entries = [], options = {}) {
  const mode = normalizeMode(options.mode || options.selectionMode);
  const k = Math.max(1, Math.floor(Number(options.k || options.selectionK || 3)));
  const lambda = clampNumber(options.lambda ?? options.mmrLambda, 0.65, 0, 1);
  const minEvidenceTier = options.minEvidenceTier || 'moderate';
  const requireBridgePath = options.requireBridgePath === true;
  const candidates = normalizeIdeaCandidates(entries, options.context || {});
  const rejected = [];
  const eligible = [];
  for (const candidate of candidates) {
    const reason = evidenceGate(candidate, minEvidenceTier, requireBridgePath);
    if (reason) {
      rejected.push({
        candidateId: candidate.candidateId,
        candidate_id: candidate.candidateId,
        reason,
        evidenceTier: candidate.evidenceTier,
        evidence_tier: candidate.evidenceTier,
        riskFlags: candidate.riskFlags,
        risk_flags: candidate.riskFlags
      });
    } else {
      eligible.push(candidate);
    }
  }
  const result = mode === 'mmr'
    ? selectMmr(eligible, k, lambda)
    : mode === 'submodular'
      ? selectSubmodular(eligible, k)
      : mode === 'dpp'
        ? selectDpp(eligible, k)
        : selectTopK(eligible, k);
  const selectedIds = new Set(result.selected.map((candidate) => candidate.candidateId));
  const parked = eligible
    .filter((candidate) => !selectedIds.has(candidate.candidateId))
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      candidate_id: candidate.candidateId,
      reason: `not_selected_by_${mode}`,
      nearestSelectedCandidateId: nearestSelectedCandidateId(candidate, result.selected),
      nearest_selected_candidate_id: nearestSelectedCandidateId(candidate, result.selected)
    }));
  const selectedEntries = result.selected.map((candidate) => candidate.raw);
  const trace = {
    record_type: 'selection_trace',
    trace_id: `idea-selection:${stableHash(`${mode}:${k}:${lambda}:${candidates.map((candidate) => candidate.candidateId).join('|')}`, 16)}`,
    mode,
    k,
    lambda: mode === 'mmr' ? lambda : null,
    minEvidenceTier,
    min_evidence_tier: minEvidenceTier,
    requireBridgePath,
    require_bridge_path: requireBridgePath,
    candidate_count: candidates.length,
    eligible_count: eligible.length,
    selected: result.records,
    parked,
    rejected,
    ...(result.dpp_panels ? { dpp_panels: result.dpp_panels } : {}),
    metrics: {
      distinct_source_domain_count: new Set(result.selected.flatMap((candidate) => candidate.sourceDomains || [])).size,
      distinct_mechanism_count: new Set(result.selected.flatMap((candidate) => candidate.mechanisms || [])).size,
      average_pairwise_similarity: averagePairwiseSimilarity(result.selected)
    },
    limitations: [
      'MMR uses deterministic token overlap rather than embedding similarity.',
      'Submodular mode uses a greedy coverage objective over available candidate metadata.',
      'DPP mode uses a deterministic greedy MAP approximation for an auditable candidate panel, not stochastic human-validated sampling.',
      'The evidence gate is a candidate metadata check, not a new literature-validation pass.'
    ],
    generatedAt: new Date().toISOString()
  };
  return {
    mode,
    selected: selectedEntries,
    selectedCandidates: result.selected,
    selected_candidates: result.selected,
    selectedIds: [...selectedIds],
    selected_ids: [...selectedIds],
    trace,
    selection_trace: trace
  };
}

function nearestSelectedCandidateId(candidate = {}, selected = []) {
  let bestId = null;
  let bestSimilarity = 0;
  for (const selectedCandidate of selected) {
    const similarity = candidateSimilarity(candidate, selectedCandidate);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestId = selectedCandidate.candidateId;
    }
  }
  return bestId;
}

function averagePairwiseSimilarity(candidates = []) {
  if (candidates.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      total += candidateSimilarity(candidates[i], candidates[j]);
      count += 1;
    }
  }
  return Number((total / Math.max(1, count)).toFixed(4));
}
