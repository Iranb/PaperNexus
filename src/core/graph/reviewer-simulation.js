import {
  asArray,
  average,
  compactText,
  stableHash
} from './innovation-artifact-utils.js';
import { buildContributionClaims } from './claim-linking.js';
import {
  attachModelAssistedReview,
  buildModelAssistedInnovationContext
} from './model-assisted-innovation.js';
import { buildNoveltyCertificate } from './novelty-scoring.js';
import { buildMustCiteSet } from './prior-art-contrast.js';

export function buildReviewPacket(payload = {}, options = {}) {
  const claims = options.contributionClaims || buildContributionClaims(payload, options);
  const mustCiteSet = options.mustCiteSet || buildMustCiteSet(payload, options);
  const noveltyCertificate = options.noveltyCertificate || buildNoveltyCertificate(payload, { ...options, contributionClaims: claims, mustCiteSet });
  const unsupportedClaims = claims.filter((claim) => !asArray(claim.source_span_ids).length);
  const metadataOnlyCitations = mustCiteSet.filter((entry) => entry.coverage_status !== 'covered');
  const futureLeakage = mustCiteSet.filter((entry) => entry.temporal_status === 'future_leakage');
  const majorConcerns = [
    ...unsupportedClaims.map((claim) => ({
      concern_id: `concern:${stableHash(`unsupported:${claim.claim_id}`, 12)}`,
      reviewer_role: 'reproducibility',
      severity: 'major',
      concern: 'Contribution claim lacks source-span grounding.',
      affected_claim_ids: [claim.claim_id],
      evidence_gap: 'source_span_ids',
      addressed: false
    })),
    ...metadataOnlyCitations.map((entry) => ({
      concern_id: `concern:${stableHash(`mustcite:${entry.citation_id}`, 12)}`,
      reviewer_role: 'novelty',
      severity: 'minor',
      concern: 'Must-cite entry is metadata-only and should be backed by citation context or source span.',
      affected_claim_ids: [],
      must_cite_id: entry.citation_id,
      evidence_gap: 'citation_context',
      addressed: false
    })),
    ...futureLeakage.map((entry) => ({
      concern_id: `concern:${stableHash(`future:${entry.citation_id}`, 12)}`,
      reviewer_role: 'methods',
      severity: 'major',
      concern: 'Must-cite entry appears after the configured time cutoff.',
      affected_claim_ids: [],
      must_cite_id: entry.citation_id,
      evidence_gap: 'temporal_cutoff',
      addressed: false
    }))
  ];
  const reviewerPanel = asArray(options.reviewerPanel || options.reviewer_panel || payload.reviewerPanel || payload.reviewer_panel);
  const roles = reviewerPanel.length ? reviewerPanel : ['novelty', 'methods', 'reproducibility', 'outsider'];
  const reviewers = roles.map((role) => {
    const normalizedRole = compactText(role).toLowerCase().replace(/[\s-]+/g, '_');
    const score = normalizedRole.includes('novelty')
      ? noveltyCertificate.novelty
      : normalizedRole.includes('repro')
        ? noveltyCertificate.grounding
        : normalizedRole.includes('method')
          ? noveltyCertificate.feasibility
          : average([noveltyCertificate.significance, noveltyCertificate.grounding], 0);
    return {
      reviewer_id: `reviewer:${normalizedRole}`,
      role: normalizedRole,
      score: Number(score.toFixed(4)),
      concerns: majorConcerns.filter((concern) => concern.reviewer_role === normalizedRole).map((concern) => concern.concern_id),
      summary: majorConcerns.some((concern) => concern.reviewer_role === normalizedRole)
        ? `${normalizedRole} review found evidence gaps that should be resolved before treating the proposal as source-backed.`
        : `${normalizedRole} review found no blocking concern in the structured packet.`
    };
  });
  const majorCount = majorConcerns.filter((concern) => concern.severity === 'major').length;
  const packet = {
    packet_version: 'review-packet-v1',
    reviewers,
    meta_review: {
      recommendation: majorCount > 0 ? 'major_revision' : (noveltyCertificate.grounding >= 0.75 ? 'weak_accept' : 'borderline'),
      major_concern_count: majorCount,
      summary: majorCount > 0
        ? 'Resolve major claim grounding or temporal concerns before promoting this idea.'
        : 'Structured review found enough grounding for a proposal-level next step.'
    },
    major_concerns: majorConcerns
  };
  const modelAssisted = options.modelAssistedContext || buildModelAssistedInnovationContext(payload, options);
  return attachModelAssistedReview(packet, modelAssisted);
}
