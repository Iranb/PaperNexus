import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('createImportTask stores uploaded files, queue state, and append-only logs', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-store-'));

  try {
    const {
      appendImportTaskLog,
      createImportTask,
      listActiveImportSourceDirs,
      listImportTasks,
      loadImportTask,
      loadImportTaskLog,
      reserveNextImportTask
    } = await import('../src/storage/import-store.js');

    const task = await createImportTask(rootPath, {
      trigger: 'api',
      inputPaths: [path.join(rootPath, 'papers')],
      files: [
        {
          name: 'sample-paper.md',
          contentBase64: Buffer.from('# Sample Paper\n\n## Abstract\n\nA short upload test.\n', 'utf8').toString('base64'),
          mimeType: 'text/markdown'
        }
      ]
    });

    assert.equal(task.status, 'pending');
    assert.equal(task.files.length, 1);
    await fs.access(task.files[0].storedPath);

    await appendImportTaskLog(rootPath, task.id, {
      level: 'info',
      message: 'queued for processing'
    });

    const loaded = await loadImportTask(rootPath, task.id);
    assert.equal(loaded.id, task.id);
    assert.equal(loaded.trigger, 'api');

    const listed = await listImportTasks(rootPath);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, task.id);

    const beforeReserve = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(beforeReserve, []);

    const reserved = await reserveNextImportTask(rootPath);
    assert.equal(reserved.task.id, task.id);

    const afterReserve = await listActiveImportSourceDirs(rootPath);
    assert.deepEqual(afterReserve, [task.sourcesDir]);

    const log = await loadImportTaskLog(rootPath, task.id);
    assert.match(log, /queued for processing/);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
