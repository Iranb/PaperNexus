import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildDocsSyncReleaseEvidenceReport,
  DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
  REQUIRED_DOCS_SYNC_CHECKS,
  REQUIRED_DOCS_SYNC_INPUTS
} from '../src/core/eval/docs-sync-release-evidence.js';

const execFileAsync = promisify(execFile);

function passedInputs() {
  return REQUIRED_DOCS_SYNC_INPUTS.map((file) => ({
    role: 'required_sync_input',
    relative_path: file,
    path: `/repo/${file}`,
    sha256: `sha-${file}`
  }));
}

function passedChecks() {
  return REQUIRED_DOCS_SYNC_CHECKS.map((check) => ({
    id: check.id,
    label: check.label,
    command: check.command ? [check.command, ...(check.args || [])].join(' ') : `internal:${check.kind}`,
    status: 'passed',
    exit_code: 0,
    duration_ms: 5
  }));
}

test('docs sync release evidence marks docs, snapshots, fixtures, and migration notes as passed', () => {
  const report = buildDocsSyncReleaseEvidenceReport({
    runId: 'docs-sync-fixture',
    generatedAt: '2026-05-27T00:00:00.000Z',
    precheckInputs: passedInputs(),
    inputs: passedInputs(),
    checkRuns: passedChecks()
  });

  assert.equal(report.contractVersion, DOCS_SYNC_RELEASE_EVIDENCE_VERSION);
  assert.equal(report.status, 'passed');
  assert.equal(report.diagnostics.passed_required_check_count, REQUIRED_DOCS_SYNC_CHECKS.length);
  assert.deepEqual(report.diagnostics.failed_required_checks, []);
  assert.deepEqual(report.diagnostics.missing_required_checks, []);
  assert.deepEqual(report.diagnostics.missing_input_hashes, []);
  assert.equal(report.input_stability.checked, true);
  assert.equal(report.input_stability.changed_input_count, 0);
});

test('docs sync release evidence rejects missing checks or input hashes', () => {
  const missingCheck = buildDocsSyncReleaseEvidenceReport({
    inputs: passedInputs(),
    checkRuns: passedChecks().filter((check) => check.id !== 'packet_fixture_drift')
  });

  assert.equal(missingCheck.status, 'incomplete');
  assert.ok(missingCheck.diagnostics.missing_required_checks.includes('packet_fixture_drift'));

  const missingHashes = buildDocsSyncReleaseEvidenceReport({
    inputs: [],
    checkRuns: passedChecks()
  });

  assert.equal(missingHashes.status, 'incomplete');
  assert.ok(missingHashes.diagnostics.missing_input_hashes.includes('docs/eval/idea-catalyst-v2-migration-notes.md'));
});

test('docs sync release evidence fails when a required check fails', () => {
  const failed = buildDocsSyncReleaseEvidenceReport({
    inputs: passedInputs(),
    checkRuns: passedChecks().map((check) => check.id === 'mcp_schema_snapshot'
      ? { ...check, status: 'failed', exit_code: 1 }
      : check)
  });

  assert.equal(failed.status, 'failed');
  assert.ok(failed.diagnostics.failed_required_checks.includes('mcp_schema_snapshot'));
});

test('docs sync release evidence fails when docs build changes required synced inputs', () => {
  const before = passedInputs();
  const after = passedInputs().map((entry) => entry.relative_path === 'docs/reference/generated/mcp-tools.md'
    ? { ...entry, sha256: 'sha-after-docs-build' }
    : entry);
  const drifted = buildDocsSyncReleaseEvidenceReport({
    precheckInputs: before,
    inputs: after,
    checkRuns: passedChecks()
  });

  assert.equal(drifted.status, 'failed');
  assert.equal(drifted.releaseGate.reason, 'docs_sync_inputs_changed_during_checks');
  assert.ok(drifted.diagnostics.changed_input_hashes.includes('docs/reference/generated/mcp-tools.md'));
  assert.equal(drifted.input_stability.changed_input_count, 1);
});

test('docs sync release evidence CLI exposes default required checks', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-docs-sync-release-evidence.mjs',
    '--help'
  ], {
    cwd: process.cwd()
  });

  assert.match(stdout, /docs_build/);
  assert.match(stdout, /mcp_schema_snapshot/);
  assert.match(stdout, /packet_fixture_drift/);
  assert.match(stdout, /migration_notes_present/);
  assert.match(stdout, /--require-passed/);
});
