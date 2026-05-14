import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGraphAblationPaperClaimPipeline } from '../scripts/run-graph-ablation-paper-claim-pipeline.mjs';

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
  return {
    name: 'pipeline-graph-artifact-fixture',
    format: 'custom',
    frozen: true,
    humanReviewRequired: false,
    generationScript: 'scripts/build-frozen-graph-artifact.mjs',
    corpus: [
      {
        id: 'seed',
        title: 'Graph retrieval seed paper',
        abstract: 'A seed paper for relation-aware graph retrieval.'
      },
      {
        id: 'target',
        title: 'Neighborhood reranking for scholarly discovery',
        abstract: 'Citation neighborhood evidence improves scientific paper discovery.'
      },
      {
        id: 'decoy',
        title: 'Graph retrieval survey',
        abstract: 'A broad survey of graph retrieval systems.'
      }
    ],
    graph: {
      edges: [
        { source: 'seed', target: 'target', type: 'uses' }
      ]
    },
    queries: Array.from({ length: queryCount }, (_, index) => ({
      id: `q${index + 1}`,
      query: `graph retrieval ${index + 1}`,
      graphSeeds: ['seed'],
      relevant: [{ id: 'target', title: 'Neighborhood reranking for scholarly discovery' }]
    }))
  };
}

test('graph ablation paper claim pipeline refuses to run ablation when preflight fails', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-claim-pipeline-blocked-'));

  try {
    const report = await runGraphAblationPaperClaimPipeline({
      runId: 'blocked-pipeline',
      outputDir: tempRoot,
      benchmark: {
        ...graphArtifactFixture(1),
        frozen: false,
        syntheticGraph: true
      },
      minQueries: 30
    });

    assert.equal(report.status, 'blocked_by_preflight');
    assert.equal(report.evidenceClass, 'engineering_diagnostic');
    assert.equal(report.paperIntegrationRequired, undefined);
    assert.ok(report.preflight.gate.reasons.includes('query_count_below_30'));
    assert.ok(report.preflight.gate.reasons.includes('artifact_not_marked_frozen'));
    assert.equal(await fileExists(path.join(tempRoot, 'graph-ranking-ablation', 'report.json')), false);
    assert.ok(await fileExists(report.artifacts.reportPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation paper claim pipeline runs ablation after a passing preflight', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-claim-pipeline-pass-'));

  try {
    const report = await runGraphAblationPaperClaimPipeline({
      runId: 'passing-pipeline',
      outputDir: tempRoot,
      benchmark: graphArtifactFixture(30),
      minQueries: 30,
      modes: ['text-only', 'graph-only'],
      cutoffs: [1, 10],
      maxCandidates: 3
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.evidenceClass, 'paper_ready');
    assert.equal(report.paperIntegrationRequired, true);
    assert.equal(report.preflight.status, 'paper_ready');
    assert.equal(report.ablation.status, 'completed');
    assert.deepEqual(report.ablation.modeSummaries.map((summary) => summary.mode), ['text-only', 'graph-only']);
    assert.ok(await fileExists(report.ablation.reportPath));
    assert.ok(await fileExists(report.ablation.summaryTsvPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation paper claim pipeline CLI blocks not-for-paper template inputs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-claim-pipeline-cli-'));

  try {
    const artifactPath = path.join(tempRoot, 'candidate.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(artifactPath, `${JSON.stringify({
      ...graphArtifactFixture(1),
      frozen: false,
      syntheticGraph: true
    }, null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/run-graph-ablation-paper-claim-pipeline.mjs'),
      '--dataset-path', artifactPath,
      '--run-id', 'cli-blocked-pipeline',
      '--output-dir', outputDir,
      '--min-queries', '30'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.status, 'blocked_by_preflight');
    assert.equal(cliReport.paperIntegrationRequired, false);
    assert.ok(await fileExists(path.join(outputDir, 'graph-ablation-paper-claim-pipeline.json')));
    assert.equal(await fileExists(path.join(outputDir, 'graph-ranking-ablation', 'report.json')), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
