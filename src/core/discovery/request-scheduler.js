import { stableHash } from '../../lib/utils.js';

const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_SEMANTIC_SCHOLAR_MAX_CONCURRENT = 1;

const providerLimiters = new Map();
const inFlightRequests = new Map();
const memoryCache = new Map();

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function normalizeProviderName(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (normalized === 's2' || normalized === 'semanticscholar') return 'semantic_scholar';
  if (normalized === 'open_alex') return 'openalex';
  return normalized || 'generic';
}

function inferProviderFromUrl(input) {
  try {
    const hostname = new URL(String(input)).hostname.toLowerCase();
    if (hostname === 'api.openalex.org') return 'openalex';
    if (hostname === 'api.semanticscholar.org') return 'semantic_scholar';
    if (hostname === 'api.crossref.org') return 'crossref';
    if (hostname === 'export.arxiv.org') return 'arxiv';
    if (hostname === 'dblp.org') return 'dblp';
    if (hostname === 'api.core.ac.uk') return 'core';
    if (hostname.includes('europepmc')) return 'europe_pmc';
    return hostname || 'generic';
  } catch {
    return 'generic';
  }
}

function hasHeader(headers = {}, headerName = '') {
  const normalized = headerName.toLowerCase();
  return Object.entries(headers || {}).some(([key, value]) => (
    String(key || '').toLowerCase() === normalized
    && String(value || '').trim()
  ));
}

function resolveProviderDelayMs(provider, config = {}, headers = {}) {
  if (provider === 'semantic_scholar') {
    if (!hasHeader(headers, 'x-api-key')) return 0;
    return toNonNegativeInteger(
      config.semanticScholarRequestDelayMs
      ?? config.semantic_scholar_request_delay_ms
      ?? config.s2RequestDelayMs
      ?? config.s2_request_delay_ms
      ?? process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS
      ?? process.env.PAPERNEXUS_S2_REQUEST_DELAY_MS
      ?? process.env.S2_REQUEST_DELAY_MS,
      0
    );
  }

  if (provider === 'openalex') {
    return toNonNegativeInteger(
      config.openAlexRequestDelayMs
      ?? config.openalexRequestDelayMs
      ?? config.openalex_request_delay_ms
      ?? process.env.PAPERNEXUS_OPENALEX_REQUEST_DELAY_MS,
      0
    );
  }

  return toNonNegativeInteger(config.providerRequestSchedulerDelayMs, 0);
}

function resolveProviderMaxConcurrent(provider, config = {}) {
  if (provider === 'semantic_scholar') {
    return toPositiveInteger(
      config.semanticScholarMaxConcurrent
      ?? config.semantic_scholar_max_concurrent,
      DEFAULT_SEMANTIC_SCHOLAR_MAX_CONCURRENT
    );
  }

  if (provider === 'openalex') {
    return toPositiveInteger(
      config.openAlexMaxConcurrent
      ?? config.openalexMaxConcurrent
      ?? config.openalex_max_concurrent
      ?? process.env.PAPERNEXUS_OPENALEX_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT
    );
  }

  return toPositiveInteger(config.providerRequestMaxConcurrent, DEFAULT_MAX_CONCURRENT);
}

function resolveCacheTtlMs(provider, config = {}, options = {}) {
  if (options.cacheTtlMs !== undefined) return toNonNegativeInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
  if (config.discoveryRequestCacheTtlMs !== undefined) return toNonNegativeInteger(config.discoveryRequestCacheTtlMs, DEFAULT_CACHE_TTL_MS);
  if (config.discovery_request_cache_ttl_ms !== undefined) return toNonNegativeInteger(config.discovery_request_cache_ttl_ms, DEFAULT_CACHE_TTL_MS);
  if (provider === 'semantic_scholar' && config.semanticScholarCacheTtlMs !== undefined) {
    return toNonNegativeInteger(config.semanticScholarCacheTtlMs, DEFAULT_CACHE_TTL_MS);
  }
  if (provider === 'openalex' && config.openAlexCacheTtlMs !== undefined) {
    return toNonNegativeInteger(config.openAlexCacheTtlMs, DEFAULT_CACHE_TTL_MS);
  }
  return toNonNegativeInteger(process.env.PAPERNEXUS_DISCOVERY_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
}

function cacheEnabled(config = {}, options = {}) {
  if (options.cache === false || config.discoveryRequestCache === false) return false;
  if (options.cache === true || config.discoveryRequestCache === true) return true;
  return resolveCacheTtlMs(options.provider || 'generic', config, options) > 0;
}

function normalizeUrlForCache(input) {
  try {
    const url = new URL(String(input));
    url.hash = '';
    return url.toString();
  } catch {
    return String(input);
  }
}

function headersCachePart(headers = {}) {
  const relevant = {};
  if (hasHeader(headers, 'x-api-key')) {
    const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'x-api-key');
    relevant['x-api-key'] = `sha1:${stableHash(entry?.[1] || '', 10)}`;
  }
  if (hasHeader(headers, 'accept')) {
    const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'accept');
    relevant.accept = String(entry?.[1] || '').trim();
  }
  return JSON.stringify(relevant);
}

function buildRequestKey(input, headers = {}, options = {}) {
  return [
    normalizeProviderName(options.provider || inferProviderFromUrl(input)),
    options.endpoint || 'GET',
    normalizeUrlForCache(input),
    headersCachePart(headers)
  ].join(':');
}

