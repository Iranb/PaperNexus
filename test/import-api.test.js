import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('import API payload helpers create, list, inspect, and show logs for upload tasks', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-workspace-'));
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

    const [ingestion, api] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-api-test',
      force: true
    });

    const created = await api.createImportTaskPayload(indexRoot, {
      files: [
        {
          name: 'api-upload.md',
          contentBase64: Buffer.from('# API Upload\n\n## Abstract\n\nCreated through the API helper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    assert.equal(created.task.status, 'pending');

    const listed = await api.listImportTasksPayload(indexRoot);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.task.id);

    const detail = await api.importTaskPayload(indexRoot, created.task.id);
    assert.equal(detail.task.id, created.task.id);
    assert.equal(detail.task.files.length, 1);

    const log = await api.importTaskLogPayload(indexRoot, created.task.id);
    assert.match(log.log, /created import task/i);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('API payload helpers prefer the configured storage index over stale registry roots', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-config-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-config-workspace-'));
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

    const [ingestion, api, registry] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js'),
      import('../src/storage/registry.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'configured-import-api-test',
      force: true
    });

    await registry.saveRegistry({
      corpora: [
        {
          name: 'stale-macos-corpus',
          rootPath: '/var/folders/old-machine/index-store',
          indexedAt: new Date(0).toISOString(),
          paperCount: 99
        }
      ]
    });

    const options = {
      config: {
        storage: {
          indexDir: indexRoot
        }
      },
      configBaseDir: workspaceRoot
    };

    const listed = await api.listCorporaPayload(options);
    assert.equal(listed.corpora.length, 1);
    assert.equal(listed.corpora[0].rootPath, indexRoot);

    const meta = await api.corpusMetaPayload(undefined, options);
    assert.equal(meta.meta.name, 'configured-import-api-test');

    const created = await api.createImportTaskPayload(undefined, {
      files: [
        {
          name: 'configured-upload.md',
          contentBase64: Buffer.from('# Upload\n\nUsing configured root.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    }, options);
    assert.equal(created.rootPath, indexRoot);
    assert.equal(created.task.status, 'pending');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
