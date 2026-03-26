import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('single-graph stages reject switching to a narrower input scope on the same index root', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-single-graph-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-single-graph-workspace-'));
  const fullInput = path.join(workspaceRoot, 'papers');
  const narrowInput = path.join(workspaceRoot, 'subset');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.mkdir(fullInput, { recursive: true });
    await fs.mkdir(narrowInput, { recursive: true });

    await fs.writeFile(path.join(fullInput, 'paper-a.md'), `# Paper A

## Abstract

We study safe single-graph stage execution.
`, 'utf8');

    await fs.writeFile(path.join(fullInput, 'paper-b.md'), `# Paper B

## Abstract

We study keeping one graph root stable.
`, 'utf8');

    await fs.writeFile(path.join(narrowInput, 'subset-paper.md'), `# Subset Paper

## Abstract

This paper should not silently replace the main graph scope.
`, 'utf8');

    const ingestion = await import('../src/core/ingestion/pipeline.js');

    await ingestion.materializeCorpus(fullInput, {
      name: 'single-graph-safety',
      rootPath: indexRoot,
      force: true
    });

    await assert.rejects(
      ingestion.materializeCorpus(narrowInput, {
        name: 'single-graph-safety',
        rootPath: indexRoot
      }),
      /single graph|single-graph|input scope|configured inputs/i
    );

    await assert.rejects(
      ingestion.buildGraphCorpus(narrowInput, {
        name: 'single-graph-safety',
        rootPath: indexRoot
      }),
      /single graph|single-graph|input scope|configured inputs/i
    );
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('committing an updated graph creates a backup of the previous single-graph index', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-single-graph-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-single-graph-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.mkdir(inputRoot, { recursive: true });
    await fs.writeFile(path.join(inputRoot, 'paper-a.md'), `# Paper A

## Abstract

We study backup-aware single graph updates.
`, 'utf8');

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      name: 'single-graph-backup',
      rootPath: indexRoot,
      force: true
    });

    await fs.writeFile(path.join(inputRoot, 'paper-b.md'), `# Paper B

## Abstract

We trigger a second commit to require a backup.
`, 'utf8');

    await ingestion.analyzeCorpus(inputRoot, {
      name: 'single-graph-backup',
      rootPath: indexRoot
    });

    const backupRoot = corpusStore.getCorpusBackupDir(indexRoot);
    const backupEntries = await fs.readdir(backupRoot);
    assert.ok(backupEntries.length >= 1);

    const backupManifest = JSON.parse(
      await fs.readFile(path.join(backupRoot, backupEntries[0], 'backup.json'), 'utf8')
    );
    assert.equal(backupManifest.corpusName, 'single-graph-backup');
    assert.equal(backupManifest.paperCount, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
