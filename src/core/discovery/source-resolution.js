import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../../lib/fs.js';
import {
  createContentSha256,
  createSourceIdentity,
  normalizeArxivId,
  normalizeDoi,
  normalizePmcid
} from '../../lib/paper-identifiers.js';
import { stableHash, unique } from '../../lib/utils.js';

const HTML_MARKERS = ['<!doctype html', '<html', '<head', '<body', '<script', '<title'];
const ANTI_BOT_MARKERS = [
  'access denied',
  'forbidden',
  'too many requests',
  'cloudflare',
  'captcha',
  'please enable javascript',
  'service unavailable'
];
const FULL_TEXT_STATUS = Object.freeze({
  OPEN_PDF: 'open_pdf',
  NEEDS_INSTITUTION: 'needs_institution',
  NO_OPEN_PDF: 'no_open_pdf',
  ANTI_BOT_BLOCKED: 'anti_bot_blocked',
  HTML_NOT_PDF: 'html_not_pdf',
  UNKNOWN: 'unknown'
});
const DOWNLOAD_STATUS = Object.freeze({
  ELIGIBLE: 'eligible',
  DOWNLOADED: 'downloaded',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  NOT_PDF: 'not_pdf'
});

export const DISCOVERY_FULL_TEXT_STATUSES = Object.freeze(Object.values(FULL_TEXT_STATUS));
export const MAX_DISCOVERY_DOWNLOAD_THREADS = 4;

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function resolveDownloadConcurrency(params = {}) {
  return Math.min(
    MAX_DISCOVERY_DOWNLOAD_THREADS,
    toPositiveInteger(
      params.downloadConcurrency
      || params.download_concurrency
      || params.maxDownloadThreads
      || params.max_download_threads,
      MAX_DISCOVERY_DOWNLOAD_THREADS
    )
  );
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  if (!Array.isArray(items) || !items.length) return [];

  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency || 1)), items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function isHttpUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikePdfUrl(value = '') {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.pathname.toLowerCase().endsWith('.pdf') || (
      /(^|\.)arxiv\.org$/i.test(url.hostname) && url.pathname.startsWith('/pdf/')
    ) || (
      /(^|\.)pmc\.ncbi\.nlm\.nih\.gov$/i.test(url.hostname) && /\/pdf\/?$/i.test(url.pathname)
    ) || (
      /(^|\.)core\.ac\.uk$/i.test(url.hostname) && /\/download\/?$/i.test(url.pathname)
    );
  } catch {
    return String(value).toLowerCase().includes('.pdf');
  }
}

function arxivPdfUrl(value = '') {
  const arxivId = normalizeArxivId(value);
  return arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '';
}

function pmcidPdfUrl(value = '') {
  const pmcid = normalizePmcid(value);
  return pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/` : '';
}

function collectDownloadUrls(candidate = {}) {
  const urls = [
    candidate.pdfUrl,
    ...(candidate.sourceHints || []),
    ...(candidate.fullTextUrls || []),
    arxivPdfUrl(candidate.identifiers?.arxivId),
    pmcidPdfUrl(candidate.identifiers?.pmcid)
  ];
  return unique(urls.filter((url) => isHttpUrl(url) && looksLikePdfUrl(url)));
}

function validatePdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 512) {
    return { valid: false, reason: 'too-small' };
  }
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { valid: true, reason: 'pdf-header-ok' };
  }
  const preview = buffer.subarray(0, 4096).toString('utf8').toLowerCase();
  if (ANTI_BOT_MARKERS.some((marker) => preview.includes(marker))) {
    return { valid: false, reason: FULL_TEXT_STATUS.ANTI_BOT_BLOCKED };
  }
  if (HTML_MARKERS.some((marker) => preview.includes(marker))) {
    return { valid: false, reason: FULL_TEXT_STATUS.HTML_NOT_PDF };
  }
  return { valid: false, reason: 'missing-pdf-header' };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': options.userAgent || 'PaperNexus/0.1 literature-discovery',
        accept: 'application/pdf,*/*;q=0.8'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadPdf(url, outputPath, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const reason = [401, 403, 429, 503].includes(Number(response.status))
      ? FULL_TEXT_STATUS.ANTI_BOT_BLOCKED
      : `http-${response.status}`;
    return { ok: false, reason };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const validation = validatePdfBuffer(buffer);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason };
  }
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, buffer);
  return {
    ok: true,
    reason: validation.reason,
    contentSha256: createContentSha256(buffer)
  };
}

async function resolveUnpaywall(candidate = {}, options = {}) {
  const doi = normalizeDoi(candidate.identifiers?.doi);
  const email = String(options.unpaywallEmail || options.mailto || process.env.UNPAYWALL_EMAIL || process.env.PAPERNEXUS_DISCOVERY_MAILTO || '').trim();
  if (!doi) return { ok: false, reason: 'missing-doi' };
  if (!email) return { ok: false, reason: 'missing-email' };

  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
  url.searchParams.set('email', email);
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) return { ok: false, reason: `http-${response.status}` };
  const payload = await response.json();
  const location = payload.best_oa_location || {};
  const pdfUrl = location.url_for_pdf || '';
  return {
    ok: Boolean(pdfUrl),
    reason: pdfUrl ? 'open_pdf' : (payload.is_oa ? 'oa_without_pdf' : 'closed'),
    isOpenAccess: Boolean(payload.is_oa),
    openAccessStatus: payload.oa_status || '',
    license: location.license || '',
    pdfUrl,
    bestOaUrl: location.url || ''
  };
}

function createInstitutionalAccessHints(candidate = {}, options = {}) {
  const doi = normalizeDoi(candidate.identifiers?.doi);
  const hints = [];
  if (doi) {
    hints.push({ kind: 'doi', url: `https://doi.org/${doi}` });
  }
  if (candidate.landingPageUrl) {
    hints.push({ kind: 'publisher', url: candidate.landingPageUrl });
  }
  const resolverBaseUrl = String(options.institutionalResolverBaseUrl || process.env.PAPERNEXUS_INSTITUTIONAL_RESOLVER_URL || '').trim();
  if (resolverBaseUrl && doi) {
    try {
      const resolver = new URL(resolverBaseUrl);
      resolver.searchParams.set('doi', doi);
      hints.push({ kind: 'institutional_resolver', url: resolver.toString() });
    } catch {}
  }
  return hints;
}

