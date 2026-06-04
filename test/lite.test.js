import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
import { createLiteGraphPayload } from '../src/core/graph/lite.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { slugify, stableHash } from '../src/lib/utils.js';
import {
  getCorpusPaths,
  saveCorpusFastLocalDelta
} from '../src/storage/corpus-store.js';
import { listAuthoritativeSyncJobs } from '../src/storage/authoritative-sync-store.js';
import {
  applyLiteDeltaCommit,
  saveLiteGraphMaterializedView
} from '../src/storage/lite-view.js';

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
    evidences: [
      {
        text: 'We report evidence on a category discovery benchmark.',
        section: 'Results',
        sectionHeading: 'Results',
        sectionRole: 'results',
        confidence: 0.76,
        linkedDatasets: [],
        linkedMetrics: []
      }
    ],
    futureDirections: [],
    llmRelations: [],
    ...overrides
  };
}

test('createLiteGraphPayload preserves layer metadata and truncates large fields', () => {
  const graph = createKnowledgeGraph();
  const largeAbstract = 'A'.repeat(900);
  const largeEvidence = 'B'.repeat(500);

  graph.addNode({
    id: 'paper:1',
    type: 'Paper',
    name: 'Large Paper',
    properties: {
      layer: 'DocumentLayer',
      abstract: largeAbstract,
      paperTitle: 'Large Paper',
      paperTitles: ['Large Paper', 'Neighbor Paper'],
      aliases: ['large paper system']
    }
  });

  graph.addNode({
    id: 'problem:1',
    type: 'Problem',
    name: 'class imbalance',
    properties: {
      layer: 'ProblemLayer',
      text: 'Class imbalance in semi-supervised learning',
      brainstormEligible: true,
      brainstormScore: 0.87,
      brainstormTier: 'high'
    }
  });

  graph.addRelationship({
    id: 'rel:1',
    sourceId: 'paper:1',
    targetId: 'problem:1',
    type: 'SOLVES',
    properties: {
      sourceLayer: 'DocumentLayer',
      targetLayer: 'ProblemLayer',
      layerScope: 'cross-layer',
      layerPath: 'DocumentLayer->ProblemLayer',
      evidenceText: largeEvidence,
      relationSource: 'heuristic'
    }
  });

  const payload = createLiteGraphPayload(graph);

  assert.equal(payload.nodes.length, 2);
  assert.equal(payload.relationships.length, 1);
  assert.equal(payload.nodes[0].properties.layer, 'DocumentLayer');
  assert.ok(payload.nodes[0].properties.abstract.length < largeAbstract.length);
  assert.match(payload.nodes[0].properties.abstract, /\.\.\.$/);
  assert.ok(payload.relationships[0].properties.evidenceText.length < largeEvidence.length);
  assert.match(payload.relationships[0].properties.evidenceText, /\.\.\.$/);
  assert.equal(payload.relationships[0].properties.layerPath, 'DocumentLayer->ProblemLayer');
  assert.equal(payload.nodes[1].properties.brainstormEligible, true);
  assert.equal(payload.views.brainstorm.nodeCount, 1);
  assert.deepEqual(payload.views.brainstorm.nodeIds, ['problem:1']);
  assert.ok(payload.indexes.searchTokens.large.includes('paper:1'));
  assert.ok(payload.indexes.searchTokens.imbalance.includes('problem:1'));
  assert.ok(payload.views.brainstorm.indexes.searchTokens.imbalance.includes('problem:1'));
});

