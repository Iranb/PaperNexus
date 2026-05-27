import {
  asArray,
  average,
  evidenceTierScore,
  normalizeScore
} from './innovation-artifact-utils.js';
import { buildContributionClaims } from './claim-linking.js';
import {
  attachModelAssistedNovelty,
  buildModelAssistedInnovationContext
} from './model-assisted-innovation.js';
import { buildMustCiteSet } from './prior-art-contrast.js';

export function buildNoveltyCertificate(payload = {}, options = {}) {
  const fragments = asArray(payload.idea_fragments || payload.ideaFragments);
  const claims = options.contributionClaims || buildContributionClaims(payload, options);
  const mustCiteSet = options.mustCiteSet || buildMustCiteSet(payload, options);
  const unsupportedClaims = claims.filter((claim) => !asArray(claim.source_span_ids).length);
  const futureLeakage = mustCiteSet.filter((entry) => entry.temporal_status === 'future_leakage');
  const novelty = average(fragments.map((fragment) => normalizeScore(fragment.novelty_score ?? fragment.noveltyScore, 0.5)), 0);
  const significance = average(fragments.map((fragment) => normalizeScore(fragment.usefulness_score ?? fragment.usefulnessScore ?? fragment.ranking_signals?.interdisciplinary_potential, 0.5)), 0);
  const grounding = claims.length ? (claims.length - unsupportedClaims.length) / claims.length : 0;
  const feasibility = average(claims.map((claim) => evidenceTierScore(claim.evidence_tier)), 0);
  const mustCiteCompleteness = mustCiteSet.length
    ? mustCiteSet.filter((entry) => entry.coverage_status === 'covered').length / mustCiteSet.length
    : 0;
  const temporalValidity = futureLeakage.length ? 0 : 1;
  const scores = {
    novelty: Number(novelty.toFixed(4)),
    significance: Number(significance.toFixed(4)),
    feasibility: Number(feasibility.toFixed(4)),
    grounding: Number(grounding.toFixed(4)),
    must_cite_completeness: Number(mustCiteCompleteness.toFixed(4)),
    temporal_validity: temporalValidity
  };

  const certificate = {
    certificate_version: 'novelty-certificate-v1',
    novelty: scores.novelty,
    significance: scores.significance,
    feasibility: scores.feasibility,
    grounding: scores.grounding,
    must_cite_completeness: scores.must_cite_completeness,
    temporal_validity: scores.temporal_validity,
    claim_count: claims.length,
    unsupported_claim_count: unsupportedClaims.length,
    must_cite_count: mustCiteSet.length,
    future_leakage_count: futureLeakage.length,
    reasons: [
      {
        axis: 'novelty',
        score: scores.novelty,
        reason: fragments.length
          ? `Novelty is averaged from ${fragments.length} normalized fragment novelty scores.`
          : 'Novelty is 0 because no idea fragments were available.'
      },
      {
        axis: 'significance',
        score: scores.significance,
        reason: fragments.length
          ? `Significance is averaged from ${fragments.length} usefulness or interdisciplinary-potential signals.`
          : 'Significance is 0 because no idea fragments were available.'
      },
      {
        axis: 'feasibility',
        score: scores.feasibility,
        reason: claims.length
          ? `Feasibility is averaged from evidence tiers across ${claims.length} contribution claims.`
          : 'Feasibility is 0 because no contribution claims were available.'
      },
      {
        axis: 'grounding',
        score: scores.grounding,
        reason: claims.length
          ? `${claims.length - unsupportedClaims.length}/${claims.length} contribution claims have source spans.`
          : 'Grounding is 0 because no contribution claims were available.'
      },
      {
        axis: 'must_cite_completeness',
        score: scores.must_cite_completeness,
        reason: mustCiteSet.length
          ? `${mustCiteSet.filter((entry) => entry.coverage_status === 'covered').length}/${mustCiteSet.length} must-cite entries are span-backed.`
          : 'Must-cite completeness is 0 because no must-cite entries were available.'
      },
      {
        axis: 'temporal_validity',
        score: scores.temporal_validity,
        reason: futureLeakage.length
          ? `${futureLeakage.length} must-cite entries violate the time cutoff.`
          : 'Temporal validity is 1 because no future leakage was detected from the current cutoff.'
      }
    ],
    time_cutoff: options.timeCutoff || options.time_cutoff || payload.timeCutoff || payload.time_cutoff || null
  };
  const modelAssisted = options.modelAssistedContext || buildModelAssistedInnovationContext(payload, options);
  return attachModelAssistedNovelty(certificate, modelAssisted);
}
