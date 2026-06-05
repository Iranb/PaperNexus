import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  adjudicateCrossPaperCandidates,
  clearLlmRateLimitCooldowns,
  inferChunkSemanticObjectsBatch,
  inferGraphNodeChecksBatch,
  inferPaperResearchSemanticsBatch,
  inferPaperSemanticObjects,
  inferPaperSemanticObjectsBatch,
  inferPaperResearchSemantics,
  loadLlmApiKey,
  resolveLlmConfig
} from '../src/core/llm/ollama.js';
import {
  loadCrossPaperJudgmentCache,
  saveCrossPaperJudgmentCache
} from '../src/storage/corpus-store.js';

const originalFetch = globalThis.fetch;
const originalRateLimitStatePath = process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await clearLlmRateLimitCooldowns({ persisted: false });
  if (originalRateLimitStatePath === undefined) {
    delete process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH;
  } else {
    process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = originalRateLimitStatePath;
  }
});

function createRateLimitResponse(message = 'rate limited') {
  return {
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'retry-after' ? '0' : '';
      }
    },
    async text() {
      return JSON.stringify({ error: { message } });
    }
  };
}

function createProviderErrorResponse(status, statusText, message = statusText) {
  return {
    ok: false,
    status,
    statusText,
    headers: {
      get() {
        return '';
      }
    },
    async text() {
      return JSON.stringify({ error: { message } });
    }
  };
}

test('inferPaperSemanticObjects extracts structured semantic objects from OpenAI-style JSON', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                problems: [
                  {
                    name: 'open-world semi-supervised learning under distribution shift',
                    type: 'Problem',
                    evidenceText: 'The paper studies open-world semi-supervised learning under distribution shift.',
                    sectionHeading: 'Introduction',
                    sectionRole: 'introduction',
                    confidence: 0.93,
                    explicitOrInferred: 'explicit'
                  }
                ],
                methods: [
                  {
                    name: 'graph-theoretic open-world consistency framework',
                    type: 'Method',
                    evidenceText: 'We propose a graph-theoretic framework.',
                    sectionHeading: 'Method',
                    sectionRole: 'method',
                    confidence: 0.9,
                    explicitOrInferred: 'explicit'
                  }
                ],
                claims: [
                  {
                    name: 'the framework improves robustness to unknown classes',
                    type: 'Claim',
                    evidenceText: 'The framework improves robustness to unknown classes.',
                    sectionHeading: 'Abstract',
                    sectionRole: 'abstract',
                    confidence: 0.86
                  }
                ]
              })
            }
          }
        ]
      };
    }
  });

  const result = await inferPaperSemanticObjects(
    {
      title: 'A Graph-Theoretic Framework for Understanding Open-World Semi-Supervised Learning',
      sections: [
        { heading: 'Introduction', role: 'introduction', text: 'We study open-world semi-supervised learning under distribution shift.' },
        { heading: 'Method', role: 'method', text: 'We propose a graph-theoretic framework.' }
      ]
    },
    {
      abstract: 'A paper about open-world semi-supervised learning.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    }
  );

  assert.equal(result.provider, 'openai');
  assert.equal(result.mode, 'llm-assisted');
  assert.equal(result.error, null);
  assert.equal(result.problems.length, 1);
  assert.equal(result.methods.length, 1);
  assert.equal(result.claims.length, 1);
  assert.equal(result.problems[0].sectionRole, 'introduction');
});

test('inferPaperSemanticObjects auto falls back to heuristic-only when no LLM model is configured', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called without an LLM model');
  };

  const result = await inferPaperSemanticObjects(
    {
      title: 'Fallback Paper',
      sections: [
        { heading: 'Introduction', role: 'introduction', text: 'A fallback-only semantic extraction case.' }
      ]
    },
    {
      abstract: 'No configured model should cause auto to fall back.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'auto'
    }
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.provider, 'disabled');
  assert.equal(result.requestedMode, 'auto');
  assert.equal(result.effectiveMode, 'heuristic-only');
  assert.equal(result.mode, 'heuristic-only');
  assert.equal(result.attempted, false);
  assert.equal(result.participated, false);
  assert.equal(result.reason, 'llm-unconfigured');
  assert.equal(result.error, null);
  assert.equal(result.problems.length, 0);
});

test('inferPaperSemanticObjects disables thinking for DashScope Qwen3 JSON mode', async () => {
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  problems: []
                })
              }
            }
          ]
        };
      }
    };
  };

  await inferPaperSemanticObjects(
    {
      title: 'DashScope Qwen3 paper',
      sections: [
        { heading: 'Introduction', role: 'introduction', text: 'Structured JSON extraction test.' }
      ]
    },
    {
      abstract: 'A test paper.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'qwen3-32b',
      llmBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      llmApiKey: 'test-key'
    }
  );

  assert.equal(requestBody.enable_thinking, false);
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
});

test('inferPaperSemanticObjects sends DeepSeek JSON-mode chat requests', async () => {
  let requestUrl = '';
  let requestBody = null;
  let requestHeaders = null;
  globalThis.fetch = async (url, options) => {
    requestUrl = String(url);
    requestBody = JSON.parse(options.body);
    requestHeaders = options.headers;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  problems: [
                    {
                      name: 'deepseek json mode extraction',
                      type: 'Problem',
                      evidenceText: 'DeepSeek JSON mode extraction is tested.',
                      sectionHeading: 'Abstract',
                      sectionRole: 'abstract',
                      confidence: 0.91
                    }
                  ]
                })
              }
            }
          ]
        };
      }
    };
  };

  const result = await inferPaperSemanticObjects(
    {
      title: 'DeepSeek JSON Mode',
      sections: [
        { heading: 'Abstract', role: 'abstract', text: 'DeepSeek JSON mode extraction is tested.' }
      ]
    },
    {
      abstract: 'A DeepSeek JSON mode paper.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-chat',
      llmApiKey: 'deepseek-test-key',
      llmMaxTokens: 1024
    }
  );

  assert.equal(requestUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(requestHeaders.authorization, 'Bearer deepseek-test-key');
  assert.equal(requestBody.model, 'deepseek-chat');
  assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  assert.equal(requestBody.max_tokens, 1024);
  assert.equal(Object.hasOwn(requestBody, 'max_completion_tokens'), false);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.problems[0].name, 'deepseek json mode extraction');
});

test('inferPaperSemanticObjects reports empty DeepSeek JSON-mode content as empty response', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: ''
            }
          }
        ]
      };
    }
  });

  const result = await inferPaperSemanticObjects(
    {
      title: 'Empty DeepSeek JSON Mode',
      sections: [
        { heading: 'Abstract', role: 'abstract', text: 'DeepSeek may return empty content.' }
      ]
    },
    {
      abstract: 'A test paper.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-chat',
      llmApiKey: 'deepseek-test-key'
    }
  );

  assert.equal(result.provider, 'deepseek');
  assert.equal(result.participated, false);
  assert.equal(result.reason, 'empty-response');
  assert.match(result.error, /empty content/i);
});

