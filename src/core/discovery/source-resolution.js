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
  OPEN_MARKDOWN: 'open_markdown',
  OPEN_PDF: 'open_pdf',
  NEEDS_INSTITUTION: 'needs_institution',
  NO_OPEN_PDF: 'no_open_pdf',
  ANTI_BOT_BLOCKED: 'anti_bot_blocked',
  HTML_NOT_MARKDOWN: 'html_not_markdown',
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

function looksLikeMarkdownUrl(value = '') {
  if (!value) return false;
  try {
    const url = new URL(value);
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith('.md')
      || pathname.endsWith('.markdown')
      || (/^huggingface\.co$/i.test(url.hostname) && /^\/papers\/.+\.md$/i.test(pathname))
      || (/^arxiv2md\.org$/i.test(url.hostname) && (pathname === '/api/markdown' || pathname.startsWith('/abs/')))
      || (/^markxiv\.org$/i.test(url.hostname) && pathname.startsWith('/abs/'));
  } catch {
    const normalized = String(value).toLowerCase();
    return normalized.includes('.md') || normalized.includes('arxiv2md') || normalized.includes('markxiv');
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

function collectMarkdownInputs(candidate = {}, params = {}) {
  if (params.preferMarkdown === false || params.prefer_markdown === false) return [];

  const explicitUrls = [
    candidate.markdownUrl,
    candidate.markdown_url,
    candidate.bestMarkdownUrl,
    candidate.best_markdown_url,
    candidate.source?.markdownUrl,
    ...(candidate.markdownUrls || []),
    ...(candidate.markdown_urls || []),
    ...(candidate.sourceHints || []),
    ...(candidate.fullTextUrls || [])
  ].filter((url) => isHttpUrl(url) && looksLikeMarkdownUrl(url));

  const inputs = explicitUrls.map((url) => ({
    url,
    provider: inferMarkdownProvider(url),
    generated: false
  }));

  const arxivId = normalizeArxivId(candidate.identifiers?.arxivId || candidate.arxivId || candidate.arxiv_id);
  if (arxivId && (params.generateArxivMarkdownSources === true || params.generate_arxiv_markdown_sources === true)) {
    inputs.push(
      {
        url: `https://huggingface.co/papers/${arxivId}.md`,
        provider: 'hf',
        generated: true
      },
      {
        url: `https://arxiv2md.org/api/markdown?url=${encodeURIComponent(arxivId)}&remove_refs=true&remove_toc=true&remove_citations=true`,
        provider: 'arxiv2md-api',
        generated: true
      },
      {
        url: `https://markxiv.org/abs/${arxivId}`,
        provider: 'markxiv',
        generated: true
      },
      {
        url: `https://arxiv2md.org/abs/${arxivId}`,
        provider: 'arxiv2md',
        generated: true
      }
    );
  }

  const seen = new Set();
  return inputs.filter((entry) => {
    const key = entry.url;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferMarkdownProvider(value = '') {
  try {
    const url = new URL(value);
    if (/^huggingface\.co$/i.test(url.hostname) && url.pathname.startsWith('/papers/')) return 'hf';
    if (/^arxiv2md\.org$/i.test(url.hostname) && url.pathname === '/api/markdown') return 'arxiv2md-api';
    if (/^markxiv\.org$/i.test(url.hostname)) return 'markxiv';
    if (/^arxiv2md\.org$/i.test(url.hostname)) return 'arxiv2md';
  } catch {}
  return 'literature-discovery-markdown';
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
        accept: options.accept || 'application/pdf,*/*;q=0.8'
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function formatFetchFailure(error) {
  const message = String(error?.message || error || 'fetch failed').replace(/\s+/g, ' ').trim();
  return `fetch-failed: ${message || 'fetch failed'}`;
}

function validateMarkdownText(text = '') {
  const raw = String(text || '');
  if (raw.length < 200) {
    return { valid: false, reason: 'too-small' };
  }
  const preview = raw.slice(0, 6000).trim().toLowerCase();
  if (!preview) {
    return { valid: false, reason: 'empty' };
  }
  if (ANTI_BOT_MARKERS.some((marker) => preview.includes(marker))) {
    return { valid: false, reason: FULL_TEXT_STATUS.ANTI_BOT_BLOCKED };
  }
  if (HTML_MARKERS.some((marker) => preview.includes(marker))) {
    return { valid: false, reason: FULL_TEXT_STATUS.HTML_NOT_MARKDOWN };
  }
  const htmlTagHits = (preview.match(/<(html|head|body|script|style|div|span|meta|link)\b/g) || []).length;
  if (htmlTagHits >= 3) {
    return { valid: false, reason: FULL_TEXT_STATUS.HTML_NOT_MARKDOWN };
  }
  const markdownSignals = ['\n#', '\n##', '\n###', '\n- ', '\n* ', '\n1. ', 'abstract', 'introduction'];
  if (preview.length < 400 && !markdownSignals.some((signal) => preview.includes(signal))) {
    return { valid: false, reason: 'too-short-for-paper-markdown' };
  }
  return { valid: true, reason: 'markdown-ok' };
}

async function downloadMarkdown(url, outputPath, options = {}) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      ...options,
      accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.2'
    });
  } catch (error) {
    return { ok: false, reason: formatFetchFailure(error) };
  }
  if (!response.ok) {
    const reason = [401, 403, 429, 503].includes(Number(response.status))
      ? FULL_TEXT_STATUS.ANTI_BOT_BLOCKED
      : `http-${response.status}`;
    return { ok: false, reason };
  }
  const text = await response.text();
  const validation = validateMarkdownText(text);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason };
  }
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, text);
  return {
    ok: true,
    reason: validation.reason,
    contentSha256: createContentSha256(Buffer.from(text, 'utf8'))
  };
}

