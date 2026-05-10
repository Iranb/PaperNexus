import {
  createPaperIdentity,
  normalizeArxivId,
  normalizeDoi,
  normalizePaperIdentifiers
} from '../../lib/paper-identifiers.js';
import { resolveOpenAlexApiKey } from '../../lib/api-keys.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { matchVenueRegistry } from './venue-registry.js';
import {
  hasSemanticScholarApiKey,
  waitForSemanticScholarRateLimit
} from './s2-rate-limit.js';

export const DEFAULT_DISCOVERY_PROVIDERS = ['openalex', 'semantic_scholar', 'crossref', 'arxiv'];
export const MAX_DISCOVERY_PROVIDER_THREADS = 4;
export const KNOWN_DISCOVERY_PROVIDERS = new Set([
  ...DEFAULT_DISCOVERY_PROVIDERS,
  'unpaywall',
  'pubmed',
  'europe_pmc',
  'core',
  'openreview',
  'dblp',
  'papers_with_code',
  'datacite'
]);

const OPENALEX_WORKS_URL = 'https://api.openalex.org/works';
const SEMANTIC_SCHOLAR_SEARCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const CROSSREF_WORKS_URL = 'https://api.crossref.org/works';
const ARXIV_QUERY_URL = 'https://export.arxiv.org/api/query';
const EUROPE_PMC_SEARCH_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const DBLP_SEARCH_URL = 'https://dblp.org/search/publ/api';
const CORE_SEARCH_URL = 'https://api.core.ac.uk/v3/search/works';

function normalizeProviderName(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 's2' || normalized === 'semanticscholar') return 'semantic_scholar';
  if (normalized === 'paperswithcode') return 'papers_with_code';
  if (normalized === 'europepmc') return 'europe_pmc';
  return normalized;
}

export function normalizeDiscoveryProviders(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const providers = rawValues
    .map(normalizeProviderName)
    .filter((entry) => KNOWN_DISCOVERY_PROVIDERS.has(entry));
  return providers.length ? unique(providers) : [...DEFAULT_DISCOVERY_PROVIDERS];
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function resolveDiscoveryConfig(options = {}) {
  return {
    providers: normalizeDiscoveryProviders(options.providers),
    providerConcurrency: Math.min(
      MAX_DISCOVERY_PROVIDER_THREADS,
      toPositiveInteger(
        options.providerConcurrency
        || options.provider_concurrency
        || options.maxProviderThreads
        || options.max_provider_threads,
        MAX_DISCOVERY_PROVIDER_THREADS
      )
    ),
    maxResultsPerQuery: Math.min(50, toPositiveInteger(options.maxResultsPerQuery, 20)),
    timeoutMs: Math.min(30000, toPositiveInteger(options.timeoutMs, 8000)),
    retryCount: Math.min(3, toNonNegativeInteger(options.retryCount ?? options.retry_count, 1)),
    retryBackoffMs: Math.min(5000, toPositiveInteger(options.retryBackoffMs || options.retry_backoff_ms, 250)),
    providerRequestDelayMs: Math.min(10000, toNonNegativeInteger(
      options.providerRequestDelayMs ?? options.provider_request_delay_ms,
      250
    )),
    maxRetryAfterMs: Math.min(10000, toPositiveInteger(options.maxRetryAfterMs || options.max_retry_after_ms, 10000)),
    mailto: String(
      options.mailto
      || process.env.PAPERNEXUS_DISCOVERY_MAILTO
      || process.env.PAPERNEXUS_IDENTIFIER_RESOLUTION_MAILTO
      || ''
    ).trim(),
    openAlexApiKey: resolveOpenAlexApiKey(options),
    semanticScholarApiKey: String(
      options.semanticScholarApiKey
      || process.env.SEMANTIC_SCHOLAR_API_KEY
      || process.env.S2_API_KEY
      || ''
    ).trim(),
    coreApiKey: String(
      options.coreApiKey
      || process.env.CORE_API_KEY
      || ''
    ).trim(),
    userAgent: String(options.userAgent || 'PaperNexus/0.1 literature-discovery').trim()
  };
}

async function waitForProviderRequestDelay(config = {}) {
  const delayMs = Math.max(0, Number(config.providerRequestDelayMs) || 0);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function fetchWithTimeout(url, config = {}, headers = {}) {
  const maxAttempts = 1 + Math.max(0, Math.floor(Number(config.retryCount ?? 1) || 0));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': config.userAgent || 'PaperNexus/0.1 literature-discovery',
          ...headers
        }
      });
      if (!shouldRetryResponse(response, config) || attempt === maxAttempts) return response;
      await waitForRetryDelay(response, config, attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || error?.name === 'AbortError') throw error;
      await waitForRetryDelay(null, config, attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('request-failed');
}

