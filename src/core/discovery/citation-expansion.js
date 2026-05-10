import {
  createPaperIdentity,
  normalizePaperIdentifiers
} from '../../lib/paper-identifiers.js';
import { resolveOpenAlexApiKey } from '../../lib/api-keys.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import {
  hasSemanticScholarApiKey,
  isSemanticScholarApiUrl,
  waitForSemanticScholarRateLimit
} from './s2-rate-limit.js';
import { scheduleDiscoveryFetch } from './request-scheduler.js';

const SEMANTIC_SCHOLAR_PAPER_URL = 'https://api.semanticscholar.org/graph/v1/paper';
const OPENALEX_WORKS_URL = 'https://api.openalex.org/works';

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

function getSeedLookupId(candidate = {}) {
  const identifiers = candidate.identifiers || {};
  if (identifiers.doi) return `DOI:${identifiers.doi}`;
  if (identifiers.arxivId) return `ARXIV:${identifiers.arxivId}`;
  if (identifiers.pmid) return `PMID:${identifiers.pmid}`;
  return '';
}

function getOpenAlexSeedLookup(candidate = {}) {
  const identifiers = candidate.identifiers || {};
  if (identifiers.doi) {
    return {
      query: `DOI:${identifiers.doi}`,
      lookupId: `https://doi.org/${identifiers.doi}`
    };
  }
  if (identifiers.arxivId) {
    return {
      query: `ARXIV:${identifiers.arxivId}`,
      lookupId: `https://arxiv.org/abs/${identifiers.arxivId}`
    };
  }
  const openAlexEvidence = Array.isArray(candidate.retrievalEvidence)
    ? candidate.retrievalEvidence.find((entry) => (
        entry?.provider === 'openalex'
        && /(?:^|\/)W\d+$/i.test(String(entry.providerId || ''))
      ))
    : null;
  const providerId = String(openAlexEvidence?.providerId || '').trim();
  if (!providerId) return null;
  const workId = providerId.split('/').pop();
  return {
    query: workId,
    lookupId: workId
  };
}

async function fetchWithTimeout(url, config = {}, headers = {}) {
  return scheduleDiscoveryFetch(url, config, headers);
}

function maxRetryAfterMs(params = {}) {
  const configured = Number(params.maxRetryAfterMs || params.max_retry_after_ms || 10000);
  if (!Number.isFinite(configured) || configured <= 0) return 10000;
  return Math.min(10000, configured);
}

function shouldRetryResponse(response, params = {}) {
  if (![429, 500, 502, 503, 504].includes(Number(response?.status))) return false;
  const retryAfter = retryAfterMs(response);
  return !retryAfter || retryAfter <= maxRetryAfterMs(params);
}

function retryAfterMs(response) {
  const raw = typeof response?.headers?.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(raw || '');
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, timestamp - Date.now());
}

async function waitForRetryDelay(response, params = {}, attempt = 1) {
  const configured = Number(params.retryBackoffMs || params.retry_backoff_ms || 250);
  const backoffMs = Math.max(0, Number.isFinite(configured) ? configured : 250) * attempt;
  const retryAfter = retryAfterMs(response);
  const delayMs = retryAfter ? Math.min(retryAfter, maxRetryAfterMs(params)) : backoffMs;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function fetchSemanticScholarCitation(url, params = {}, headers = {}) {
  const maxAttempts = 1 + Math.min(3, toNonNegativeInteger(params.retryCount ?? params.retry_count, 1));
  const shouldRateLimit = isSemanticScholarApiUrl(url) && hasSemanticScholarApiKey(headers);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (shouldRateLimit) await waitForSemanticScholarRateLimit(params);
      const response = await fetchWithTimeout(url, params, headers);
      if (!shouldRetryResponse(response, params) || attempt === maxAttempts) return response;
      await waitForRetryDelay(response, params, attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || error?.name === 'AbortError') throw error;
      await waitForRetryDelay(null, params, attempt);
    }
  }
  throw lastError || new Error('request-failed');
}

function normalizeAuthors(value) {
  return Array.isArray(value)
    ? value.map((author) => author?.name || author).map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
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
    pmcid: work.ids?.pmcid
  });
}

