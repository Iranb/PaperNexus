const DEFAULT_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS = 1000;

let nextSemanticScholarRequestAt = 0;
let semanticScholarQueue = Promise.resolve();

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function isSemanticScholarApiUrl(input) {
  try {
    return new URL(String(input)).hostname === 'api.semanticscholar.org';
  } catch {
    return false;
  }
}

export function hasSemanticScholarApiKey(headers = {}) {
  return Object.entries(headers || {}).some(([key, value]) => (
    String(key || '').toLowerCase() === 'x-api-key'
    && String(value || '').trim()
  ));
}

export function resolveSemanticScholarRequestDelayMs(options = {}) {
  return toNonNegativeInteger(
    options.semanticScholarRequestDelayMs
    ?? options.semantic_scholar_request_delay_ms
    ?? options.s2RequestDelayMs
    ?? options.s2_request_delay_ms
    ?? process.env.PAPERNEXUS_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS
    ?? process.env.PAPERNEXUS_S2_REQUEST_DELAY_MS
    ?? process.env.S2_REQUEST_DELAY_MS,
    DEFAULT_SEMANTIC_SCHOLAR_REQUEST_DELAY_MS
  );
}

export async function waitForSemanticScholarRateLimit(options = {}) {
  const delayMs = resolveSemanticScholarRequestDelayMs(options);
  if (delayMs <= 0) return;

  const previous = semanticScholarQueue;
  let release = () => {};
  semanticScholarQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    const waitMs = Math.max(0, nextSemanticScholarRequestAt - Date.now());
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    nextSemanticScholarRequestAt = Date.now() + delayMs;
  } finally {
    release();
  }
}

export function resetSemanticScholarRateLimitForTests() {
  nextSemanticScholarRequestAt = 0;
  semanticScholarQueue = Promise.resolve();
}
