import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  buildEngineeringReleaseEvidenceReport,
  ENGINEERING_RELEASE_EVIDENCE_VERSION,
  REQUIRED_ENGINEERING_TESTS
} from '../src/core/eval/engineering-release-evidence.js';

const execFileAsync = promisify(execFile);

function passedInputs() {
  return REQUIRED_ENGINEERING_TESTS.map((file) => ({
    role: 'required_test_file',
    path: `/repo/${file}`,
    sha256: `sha-${file}`
  }));
}

test('engineering release evidence marks required named tests as passed', () => {
  const report = buildEngineeringReleaseEvidenceReport({
    runId: 'engineering-release-fixture',
    generatedAt: '2026-05-27T00:00:00.000Z',
    inputs: passedInputs(),
    testRuns: REQUIRED_ENGINEERING_TESTS.map((file) => ({
      test_file: file,
      command: `${process.execPath} --test ${file}`,
      status: 'passed',
      exit_code: 0,
      duration_ms: 5
    }))
  });

  assert.equal(report.contractVersion, ENGINEERING_RELEASE_EVIDENCE_VERSION);
  assert.equal(report.status, 'passed');
  assert.equal(report.diagnostics.passed_required_test_count, REQUIRED_ENGINEERING_TESTS.length);
  assert.deepEqual(report.diagnostics.failed_required_tests, []);
  assert.deepEqual(report.diagnostics.missing_required_tests, []);
  assert.deepEqual(report.diagnostics.missing_input_hashes, []);
});

test('engineering release evidence rejects missing or failed required tests', () => {
  const failed = buildEngineeringReleaseEvidenceReport({
    inputs: passedInputs(),
    testRuns: [{
      test_file: 'test/mcp.test.js',
      status: 'failed',
      exit_code: 1
    }]
  });

  assert.equal(failed.status, 'incomplete');
  assert.ok(failed.diagnostics.missing_required_tests.includes('test/mcp-http.test.js'));

  const missingHashes = buildEngineeringReleaseEvidenceReport({
    inputs: [],
    testRuns: REQUIRED_ENGINEERING_TESTS.map((file) => ({ test_file: file, status: 'passed' }))
  });

  assert.equal(missingHashes.status, 'incomplete');
  assert.ok(missingHashes.diagnostics.missing_input_hashes.includes('test/mcp.test.js'));
});

test('engineering release evidence CLI exposes default required tests', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/prepare-engineering-release-evidence.mjs',
    '--help'
  ], {
    cwd: process.cwd()
  });

  assert.match(stdout, /engineering-control-acceptance\.test\.js/);
  assert.match(stdout, /--require-passed/);
});