function maxRetryAfterMs(config = {}) {
  const configured = Number(config.maxRetryAfterMs || config.max_retry_after_ms || 10000);
  if (!Number.isFinite(configured) || configured <= 0) return 10000;
  return Math.min(10000, configured);
}

function shouldRetryResponse(response, config = {}) {
  if (![429, 500, 502, 503, 504].includes(Number(response?.status))) return false;
  const retryAfter = readRetryAfterMs(response);
  return !retryAfter || retryAfter <= maxRetryAfterMs(config);
}

function readRetryAfterMs(response) {
  const raw = typeof response?.headers?.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(raw || '');
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, timestamp - Date.now());
}

async function waitForRetryDelay(response, config = {}, attempt = 1) {
  const retryAfterMs = readRetryAfterMs(response);
  const backoffMs = Math.max(0, Number(config.retryBackoffMs || 250)) * attempt;
  const delayMs = retryAfterMs ? Math.min(retryAfterMs, maxRetryAfterMs(config)) : backoffMs;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function decodeXml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function reconstructOpenAlexAbstract(index = null) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      const parsed = Number(position);
      if (Number.isInteger(parsed) && parsed >= 0) words[parsed] = word;
    }
  }
  return words.filter(Boolean).join(' ');
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function normalizeFieldScope(planQuery = {}) {
  const value = String(planQuery.fieldScope || planQuery.field || '').trim().toLowerCase();
  return value === 'title' || value === 'abstract' ? value : '';
}

function stripOuterQuotes(value = '') {
  return String(value || '').trim().replace(/^"(.+)"$/, '$1').trim();
}

function normalizeCandidate(raw = {}) {
  const identifiers = normalizePaperIdentifiers(raw.identifiers || raw);
  const identity = createPaperIdentity({
    identifiers,
    title: raw.title
  });
  const provider = normalizeProviderName(raw.provider);
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
  const retrievalEvidence = Array.isArray(raw.retrievalEvidence) ? raw.retrievalEvidence : [];
  const venueMatch = matchVenueRegistry({
    venue: raw.venue,
    preferredPacks: raw.preferredVenuePacks
  });

  return {
    id: `${provider}:${stableHash(`${provider}:${identity.canonicalId || title}:${raw.url || ''}`, 16)}`,
    provider,
    title,
    authors: Array.isArray(raw.authors) ? raw.authors.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    year: raw.year || null,
    publicationDate: raw.publicationDate || null,
    venue: raw.venue || '',
    venueFamily: raw.venueFamily || venueMatch.venueFamily || '',
    venueType: raw.venueType || venueMatch.venueType || '',
    venuePackHits: unique([...(raw.venuePackHits || []), ...venueMatch.venuePackHits]),
    venueAliasesMatched: unique([...(raw.venueAliasesMatched || []), ...venueMatch.venueAliasesMatched]),
    publicationType: raw.publicationType || '',
    abstract: raw.abstract || '',
    identifiers,
    canonicalId: identity.canonicalId,
    canonicalIdSource: identity.canonicalIdSource,
    identityConfidence: identity.identityConfidence,
    identityAliases: identity.identityAliases,
    citationCount: Number.isFinite(Number(raw.citationCount)) ? Number(raw.citationCount) : null,
    openAccessStatus: raw.openAccessStatus || '',
    license: raw.license || '',
    pdfUrl: raw.pdfUrl || '',
    bestOaUrl: raw.bestOaUrl || '',
    landingPageUrl: raw.landingPageUrl || raw.url || '',
    fullTextUrls: unique((raw.fullTextUrls || []).filter(Boolean)),
    sourceHints: unique([raw.pdfUrl, raw.bestOaUrl, raw.landingPageUrl, ...(raw.sourceHints || []), ...(raw.fullTextUrls || [])].filter(Boolean)),
    retrievalEvidence,
    rawSummary: raw.rawSummary || ''
  };
}

