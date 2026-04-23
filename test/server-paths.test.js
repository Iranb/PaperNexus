import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('server path helpers collapse absolute home paths and resolve tilde references', async () => {
  const { collapseHomePath, isServerPathReference, resolveServerPathReference } = await import('../src/lib/server-paths.js');

  assert.equal(collapseHomePath('/home/disk0/hyq/.papernexus/GCD/index/.papernexus', { homeDir: '/home/disk0/hyq' }), '~/.papernexus/GCD/index/.papernexus');
  assert.equal(collapseHomePath('/tmp/papernexus-import-staging/demo', { homeDir: '/home/disk0/hyq' }), '/tmp/papernexus-import-staging/demo');
  assert.equal(resolveServerPathReference('~/.papernexus/GCD/index/.papernexus', { homeDir: '/home/disk0/hyq' }), '/home/disk0/hyq/.papernexus/GCD/index/.papernexus');
  assert.equal(resolveServerPathReference('/tmp/papernexus-import-staging/demo', { homeDir: '/home/disk0/hyq' }), '/tmp/papernexus-import-staging/demo');
  assert.equal(isServerPathReference('~/.papernexus/GCD/index/.papernexus'), true);
  assert.equal(isServerPathReference('/tmp/papernexus-import-staging/demo'), true);
  assert.equal(isServerPathReference('relative/path'), false);
});

test('API payload helpers expose portable home-relative corpus paths and accept tilde serverFilePath values', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-server-path-home-'));
  const inputRoot = path.join(tempHome, 'papers');
  const indexRoot = path.join(tempHome, 'index-store');
  const uploadRoot = path.join(tempHome, 'uploads');
  const uploadPath = path.join(uploadRoot, 'server-side-upload.md');
  const previousHome = process.env.HOME;
  const previousPapernexusHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.HOME = tempHome;
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.writeFile(uploadPath, '# Server Path Upload\n\n## Abstract\n\nLoaded from a tilde path.\n', 'utf8');

    const [ingestion, api] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'portable-path-test',
      force: true
    });

    const options = {
      portablePaths: true,
      config: {
        storage: {
          indexDir: '~/index-store'
        }
      },
      configBaseDir: tempHome
    };

    const listed = await api.listCorporaPayload(options);
    assert.equal(listed.corpora.length, 1);
    assert.equal(listed.corpora[0].rootPath, '~/index-store');

    const meta = await api.corpusMetaPayload(undefined, options);
    assert.equal(meta.meta.rootPath, '~/index-store');

    const created = await api.createImportTaskPayload(undefined, {
      serverFilePath: '~/uploads/server-side-upload.md',
      identifiers: {
        doi: '10.48550/papernexus.portable-server-path'
      }
    }, options);
    assert.equal(created.rootPath, '~/index-store');
    assert.match(created.task.sourcesDir, /^~\/index-store\/\.papernexus\/imports\/tasks\//);
    assert.match(created.task.files[0].storedPath, /^~\/index-store\/\.papernexus\/imports\/tasks\//);

    const detail = await api.importTaskPayload(undefined, created.task.id, options);
    assert.equal(detail.rootPath, '~/index-store');
    assert.match(detail.task.sourcesDir, /^~\/index-store\/\.papernexus\/imports\/tasks\//);
    assert.match(detail.task.files[0].storedPath, /^~\/index-store\/\.papernexus\/imports\/tasks\//);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPapernexusHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousPapernexusHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
