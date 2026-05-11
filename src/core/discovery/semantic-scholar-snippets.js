import { stableHash, truncate, unique } from '../../lib/utils.js';
import { resolveDiscoveryConfig } from './providers.js';
import { scheduleDiscoveryFetch } from './request-scheduler.js';

export const SEMANTIC_SCHOLAR_SNIPPETS_CONTRACT_VERSION = 'semantic-scholar-snippets-v1';
export const SEMANTIC_SCHOLAR_SNIPPETS_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/snippet/search';
export const SEMANTIC_SCHOLAR_PAPER_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper';

export const S2_FIELDS_OF_STUDY = [
  'Computer Science',
  'Medicine',
  'Chemistry',
  'Biology',
  'Materials Science',
  'Physics',
  'Geology',
  'Psychology',
  'Art',
  'History',
  'Geography',
  'Sociology',
  'Business',
  'Political Science',
  'Economics',
  'Philosophy',
  'Mathematics',
  'Engineering',
  'Environmental Science',
  'Agricultural and Food Sciences',
  'Education',
  'Law',
  'Linguistics'
];

const DEFAULT_SNIPPET_FIELDS = [
  'snippet.text',
  'snippet.snippetKind',
  'snippet.section',
  'snippet.snippetOffset',
  'snippet.annotations.sentences'
].join(',');

const FIELD_ALIASES = new Map([
  ['ai', 'Computer Science'],
  ['artificial intelligence', 'Computer Science'],
  ['computer vision', 'Computer Science'],
  ['cs', 'Computer Science'],
  ['data mining', 'Computer Science'],
  ['database', 'Computer Science'],
  ['databases', 'Computer Science'],
  ['hci', 'Computer Science'],
  ['human ai collaboration', 'Computer Science'],
  ['human-ai collaboration', 'Computer Science'],
  ['human computer interaction', 'Computer Science'],
  ['human-computer interaction', 'Computer Science'],
  ['information retrieval', 'Computer Science'],
  ['machine learning', 'Computer Science'],
  ['natural language processing', 'Computer Science'],
  ['nlp', 'Computer Science'],
  ['software engineering', 'Computer Science'],
  ['biomedicine', 'Medicine'],
  ['biomedical', 'Medicine'],
  ['clinical medicine', 'Medicine'],
  ['health', 'Medicine'],
  ['healthcare', 'Medicine'],
  ['materials', 'Materials Science'],
  ['material science', 'Materials Science'],
  ['earth science', 'Geology'],
  ['earth sciences', 'Geology'],
  ['social science', 'Sociology'],
  ['social sciences', 'Sociology'],
  ['politics', 'Political Science'],
  ['math', 'Mathematics'],
  ['agriculture', 'Agricultural and Food Sciences'],
  ['food science', 'Agricultural and Food Sciences'],
  ['environment', 'Environmental Science'],
  ['environmental sciences', 'Environmental Science'],
  ['legal studies', 'Law'],
  ['language', 'Linguistics']
]);

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value = '') {
  return compactText(value).toLowerCase().replace(/[-_]+/g, ' ');
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function toPositiveInteger(value, fallback, max = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function buildHeaders(config = {}) {
  return config.semanticScholarApiKey
    ? { 'x-api-key': config.semanticScholarApiKey }
    : {};
}

function normalizeExternalIds(externalIds = {}) {
  if (!externalIds || typeof externalIds !== 'object') return {};
  return Object.fromEntries(Object.entries(externalIds).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function normalizeAuthors(value) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === 'string') return compactText(entry);
      return compactText(entry?.name);
    })
    .filter(Boolean);
}

export function normalizeS2FieldOfStudy(value = '') {
  const text = compactText(value);
  if (!text) return '';
  const direct = S2_FIELDS_OF_STUDY.find((field) => field.toLowerCase() === text.toLowerCase());
  if (direct) return direct;
  const alias = FIELD_ALIASES.get(normalizeKey(text));
  if (alias) return alias;
  const contains = S2_FIELDS_OF_STUDY.find((field) => normalizeKey(text).includes(normalizeKey(field)));
  return contains || text;
}

export function normalizeS2FieldsOfStudy(value) {
  return unique(asArray(value)
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => normalizeS2FieldOfStudy(entry))
    .filter(Boolean));
}

