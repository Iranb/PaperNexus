export const RESEARCH_OBJECT_FIELDS = [
  'problems', 'methods', 'claims', 'findings', 'researchGoals', 'researchQuestions',
  'openChallenges', 'takeaways', 'ideaFragments', 'limitations', 'assumptions',
  'evidences', 'futureDirections', 'benchmarks', 'datasets', 'metrics'
];

export function countResearchObjects(payload = {}) {
  const ordinary = RESEARCH_OBJECT_FIELDS.reduce((total, field) => total + (
    Array.isArray(payload[field]) ? payload[field].filter(entry => (
      entry && typeof entry === 'object' && String(entry.name || entry.text || '').trim()
    )).length : 0
  ), 0);
  const mechanisms = (Array.isArray(payload.abstractMechanismObjects) ? payload.abstractMechanismObjects : [])
    .filter(entry => entry && typeof entry === 'object' && String(entry.name || '').trim()
      && (String(entry.evidenceText || '').trim()
        || (String(entry.description || '').trim()
          && String(entry.description).trim().toLowerCase() !== String(entry.name).trim().toLowerCase())));
  return ordinary + mechanisms.length;
}

export function summarizeSemanticSnapshot(snapshot, { requireRelations = false } = {}) {
  const semantics = snapshot?.llmSemanticObjects || {};
  const llm = snapshot?.llm || {};
  const objectCount = countResearchObjects(semantics);
  const relationCount = Array.isArray(snapshot?.llmRelations) ? snapshot.llmRelations.length : 0;
  const attempted = Boolean(semantics.attempted ?? llm.semanticExtractionAttempted ?? objectCount > 0);
  const participated = objectCount > 0 && (semantics.participated ?? llm.semanticExtractionParticipated) !== false;
  const chunks = llm.chunkPipeline || semantics.chunkPipeline || {};
  const semanticChunkIncomplete = chunks.enabled && Number(chunks.selectedChunkCount || 0) > Number(chunks.processedChunkCount || 0);
  const relationChunkIncomplete = chunks.enabled && Number(chunks.relationChunkCount || 0) > Number(chunks.relationProcessedChunkCount || 0);
  const semanticError = semantics.error || (!participated ? llm.error : null);
  const semanticReason = semantics.reason || llm.semanticExtractionParticipationReason || null;
  const semanticComplete = participated && !semanticError && !semanticReason && !semanticChunkIncomplete;
  const relationSignature = String(llm.relationConfigSignature || '');
  const relationAttempted = relationCount > 0
    || (relationSignature && !relationSignature.includes(':disabled') && !relationSignature.includes('"provider":"disabled"'))
    || llm.longContext?.artifacts?.relation?.status === 'completed';
  const relationComplete = Boolean(relationAttempted && !llm.error && !llm.relationParticipationReason && !relationChunkIncomplete);
  const issues = [];
  if (!snapshot) issues.push('missing-snapshot');
  else if (!attempted) issues.push('semantic-not-attempted');
  else if (!objectCount) issues.push(semanticError || (semanticReason && semanticReason !== 'empty-semantic-result')
    ? 'semantic-failed' : 'empty-semantic-result');
  else if (!semanticComplete) issues.push(semanticChunkIncomplete ? 'semantic-chunks-incomplete' : 'semantic-failed');
  if (requireRelations && !relationComplete) {
    issues.push(relationChunkIncomplete ? 'relation-chunks-incomplete'
      : relationAttempted || llm.relationParticipationReason ? 'relations-failed' : 'relations-not-attempted');
  }
  return {
    sourceKey: snapshot?.sourceKey || null,
    paperId: snapshot?.paperId || null,
    attempted,
    participated,
    semanticObjectCount: objectCount,
    relationCount,
    complete: Boolean(snapshot && semanticComplete && (!requireRelations || relationComplete)),
    artifactState: participated ? (relationCount ? 'objects_and_relations' : 'objects_only')
      : !attempted ? 'not_attempted' : semanticError || semanticReason && semanticReason !== 'empty-semantic-result'
        ? 'attempt_failed' : 'empty_result',
    issues,
    error: semantics.error || llm.error || null
  };
}
