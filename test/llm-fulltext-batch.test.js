import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPaperSemanticObjectsBatch, inferPaperResearchSemanticsBatch } from '../src/core/llm/ollama.js';

test('long-context extraction includes late evidence and PDF body sections in both phases', async () => {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.messages.map(message => message.content).join('\n'));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ papers: [{
      id: 'p1', problems: [], methods: [], relations: []
    }] }) } }] }) };
  };
  const entries = [{ id: 'p1', parsedPaper: { title: 'Full text', sections: [
    ...Array.from({ length: 9 }, (_, i) => ({ heading: `PDF page ${i + 1}`, role: 'body',
      text: 'Evidence about continual learning. '.repeat(50) })),
    { heading: 'PDF page 10', role: 'body', text: 'Further details. '.repeat(80) + 'LATE_BODY_EVIDENCE' }
  ] }, semanticPaper: { methods: [], problems: [] } }];
  const options = { semanticExtraction: 'llm-primary', llmProvider: 'deepseek',
    llmModel: 'deepseek-flash', llmApiKey: 'test-key', llmRelations: true,
    llmExtractionStrategy: 'long-context-first', llmContextWindowTokens: 1000000,
    llmBatchPromptMaxChars: 1000000, llmBatchFailureSplitRetryCount: 0 };
  try {
    await inferPaperSemanticObjectsBatch(entries, options);
    await inferPaperResearchSemanticsBatch(entries, options);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.ok(prompt.includes('LATE_BODY_EVIDENCE'));
      assert.ok(prompt.includes('PDF page 10'));
      assert.ok(prompt.includes('Evidence about continual learning. '.repeat(30).trim()));
    }
    prompts.length = 0;
    await inferPaperSemanticObjectsBatch(entries, { ...options, llmExtractionStrategy: 'chunk-first' });
    await inferPaperResearchSemanticsBatch(entries, { ...options, llmExtractionStrategy: 'chunk-first' });
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(prompt => !prompt.includes('LATE_BODY_EVIDENCE')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