function normalizeExpansionCandidate(raw = {}, context = {}) {
  const identifiers = normalizePaperIdentifiers({
    doi: raw.externalIds?.DOI,
    arxivId: raw.externalIds?.ArXiv,
    pmid: raw.externalIds?.PubMed,
    pmcid: raw.externalIds?.PubMedCentral
  });
  const identity = createPaperIdentity({
    identifiers,
    title: raw.title
  });
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
  const provider = 'semantic_scholar_citation';

  return {
    id: `${provider}:${stableHash(`${context.seedCanonicalId}:${context.direction}:${identity.canonicalId || title}`, 16)}`,
    provider,
    title,
    authors: normalizeAuthors(raw.authors),
    year: raw.year || null,
    publicationDate: raw.publicationDate || null,
    venue: raw.venue || '',
    publicationType: Array.isArray(raw.publicationTypes) ? raw.publicationTypes[0] || '' : '',
    abstract: raw.abstract || '',
    identifiers,
    canonicalId: identity.canonicalId,
    canonicalIdSource: identity.canonicalIdSource,
    identityConfidence: identity.identityConfidence,
    identityAliases: identity.identityAliases,
    citationCount: Number.isFinite(Number(raw.citationCount)) ? Number(raw.citationCount) : null,
    openAccessStatus: raw.isOpenAccess ? 'oa' : '',
    license: '',
    pdfUrl: raw.openAccessPdf?.url || '',
    bestOaUrl: raw.openAccessPdf?.url || raw.url || '',
    landingPageUrl: raw.url || '',
    fullTextUrls: [],
    sourceHints: unique([raw.openAccessPdf?.url, raw.url].filter(Boolean)),
    retrievalEvidence: [{
      provider,
      queryId: context.queryId,
      query: context.seedCanonicalId,
      family: context.direction === 'reference' ? 'backward_citation' : 'forward_citation',
      providerId: raw.paperId || '',
      seedCanonicalId: context.seedCanonicalId,
      seedTitle: context.seedTitle || ''
    }],
    rawSummary: ''
  };
}

function normalizeOpenAlexRelatedCandidate(work = {}, context = {}) {
  const identifiers = extractOpenAlexIdentifiers(work);
  const identity = createPaperIdentity({
    identifiers,
    title: work.title || work.display_name
  });
  const title = String(work.title || work.display_name || '').replace(/\s+/g, ' ').trim();
  const provider = 'openalex_related';
  const pdfUrl = work.best_oa_location?.pdf_url || work.primary_location?.pdf_url || '';
  const landingPageUrl = work.primary_location?.landing_page_url || work.id || '';

  return {
    id: `${provider}:${stableHash(`${context.seedCanonicalId}:related:${identity.canonicalId || title}`, 16)}`,
    provider,
    title,
    authors: extractOpenAlexAuthors(work),
    year: work.publication_year || null,
    publicationDate: work.publication_date || null,
    venue: work.primary_location?.source?.display_name || '',
    publicationType: work.type || '',
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    identifiers,
    canonicalId: identity.canonicalId,
    canonicalIdSource: identity.canonicalIdSource,
    identityConfidence: identity.identityConfidence,
    identityAliases: identity.identityAliases,
    citationCount: Number.isFinite(Number(work.cited_by_count)) ? Number(work.cited_by_count) : null,
    openAccessStatus: work.open_access?.oa_status || '',
    license: '',
    pdfUrl,
    bestOaUrl: work.best_oa_location?.landing_page_url || landingPageUrl,
    landingPageUrl,
    fullTextUrls: [],
    sourceHints: unique([pdfUrl, work.best_oa_location?.landing_page_url, landingPageUrl].filter(Boolean)),
    retrievalEvidence: [{
      provider,
      queryId: context.queryId,
      query: context.seedCanonicalId,
      family: 'related_work_similarity',
      providerId: work.id || '',
      seedCanonicalId: context.seedCanonicalId,
      seedTitle: context.seedTitle || '',
      seedProviderTitle: context.seedProviderTitle || ''
    }],
    rawSummary: ''
  };
}

