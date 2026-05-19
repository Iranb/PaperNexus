import { createImportTaskPayload } from '../../server/api.js';
import { normalizePaperIdentifiers } from '../../lib/paper-identifiers.js';

function candidateHasResolvedSource(candidate = {}) {
  const resolutionStatus = candidate.source?.resolutionStatus || candidate.source?.resolution_status || '';
  return resolutionStatus === 'fulltext_ready' && sourcePathOf(candidate);
}

function sourcePathOf(candidate = {}) {
  return candidate.source?.sourcePath || candidate.source?.source_path || '';
}

function sourceProviderOf(candidate = {}) {
  return candidate.source?.sourceProvider || candidate.source?.source_provider || candidate.providers?.[0] || 'literature-discovery';
}

function identifiersOf(candidate = {}) {
  const identifiers = candidate.identifiers && typeof candidate.identifiers === 'object' ? candidate.identifiers : {};
  return normalizePaperIdentifiers({ ...candidate, identifiers });
}

function buildImportBody(candidate = {}) {
  const identifiers = identifiersOf(candidate);
  const sourcePath = sourcePathOf(candidate);
  const sourceProvider = sourceProviderOf(candidate);
  return {
    trigger: 'literature_discovery',
    serverFilePath: sourcePath,
    identifiers,
    doi: identifiers.doi,
    arxivId: identifiers.arxivId,
    pmid: identifiers.pmid,
    pmcid: identifiers.pmcid,
    isbn: identifiers.isbn,
    issn: identifiers.issn,
    sourceProvider,
    paperMetadata: {
      title: candidate.title,
      authors: candidate.authors,
      year: candidate.year,
      identifiers,
      sourceProvider
    }
  };
}

export async function submitDiscoveryImports(params = {}) {
  const candidates = Array.isArray(params.candidates) ? params.candidates : [];
  const corpus = params.corpus;
  const limit = Math.max(1, Math.floor(Number(params.maxImported || params.limit || 20)));
  const results = [];

  for (const candidate of candidates.filter(candidateHasResolvedSource).slice(0, limit)) {
    const candidateId = candidate.id || candidate.candidateId || candidate.candidate_id || null;
    const sourcePath = sourcePathOf(candidate);
    const identifiers = identifiersOf(candidate);
    try {
      const payload = await createImportTaskPayload(corpus, buildImportBody(candidate), params.options || {});
      results.push({
        candidateId,
        canonicalId: candidate.canonicalId || candidate.canonical_id,
        sourcePath,
        title: candidate.title || '',
        identifiers,
        status: payload?.deduped ? 'deduped' : 'submitted',
        taskId: payload?.task?.id || null,
        payload
      });
    } catch (error) {
      results.push({
        candidateId,
        canonicalId: candidate.canonicalId || candidate.canonical_id,
        sourcePath,
        title: candidate.title || '',
        identifiers,
        status: 'failed',
        error: error?.message || 'import-failed'
      });
    }
  }

  return {
    submitted: results.filter((entry) => entry.status === 'submitted').length,
    deduped: results.filter((entry) => entry.status === 'deduped').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results
  };
}
