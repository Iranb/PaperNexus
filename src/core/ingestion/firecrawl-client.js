import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_FIRECRAWL_API_BASE_URL = 'https://api.firecrawl.dev';
export const DEFAULT_FIRECRAWL_API_KEY_ENV = 'FIRECRAWL_API_KEY';
export const DEFAULT_FIRECRAWL_MODE = 'auto';
export const DEFAULT_FIRECRAWL_SOURCE_MODE = 'auto';

const FIRECRAWL_PARSE_ENDPOINT = '/v2/parse';
const FIRECRAWL_SCRAPE_ENDPOINT = '/v2/scrape';

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

export function normalizeFirecrawlMode(value) {
  const normalized = String(value || DEFAULT_FIRECRAWL_MODE).trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'ocr' || normalized === 'auto') return normalized;
  return DEFAULT_FIRECRAWL_MODE;
}

export function normalizeFirecrawlSourceMode(value) {
  const normalized = String(value || DEFAULT_FIRECRAWL_SOURCE_MODE).trim().toLowerCase();
  if (normalized === 'upload' || normalized === 'url' || normalized === 'auto') return normalized;
  return DEFAULT_FIRECRAWL_SOURCE_MODE;
}

export function normalizeFirecrawlMaxPages(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(1, Math.floor(numeric));
}

function normalizeApiBaseUrl(value) {
  const raw = firstNonEmptyString(value, process.env.PAPERNEXUS_FIRECRAWL_API_BASE_URL, DEFAULT_FIRECRAWL_API_BASE_URL);
  return raw.replace(/\/+$/, '');
}

function buildEndpointUrl(baseUrl, endpoint) {
  const normalizedBaseUrl = normalizeApiBaseUrl(baseUrl);
  if (normalizedBaseUrl.endsWith('/v2') && endpoint.startsWith('/v2/')) {
    return `${normalizedBaseUrl}${endpoint.slice(3)}`;
  }
  return `${normalizedBaseUrl}${endpoint}`;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveFirecrawlApiKey(options = {}) {
  const apiKeyEnv = firstNonEmptyString(
    options.apiKeyEnv,
    options.firecrawlApiKeyEnv,
    process.env.PAPERNEXUS_FIRECRAWL_API_KEY_ENV,
    DEFAULT_FIRECRAWL_API_KEY_ENV
  );
  const apiKey = firstNonEmptyString(
    options.apiKey,
    options.firecrawlApiKey,
    apiKeyEnv ? process.env[apiKeyEnv] : '',
    apiKeyEnv !== DEFAULT_FIRECRAWL_API_KEY_ENV ? process.env[DEFAULT_FIRECRAWL_API_KEY_ENV] : ''
  );
  return { apiKey, apiKeyEnv };
}

function buildPdfParserOptions({ mode, maxPages } = {}) {
  const parser = {
    type: 'pdf',
    mode: normalizeFirecrawlMode(mode)
  };
  const normalizedMaxPages = normalizeFirecrawlMaxPages(maxPages);
  if (normalizedMaxPages) {
    parser.maxPages = normalizedMaxPages;
  }
  return {
    formats: ['markdown'],
    parsers: [parser]
  };
}

function sanitizeText(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    const normalized = String(secret || '');
    if (!normalized) continue;
    text = text.split(normalized).join('[REDACTED]');
  }
  return text;
}