function extractOpenAlexAuthors(work = {}) {
  return Array.isArray(work.authorships)
    ? work.authorships.map((entry) => entry?.author?.display_name).filter(Boolean)
    : [];
}

function extractOpenAlexIdentifiers(work = {}) {
  return normalizePaperIdentifiers({
    doi: work.doi || work.ids?.doi,
    arxivId: work.ids?.arxiv,
    pmid: work.ids?.pmid,
    pmcid: work.ids?.pmcid,
    issn: work.primary_location?.source?.issn_l || work.host_venue?.issn_l
  });
}

async function fetchOpenAlex(query, planQuery, config) {
  const url = new URL(OPENALEX_WORKS_URL);
  const fieldScope = normalizeFieldScope(planQuery);
  if (fieldScope === 'title') {
    url.searchParams.set('filter', `title.search:${stripOuterQuotes(query)}`);
  } else if (fieldScope === 'abstract') {
    url.searchParams.set('filter', `abstract.search:${stripOuterQuotes(query)}`);
  } else {
    url.searchParams.set('search', query);
  }
  url.searchParams.set('per-page', String(config.maxResultsPerQuery));
  url.searchParams.set('select', [
    'id',
    'doi',
    'title',
    'display_name',
    'publication_year',
    'publication_date',
    'authorships',
    'ids',
    'primary_location',
    'best_oa_location',
    'open_access',
    'cited_by_count',
    'type',
    'abstract_inverted_index'
  ].join(','));
  if (config.mailto) url.searchParams.set('mailto', config.mailto);
  if (config.openAlexApiKey) url.searchParams.set('api_key', config.openAlexApiKey);
  const response = await fetchWithTimeout(url, config);
  if (!response.ok) throw new Error(`openalex http ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map((work) => normalizeCandidate({
    provider: 'openalex',
    title: work.title || work.display_name || '',
    authors: extractOpenAlexAuthors(work),
    year: work.publication_year || null,
    publicationDate: work.publication_date || null,
    venue: work.primary_location?.source?.display_name || '',
    publicationType: work.type || '',
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    identifiers: extractOpenAlexIdentifiers(work),
    citationCount: work.cited_by_count,
    openAccessStatus: work.open_access?.oa_status || '',
    pdfUrl: work.best_oa_location?.pdf_url || work.primary_location?.pdf_url || '',
    bestOaUrl: work.best_oa_location?.landing_page_url || work.primary_location?.landing_page_url || '',
    landingPageUrl: work.primary_location?.landing_page_url || work.id || '',
    preferredVenuePacks: planQuery.preferredVenuePacks,
    retrievalEvidence: [{
      provider: 'openalex',
      queryId: planQuery.id,
      query: planQuery.query,
      family: planQuery.family,
      fieldScope,
      preferredVenuePacks: planQuery.preferredVenuePacks,
      providerId: work.id || ''
    }]
  }));
}

function extractS2Identifiers(paper = {}) {
  const external = paper.externalIds || {};
  return normalizePaperIdentifiers({
    doi: external.DOI,
    arxivId: external.ArXiv,
    pmid: external.PubMed,
    pmcid: external.PubMedCentral
  });
}

function semanticScholarFieldsOfStudy(planQuery = {}) {
  const rawValue = planQuery.semanticScholarFieldsOfStudy || planQuery.fieldsOfStudy || [];
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  return unique(values.map((entry) => String(entry || '').trim()).filter(Boolean));
}

async function fetchSemanticScholar(query, planQuery, config) {
  const url = new URL(SEMANTIC_SCHOLAR_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(config.maxResultsPerQuery));
  url.searchParams.set('fields', [
    'title',
    'authors',
    'year',
    'publicationDate',
    'venue',
    'abstract',
    'citationCount',
    'externalIds',
    'openAccessPdf',
    'publicationTypes',
    'fieldsOfStudy',
    'isOpenAccess',
    'url'
  ].join(','));
  if (planQuery.venue) url.searchParams.set('venue', String(planQuery.venue).trim());
  const fieldsOfStudy = semanticScholarFieldsOfStudy(planQuery);
  if (fieldsOfStudy.length) url.searchParams.set('fieldsOfStudy', fieldsOfStudy.join(','));
  const headers = config.semanticScholarApiKey ? { 'x-api-key': config.semanticScholarApiKey } : {};
  const response = await fetchSemanticScholarWithTimeout(url, config, headers);
  if (!response.ok) throw new Error(`semantic_scholar http ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload.data) ? payload.data : [];
  return results.map((paper) => normalizeCandidate({
    provider: 'semantic_scholar',
    title: paper.title || '',
    authors: Array.isArray(paper.authors) ? paper.authors.map((author) => author.name).filter(Boolean) : [],
    year: paper.year || null,
    publicationDate: paper.publicationDate || null,
    venue: paper.venue || '',
    publicationType: Array.isArray(paper.publicationTypes) ? paper.publicationTypes[0] || '' : '',
    abstract: paper.abstract || '',
    identifiers: extractS2Identifiers(paper),
    citationCount: paper.citationCount,
    openAccessStatus: paper.isOpenAccess ? 'oa' : '',
    pdfUrl: paper.openAccessPdf?.url || '',
    bestOaUrl: paper.openAccessPdf?.url || '',
    landingPageUrl: paper.url || '',
    preferredVenuePacks: planQuery.preferredVenuePacks,
    retrievalEvidence: [{
      provider: 'semantic_scholar',
      queryId: planQuery.id,
      query: planQuery.query,
      family: planQuery.family,
      preferredVenuePacks: planQuery.preferredVenuePacks,
      venue: planQuery.venue || '',
      semanticScholarFieldsOfStudy: fieldsOfStudy,
      providerId: paper.paperId || ''
    }]
  }));
}

