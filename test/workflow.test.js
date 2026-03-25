import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

let tempHome;
let tempCorpusRoot;
let analysisResult;
let liteCorpus;
let getCorpusPaths;
let buildBrainstorm;
let buildImpact;
let resolveGraphStorageMode;

before(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-home-'));
  tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-corpus-'));
  process.env.PAPERNEXUS_HOME = tempHome;

  const exampleFiles = [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ];

  for (const fileName of exampleFiles) {
    await fs.copyFile(
      path.join(examplesRoot, fileName),
      path.join(tempCorpusRoot, fileName)
    );
  }

  const [{ analyzeCorpus }, corpusStore, searchModule] = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/storage/corpus-store.js'),
    import('../src/core/search/search.js')
  ]);

  getCorpusPaths = corpusStore.getCorpusPaths;
  resolveGraphStorageMode = corpusStore.resolveGraphStorageMode;
  buildBrainstorm = searchModule.buildBrainstorm;
  buildImpact = searchModule.buildImpact;

  analysisResult = await analyzeCorpus(tempCorpusRoot, {
    name: 'test-papers',
    force: true
  });

  liteCorpus = await corpusStore.loadCorpusLite(tempCorpusRoot);
});

after(async () => {
  await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  await fs.rm(tempHome, { recursive: true, force: true });
});

test('analyzeCorpus builds an explicit multilayer graph and writes lite storage', async () => {
  const storageMode = await resolveGraphStorageMode();

  assert.equal(analysisResult.meta.graphMode, 'explicit-multilayer');
  assert.equal(analysisResult.meta.storageMode, storageMode);
  assert.equal(analysisResult.meta.paperCount, 2);
  assert.ok(analysisResult.meta.layers?.ProblemLayer > 0);
  assert.ok(analysisResult.meta.layerPaths);

  const paths = getCorpusPaths(tempCorpusRoot);
  await assert.doesNotReject(fs.access(
    storageMode === 'kuzu+lite-index' ? paths.kuzuGraphPath : paths.graphPath
  ));
  await assert.doesNotReject(fs.access(paths.liteGraphPath));
  const litePayload = JSON.parse(await fs.readFile(paths.liteGraphPath, 'utf8'));

  assert.ok(
    liteCorpus.graph.relationships.some((relationship) => relationship.properties?.layerPath),
    'expected lite graph relationships to preserve layer path metadata'
  );
  assert.ok(analysisResult.meta.brainstormView?.eligibleNodeCount > 0);
  assert.ok(litePayload.views?.brainstorm?.nodeCount > 0);
});

test('brainstorm diverge/converge surfaces research branches from the lite graph', () => {
  const diverged = buildBrainstorm(liteCorpus.graph, 'experiment planning', {
    mode: 'diverge',
    maxHops: 2
  });

  assert.equal(diverged.mode, 'diverge');
  assert.ok(diverged.seedPapers.length > 0);
  assert.ok(diverged.similarProblems.length > 0);
  assert.ok(diverged.relatedConcepts.length > 0);

  const converged = buildBrainstorm(liteCorpus.graph, 'experiment planning', {
    mode: 'converge',
    maxHops: 2,
    limit: 5,
    layers: 'ProblemLayer,MethodLayer,ConstraintLayer',
    layerMode: 'cross'
  });

  assert.equal(converged.mode, 'converge');
  assert.ok(converged.convergedDirections.length > 0);
  assert.ok(converged.ideas.length > 0);
});

test('impact traversal respects multilayer filters', () => {
  const impact = buildImpact(liteCorpus.graph, 'experiment planning', {
    direction: 'downstream',
    maxDepth: 2,
    layers: 'ProblemLayer,MethodLayer',
    layerMode: 'cross'
  });

  assert.ok(impact.node, 'expected impact root node to resolve');
  assert.ok(impact.byDepth.length > 0, 'expected at least one impact bucket');

  for (const bucket of impact.byDepth) {
    for (const node of bucket.nodes) {
      assert.ok(['ProblemLayer', 'MethodLayer'].includes(node.layer));
    }
  }
});
