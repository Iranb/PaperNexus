import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('analyzeCorpus can resume from matching semantic snapshots after an interrupted run', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-resume-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-resume-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), `# Original Paper Title

Jane Doe

## Abstract

We study retrieval-augmented experiment planning with graph evidence.

## Method

We propose a graph-guided retrieval planner.
`, 'utf8');

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'resume-test',
      force: true
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const sourceKey = manifest.sources[0].sourceKey;
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, sourceKey);
    snapshot.paperTitle = 'Resumed Snapshot Title';
    await corpusStore.saveSemanticPaperSnapshot(tempCorpusRoot, sourceKey, snapshot);

    const paths = corpusStore.getCorpusPaths(tempCorpusRoot);
    await Promise.all([
      fs.rm(paths.metaPath, { force: true }),
      fs.rm(paths.manifestPath, { force: true }),
      fs.rm(paths.graphPath, { force: true }),
      fs.rm(paths.kuzuGraphPath, { recursive: true, force: true }),
      fs.rm(`${paths.kuzuGraphPath}.wal`, { force: true }),
      fs.rm(paths.liteGraphPath, { force: true }),
      fs.rm(paths.liteStatePath, { force: true })
    ]);

    const resumed = await analyzeCorpus(tempCorpusRoot, {
      name: 'resume-test'
    });

    const paperNode = resumed.graph.nodes.find((node) => node.type === 'Paper');
    assert.ok(paperNode);
    assert.equal(paperNode.name, 'Resumed Snapshot Title');
    assert.equal(resumed.meta.paperCount, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;

    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