test('inferPaperSemanticObjectsBatch classifies provider HTTP failures', async () => {
  globalThis.fetch = async () => createProviderErrorResponse(500, 'Internal Server Error', 'upstream unavailable');

  const results = await inferPaperSemanticObjectsBatch(
    [
      {
        id: 'paper-http-1',
        parsedPaper: {
          title: 'Provider HTTP Failure One',
          sections: [{ heading: 'Abstract', role: 'abstract', text: 'Provider 5xx should be classified.' }]
        },
        semanticPaper: { abstract: 'Provider 5xx should be classified.', problems: [], methods: [], claims: [] }
      },
      {
        id: 'paper-http-2',
        parsedPaper: {
          title: 'Provider HTTP Failure Two',
          sections: [{ heading: 'Abstract', role: 'abstract', text: 'The batch should keep per-paper failed results.' }]
        },
        semanticPaper: { abstract: 'The batch should keep per-paper failed results.', problems: [], methods: [], claims: [] }
      }
    ],
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      llmApiKey: 'deepseek-test-key',
      llmRateLimitRetryCount: 0,
      llmBatchSize: 2
    }
  );

  assert.deepEqual(results.map((entry) => entry.reason), ['provider-http-5xx', 'provider-http-5xx']);
  assert.equal(results.every((entry) => entry.participated === false), true);
});

