import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('registry reconcile refreshes stale paper and graph counts from the lite graph', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-registry-reconcile-home-'));
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-registry-reconcile-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousGraphBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
    const [
      { createKnowledgeGraph },
      { NODE_TYPES, getNodeLayer },
      { saveCorpus, saveSourceManifest },
      { saveRegistry, loadRegistry },
      { runRegistryReconcileForAllCorporaOnce }
    ] = await Promise.all([
      import('../src/core/graph/graph.js'),
      import('../src/core/graph/schema.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/registry.js'),
      import('../src/storage/registry-reconcile.js')
    ]);

    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'paper:first',
      type: NODE_TYPES.PAPER,
      name: 'First Paper',
      properties: {
        layer: getNodeLayer(NODE_TYPES.PAPER),
        paperId: 'paper:first',
        paperTitle: 'First Paper',
        sourcePath: path.join(rootPath, 'first.md')
      }
    });
    graph.addNode({
      id: 'paper:second',
      type: NODE_TYPES.PAPER,
      name: 'Second Paper',
      properties: {
        layer: getNodeLayer(NODE_TYPES.PAPER),
        paperId: 'paper:second',
        paperTitle: 'Second Paper',
        sourcePath: path.join(rootPath, 'second.md')
      }
    });
    graph.addNode({
      id: 'paper:citation-placeholder',
      type: NODE_TYPES.PAPER,
      name: 'Citation Placeholder',
      properties: {
        layer: getNodeLayer(NODE_TYPES.PAPER),
        paperId: 'paper:citation-placeholder',
        paperTitle: 'Citation Placeholder',
        placeholder: true
      }
    });
    graph.addNode({
      id: 'problem:test',
      type: NODE_TYPES.PROBLEM,
      name: 'Registry count drift',
      properties: {
        layer: getNodeLayer(NODE_TYPES.PROBLEM)
      }
    });

    await saveCorpus(rootPath, graph, {
      name: 'registry-reconcile-test',
      rootPath,
      indexedAt: '2026-05-01T00:00:00.000Z',
      paperCount: 9,
      nodeCount: 1,
      relationshipCount: 0,
      sourceCount: 9
    });
    await saveSourceManifest(rootPath, {
      corpusName: 'registry-reconcile-test',
      sources: [
        { sourceKey: 'first', activeInGraph: true },
        { sourceKey: 'second', activeInGraph: true },
        { sourceKey: 'duplicate-second', activeInGraph: false }
      ]
    });
    await saveRegistry({
      corpora: [
        {
          name: 'registry-reconcile-test',
          rootPath,
          indexedAt: '2026-05-01T00:00:00.000Z',
          paperCount: 99,
          customField: 'preserved'
        }
      ]
    });

    const results = await runRegistryReconcileForAllCorporaOnce({
      rootPaths: [rootPath]
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].updated, true);

    const registry = await loadRegistry();
    assert.equal(registry.corpora.length, 1);
    assert.equal(registry.corpora[0].paperCount, 2);
    assert.equal(registry.corpora[0].nodeCount, 4);
    assert.equal(registry.corpora[0].relationshipCount, 0);
    assert.equal(registry.corpora[0].sourceCount, 3);
    assert.equal(registry.corpora[0].graphPaperNodeCount, 3);
    assert.equal(registry.corpora[0].graphIndexedPaperNodeCount, 2);
    assert.equal(registry.corpora[0].customField, 'preserved');
    assert.equal(registry.corpora[0].registryReconcileSource, 'graph-lite');
    assert.ok(registry.corpora[0].lastRegistryReconciledAt);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousGraphBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousGraphBackend;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