function trimBodySnippet(value, secrets = []) {
  const text = sanitizeText(value, secrets).replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function readPath(payload, pathParts) {
  let current = payload;
  for (const part of pathParts) {
    if (current === undefined || current === null) return '';
    current = current[part];
  }
  return typeof current === 'string' ? current : '';
}

export function extractFirecrawlMarkdown(payload = {}) {
  const paths = [
    ['data', 'markdown'],
    ['data', 'content'],
    ['markdown'],
    ['content'],
    ['document', 'markdown'],
    ['data', 'document', 'markdown'],
    ['documents', 0, 'markdown'],
    ['data', 'documents', 0, 'markdown'],
    ['data', 0, 'markdown']
  ];

  for (const pathParts of paths) {
    const value = readPath(payload, pathParts);
    if (value.trim()) return value.trim();
  }
  return '';
}

function extractFirecrawlMetadata(payload = {}) {
  return payload?.data?.metadata
    || payload?.metadata
    || payload?.data?.document?.metadata
    || payload?.document?.metadata
    || {};
}

async function fetchFirecrawlJson(endpoint, options = {}) {
  const { apiKey, apiKeyEnv } = resolveFirecrawlApiKey(options);
  if (!apiKey) {
    throw new Error(`Firecrawl API key is not configured. Set ${apiKeyEnv || DEFAULT_FIRECRAWL_API_KEY_ENV} or configure firecrawlApiKeyEnv.`);
  }

  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const url = buildEndpointUrl(options.apiBaseUrl || options.firecrawlApiBaseUrl, endpoint);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.headers || {})
      },
      body: options.body,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok || payload?.success === false) {
      const snippet = trimBodySnippet(payload?.error || payload?.message || text || response.statusText, [apiKey]);
      throw new Error(`Firecrawl ${endpoint} failed with HTTP ${response.status}: ${snippet || response.statusText}`);
    }
    return {
      status: response.status,
      payload
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Firecrawl ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw new Error(sanitizeText(error.message || String(error), [apiKey]));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function parseFirecrawlUpload(pdfPath, options = {}) {
  const pdfBuffer = await fs.readFile(pdfPath);
  const mode = normalizeFirecrawlMode(options.mode);
  const maxPages = normalizeFirecrawlMaxPages(options.maxPages);
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), path.basename(pdfPath));
  form.append('options', JSON.stringify(buildPdfParserOptions({ mode, maxPages })));
  const response = await fetchFirecrawlJson(FIRECRAWL_PARSE_ENDPOINT, {
    ...options,
    body: form
  });
  return {
    ...response,
    endpoint: FIRECRAWL_PARSE_ENDPOINT,
    sourceMode: 'upload'
  };
}

async function parseFirecrawlUrl(sourceUrl, options = {}) {
  if (!isHttpUrl(sourceUrl)) {
    throw new Error('Firecrawl URL mode requires an http(s) PDF URL.');
  }
  const mode = normalizeFirecrawlMode(options.mode);
  const maxPages = normalizeFirecrawlMaxPages(options.maxPages);
  const body = JSON.stringify({
    url: sourceUrl,
    ...buildPdfParserOptions({ mode, maxPages })
  });
  const response = await fetchFirecrawlJson(FIRECRAWL_SCRAPE_ENDPOINT, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body
  });
  return {
    ...response,
    endpoint: FIRECRAWL_SCRAPE_ENDPOINT,
    sourceMode: 'url'
  };
}

export async function convertPdfWithFirecrawl(pdfPath, options = {}) {
  const mode = normalizeFirecrawlMode(options.mode || options.firecrawlMode);
  const maxPages = normalizeFirecrawlMaxPages(options.maxPages ?? options.firecrawlMaxPages);
  const sourceMode = normalizeFirecrawlSourceMode(options.sourceMode || options.firecrawlSourceMode);
  const sourceUrl = firstNonEmptyString(options.sourceUrl, options.firecrawlSourceUrl);
  const shouldUseUrl = sourceMode === 'url' || (sourceMode === 'auto' && isHttpUrl(sourceUrl));
  const response = shouldUseUrl
    ? await parseFirecrawlUrl(sourceUrl, { ...options, mode, maxPages })
    : await parseFirecrawlUpload(pdfPath, { ...options, mode, maxPages });
  const markdown = extractFirecrawlMarkdown(response.payload);
  if (!markdown.trim()) {
    throw new Error(`Firecrawl ${response.endpoint} did not return markdown content.`);
  }
  return {
    markdown,
    endpoint: response.endpoint,
    sourceMode: response.sourceMode,
    mode,
    status: response.status,
    metadata: extractFirecrawlMetadata(response.payload),
    parserCommand: `firecrawl:${response.endpoint} mode=${mode} source=${response.sourceMode}`
  };
}