test('inferPaperSemanticObjects records a one-hour OpenAI-compatible 429 cooldown without surfacing an error', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-rate-limit-state-'));
  const statePath = path.join(tempDir, 'llm-rate-limits.json');
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = statePath;
  let fetchCount = 0;

  try {
    globalThis.fetch = async () => {
      fetchCount += 1;
      return createRateLimitResponse('temporary request quota exceeded');
    };

    const options = {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmRateLimitRetryCount: 2,
      llmRateLimitRetryDelayMs: 0,
      llmRateLimitRetryMaxDelayMs: 0
    };
    const result = await inferPaperSemanticObjects(
      {
        title: 'Rate Limit Recovery',
        sections: [
          { heading: 'Introduction', role: 'introduction', text: 'The extraction should recover after a temporary 429.' }
        ]
      },
      {
        abstract: 'A test paper.',
        problems: [],
        methods: [],
        claims: []
      },
      options
    );

    assert.equal(fetchCount, 1);
    assert.equal(result.participated, false);
    assert.equal(result.reason, 'rate-limited');
    assert.equal(result.error, null);
    assert.match(result.rateLimitCooldownUntil, /^\d{4}-\d{2}-\d{2}T/);

    const statePayload = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(statePayload.cooldowns.length, 1);
    assert.equal(statePayload.cooldowns[0].until, result.rateLimitCooldownUntil);

    await clearLlmRateLimitCooldowns({ persisted: false });

    const second = await inferPaperSemanticObjects(
      {
        title: 'Rate Limit Recovery 2',
        sections: [
          { heading: 'Introduction', role: 'introduction', text: 'The cooldown should avoid another request.' }
        ]
      },
      {
        abstract: 'A test paper.',
        problems: [],
        methods: [],
        claims: []
      },
      options
    );

    assert.equal(fetchCount, 1);
    assert.equal(second.reason, 'rate-limited');
    assert.equal(second.error, null);
    assert.equal(second.rateLimitCooldownUntil, result.rateLimitCooldownUntil);
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperSemanticObjects falls back to Ollama after an OpenAI-compatible 429', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-fallback-'));
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = path.join(tempDir, 'llm-rate-limits.json');
  const requestedUrls = [];

  try {
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('/chat/completions')) {
        return createRateLimitResponse('temporary quota exhausted');
      }
      return {
        ok: true,
        async json() {
          return {
            response: JSON.stringify({
              problems: [
                {
                  name: 'fallback semantic extraction',
                  type: 'Problem',
                  evidenceText: 'The fallback model extracted this problem.',
                  confidence: 0.82
                }
              ]
            })
          };
        }
      };
    };

    const result = await inferPaperSemanticObjects(
      {
        title: 'Fallback Recovery',
        sections: [
          { heading: 'Abstract', role: 'abstract', text: 'A fallback LLM should recover from a provider 429.' }
        ]
      },
      {
        abstract: 'A fallback test paper.',
        problems: [],
        methods: [],
        claims: []
      },
      {
        semanticExtraction: 'llm-assisted',
        llmProvider: 'openai',
        llmModel: 'gpt-4o-mini',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'test-key',
        llmRateLimitRetryCount: 0,
        llmRateLimitRetryDelayMs: 0,
        llmRateLimitRetryMaxDelayMs: 0,
        llmFallbackProvider: 'ollama',
        llmFallbackModel: 'gemma3:4b',
        llmFallbackBaseUrl: 'http://127.0.0.1:11434'
      }
    );

    assert.equal(requestedUrls.length, 2);
    assert.equal(requestedUrls[0], 'https://api.openai.com/v1/chat/completions');
    assert.equal(requestedUrls[1], 'http://127.0.0.1:11434/api/generate');
    assert.equal(result.provider, 'ollama');
    assert.equal(result.participated, true);
    assert.equal(result.reason, null);
    assert.equal(result.problems[0].name, 'fallback semantic extraction');
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperSemanticObjects falls back to DeepSeek after an OpenAI-compatible 429', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-deepseek-fallback-'));
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = path.join(tempDir, 'llm-rate-limits.json');
  const requests = [];

  try {
    globalThis.fetch = async (url, options) => {
      const requestBody = JSON.parse(options.body);
      requests.push({
        url: String(url),
        authorization: options.headers.authorization,
        body: requestBody
      });
      if (String(url) === 'https://coding.dashscope.aliyuncs.com/v1/chat/completions') {
        return createRateLimitResponse('temporary upstream quota exhausted');
      }
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    problems: [
                      {
                        name: 'deepseek fallback semantic extraction',
                        type: 'Problem',
                        evidenceText: 'The DeepSeek fallback model extracted this problem.',
                        confidence: 0.84
                      }
                    ]
                  })
                }
              }
            ]
          };
        }
      };
    };

    const result = await inferPaperSemanticObjects(
      {
        title: 'DeepSeek Fallback Recovery',
        sections: [
          { heading: 'Abstract', role: 'abstract', text: 'A fallback LLM should recover from repeated upstream 429s.' }
        ]
      },
      {
        abstract: 'A DeepSeek fallback test paper.',
        problems: [],
        methods: [],
        claims: []
      },
      {
        semanticExtraction: 'llm-assisted',
        llmProvider: 'openai',
        llmModel: 'qwen3.6-plus',
        llmBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        llmApiKey: 'primary-test-key',
        llmRateLimitRetryCount: 0,
        llmRateLimitRetryDelayMs: 0,
        llmRateLimitRetryMaxDelayMs: 0,
        llmFallbackProvider: 'deepseek',
        llmFallbackModel: 'deepseek-v4-flash',
        llmFallbackBaseUrl: 'https://api.deepseek.com',
        llmFallbackApiKey: 'fallback-test-key'
      }
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://coding.dashscope.aliyuncs.com/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer primary-test-key');
    assert.equal(requests[0].body.model, 'qwen3.6-plus');
    assert.equal(requests[1].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(requests[1].authorization, 'Bearer fallback-test-key');
    assert.equal(requests[1].body.model, 'deepseek-v4-flash');
    assert.equal(requests[1].body.max_tokens, 2048);
    assert.equal(requests[1].body.max_completion_tokens, undefined);
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.participated, true);
    assert.equal(result.reason, null);
    assert.equal(result.problems[0].name, 'deepseek fallback semantic extraction');
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperSemanticObjects auto-starts and pulls fallback Ollama models before parsing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-fallback-bootstrap-'));
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = path.join(tempDir, 'llm-rate-limits.json');
  const shellCommands = [];
  let tagsCalls = 0;

  try {
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/chat/completions')) {
        return createRateLimitResponse('temporary quota exhausted');
      }
      if (requestUrl.endsWith('/api/tags')) {
        tagsCalls += 1;
        if (tagsCalls === 1) {
          throw new Error('Ollama is down');
        }
        return {
          ok: true,
          async json() {
            return { models: [] };
          }
        };
      }
      return {
        ok: true,
        async json() {
          return {
            response: JSON.stringify({
              problems: [
                {
                  name: 'docker bootstrapped fallback',
                  type: 'Problem',
                  evidenceText: 'The fallback model was available after bootstrap.'
                }
              ]
            })
          };
        }
      };
    };

    const result = await inferPaperSemanticObjects(
      {
        title: 'Fallback Bootstrap',
        sections: [
          { heading: 'Abstract', role: 'abstract', text: 'Ollama should be bootstrapped automatically.' }
        ]
      },
      {
        abstract: 'A fallback bootstrap paper.',
        problems: [],
        methods: [],
        claims: []
      },
      {
        semanticExtraction: 'llm-assisted',
        llmProvider: 'openai',
        llmModel: 'gpt-4o-mini',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'test-key',
        llmRateLimitRetryCount: 0,
        llmRateLimitRetryDelayMs: 0,
        llmRateLimitRetryMaxDelayMs: 0,
        llmFallbackProvider: 'ollama',
        llmFallbackModel: 'gemma3:4b',
        llmFallbackBaseUrl: 'http://127.0.0.1:11434',
        llmFallbackAutoStart: true,
        llmFallbackAutoPull: true,
        llmFallbackOllamaBootstrap: 'docker',
        llmFallbackStartupWaitMs: 1000,
        llmFallbackExecFile: async (command, args) => {
          shellCommands.push([command, ...args].join(' '));
          return { stdout: '' };
        }
      }
    );

    assert.equal(result.provider, 'ollama');
    assert.equal(result.participated, true);
    assert.equal(shellCommands.length, 2);
    assert.match(shellCommands[0], /docker.*run.*ollama\/ollama:latest/);
    assert.match(shellCommands[1], /docker.*exec.*papernexus-ollama.*ollama pull 'gemma3:4b'/);
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperSemanticObjectsBatch stops later LLM batches after provider rate limit', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-rate-limit-batch-'));
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = path.join(tempDir, 'llm-rate-limits.json');
  const batchEvents = [];
  let fetchCount = 0;

  try {
    globalThis.fetch = async () => {
      fetchCount += 1;
      return createRateLimitResponse('quota exhausted');
    };

    const results = await inferPaperSemanticObjectsBatch(
      [
        { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
        { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} },
        { id: 'paper-3', parsedPaper: { title: 'C', sections: [] }, semanticPaper: {} }
      ],
      {
        semanticExtraction: 'llm-assisted',
        llmProvider: 'openai',
        llmModel: 'gpt-4o-mini',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'test-key',
        llmBatchSize: 1,
        llmRateLimitRetryCount: 0,
        llmRateLimitRetryDelayMs: 0,
        llmRateLimitRetryMaxDelayMs: 0,
        onBatchComplete(event) {
          batchEvents.push(event);
        }
      }
    );

    assert.equal(fetchCount, 1);
    assert.equal(results.length, 3);
    assert.equal(results.every((result) => result.reason === 'rate-limited'), true);
    assert.equal(results.every((result) => result.error === null), true);
    assert.match(results[1].rateLimitCooldownUntil, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(batchEvents.length, 1);
    assert.equal(batchEvents[0].completed, 3);
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferGraphNodeChecksBatch stops later node-check batches after provider rate limit', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-check-rate-limit-'));
  process.env.PAPERNEXUS_LLM_RATE_LIMIT_STATE_PATH = path.join(tempDir, 'llm-rate-limits.json');
  const batchEvents = [];
  let fetchCount = 0;

  try {
    globalThis.fetch = async () => {
      fetchCount += 1;
      return createRateLimitResponse('quota exhausted');
    };

    const results = await inferGraphNodeChecksBatch(
      [
        { id: 'node-1', type: 'Dataset', name: 'training dataset' },
        { id: 'node-2', type: 'Dataset', name: 'Office-Home dataset' },
        { id: 'node-3', type: 'Problem', name: 'open-set domain adaptation' }
      ],
      {
        nodeLlmCheck: true,
        llmProvider: 'openai',
        llmModel: 'gpt-4o-mini',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'test-key',
        llmBatchSize: 1,
        llmRateLimitRetryCount: 0,
        llmRateLimitRetryDelayMs: 0,
        llmRateLimitRetryMaxDelayMs: 0,
        onBatchComplete(event) {
          batchEvents.push(event);
        }
      }
    );

    assert.equal(fetchCount, 1);
    assert.equal(results.length, 3);
    assert.equal(results.every((result) => result.reason === 'rate-limited'), true);
    assert.equal(results.every((result) => result.error === null), true);
    assert.match(results[2].rateLimitCooldownUntil, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(batchEvents.length, 1);
    assert.equal(batchEvents[0].completed, 3);
  } finally {
    await clearLlmRateLimitCooldowns();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperSemanticObjects tolerates lightly malformed JSON with repair fallback', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: "{problems:[{name:'open-world ssl', type:'Problem', evidenceText:'A test.',}],}"
            }
          }
        ]
      };
    }
  });

  const result = await inferPaperSemanticObjects(
    {
      title: 'Repair test',
      sections: [
        { heading: 'Introduction', role: 'introduction', text: 'A malformed JSON response should still parse.' }
      ]
    },
    {
      abstract: 'A test paper.',
      problems: [],
      methods: [],
      claims: []
    },
    {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    }
  );

  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].name, 'open-world ssl');
});

