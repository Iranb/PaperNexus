export const INTERDISCIPLINARY_POTENTIAL_RANKING_CONTRACT_VERSION = 'idea-catalyst-interdisciplinary-ranking-v1';

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(4));
}

export function buildInterdisciplinaryPotentialRanking(
  bridgeRetrieval = {},
  structuralAnalogy = {},
  params = {}
) {
  const limit = Math.max(1, Number(params.limit || 8));
  const alignmentByPathId = new Map(
    (structuralAnalogy.alignments || []).map((entry) => [entry.bridgePathId, entry])
  );

  const rankedCandidates = (bridgeRetrieval.candidateBridgePaths || [])
    .map((candidate) => {
      const alignment = alignmentByPathId.get(candidate.pathId) || null;
      const noveltyProxy = clampScore(candidate.domainNovelty);
      const groundingScore = clampScore(
        (Number(candidate.evidenceDensity || 0) * 0.55)
        + (Number(candidate.mechanismSupportDensity || 0) * 0.45)
      );
      const challengeCoverageScore = clampScore(candidate.challengeCoverageScore);
      const storyCompleteness = clampScore(
        (Number(candidate.pathCompleteness || 0) * 0.65)
        + (Number(alignment?.motifCompleteness || 0) * 0.35)
      );
      const analogyScore = clampScore(alignment?.analogyScore || 0);
      const interdisciplinaryPotential = clampScore(
        (noveltyProxy * 0.22)
        + (groundingScore * 0.24)
        + (challengeCoverageScore * 0.22)
        + (analogyScore * 0.16)
        + (storyCompleteness * 0.16)
      );

      return {
        bridgePathId: candidate.pathId,
        candidateNodeId: candidate.candidateNodeId,
        candidateNodeType: candidate.candidateNodeType,
        candidateNodeName: candidate.candidateNodeName,
        sourceDomain: candidate.sourceDomain,
        targetDomain: candidate.targetDomain,
        retrievalBackend: bridgeRetrieval.retrievalBackend || null,
        interdisciplinaryPotential,
        noveltyProxy,
        groundingScore,
        challengeCoverageScore,
        storyCompleteness,
        analogyScore,
        graphScore: clampScore(candidate.graphScore),
        retrievalScore: clampScore(candidate.retrievalScore),
        mechanismCoverageScore: clampScore(candidate.mechanismCoverageScore),
        evidenceDensity: clampScore(candidate.evidenceDensity),
        mechanismSupportDensity: clampScore(candidate.mechanismSupportDensity),
        matchedMechanisms: Array.isArray(candidate.matchedMechanisms) ? candidate.matchedMechanisms : [],
        matchedChallenges: Array.isArray(candidate.matchedChallenges) ? candidate.matchedChallenges : [],
        matchedMotifs: Array.isArray(alignment?.matchedMotifs) ? alignment.matchedMotifs : [],
        transferableMechanisms: Array.isArray(alignment?.transferableMechanisms)
          ? alignment.transferableMechanisms
          : (Array.isArray(candidate.matchedMechanisms) ? candidate.matchedMechanisms : []),
        evidenceSnippetCount: Number(candidate.evidenceSnippetCount || 0),
        rationale: alignment?.alignmentRationale || `${candidate.sourceDomain} -> ${candidate.targetDomain} bridge candidate`,
        path: Array.isArray(candidate.path) ? candidate.path : []
      };
    })
    .sort((left, right) => (
      right.interdisciplinaryPotential - left.interdisciplinaryPotential
      || right.groundingScore - left.groundingScore
      || right.challengeCoverageScore - left.challengeCoverageScore
      || left.candidateNodeName.localeCompare(right.candidateNodeName)
    ))
    .slice(0, limit);

  return {
    contractVersion: INTERDISCIPLINARY_POTENTIAL_RANKING_CONTRACT_VERSION,
    targetDomain: bridgeRetrieval.targetDomain || params.targetDomain || '',
    abstractChallenge: bridgeRetrieval.abstractChallenge || params.abstractChallenge || '',
    targetMechanisms: Array.isArray(bridgeRetrieval.targetMechanisms) ? bridgeRetrieval.targetMechanisms : [],
    rankingBackend: 'graph-analogy-fusion-v1',
    rankedCandidates
  };
}
