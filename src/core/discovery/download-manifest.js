import path from 'node:path';
import { stableHash } from '../../lib/utils.js';

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.candidates)) return value.candidates;
  return [];
}

function safePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'paper';
}

function filenameFor(candidate = {}, index = 0) {
  if (candidate.source?.sourcePath) return path.basename(candidate.source.sourcePath);
  const year = candidate.year ? String(candidate.year) : '';
  const title = safePart(candidate.title || candidate.identifiers?.doi || candidate.identifiers?.arxivId || `paper_${index + 1}`);
  const raw = candidate.identifiers?.doi || candidate.identifiers?.arxivId || candidate.canonicalId || `${candidate.title || 'paper'}-${index}`;
  const id = stableHash(raw, 12);
  return [year, title, id].filter(Boolean).join('_') + '.pdf';
}

function inferDownloadSource(candidate = {}) {
  const platforms = Array.isArray(candidate.providers) ? candidate.providers : [];
  if (candidate.identifiers?.arxivId || platforms.includes('arxiv')) return 'arxiv';
  if (candidate.identifiers?.pmcid || platforms.includes('europe_pmc') || platforms.includes('pubmed')) return 'pubmed_central';
  if (platforms.includes('unpaywall')) return 'unpaywall';
  if (platforms.includes('openalex')) return 'openalex';
  if (platforms.includes('semantic_scholar')) return 'semantic_scholar';
  return platforms[0] || candidate.source?.sourceProvider || 'unknown';
}

function skipReason(candidate = {}, fullTextStatus = 'unknown', pdfUrl = '') {
  if (candidate.source?.downloadError) return candidate.source.downloadError;
  if (fullTextStatus !== 'open_pdf') return `full_text_status=${fullTextStatus || 'unknown'}`;
  if (!pdfUrl) return 'missing pdf_url';
  if (!/^https?:\/\//i.test(pdfUrl)) return 'pdf_url must be http(s)';
  return null;
}

function inferDownloadStatus(candidate = {}, fullTextStatus = 'unknown', pdfUrl = '') {
  if (candidate.source?.downloadStatus) return candidate.source.downloadStatus;
  if (candidate.source?.resolutionStatus === 'fulltext_ready') return 'downloaded';
  if (fullTextStatus === 'open_pdf' && pdfUrl) return 'eligible';
  return 'skipped';
}

export function buildDiscoveryDownloadManifest(runOrCandidates = {}) {
  return ensureArray(runOrCandidates).map((candidate, index) => {
    const source = candidate.source || {};
    const identifiers = candidate.identifiers || {};
    const pdfUrl = source.pdfUrl || candidate.pdfUrl || '';
    const fullTextStatus = source.fullTextStatus || (pdfUrl ? 'open_pdf' : 'unknown');
    const downloadStatus = inferDownloadStatus(candidate, fullTextStatus, pdfUrl);
    const downloadedPath = source.localPdfPath || (
      source.resolutionStatus === 'fulltext_ready' ? source.sourcePath || null : null
    );
    const reason = downloadStatus === 'downloaded' ? null : skipReason(candidate, fullTextStatus, pdfUrl);

    return {
      index: index + 1,
      title: candidate.title || '',
      authors: Array.isArray(candidate.authors) ? candidate.authors : [],
      year: candidate.year || null,
      doi: identifiers.doi || null,
      arxiv_id: identifiers.arxivId || null,
      pmid: identifiers.pmid || null,
      pmcid: identifiers.pmcid || null,
      pdf_url: pdfUrl || null,
      landing_page_url: candidate.landingPageUrl || candidate.bestOaUrl || null,
      full_text_status: fullTextStatus,
      source_platforms: Array.isArray(candidate.providers) ? candidate.providers : [],
      download_source: fullTextStatus === 'open_pdf' || downloadStatus === 'downloaded' ? inferDownloadSource(candidate) : null,
      download_status: downloadStatus,
      download_error: reason,
      local_pdf_path: downloadedPath,
      filename: fullTextStatus === 'open_pdf' || downloadStatus === 'downloaded' ? filenameFor(candidate, index) : null,
      institutional_access_hints: source.institutionalAccessHints || []
    };
  });
}

export function countDiscoveryDownloadManifestStatuses(manifest = []) {
  return manifest.reduce((counts, item) => {
    counts.total += 1;
    const status = item.download_status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {
    total: 0,
    eligible: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    not_pdf: 0
  });
}
