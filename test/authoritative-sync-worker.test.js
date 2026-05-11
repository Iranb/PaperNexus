import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { applyGraphDeltaPayload, buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
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
import {
  buildGraphV2Shadow,
  cutoverGraphV2,
  rollbackGraphV2,
  verifyGraphV2
} from '../src/core/graph-v2/migration.js';
import { loadKuzuV2Summary, saveGraphDeltaToKuzu, verifyKuzuV2SourceFragment } from '../src/storage/kuzu-store.js';

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

test('graph-v2 migration builds a shadow DB, verifies it, cutovers, and rolls back', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-migration-'));
  const corpusName = 'graph-v2-migration-test';
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

    const shadow = await buildGraphV2Shadow(tempRoot);
    assert.equal(shadow.report.graphV2.nodeCount, committedGraph.nodeCount);
    assert.equal(shadow.report.graphV2.relationshipCount, committedGraph.relationshipCount);

    const verification = await verifyGraphV2(tempRoot);
    assert.equal(verification.report.ok, true);

    const cutover = await cutoverGraphV2(tempRoot, {
      skipVerify: true
    });
    const activeMeta = JSON.parse(await fs.readFile(getCorpusPaths(tempRoot).metaPath, 'utf8'));
    const activeCorpus = await loadCorpus(tempRoot);
    assert.equal(cutover.report.type, 'cutover');
    assert.equal(activeMeta.graphV2Status, 'active');
    assert.ok(activeCorpus.graph.getNode('paper:old'));

    const rollback = await rollbackGraphV2(tempRoot);
    const rolledBackCorpus = await loadCorpus(tempRoot);
    assert.equal(rollback.report.type, 'rollback');
    assert.ok(rolledBackCorpus.graph.getNode('paper:old'));
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph-v2 delta writes are idempotent for carried-forward source fragments', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-idempotent-delta-'));
  const dbPath = path.join(tempRoot, 'graph-v2.kuzu');

  try {
    await saveGraphDeltaToKuzu(dbPath, {
      targetManifestToken: 'manifest:base',
      changedSourceKeys: ['source:old'],
      upsertNodes: [
        {
          id: 'paper:old',
          type: NODE_TYPES.PAPER,
          name: 'Old Paper',
          properties: {
            layer: 'DocumentLayer',
            paperId: 'paper:old',
            paperTitle: 'Old Paper'
          }
        }
      ],
      upsertRelationships: [],
      sourceEntries: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          fingerprint: 'fp:old',
          nodeIds: ['paper:old'],
          relationshipIds: []
        }
      ]
    });

    const second = await saveGraphDeltaToKuzu(dbPath, {
      baseManifestToken: 'manifest:base',
      targetManifestToken: 'manifest:next',
      changedSourceKeys: ['source:new'],
      upsertNodes: [
        {
          id: 'paper:new',
          type: NODE_TYPES.PAPER,
          name: 'New Paper',
          properties: {
            layer: 'DocumentLayer',
            paperId: 'paper:new',
            paperTitle: 'New Paper'
          }
        }
      ],
      upsertRelationships: [],
      sourceEntries: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          fingerprint: 'fp:old',
          nodeIds: ['paper:old'],
          relationshipIds: []
        },
        {
          sourceKey: 'source:new',
          paperId: 'paper:new',
          fingerprint: 'fp:new',
          nodeIds: ['paper:new'],
          relationshipIds: []
        }
      ]
    });
    const summary = await loadKuzuV2Summary(dbPath);

    assert.equal(second.reused, false);
    assert.equal(summary.sourceFragmentCount, 2);
    assert.equal(summary.nodeContributionCount, 2);
    assert.equal(summary.relationshipContributionCount, 0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph-v2 build-shadow repairs from lite state when active Kuzu is stale', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-lite-repair-'));
  const corpusName = 'graph-v2-lite-repair-test';
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

    await buildGraphV2Shadow(tempRoot);
    await cutoverGraphV2(tempRoot, {
      skipVerify: true
    });

    process.env.PAPERNEXUS_GRAPH_BACKEND = 'kuzu';
    const activeCorpus = await loadCorpus(tempRoot);
    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph: activeCorpus.graph,
      semanticPapers: [createSemanticPaper()]
    });
    const nextGraph = applyGraphDeltaPayload(activeCorpus.graph, delta);
    await saveCorpusFastLocalDelta(tempRoot, delta, {
      ...activeCorpus.meta,
      paperCount: 2,
      nodeCount: nextGraph.nodeCount,
      relationshipCount: nextGraph.relationshipCount,
      graphV2Status: 'active'
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
      baseManifestToken: 'manifest:v2-base',
      targetManifestToken: 'manifest:v2-target'
    });

    const repaired = await buildGraphV2Shadow(tempRoot, { force: true });
    await cutoverGraphV2(tempRoot, {
      skipVerify: true
    });
    const verification = await verifyGraphV2(tempRoot);
    const repairedMeta = JSON.parse(await fs.readFile(getCorpusPaths(tempRoot).metaPath, 'utf8'));

    assert.equal(repaired.report.graphV2.nodeCount, repairedMeta.nodeCount);
    assert.equal(repaired.report.graphV2.relationshipCount, repairedMeta.relationshipCount);
    assert.equal(verification.report.ok, true);
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('authoritative sync worker mirrors deltas into graph-v2 shadow sync without blocking the old path', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-shadow-sync-'));
  const corpusName = 'graph-v2-shadow-sync-test';
  const corpusId = buildCorpusId(corpusName, tempRoot);
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const previousShadowSync = process.env.PAPERNEXUS_GRAPH_V2_SHADOW_SYNC;
  const committedGraph = createKnowledgeGraph();

  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
    process.env.PAPERNEXUS_GRAPH_V2_SHADOW_SYNC = '1';

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
      relationshipCount: committedGraph.relationshipCount,
      graphV2Status: 'shadow-sync'
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

    await buildGraphV2Shadow(tempRoot);

    const activeCorpus = await loadCorpus(tempRoot);
    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph: activeCorpus.graph,
      semanticPapers: [createSemanticPaper()]
    });

    await saveCorpusFastLocalDelta(tempRoot, delta, {
      ...activeCorpus.meta,
      paperCount: 2,
      nodeCount: activeCorpus.graph.nodeCount,
      relationshipCount: activeCorpus.graph.relationshipCount,
      graphV2Status: 'shadow-sync'
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
      baseManifestToken: 'manifest:shadow-base',
      targetManifestToken: 'manifest:shadow-target'
    });

    const result = await runAuthoritativeSyncQueueOnce(tempRoot);
    const syncedCorpus = await loadCorpus(tempRoot);
    const syncedMeta = JSON.parse(await fs.readFile(getCorpusPaths(tempRoot).metaPath, 'utf8'));
    const graphV2Summary = await loadKuzuV2Summary(path.join(getCorpusPaths(tempRoot).corpusDir, 'graph-v2.kuzu'));

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.ok(syncedCorpus.graph.getNode('paper:new'));
    assert.equal(syncedMeta.authoritativeSyncStatus, 'synced');
    assert.equal(syncedMeta.graphV2Status, 'shadow-sync');
    assert.equal(syncedMeta.graphV2ShadowSyncStatus, 'synced');
    assert.equal(graphV2Summary.nodeCount, syncedCorpus.graph.nodeCount);
    assert.equal(graphV2Summary.relationshipCount, syncedCorpus.graph.relationshipCount);
    const sourceFragmentCheck = await verifyKuzuV2SourceFragment(
      path.join(getCorpusPaths(tempRoot).corpusDir, 'graph-v2.kuzu'),
      'source:new'
    );
    assert.equal(sourceFragmentCheck.ok, true);
    assert.equal(sourceFragmentCheck.exists, true);
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    if (previousShadowSync === undefined) delete process.env.PAPERNEXUS_GRAPH_V2_SHADOW_SYNC;
    else process.env.PAPERNEXUS_GRAPH_V2_SHADOW_SYNC = previousShadowSync;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('authoritative sync worker applies active graph-v2 deltas without full corpus rewrite', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-v2-delta-worker-'));
  const corpusName = 'graph-v2-delta-worker-test';
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

    await buildGraphV2Shadow(tempRoot);
    await cutoverGraphV2(tempRoot, {
      skipVerify: true
    });

    const activeCorpus = await loadCorpus(tempRoot);
    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph: activeCorpus.graph,
      semanticPapers: [createSemanticPaper()]
    });

    await saveCorpusFastLocalDelta(tempRoot, delta, {
      ...activeCorpus.meta,
      paperCount: 2,
      nodeCount: activeCorpus.graph.nodeCount,
      relationshipCount: activeCorpus.graph.relationshipCount,
      graphV2Status: 'active'
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
      baseManifestToken: 'manifest:v2-base',
      targetManifestToken: 'manifest:v2-target'
    });

    const result = await runAuthoritativeSyncQueueOnce(tempRoot);
    const syncedCorpus = await loadCorpus(tempRoot);
    const syncedMeta = JSON.parse(await fs.readFile(getCorpusPaths(tempRoot).metaPath, 'utf8'));
    const activeVerification = await verifyGraphV2(tempRoot);

    assert.equal(result.processed, true);
    assert.equal(result.failed, false);
    assert.ok(syncedCorpus.graph.getNode('paper:new'));
    assert.equal(syncedMeta.authoritativeSyncStatus, 'synced');
    assert.equal(syncedMeta.authoritativeSyncError, null);
    assert.equal(syncedMeta.graphV2Status, 'active');
    assert.equal(activeVerification.report.ok, true);
  } finally {
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