test('saveLiteGraphMaterializedView updates shared lite nodes incrementally across source changes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-lite-view-'));
  const liteGraphPath = path.join(tempRoot, 'graph.lite.json');
  const liteStatePath = path.join(tempRoot, 'graph.lite.state.json');

  try {
    const initialGraph = createKnowledgeGraph();
    initialGraph.addNode({
      id: 'paper:a',
      type: 'Paper',
      name: 'Paper A',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:a',
        paperTitle: 'Paper A'
      }
    });
    initialGraph.addNode({
      id: 'paper:b',
      type: 'Paper',
      name: 'Paper B',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:b',
        paperTitle: 'Paper B'
      }
    });
    initialGraph.addNode({
      id: 'problem:shared',
      type: 'Problem',
      name: 'shared problem',
      properties: {
        layer: 'ProblemLayer',
        paperTitles: ['Paper A', 'Paper B'],
        text: 'Shared problem context'
      }
    });
    initialGraph.addRelationship({
      id: 'rel:a',
      sourceId: 'paper:a',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:a',
        sourcePaperTitle: 'Paper A',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });
    initialGraph.addRelationship({
      id: 'rel:b',
      sourceId: 'paper:b',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:b',
        sourcePaperTitle: 'Paper B',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });

    await saveLiteGraphMaterializedView(tempRoot, initialGraph, {
      liteGraphPath,
      liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:a',
          paperId: 'paper:a',
          paperTitle: 'Paper A',
          sourceFingerprint: 'a:1'
        },
        {
          sourceKey: 'source:b',
          paperId: 'paper:b',
          paperTitle: 'Paper B',
          sourceFingerprint: 'b:1'
        }
      ]
    });

    const updatedGraph = createKnowledgeGraph();
    updatedGraph.addNode({
      id: 'paper:b',
      type: 'Paper',
      name: 'Paper B',
      properties: {
        layer: 'DocumentLayer',
        paperId: 'paper:b',
        paperTitle: 'Paper B'
      }
    });
    updatedGraph.addNode({
      id: 'problem:shared',
      type: 'Problem',
      name: 'shared problem',
      properties: {
        layer: 'ProblemLayer',
        paperTitles: ['Paper B'],
        text: 'Shared problem context'
      }
    });
    updatedGraph.addRelationship({
      id: 'rel:b',
      sourceId: 'paper:b',
      targetId: 'problem:shared',
      type: 'SOLVES',
      properties: {
        sourcePaperId: 'paper:b',
        sourcePaperTitle: 'Paper B',
        layerPath: 'DocumentLayer->ProblemLayer'
      }
    });

    await saveLiteGraphMaterializedView(tempRoot, updatedGraph, {
      liteGraphPath,
      liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:b',
          paperId: 'paper:b',
          paperTitle: 'Paper B',
          sourceFingerprint: 'b:1'
        }
      ]
    });

    const payload = JSON.parse(await fs.readFile(liteGraphPath, 'utf8'));
    const state = JSON.parse(await fs.readFile(liteStatePath, 'utf8'));
    const sharedProblem = payload.nodes.find((node) => node.id === 'problem:shared');

    assert.equal(payload.nodes.some((node) => node.id === 'paper:a'), false);
    assert.equal(payload.relationships.some((relationship) => relationship.id === 'rel:a'), false);
    assert.deepEqual(sharedProblem.properties.paperTitles, ['Paper B']);
    assert.equal(state.sources['source:a'], undefined);
    assert.deepEqual(state.sources['source:b'].nodeIds.sort(), ['paper:b', 'problem:shared']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('saveCorpusFastLocalDelta makes a new paper query-visible in lite state and enqueues authoritative sync', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-local-delta-'));
  const corpusName = 'fast-delta-test';
  const corpusId = buildCorpusId(corpusName, tempRoot);
  const committedGraph = createKnowledgeGraph();
  const paths = getCorpusPaths(tempRoot);

  try {
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

    await saveLiteGraphMaterializedView(tempRoot, committedGraph, {
      liteGraphPath: paths.liteGraphPath,
      liteStatePath: paths.liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Old Paper',
          sourceFingerprint: 'fp:old'
        }
      ]
    });

    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph,
      semanticPapers: [createSemanticPaper()]
    });

    const nextManifest = {
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
    };

    const result = await saveCorpusFastLocalDelta(tempRoot, delta, {
      name: corpusName,
      indexedAt: new Date().toISOString(),
      paperCount: 2,
      nodeCount: 0,
      relationshipCount: 0
    }, nextManifest, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target'
    });

    const litePayload = JSON.parse(await fs.readFile(paths.liteGraphPath, 'utf8'));
    const liteState = JSON.parse(await fs.readFile(paths.liteStatePath, 'utf8'));
    const meta = JSON.parse(await fs.readFile(paths.metaPath, 'utf8'));
    const manifest = JSON.parse(await fs.readFile(paths.manifestPath, 'utf8'));
    const queuedJobs = await listAuthoritativeSyncJobs(tempRoot);

    assert.ok(litePayload.nodes.some((node) => node.id === 'paper:new'));
    assert.ok(liteState.sources['source:new']);
    assert.equal(meta.authoritativeSyncStatus, 'pending');
    assert.equal(meta.lastFastCommitJobId, result.syncJob.jobId);
    assert.equal(manifest.sources.length, 2);
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].targetManifestToken, 'manifest:target');
    assert.equal(typeof result.fastCommitWriteTimingsMs.loadCheckpoint, 'number');
    assert.equal(typeof result.fastCommitWriteTimingsMs.applyLiteDelta, 'number');
    assert.equal(typeof result.fastCommitWriteTimingsMs.writeManifest, 'number');
    assert.equal(typeof result.fastCommitWriteTimingsMs.queueAuthoritativeSync, 'number');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('saveCorpusFastLocalDelta is idempotent for the same target manifest token', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-fast-local-delta-idempotent-'));
  const corpusName = 'fast-delta-idempotent-test';
  const corpusId = buildCorpusId(corpusName, tempRoot);
  const committedGraph = createKnowledgeGraph();
  const paths = getCorpusPaths(tempRoot);

  try {
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

    await saveLiteGraphMaterializedView(tempRoot, committedGraph, {
      liteGraphPath: paths.liteGraphPath,
      liteStatePath: paths.liteStatePath,
      incremental: true,
      currentSources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Old Paper',
          sourceFingerprint: 'fp:old'
        }
      ]
    });

    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph,
      semanticPapers: [createSemanticPaper()]
    });

    const nextManifest = {
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
    };

    const first = await saveCorpusFastLocalDelta(tempRoot, delta, {
      name: corpusName,
      indexedAt: new Date().toISOString(),
      paperCount: 2,
      nodeCount: 0,
      relationshipCount: 0
    }, nextManifest, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target'
    });

    const second = await saveCorpusFastLocalDelta(tempRoot, delta, {
      name: corpusName,
      indexedAt: new Date().toISOString(),
      paperCount: 2,
      nodeCount: 0,
      relationshipCount: 0
    }, nextManifest, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:target'
    });

    const liteState = JSON.parse(await fs.readFile(paths.liteStatePath, 'utf8'));
    const queuedJobs = await listAuthoritativeSyncJobs(tempRoot);

    assert.equal(first.syncJob.jobId, second.syncJob.jobId);
    assert.equal(second.reused, true);
    assert.equal(queuedJobs.length, 1);
    assert.equal(liteState.nodeRefs['paper:new'], 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