test('inferPaperResearchSemantics sanitizes Ollama output and remaps incompatible relations', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        response: JSON.stringify({
          benchmarks: [
            {
              name: 'SemiBench',
              type: 'Benchmark',
              evidenceText: 'Evaluation is reported on SemiBench.',
              sectionHeading: 'Results',
              confidence: 0.91,
              explicitOrInferred: 'explicit'
            }
          ],
          findings: [
            {
              name: 'FlexMatch improves by 2.1 points',
              type: 'Finding',
              evidenceText: 'Improves by 2.1 points on average.',
              sectionHeading: 'Results',
              confidence: 0.88,
              explicitOrInferred: 'explicit'
            }
          ],
          relations: [
            {
              sourceType: 'Method',
              sourceName: 'FlexMatch',
              targetType: 'Problem',
              targetName: 'class imbalance',
              type: 'HAS_GAP',
              confidence: 0.8,
              evidenceText: 'Applied to the class imbalance setting.',
              rationale: 'Method-to-problem should map to applies-to.',
              explicitOrInferred: 'inferred'
            },
            {
              sourceType: 'Claim',
              sourceName: 'Better calibration',
              targetType: 'Evidence',
              targetName: 'Table 2',
              type: 'SUPPORTED_BY',
              confidence: 0.77,
              evidenceText: 'Table 2 supports the claim.'
            },
            {
              sourceType: 'Dataset',
              sourceName: 'CIFAR-10',
              targetType: 'Method',
              targetName: 'FlexMatch',
              type: 'RELATED_TO'
            }
          ]
        })
      };
    }
  });

  const result = await inferPaperResearchSemantics(
    {
      title: 'FlexMatch for Semi-Supervised Learning',
      sections: [{ heading: 'Results', text: 'FlexMatch improves by 2.1 points on SemiBench.' }]
    },
    {
      abstract: 'A paper about class imbalance and semi-supervised learning.',
      problems: [{ name: 'class imbalance', text: 'class imbalance', confidence: 0.7 }],
      methods: [{ name: 'FlexMatch', text: 'FlexMatch', confidence: 0.8 }],
      claims: [{ name: 'Better calibration', text: 'Better calibration', confidence: 0.7 }]
    },
    {
      ollamaRelations: true,
      ollamaModel: 'qwen2.5:0.5b',
      ollamaUrl: 'http://127.0.0.1:11434'
    }
  );

  assert.equal(result.provider, 'ollama');
  assert.equal(result.error, null);
  assert.equal(result.benchmarks.length, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.relations.length, 2);
  assert.equal(result.relations[0].type, 'APPLIES_TO');
  assert.equal(result.relations[0].explicitOrInferred, 'inferred');
  assert.equal(result.relations[1].type, 'SUPPORTED_BY');
});

test('adjudicateCrossPaperCandidates batches requests and filters unsupported relations', async () => {
  const responses = [
    {
      response: JSON.stringify({
        judgments: [
          {
            id: 'transfer:1',
            accepted: true,
            relationType: 'TRANSFERABLE_TO',
            confidence: 0.82,
            evidenceText: 'Works on a neighboring problem.',
            rationale: 'Transfer looks justified.'
          }
        ]
      })
    },
    {
      response: JSON.stringify({
        judgments: [
          {
            id: 'combine:1',
            accepted: true,
            relationType: 'COMBINES_WITH',
            confidence: 0.79,
            evidenceText: 'The methods are complementary.',
            rationale: 'Combination is plausible.'
          },
          {
            id: 'ignored:1',
            accepted: true,
            relationType: 'RELATED_TO',
            confidence: 0.5
          }
        ]
      })
    }
  ];
  const calls = [];

  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        return responses.shift();
      }
    };
  };

  const judgments = await adjudicateCrossPaperCandidates(
    [
      {
        id: 'transfer:1',
        source: { id: 'm1', type: 'Method', name: 'Method A' },
        target: { id: 'p1', type: 'Problem', name: 'Problem A' }
      },
      {
        id: 'combine:1',
        source: { id: 'm2', type: 'Method', name: 'Method B' },
        target: { id: 'm3', type: 'Method', name: 'Method C' }
      }
    ],
    {
      ollamaRelations: true,
      ollamaModel: 'qwen2.5:0.5b',
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaBatchSize: 1
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(judgments.length, 2);
  assert.deepEqual(
    judgments.map((item) => item.relationType),
    ['TRANSFERABLE_TO', 'COMBINES_WITH']
  );
});

test('adjudicateCrossPaperCandidates reuses cached judgments for identical candidates and config', async () => {
  let fetchCount = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const candidate = /"id":"([^"]+)"/.exec(prompt)?.[1] || 'transfer:1';

    return {
      ok: true,
      async json() {
        return {
          response: JSON.stringify({
            judgments: [
              {
                id: candidate,
                accepted: true,
                relationType: 'TRANSFERABLE_TO',
                confidence: 0.82,
                evidenceText: 'Works on a neighboring problem.',
                rationale: 'Transfer looks justified.'
              }
            ]
          })
        };
      }
    };
  };

  const cache = new Map();
  const candidates = [
    {
      id: 'transfer:1',
      relationType: 'TRANSFERABLE_TO',
      source: { id: 'm1', type: 'Method', name: 'Method A', papers: [] },
      target: { id: 'p1', type: 'Problem', name: 'Problem A', papers: [] },
      heuristicScore: 0.75
    }
  ];
  const options = {
    ollamaRelations: true,
    ollamaModel: 'qwen2.5:0.5b',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaBatchSize: 1,
    crossPaperJudgmentCache: cache
  };

  const first = await adjudicateCrossPaperCandidates(candidates, options);
  const second = await adjudicateCrossPaperCandidates(candidates, options);

  assert.equal(fetchCount, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].id, 'transfer:1');
  assert.equal(second[0].id, 'transfer:1');
  assert.equal(cache.size, 1);
});