function createOutputPath(stagingRoot, candidate) {
  const id = candidate.canonicalId || candidate.title || stableHash(JSON.stringify(candidate), 16);
  const safeId = String(id).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return path.join(stagingRoot, `${safeId || stableHash(id, 16)}.pdf`);
}

function classifyFailedResolution(next, pdfUrls, options = {}) {
  const attempts = next.source.resolutionAttempts || [];
  const failedPdfAttempts = attempts.filter((attempt) => attempt.provider === 'pdf' && attempt.status === 'failed');
  const firstTerminalReason = failedPdfAttempts.find((attempt) => (
    attempt.detail === FULL_TEXT_STATUS.ANTI_BOT_BLOCKED || attempt.detail === FULL_TEXT_STATUS.HTML_NOT_PDF
  ))?.detail || '';
  const attemptedDownloads = failedPdfAttempts.length > 0;

  if (firstTerminalReason === FULL_TEXT_STATUS.HTML_NOT_PDF) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.HTML_NOT_PDF,
      downloadStatus: DOWNLOAD_STATUS.NOT_PDF,
      downloadError: 'PDF route returned HTML instead of a PDF binary.'
    };
  }
  if (firstTerminalReason === FULL_TEXT_STATUS.ANTI_BOT_BLOCKED) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.ANTI_BOT_BLOCKED,
      downloadStatus: DOWNLOAD_STATUS.FAILED,
      downloadError: 'Automated PDF request was blocked by access control or anti-bot protection.'
    };
  }
  if (pdfUrls.length && (!options.allowDownloads || !attemptedDownloads)) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.OPEN_PDF,
      downloadStatus: DOWNLOAD_STATUS.ELIGIBLE,
      downloadError: null
    };
  }
  if (pdfUrls.length && attemptedDownloads) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.UNKNOWN,
      downloadStatus: DOWNLOAD_STATUS.FAILED,
      downloadError: failedPdfAttempts.map((attempt) => attempt.detail).filter(Boolean).join('; ') || 'PDF download failed.'
    };
  }

  const unpaywallAttempt = attempts.find((attempt) => attempt.provider === 'unpaywall');
  if (unpaywallAttempt?.detail === 'closed' || unpaywallAttempt?.detail === 'oa_without_pdf') {
    if (next.source.institutionalAccessHints?.length && (next.identifiers?.doi || next.landingPageUrl)) {
      return {
        fullTextStatus: FULL_TEXT_STATUS.NEEDS_INSTITUTION,
        downloadStatus: DOWNLOAD_STATUS.SKIPPED,
        downloadError: 'No open PDF found; institutional access may be available through the DOI or publisher page.'
      };
    }
    return {
      fullTextStatus: FULL_TEXT_STATUS.NO_OPEN_PDF,
      downloadStatus: DOWNLOAD_STATUS.SKIPPED,
      downloadError: 'No openly downloadable PDF was found.'
    };
  }
  if (next.source.institutionalAccessHints?.length && (next.identifiers?.doi || next.landingPageUrl)) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.NEEDS_INSTITUTION,
      downloadStatus: DOWNLOAD_STATUS.SKIPPED,
      downloadError: 'No open PDF found; institutional access may still be available through the DOI or publisher page.'
    };
  }
  return {
    fullTextStatus: FULL_TEXT_STATUS.UNKNOWN,
    downloadStatus: DOWNLOAD_STATUS.SKIPPED,
    downloadError: 'No reliable full-text access signal was found.'
  };
}

