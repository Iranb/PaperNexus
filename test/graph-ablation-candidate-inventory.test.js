import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGraphAblationCandidateInventory } from '../scripts/inspect-graph-ablation-candidates.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeBeirCandidate(rootPath) {
  await fs.mkdir(path.join(rootPath, 'qrels'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'doc-1', title: 'A', text: 'first paper' }),
    JSON.stringify({ _id: 'doc-2', title: 'B', text: 'second paper' })
  ].join('\n') + '\n');
  await fs.writeFile(path.join(rootPath, 'queries.jsonl'), [
    JSON.stringify({ _id: 'q1', text: 'first' }),
    JSON.stringify({ _id: 'q2', text: 'second' })
  ].join('\n') + '\n');
  await fs.writeFile(path.join(rootPath, 'qrels', 'test.tsv'), 'query-id\tcorpus-id\tscore\nq1\tdoc-1\t1\nq2\tdoc-2\t1\n');
}

function paperReadyGraphCandidate(queryCount = 30) {
  return {
    name: 'paper-ready-graph-candidate',
    format: 'custom',
    frozen: true,
    humanReviewRequired: false,
    generationScript: 'scripts/build-frozen-graph-artifact.mjs',
    corpus: [
      { id: 'seed', title: 'Seed paper', abstract: 'source paper' },
      { id: 'target', title: 'Target paper', abstract: 'relevant paper' }
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
      qrels: { target: 1 }
    }))
  };
}

test('graph ablation candidate inventory marks BEIR directories as not paper-ready graph candidates', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-candidate-inventory-'));

  try {
    const candidateDir = path.join(tempRoot, 'beir');
    await writeBeirCandidate(candidateDir);
    const report = await runGraphAblationCandidateInventory({
      runId: 'beir-inventory',
      outputDir: path.join(tempRoot, 'out'),
      minQueries: 3,
      inputs: [candidateDir]
    });

    assert.equal(report.status, 'no_paper_ready_candidate');
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].kind, 'beir_directory');
    assert.equal(report.candidates[0].stats.corpusSize, 2);
    assert.equal(report.candidates[0].stats.queryCount, 2);
    assert.ok(report.candidates[0].gate.reasons.includes('missing_graph_edges'));
    assert.ok(report.candidates[0].gate.reasons.includes('queries_missing_graph_seeds'));
    assert.ok(await fileExists(report.artifacts.tablePath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation candidate inventory surfaces custom JSON candidates that pass preflight', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-candidate-inventory-json-'));

  try {
    const candidatePath = path.join(tempRoot, 'candidate.json');
    await fs.writeFile(candidatePath, `${JSON.stringify(paperReadyGraphCandidate(), null, 2)}\n`);
    const report = await runGraphAblationCandidateInventory({
      runId: 'json-inventory',
      outputDir: path.join(tempRoot, 'out'),
      minQueries: 30,
      inputs: [candidatePath]
    });

    assert.equal(report.status, 'has_paper_ready_candidate');
    assert.equal(report.candidates[0].kind, 'custom_json');
    assert.equal(report.candidates[0].status, 'paper_ready');
    assert.equal(report.candidates[0].stats.queryCount, 30);
    assert.ok(await fileExists(report.candidates[0].preflightReportPath));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation candidate inventory CLI writes table and report artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-candidate-inventory-cli-'));

  try {
    const candidateDir = path.join(tempRoot, 'beir');
    const outputDir = path.join(tempRoot, 'out');
    await writeBeirCandidate(candidateDir);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/inspect-graph-ablation-candidates.mjs'),
      '--run-id', 'cli-inventory',
      '--output-dir', outputDir,
      '--min-queries', '3',
      candidateDir
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-inventory');
    assert.equal(cliReport.status, 'no_paper_ready_candidate');
    assert.equal(cliReport.candidateCount, 1);
    assert.equal(cliReport.paperReadyCandidateCount, 0);
    assert.ok(await fileExists(path.join(outputDir, 'graph-ablation-candidate-inventory.json')));
    assert.ok(await fileExists(path.join(outputDir, 'graph-ablation-candidate-inventory.tsv')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