test('cross-paper judgment cache persists across process-level reruns', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cross-paper-cache-'));
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      async json() {
        return {
          response: JSON.stringify({
            judgments: [
              {
                id: 'transfer:1',
                accepted: true,
                relationType: 'TRANSFERABLE_TO',
                confidence: 0.82,
                evidenceText: 'Works on a neighboring problem.',
                rationale: 'Transfer looks justified.'
              }
            ]
          })
        };
      }
    };
  };

  const candidates = [
    {
      id: 'transfer:1',
      relationType: 'TRANSFERABLE_TO',
      source: { id: 'm1', type: 'Method', name: 'Method A', papers: ['Paper A'] },
      target: { id: 'p1', type: 'Problem', name: 'Problem A', papers: ['Paper B'] },
      heuristicScore: 0.75
    }
  ];
  const options = {
    ollamaRelations: true,
    ollamaModel: 'qwen2.5:0.5b',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaBatchSize: 1
  };

  const firstCache = new Map();
  await adjudicateCrossPaperCandidates(candidates, {
    ...options,
    crossPaperJudgmentCache: firstCache
  });
  await saveCrossPaperJudgmentCache(tempRoot, firstCache);

  const secondCache = await loadCrossPaperJudgmentCache(tempRoot);
  const second = await adjudicateCrossPaperCandidates(candidates, {
    ...options,
    crossPaperJudgmentCache: secondCache
  });

  assert.equal(fetchCount, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, 'transfer:1');
  assert.equal(secondCache.size, 1);
});

test('batch LLM inference reports batch progress callbacks', async () => {
  const batchEvents = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  papers: papers.map((paper) => ({
                    id: paper.id,
                    problems: []
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} },
    { id: 'paper-3', parsedPaper: { title: 'C', sections: [] }, semanticPaper: {} }
  ];

  const semanticResults = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 2,
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(semanticResults.length, 3);
  assert.equal(batchEvents.length, 2);
  assert.equal(batchEvents[0].batchNumber, 1);
  assert.equal(batchEvents[0].totalBatches, 2);
  assert.equal(batchEvents[0].completed, 2);
  assert.equal(batchEvents[1].batchNumber, 2);
  assert.equal(batchEvents[1].totalBatches, 2);
  assert.equal(batchEvents[1].completed, 3);

  batchEvents.length = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  papers: papers.map((paper) => ({
                    id: paper.id,
                    relations: []
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const relationResults = await inferPaperResearchSemanticsBatch(entries, {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmRelations: true,
    llmBatchSize: 2,
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(relationResults.length, 3);
  assert.equal(batchEvents.length, 2);
  assert.equal(batchEvents[0].batchNumber, 1);
  assert.equal(batchEvents[0].totalBatches, 2);
  assert.equal(batchEvents[0].completed, 2);
  assert.equal(batchEvents[1].batchNumber, 2);
  assert.equal(batchEvents[1].totalBatches, 2);
  assert.equal(batchEvents[1].completed, 3);
});

test('batch LLM inference fails closed on malformed per-paper schema', async () => {
  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} }
  ];

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper, index) => index === 0
                  ? { id: paper.id, problems: 'not-an-array' }
                  : {
                      id: paper.id,
                      problems: [{
                        name: 'valid semantic object',
                        type: 'Problem',
                        evidenceText: 'The valid paper keeps its semantic object.'
                      }]
                    })
              })
            }
          }]
        };
      }
    };
  };

  const semanticResults = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 2
  });

  assert.equal(semanticResults[0].participated, false);
  assert.equal(semanticResults[0].reason, 'schema-validation-failed');
  assert.match(semanticResults[0].error, /problems/i);
  assert.equal(semanticResults[1].participated, true);
  assert.equal(semanticResults[1].problems.length, 1);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper, index) => index === 0
                  ? {
                      id: paper.id,
                      relations: [{
                        sourceType: 'Problem',
                        targetType: 'Method',
                        type: 'USES',
                        targetName: 'valid target without source'
                      }]
                    }
                  : { id: paper.id, relations: [] })
              })
            }
          }]
        };
      }
    };
  };

  const relationResults = await inferPaperResearchSemanticsBatch(entries, {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmRelations: true,
    llmBatchSize: 2
  });

  assert.equal(relationResults[0].reason, 'schema-validation-failed');
  assert.match(relationResults[0].error, /relations/i);
  assert.equal(relationResults[0].relations.length, 0);
  assert.equal(relationResults[1].error, null);
});

test('batch LLM inference normalizes safe output aliases before strict schema validation', async () => {
  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} }
  ];

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper) => ({
                  id: paper.id,
                  research_goals: [{
                    name: 'quality-preserving fast ingestion',
                    evidenceText: 'The fast ingestion path keeps graph-visible quality checks.'
                  }],
                  future_work: [{
                    text: 'background semantic enrichment should avoid unnecessary chunk fallback',
                    evidenceText: 'Long-context extraction should complete before chunk fallback.'
                  }],
                  evidence: [{
                    text: 'worker telemetry shows fallback multiplies provider calls',
                    evidenceText: 'Telemetry reports long-context fallback followed by chunk calls.'
                  }],
                  open_challenges: [{
                    name: 'semantic throughput bottleneck',
                    domainSpecificText: 'LLM optimization is the remaining throughput bottleneck.'
                  }],
                  field_candidates: ['Information Retrieval'],
                  domain_tags: ['Paper Graphs']
                }))
              })
            }
          }]
        };
      }
    };
  };

  const semanticResults = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 1
  });

  assert.equal(semanticResults[0].participated, true);
  assert.equal(semanticResults[0].error, null);
  assert.equal(semanticResults[0].researchGoals[0].name, 'quality-preserving fast ingestion');
  assert.equal(semanticResults[0].futureDirections[0].name, 'background semantic enrichment should avoid unnecessary chunk fallback');
  assert.equal(semanticResults[0].evidences[0].name, 'worker telemetry shows fallback multiplies provider calls');
  assert.equal(semanticResults[0].openChallenges[0].name, 'semantic throughput bottleneck');
  assert.deepEqual(semanticResults[0].fieldCandidates, ['Information Retrieval']);
  assert.deepEqual(semanticResults[0].domainTags, ['Paper Graphs']);

  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper) => ({
                  id: paper.id,
                  research_goals: [{
                    name: 'keep graph quality while ingesting faster',
                    evidenceText: 'Graph quality remains a hard constraint.'
                  }],
                  relationships: [{
                    from: 'fast ingestion path',
                    source_type: 'Method',
                    to: 'slow graph visibility',
                    target_type: 'Problem',
                    relationType: 'APPLIES_TO',
                    evidence: 'The fast path targets the graph visibility bottleneck.'
                  }]
                }))
              })
            }
          }]
        };
      }
    };
  };

  const relationResults = await inferPaperResearchSemanticsBatch(entries, {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmRelations: true,
    llmBatchSize: 1
  });

  assert.equal(relationResults[0].error, null);
  assert.equal(relationResults[0].researchGoals[0].name, 'keep graph quality while ingesting faster');
  assert.equal(relationResults[0].relations.length, 1);
  assert.equal(relationResults[0].relations[0].sourceName, 'fast ingestion path');
  assert.equal(relationResults[0].relations[0].targetName, 'slow graph visibility');
  assert.equal(relationResults[0].relations[0].type, 'APPLIES_TO');
  assert.equal(relationResults[0].relations[0].evidenceText, 'The fast path targets the graph visibility bottleneck.');
});

