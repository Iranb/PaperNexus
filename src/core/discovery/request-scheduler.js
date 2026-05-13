import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableHash } from '../../lib/utils.js';

const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 0;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_SEMANTIC_SCHOLAR_MAX_CONCURRENT = 1;
const MAX_PROVIDER_REQUEST_CONCURRENT = 16;
const DEFAULT_RESPONSE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const DISK_CACHE_VERSION = 1;
const RETRYABLE_FAILURE_STATUSES = new Set([0, 429, 500, 502, 503, 504]);

const providerLimiters = new Map();
const inFlightRequests = new Map();
const memoryCache = new Map();
const providerCircuitBreakers = new Map();
const requestStats = {
  totals: createRequestCounters(),
  byProvider: new Map()
};

function createRequestCounters() {
  return {
    total: 0,
    cacheDisabled: 0,
    cacheMisses: 0,
    cacheHits: 0,
    cacheMemoryHits: 0,
    cacheDiskHits: 0,
    networkRequests: 0,
    networkErrors: 0,
    cacheWrites: 0,
    inFlightHits: 0,
    circuitBreakerHits: 0
  };
}

function resetRequestCounters(target) {
  const empty = createRequestCounters();
  for (const key of Object.keys(empty)) {
    target[key] = empty[key];
  }
}

function providerRequestCounters(provider) {
  const normalized = normalizeProviderName(provider);
  if (!requestStats.byProvider.has(normalized)) {
    requestStats.byProvider.set(normalized, createRequestCounters());
  }
  return requestStats.byProvider.get(normalized);
}

function incrementRequestStat(provider, field, amount = 1) {
  const increment = Math.max(0, Number(amount) || 0);
  if (!field || !increment) return;
  requestStats.totals[field] = (requestStats.totals[field] || 0) + increment;
  const providerCounters = providerRequestCounters(provider);
  providerCounters[field] = (providerCounters[field] || 0) + increment;
}