function getLimiter(provider) {
  const normalized = normalizeProviderName(provider);
  if (!providerLimiters.has(normalized)) {
    providerLimiters.set(normalized, {
      active: 0,
      waiters: [],
      startQueue: Promise.resolve(),
      nextStartAt: 0
    });
  }
  return providerLimiters.get(normalized);
}

async function acquireSlot(limiter, maxConcurrent) {
  if (limiter.active < maxConcurrent) {
    limiter.active += 1;
    return;
  }

  await new Promise((resolve) => {
    limiter.waiters.push(resolve);
  });
  limiter.active += 1;
}

function releaseSlot(limiter) {
  limiter.active = Math.max(0, limiter.active - 1);
  const next = limiter.waiters.shift();
  if (next) next();
}

async function waitForProviderStart(limiter, delayMs) {
  const previous = limiter.startQueue;
  let release = () => {};
  limiter.startQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    const waitMs = Math.max(0, limiter.nextStartAt - Date.now());
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    limiter.nextStartAt = Date.now() + Math.max(0, delayMs);
  } finally {
    release();
  }
}

function getHeaderValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === name.toLowerCase());
  return entry ? entry[1] : null;
}

function headersToEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()];
  if (headers instanceof Map) return [...headers.entries()];
  if (typeof headers.get === 'function') {
    return [
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'x-ratelimit-credits-used'
    ]
      .map((name) => [name, headers.get(name)])
      .filter(([, value]) => value !== undefined && value !== null);
  }
  return Object.entries(headers);
}

function createHeadersFacade(entries = []) {
  const normalized = new Map(entries.map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  return {
    get(name) {
      return normalized.get(String(name || '').toLowerCase()) || null;
    },
    entries() {
      return normalized.entries();
    },
    [Symbol.iterator]() {
      return normalized[Symbol.iterator]();
    }
  };
}

async function snapshotResponse(response) {
  let body = Buffer.alloc(0);
  if (typeof response.arrayBuffer === 'function') {
    const arrayBuffer = await response.arrayBuffer();
    body = Buffer.from(arrayBuffer);
  } else if (typeof response.text === 'function') {
    body = Buffer.from(await response.text());
  } else if (typeof response.json === 'function') {
    body = Buffer.from(JSON.stringify(await response.json()));
  }

  return {
    ok: Boolean(response.ok),
    status: Number(response.status || 0),
    statusText: response.statusText || '',
    url: response.url || '',
    headers: headersToEntries(response.headers),
    body
  };
}

function cloneSnapshot(snapshot) {
  const body = Buffer.from(snapshot.body || []);
  return {
    ok: snapshot.ok,
    status: snapshot.status,
    statusText: snapshot.statusText,
    url: snapshot.url,
    headers: createHeadersFacade(snapshot.headers),
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
    async text() {
      return body.toString('utf8');
    },
    async json() {
      const text = body.toString('utf8').trim();
      return text ? JSON.parse(text) : {};
    }
  };
}

async function runRawFetch(input, config = {}, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
  try {
    return await fetch(input, {
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent || 'PaperNexus/0.1 literature-discovery',
        ...headers
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getCachedSnapshot(key) {
  const cached = memoryCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return cached.snapshot;
}

function setCachedSnapshot(key, snapshot, ttlMs) {
  if (!ttlMs || ttlMs <= 0 || !snapshot.ok) return;
  memoryCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    snapshot
  });
}

export async function scheduleDiscoveryFetch(input, config = {}, headers = {}, options = {}) {
  const provider = normalizeProviderName(options.provider || inferProviderFromUrl(input));
  const requestKey = options.cacheKey || buildRequestKey(input, headers, { ...options, provider });
  const ttlMs = resolveCacheTtlMs(provider, config, { ...options, provider });
  const shouldCache = cacheEnabled(config, { ...options, provider, cacheTtlMs: ttlMs });

  if (shouldCache) {
    const cached = getCachedSnapshot(requestKey);
    if (cached) return cloneSnapshot(cached);
  }

  if (inFlightRequests.has(requestKey)) {
    return cloneSnapshot(await inFlightRequests.get(requestKey));
  }

  const requestPromise = (async () => {
    const limiter = getLimiter(provider);
    const maxConcurrent = resolveProviderMaxConcurrent(provider, config);
    const delayMs = resolveProviderDelayMs(provider, config, headers);
    await acquireSlot(limiter, maxConcurrent);
    try {
      await waitForProviderStart(limiter, delayMs);
      const response = await runRawFetch(input, config, headers);
      const snapshot = await snapshotResponse(response);
      setCachedSnapshot(requestKey, snapshot, ttlMs);
      return snapshot;
    } finally {
      releaseSlot(limiter);
    }
  })();

  inFlightRequests.set(requestKey, requestPromise);
  try {
    return cloneSnapshot(await requestPromise);
  } finally {
    inFlightRequests.delete(requestKey);
  }
}

export function resetDiscoveryRequestSchedulerForTests() {
  providerLimiters.clear();
  inFlightRequests.clear();
  memoryCache.clear();
}

export function readDiscoveryRequestSchedulerState() {
  return {
    providers: [...providerLimiters.keys()],
    inFlightCount: inFlightRequests.size,
    cacheEntries: memoryCache.size
  };
}
