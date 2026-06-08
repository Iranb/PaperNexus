function pickDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function resolveLlmBatchConcurrency(options = {}) {
  const explicit = Number(pickDefined(
    options.llmBatchConcurrency,
    options.batchConcurrency,
    options.llmConcurrency,
    process.env.PAPERNEXUS_LLM_BATCH_CONCURRENCY
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }
  return 1;
}

export function resolveLlmBatchSliceTimeoutMs(options = {}) {
  const explicit = Number(pickDefined(
    options.llmBatchSliceTimeoutMs,
    options.llmSliceTimeoutMs,
    options.sliceTimeoutMs,
    options.llmBatchTimeoutMs,
    process.env.PAPERNEXUS_LLM_BATCH_SLICE_TIMEOUT_MS
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return 0;
}

export function createLlmBatchSlices(items = [], batchSize = 1) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeBatchSize = Math.max(1, Math.floor(Number(batchSize || 1)));
  const batches = [];
  for (let start = 0; start < safeItems.length; start += safeBatchSize) {
    batches.push({
      start,
      batchNumber: Math.floor(start / safeBatchSize) + 1,
      batch: safeItems.slice(start, start + safeBatchSize)
    });
  }
  const totalBatches = Math.max(1, batches.length);
  return batches.map((batch) => ({
    ...batch,
    totalBatches
  }));
}

export function getFutureIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

export function getLlmResultRateLimitCooldownUntil(value = null, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  const direct = getFutureIsoTimestamp(value.rateLimitCooldownUntil);
  if (direct) return direct;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getLlmResultRateLimitCooldownUntil(item, seen);
      if (nested) return nested;
    }
    return null;
  }

  for (const key of [
    'semanticBatchResults',
    'relationBatchResults',
    'batchResults',
    'results',
    'result',
    'semanticResult',
    'relationResult',
    'semanticObjects',
    'inference',
    'llmSemanticObjects',
    'llm'
  ]) {
    const nested = getLlmResultRateLimitCooldownUntil(value[key], seen);
    if (nested) return nested;
  }

  return null;
}

export function createLlmBatchSliceTimeoutError(timeoutMs, item = null, index = -1) {
  const error = new Error(`LLM batch slice timed out after ${timeoutMs}ms`);
  error.name = 'LlmBatchSliceTimeoutError';
  error.reason = 'provider-timeout';
  error.timeoutMs = timeoutMs;
  error.item = item;
  error.itemIndex = index;
  return error;
}

async function runWithOptionalSliceDeadline(work, options = {}, item = null, index = -1) {
  const timeoutMs = resolveLlmBatchSliceTimeoutMs(options);
  if (!timeoutMs) {
    return work();
  }

  const pending = Promise.resolve().then(work);
  let timeoutHandle = null;
  const timeoutMarker = Symbol('llm-batch-slice-timeout');
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeoutMarker), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([pending, timeout]);
  } catch (error) {
    clearTimeout(timeoutHandle);
    throw error;
  }
  if (result !== timeoutMarker) {
    clearTimeout(timeoutHandle);
    return result;
  }

  pending.catch(() => {});
  if (typeof options.createTimeoutResult === 'function') {
    return options.createTimeoutResult(item, timeoutMs, index);
  }
  throw createLlmBatchSliceTimeoutError(timeoutMs, item, index);
}

export async function runLlmBatchWorkerPool(items = [], options = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  if (typeof options.iteratee !== 'function') {
    throw new Error('runLlmBatchWorkerPool requires an iteratee function.');
  }

  const results = new Array(items.length);
  const workerCount = Math.min(
    Math.max(1, Math.floor(Number(options.concurrency || 1))),
    items.length
  );
  const detectRateLimitCooldownUntil = typeof options.detectRateLimitCooldownUntil === 'function'
    ? options.detectRateLimitCooldownUntil
    : getLlmResultRateLimitCooldownUntil;
  let nextIndex = 0;
  let rateLimitCooldownUntil = null;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      const cooldownUntil = getFutureIsoTimestamp(rateLimitCooldownUntil);
      if (cooldownUntil) {
        results[currentIndex] = await options.createSkippedResult(items[currentIndex], cooldownUntil, currentIndex);
        continue;
      }

      const result = await runWithOptionalSliceDeadline(
        () => options.iteratee(items[currentIndex], currentIndex),
        options,
        items[currentIndex],
        currentIndex
      );
      results[currentIndex] = result;
      const detectedCooldownUntil = detectRateLimitCooldownUntil(result);
      if (detectedCooldownUntil && !getFutureIsoTimestamp(rateLimitCooldownUntil)) {
        rateLimitCooldownUntil = detectedCooldownUntil;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function mapLlmBatchSlicesWithRateLimitStop(items, concurrency, iteratee, createSkippedResult, options = {}) {
  return runLlmBatchWorkerPool(items, {
    ...options,
    concurrency,
    iteratee,
    createSkippedResult
  });
}