export function isDegenerateSnippetText(text = '', title = '') {
  const snippet = compactText(text);
  const paperTitle = compactText(title);
  if (!snippet) return true;
  if (snippet.length < 24) return true;
  return Boolean(paperTitle && snippet.toLowerCase() === paperTitle.toLowerCase());
}

function semanticScholarPaperId(paper = {}) {
  if (paper.paperId) return String(paper.paperId);
  if (paper.corpusId) return `CorpusId:${paper.corpusId}`;
  if (paper.externalIds?.DOI) return `DOI:${paper.externalIds.DOI}`;
  if (paper.externalIds?.ArXiv) return `ARXIV:${paper.externalIds.ArXiv}`;
  if (paper.externalIds?.PubMed) return `PMID:${paper.externalIds.PubMed}`;
  if (paper.externalIds?.PubMedCentral) return `PMCID:${paper.externalIds.PubMedCentral}`;
  return '';
}

function normalizePaper(paper = {}, fallback = {}) {
  const externalIds = normalizeExternalIds(paper.externalIds || fallback.externalIds);
  const corpusId = paper.corpusId ?? fallback.corpusId ?? externalIds.CorpusId ?? '';
  return {
    paperId: paper.paperId || fallback.paperId || '',
    corpusId: corpusId === undefined || corpusId === null ? '' : String(corpusId),
    title: compactText(paper.title || fallback.title),
    authors: normalizeAuthors(paper.authors || fallback.authors),
    year: Number.isFinite(Number(paper.year ?? fallback.year)) ? Number(paper.year ?? fallback.year) : null,
    venue: compactText(paper.venue || fallback.venue),
    url: compactText(paper.url || fallback.url),
    externalIds,
    fieldsOfStudy: normalizeS2FieldsOfStudy(paper.fieldsOfStudy || fallback.fieldsOfStudy),
    isOpenAccess: paper.isOpenAccess ?? fallback.isOpenAccess ?? null,
    openAccessPdf: paper.openAccessPdf || fallback.openAccessPdf || null,
    openAccessInfo: paper.openAccessInfo || fallback.openAccessInfo || null
  };
}

function normalizeSnippetMatch(match = {}, context = {}) {
  const snippet = match.snippet || {};
  const paper = normalizePaper(match.paper || {});
  const text = compactText(snippet.text || '');
  const snippetId = `s2-snippet:${stableHash(JSON.stringify({
    query: context.query,
    field: context.fieldsOfStudy,
    paper: paper.corpusId || paper.paperId || paper.title,
    text
  }), 20)}`;
  return {
    snippetId,
    provider: 'semantic_scholar_snippets',
    query: context.query,
    fieldsOfStudy: context.fieldsOfStudy || [],
    score: Number.isFinite(Number(match.score)) ? Number(match.score) : null,
    text,
    evidenceText: text,
    snippetKind: compactText(snippet.snippetKind || ''),
    section: compactText(snippet.section || ''),
    snippetOffset: snippet.snippetOffset || null,
    annotations: snippet.annotations || null,
    paper,
    degenerate: isDegenerateSnippetText(text, paper.title),
    abstractFallback: false
  };
}

function attachSearchParams(url, params = {}) {
  url.searchParams.set('query', compactText(params.query));
  url.searchParams.set('limit', String(toPositiveInteger(params.limit, 10)));
  url.searchParams.set('fields', compactText(params.fields || DEFAULT_SNIPPET_FIELDS));

  const fieldsOfStudy = normalizeS2FieldsOfStudy(params.fieldsOfStudy || params.fieldOfStudy || params.domain);
  if (fieldsOfStudy.length) url.searchParams.set('fieldsOfStudy', fieldsOfStudy.join(','));

  for (const [inputKey, outputKey] of [
    ['paperIds', 'paperIds'],
    ['authors', 'authors'],
    ['minCitationCount', 'minCitationCount'],
    ['insertedBefore', 'insertedBefore'],
    ['publicationDateOrYear', 'publicationDateOrYear'],
    ['year', 'year'],
    ['venue', 'venue']
  ]) {
    const value = params[inputKey];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(outputKey, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  return fieldsOfStudy;
}

async function fetchJsonWithRetry(input, config = {}, headers = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const retryCount = Math.max(0, Math.floor(Number(config.retryCount ?? 1) || 0));
  const retryBackoffMs = Math.max(0, Math.floor(Number(config.retryBackoffMs ?? 500) || 0));
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = fetchImpl === globalThis.fetch
        ? await scheduleDiscoveryFetch(input, config, headers, {
            provider: 'semantic_scholar',
            endpoint: 'GET'
          })
        : await fetchImpl(input, {
            headers: {
              'user-agent': config.userAgent || 'PaperNexus/0.1 semantic-scholar-snippets',
              ...headers
            }
          });
      if (response.ok) return response.json();
      const text = await response.text().catch(() => '');
      lastError = new Error(`semantic_scholar_snippets http ${response.status}: ${truncate(text, 240)}`);
      if (![429, 500, 502, 503, 504].includes(Number(response.status)) || attempt >= retryCount) break;
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) break;
    }

    if (retryBackoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryBackoffMs * (attempt + 1)));
    }
  }

  throw lastError || new Error('semantic_scholar_snippets request failed');
}

