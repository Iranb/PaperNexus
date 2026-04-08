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
    assert.equal(created.deduped, false);

    const deduped = await api.createImportTaskPayload(indexRoot, {
      files: [
        {
          name: 'api-upload-copy.md',
          contentBase64: Buffer.from('# API Upload\n\n## Abstract\n\nCreated through the API helper.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });
    assert.equal(deduped.task.id, created.task.id);
    assert.equal(deduped.deduped, true);

    const listed = await api.listImportTasksPayload(indexRoot);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, created.task.id);
    assert.equal(listed.summary.total, 1);
    assert.equal(listed.summary.pending, 1);
    assert.equal(typeof listed.summary.overallPercent, 'number');
    assert.equal(listed.tasks[0].progress.contractVersion, 'import-progress-v1');

    const detail = await api.importTaskPayload(indexRoot, created.task.id);
    assert.equal(detail.task.id, created.task.id);
    assert.equal(detail.task.files.length, 1);
    assert.equal(detail.task.progress.contractVersion, 'import-progress-v1');
    assert.equal(detail.task.progress.stage, 'queued');
    assert.equal(detail.queueSummary.total, 1);
    assert.equal(detail.queueSummary.pending, 1);

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

test('API payload helpers ignore an invalid configured storage index and fall back to the registered corpus', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-invalid-config-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-invalid-config-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const invalidIndexRoot = path.join(workspaceRoot, 'index-store');
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
      name: 'invalid-config-fallback-test',
      force: true
    });

    const options = {
      config: {
        storage: {
          indexDir: invalidIndexRoot
        }
      },
      configBaseDir: workspaceRoot
    };

    const meta = await api.corpusMetaPayload(undefined, options);
    assert.equal(meta.meta.name, 'invalid-config-fallback-test');

    const created = await api.createImportTaskPayload(undefined, {
      files: [
        {
          name: 'fallback-upload.md',
          contentBase64: Buffer.from('# Upload\n\nUsing registry fallback.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    }, options);
    assert.equal(created.rootPath, inputRoot);
    assert.equal(created.task.status, 'pending');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import API payload helpers can create tasks from a server-side single file path', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-server-path-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-server-path-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const uploadRoot = path.join(workspaceRoot, 'uploads');
  const uploadPath = path.join(uploadRoot, 'server-side-upload.md');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.writeFile(uploadPath, '# Server Path Upload\n\n## Abstract\n\nLoaded from a server-side path.\n', 'utf8');

    const [ingestion, api] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-api-server-path-test',
      force: true
    });

    const created = await api.createImportTaskPayload(indexRoot, {
      serverFilePath: uploadPath
    });
    assert.equal(created.task.status, 'pending');
    assert.equal(created.deduped, false);
    assert.equal(created.task.files.length, 1);
    assert.equal(created.task.files[0].originalName, 'server-side-upload.md');
    assert.notEqual(created.task.files[0].storedPath, uploadPath);

    const deduped = await api.createImportTaskPayload(indexRoot, {
      serverFilePath: uploadPath
    });
    assert.equal(deduped.task.id, created.task.id);
    assert.equal(deduped.deduped, true);
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import API payload helpers reject invalid server-side file path requests', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-server-path-invalid-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-api-server-path-invalid-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const uploadRoot = path.join(workspaceRoot, 'uploads');
  const uploadPath = path.join(uploadRoot, 'server-side-upload.md');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.writeFile(uploadPath, '# Server Path Upload\n', 'utf8');

    const [ingestion, api] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'import-api-server-path-invalid-test',
      force: true
    });

    await assert.rejects(
      () => api.createImportTaskPayload(indexRoot, {
        serverFilePath: 'relative/path/paper.md'
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /absolute path/i);
        return true;
      }
    );

    await assert.rejects(
      () => api.createImportTaskPayload(indexRoot, {
        serverFilePath: uploadRoot
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /regular file/i);
        return true;
      }
    );

    await assert.rejects(
      () => api.createImportTaskPayload(indexRoot, {
        serverFilePath: uploadPath,
        files: [
          {
            name: 'api-upload.md',
            contentBase64: Buffer.from('# API Upload\n', 'utf8').toString('base64'),
            mimeType: 'text/markdown'
          }
        ]
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /either `files` or `serverFilePath`/i);
        return true;
      }
    );
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