function extractExpansionCandidates(payload = {}, seed = {}, options = {}) {
  const perSeed = toPositiveInteger(options.maxCitationsPerSeed || options.maxPerSeed, 5);
  const seedContext = {
    seedCanonicalId: seed.canonicalId || seed.id || seed.title || '',
    seedTitle: seed.title || ''
  };
  const references = Array.isArray(payload.references) ? payload.references.slice(0, perSeed) : [];
  const citations = Array.isArray(payload.citations) ? payload.citations.slice(0, perSeed) : [];
  return [
    ...references.map((paper) => normalizeExpansionCandidate(paper, {
      ...seedContext,
      queryId: `citation-ref-${stableHash(seedContext.seedCanonicalId, 8)}`,
      direction: 'reference'
    })),
    ...citations.map((paper) => normalizeExpansionCandidate(paper, {
      ...seedContext,
      queryId: `citation-cit-${stableHash(seedContext.seedCanonicalId, 8)}`,
      direction: 'citation'
    }))
  ].filter((candidate) => candidate.title || candidate.canonicalId);
}

function isOpenAlexRelatedExpansionEnabled(params = {}) {
  if (params.openAlexRelatedExpansion !== undefined) return Boolean(params.openAlexRelatedExpansion);
  if (params.openalexRelatedExpansion !== undefined) return Boolean(params.openalexRelatedExpansion);
  if (params.openalex_related_expansion !== undefined) return Boolean(params.openalex_related_expansion);
  return true;
}

function extractOpenAlexWorkId(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/(?:^|\/)(W\d+)$/i);
  return match ? match[1].toUpperCase() : '';
}

function openAlexSelectFields() {
  return [
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
  ].join(',');
}

async function fetchOpenAlexRelatedCandidates(seed = {}, params = {}) {
  const lookup = getOpenAlexSeedLookup(seed);
  if (!lookup) return [];
  const openAlexApiKey = resolveOpenAlexApiKey(params);

  const perSeed = toPositiveInteger(
    params.maxRelatedPerSeed
    || params.max_related_per_seed
    || params.maxCitationsPerSeed
    || params.maxPerSeed,
    5
  );
  const seedUrl = new URL(`${OPENALEX_WORKS_URL}/${encodeURIComponent(lookup.lookupId)}`);
  seedUrl.searchParams.set('select', 'id,title,display_name,related_works');
  if (params.mailto) seedUrl.searchParams.set('mailto', params.mailto);
  if (openAlexApiKey) seedUrl.searchParams.set('api_key', openAlexApiKey);
  const seedResponse = await fetchSemanticScholarCitation(seedUrl, params, {
    accept: 'application/json'
  });
  if (seedResponse.status === 404) return [];
  if (!seedResponse.ok) throw new Error(`openalex_related http ${seedResponse.status}`);
  const seedPayload = await seedResponse.json();
  const relatedIds = (Array.isArray(seedPayload.related_works) ? seedPayload.related_works : [])
    .map(extractOpenAlexWorkId)
    .filter(Boolean)
    .slice(0, perSeed);
  if (!relatedIds.length) return [];

  const worksUrl = new URL(OPENALEX_WORKS_URL);
  worksUrl.searchParams.set('filter', `ids.openalex:${relatedIds.join('|')}`);
  worksUrl.searchParams.set('per-page', String(relatedIds.length));
  worksUrl.searchParams.set('select', openAlexSelectFields());
  if (params.mailto) worksUrl.searchParams.set('mailto', params.mailto);
  if (openAlexApiKey) worksUrl.searchParams.set('api_key', openAlexApiKey);
  const worksResponse = await fetchSemanticScholarCitation(worksUrl, params, {
    accept: 'application/json'
  });
  if (!worksResponse.ok) throw new Error(`openalex_related http ${worksResponse.status}`);
  const worksPayload = await worksResponse.json();
  const seedContext = {
    seedCanonicalId: seed.canonicalId || seed.id || seed.title || '',
    seedTitle: seed.title || '',
    seedProviderTitle: seedPayload.title || seedPayload.display_name || '',
    queryId: `openalex-related-${stableHash(seed.canonicalId || seed.id || seed.title || lookup.query, 8)}`
  };
  return (Array.isArray(worksPayload.results) ? worksPayload.results : [])
    .map((work) => normalizeOpenAlexRelatedCandidate(work, seedContext))
    .filter((candidate) => candidate.title || candidate.canonicalId);
}

