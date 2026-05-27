import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  createReplayReleaseEvidenceSkeleton,
  REPLAY_RELEASE_EVIDENCE_SKELETON_VERSION,
  REQUIRED_REPLAY_RELEASE_FAMILIES,
  REQUIRED_REPLAY_RELEASE_METADATA_FIELDS
} from '../src/core/eval/replay-release-skeleton.js';

const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('replay release evidence skeleton creates manifest, TODO, and directories only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-release-skeleton-'));
  const result = await createReplayReleaseEvidenceSkeleton({
    outputDir: root,
    runId: 'r1-skeleton-test',
    generatedAt: '2026-05-27T00:00:00.000Z'
  });
  const manifestPath = path.join(root, 'replay-release-evidence-skeleton.json');
  const todoPath = path.join(root, 'R1-REPLAY-EVIDENCE-TODO.md');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const todo = await fs.readFile(todoPath, 'utf8');

  assert.equal(result.status, 'skeleton_created');
  assert.equal(manifest.contractVersion, REPLAY_RELEASE_EVIDENCE_SKELETON_VERSION);
  assert.equal(manifest.runId, 'r1-skeleton-test');
  assert.equal(manifest.status, 'skeleton');
  assert.equal(manifest.families.length, REQUIRED_REPLAY_RELEASE_FAMILIES.length);
  assert.deepEqual(manifest.required_metadata_fields, REQUIRED_REPLAY_RELEASE_METADATA_FIELDS);
  assert.match(todo, /This directory is only a scaffold/);
  assert.match(todo, /MasterSet/);
  assert.match(todo, /CLAIMCHECK/);
  assert.match(todo, /OpenReview/);
  assert.match(todo, /eval:idea-catalyst-replay-suite/);

  for (const family of manifest.families) {
    assert.equal(family.required_metadata_fields.length, REQUIRED_REPLAY_RELEASE_METADATA_FIELDS.length);
    assert.equal(await exists(path.join(root, 'reports', family.slug)), true);
    assert.match(family.command_template, /--thresholds-json @thresholds\//);
    assert.match(family.command_template, /--statistical-significance-json @statistics\//);
    assert.match(family.command_template, /--dataset-source <source-url-or-snapshot-id>/);
    assert.match(family.command_template, /--license-scope <license-or-internal-scope>/);
    assert.match(family.command_template, /--holdout-policy <venue-year-holdout-policy>/);
    assert.match(family.command_template, /--time-slice-policy <openalex-s2orc-reference-cutoff-policy>/);
  }

  assert.equal(await exists(path.join(root, 'raw-inputs', 'masterset.json')), false);
  assert.equal(await exists(path.join(root, 'normalized-datasets', 'masterset-replay.json')), false);
  assert.equal(await exists(path.join(root, 'statistics', 'masterset-statistical-significance.json')), false);
  assert.equal(await exists(path.join(root, 'reports', 'masterset', 'replay-suite-manifest.json')), false);
});

test('replay release evidence skeleton CLI exposes release families and metadata fields', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-replay-release-evidence-skeleton.mjs',
    '--help'
  ], {
    cwd: process.cwd()
  });

  assert.match(stdout, /MasterSet/);
  assert.match(stdout, /NovBench/);
  assert.match(stdout, /RINoBench/);
  assert.match(stdout, /CLAIM-BENCH/);
  assert.match(stdout, /OpenReview/);
  assert.match(stdout, /source, license_scope, raw_input_sha256/);
  assert.match(stdout, /--output-dir DIR/);
  assert.match(stdout, /--run-id ID/);
});

test('replay release evidence skeleton CLI creates non-evidence scaffold', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-replay-release-skeleton-cli-'));
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-replay-release-evidence-skeleton.mjs',
    '--output-dir',
    root,
    '--run-id',
    'r1-cli-skeleton'
  ], {
    cwd: process.cwd()
  });
  const result = JSON.parse(stdout);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'replay-release-evidence-skeleton.json'), 'utf8'));

  assert.equal(result.status, 'skeleton_created');
  assert.equal(manifest.runId, 'r1-cli-skeleton');
  assert.equal(manifest.families.length, 10);
  assert.equal(await exists(path.join(root, 'R1-REPLAY-EVIDENCE-TODO.md')), true);
  assert.equal(await exists(path.join(root, 'reports', 'claimcheck', 'replay-suite-manifest.json')), false);
});
