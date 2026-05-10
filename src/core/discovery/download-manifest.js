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
  const extension = candidate.source?.sourceKind === 'markdown' ? '.md' : '.pdf';
  return [year, title, id].filter(Boolean).join('_') + extension;
}

function inferDownloadSource(candidate = {}) {
  if (candidate.source?.sourceKind === 'markdown' && candidate.source?.sourceProvider) return candidate.source.sourceProvider;
  const platforms = Array.isArray(candidate.providers) ? candidate.providers : [];
  if (candidate.identifiers?.arxivId || platforms.includes('arxiv')) return 'arxiv';
  if (candidate.identifiers?.pmcid || platforms.includes('europe_pmc') || platforms.includes('pubmed')) return 'pubmed_central';
  if (platforms.includes('unpaywall')) return 'unpaywall';
  if (platforms.includes('openalex')) return 'openalex';
  if (platforms.includes('semantic_scholar')) return 'semantic_scholar';
  return platforms[0] || candidate.source?.sourceProvider || 'unknown';
}

function skipReason(candidate = {}, fullTextStatus = 'unknown', sourceUrl = '') {
  if (candidate.source?.downloadError) return candidate.source.downloadError;
  if (fullTextStatus !== 'open_pdf' && fullTextStatus !== 'open_markdown') return `full_text_status=${fullTextStatus || 'unknown'}`;
  if (!sourceUrl) return 'missing source_url';
  if (!/^https?:\/\//i.test(sourceUrl)) return 'source_url must be http(s)';
  return null;
}

function inferDownloadStatus(candidate = {}, fullTextStatus = 'unknown', pdfUrl = '') {
  if (candidate.source?.downloadStatus) return candidate.source.downloadStatus;
  if (candidate.source?.resolutionStatus === 'fulltext_ready') return 'downloaded';
  if ((fullTextStatus === 'open_pdf' || fullTextStatus === 'open_markdown') && pdfUrl) return 'eligible';
  return 'skipped';
}

export function buildDiscoveryDownloadManifest(runOrCandidates = {}) {
  return ensureArray(runOrCandidates).map((candidate, index) => {
    const source = candidate.source || {};
    const identifiers = candidate.identifiers || {};
    const pdfUrl = source.pdfUrl || candidate.pdfUrl || '';
    const markdownUrl = source.markdownUrl || candidate.markdownUrl || candidate.markdownUrls?.[0] || '';
    const fullTextStatus = source.fullTextStatus || (markdownUrl ? 'open_markdown' : (pdfUrl ? 'open_pdf' : 'unknown'));
    const accessUrl = fullTextStatus === 'open_markdown' ? markdownUrl : pdfUrl;
    const downloadStatus = inferDownloadStatus(candidate, fullTextStatus, accessUrl);
    const localPdfPath = source.localPdfPath || (source.sourceKind === 'pdf' ? source.sourcePath || null : null);
    const localMarkdownPath = source.localMarkdownPath || (source.sourceKind === 'markdown' ? source.sourcePath || null : null);
    const downloadedPath = source.sourcePath || localMarkdownPath || localPdfPath || null;
    const reason = downloadStatus === 'downloaded' ? null : skipReason(candidate, fullTextStatus, accessUrl);

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
      markdown_url: markdownUrl || null,
      landing_page_url: candidate.landingPageUrl || candidate.bestOaUrl || null,
      source_kind: source.sourceKind || 'metadata_only',
      source_path: source.sourcePath || null,
      full_text_status: fullTextStatus,
      source_platforms: Array.isArray(candidate.providers) ? candidate.providers : [],
      download_source: fullTextStatus === 'open_pdf' || fullTextStatus === 'open_markdown' || downloadStatus === 'downloaded' ? inferDownloadSource(candidate) : null,
      download_status: downloadStatus,
      download_error: reason,
      local_pdf_path: localPdfPath,
      local_markdown_path: localMarkdownPath,
      local_source_path: downloadedPath,
      filename: fullTextStatus === 'open_pdf' || fullTextStatus === 'open_markdown' || downloadStatus === 'downloaded' ? filenameFor(candidate, index) : null,
      institutional_access_hints: source.institutionalAccessHints || [],
      supplementation: source.supplementation || null
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
