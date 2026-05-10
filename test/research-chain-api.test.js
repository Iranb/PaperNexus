import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function createResearchApiFixture() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-research-api-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-research-api-workspace-'));
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

  const [ingestion, worker, corpusStore] = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/core/enhancements/worker.js'),
    import('../src/storage/corpus-store.js')
  ]);

  await ingestion.analyzeCorpus(inputRoot, {
    rootPath: indexRoot,
    name: 'research-api-test',
    force: true
  });

  await worker.runEnhancementQueueUntilIdle(indexRoot, {
    maxPasses: 8,
    backfillLimit: 2
  });

  const liteCorpus = await corpusStore.loadCorpusLite(indexRoot);
  const paperNode = liteCorpus.graph.nodes.find((node) => node.type === 'Paper');
  const outgoing = typeof liteCorpus.graph.getOutgoing === 'function'
    ? liteCorpus.graph.getOutgoing(paperNode.id)
    : liteCorpus.graph.relationships.filter((relationship) => relationship.sourceId === paperNode.id);
  const targetRelation = outgoing.find((relationship) => {
    const target = liteCorpus.graph.getNode(relationship.targetId);
    return target && ['Problem', 'Method', 'Claim', 'Evidence', 'Limitation'].includes(target.type);
  });
  const targetNode = targetRelation ? liteCorpus.graph.getNode(targetRelation.targetId) : null;

  return {
    tempHome,
    workspaceRoot,
    indexRoot,
    previousHome,
    paperNode,
    targetNode
  };
}

async function cleanupResearchApiFixture(fixture) {
  if (fixture.previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = fixture.previousHome;
  await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
}

test('second-layer research API helpers return structured chain and brief payloads', async () => {
  const fixture = await createResearchApiFixture();

  try {
    const api = await import('../src/server/api.js');

    const pathTrace = await api.pathTraceGraphPayload(fixture.indexRoot, {
      from: fixture.paperNode.id,
      to: fixture.targetNode.id,
      options: {
        maxDepth: 4,
        maxPaths: 3
      }
    });
    assert.equal(pathTrace.rootPath, fixture.indexRoot);
    assert.equal(pathTrace.result.paths[0].nodes[0].id, fixture.paperNode.id);
    assert.equal(pathTrace.result.paths[0].nodes.at(-1).id, fixture.targetNode.id);

    const evidenceChain = await api.evidenceChainPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 3
      }
    });
    assert.equal(evidenceChain.rootPath, fixture.indexRoot);
    assert.ok(evidenceChain.result.chains.length > 0);
    assert.ok(evidenceChain.result.chains[0].paper.paperId);

    const methodEvidence = await api.methodEvidencePayload(fixture.indexRoot, {
      method: 'experiment planning',
      limit: 3
    });
    assert.equal(methodEvidence.rootPath, fixture.indexRoot);
    assert.equal(methodEvidence.result.contractVersion, 'papernexus-method-evidence-v1');
    assert.equal(methodEvidence.result.diagnostics.queryTimeLlmCalls, 0);

    const methodLineage = await api.methodLineagePayload(fixture.indexRoot, {
      method: 'experiment planning',
      direction: 'backward',
      maxDepth: 2,
      limit: 3
    });
    assert.equal(methodLineage.rootPath, fixture.indexRoot);
    assert.equal(methodLineage.result.contractVersion, 'papernexus-method-evolution-lineage-v1');
    assert.equal(methodLineage.result.diagnostics.queryTimeLlmCalls, 0);

    const methodRegistry = await api.methodRegistryPayload(fixture.indexRoot);
    assert.equal(methodRegistry.rootPath, fixture.indexRoot);
    assert.equal(methodRegistry.result.contractVersion, 'papernexus-method-registry-v1');
    assert.ok(Array.isArray(methodRegistry.result.registry.methods));
    assert.equal(methodRegistry.result.diagnostics.queryTimeLlmCalls, 0);

    const reflectionChain = await api.reflectionChainPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 3
      }
    });
    assert.equal(reflectionChain.rootPath, fixture.indexRoot);
    assert.ok(reflectionChain.result.chains.length > 0);
    assert.ok(Array.isArray(reflectionChain.result.chains[0].innovations));

    const theoryBrief = await api.theoryBriefPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 2
      }
    });
    assert.equal(theoryBrief.rootPath, fixture.indexRoot);
    assert.ok(theoryBrief.result.papers.length > 0);
    assert.ok(Array.isArray(theoryBrief.result.papers[0].supportNote));

    const storylineBrief = await api.storylineBriefPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 2
      }
    });
    assert.equal(storylineBrief.rootPath, fixture.indexRoot);
    assert.ok(storylineBrief.result.papers.length > 0);
    assert.ok(Array.isArray(storylineBrief.result.papers[0].beats));

    const researchBrief = await api.researchBriefPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 3
      }
    });
    assert.equal(researchBrief.rootPath, fixture.indexRoot);
    assert.ok(researchBrief.result.querySummary.groups.length > 0);
    assert.ok(Array.isArray(researchBrief.result.evidenceChains.chains));
    assert.ok(Array.isArray(researchBrief.result.reflectionChains.chains));

    const brainstormBrief = await api.brainstormBriefPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 3,
        maxHops: 2
      }
    });
    assert.equal(brainstormBrief.rootPath, fixture.indexRoot);
    assert.ok(Array.isArray(brainstormBrief.result.directions));
    assert.ok(brainstormBrief.result.directions.length > 0);
    assert.ok(Array.isArray(brainstormBrief.result.supportingChains));
  } finally {
    await cleanupResearchApiFixture(fixture);
  }
});