export async function expandDiscoveryCitations(params = {}) {
  const candidates = Array.isArray(params.candidates) ? params.candidates : [];
  const maxSeeds = toPositiveInteger(params.maxCitationSeeds || params.maxSeeds, 3);
  const seeds = candidates
    .filter((candidate) => getSeedLookupId(candidate) || getOpenAlexSeedLookup(candidate))
    .slice(0, maxSeeds);
  const expandedCandidates = [];
  const queryResults = [];
  const semanticScholarCandidates = [];
  const openAlexRelatedCandidates = [];
  const apiKey = String(params.semanticScholarApiKey || process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY || '').trim();

  for (const seed of seeds) {
    const lookupId = getSeedLookupId(seed);
    if (!lookupId) continue;
    const url = new URL(`${SEMANTIC_SCHOLAR_PAPER_URL}/${encodeURIComponent(lookupId)}`);
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
      'isOpenAccess',
      'url',
      'references.paperId',
      'references.title',
      'references.authors',
      'references.year',
      'references.publicationDate',
      'references.venue',
      'references.externalIds',
      'references.openAccessPdf',
      'references.url',
      'references.citationCount',
      'citations.paperId',
      'citations.title',
      'citations.authors',
      'citations.year',
      'citations.publicationDate',
      'citations.venue',
      'citations.externalIds',
      'citations.openAccessPdf',
      'citations.url',
      'citations.citationCount'
    ].join(','));
    try {
      const headers = apiKey ? { 'x-api-key': apiKey } : {};
      const response = await fetchSemanticScholarCitation(url, params, headers);
      if (!response.ok) throw new Error(`semantic_scholar_citation http ${response.status}`);
      const payload = await response.json();
      const seedCandidates = extractExpansionCandidates(payload, seed, params);
      semanticScholarCandidates.push(...seedCandidates);
      expandedCandidates.push(...seedCandidates);
      queryResults.push({
        provider: 'semantic_scholar_citation',
        queryId: `citation-${stableHash(lookupId, 8)}`,
        query: lookupId,
        family: 'citation_expansion',
        ok: true,
        count: seedCandidates.length,
        candidates: seedCandidates.map((candidate) => candidate.id)
      });
    } catch (error) {
      queryResults.push({
        provider: 'semantic_scholar_citation',
        queryId: `citation-${stableHash(lookupId, 8)}`,
        query: lookupId,
        family: 'citation_expansion',
        ok: false,
        reason: error?.name === 'AbortError' ? 'timeout' : truncate(error?.message || 'request-failed', 200),
        candidates: []
      });
    }
  }

  if (isOpenAlexRelatedExpansionEnabled(params)) {
    for (const seed of seeds) {
      const lookup = getOpenAlexSeedLookup(seed);
      if (!lookup) continue;
      const queryId = `openalex-related-${stableHash(seed.canonicalId || seed.id || seed.title || lookup.query, 8)}`;
      try {
        const seedCandidates = await fetchOpenAlexRelatedCandidates(seed, params);
        openAlexRelatedCandidates.push(...seedCandidates);
        expandedCandidates.push(...seedCandidates);
        queryResults.push({
          provider: 'openalex_related',
          queryId,
          query: lookup.query,
          family: 'related_work_similarity',
          ok: true,
          count: seedCandidates.length,
          candidates: seedCandidates.map((candidate) => candidate.id)
        });
      } catch (error) {
        queryResults.push({
          provider: 'openalex_related',
          queryId,
          query: lookup.query,
          family: 'related_work_similarity',
          ok: false,
          reason: error?.name === 'AbortError' ? 'timeout' : truncate(error?.message || 'request-failed', 200),
          candidates: []
        });
      }
    }
  }

  return {
    candidates: expandedCandidates,
    queryResults,
    summary: {
      seeds: seeds.length,
      addedCandidates: expandedCandidates.length,
      failedSeeds: queryResults.filter((entry) => !entry.ok).length,
      semanticScholarAddedCandidates: semanticScholarCandidates.length,
      openAlexRelatedAddedCandidates: openAlexRelatedCandidates.length
    }
  };
}