async function fetchSemanticScholarWithTimeout(url, config = {}, headers = {}) {
  const maxAttempts = 1 + Math.max(0, Math.floor(Number(config.retryCount ?? 1) || 0));
  const requestConfig = {
    ...config,
    retryCount: 0
  };
  const shouldRateLimit = hasSemanticScholarApiKey(headers);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (shouldRateLimit) await waitForSemanticScholarRateLimit(config);
      const response = await fetchWithTimeout(url, requestConfig, headers);
      if (!shouldRetryResponse(response, config) || attempt === maxAttempts) return response;
      await waitForRetryDelay(response, config, attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || error?.name === 'AbortError') throw error;
      await waitForRetryDelay(null, config, attempt);
    }
  }

  throw lastError || new Error('request-failed');
}

function extractCrossrefAuthors(item = {}) {
  return Array.isArray(item.author)
    ? item.author.map((author) => [author.given, author.family].filter(Boolean).join(' ').trim()).filter(Boolean)
    : [];
}

async function fetchCrossref(query, planQuery, config) {
  const url = new URL(CROSSREF_WORKS_URL);
  const fieldScope = normalizeFieldScope(planQuery);
  const queryText = stripOuterQuotes(query);
  if (fieldScope === 'title') {
    url.searchParams.set('query.title', queryText);
  } else if (fieldScope === 'abstract') {
    url.searchParams.set('query.bibliographic', queryText);
  } else {
    url.searchParams.set('query', queryText);
  }
  url.searchParams.set('rows', String(config.maxResultsPerQuery));
  if (config.mailto) url.searchParams.set('mailto', config.mailto);
  const response = await fetchWithTimeout(url, config);
  if (!response.ok) throw new Error(`crossref http ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload?.message?.items) ? payload.message.items : [];
  return results.map((item) => normalizeCandidate({
    provider: 'crossref',
    title: firstArrayValue(item.title),
    authors: extractCrossrefAuthors(item),
    year: item.published?.['date-parts']?.[0]?.[0]
      || item['published-print']?.['date-parts']?.[0]?.[0]
      || item['published-online']?.['date-parts']?.[0]?.[0]
      || null,
    publicationDate: Array.isArray(item.published?.['date-parts']?.[0])
      ? item.published['date-parts'][0].filter(Boolean).join('-')
      : null,
    venue: firstArrayValue(item['container-title']),
    publicationType: item.type || '',
    abstract: stripHtml(item.abstract || ''),
    identifiers: normalizePaperIdentifiers({
      doi: item.DOI,
      isbn: Array.isArray(item.ISBN) ? item.ISBN[0] : item.ISBN,
      issn: Array.isArray(item.ISSN) ? item.ISSN[0] : item.ISSN
    }),
    landingPageUrl: item.URL || (item.DOI ? `https://doi.org/${normalizeDoi(item.DOI)}` : ''),
    preferredVenuePacks: planQuery.preferredVenuePacks,
    retrievalEvidence: [{
      provider: 'crossref',
      queryId: planQuery.id,
      query: planQuery.query,
      family: planQuery.family,
      fieldScope,
      preferredVenuePacks: planQuery.preferredVenuePacks,
      providerId: item.DOI || item.URL || ''
    }]
  }));
}

