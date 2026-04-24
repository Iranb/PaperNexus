import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import {
  hasStrongPaperIdentifiers,
  normalizeArxivId,
  normalizeExactPaperTitle,
  normalizePaperIdentifiers
} from '../../lib/paper-identifiers.js';
import {
  jaccardSimilarity,
  normalizeText,
  stableHash,
  tokenizeWithoutStopwords,
  unique
} from '../../lib/utils.js';
import { getCorpusPaths } from '../../storage/corpus-store.js';

const OPENALEX_WORKS_URL = 'https://api.openalex.org/works';
const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const ARXIV_QUERY_URL = 'https://export.arxiv.org/api/query';
const KNOWN_PROVIDERS = new Set(['openalex', 'crossref', 'arxiv']);
const DEFAULT_PROVIDERS = ['openalex', 'crossref', 'arxiv'];
const MISS_CACHE_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_MISS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const missCacheStateByRoot = new Map();
const missCacheLoadedByRoot = new Set();
const missCacheWriteChainsByRoot = new Map();

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeProviders(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const providers = rawValues
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => KNOWN_PROVIDERS.has(entry));
  return providers.length ? unique(providers) : [...DEFAULT_PROVIDERS];
}

export function resolveIdentifierResolutionConfig(options = {}) {
  const nested = asPlainObject(options.identifierResolution);
  return {
    enabled: toBoolean(
      nested.enabled ?? options.identifierResolutionEnabled,
      true
    ),
    providers: normalizeProviders(nested.providers ?? options.identifierResolutionProviders),
    timeoutMs: toPositiveInteger(
      nested.timeoutMs ?? options.identifierResolutionTimeoutMs,
      DEFAULT_TIMEOUT_MS
    ),
    maxCandidates: toPositiveInteger(
      nested.maxCandidates ?? options.identifierResolutionMaxCandidates,
      DEFAULT_MAX_CANDIDATES
    ),
    missCacheTtlMs: toPositiveInteger(
      nested.missCacheTtlMs ?? options.identifierResolutionMissCacheTtlMs,
      DEFAULT_MISS_CACHE_TTL_MS
    ),
    mailto: String(
      nested.mailto
      ?? options.identifierResolutionMailto
      ?? process.env.PAPERNEXUS_IDENTIFIER_RESOLUTION_MAILTO
      ?? ''
    ).trim(),
    allowInWatch: toBoolean(
      nested.allowInWatch ?? options.identifierResolutionAllowInWatch,
      false
    ),
    watchMode: Boolean(options.watchMode)
  };
}

function getMissCachePath(rootPath) {
  return getCorpusPaths(rootPath).identifierResolutionCachePath;
}

function normalizeMissCache(rawCache = {}) {
  const normalizedCache = asPlainObject(rawCache);
  const sourceMisses = Number(normalizedCache.version || 0) === MISS_CACHE_VERSION
    ? asPlainObject(normalizedCache.misses)
    : {};
  const now = Date.now();
  const misses = {};
  for (const [key, value] of Object.entries(sourceMisses)) {
    const expiresAt = Number(value?.expiresAt || 0);
    if (expiresAt && expiresAt <= now) continue;
    misses[key] = {
      reason: String(value?.reason || 'no-match').trim() || 'no-match',
      cachedAt: Number(value?.cachedAt || now),
      expiresAt
    };
  }
  return {
    version: MISS_CACHE_VERSION,
    misses
  };
}

async function loadMissCache(rootPath) {
  if (missCacheLoadedByRoot.has(rootPath)) {
    return missCacheStateByRoot.get(rootPath);
  }

  const cache = normalizeMissCache(await readJson(getMissCachePath(rootPath), null));
  missCacheStateByRoot.set(rootPath, cache);
  missCacheLoadedByRoot.add(rootPath);
  return cache;
}

