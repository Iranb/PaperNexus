import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runGraphIdentityDiagnostics } from '../scripts/diagnose-graph-identity.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('graph identity diagnostics reports duplicate canonical keys, aliases, and identifier conflicts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-identity-diagnostics-'));
  const fixturePath = fileURLToPath(new URL('./fixtures/graph-identity-diagnostics-fixture.json', import.meta.url));

  try {
    const report = await runGraphIdentityDiagnostics({
      runId: 'test-graph-identity-diagnostics',
      outputDir: tempRoot,
      inputPath: fixturePath
    });

    assert.equal(report.status, 'completed_with_findings');
    assert.equal(report.metrics.nodes_total, 7);
    assert.equal(report.metrics.duplicate_canonical_key_count, 1);
    assert.equal(report.metrics.unresolved_alias_count, 1);
    assert.equal(report.metrics.title_only_merge_count, 1);
    assert.equal(report.metrics.conflicting_identifier_count, 1);
    assert.equal(report.metrics.method_alias_collision_count, 1);
    assert.equal(report.byType.paper.nodeCount, 4);
    assert.equal(report.byType.method.nodeCount, 2);
    assert.equal(report.byType.task.nodeCount, 1);

    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));
    assert.ok(await fileExists(report.artifacts.failuresPath));

    const failures = await fs.readFile(report.artifacts.failuresPath, 'utf8');
    assert.match(failures, /DUPLICATE_CANONICAL_KEY/);
    assert.match(failures, /TITLE_ONLY_MERGE/);
    assert.match(failures, /CONFLICTING_IDENTIFIER/);
    assert.match(failures, /METHOD_ALIAS_COLLISION/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph identity diagnostics CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-identity-diagnostics-cli-'));
  const fixturePath = fileURLToPath(new URL('./fixtures/graph-identity-diagnostics-fixture.json', import.meta.url));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/diagnose-graph-identity.mjs'),
      '--input', fixturePath,
      '--output-dir', tempRoot,
      '--run-id', 'cli-graph-identity-diagnostics'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-graph-identity-diagnostics');
    assert.equal(cliReport.status, 'completed_with_findings');
    assert.equal(cliReport.outputDir, tempRoot);
    assert.equal(cliReport.metrics.nodes_total, 7);
    assert.ok(await fileExists(path.join(tempRoot, 'report.json')));
    assert.ok(await fileExists(path.join(tempRoot, 'report.md')));
    assert.ok(await fileExists(path.join(tempRoot, 'failures.jsonl')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