test('inferPaperSemanticObjectsBatch forces DeepSeek requests to single-item batches', async () => {
  const batchEvents = [];
  const requestPaperCounts = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    requestPaperCounts.push(papers.length);

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  papers: papers.map((paper) => ({
                    id: paper.id,
                    problems: []
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} },
    { id: 'paper-3', parsedPaper: { title: 'C', sections: [] }, semanticPaper: {} }
  ];

  const results = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-chat',
    llmApiKey: 'deepseek-test-key',
    llmBatchSize: 3,
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(results.length, 3);
  assert.deepEqual(requestPaperCounts, [1, 1, 1]);
  assert.equal(batchEvents.length, 3);
  assert.equal(batchEvents.every((event) => event.batchSize === 1), true);
  assert.equal(results.every((result) => result.provider === 'deepseek' && result.participated), true);
});

test('inferPaperSemanticObjectsBatch writes and resumes optional batch ledger', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-batch-ledger-'));
  let fetchCount = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper) => ({ id: paper.id, problems: [], methods: [] }))
              })
            }
          }]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} }
  ];

  try {
    const first = await inferPaperSemanticObjectsBatch(entries, {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'ledger-test'
    });
    assert.equal(fetchCount, 1);
    assert.equal(first.every((result) => result.participated), true);

    const batches = await fs.readFile(path.join(tempDir, 'llm-batches.jsonl'), 'utf8');
    const results = await fs.readFile(path.join(tempDir, 'llm-results.jsonl'), 'utf8');
    assert.match(batches, /ledger-test/);
    assert.match(results, /"status":"completed"/);

    const second = await inferPaperSemanticObjectsBatch(entries, {
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'ledger-test',
      llmBatchResume: true
    });
    assert.equal(fetchCount, 1);
    assert.equal(second.every((result) => result.participated), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferGraphNodeChecksBatch writes and resumes optional batch ledger', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-check-ledger-'));
  let fetchCount = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Nodes:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const nodes = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                nodes: nodes.map((node) => ({
                  id: node.id,
                  verdict: 'keep',
                  canonicalName: node.name,
                  confidence: 0.92,
                  reason: 'valid academic graph node'
                }))
              })
            }
          }]
        };
      }
    };
  };

  const entries = [
    { id: 'node-1', type: 'Dataset', name: 'Office-Home dataset' },
    { id: 'node-2', type: 'Problem', name: 'open-set domain adaptation' }
  ];

  try {
    const first = await inferGraphNodeChecksBatch(entries, {
      nodeLlmCheck: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'node-ledger-test'
    });
    assert.equal(fetchCount, 1);
    assert.equal(first.every((result) => result.participated), true);

    const batches = await fs.readFile(path.join(tempDir, 'llm-batches.jsonl'), 'utf8');
    const results = await fs.readFile(path.join(tempDir, 'llm-results.jsonl'), 'utf8');
    assert.match(batches, /node-ledger-test/);
    assert.match(results, /"phase":"node-check"/);
    assert.match(results, /"status":"completed"/);

    const second = await inferGraphNodeChecksBatch(entries, {
      nodeLlmCheck: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'node-ledger-test',
      llmBatchResume: true
    });
    assert.equal(fetchCount, 1);
    assert.equal(second.every((result) => result.participated), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferPaperResearchSemanticsBatch writes and resumes optional batch ledger', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-relation-batch-ledger-'));
  let fetchCount = 0;
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                papers: papers.map((paper) => ({
                  id: paper.id,
                  benchmarks: [],
                  findings: [],
                  researchGoals: [],
                  relations: []
                }))
              })
            }
          }]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} }
  ];

  try {
    const first = await inferPaperResearchSemanticsBatch(entries, {
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'relation-ledger-test'
    });
    assert.equal(fetchCount, 1);
    assert.equal(first.every((result) => !result.error), true);

    const batches = await fs.readFile(path.join(tempDir, 'llm-batches.jsonl'), 'utf8');
    const results = await fs.readFile(path.join(tempDir, 'llm-results.jsonl'), 'utf8');
    assert.match(batches, /relation-ledger-test/);
    assert.match(results, /"phase":"relation-extraction"/);
    assert.match(results, /"status":"completed"/);

    const second = await inferPaperResearchSemanticsBatch(entries, {
      llmRelations: true,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 2,
      llmBatchLedgerDir: tempDir,
      llmBatchRunId: 'relation-ledger-test',
      llmBatchResume: true
    });
    assert.equal(fetchCount, 1);
    assert.equal(second.every((result) => !result.error), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('inferChunkSemanticObjectsBatch splits oversized prompts by prompt budget', async () => {
  let fetchCount = 0;
  const batchEvents = [];
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const chunks = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  chunks: chunks.map((chunk) => ({
                    id: chunk.id,
                    problems: [],
                    methods: [],
                    claims: [],
                    findings: [],
                    researchGoals: [],
                    limitations: [],
                    assumptions: [],
                    evidences: [],
                    futureDirections: [],
                    benchmarks: [],
                    datasets: [],
                    metrics: [],
                    fieldOfStudy: 'Computer Science',
                    fieldCandidates: ['Computer Science'],
                    domainTags: ['Computer Science'],
                    abstractMechanisms: [],
                    researchQuestions: [],
                    openChallenges: [],
                    takeaways: [],
                    ideaFragments: []
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    {
      id: 'chunk-1',
      text: 'A'.repeat(1200),
      chunk: { chunkId: 'chunk-1', text: 'A'.repeat(1200) },
      semanticPaper: { paperId: 'paper-1', paperTitle: 'Paper 1' }
    },
    {
      id: 'chunk-2',
      text: 'B'.repeat(1200),
      chunk: { chunkId: 'chunk-2', text: 'B'.repeat(1200) },
      semanticPaper: { paperId: 'paper-2', paperTitle: 'Paper 2' }
    },
    {
      id: 'chunk-3',
      text: 'C'.repeat(1200),
      chunk: { chunkId: 'chunk-3', text: 'C'.repeat(1200) },
      semanticPaper: { paperId: 'paper-3', paperTitle: 'Paper 3' }
    }
  ];

  const results = await inferChunkSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 10,
    llmBatchPromptMaxChars: 1800,
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(results.length, 3);
  assert.ok(fetchCount > 1);
  assert.equal(batchEvents.length, fetchCount);
  assert.equal(results.every((result) => result.participated), true);
});

test('inferPaperSemanticObjectsBatch retries malformed batch output with smaller batches', async () => {
  let fetchCount = 0;
  const retryEvents = [];
  const batchEvents = [];
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: papers.length > 2
                  ? '<xml></xml>'
                  : JSON.stringify({
                      papers: papers.map((paper) => ({
                        id: paper.id,
                        problems: [],
                        methods: [],
                        claims: [],
                        findings: []
                      }))
                    })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} },
    { id: 'paper-3', parsedPaper: { title: 'C', sections: [] }, semanticPaper: {} },
    { id: 'paper-4', parsedPaper: { title: 'D', sections: [] }, semanticPaper: {} }
  ];

  const results = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 4,
    llmBatchFailureSplitRetryCount: 2,
    onBatchRetry(event) {
      retryEvents.push(event);
    },
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(fetchCount, 3);
  assert.equal(results.length, 4);
  assert.equal(results.every((result) => result.participated), true);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].batchSize, 4);
  assert.equal(retryEvents[0].retryBatchSize, 2);
  assert.equal(batchEvents.length, 1);
  assert.equal(batchEvents[0].completed, 4);
});