async function persistMissCache(rootPath) {
  const cache = normalizeMissCache(missCacheStateByRoot.get(rootPath) || {});
  missCacheStateByRoot.set(rootPath, cache);
  const cachePath = getMissCachePath(rootPath);
  await ensureDir(getCorpusPaths(rootPath).corpusDir);
  await writeJson(cachePath, cache);
}

async function withMissCacheWrite(rootPath, handler) {
  const previous = missCacheWriteChainsByRoot.get(rootPath) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const cache = await loadMissCache(rootPath);
    const result = await handler(cache);
    await persistMissCache(rootPath);
    return result;
  });
  missCacheWriteChainsByRoot.set(rootPath, next.then(() => undefined, () => undefined));
  return next;
}

function createMissCacheKey(paper = {}, sourceState = {}) {
  const fingerprint = String(sourceState?.fingerprint || paper?.sourceFingerprint || '').trim();
  if (fingerprint) return `fingerprint:${fingerprint}`;
  const title = normalizeExactPaperTitle(paper?.paperTitle || paper?.title || '');
  const authors = unique((Array.isArray(paper?.authors) ? paper.authors : []).map((entry) => normalizeText(entry))).sort();
  return `query:${stableHash(JSON.stringify({ title, authors }), 20)}`;
}

function normalizeAuthorName(value = '') {
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function extractPaperAuthors(paper = {}) {
  return new Set((Array.isArray(paper?.authors) ? paper.authors : []).map(normalizeAuthorName).filter(Boolean));
}

function compactWhitespace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createRequestHeaders(config = {}, accept = 'application/json') {
  return {
    accept,
    'user-agent': config.mailto
      ? `PaperNexus/0.1 (+${config.mailto})`
      : 'PaperNexus/0.1'
  };
}

async function fetchProviderResponse(url, config = {}, accept = 'application/json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: createRequestHeaders(config, accept),
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `http-${response.status}`
      };
    }

    return {
      ok: true,
      reason: '',
      response
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'request-failed'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractWorkAuthors(work = {}) {
  return new Set(
    (Array.isArray(work.authorships) ? work.authorships : [])
      .map((entry) => entry?.author?.display_name || entry?.raw_author_name || '')
      .map(normalizeAuthorName)
      .filter(Boolean)
  );
}

function extractArxivIdFromOpenAlexWork(work = {}) {
  const candidates = unique([
    work?.primary_location?.id,
    work?.primary_location?.landing_page_url,
    work?.primary_location?.pdf_url,
    ...(Array.isArray(work?.locations)
      ? work.locations.flatMap((entry) => [entry?.id, entry?.landing_page_url, entry?.pdf_url])
      : [])
  ].filter(Boolean));

  for (const candidate of candidates) {
    const normalized = normalizeArxivId(candidate);
    if (normalized) return normalized;
    const oaiMatch = String(candidate || '').match(/arxiv\.org:(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (oaiMatch) {
      const fromOai = normalizeArxivId(oaiMatch[1]);
      if (fromOai) return fromOai;
    }
  }

  return '';
}

function extractIdentifiersFromOpenAlexWork(work = {}) {
  return normalizePaperIdentifiers({
    doi: work?.doi || work?.ids?.doi || '',
    arxivId: extractArxivIdFromOpenAlexWork(work),
    pmid: work?.ids?.pmid || '',
    pmcid: work?.ids?.pmcid || ''
  });
}

function extractCrossrefAuthors(item = {}) {
  return (Array.isArray(item?.author) ? item.author : [])
    .map((entry) => compactWhitespace(entry?.name || [entry?.given, entry?.family].filter(Boolean).join(' ')))
    .filter(Boolean);
}

function extractIdentifiersFromCrossrefWork(item = {}) {
  return normalizePaperIdentifiers({
    doi: item?.DOI || item?.doi || ''
  });
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function stripXmlTags(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function normalizeXmlText(value = '') {
  return compactWhitespace(decodeXmlEntities(stripXmlTags(value)));
}

function stripArxivVersion(value = '') {
  return String(value || '').trim().toLowerCase().replace(/v\d+$/i, '');
}

function escapeTagName(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractXmlFirstValue(xml = '', tagName = '') {
  if (!tagName) return '';
  const match = String(xml || '').match(new RegExp(`<${escapeTagName(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeTagName(tagName)}>`, 'i'));
  return match ? match[1] : '';
}

function extractXmlBlocks(xml = '', tagName = '') {
  if (!tagName) return [];
  return Array.from(
    String(xml || '').matchAll(new RegExp(`<${escapeTagName(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeTagName(tagName)}>`, 'gi')),
    (match) => match[1]
  );
}

function extractIdentifiersFromArxivEntry(entryXml = '') {
  const rawArxivId = normalizeArxivId(normalizeXmlText(extractXmlFirstValue(entryXml, 'id')));
  return normalizePaperIdentifiers({
    arxivId: stripArxivVersion(rawArxivId),
    doi: normalizeXmlText(extractXmlFirstValue(entryXml, 'arxiv:doi')) || normalizeXmlText(extractXmlFirstValue(entryXml, 'doi'))
  });
}

function parseArxivFeed(xml = '') {
  const source = String(xml || '');
  if (!/<feed\b/i.test(source)) {
    return null;
  }

  return extractXmlBlocks(source, 'entry').map((entryXml) => ({
    provider: 'arxiv',
    title: normalizeXmlText(extractXmlFirstValue(entryXml, 'title')),
    authors: extractXmlBlocks(entryXml, 'author')
      .map((authorXml) => normalizeXmlText(extractXmlFirstValue(authorXml, 'name')))
      .filter(Boolean),
    identifiers: extractIdentifiersFromArxivEntry(entryXml)
  }));
}

function computeAuthorOverlapRatio(queryAuthors = new Set(), candidateAuthors = new Set()) {
  if (!queryAuthors.size || !candidateAuthors.size) return 0;
  let matches = 0;
  for (const author of queryAuthors) {
    if (candidateAuthors.has(author)) matches += 1;
  }
  return matches / queryAuthors.size;
}

function evaluateResolvedCandidate(paper = {}, candidate = {}) {
  const sourceTitle = normalizeExactPaperTitle(paper?.paperTitle || paper?.title || '');
  const candidateTitle = normalizeExactPaperTitle(candidate?.title || '');
  const exactTitle = Boolean(sourceTitle && candidateTitle && sourceTitle === candidateTitle);
  const titleSimilarity = exactTitle ? 1 : jaccardSimilarity(sourceTitle, candidateTitle);
  const queryAuthors = extractPaperAuthors(paper);
  const candidateAuthors = new Set((Array.isArray(candidate?.authors) ? candidate.authors : []).map(normalizeAuthorName).filter(Boolean));
  const authorOverlap = computeAuthorOverlapRatio(queryAuthors, candidateAuthors);
  const identifiers = normalizePaperIdentifiers(candidate?.identifiers || {});
  const hasStrongIdentifiers = hasStrongPaperIdentifiers(identifiers);

  const accepted = hasStrongIdentifiers && (
    (exactTitle && (!queryAuthors.size || authorOverlap > 0))
    || (titleSimilarity >= 0.92 && authorOverlap >= 0.34)
    || (titleSimilarity >= 0.98 && !queryAuthors.size)
  );

  return {
    accepted,
    score: (exactTitle ? 1 : titleSimilarity) + authorOverlap + (identifiers.doi ? 0.25 : 0) + (identifiers.arxivId ? 0.2 : 0),
    titleSimilarity,
    authorOverlap,
    identifiers,
    matchedTitle: candidate?.title || '',
    provider: String(candidate?.provider || '').trim()
  };
}

function createOpenAlexUrl(paper = {}, config = {}) {
  const title = String(paper?.titleValidation?.rawTitle || paper?.paperTitle || paper?.title || '').trim();
  const url = new URL(OPENALEX_WORKS_URL);
  url.searchParams.set('search', title);
  url.searchParams.set('per-page', String(config.maxCandidates || DEFAULT_MAX_CANDIDATES));
  url.searchParams.set('select', 'id,doi,title,display_name,publication_year,authorships,ids,primary_location,locations');
  if (config.mailto) {
    url.searchParams.set('mailto', config.mailto);
  }
  return url;
}

async function fetchOpenAlexCandidates(paper = {}, config = {}) {
  const response = await fetchProviderResponse(createOpenAlexUrl(paper, config), config);
  if (!response.ok) {
    return {
      ok: false,
      reason: response.reason || 'request-failed',
      candidates: []
    };
  }

  try {
    const payload = await response.response.json();
    if (!Array.isArray(payload?.results)) {
      return {
        ok: false,
        reason: 'malformed-response',
        candidates: []
      };
    }

    return {
      ok: true,
      reason: '',
      candidates: payload.results.map((work) => ({
        provider: 'openalex',
        title: work?.title || work?.display_name || '',
        authors: Array.from(extractWorkAuthors(work)),
        identifiers: extractIdentifiersFromOpenAlexWork(work)
      }))
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-response',
      candidates: []
    };
  }
}

function createCrossrefUrl(paper = {}, config = {}) {
  const title = String(paper?.titleValidation?.rawTitle || paper?.paperTitle || paper?.title || '').trim();
  const url = new URL(CROSSREF_WORKS_URL);
  url.searchParams.set('query.title', title);
  url.searchParams.set('rows', String(config.maxCandidates || DEFAULT_MAX_CANDIDATES));
  if (config.mailto) {
    url.searchParams.set('mailto', config.mailto);
  }
  return url;
}

async function fetchCrossrefCandidates(paper = {}, config = {}) {
  const response = await fetchProviderResponse(createCrossrefUrl(paper, config), config);
  if (!response.ok) {
    return {
      ok: false,
      reason: response.reason || 'request-failed',
      candidates: []
    };
  }

  try {
    const payload = await response.response.json();
    if (!Array.isArray(payload?.message?.items)) {
      return {
        ok: false,
        reason: 'malformed-response',
        candidates: []
      };
    }

    return {
      ok: true,
      reason: '',
      candidates: payload.message.items.map((item) => ({
        provider: 'crossref',
        title: Array.isArray(item?.title) ? String(item.title[0] || '') : String(item?.title || ''),
        authors: extractCrossrefAuthors(item),
        identifiers: extractIdentifiersFromCrossrefWork(item)
      }))
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-response',
      candidates: []
    };
  }
}

function createArxivQuery(paper = {}) {
  const title = String(paper?.titleValidation?.rawTitle || paper?.paperTitle || paper?.title || '').trim();
  const titleTokens = unique(tokenizeWithoutStopwords(title)).slice(0, 8);
  if (!titleTokens.length) return '';
  return titleTokens.map((token) => `ti:${token}`).join(' AND ');
}

function createArxivUrl(paper = {}, config = {}) {
  const query = createArxivQuery(paper);
  if (!query) return null;
  const url = new URL(ARXIV_QUERY_URL);
  url.searchParams.set('search_query', query);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(config.maxCandidates || DEFAULT_MAX_CANDIDATES));
  return url;
}

async function fetchArxivCandidates(paper = {}, config = {}) {
  const url = createArxivUrl(paper, config);
  if (!url) {
    return {
      ok: false,
      reason: 'invalid-query',
      candidates: []
    };
  }

  const response = await fetchProviderResponse(
    url,
    config,
    'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'
  );
  if (!response.ok) {
    return {
      ok: false,
      reason: response.reason || 'request-failed',
      candidates: []
    };
  }

  try {
    const payload = await response.response.text();
    const candidates = parseArxivFeed(payload);
    if (!Array.isArray(candidates)) {
      return {
        ok: false,
        reason: 'malformed-response',
        candidates: []
      };
    }

    return {
      ok: true,
      reason: '',
      candidates
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-response',
      candidates: []
    };
  }
}

const PROVIDER_FETCHERS = {
  openalex: fetchOpenAlexCandidates,
  crossref: fetchCrossrefCandidates,
  arxiv: fetchArxivCandidates
};

export function shouldAttemptIdentifierResolution(paper = {}, sourceState = {}, options = {}) {
  const config = resolveIdentifierResolutionConfig(options);
  if (!config.enabled) return false;
  if (config.watchMode && !config.allowInWatch) return false;
  if (hasStrongPaperIdentifiers({
    identifiers: paper?.identifiers || {},
    paperMetadata: sourceState?.paperMetadata || {}
  })) {
    return false;
  }

  const titleValidation = paper?.titleValidation;
  if (!titleValidation || titleValidation.isValid === false || titleValidation.usedFallbackTitle) {
    return false;
  }

  const title = String(paper?.paperTitle || paper?.title || '').trim();
  return tokenizeWithoutStopwords(title).length >= 2;
}

async function hasRecentResolutionMiss(rootPath, cacheKey) {
  const cache = await loadMissCache(rootPath);
  const entry = cache?.misses?.[cacheKey];
  if (!entry) return false;
  if (Number(entry.expiresAt || 0) <= Date.now()) {
    delete cache.misses[cacheKey];
    return false;
  }
  return true;
}

async function recordResolutionMiss(rootPath, cacheKey, config = {}, reason = 'no-match') {
  return withMissCacheWrite(rootPath, async (cache) => {
    cache.misses[cacheKey] = {
      reason,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (config.missCacheTtlMs || DEFAULT_MISS_CACHE_TTL_MS)
    };
  });
}

export async function resolvePaperIdentifiersExternally(rootPath, paper = {}, sourceState = {}, options = {}) {
  const config = resolveIdentifierResolutionConfig(options);
  if (!shouldAttemptIdentifierResolution(paper, sourceState, {
    ...options,
    identifierResolution: config
  })) {
    return {
      identifiers: {},
      provider: '',
      reason: 'skipped'
    };
  }

  if (!config.providers.length) {
    return {
      identifiers: {},
      provider: '',
      reason: 'provider-disabled'
    };
  }

  const cacheKey = createMissCacheKey(paper, sourceState);
  if (await hasRecentResolutionMiss(rootPath, cacheKey)) {
    return {
      identifiers: {},
      provider: '',
      reason: 'miss-cached'
    };
  }

  let firstFailure = null;
  let definitiveNoMatch = true;

  for (const provider of config.providers) {
    const fetchCandidates = PROVIDER_FETCHERS[provider];
    if (!fetchCandidates) continue;

    const response = await fetchCandidates(paper, config);
    if (!response.ok) {
      definitiveNoMatch = false;
      if (!firstFailure) {
        firstFailure = {
          provider,
          reason: response.reason || 'request-failed'
        };
      }
      continue;
    }

    const matches = response.candidates
      .map((candidate) => evaluateResolvedCandidate(paper, candidate))
      .filter((candidate) => candidate.accepted)
      .sort((left, right) => right.score - left.score || right.titleSimilarity - left.titleSimilarity || right.authorOverlap - left.authorOverlap);

    if (!matches.length) {
      continue;
    }

    return {
      identifiers: matches[0].identifiers,
      provider: matches[0].provider || provider,
      reason: 'resolved',
      score: matches[0].score,
      matchedTitle: matches[0].matchedTitle
    };
  }

  if (definitiveNoMatch) {
    await recordResolutionMiss(rootPath, cacheKey, config, 'no-match');
  }

  return {
    identifiers: {},
    provider: firstFailure?.provider || '',
    reason: definitiveNoMatch ? 'no-match' : (firstFailure?.reason || 'request-failed')
  };
}
