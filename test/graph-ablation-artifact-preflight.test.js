import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGraphAblationArtifactPreflight } from '../scripts/prepare-graph-ablation-artifact.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function graphArtifactFixture(queryCount = 30) {
  const corpus = [
    {
      id: 'seed',
      title: 'Source paper for graph-aware retrieval',
      abstract: 'A stable source paper for graph expansion.'
    },
    {
      id: 'target',
      title: 'Graph evidence improves retrieval',
      abstract: 'A relevant paper connected by typed graph evidence.'
    }
  ];
  const queries = Array.from({ length: queryCount }, (_, index) => ({
    id: `q${index + 1}`,
    query: `graph evidence retrieval ${index + 1}`,
    graphSeeds: ['seed'],
    relevant: [{ id: 'target', title: 'Graph evidence improves retrieval' }]
  }));

  return {
    name: 'frozen-graph-artifact-fixture',
    format: 'custom',
    frozen: true,
    humanReviewRequired: false,
    generationScript: 'scripts/build-frozen-graph-artifact.mjs',
    corpus,
    graph: {
      edges: [
        { source: 'seed', target: 'target', type: 'uses' }
      ]
    },
    queries
  };
}

test('graph ablation artifact preflight passes a frozen graph-aware benchmark', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-artifact-preflight-'));

  try {
    const report = await runGraphAblationArtifactPreflight({
      runId: 'paper-ready-graph-artifact',
      outputDir: tempRoot,
      benchmark: graphArtifactFixture(30),
      minQueries: 30
    });

    assert.equal(report.status, 'paper_ready');
    assert.equal(report.evidenceClass, 'paper_ready');
    assert.deepEqual(report.gate.reasons, []);
    assert.equal(report.stats.queryCount, 30);
    assert.equal(report.stats.graphEdgeCount, 1);
    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));
    assert.ok(await fileExists(report.artifacts.manifestPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation artifact preflight fails closed for fixture-sized or synthetic inputs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-artifact-preflight-fail-'));

  try {
    const fixture = {
      ...graphArtifactFixture(1),
      syntheticGraph: true,
      humanReviewRequired: true,
      generationScript: ''
    };
    const report = await runGraphAblationArtifactPreflight({
      runId: 'not-paper-ready-graph-artifact',
      outputDir: tempRoot,
      benchmark: fixture,
      minQueries: 30
    });

    assert.equal(report.status, 'not_paper_ready');
    assert.equal(report.evidenceClass, 'engineering_diagnostic');
    assert.ok(report.gate.reasons.includes('query_count_below_30'));
    assert.ok(report.gate.reasons.includes('artifact_marked_synthetic'));
    assert.ok(report.gate.reasons.includes('manual_review_boundary_not_false'));
    assert.ok(report.gate.reasons.includes('missing_generation_script'));

    const markdown = await fs.readFile(report.artifacts.reportMarkdownPath, 'utf8');
    assert.match(markdown, /must not be promoted to a paper graph-performance claim/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation artifact preflight CLI writes artifacts from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-artifact-preflight-cli-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(graphArtifactFixture(30), null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-graph-ablation-artifact.mjs'),
      '--dataset-path', benchmarkPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-graph-artifact-preflight',
      '--min-queries', '30'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-graph-artifact-preflight');
    assert.equal(cliReport.status, 'paper_ready');
    assert.deepEqual(cliReport.gateReasons, []);
    assert.ok(await fileExists(path.join(outputDir, 'graph-ablation-artifact-preflight.json')));
    assert.ok(await fileExists(path.join(outputDir, 'graph-ablation-artifact-manifest.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