function extractXmlTag(entry, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = entry.match(pattern);
  return match ? decodeXml(match[1]) : '';
}

function extractXmlTags(entry, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const values = [];
  let match = pattern.exec(entry);
  while (match) {
    values.push(decodeXml(match[1]));
    match = pattern.exec(entry);
  }
  return values;
}

function extractArxivPdfUrl(entry) {
  const linkPattern = /<link\b([^>]+)>/gi;
  let match = linkPattern.exec(entry);
  while (match) {
    const attrs = match[1];
    if (/type=["']application\/pdf["']/i.test(attrs)) {
      const href = attrs.match(/href=["']([^"']+)["']/i)?.[1] || '';
      if (href) return decodeXml(href);
    }
    match = linkPattern.exec(entry);
  }
  return '';
}

function buildArxivSearchQuery(query = '', planQuery = {}) {
  const fieldScope = normalizeFieldScope(planQuery);
  const queryText = stripOuterQuotes(query);
  if (fieldScope === 'title') return `ti:${queryText}`;
  if (fieldScope === 'abstract') return `abs:${queryText}`;
  return query.includes(':') ? query : `all:${query}`;
}

async function fetchArxiv(query, planQuery, config) {
  const url = new URL(ARXIV_QUERY_URL);
  const fieldScope = normalizeFieldScope(planQuery);
  url.searchParams.set('search_query', buildArxivSearchQuery(query, planQuery));
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(config.maxResultsPerQuery));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'descending');
  const response = await fetchWithTimeout(url, config, {
    accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'
  });
  if (!response.ok) throw new Error(`arxiv http ${response.status}`);
  const text = await response.text();
  const entries = text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return entries.map((entry) => {
    const idUrl = extractXmlTag(entry, 'id');
    const arxivId = normalizeArxivId(idUrl.split('/abs/').pop() || idUrl);
    const doi = extractXmlTag(entry, 'arxiv:doi');
    const pdfUrl = extractArxivPdfUrl(entry) || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : '');
    return normalizeCandidate({
      provider: 'arxiv',
      title: extractXmlTag(entry, 'title'),
      authors: extractXmlTags(entry, 'name'),
      year: Number(extractXmlTag(entry, 'published').slice(0, 4)) || null,
      publicationDate: extractXmlTag(entry, 'published').slice(0, 10) || null,
      publicationType: 'preprint',
      abstract: extractXmlTag(entry, 'summary'),
      identifiers: normalizePaperIdentifiers({ arxivId, doi }),
      pdfUrl,
      bestOaUrl: idUrl,
      landingPageUrl: idUrl,
      preferredVenuePacks: planQuery.preferredVenuePacks,
      retrievalEvidence: [{
        provider: 'arxiv',
        queryId: planQuery.id,
        query: planQuery.query,
        family: planQuery.family,
        fieldScope,
        preferredVenuePacks: planQuery.preferredVenuePacks,
        providerId: arxivId
      }]
    });
  });
}

