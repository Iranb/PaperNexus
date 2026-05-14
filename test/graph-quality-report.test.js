import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runGraphQualityImprovementReport } from '../scripts/generate-graph-quality-report.mjs';

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('graph quality report emits fixture-only appendix table with explicit gate', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-quality-report-'));

  try {
    const report = await runGraphQualityImprovementReport({
      runId: 'test-graph-quality-report',
      outputDir: tempRoot
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.scope, 'fixture-and-small-gold');
    assert.equal(report.paperAppendix.claimClass, 'fixture_only');
    assert.equal(report.paperAppendix.gate, 'not_paper_ready');
    assert.ok(report.paperAppendix.graphRankingAblationRows.length >= 3);
    assert.ok(await fileExists(report.artifacts.graphRankingAppendixTablePath));
    assert.ok(await fileExists(report.artifacts.summaryPath));
    assert.ok(await fileExists(report.artifacts.manifestPath));

    const table = await fs.readFile(report.artifacts.graphRankingAppendixTablePath, 'utf8');
    assert.match(table, /mode\tscope\tgate/);
    assert.match(table, /hybrid\tfixture_only\tnot_paper_ready/);
    assert.match(table, /hybrid\+all\tfixture_only\tnot_paper_ready/);
    assert.match(table, /hit@10_delta_vs_hybrid/);

    const manifest = JSON.parse(await fs.readFile(report.artifacts.manifestPath, 'utf8'));
    assert.equal(manifest.paperAppendix.claimClass, 'fixture_only');
    assert.equal(manifest.paperAppendix.gate, 'not_paper_ready');

    const summary = await fs.readFile(report.artifacts.summaryPath, 'utf8');
    assert.match(summary, /graph-ranking-ablation-table\.tsv/);
    assert.match(summary, /fixture_only/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
