import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { slugify, stableHash } from '../src/lib/utils.js';
import {
  getCorpusPaths,
  loadCorpus,
  saveCorpus,
  saveCorpusFastLocalDelta,
  saveSourceManifest
} from '../src/storage/corpus-store.js';
import { listAuthoritativeSyncJobs } from '../src/storage/authoritative-sync-store.js';
import { runAuthoritativeSyncQueueOnce } from '../src/core/authoritative-sync/worker.js';
import { corpusMetaPayload } from '../src/server/api.js';

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function buildCorpusId(name, rootPath) {
  return `corpus:${slugify(name)}:${stableHash(rootPath)}`;
}

function createSemanticPaper(overrides = {}) {
  return {
    paperId: 'paper:new',
    paperTitle: 'New Paper',
    sourceKey: 'source:new',
    sourcePath: '/tmp/new-paper.md',
    sourceMarkdownPath: '/tmp/new-paper.md',
    sourcePdfPath: null,
    sourceKind: 'markdown',
    sourceFingerprint: 'fp:new',
    authors: ['Researcher Example'],
    abstract: 'We study generalized category discovery with prototype alignment.',
    problems: [
      {
        name: 'Generalized Category Discovery',
        text: 'generalized category discovery',
        evidenceText: 'We study generalized category discovery.',
        sectionRole: 'abstract',
        confidence: 0.82
      }
    ],
    methods: [
      {
        name: 'prototype alignment',
        text: 'prototype alignment',
        evidenceText: 'We propose prototype alignment.',
        sectionRole: 'abstract',
        confidence: 0.84
      }
    ],
    datasets: [],
    benchmarks: [],
    metrics: [],
    claims: [
      {
        name: 'Prototype alignment improves generalized category discovery.',
        text: 'Prototype alignment improves generalized category discovery.',
        evidenceText: 'Prototype alignment improves generalized category discovery.',
        sectionRole: 'abstract',
        confidence: 0.8
      }
    ],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [],
    futureDirections: [],
    llmRelations: [],
    ...overrides
  };
}

test('authoritative sync worker applies a queued delta to the committed graph and marks the corpus synced', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-authoritative-worker-'));
  const corpusName = 'authoritative-worker-test';
  const corpusId = buildCorpusId(corpusName, tempRoot);
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const committedGraph = createKnowledgeGraph();

  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    committedGraph.addNode({
      id: corpusId,
      type: NODE_TYPES.CORPUS,
      name: corpusName,
      properties: {
        layer: 'CorpusLayer',
        rootPath: tempRoot
      }
    });
    committedGraph.addNode({
      id: 'paper:old',
      type: NODE_TYPES.PAPER,
      name: 'Old Paper',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:old',
        paperTitle: 'Old Paper'
      }
    });
    committedGraph.addRelationship(createRelationship(corpusId, 'paper:old', EDGE_TYPES.CONTAINS));

    await saveCorpus(tempRoot, committedGraph, {
      name: corpusName,
      indexedAt: new Date().toISOString(),
      paperCount: 1,
      nodeCount: committedGraph.nodeCount,
      relationshipCount: committedGraph.relationshipCount
    }, {
      liteViewMode: 'incremental',
      liteViewSources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Old Paper',
          sourceFingerprint: 'fp:old'
        }
      ]
    });

    await saveSourceManifest(tempRoot, {
      corpusName,
      rootPath: tempRoot,
      sources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Old Paper',
          fingerprint: 'fp:old',
          activeInGraph: true
        }
      ]
    });

    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph,
      semanticPapers: [createSemanticPaper()]
    });

    await saveCorpusFastLocalDelta(tempRoot, delta, {
      name: corpusName,
      indexedAt: new Date().toISOString(),
      paperCount: 2,
      nodeCount: 0,
      relationshipCount: 0
    }, {
      corpusName,
      rootPath: tempRoot,
      sources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Old Paper',
          fingerprint: 'fp:old',
          activeInGraph: true
        },
        {
          sourceKey: 'source:new',
          paperId: 'paper:new',
          paperTitle: 'New Paper',
          fingerprint: 'fp:new',
          activeInGraph: true
        }
      ]
    }, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target'
    });

    const pendingMetaPayload = await corpusMetaPayload(tempRoot);
    assert.equal(pendingMetaPayload.authoritativeSync.status, 'pending');
    assert.equal(pendingMetaPayload.authoritativeSync.pendingJobCount, 1);

    const result = await runAuthoritativeSyncQueueOnce(tempRoot);
    const corpus = await loadCorpus(tempRoot);
    const meta = JSON.parse(await fs.readFile(getCorpusPaths(tempRoot).metaPath, 'utf8'));
    const queuedJobs = await listAuthoritativeSyncJobs(tempRoot);

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.ok(corpus.graph.getNode('paper:new'));
    assert.equal(meta.authoritativeSyncStatus, 'synced');
    assert.deepEqual(queuedJobs, []);
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
