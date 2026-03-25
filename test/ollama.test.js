import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjudicateCrossPaperCandidates,
  inferPaperSemanticObjects,
  inferPaperResearchSemantics,
  loadLlmApiKey,
  resolveLlmConfig
} from '../src/core/llm/ollama.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
