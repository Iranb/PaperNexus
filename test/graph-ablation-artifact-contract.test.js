import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGraphAblationArtifactContract } from '../scripts/generate-graph-ablation-artifact-contract.mjs';
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

test('graph ablation artifact contract writes schema, markdown, and not-for-paper template', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-artifact-contract-'));

  try {
    const report = await runGraphAblationArtifactContract({
      runId: 'contract-test',
      outputDir: tempRoot
    });

    assert.equal(report.status, 'completed');
    assert.ok(await fileExists(report.artifacts.contractPath));
    assert.ok(await fileExists(report.artifacts.markdownPath));
    assert.ok(await fileExists(report.artifacts.templatePath));
    assert.ok(await fileExists(report.artifacts.manifestPath));

    const contract = JSON.parse(await fs.readFile(report.artifacts.contractPath, 'utf8'));
    assert.ok(contract.requiredTopLevelFields.includes('graph.edges'));
    assert.ok(contract.paperReadyRequirements.some((entry) => entry.includes('graphSeeds')));

    const templatePreflight = await runGraphAblationArtifactPreflight({
      runId: 'contract-template-preflight',
      outputDir: path.join(tempRoot, 'preflight'),
      datasetPath: report.artifacts.templatePath,
      minQueries: 30
    });
    assert.equal(templatePreflight.status, 'not_paper_ready');
    assert.ok(templatePreflight.gate.reasons.includes('artifact_marked_synthetic'));
    assert.ok(templatePreflight.gate.reasons.includes('artifact_not_marked_frozen'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('graph ablation artifact contract CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-graph-artifact-contract-cli-'));

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/generate-graph-ablation-artifact-contract.mjs'),
      '--run-id', 'contract-cli',
      '--output-dir', tempRoot
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'contract-cli');
    assert.equal(cliReport.status, 'completed');
    assert.ok(await fileExists(path.join(tempRoot, 'graph-ablation-artifact-contract.json')));
    assert.ok(await fileExists(path.join(tempRoot, 'graph-ablation-artifact-template.not-paper-ready.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
