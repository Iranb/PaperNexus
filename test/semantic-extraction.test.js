import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

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
                })
              }
            }
          ]
        };
      }
    });

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

      if (prompt.includes('Paper title: Participating Paper')) {
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
                    })
                  }
                }
              ]
            };
          }
        };
      }

      throw new Error('synthetic llm failure');
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

      if (prompt.includes('Paper title: Retry Me Paper')) {
        recordRequest('Retry Me Paper');
        throw new Error('temporary network failure');
      }

      if (prompt.includes('Paper title: Stable Paper')) {
        recordRequest('Stable Paper');
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
                          name: 'stable semantic extraction',
                          type: 'Problem',
                          evidenceText: 'We study stable semantic extraction.',
                          sectionHeading: 'Abstract',
                          sectionRole: 'abstract',
                          confidence: 0.9
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

      throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
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

      if (prompt.includes('Paper title: Stable Paper')) {
        throw new Error('stable paper should have been reused from cache');
      }

      if (prompt.includes('Paper title: Retry Me Paper')) {
        recordRequest('Retry Me Paper');
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
    assert.equal(secondRun.meta.llm.semanticExtraction.participatedPaperCount, 2);
    assert.equal(secondRun.meta.llm.semanticExtraction.skippedPaperCount, 0);
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
    assert.equal(stableSnapshot.llm.semanticExtractionParticipated, true);
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