function normalizeDblpAuthors(info = {}) {
  const authorsRaw = info.authors && typeof info.authors === 'object'
    ? info.authors.author
    : [];
  const values = Array.isArray(authorsRaw) ? authorsRaw : [authorsRaw];
  return values.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return entry.text || entry._ || entry.name || '';
    return '';
  }).map((entry) => String(entry || '').trim()).filter(Boolean);
}

function pickDblpExternalUrl(info = {}) {
  const value = info.ee;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && /^https?:\/\//i.test(entry));
    if (first) return first;
  }
  return '';
}

async function fetchDblp(query, planQuery, config) {
  const url = new URL(DBLP_SEARCH_URL);
  const fieldScope = normalizeFieldScope(planQuery);
  url.searchParams.set('q', fieldScope === 'title' ? `${stripOuterQuotes(query)}$` : query);
  url.searchParams.set('h', String(config.maxResultsPerQuery));
  url.searchParams.set('format', 'json');
  const response = await fetchWithTimeout(url, config, {
    accept: 'application/json'
  });
  if (!response.ok) throw new Error(`dblp http ${response.status}`);
  const payload = await response.json();
  const hits = Array.isArray(payload?.result?.hits?.hit) ? payload.result.hits.hit : [];
  return hits.map((entry) => {
    const info = entry.info || {};
    const venue = String(info.venue || '').trim();
    return normalizeCandidate({
      provider: 'dblp',
      title: info.title || '',
      authors: normalizeDblpAuthors(info),
      year: Number(info.year) || null,
      publicationDate: info.year ? `${info.year}-01-01` : null,
      venue,
      publicationType: /\btransactions|journal|letters|review\b/i.test(venue) ? 'journal-article' : 'conference-paper',
      identifiers: normalizePaperIdentifiers({
        doi: info.doi
      }),
      bestOaUrl: pickDblpExternalUrl(info),
      landingPageUrl: info.url || pickDblpExternalUrl(info),
      retrievalEvidence: [{
        provider: 'dblp',
        queryId: planQuery.id,
        query: planQuery.query,
        family: planQuery.family,
        fieldScope,
        preferredVenuePacks: planQuery.preferredVenuePacks,
        providerId: info.key || info.url || ''
      }],
      preferredVenuePacks: planQuery.preferredVenuePacks
    });
  });
}

function normalizeCoreAuthors(item = {}) {
  const authors = Array.isArray(item.authors) ? item.authors : [];
  return authors.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return entry.name || entry.fullName || entry.full_name || '';
    return '';
  }).map((entry) => String(entry || '').trim()).filter(Boolean);
}