export async function resolveDiscoverySources(params = {}) {
  const rootPath = params.rootPath;
  if (!rootPath) throw new Error('rootPath is required to resolve discovery sources.');
  const candidates = Array.isArray(params.candidates) ? params.candidates : [];
  const maxDownloads = Math.max(0, Math.floor(Number(params.maxDownloads ?? params.maxResolutionAttempts ?? 12)));
  const allowDownloads = params.allowDownloads !== false;
  const downloadConcurrency = resolveDownloadConcurrency(params);
  const stagingRoot = params.stagingRoot || path.join(rootPath, '.papernexus', 'discovery', 'staging', 'pdf');
  let downloadReservations = 0;

  function reserveDownloadSlot(pdfUrls = []) {
    if (!allowDownloads || !pdfUrls.length || downloadReservations >= maxDownloads) return false;
    downloadReservations += 1;
    return true;
  }

  const resolved = await mapWithConcurrency(candidates, downloadConcurrency, async (candidate) => {
    const next = {
      ...candidate,
      source: {
        sourceKind: 'metadata_only',
        sourcePath: '',
        sourceProvider: '',
        contentSha256: '',
        sourceId: '',
        resolutionStatus: 'metadata_only',
        fullTextStatus: FULL_TEXT_STATUS.UNKNOWN,
        downloadStatus: DOWNLOAD_STATUS.SKIPPED,
        downloadError: null,
        localPdfPath: null,
        pdfUrl: '',
        resolutionAttempts: [],
        institutionalAccessHints: createInstitutionalAccessHints(candidate, params)
      }
    };

    let pdfUrls = collectDownloadUrls(next);
    if (!pdfUrls.length && next.identifiers?.doi) {
      const unpaywall = await resolveUnpaywall(next, params);
      next.source.resolutionAttempts.push({
        provider: 'unpaywall',
        status: unpaywall.ok ? 'candidate' : 'checked',
        detail: unpaywall.reason,
        url: unpaywall.pdfUrl || unpaywall.bestOaUrl || '',
        at: new Date().toISOString()
      });
      if (unpaywall.openAccessStatus && !next.openAccessStatus) next.openAccessStatus = unpaywall.openAccessStatus;
      if (unpaywall.license && !next.license) next.license = unpaywall.license;
      if (unpaywall.pdfUrl && !next.pdfUrl) next.pdfUrl = unpaywall.pdfUrl;
      if (unpaywall.bestOaUrl && !next.bestOaUrl) next.bestOaUrl = unpaywall.bestOaUrl;
      pdfUrls = collectDownloadUrls(next);
    }

    if (reserveDownloadSlot(pdfUrls)) {
      for (const url of pdfUrls) {
        const outputPath = createOutputPath(stagingRoot, next);
        const outcome = await downloadPdf(url, outputPath, params);
        next.source.resolutionAttempts.push({
          provider: 'pdf',
          status: outcome.ok ? 'success' : 'failed',
          detail: outcome.reason,
          url,
          at: new Date().toISOString()
        });
        if (outcome.ok) {
          const identity = createSourceIdentity({
            ...next,
            identifiers: next.identifiers,
            title: next.title,
            sourceKind: 'pdf',
            sourceProvider: next.providers?.[0] || 'literature-discovery',
            contentSha256: outcome.contentSha256,
            resolutionStatus: 'fulltext_ready'
          });
          next.source = {
            ...next.source,
            sourceKind: 'pdf',
            sourcePath: outputPath,
            sourceProvider: identity.sourceProvider,
            contentSha256: identity.contentSha256,
            sourceId: identity.sourceId,
            resolutionStatus: 'fulltext_ready',
            fullTextStatus: FULL_TEXT_STATUS.OPEN_PDF,
            downloadStatus: DOWNLOAD_STATUS.DOWNLOADED,
            downloadError: null,
            localPdfPath: outputPath,
            pdfUrl: url
          };
          break;
        }
      }
    }

    if (next.source.resolutionStatus !== 'fulltext_ready') {
      const classification = classifyFailedResolution(next, pdfUrls, {
        allowDownloads,
        maxDownloads
      });
      next.source.fullTextStatus = classification.fullTextStatus;
      next.source.downloadStatus = classification.downloadStatus;
      next.source.downloadError = classification.downloadError;
      next.source.pdfUrl = pdfUrls[0] || next.pdfUrl || '';
      if (next.source.institutionalAccessHints.length) {
        next.source.authorizedAccessStatus = 'institutional_access_may_be_available';
      }
    }

    return next;
  });

  const downloadedCount = resolved.filter((entry) => entry.source?.resolutionStatus === 'fulltext_ready').length;

  return {
    candidates: resolved,
    summary: {
      total: resolved.length,
      resolvedFullText: resolved.filter((entry) => entry.source?.resolutionStatus === 'fulltext_ready').length,
      metadataOnly: resolved.filter((entry) => entry.source?.resolutionStatus !== 'fulltext_ready').length,
      downloaded: downloadedCount
    }
  };
}
