import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('import worker processes queued uploads and merges them into the single graph', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-worker-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [
      ingestion,
      corpusStore,
      importStore,
      importWorker
    ] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-worker-test',
      force: true
    });

    const task = await importStore.createImportTask(indexRoot, {
      trigger: 'api',
      inputPaths: [inputRoot],
      files: [
        {
          name: 'uploaded-paper.md',
          contentBase64: Buffer.from('# Uploaded Paper\n\n## Abstract\n\nThis upload should enter the graph.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    const result = await importWorker.runImportQueueUntilIdle(indexRoot, {
      semanticExtraction: 'heuristic-only',
      maxPasses: 4
    });

    assert.equal(result.completedTaskIds.includes(task.id), true);

    const loadedTask = await importStore.loadImportTask(indexRoot, task.id);
    assert.equal(loadedTask.status, 'completed');

    const corpus = await corpusStore.loadCorpus(indexRoot);
    assert.equal(corpus.meta.paperCount, 2);

    const manifest = await corpusStore.loadSourceManifest(indexRoot);
    assert.equal(
      manifest.sources.some((entry) => String(entry.sourcePath || '').includes(path.join('.papernexus', 'imports'))),
      true
    );

    const log = await importStore.loadImportTaskLog(indexRoot, task.id);
    assert.match(log, /stage materialize/i);
    assert.match(log, /stage write-index/i);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