function parseCoreYear(item = {}) {
  const value = item.yearPublished || item.year || item.publishedYear;
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function pickCoreUrl(item = {}) {
  return item.downloadUrl || item.fullTextIdentifier || item.url || item.oai || '';
}

async function fetchCore(query, planQuery, config) {
  const apiKey = String(config.coreApiKey || process.env.CORE_API_KEY || '').trim();
  if (!apiKey) throw new Error('missing_credentials: CORE_API_KEY is not configured');
  const url = new URL(CORE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(config.maxResultsPerQuery));
  const response = await fetchWithTimeout(url, config, {
    accept: 'application/json',
    Authorization: `Bearer ${apiKey}`
  });
  if (!response.ok) throw new Error(`core http ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload.results)
    ? payload.results
    : (Array.isArray(payload.data) ? payload.data : []);
  return results.map((item) => {
    const urlValue = pickCoreUrl(item);
    const year = parseCoreYear(item);
    return normalizeCandidate({
      provider: 'core',
      title: item.title || '',
      authors: normalizeCoreAuthors(item),
      year,
      publicationDate: year ? `${year}-01-01` : null,
      venue: item.publisher || item.journal || '',
      publicationType: 'repository-work',
      abstract: item.abstract || '',
      identifiers: normalizePaperIdentifiers({
        doi: item.doi
      }),
      pdfUrl: item.downloadUrl || '',
      bestOaUrl: urlValue,
      landingPageUrl: item.url || urlValue,
      sourceHints: [urlValue, item.downloadUrl].filter(Boolean),
      retrievalEvidence: [{
        provider: 'core',
        queryId: planQuery.id,
        query: planQuery.query,
        family: planQuery.family,
        preferredVenuePacks: planQuery.preferredVenuePacks,
        providerId: item.id || item.oai || item.doi || ''
      }],
      preferredVenuePacks: planQuery.preferredVenuePacks
    });
  });
}

function normalizeEuropePmcAuthors(result = {}) {
  if (Array.isArray(result.authorList?.author)) {
    return result.authorList.author.map((author) => author.fullName || author.collectiveName).filter(Boolean);
  }
  return String(result.authorString || '')
    .split(/\s*,\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectEuropePmcFullTextUrls(result = {}) {
  const entries = Array.isArray(result.fullTextUrlList?.fullTextUrl)
    ? result.fullTextUrlList.fullTextUrl
    : [];
  return entries.map((entry) => entry.url || '').filter(Boolean);
}

function pickEuropePmcPdfUrl(result = {}) {
  const entries = Array.isArray(result.fullTextUrlList?.fullTextUrl)
    ? result.fullTextUrlList.fullTextUrl
    : [];
  const pdf = entries.find((entry) => (
    /pdf/i.test(entry.documentStyle || '') || /\.pdf(?:$|[?#])/i.test(entry.url || '') || /\/pdf\/?$/i.test(entry.url || '')
  ));
  if (pdf?.url) return pdf.url;
  return result.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${result.pmcid}/pdf/` : '';
}

async function fetchEuropePmc(query, planQuery, config) {
  const url = new URL(EUROPE_PMC_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageSize', String(config.maxResultsPerQuery));
  url.searchParams.set('resultType', 'core');
  if (config.mailto) url.searchParams.set('email', config.mailto);
  const response = await fetchWithTimeout(url, config, {
    accept: 'application/json'
  });
  if (!response.ok) throw new Error(`europe_pmc http ${response.status}`);
  const payload = await response.json();
  const results = Array.isArray(payload?.resultList?.result) ? payload.resultList.result : [];
  return results.map((result) => {
    const fullTextUrls = collectEuropePmcFullTextUrls(result);
    const pdfUrl = pickEuropePmcPdfUrl(result);
    const publicationDate = result.firstPublicationDate || result.printPublicationDate || result.electronicPublicationDate || '';
    return normalizeCandidate({
      provider: 'europe_pmc',
      title: result.title || '',
      authors: normalizeEuropePmcAuthors(result),
      year: Number(result.pubYear || String(publicationDate).slice(0, 4)) || null,
      publicationDate: publicationDate || null,
      venue: result.journalTitle || result.bookOrReportDetails || '',
      publicationType: result.pubType || '',
      abstract: stripHtml(result.abstractText || ''),
      identifiers: normalizePaperIdentifiers({
        doi: result.doi,
        pmid: result.pmid,
        pmcid: result.pmcid
      }),
      citationCount: result.citedByCount,
      openAccessStatus: result.isOpenAccess === 'Y' || result.isOpenAccess === true ? 'oa' : '',
      pdfUrl,
      bestOaUrl: fullTextUrls[0] || (result.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${result.pmcid}/` : ''),
      landingPageUrl: result.pmcid
        ? `https://pmc.ncbi.nlm.nih.gov/articles/${result.pmcid}/`
        : (result.doi ? `https://doi.org/${normalizeDoi(result.doi)}` : ''),
      fullTextUrls,
      preferredVenuePacks: planQuery.preferredVenuePacks,
      retrievalEvidence: [{
        provider: 'europe_pmc',
        queryId: planQuery.id,
        query: planQuery.query,
        family: planQuery.family,
        preferredVenuePacks: planQuery.preferredVenuePacks,
        providerId: result.id || result.pmid || result.pmcid || result.doi || ''
      }]
    });
  });
}

const PROVIDER_FETCHERS = {
  openalex: fetchOpenAlex,
  semantic_scholar: fetchSemanticScholar,
  crossref: fetchCrossref,
  arxiv: fetchArxiv,
  europe_pmc: fetchEuropePmc,
  pubmed: fetchEuropePmc,
  dblp: fetchDblp,
  core: fetchCore
};

function shouldRunQueryForProvider(provider, query = {}) {
  const allowList = Array.isArray(query.providerAllowList)
    ? query.providerAllowList.map(normalizeProviderName).filter(Boolean)
    : [];
  return !allowList.length || allowList.includes(provider);
}

function buildProviderQueryResult(provider, query = {}, values = {}) {
  const queryResult = {
    provider,
    queryId: query.id,
    query: query.query,
    family: query.family,
    ...values
  };
  if (query.venue) queryResult.venue = query.venue;
  if (query.fieldScope) queryResult.fieldScope = query.fieldScope;
  if (Array.isArray(query.semanticScholarFieldsOfStudy)) {
    queryResult.semanticScholarFieldsOfStudy = query.semanticScholarFieldsOfStudy;
  }
  return queryResult;
}

async function runProviderQuery(provider, fetcher, query, config) {
  try {
    const providerCandidates = await fetcher(query.query, query, config);
    return {
      queryResult: buildProviderQueryResult(provider, query, {
        ok: true,
        count: providerCandidates.length,
        candidates: providerCandidates.map((candidate) => candidate.id)
      }),
      candidates: providerCandidates
    };
  } catch (error) {
    return {
      queryResult: buildProviderQueryResult(provider, query, {
        ok: false,
        reason: error?.name === 'AbortError' ? 'timeout' : truncate(error?.message || 'request-failed', 200),
        candidates: []
      }),
      candidates: []
    };
  }
}

export async function executeProviderQueries(params = {}) {
  const plan = params.plan || {};
  const config = resolveDiscoveryConfig(params);
  const providerResults = new Array(config.providers.length);
  let nextProviderIndex = 0;

  async function worker() {
    while (nextProviderIndex < config.providers.length) {
      const providerIndex = nextProviderIndex;
      nextProviderIndex += 1;
      const provider = config.providers[providerIndex];
      const fetcher = PROVIDER_FETCHERS[provider];
      const queryResults = [];
      const candidateBatches = [];

      if (!fetcher) {
        providerResults[providerIndex] = {
          queryResults: [{
            provider,
            ok: false,
            skipped: true,
            reason: 'provider-not-implemented',
            candidates: []
          }],
          candidateBatches
        };
        continue;
      }

      let hasRunProviderQuery = false;
      for (const query of plan.queries || []) {
        if (!shouldRunQueryForProvider(provider, query)) continue;
        if (hasRunProviderQuery) await waitForProviderRequestDelay(config);
        const result = await runProviderQuery(provider, fetcher, query, config);
        hasRunProviderQuery = true;
        queryResults.push(result.queryResult);
        candidateBatches.push(result.candidates);
      }

      providerResults[providerIndex] = {
        queryResults,
        candidateBatches
      };
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(config.providerConcurrency, Math.max(config.providers.length, 1)) },
    () => worker()
  ));

  return {
    providers: config.providers,
    queryResults: providerResults.flatMap((entry) => (entry?.queryResults || []).filter(Boolean)),
    candidates: providerResults.flatMap((entry) => (
      (entry?.candidateBatches || []).filter(Boolean).flat()
    ))
  };
}
