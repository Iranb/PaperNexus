import fs from 'node:fs/promises';
import path from 'node:path';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sumKnown = values => values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;

export function normalizeLlmUsage(payload = {}, provider = '') {
  const usage = payload.usage || {};
  let inputTokens = number(usage.prompt_tokens ?? usage.input_tokens ?? payload.prompt_eval_count);
  const outputTokens = number(usage.completion_tokens ?? usage.output_tokens ?? payload.eval_count);
  const cachedInputTokens = number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
  const cacheWriteInputTokens = number(usage.cache_creation_input_tokens ?? usage.input_tokens_details?.cache_write_tokens);
  if (provider === 'anthropic' && inputTokens !== null) {
    inputTokens += (cachedInputTokens || 0) + (cacheWriteInputTokens || 0);
  }
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens,
    reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens),
    totalTokens: number(usage.total_tokens) ?? sumKnown([inputTokens, outputTokens]) };
}

export async function appendLlmUsage(ledger, event) {
  if (!ledger?.dir) return;
  await fs.mkdir(ledger.dir, { recursive: true });
  await fs.appendFile(path.join(ledger.dir, 'llm-usage.jsonl'), JSON.stringify({
    contractVersion: 'papernexus-llm-usage-v1', runId: ledger.runId, phase: ledger.phase,
    recordedAt: new Date().toISOString(), ...event
  }) + '\n');
}

export function summarizeLlmUsage(events = []) {
  const totals = { requests: events.length, reportedRequests: 0, unreportedRequests: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    reasoningTokens: 0, cacheReportedRequests: 0, failedRequests: 0 };
  const byPhase = {};
  const byModel = {};
  for (const event of events) {
    if (event.status === 'failed') totals.failedRequests++;
    const usage = event.usage || {};
    if (usage.inputTokens == null || usage.outputTokens == null) totals.unreportedRequests++;
    else totals.reportedRequests++;
    if (usage.cachedInputTokens != null) totals.cacheReportedRequests++;
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens']) {
      totals[key] += number(usage[key]) || 0;
    }
    (byPhase[event.phase || 'unknown'] ||= []).push(event);
    (byModel[`${event.provider || 'unknown'}/${event.model || 'unknown'}`] ||= []).push(event);
  }
  const group = values => Object.fromEntries(Object.entries(values).map(([key, rows]) => [key, {
    requests: rows.length, reportedRequests: rows.filter(row => row.usage?.inputTokens != null && row.usage?.outputTokens != null).length,
    inputTokens: rows.reduce((sum, row) => sum + (number(row.usage?.inputTokens) || 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (number(row.usage?.outputTokens) || 0), 0),
    totalTokens: rows.reduce((sum, row) => sum + (number(row.usage?.totalTokens) || 0), 0)
  }]));
  return { ...totals, complete: totals.unreportedRequests === 0, byPhase: group(byPhase), byModel: group(byModel),
    basis: 'Provider-reported tokens. Totals exclude unreported usage and are not a billing statement.' };
}

export async function readLlmUsage(ledgerDirectory) {
  const text = await fs.readFile(path.join(ledgerDirectory, 'llm-usage.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return summarizeLlmUsage(text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