test('inferPaperSemanticObjectsBatch retries empty provider batch output with smaller batches', async () => {
  let fetchCount = 0;
  const retryEvents = [];
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: ''
                }
              }
            ]
          };
        }
      };
    }

    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  papers: papers.map((paper) => ({
                    id: paper.id,
                    problems: [],
                    methods: [],
                    claims: [],
                    findings: []
                  }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-empty-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-empty-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} }
  ];

  const results = await inferPaperSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 2,
    llmBatchFailureSplitRetryCount: 2,
    onBatchRetry(event) {
      retryEvents.push(event);
    }
  });

  assert.equal(fetchCount, 3);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.participated), true);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].batchSize, 2);
  assert.equal(retryEvents[0].retryBatchSize, 1);
  assert.match(retryEvents[0].error, /empty content/i);
});

test('inferPaperResearchSemanticsBatch retries transient per-paper batch failures with smaller batches', async () => {
  let fetchCount = 0;
  const retryEvents = [];
  const batchEvents = [];
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const papers = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    const shouldReturnPerPaperError = fetchCount === 1 && papers.length > 1;

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  errors: shouldReturnPerPaperError
                    ? [{ id: papers[0].id, error: 'empty response from provider' }]
                    : [],
                  papers: papers
                    .filter((paper) => !(shouldReturnPerPaperError && paper.id === papers[0].id))
                    .map((paper) => ({
                      id: paper.id,
                      benchmarks: [],
                      findings: [],
                      researchGoals: [],
                      relations: []
                    }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    { id: 'paper-relation-empty-1', parsedPaper: { title: 'A', sections: [] }, semanticPaper: {} },
    { id: 'paper-relation-empty-2', parsedPaper: { title: 'B', sections: [] }, semanticPaper: {} }
  ];

  const results = await inferPaperResearchSemanticsBatch(entries, {
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmRelations: true,
    llmBatchSize: 2,
    llmBatchFailureSplitRetryCount: 2,
    onBatchRetry(event) {
      retryEvents.push(event);
    },
    onBatchComplete(event) {
      batchEvents.push(event);
    }
  });

  assert.equal(fetchCount, 3);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.error === null), true);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].phase, 'relation-extraction');
  assert.equal(retryEvents[0].batchSize, 2);
  assert.equal(retryEvents[0].retryBatchSize, 1);
  assert.match(retryEvents[0].error, /empty-response/i);
  assert.equal(batchEvents.length, 1);
  assert.equal(batchEvents[0].failureCount, 0);
});

test('inferChunkSemanticObjectsBatch retries transient per-chunk batch failures with smaller batches', async () => {
  let fetchCount = 0;
  const retryEvents = [];
  globalThis.fetch = async (_url, options) => {
    fetchCount += 1;
    const request = JSON.parse(options.body);
    const prompt = request.messages?.[0]?.content || '';
    const marker = 'Papers:\n';
    const markerIndex = String(prompt).lastIndexOf(marker);
    const chunks = markerIndex === -1 ? [] : JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
    const shouldReturnPerChunkError = fetchCount === 1 && chunks.length > 1;

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  errors: shouldReturnPerChunkError
                    ? [{ id: chunks[0].id, error: 'empty response from provider' }]
                    : [],
                  chunks: chunks
                    .filter((chunk) => !(shouldReturnPerChunkError && chunk.id === chunks[0].id))
                    .map((chunk) => ({
                      id: chunk.id,
                      problems: [],
                      methods: [],
                      claims: [],
                      findings: [],
                      researchGoals: [],
                      limitations: [],
                      assumptions: [],
                      evidences: [],
                      futureDirections: [],
                      benchmarks: [],
                      datasets: [],
                      metrics: [],
                      fieldOfStudy: 'Computer Science',
                      fieldCandidates: ['Computer Science'],
                      domainTags: ['Computer Science'],
                      abstractMechanisms: [],
                      researchQuestions: [],
                      openChallenges: [],
                      takeaways: [],
                      ideaFragments: []
                    }))
                })
              }
            }
          ]
        };
      }
    };
  };

  const entries = [
    {
      id: 'chunk-empty-1',
      text: 'Chunk A',
      chunk: { chunkId: 'chunk-empty-1', text: 'Chunk A' },
      semanticPaper: { paperId: 'paper-empty-1', paperTitle: 'Paper 1' }
    },
    {
      id: 'chunk-empty-2',
      text: 'Chunk B',
      chunk: { chunkId: 'chunk-empty-2', text: 'Chunk B' },
      semanticPaper: { paperId: 'paper-empty-2', paperTitle: 'Paper 2' }
    }
  ];

  const results = await inferChunkSemanticObjectsBatch(entries, {
    semanticExtraction: 'llm-assisted',
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBaseUrl: 'https://api.openai.com/v1',
    llmApiKey: 'test-key',
    llmBatchSize: 2,
    llmBatchFailureSplitRetryCount: 2,
    onBatchRetry(event) {
      retryEvents.push(event);
    }
  });

  assert.equal(fetchCount, 3);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.participated), true);
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].phase, 'chunk-semantic-extraction');
  assert.equal(retryEvents[0].batchSize, 2);
  assert.equal(retryEvents[0].retryBatchSize, 1);
  assert.match(retryEvents[0].error, /empty-response/i);
});

