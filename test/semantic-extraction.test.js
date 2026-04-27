import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function extractPromptPapers(prompt) {
  const marker = 'Papers:\n';
  const markerIndex = String(prompt || '').lastIndexOf(marker);
  if (markerIndex === -1) return [];

  try {
    return JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
  } catch {
    return [];
  }
}

function findPromptPaper(prompt, title) {
  return extractPromptPapers(prompt).find((entry) => entry?.title === title) || null;
}

function isOpenAiTestUrl(url) {
  return String(url || '').startsWith('https://api.openai.com/v1');
}

function createIdentifierResolutionMissResponse() {
  return {
    ok: false,
    status: 404,
    statusText: 'Not Found',
    async json() {
      return {};
    },
    async text() {
      return '';
    }
  };
}

test('analyzeCorpus merges llm-assisted semantic extraction into the graph and semantic snapshot', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Open-World Semi-Supervised Learning with Graph Consistency

Jane Doe, John Smith

## Abstract

We study open-world semi-supervised learning under distribution shift. We propose a graph-theoretic consistency framework and show that it improves robustness to unknown classes.

## Introduction

Open-world semi-supervised learning under distribution shift is challenging because unknown classes break closed-world assumptions.

## Method

Our method is a graph-theoretic open-world consistency framework for open-world semi-supervised learning.

## Results

The framework improves robustness to unknown classes on OpenWorldBench.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        fieldOfStudy: 'Computer Science',
                        fieldCandidates: ['Computer Science', 'Psychology'],
                        domainTags: ['Computer Science', 'Psychology'],
                        abstractMechanisms: ['memory preservation', 'adaptive regulation'],
                        problems: [
                          {
                            name: 'open-world semi-supervised learning under distribution shift',
                            type: 'Problem',
                            evidenceText: 'We study open-world semi-supervised learning under distribution shift.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.95
                          }
                        ],
                        methods: [
                          {
                            name: 'graph-theoretic open-world consistency framework',
                            type: 'Method',
                            evidenceText: 'We propose a graph-theoretic consistency framework.',
                            sectionHeading: 'Method',
                            sectionRole: 'method',
                            confidence: 0.92
                          }
                        ],
                        claims: [
                          {
                            name: 'the framework improves robustness to unknown classes',
                            type: 'Claim',
                            evidenceText: 'The framework improves robustness to unknown classes.',
                            sectionHeading: 'Results',
                            sectionRole: 'results',
                            confidence: 0.88
                          }
                        ]
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

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(result.meta.semanticExtractionMode, 'llm-assisted');
    assert.ok(result.graph.nodes.some((node) => node.type === 'Problem' && node.name === 'open-world semi-supervised learning under distribution shift'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'Method' && node.name === 'graph-theoretic open-world consistency framework'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'Claim' && node.name === 'framework improves robustness to unknown classes'));

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionMode, 'llm-assisted');
    assert.equal(snapshot.llm.semanticExtractionModeEffective, 'llm-assisted');
    assert.equal(snapshot.llm.semanticExtractionAttempted, true);
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
    assert.equal(snapshot.llm.semanticExtractionParticipationReason, null);
    assert.equal(snapshot.llmSemanticObjects.problems.length, 1);
    assert.equal(snapshot.llmSemanticObjects.methods.length, 1);
    assert.equal(snapshot.llmSemanticObjects.claims.length, 1);
    assert.equal(snapshot.llmSemanticObjects.requestedMode, 'llm-assisted');
    assert.equal(snapshot.llmSemanticObjects.effectiveMode, 'llm-assisted');
    assert.equal(snapshot.llmSemanticObjects.participated, true);
    assert.equal(snapshot.llmSemanticObjects.fieldOfStudy, 'Computer Science');
    assert.deepEqual(snapshot.llmSemanticObjects.domainTags, ['Computer Science', 'Psychology']);
    assert.deepEqual(snapshot.llmSemanticObjects.abstractMechanisms, ['memory preservation', 'adaptive regulation']);
    const paperNode = result.graph.nodes.find((node) => node.type === 'Paper');
    assert.equal(paperNode?.properties?.fieldOfStudy, 'Computer Science');
    assert.deepEqual(paperNode?.properties?.domainTags, ['Computer Science', 'Psychology']);
    assert.deepEqual(paperNode?.properties?.abstractMechanisms, ['memory preservation', 'adaptive regulation']);
    assert.ok(result.graph.nodes.some((node) => node.type === 'Domain' && node.name === 'Psychology'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'AbstractMechanism' && node.name === 'memory preservation'));
    assert.equal(result.meta.llm.semanticExtraction.participatedPaperCount, 1);
    assert.equal(result.meta.llm.semanticExtraction.skippedPaperCount, 0);
    assert.equal(result.meta.llm.semanticExtraction.effectiveModes['llm-assisted'], 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus runs llm-primary semantic extraction for a fresh markdown corpus without a separate optimize step', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-llm-primary-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-llm-primary-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Fresh Markdown LLM Primary

Alice Example

## Abstract

We study direct analyze llm primary activation.

## Method

We use a reproducible semantic extractor.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!isOpenAiTestUrl(url)) {
        return createIdentifierResolutionMissResponse();
      }
      fetchCount += 1;
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        problems: [
                          {
                            name: 'direct analyze llm primary activation',
                            type: 'Problem',
                            evidenceText: 'We study direct analyze llm primary activation.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.94
                          }
                        ]
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

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-llm-primary-test',
      force: true,
      semanticExtraction: 'llm-primary',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      identifierResolutionEnabled: false
    });

    assert.equal(fetchCount, 1);
    assert.equal(result.meta.llm.semanticExtraction.participatedPaperCount, 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llm.semanticExtractionMode, 'llm-primary');
    assert.equal(snapshot.llm.semanticExtractionModeEffective, 'llm-primary');
    assert.equal(snapshot.llm.semanticExtractionParticipated, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus records which papers participated in auto semantic extraction and which fell back', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-auto-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-auto-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Participating Paper

Alice Example

## Abstract

We study structured semantic extraction for paper graphs.

## Method

We use a participation-aware graph summarizer.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Falling Back Paper

Bob Example

## Abstract

We study fallback tracking for semantic extraction.

## Method

We use a heuristic-only backup path.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const participating = findPromptPaper(prompt, 'Participating Paper');
      const fallingBack = findPromptPaper(prompt, 'Falling Back Paper');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: participating ? [
                      {
                        id: participating.id,
                        problems: [
                          {
                            name: 'structured semantic extraction',
                            type: 'Problem',
                            evidenceText: 'We study structured semantic extraction for paper graphs.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.91
                          }
                        ],
                        methods: [
                          {
                            name: 'participation-aware graph summarizer',
                            type: 'Method',
                            evidenceText: 'We use a participation-aware graph summarizer.',
                            sectionHeading: 'Method',
                            sectionRole: 'method',
                            confidence: 0.89
                          }
                        ]
                      }
                    ] : [],
                    errors: fallingBack ? [
                      {
                        id: fallingBack.id,
                        error: 'synthetic llm failure'
                      }
                    ] : []
                  })
                }
              }
            ]
          };
        }
      };
    };

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-auto-test',
      force: true,
      semanticExtraction: 'auto',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(result.meta.semanticExtractionMode, 'auto');
    assert.equal(result.meta.llm.semanticExtraction.requestedMode, 'auto');
    assert.equal(result.meta.llm.semanticExtraction.participatedPaperCount, 1);
    assert.equal(result.meta.llm.semanticExtraction.skippedPaperCount, 1);
    assert.equal(result.meta.llm.semanticExtraction.effectiveModes['llm-assisted'], 1);
    assert.equal(result.meta.llm.semanticExtraction.effectiveModes['heuristic-only'], 1);
    assert.equal(result.meta.llm.semanticExtraction.participatedPapers[0].paperTitle, 'Participating Paper');
    assert.equal(result.meta.llm.semanticExtraction.skippedPapers[0].paperTitle, 'Falling Back Paper');
    assert.equal(result.meta.llm.semanticExtraction.skippedPapers[0].reason, 'request-failed');

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const snapshotByTitle = new Map(snapshots.map((snapshot) => [snapshot.paperTitle, snapshot]));

    const participatingPaper = snapshotByTitle.get('Participating Paper');
    assert.equal(participatingPaper.llm.semanticExtractionMode, 'auto');
    assert.equal(participatingPaper.llm.semanticExtractionModeEffective, 'llm-assisted');
    assert.equal(participatingPaper.llm.semanticExtractionAttempted, true);
    assert.equal(participatingPaper.llm.semanticExtractionParticipated, true);
    assert.equal(participatingPaper.llm.semanticExtractionParticipationReason, null);

    const fallbackPaper = snapshotByTitle.get('Falling Back Paper');
    assert.equal(fallbackPaper.llm.semanticExtractionMode, 'auto');
    assert.equal(fallbackPaper.llm.semanticExtractionModeEffective, 'heuristic-only');
    assert.equal(fallbackPaper.llm.semanticExtractionAttempted, true);
    assert.equal(fallbackPaper.llm.semanticExtractionParticipated, false);
    assert.equal(fallbackPaper.llm.semanticExtractionParticipationReason, 'request-failed');
    assert.match(fallbackPaper.llm.error, /synthetic llm failure/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus batches LLM semantic extraction across multiple papers', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-batch-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-batch-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  let fetchCount = 0;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Batch Paper A

Alice Example

## Abstract

We study batch semantic extraction for paper A.

## Method

We use a batched graph summarizer.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Batch Paper B

Bob Example

## Abstract

We study batch semantic extraction for paper B.

## Method

We use a batched evidence linker.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!isOpenAiTestUrl(url)) {
        return createIdentifierResolutionMissResponse();
      }
      fetchCount += 1;
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const papers = extractPromptPapers(prompt);

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
                      problems: [
                        {
                          name: `batch semantic extraction for ${paper.title.toLowerCase()}`,
                          type: 'Problem',
                          evidenceText: `We study batch semantic extraction for ${paper.title}.`,
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.9
                        }
                      ]
                    }))
                  })
                }
              }
            ]
          };
        }
      };
    };

    const [{ analyzeCorpus }] = await Promise.all([
      import('../src/core/ingestion/pipeline.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-batch-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      llmBatchSize: 8,
      identifierResolutionEnabled: false
    });

    assert.equal(fetchCount, 1);
    assert.equal(result.meta.llm.semanticExtraction.participatedPaperCount, 2);
    assert.equal(result.meta.llm.semanticExtraction.skippedPaperCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus preserves structured abstract mechanism metadata while keeping legacy mechanism names stable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-mechanism-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-mechanism-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Mechanism Typing for Cross-Domain Transfer

Alice Example

## Abstract

We study adaptive trade-offs between persistence and flexibility.

## Method

We use a metacontrol policy to regulate belief updates.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!isOpenAiTestUrl(url)) {
        return createIdentifierResolutionMissResponse();
      }
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        fieldOfStudy: 'Computer Science',
                        fieldCandidates: ['Computer Science', 'Psychology'],
                        domainTags: ['Computer Science', 'Psychology'],
                      abstractMechanisms: [
                        'memory preservation',
                        {
                          name: 'metacontrol policy',
                          type: 'control-policy',
                          category: 'adaptive-control',
                          description: 'adaptive trade-off between persistence and flexibility',
                          aliases: ['cognitive control trade-off']
                        }
                      ],
                      methods: [
                        {
                          name: 'metacontrol policy scheduler',
                          type: 'Method',
                          evidenceText: 'We use a metacontrol policy to regulate belief updates.',
                          sectionHeading: 'Method',
                          sectionRole: 'method',
                          confidence: 0.9,
                          abstractMechanisms: ['metacontrol policy']
                        }
                      ]
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

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-mechanism-typing-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      identifierResolutionEnabled: false
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);

    assert.deepEqual(snapshot.llmSemanticObjects.abstractMechanisms, ['memory preservation', 'metacontrol policy']);
    assert.equal(snapshot.llmSemanticObjects.abstractMechanismObjects.length, 2);

    const typedMechanism = snapshot.llmSemanticObjects.abstractMechanismObjects.find(
      (entry) => entry.name === 'metacontrol policy'
    );
    assert.ok(typedMechanism);
    assert.equal(typedMechanism.mechanismType, 'control-policy');
    assert.equal(typedMechanism.mechanismCategory, 'adaptive-control');
    assert.equal(typedMechanism.description, 'adaptive trade-off between persistence and flexibility');
    assert.ok(typedMechanism.aliases.includes('cognitive control trade-off'));

    const paperNode = result.graph.nodes.find((node) => node.type === 'Paper');
    assert.deepEqual(paperNode?.properties?.abstractMechanisms, ['memory preservation', 'metacontrol policy']);
    assert.equal(paperNode?.properties?.abstractMechanismObjects?.length, 2);

    const mechanismNode = result.graph.nodes.find(
      (node) => node.type === 'AbstractMechanism' && node.name === 'metacontrol policy'
    );
    assert.ok(mechanismNode);
    assert.equal(mechanismNode.properties.mechanismType, 'control-policy');
    assert.equal(mechanismNode.properties.mechanismCategory, 'adaptive-control');
    assert.ok(mechanismNode.properties.aliases.includes('cognitive control trade-off'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus materializes research questions and dual-form challenges into snapshots and graph primitives', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-challenge-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-challenge-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Cross-Domain Belief Calibration

Alice Example

## Abstract

We study confirmation bias during tutoring feedback.

## Method

We use metacontrol prompts to calibrate belief updates.
`, 'utf8');

    globalThis.fetch = async (url, options) => {
      if (!isOpenAiTestUrl(url)) {
        return createIdentifierResolutionMissResponse();
      }
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        fieldOfStudy: 'Education',
                        fieldCandidates: ['Education', 'Psychology'],
                        domainTags: ['Education', 'Psychology'],
                        abstractMechanisms: [
                          {
                            name: 'metacontrol policy',
                            type: 'control-policy',
                            category: 'adaptive-control',
                            description: 'adaptive trade-off between persistence and flexibility'
                          }
                        ],
                        problems: [
                          {
                            name: 'confirmation bias during tutoring feedback',
                            type: 'Problem',
                            evidenceText: 'We study confirmation bias during tutoring feedback.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.95
                          }
                        ],
                        researchQuestions: [
                          {
                            name: 'how can tutoring systems reduce confirmation bias during feedback?',
                            domainSpecificText: 'How can tutoring systems reduce confirmation bias during feedback?',
                            domainAgnosticText: 'How can interactive systems reduce biased belief updates?'
                          }
                        ],
                        openChallenges: [
                          {
                            name: 'adaptive belief calibration under asymmetric feedback',
                            domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
                            domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
                            challengeType: 'mixed',
                            relatedMechanisms: ['metacontrol policy']
                          }
                        ]
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

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-challenge-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      identifierResolutionEnabled: false
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);

    assert.equal(snapshot.llmSemanticObjects.researchQuestions.length, 1);
    assert.equal(snapshot.llmSemanticObjects.openChallenges.length, 1);
    assert.equal(snapshot.llmSemanticObjects.researchQuestions[0].domainAgnosticText, 'How can interactive systems reduce biased belief updates?');
    assert.equal(snapshot.llmSemanticObjects.openChallenges[0].challengeType, 'mixed');
    assert.deepEqual(snapshot.llmSemanticObjects.openChallenges[0].relatedMechanisms, ['metacontrol policy']);

    const researchQuestionNode = result.graph.nodes.find((node) => node.type === 'ResearchQuestion');
    assert.ok(researchQuestionNode);
    const specificChallengeNode = result.graph.nodes.find(
      (node) => node.type === 'Challenge' && node.properties?.abstractionLevel === 'specific'
    );
    const agnosticChallengeNode = result.graph.nodes.find(
      (node) => node.type === 'Challenge' && node.properties?.abstractionLevel === 'agnostic'
    );
    assert.ok(specificChallengeNode);
    assert.ok(agnosticChallengeNode);
    assert.equal(specificChallengeNode.properties.challengeType, 'mixed');
    assert.equal(agnosticChallengeNode.properties.domainAgnosticText, 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.');

    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'DECOMPOSES_TO'));
    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'HAS_OPEN_CHALLENGE'));
    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'ABSTRACTS_TO'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus materializes takeaways, idea fragments, and supporting snippets into snapshots and graph primitives', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-takeaway-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-takeaway-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Reflective Prompt Transfer

Alice Example

## Abstract

Reflective prompts improve belief updating under uncertainty.

## Discussion

Reflective prompts create a pause that improves uncertainty-aware belief revision.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const paper = extractPromptPapers(prompt)[0];

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: [
                      {
                        id: paper?.id || 'paper-1',
                        fieldOfStudy: 'Psychology',
                        fieldCandidates: ['Psychology', 'Education'],
                        domainTags: ['Psychology', 'Education'],
                        abstractMechanisms: [
                          {
                            name: 'metacontrol policy',
                            type: 'control-policy',
                            category: 'adaptive-control',
                            description: 'adaptive trade-off between persistence and flexibility'
                          }
                        ],
                        problems: [
                          {
                            name: 'belief calibration under uncertainty',
                            type: 'Problem',
                            evidenceText: 'Reflective prompts improve belief updating under uncertainty.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.94
                          }
                        ],
                        openChallenges: [
                          {
                            name: 'adaptive belief calibration under asymmetric feedback',
                            domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
                            domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into biased feedback loops.',
                            challengeType: 'mixed',
                            relatedMechanisms: ['metacontrol policy']
                          }
                        ],
                        takeaways: [
                          {
                            name: 'reflective prompts stabilize belief updating',
                            text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
                            relatedMechanisms: ['metacontrol policy'],
                            relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
                            supportingSnippets: [
                              {
                                text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
                                sectionHeading: 'Discussion',
                                sectionRole: 'discussion'
                              }
                            ]
                          }
                        ],
                        ideaFragments: [
                          {
                            name: 'tutoring feedback prompt scaffold',
                            text: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
                            targetDomain: 'Education',
                            sourceDomains: ['Psychology'],
                            relatedMechanisms: ['metacontrol policy'],
                            sourceTakeaways: ['reflective prompts stabilize belief updating'],
                            addressesChallenges: ['adaptive belief calibration under asymmetric feedback'],
                            supportingSnippets: [
                              {
                                text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
                                sectionHeading: 'Discussion',
                                sectionRole: 'discussion'
                              }
                            ]
                          }
                        ]
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

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-takeaway-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);

    assert.equal(snapshot.llmSemanticObjects.takeaways.length, 1);
    assert.equal(snapshot.llmSemanticObjects.ideaFragments.length, 1);
    assert.equal(snapshot.takeaways.length, 1);
    assert.equal(snapshot.ideaFragments.length, 1);
    assert.equal(snapshot.takeaways[0].relatedChallenges[0], 'adaptive belief calibration under asymmetric feedback');
    assert.equal(snapshot.ideaFragments[0].sourceTakeaways[0], 'reflective prompts stabilize belief updating');

    assert.ok(result.graph.nodes.some((node) => node.type === 'Takeaway'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'IdeaFragment'));
    assert.ok(result.graph.nodes.some((node) => node.type === 'EvidenceSnippet'));
    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'HAS_TAKEAWAY'));
    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'RECONTEXTUALIZES_TO'));
    assert.ok(result.graph.relationships.some((relationship) => relationship.type === 'SUPPORTED_BY_SNIPPET'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus retries only previously failed LLM-assisted papers on a later incremental run', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-retry-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-semantic-retry-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), `# Retry Me Paper

Alice Example

## Abstract

We study retry-aware semantic extraction.

## Method

We use a resumable graph synthesizer.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), `# Stable Paper

Bob Example

## Abstract

We study stable semantic extraction.

## Method

We use a cached graph summarizer.
`, 'utf8');

    const requestCounts = new Map();
    const recordRequest = (title) => {
      requestCounts.set(title, (requestCounts.get(title) || 0) + 1);
    };

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const retryPaper = findPromptPaper(prompt, 'Retry Me Paper');
      const stablePaper = findPromptPaper(prompt, 'Stable Paper');

      if (retryPaper) recordRequest('Retry Me Paper');
      if (stablePaper) recordRequest('Stable Paper');

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    papers: stablePaper ? [
                      {
                        id: stablePaper.id,
                        problems: [
                          {
                            name: 'stable semantic extraction',
                            type: 'Problem',
                            evidenceText: 'We study stable semantic extraction.',
                            sectionHeading: 'Abstract',
                            sectionRole: 'abstract',
                            confidence: 0.9
                          }
                        ]
                      }
                    ] : [],
                    errors: retryPaper ? [
                      {
                        id: retryPaper.id,
                        error: 'temporary network failure'
                      }
                    ] : []
                  })
                }
              }
            ]
          };
        }
      };
    };

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const firstRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-retry-test',
      force: true,
      semanticExtraction: 'auto',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(firstRun.meta.llm.semanticExtraction.participatedPaperCount, 1);
    assert.equal(firstRun.meta.llm.semanticExtraction.skippedPaperCount, 1);
    assert.equal(requestCounts.get('Retry Me Paper'), 1);
    assert.equal(requestCounts.get('Stable Paper'), 1);

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const stablePaper = findPromptPaper(prompt, 'Stable Paper');
      const retryPaper = findPromptPaper(prompt, 'Retry Me Paper');

      if (stablePaper) {
        throw new Error('stable paper should have been reused from cache');
      }

      if (retryPaper) {
        recordRequest('Retry Me Paper');
        return {
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      papers: [
                        {
                          id: retryPaper.id,
                          problems: [
                            {
                              name: 'retry-aware semantic extraction',
                              type: 'Problem',
                              evidenceText: 'We study retry-aware semantic extraction.',
                              sectionHeading: 'Abstract',
                              sectionRole: 'abstract',
                              confidence: 0.94
                            }
                          ],
                          methods: [
                            {
                              name: 'resumable graph synthesizer',
                              type: 'Method',
                              evidenceText: 'We use a resumable graph synthesizer.',
                              sectionHeading: 'Method',
                              sectionRole: 'method',
                              confidence: 0.9
                            }
                          ]
                        }
                      ]
                    })
                  }
                }
              ]
            };
          }
        };
      }

      throw new Error(`unexpected prompt on retry: ${prompt.slice(0, 80)}`);
    };

    const secondRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'semantic-extraction-retry-test',
      semanticExtraction: 'auto',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.equal(secondRun.reused, false);
    assert.equal(secondRun.changes.updated, 1);
    assert.equal(secondRun.changes.reused, 1);
    assert.equal(secondRun.meta.llm.semanticExtraction.participatedPaperCount, 1);
    assert.equal(secondRun.meta.llm.semanticExtraction.skippedPaperCount, 1);
    assert.equal(requestCounts.get('Retry Me Paper'), 2);
    assert.equal(requestCounts.get('Stable Paper'), 1);

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshots = await Promise.all(
      manifest.sources.map((entry) => corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, entry.sourceKey))
    );
    const retrySnapshot = snapshots.find((snapshot) => snapshot.paperTitle === 'Retry Me Paper');
    const stableSnapshot = snapshots.find((snapshot) => snapshot.paperTitle === 'Stable Paper');

    assert.equal(retrySnapshot.llm.semanticExtractionParticipated, true);
    assert.equal(retrySnapshot.llm.semanticExtractionParticipationReason, null);
    assert.ok(stableSnapshot);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