export async function fetchSemanticScholarPaperAbstract(paper, params = {}) {
  const config = resolveDiscoveryConfig(params);
  const paperId = typeof paper === 'string' ? paper : semanticScholarPaperId(paper);
  if (!paperId) return null;

  const url = new URL(`${SEMANTIC_SCHOLAR_PAPER_ENDPOINT}/${encodeURIComponent(paperId)}`);
  url.searchParams.set('fields', [
    'title',
    'abstract',
    'year',
    'venue',
    'url',
    'externalIds',
    'isOpenAccess',
    'openAccessPdf',
    'fieldsOfStudy'
  ].join(','));

  const payload = await fetchJsonWithRetry(url.toString(), config, buildHeaders(config), params);
  const abstract = compactText(payload.abstract || '');
  if (!abstract) return null;
  return {
    abstract,
    paper: normalizePaper(payload, typeof paper === 'object' ? paper : {})
  };
}

async function hydrateDegenerateSnippets(results = [], params = {}) {
  if (params.fallbackToAbstract === false || params.fallback_to_abstract === false) return results;

  const hydrated = [];
  for (const result of results) {
    if (!result.degenerate) {
      hydrated.push(result);
      continue;
    }

    try {
      const fallback = await fetchSemanticScholarPaperAbstract(result.paper, params);
      if (!fallback?.abstract) {
        hydrated.push(result);
        continue;
      }
      hydrated.push({
        ...result,
        text: fallback.abstract,
        evidenceText: fallback.abstract,
        snippetKind: 'abstract',
        section: result.section || 'Abstract',
        paper: normalizePaper(fallback.paper, result.paper),
        degenerate: false,
        abstractFallback: true
      });
    } catch {
      hydrated.push(result);
    }
  }
  return hydrated;
}

export async function searchSemanticScholarSnippets(params = {}) {
  const query = compactText(params.query);
  if (!query) throw new Error('query is required for Semantic Scholar snippet search.');

  const config = resolveDiscoveryConfig(params);
  const url = new URL(params.baseUrl || SEMANTIC_SCHOLAR_SNIPPETS_ENDPOINT);
  const fieldsOfStudy = attachSearchParams(url, params);
  const payload = await fetchJsonWithRetry(url.toString(), config, buildHeaders(config), params);
  const rawResults = Array.isArray(payload.data) ? payload.data : [];
  const normalized = rawResults.map((entry) => normalizeSnippetMatch(entry, {
    query,
    fieldsOfStudy
  }));
  const results = await hydrateDegenerateSnippets(normalized, {
    ...params,
    ...config
  });

  return {
    contractVersion: SEMANTIC_SCHOLAR_SNIPPETS_CONTRACT_VERSION,
    provider: 'semantic_scholar_snippets',
    endpoint: SEMANTIC_SCHOLAR_SNIPPETS_ENDPOINT,
    query,
    fieldsOfStudy,
    limit: toPositiveInteger(params.limit, 10),
    retrievalVersion: payload.retrievalVersion || '',
    resultCount: results.length,
    paperCount: unique(results.map((entry) => entry.paper.corpusId || entry.paper.paperId || entry.paper.title).filter(Boolean)).length,
    abstractFallbackCount: results.filter((entry) => entry.abstractFallback).length,
    results
  };
}
