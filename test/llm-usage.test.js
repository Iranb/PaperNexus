import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateResearchJson, inferPaperSemanticObjectsBatch, inferPaperResearchSemanticsBatch } from '../src/core/llm/ollama.js';
import { normalizeLlmUsage, readLlmUsage } from '../src/core/llm/usage.js';

test('usage distinguishes cached input and reasoning subsets across providers', () => {
  const openai = normalizeLlmUsage({ usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 150 } } }, 'openai');
  assert.equal(openai.inputTokens, 1000); assert.equal(openai.totalTokens, 1200); assert.equal(openai.reasoningTokens, 150);
  const anthropic = normalizeLlmUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 600,
    cache_creation_input_tokens: 300, output_tokens: 200 } }, 'anthropic');
  assert.equal(anthropic.inputTokens, 1000); assert.equal(anthropic.totalTokens, 1200);
  const ollama = normalizeLlmUsage({ prompt_eval_count: 400, eval_count: 50 }, 'ollama');
  assert.equal(ollama.totalTokens, 450); assert.equal(ollama.cachedInputTokens, null);
  assert.equal(normalizeLlmUsage({}).totalTokens, null);
});

test('empty JSON recovery records both provider responses without treating missing usage as zero', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-usage-retry-'));
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => {
    calls++;
    return { id: 'r' + calls, model: 'fixture', ...(calls === 1 ? { usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } } : {}),
      choices: [{ finish_reason: 'stop', message: { content: calls === 1 ? '' : '{"ok":true}' } }] };
  } });
  try {
    await generateResearchJson('Return JSON.', { llmProvider: 'deepseek', llmModel: 'fixture', llmApiKey: 'fixture-key',
      llmBatchLedgerDir: directory, llmBatchRunId: 'retry' });
    const summary = await readLlmUsage(directory);
    assert.equal(summary.requests, 2); assert.equal(summary.totalTokens, 1100);
    assert.equal(summary.reportedRequests, 1); assert.equal(summary.unreportedRequests, 1); assert.equal(summary.complete, false);
    assert.equal(summary.byPhase['lineage-extraction'].requests, 2);
    assert.doesNotMatch(await fs.readFile(path.join(directory, 'llm-usage.jsonl'), 'utf8'), /fixture-key|Return JSON/);
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});

test('existing extraction phases persist usage and completed batch reuse adds no provider usage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-usage-phases-'));
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ model: 'fixture', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ papers: [{ id: 'p1', methods: [], problems: [], relations: [] }] }) } }] }) };
  };
  const entries = [{ id: 'p1', parsedPaper: { title: 'Full text', sections: [{ heading: 'Method', role: 'method', text: 'Evidence.' }] },
    semanticPaper: { methods: [], problems: [] } }];
  const options = { semanticExtraction: 'llm-primary', llmProvider: 'deepseek', llmModel: 'fixture', llmApiKey: 'fixture-key', llmRelations: true,
    llmBatchLedgerDir: directory, llmBatchRunId: 'phases', llmBatchResume: true, llmBatchFailureSplitRetryCount: 0 };
  try {
    await inferPaperSemanticObjectsBatch(entries, options);
    await inferPaperResearchSemanticsBatch(entries, options);
    assert.equal(calls, 2);
    const summary = await readLlmUsage(directory);
    assert.equal(summary.byPhase['semantic-extraction'].requests, 1);
    assert.equal(summary.byPhase['relation-extraction'].requests, 1); assert.equal(summary.totalTokens, 2200);
    await inferPaperSemanticObjectsBatch(entries, options);
    await inferPaperResearchSemanticsBatch(entries, options);
    assert.equal(calls, 2); assert.equal((await readLlmUsage(directory)).requests, 2);
  } finally { globalThis.fetch = originalFetch; await fs.rm(directory, { recursive: true, force: true }); }
});
