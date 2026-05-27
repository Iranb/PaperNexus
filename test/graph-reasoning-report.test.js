import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildGraphReasoningReport,
  GRAPH_REASONING_REPORT_MANIFEST_VERSION,
  GRAPH_REASONING_REPORT_VERSION,
  writeGraphReasoningReportArtifacts
} from '../src/core/eval/graph-reasoning-report.js';
import { buildIdeaCatalystReleaseGateManifest } from '../src/core/eval/release-gate-manifest.js';
import { prepareGraphReasoningReportCli } from '../scripts/prepare-graph-reasoning-report.mjs';

function graphFixture() {
  return {
    graph: {
      nodes: [
        { id: 'challenge:bias', type: 'Challenge', name: 'biased feedback loops in tutoring systems' },
        { id: 'method:reflective-prompts', type: 'Method', name: 'reflective prompts for belief calibration' },
        { id: 'paper:distractor', type: 'Paper', title: 'confirmation bias tutoring overview' },
        { id: 'takeaway:calibration', type: 'Takeaway', name: 'calibrated reflection reduces belief lock-in' }
      ],
      relationships: [
        { id: 'r1', sourceId: 'challenge:bias', targetId: 'method:reflective-prompts', type: 'ADDRESSED_BY' },
        { id: 'r2', sourceId: 'method:reflective-prompts', targetId: 'takeaway:calibration', type: 'HAS_TAKEAWAY' }
      ]
    }
  };
}

function tasksFixture() {
  return {
    tasks: [{
      id: 'q1',
      query: 'mitigate confirmation bias in tutoring',
      seed_node_ids: ['challenge:bias'],
      gold_node_ids: ['method:reflective-prompts']
    }]
  };
}

function summariesFixture() {
  return {
    summaries: [{
      id: 'community:calibration',
      type: 'community_summary',
      node_ids: ['method:reflective-prompts'],
      summary: 'Reflective prompts mitigate confirmation bias in tutoring by forcing belief calibration.'
    }]
  };
}

test('graph reasoning report defaults to incomplete contract evidence', () => {
  const report = buildGraphReasoningReport({
    graph: graphFixture(),
    tasks: tasksFixture(),
    summaries: summariesFixture(),
    runId: 'graph-reasoning-default',
    generatedAt: '2026-05-26T00:00:00.000Z',
    topK: 1
  });

  assert.equal(report.contractVersion, GRAPH_REASONING_REPORT_VERSION);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.diagnostics.evaluableTaskCount, 1);
  assert.equal(report.metrics.retrieval_score_delta, 1);
  assert.ok(report.metrics.graph_reasoning_score_delta > 0);
  assert.equal(report.metrics.global_local_summary_delta, 1);
  assert.equal(report.gates.find((entry) => entry.name === 'release_provenance_complete').status, 'incomplete');
  assert.match(report.releaseGate.notes[0], /not release-pass evidence/);
});

test('graph reasoning report can pass only with explicit release provenance', () => {
  const report = buildGraphReasoningReport({
    graph: graphFixture(),
    tasks: tasksFixture(),
    summaries: summariesFixture(),
    runId: 'graph-reasoning-release',
    generatedAt: '2026-05-26T00:00:00.000Z',
    topK: 1,
    benchmarkName: 'SciRepEval OAG-Bench GraphRAG-Bench release slice',
    benchmarkFormat: 'scirepeval-oag-graphrag',
    datasetSource: 'https://benchmarks.papernexus.org/scirepeval-oag-graphrag/2026-05-26',
    licenseScope: 'public benchmark research use',
    releaseEvidence: true
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.benchmark.source, 'https://benchmarks.papernexus.org/scirepeval-oag-graphrag/2026-05-26');
  assert.deepEqual(report.inputs.map((entry) => entry.role), [
    'graph_snapshot',
    'graph_reasoning_tasks',
    'graphrag_summaries'
  ]);
  assert.ok(report.inputs.every((entry) => entry.sha256));
  const releaseGate = buildIdeaCatalystReleaseGateManifest({
    graphReasoningReports: [report],
    replaySuites: [],
    ablationManifests: [],
    humanAggregations: []
  });
  const e5 = releaseGate.requirements.find((entry) => entry.id === 'E5');
  assert.equal(e5.status, 'passed');
});

test('graph reasoning report writer emits report, markdown, and manifest', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-reasoning-'));
  try {
    const graphPath = path.join(tempRoot, 'graph.json');
    const tasksPath = path.join(tempRoot, 'tasks.json');
    const summariesPath = path.join(tempRoot, 'summaries.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(graphPath, `${JSON.stringify(graphFixture(), null, 2)}\n`);
    await fs.writeFile(tasksPath, `${JSON.stringify(tasksFixture(), null, 2)}\n`);
    await fs.writeFile(summariesPath, `${JSON.stringify(summariesFixture(), null, 2)}\n`);

    const result = await writeGraphReasoningReportArtifacts({
      graphPath,
      tasksPath,
      summariesPath,
      outputDir,
      runId: 'graph-reasoning-write',
      topK: 1
    });

    assert.equal(result.manifest.contractVersion, GRAPH_REASONING_REPORT_MANIFEST_VERSION);
    assert.equal(result.report.status, 'incomplete');
    assert.equal(JSON.parse(await fs.readFile(result.manifest.artifacts.reportJsonPath, 'utf8')).runId, 'graph-reasoning-write');
    assert.match(await fs.readFile(result.manifest.artifacts.reportMarkdownPath, 'utf8'), /Graph Reasoning Report/);
    assert.equal(JSON.parse(await fs.readFile(result.manifest.artifacts.manifestPath, 'utf8')).contractVersion, GRAPH_REASONING_REPORT_MANIFEST_VERSION);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph reasoning report CLI supports release-evidence mode', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-reasoning-cli-'));
  try {
    const graphPath = path.join(tempRoot, 'graph.json');
    const tasksPath = path.join(tempRoot, 'tasks.json');
    const summariesPath = path.join(tempRoot, 'summaries.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(graphPath, `${JSON.stringify(graphFixture(), null, 2)}\n`);
    await fs.writeFile(tasksPath, `${JSON.stringify(tasksFixture(), null, 2)}\n`);
    await fs.writeFile(summariesPath, `${JSON.stringify(summariesFixture(), null, 2)}\n`);

    const manifest = await prepareGraphReasoningReportCli([
      '--graph-path', graphPath,
      '--tasks-path', tasksPath,
      '--summaries-path', summariesPath,
      '--output-dir', outputDir,
      '--run-id', 'graph-reasoning-cli',
      '--top-k', '1',
      '--benchmark-name', 'SciRepEval OAG-Bench GraphRAG-Bench release slice',
      '--benchmark-format', 'scirepeval-oag-graphrag',
      '--dataset-source', 'https://benchmarks.papernexus.org/scirepeval-oag-graphrag/2026-05-26',
      '--license-scope', 'public benchmark research use',
      '--release-evidence'
    ]);

    assert.equal(manifest.runId, 'graph-reasoning-cli');
    assert.equal(manifest.status, 'passed');
    assert.equal(JSON.parse(await fs.readFile(manifest.artifacts.reportJsonPath, 'utf8')).status, 'passed');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
