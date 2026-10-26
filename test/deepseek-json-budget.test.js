import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPaperSemanticObjects } from '../src/core/llm/ollama.js';

test('DeepSeek Flash returns extraction JSON within a bounded output budget', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const thinkingDisabled = body.thinking?.type === 'disabled';
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            finish_reason: thinkingDisabled ? 'stop' : 'length',
            message: {
              content: thinkingDisabled ? JSON.stringify({ problems: [{
                name: 'catastrophic forgetting', type: 'Problem',
                evidenceText: 'Incremental updates cause catastrophic forgetting.',
                sectionHeading: 'Abstract', sectionRole: 'abstract', confidence: 0.9
              }] }) : '',
              reasoning_content: thinkingDisabled ? '' : 'Output budget exhausted during reasoning.'
            }
          }]
        };
      }
    };
  };
  try {
    const result = await inferPaperSemanticObjects({
      title: 'Class-Incremental Learning',
      sections: [{ heading: 'Abstract', role: 'abstract',
        text: 'Incremental updates cause catastrophic forgetting.' }]
    }, { problems: [], methods: [], claims: [] }, {
      semanticExtraction: 'llm-assisted', llmProvider: 'deepseek',
      llmModel: 'deepseek-flash', llmApiKey: 'test-key', llmMaxTokens: 2048
    });
    assert.equal(result.problems[0]?.name, 'catastrophic forgetting');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 2048);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
