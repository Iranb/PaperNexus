import { createImportTaskPayload } from '../../server/api.js';

function candidateHasResolvedSource(candidate = {}) {
  return candidate.source?.resolutionStatus === 'fulltext_ready' && candidate.source?.sourcePath;
}

function buildImportBody(candidate = {}) {
  const identifiers = candidate.identifiers || {};
  return {
    trigger: 'literature_discovery',
    serverFilePath: candidate.source.sourcePath,
    identifiers,
    doi: identifiers.doi,
    arxivId: identifiers.arxivId,
    pmid: identifiers.pmid,
    pmcid: identifiers.pmcid,
    isbn: identifiers.isbn,
    issn: identifiers.issn,
    sourceProvider: candidate.source.sourceProvider || candidate.providers?.[0] || 'literature-discovery',
    paperMetadata: {
      title: candidate.title,
      authors: candidate.authors,
      year: candidate.year,
      identifiers,
      sourceProvider: candidate.source.sourceProvider || candidate.providers?.[0] || 'literature-discovery'
    }
  };
}

export async function submitDiscoveryImports(params = {}) {
  const candidates = Array.isArray(params.candidates) ? params.candidates : [];
  const corpus = params.corpus;
  const limit = Math.max(1, Math.floor(Number(params.maxImported || params.limit || 20)));
  const results = [];

  for (const candidate of candidates.filter(candidateHasResolvedSource).slice(0, limit)) {
    try {
      const payload = await createImportTaskPayload(corpus, buildImportBody(candidate), params.options || {});
      results.push({
        canonicalId: candidate.canonicalId,
        sourcePath: candidate.source.sourcePath,
        status: payload?.deduped ? 'deduped' : 'submitted',
        taskId: payload?.task?.id || null,
        payload
      });
    } catch (error) {
      results.push({
        canonicalId: candidate.canonicalId,
        sourcePath: candidate.source.sourcePath,
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