async function downloadPdf(url, outputPath, options = {}) {
  let response;
  try {
    response = await fetchWithTimeout(url, options);
  } catch (error) {
    return { ok: false, reason: formatFetchFailure(error) };
  }
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

function createMarkdownOutputPath(stagingRoot, candidate) {
  const id = candidate.canonicalId || candidate.title || stableHash(JSON.stringify(candidate), 16);
  const safeId = String(id).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return path.join(stagingRoot, `${safeId || stableHash(id, 16)}.md`);
}

export function createDiscoverySupplementationInterface(candidate = {}, source = {}) {
  const identifiers = candidate.identifiers || {};
  const status = source.resolutionStatus === 'fulltext_ready' ? 'complete' : 'needed';
  return {
    status,
    acceptedSourceKinds: ['markdown', 'pdf', 'metadata'],
    preferredSourceKind: 'markdown',
    tool: 'literature_discovery',
    reservedOperation: 'supplement',
    matchFields: {
      runId: '<discovery-run-id>',
      canonicalId: candidate.canonicalId || '',
      candidateId: candidate.id || '',
      identifiers
    },
    acceptedInputs: {
      sourcePath: 'Absolute local .md, .markdown, or .pdf path on the PaperNexus server.',
      markdownUrl: 'HTTP(S) URL returning validated paper Markdown.',
      pdfUrl: 'HTTP(S) URL returning a valid PDF when Markdown is unavailable.',
      paperMetadata: 'Optional title/authors/year/identifier corrections to merge before import.'
    }
  };
}

function classifyFailedResolution(next, markdownInputs, pdfUrls, options = {}) {
  const attempts = next.source.resolutionAttempts || [];
  const failedPdfAttempts = attempts.filter((attempt) => attempt.provider === 'pdf' && attempt.status === 'failed');
  const failedMarkdownAttempts = attempts.filter((attempt) => attempt.sourceKind === 'markdown' && attempt.status === 'failed');
  const firstTerminalReason = failedPdfAttempts.find((attempt) => (
    attempt.detail === FULL_TEXT_STATUS.ANTI_BOT_BLOCKED || attempt.detail === FULL_TEXT_STATUS.HTML_NOT_PDF
  ))?.detail || '';
  const firstMarkdownTerminalReason = failedMarkdownAttempts.find((attempt) => (
    attempt.detail === FULL_TEXT_STATUS.ANTI_BOT_BLOCKED || attempt.detail === FULL_TEXT_STATUS.HTML_NOT_MARKDOWN
  ))?.detail || '';
  const attemptedDownloads = failedPdfAttempts.length > 0;
  const attemptedMarkdownDownloads = failedMarkdownAttempts.length > 0;

  if (markdownInputs.length && (!options.allowDownloads || !attemptedMarkdownDownloads)) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.OPEN_MARKDOWN,
      downloadStatus: DOWNLOAD_STATUS.ELIGIBLE,
      downloadError: null
    };
  }

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
  if (!pdfUrls.length && firstMarkdownTerminalReason === FULL_TEXT_STATUS.HTML_NOT_MARKDOWN) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.HTML_NOT_MARKDOWN,
      downloadStatus: DOWNLOAD_STATUS.FAILED,
      downloadError: 'Markdown route returned HTML instead of paper Markdown.'
    };
  }
  if (!pdfUrls.length && firstMarkdownTerminalReason === FULL_TEXT_STATUS.ANTI_BOT_BLOCKED) {
    return {
      fullTextStatus: FULL_TEXT_STATUS.ANTI_BOT_BLOCKED,
      downloadStatus: DOWNLOAD_STATUS.FAILED,
      downloadError: 'Automated Markdown request was blocked by access control or anti-bot protection.'
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
  const pdfStagingRoot = params.pdfStagingRoot || params.pdf_staging_root || params.stagingRoot || path.join(rootPath, '.papernexus', 'discovery', 'staging', 'pdf');
  const markdownStagingRoot = params.markdownStagingRoot || params.markdown_staging_root || params.mdStagingRoot || params.md_staging_root || path.join(rootPath, '.papernexus', 'discovery', 'staging', 'markdown');
  let downloadReservations = 0;

  function reserveDownloadSlot(sourceUrls = []) {
    if (!allowDownloads || !sourceUrls.length || downloadReservations >= maxDownloads) return false;
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
        localMarkdownPath: null,
        pdfUrl: '',
        markdownUrl: '',
        resolutionAttempts: [],
        institutionalAccessHints: createInstitutionalAccessHints(candidate, params),
        supplementation: null
      }
    };

    const markdownInputs = collectMarkdownInputs(candidate, params);
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

    const hasReservedDownloadSlot = reserveDownloadSlot([...markdownInputs.map((entry) => entry.url), ...pdfUrls]);
    if (hasReservedDownloadSlot) {
      for (const entry of markdownInputs) {
        const outputPath = createMarkdownOutputPath(markdownStagingRoot, next);
        const outcome = await downloadMarkdown(entry.url, outputPath, params);
        next.source.resolutionAttempts.push({
          provider: entry.provider,
          sourceKind: 'markdown',
          status: outcome.ok ? 'success' : 'failed',
          detail: outcome.reason,
          url: entry.url,
          generated: Boolean(entry.generated),
          at: new Date().toISOString()
        });
        if (outcome.ok) {
          const identity = createSourceIdentity({
            ...next,
            identifiers: next.identifiers,
            title: next.title,
            sourceKind: 'markdown',
            sourceProvider: entry.provider,
            contentSha256: outcome.contentSha256,
            resolutionStatus: 'fulltext_ready'
          });
          next.source = {
            ...next.source,
            sourceKind: 'markdown',
            sourcePath: outputPath,
            sourceProvider: identity.sourceProvider,
            contentSha256: identity.contentSha256,
            sourceId: identity.sourceId,
            resolutionStatus: 'fulltext_ready',
            fullTextStatus: FULL_TEXT_STATUS.OPEN_MARKDOWN,
            downloadStatus: DOWNLOAD_STATUS.DOWNLOADED,
            downloadError: null,
            localMarkdownPath: outputPath,
            markdownUrl: entry.url,
            supplementation: createDiscoverySupplementationInterface(next, {
              resolutionStatus: 'fulltext_ready'
            })
          };
          break;
        }
      }
    }

    if (next.source.resolutionStatus !== 'fulltext_ready' && hasReservedDownloadSlot) {
      for (const url of pdfUrls) {
        const outputPath = createOutputPath(pdfStagingRoot, next);
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
            pdfUrl: url,
            supplementation: createDiscoverySupplementationInterface(next, {
              resolutionStatus: 'fulltext_ready'
            })
          };
          break;
        }
      }
    }

    if (next.source.resolutionStatus !== 'fulltext_ready') {
      const classification = classifyFailedResolution(next, markdownInputs, pdfUrls, {
        allowDownloads,
        maxDownloads
      });
      next.source.fullTextStatus = classification.fullTextStatus;
      next.source.downloadStatus = classification.downloadStatus;
      next.source.downloadError = classification.downloadError;
      next.source.pdfUrl = pdfUrls[0] || next.pdfUrl || '';
      next.source.markdownUrl = markdownInputs[0]?.url || next.markdownUrl || '';
      if (next.source.institutionalAccessHints.length) {
        next.source.authorizedAccessStatus = 'institutional_access_may_be_available';
      }
      next.source.supplementation = createDiscoverySupplementationInterface(next, next.source);
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
