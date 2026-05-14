import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runGraphProvenanceAudit } from '../scripts/audit-graph-provenance.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('graph provenance audit reports source-span, dangling-link, and quote-match metrics', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-provenance-audit-'));
  const fixturePath = fileURLToPath(new URL('./fixtures/graph-provenance-audit-fixture.json', import.meta.url));

  try {
    const report = await runGraphProvenanceAudit({
      runId: 'test-graph-provenance-audit',
      outputDir: tempRoot,
      inputPaths: [fixturePath]
    });

    assert.equal(report.status, 'completed_with_findings');
    assert.equal(report.metrics.records_total, 4);
    assert.equal(report.metrics.source_span_presence_rate, 0.75);
    assert.equal(report.metrics.exact_quote_presence_rate, 0.75);
    assert.equal(report.metrics.exact_quote_match_rate, 2 / 3);
    assert.equal(report.metrics.dangling_source_link_rate, 0.25);
    assert.equal(report.metrics.schema_violation_count, 0);
    assert.equal(report.metrics.zero_query_time_llm_invariant, true);
    assert.equal(report.failureCounts.MISSING_SOURCE_SPAN, 1);
    assert.equal(report.failureCounts.DANGLING_SOURCE_LINK, 1);
    assert.equal(report.failureCounts.QUOTE_MISMATCH, 1);

    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));
    assert.ok(await fileExists(report.artifacts.failuresPath));

    const failures = await fs.readFile(report.artifacts.failuresPath, 'utf8');
    assert.match(failures, /MISSING_SOURCE_SPAN/);
    assert.match(failures, /DANGLING_SOURCE_LINK/);
    assert.match(failures, /QUOTE_MISMATCH/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph provenance audit CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-provenance-audit-cli-'));
  const fixturePath = fileURLToPath(new URL('./fixtures/graph-provenance-audit-fixture.json', import.meta.url));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/audit-graph-provenance.mjs'),
      '--input', fixturePath,
      '--output-dir', tempRoot,
      '--run-id', 'cli-graph-provenance-audit'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-graph-provenance-audit');
    assert.equal(cliReport.status, 'completed_with_findings');
    assert.equal(cliReport.outputDir, tempRoot);
    assert.equal(cliReport.metrics.records_total, 4);
    assert.ok(await fileExists(path.join(tempRoot, 'report.json')));
    assert.ok(await fileExists(path.join(tempRoot, 'report.md')));
    assert.ok(await fileExists(path.join(tempRoot, 'failures.jsonl')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