test('serveCommand exposes authenticated second-layer research APIs', async () => {
  const fixture = await createResearchApiFixture();
  const port = 53000 + Math.floor(Math.random() * 1000);

  try {
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: fixture.indexRoot
        },
        serve: {
          apiToken: 'test'
        }
      },
      configBaseDir: fixture.workspaceRoot
    });

    try {
      const headers = {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json'
      };

      const pathTrace = await fetch(`http://127.0.0.1:${port}/api/path-trace`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: fixture.paperNode.id,
          to: fixture.targetNode.id,
          options: {
            maxDepth: 4,
            maxPaths: 3
          }
        })
      }).then((response) => response.json());
      assert.ok(pathTrace.result.paths.length > 0);

      const evidenceChain = await fetch(`http://127.0.0.1:${port}/api/evidence-chain`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: { limit: 3 }
        })
      }).then((response) => response.json());
      assert.ok(evidenceChain.result.chains.length > 0);

      const methodEvidence = await fetch(`http://127.0.0.1:${port}/api/method-evidence`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          method: 'experiment planning',
          limit: 3
        })
      }).then((response) => response.json());
      assert.equal(methodEvidence.result.contractVersion, 'papernexus-method-evidence-v1');
      assert.equal(methodEvidence.result.diagnostics.queryTimeLlmCalls, 0);

      const methodLineage = await fetch(`http://127.0.0.1:${port}/api/method-lineage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          method: 'experiment planning',
          direction: 'backward',
          maxDepth: 2,
          limit: 3
        })
      }).then((response) => response.json());
      assert.equal(methodLineage.result.contractVersion, 'papernexus-method-evolution-lineage-v1');
      assert.equal(methodLineage.result.diagnostics.queryTimeLlmCalls, 0);

      const methodRegistry = await fetch(`http://127.0.0.1:${port}/api/method-registry`, {
        headers
      }).then((response) => response.json());
      assert.equal(methodRegistry.result.contractVersion, 'papernexus-method-registry-v1');
      assert.ok(Array.isArray(methodRegistry.result.registry.methods));
      assert.equal(methodRegistry.result.diagnostics.queryTimeLlmCalls, 0);

      const reflectionChain = await fetch(`http://127.0.0.1:${port}/api/reflection-chain`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: { limit: 3 }
        })
      }).then((response) => response.json());
      assert.ok(reflectionChain.result.chains.length > 0);

      const theoryBrief = await fetch(`http://127.0.0.1:${port}/api/theory-brief`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: { limit: 2 }
        })
      }).then((response) => response.json());
      assert.ok(theoryBrief.result.papers.length > 0);

      const storylineBrief = await fetch(`http://127.0.0.1:${port}/api/storyline-brief`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: { limit: 2 }
        })
      }).then((response) => response.json());
      assert.ok(storylineBrief.result.papers.length > 0);

      const researchBrief = await fetch(`http://127.0.0.1:${port}/api/research-brief`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: { limit: 3 }
        })
      }).then((response) => response.json());
      assert.ok(researchBrief.result.querySummary.groups.length > 0);

      const brainstormBrief = await fetch(`http://127.0.0.1:${port}/api/brainstorm-brief`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            limit: 3,
            maxHops: 2
          }
        })
      }).then((response) => response.json());
      assert.ok(brainstormBrief.result.directions.length > 0);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    await cleanupResearchApiFixture(fixture);
  }
});