test('inferPaperResearchSemantics supports OpenAI chat-completions style responses', async () => {
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [
                    {
                      name: 'Evidence tracing improves auditability',
                      type: 'Finding',
                      evidenceText: 'Auditability improves with evidence tracing.',
                      sectionHeading: 'Results',
                      confidence: 0.83,
                      explicitOrInferred: 'explicit'
                    }
                  ],
                  relations: [
                    {
                      sourceType: 'Method',
                      sourceName: 'Evidence tracing',
                      targetType: 'Problem',
                      targetName: 'auditability gap',
                      type: 'APPLIES_TO',
                      confidence: 0.79,
                      evidenceText: 'Applied to auditability gaps.'
                    }
                  ]
                })
              }
            }
          ]
        };
      }
    };
  };

  const result = await inferPaperResearchSemantics(
    {
      title: 'Evidence Tracing for Auditability',
      sections: [{ heading: 'Results', text: 'Evidence tracing improves auditability.' }]
    },
    {
      abstract: 'A paper about auditability and evidence tracing.',
      problems: [{ name: 'auditability gap', text: 'auditability gap', confidence: 0.7 }],
      methods: [{ name: 'Evidence tracing', text: 'Evidence tracing', confidence: 0.8 }]
    },
    {
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmRelations: true
    }
  );

  assert.equal(request.model, 'gpt-4o-mini');
  assert.equal(request.response_format.type, 'json_object');
  assert.equal(result.provider, 'openai');
  assert.equal(result.findings.length, 1);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].type, 'APPLIES_TO');
});

test('inferPaperResearchSemantics supports Anthropic Claude message responses', async () => {
  let request;
  let headers;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    headers = options.headers;
    return {
      ok: true,
      async json() {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                benchmarks: [
                  {
                    name: 'AuditBench',
                    type: 'Benchmark',
                    evidenceText: 'Evaluation uses AuditBench.',
                    sectionHeading: 'Evaluation',
                    confidence: 0.81
                  }
                ],
                relations: [
                  {
                    sourceType: 'Method',
                    sourceName: 'Structured audit graph',
                    targetType: 'Problem',
                    targetName: 'auditability gap',
                    type: 'APPLIES_TO',
                    confidence: 0.77
                  }
                ]
              })
            }
          ]
        };
      }
    };
  };

  const result = await inferPaperResearchSemantics(
    {
      title: 'Structured Audit Graphs',
      sections: [{ heading: 'Evaluation', text: 'Evaluation uses AuditBench.' }]
    },
    {
      abstract: 'A paper about structured audit graphs.',
      problems: [{ name: 'auditability gap', text: 'auditability gap', confidence: 0.7 }],
      methods: [{ name: 'Structured audit graph', text: 'Structured audit graph', confidence: 0.8 }]
    },
    {
      llmProvider: 'claudecode',
      llmModel: 'claude-3-5-sonnet-latest',
      llmBaseUrl: 'https://api.anthropic.com/v1',
      llmApiKey: 'anthropic-test-key',
      llmRelations: true
    }
  );

  assert.equal(request.model, 'claude-3-5-sonnet-latest');
  assert.equal(headers['x-api-key'], 'anthropic-test-key');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.benchmarks.length, 1);
  assert.equal(result.relations.length, 1);
});

test('resolveLlmConfig fills default Keychain binding fields for keychain-backed providers', () => {
  const config = resolveLlmConfig({
    llmProvider: 'openai',
    llmBaseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    llmApiKeySource: 'keychain'
  });

  assert.equal(config.apiKeySource, 'keychain');
  assert.equal(config.apiKeyService, 'papernexus.llm');
  assert.equal(config.apiKeyAccount, 'openai:https://coding.dashscope.aliyuncs.com/v1');
});

test('resolveLlmConfig prefers DeepSeek by default without implicitly enabling LLM calls', () => {
  const config = resolveLlmConfig({});

  assert.equal(config.provider, 'deepseek');
  assert.equal(config.model, '');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(config.enabled, false);
});

test('resolveLlmConfig keeps legacy Ollama options on the Ollama path', () => {
  const config = resolveLlmConfig({
    ollamaModel: 'qwen2.5:0.5b'
  });

  assert.equal(config.provider, 'ollama');
  assert.equal(config.model, 'qwen2.5:0.5b');
  assert.equal(config.baseUrl, 'http://127.0.0.1:11434');
});

test('resolveLlmConfig resolves DeepSeek defaults and disables batch inference', () => {
  const config = resolveLlmConfig({
    llmProvider: 'deepseek',
    llmModel: 'deepseek-chat',
    llmBatchSize: 8,
    llmApiKeySource: 'keychain'
  });

  assert.equal(config.provider, 'deepseek');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(config.apiKeyAccount, 'deepseek:https://api.deepseek.com');
  assert.equal(config.batchSize, 1);
});

test('resolveLlmConfig caps DeepSeek fallback batch size at one', () => {
  const config = resolveLlmConfig({
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmBatchSize: 8,
    llmFallbackProvider: 'deepseek',
    llmFallbackModel: 'deepseek-chat',
    llmFallbackBatchSize: 8
  });

  assert.equal(config.batchSize, 8);
  assert.equal(config.fallback.provider, 'deepseek');
  assert.equal(config.fallback.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.fallback.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(config.fallback.batchSize, 1);
});

test('resolveLlmConfig exposes bounded LLM retry settings for rate-limited providers', () => {
  const config = resolveLlmConfig({
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmRateLimitRetryCount: 5,
    llmRateLimitRetryDelayMs: 250,
    llmRateLimitRetryMaxDelayMs: 5000,
    llmRateLimitCooldownMs: 3600000
  });

  assert.equal(config.rateLimitRetryCount, 5);
  assert.equal(config.rateLimitRetryDelayMs, 250);
  assert.equal(config.rateLimitRetryMaxDelayMs, 5000);
  assert.equal(config.rateLimitCooldownMs, 3600000);
});

test('resolveLlmConfig exposes optional Ollama fallback bootstrap settings', () => {
  const config = resolveLlmConfig({
    llmProvider: 'openai',
    llmModel: 'gpt-4o-mini',
    llmFallbackProvider: 'ollama',
    llmFallbackModel: 'gemma3:4b',
    llmFallbackBaseUrl: 'http://127.0.0.1:11434',
    llmFallbackSshHost: 'gpu.example',
    llmFallbackAutoStart: true,
    llmFallbackAutoPull: true,
    llmFallbackOllamaBootstrap: 'docker',
    llmFallbackOllamaDockerContainer: 'paper-ollama'
  });

  assert.equal(config.fallback.provider, 'ollama');
  assert.equal(config.fallback.model, 'gemma3:4b');
  assert.equal(config.fallback.sshHost, 'gpu.example');
  assert.equal(config.fallback.autoStart, true);
  assert.equal(config.fallback.autoPull, true);
  assert.equal(config.fallback.ollamaBootstrap.mode, 'docker');
  assert.equal(config.fallback.ollamaBootstrap.dockerContainer, 'paper-ollama');
});

test('loadLlmApiKey reads keychain-backed secrets before env fallback', async () => {
  const secret = await loadLlmApiKey({
    provider: 'openai',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    apiKeySource: 'keychain',
    apiKeyService: 'papernexus.llm',
    apiKeyAccount: 'openai:https://coding.dashscope.aliyuncs.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY'
  }, {
    runner: async () => ({
      stdout: 'dashscope-key\n'
    })
  });

  assert.equal(secret, 'dashscope-key');
});