function snapshotRequestStats() {
  return {
    ...requestStats.totals,
    byProvider: [...requestStats.byProvider.entries()]
      .map(([provider, counters]) => ({
        provider,
        ...counters
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
  };
}

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

function toBoundedPositiveInteger(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function resolvePathWithHome(value = '') {
  const configured = String(value || '').trim();
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function resolvePapernexusHome() {
  const configured = String(process.env.PAPERNEXUS_HOME || '').trim();
  return configured ? resolvePathWithHome(configured) : path.join(os.homedir(), '.papernexus');
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
    return toBoundedPositiveInteger(
      config.semanticScholarMaxConcurrent
      ?? config.semantic_scholar_max_concurrent,
      DEFAULT_SEMANTIC_SCHOLAR_MAX_CONCURRENT,
      MAX_PROVIDER_REQUEST_CONCURRENT
    );
  }

  if (provider === 'openalex') {
    return toBoundedPositiveInteger(
      config.openAlexMaxConcurrent
      ?? config.openalexMaxConcurrent
      ?? config.openalex_max_concurrent
      ?? process.env.PAPERNEXUS_OPENALEX_MAX_CONCURRENT,
      DEFAULT_MAX_CONCURRENT,
      MAX_PROVIDER_REQUEST_CONCURRENT
    );
  }

  return toBoundedPositiveInteger(
    config.providerRequestMaxConcurrent,
    DEFAULT_MAX_CONCURRENT,
    MAX_PROVIDER_REQUEST_CONCURRENT
  );
}

function resolveResponseBodyLimitBytes(config = {}, options = {}) {
  return toBoundedPositiveInteger(
    options.maxResponseBytes
    ?? options.max_response_bytes
    ?? config.discoveryRequestMaxResponseBytes
    ?? config.discovery_request_max_response_bytes
    ?? process.env.PAPERNEXUS_DISCOVERY_REQUEST_MAX_RESPONSE_BYTES,
    DEFAULT_RESPONSE_BODY_LIMIT_BYTES,
    MAX_RESPONSE_BODY_LIMIT_BYTES
  );
}

function createResponseBodyLimitError(maxBytes) {
  const error = new Error(`response-too-large: response exceeds the configured limit of ${maxBytes} bytes`);
  error.name = 'ResponseTooLargeError';
  return error;
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

function resolveFailureCacheTtlMs(provider, config = {}, options = {}, successTtlMs = 0) {
  const configured = options.failureCacheTtlMs
    ?? options.failure_cache_ttl_ms
    ?? config.discoveryRequestFailureCacheTtlMs
    ?? config.discovery_request_failure_cache_ttl_ms
    ?? (provider === 'semantic_scholar' ? config.semanticScholarFailureCacheTtlMs : undefined)
    ?? (provider === 'openalex' ? config.openAlexFailureCacheTtlMs : undefined)
    ?? process.env.PAPERNEXUS_DISCOVERY_FAILURE_CACHE_TTL_MS;
  if (configured !== undefined) return toNonNegativeInteger(configured, 0);
  return successTtlMs > 0 ? Math.min(successTtlMs, DEFAULT_FAILURE_CACHE_TTL_MS) : 0;
}

function resolveDiscoveryCacheDir(config = {}, options = {}) {
  const configured = String(
    options.cacheDir
    || options.discoveryRequestCacheDir
    || options.discovery_request_cache_dir
    || config.discoveryRequestCacheDir
    || config.discovery_request_cache_dir
    || process.env.PAPERNEXUS_DISCOVERY_CACHE_DIR
    || ''
  ).trim();
  return configured
    ? resolvePathWithHome(configured)
    : path.join(resolvePapernexusHome(), 'cache', 'discovery-request-cache');
}

function cacheEnabled(config = {}, options = {}) {
  if (options.cache === false || config.discoveryRequestCache === false) return false;
  if (options.cache === true || config.discoveryRequestCache === true) return true;
  return resolveCacheTtlMs(options.provider || 'generic', config, options) > 0;
}

function resolveCircuitBreakerThreshold(config = {}, options = {}) {
  return toPositiveInteger(
    options.circuitBreakerFailureThreshold
    ?? options.circuit_breaker_failure_threshold
    ?? config.discoveryCircuitBreakerFailureThreshold
    ?? config.discovery_circuit_breaker_failure_threshold
    ?? process.env.PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD
  );
}

function resolveCircuitBreakerCooldownMs(config = {}, options = {}) {
  return toNonNegativeInteger(
    options.circuitBreakerCooldownMs
    ?? options.circuit_breaker_cooldown_ms
    ?? config.discoveryCircuitBreakerCooldownMs
    ?? config.discovery_circuit_breaker_cooldown_ms
    ?? process.env.PAPERNEXUS_DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS,
    DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS
  );
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

async function readLimitedSnapshotBody(response, maxBytes) {
  const contentLength = Number(getHeaderValue(response.headers, 'content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw createResponseBodyLimitError(maxBytes);
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          throw createResponseBodyLimitError(maxBytes);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      try {
        await reader.cancel?.();
      } catch {}
      throw error;
    }
    return Buffer.concat(chunks);
  }

  if (typeof response.arrayBuffer === 'function') {
    const arrayBuffer = await response.arrayBuffer();
    const body = Buffer.from(arrayBuffer);
    if (body.length > maxBytes) throw createResponseBodyLimitError(maxBytes);
    return body;
  }
  if (typeof response.text === 'function') {
    const body = Buffer.from(await response.text());
    if (body.length > maxBytes) throw createResponseBodyLimitError(maxBytes);
    return body;
  }
  if (typeof response.json === 'function') {
    const body = Buffer.from(JSON.stringify(await response.json()));
    if (body.length > maxBytes) throw createResponseBodyLimitError(maxBytes);
    return body;
  }

  return Buffer.alloc(0);
}

async function snapshotResponse(response, options = {}) {
  const body = await readLimitedSnapshotBody(response, options.maxBytes || DEFAULT_RESPONSE_BODY_LIMIT_BYTES);

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
  const headerEntries = Array.isArray(snapshot.headers) ? snapshot.headers : headersToEntries(snapshot.headers);
  return {
    ok: snapshot.ok,
    status: snapshot.status,
    statusText: snapshot.statusText,
    url: snapshot.url,
    headers: createHeadersFacade(headerEntries),
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

function serializeSnapshot(snapshot = {}) {
  return {
    ok: Boolean(snapshot.ok),
    status: Number(snapshot.status || 0),
    statusText: snapshot.statusText || '',
    url: snapshot.url || '',
    headers: headersToEntries(snapshot.headers),
    bodyBase64: Buffer.from(snapshot.body || []).toString('base64')
  };
}

function deserializeSnapshot(value = {}) {
  return {
    ok: Boolean(value.ok),
    status: Number(value.status || 0),
    statusText: value.statusText || '',
    url: value.url || '',
    headers: createHeadersFacade(Array.isArray(value.headers) ? value.headers : []),
    body: Buffer.from(String(value.bodyBase64 || ''), 'base64')
  };
}

function cacheFilePath(cacheDir, provider, requestKey) {
  const hash = stableHash(requestKey, 32);
  return path.join(cacheDir, normalizeProviderName(provider), hash.slice(0, 2), `${hash}.json`);
}

function cacheTtlForSnapshot(snapshot = {}, cacheConfig = {}) {
  if (snapshot.ok) return cacheConfig.successTtlMs;
  const status = Number(snapshot.status || 0);
  return RETRYABLE_FAILURE_STATUSES.has(status) ? cacheConfig.failureTtlMs : 0;
}

async function readDiskCachedSnapshot(cacheConfig = {}) {
  if (!cacheConfig.enabled || !cacheConfig.cacheDir) return null;
  const filePath = cacheFilePath(cacheConfig.cacheDir, cacheConfig.provider, cacheConfig.requestKey);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!parsed || parsed.version !== DISK_CACHE_VERSION || parsed.expiresAt <= Date.now()) return null;
    const snapshot = deserializeSnapshot(parsed.snapshot || {});
    memoryCache.set(cacheConfig.requestKey, {
      expiresAt: parsed.expiresAt,
      snapshot
    });
    return {
      snapshot,
      source: 'disk'
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function writeDiskCachedSnapshot(snapshot = {}, cacheConfig = {}, ttlMs = 0) {
  if (!cacheConfig.enabled || !cacheConfig.cacheDir || ttlMs <= 0) return;
  const filePath = cacheFilePath(cacheConfig.cacheDir, cacheConfig.provider, cacheConfig.requestKey);
  const payload = {
    version: DISK_CACHE_VERSION,
    provider: cacheConfig.provider,
    keyHash: stableHash(cacheConfig.requestKey, 32),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    snapshot: serializeSnapshot(snapshot)
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
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

async function getCachedSnapshot(key, cacheConfig = {}) {
  const cached = memoryCache.get(key);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return {
        snapshot: cached.snapshot,
        source: 'memory'
      };
    }
    memoryCache.delete(key);
  }
  return readDiskCachedSnapshot(cacheConfig);
}

async function setCachedSnapshot(key, snapshot, cacheConfig = {}) {
  const ttlMs = cacheTtlForSnapshot(snapshot, cacheConfig);
  if (!ttlMs || ttlMs <= 0) return;
  memoryCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    snapshot
  });
  try {
    await writeDiskCachedSnapshot(snapshot, cacheConfig, ttlMs);
  } catch {
    // Cache writes must not break live discovery or batch ingestion.
  }
}

function isRetryableFailureSnapshot(snapshot = {}) {
  return RETRYABLE_FAILURE_STATUSES.has(Number(snapshot.status || 0));
}

function providerCircuitBreakerState(provider) {
  const normalized = normalizeProviderName(provider);
  if (!providerCircuitBreakers.has(normalized)) {
    providerCircuitBreakers.set(normalized, {
      failureCount: 0,
      openedUntil: 0,
      lastFailureAt: 0,
      lastReason: ''
    });
  }
  return providerCircuitBreakers.get(normalized);
}

function activeCircuitBreaker(provider) {
  const state = providerCircuitBreakers.get(normalizeProviderName(provider));
  if (!state || state.openedUntil <= Date.now()) return null;
  return state;
}

function recordProviderSuccess(provider) {
  providerCircuitBreakers.delete(normalizeProviderName(provider));
}

function recordProviderFailure(provider, config = {}, options = {}, reason = '') {
  const threshold = resolveCircuitBreakerThreshold(config, options);
  const cooldownMs = resolveCircuitBreakerCooldownMs(config, options);
  if (cooldownMs <= 0) return null;
  const state = providerCircuitBreakerState(provider);
  state.failureCount += 1;
  state.lastFailureAt = Date.now();
  state.lastReason = reason;
  if (state.failureCount >= threshold) {
    state.openedUntil = Date.now() + cooldownMs;
  }
  return state;
}

function createCircuitBreakerSnapshot(provider, state = {}) {
  return {
    ok: false,
    status: 503,
    statusText: 'provider circuit breaker open',
    url: '',
    headers: createHeadersFacade([
      ['content-type', 'application/json'],
      ['x-papernexus-provider-circuit-open', 'true']
    ]),
    body: Buffer.from(JSON.stringify({
      error: 'provider-circuit-breaker-open',
      provider,
      retryAfterMs: Math.max(0, Number(state.openedUntil || 0) - Date.now()),
      reason: state.lastReason || 'provider failures exceeded threshold'
    }))
  };
}

export async function scheduleDiscoveryFetch(input, config = {}, headers = {}, options = {}) {
  const provider = normalizeProviderName(options.provider || inferProviderFromUrl(input));
  const requestKey = options.cacheKey || buildRequestKey(input, headers, { ...options, provider });
  const ttlMs = resolveCacheTtlMs(provider, config, { ...options, provider });
  const shouldCache = cacheEnabled(config, { ...options, provider, cacheTtlMs: ttlMs });
  incrementRequestStat(provider, 'total');
  const cacheConfig = {
    enabled: shouldCache,
    provider,
    requestKey,
    cacheDir: resolveDiscoveryCacheDir(config, options),
    successTtlMs: ttlMs,
    failureTtlMs: shouldCache ? resolveFailureCacheTtlMs(provider, config, options, ttlMs) : 0
  };

  if (shouldCache) {
    const cached = await getCachedSnapshot(requestKey, cacheConfig);
    if (cached?.snapshot) {
      incrementRequestStat(provider, 'cacheHits');
      incrementRequestStat(provider, cached.source === 'disk' ? 'cacheDiskHits' : 'cacheMemoryHits');
      return cloneSnapshot(cached.snapshot);
    }
    incrementRequestStat(provider, 'cacheMisses');
  } else {
    incrementRequestStat(provider, 'cacheDisabled');
  }

  const circuitState = activeCircuitBreaker(provider);
  if (circuitState) {
    incrementRequestStat(provider, 'circuitBreakerHits');
    return cloneSnapshot(createCircuitBreakerSnapshot(provider, circuitState));
  }

  if (inFlightRequests.has(requestKey)) {
    incrementRequestStat(provider, 'inFlightHits');
    return cloneSnapshot(await inFlightRequests.get(requestKey));
  }

  const requestPromise = (async () => {
    const limiter = getLimiter(provider);
    const maxConcurrent = resolveProviderMaxConcurrent(provider, config);
    const delayMs = resolveProviderDelayMs(provider, config, headers);
    await acquireSlot(limiter, maxConcurrent);
    try {
      await waitForProviderStart(limiter, delayMs);
      incrementRequestStat(provider, 'networkRequests');
      const response = await runRawFetch(input, config, headers);
      const snapshot = await snapshotResponse(response, {
        maxBytes: resolveResponseBodyLimitBytes(config, options)
      });
      if (snapshot.ok) {
        recordProviderSuccess(provider);
      } else if (isRetryableFailureSnapshot(snapshot)) {
        recordProviderFailure(provider, config, options, `http-${snapshot.status}`);
      }
      const cacheWriteEligible = cacheTtlForSnapshot(snapshot, cacheConfig) > 0;
      await setCachedSnapshot(requestKey, snapshot, cacheConfig);
      if (cacheWriteEligible) incrementRequestStat(provider, 'cacheWrites');
      return snapshot;
    } catch (error) {
      incrementRequestStat(provider, 'networkErrors');
      recordProviderFailure(provider, config, options, error?.name || error?.message || 'fetch-error');
      throw error;
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
  providerCircuitBreakers.clear();
  resetRequestCounters(requestStats.totals);
  requestStats.byProvider.clear();
}

export function readDiscoveryRequestSchedulerState() {
  return {
    providers: [...providerLimiters.keys()],
    inFlightCount: inFlightRequests.size,
    cacheEntries: memoryCache.size,
    requestStats: snapshotRequestStats(),
    circuitBreakers: [...providerCircuitBreakers.entries()].map(([provider, state]) => ({
      provider,
      failureCount: state.failureCount,
      openedUntil: state.openedUntil,
      lastFailureAt: state.lastFailureAt,
      lastReason: state.lastReason,
      open: state.openedUntil > Date.now()
    }))
  };
}
