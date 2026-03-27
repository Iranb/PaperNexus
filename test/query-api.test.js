import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function createQueryApiFixture() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-query-api-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-query-api-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  process.env.PAPERNEXUS_HOME = tempHome;
  await fs.mkdir(inputRoot, { recursive: true });

  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(path.join(examplesRoot, fileName), path.join(inputRoot, fileName));
  }

  const ingestion = await import('../src/core/ingestion/pipeline.js');
  await ingestion.analyzeCorpus(inputRoot, {
    rootPath: indexRoot,
    name: 'query-api-test',
    force: true
  });

  return {
    tempHome,
    workspaceRoot,
    indexRoot,
    previousHome
  };
}

async function cleanupQueryApiFixture(fixture) {
  if (fixture.previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = fixture.previousHome;
  await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
}

test('query API payload helpers expose query/context/impact/ideas/brainstorm over the configured corpus', async () => {
  const fixture = await createQueryApiFixture();

  try {
    const api = await import('../src/server/api.js');

    const query = await api.queryGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 5
      }
    });
    assert.equal(query.rootPath, fixture.indexRoot);
    assert.equal(query.result.query, 'experiment planning');
    assert.ok(query.result.groups.length > 0);

    const context = await api.contextGraphPayload(fixture.indexRoot, {
      query: 'experiment planning'
    });
    assert.equal(context.rootPath, fixture.indexRoot);
    assert.equal(context.result.query, 'experiment planning');
    assert.ok(context.result.node || context.result.candidates);

    const impact = await api.impactGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        direction: 'downstream',
        maxDepth: 2,
        layers: 'ProblemLayer,MethodLayer',
        layerMode: 'cross'
      }
    });
    assert.equal(impact.rootPath, fixture.indexRoot);
    assert.equal(impact.result.direction, 'downstream');
    assert.ok(impact.result.node);
    assert.ok(Array.isArray(impact.result.byDepth));

    const ideas = await api.ideasGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 5
      }
    });
    assert.equal(ideas.rootPath, fixture.indexRoot);
    assert.equal(ideas.result.query, 'experiment planning');
    assert.ok(Array.isArray(ideas.result.ideas));
    assert.ok(ideas.result.ideas.length > 0);

    const brainstorm = await api.brainstormGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        mode: 'converge',
        limit: 5,
        maxHops: 2
      }
    });
    assert.equal(brainstorm.rootPath, fixture.indexRoot);
    assert.equal(brainstorm.result.mode, 'converge');
    assert.ok(Array.isArray(brainstorm.result.convergedDirections));
    assert.ok(brainstorm.result.convergedDirections.length > 0);
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});

test('serveCommand exposes authenticated POST query APIs for graph reasoning helpers', async () => {
  const fixture = await createQueryApiFixture();
  const port = 52000 + Math.floor(Math.random() * 1000);

  try {
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'secret-token',
      enableEnhancements: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: fixture.indexRoot
        },
        serve: {
          apiToken: 'secret-token'
        }
      },
      configBaseDir: fixture.workspaceRoot
    });

    try {
      const headers = {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json'
      };

      const query = await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            limit: 5
          }
        })
      }).then((response) => response.json());
      assert.equal(query.rootPath, fixture.indexRoot);
      assert.ok(query.result.groups.length > 0);

      const context = await fetch(`http://127.0.0.1:${port}/api/context`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning'
        })
      }).then((response) => response.json());
      assert.equal(context.rootPath, fixture.indexRoot);
      assert.ok(context.result.node || context.result.candidates);

      const impact = await fetch(`http://127.0.0.1:${port}/api/impact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            direction: 'downstream',
            maxDepth: 2
          }
        })
      }).then((response) => response.json());
      assert.equal(impact.rootPath, fixture.indexRoot);
      assert.equal(impact.result.direction, 'downstream');

      const ideas = await fetch(`http://127.0.0.1:${port}/api/ideas`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            limit: 5
          }
        })
      }).then((response) => response.json());
      assert.equal(ideas.rootPath, fixture.indexRoot);
      assert.ok(ideas.result.ideas.length > 0);

      const brainstorm = await fetch(`http://127.0.0.1:${port}/api/brainstorm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            mode: 'converge',
            limit: 5,
            maxHops: 2
          }
        })
      }).then((response) => response.json());
      assert.equal(brainstorm.rootPath, fixture.indexRoot);
      assert.equal(brainstorm.result.mode, 'converge');
      assert.ok(brainstorm.result.convergedDirections.length > 0);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});
