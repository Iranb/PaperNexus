import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureDir, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const ENGINEERING_RELEASE_EVIDENCE_VERSION = 'papernexus-engineering-release-evidence-v1';

export const REQUIRED_ENGINEERING_TESTS = [
  'test/mcp.test.js',
  'test/mcp-http.test.js',
  'test/pipeline-invariants.test.js',
  'test/engineering-control-acceptance.test.js'
];

const execFileAsync = promisify(execFile);

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePathText(value = '') {
  return compactText(value).replace(/\\/g, '/').replace(/^\.\//, '');
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function tailText(value = '', maxLength = 8000) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function buildInputRecords(testFiles = [], cwd = process.cwd()) {
  const records = [];
  const paths = ['package.json', ...testFiles];
  for (const entry of unique(paths.map(normalizePathText))) {
    const absolutePath = path.resolve(cwd, entry);
    records.push({
      role: entry === 'package.json' ? 'package_manifest' : 'required_test_file',
      path: absolutePath,
      sha256: await sha256File(absolutePath)
    });
  }
  return records;
}

function normalizeTestRun(run = {}) {
  const testFiles = unique([
    ...asArray(run.test_files || run.testFiles),
    ...asArray(run.test_file || run.testFile)
  ].map(normalizePathText));
  const status = compactText(run.status || (run.ok === false ? 'failed' : 'passed')).toLowerCase();
  return {
    test_files: testFiles,
    command: compactText(run.command || ''),
    status: status === 'passed' ? 'passed' : (status === 'skipped' ? 'skipped' : 'failed'),
    exit_code: Number.isFinite(Number(run.exit_code ?? run.exitCode)) ? Number(run.exit_code ?? run.exitCode) : null,
    signal: run.signal || null,
    duration_ms: Number.isFinite(Number(run.duration_ms ?? run.durationMs)) ? Number(run.duration_ms ?? run.durationMs) : null,
    stdout_tail: tailText(run.stdout_tail || run.stdout || ''),
    stderr_tail: tailText(run.stderr_tail || run.stderr || '')
  };
}

function coveredRequiredTests(testRuns = []) {
  const passed = new Set();
  const failed = new Set();
  for (const run of testRuns.map(normalizeTestRun)) {
    for (const file of run.test_files) {
      if (run.status === 'passed') passed.add(file);
      if (run.status === 'failed') failed.add(file);
    }
  }
  return { passed, failed };
}

function inputHashCoverage(inputs = [], requiredTests = []) {
  const inputPaths = asArray(inputs)
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizePathText(entry.path || entry.file || ''));
  return requiredTests.filter((file) => inputPaths.some((entry) => entry.endsWith(file)));
}

export function buildEngineeringReleaseEvidenceReport(options = {}) {
  const requiredTests = unique(asArray(options.requiredTests || options.required_tests || REQUIRED_ENGINEERING_TESTS).map(normalizePathText));
  const testRuns = asArray(options.testRuns || options.test_runs).map(normalizeTestRun);
  const inputs = asArray(options.inputs).filter(Boolean);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `engineering-release-evidence-${stableHash(`${generatedAt}:${requiredTests.join(',')}`, 10)}`;
  const coverage = coveredRequiredTests(testRuns);
  const missingTests = requiredTests.filter((file) => !coverage.passed.has(file) && !coverage.failed.has(file));
  const failedTests = requiredTests.filter((file) => coverage.failed.has(file));
  const hashedRequiredTests = inputHashCoverage(inputs, requiredTests);
  const missingInputHashes = requiredTests.filter((file) => !hashedRequiredTests.includes(file));
  let status = 'passed';
  let reason = 'required_engineering_tests_passed';
  if (missingTests.length || !testRuns.length) {
    status = 'incomplete';
    reason = 'missing_required_test_runs';
  } else if (missingInputHashes.length) {
    status = 'incomplete';
    reason = 'missing_required_test_input_hashes';
  } else if (failedTests.length || testRuns.some((run) => run.status === 'failed')) {
    status = 'failed';
    reason = 'required_engineering_tests_failed';
  }
  return {
    contractVersion: ENGINEERING_RELEASE_EVIDENCE_VERSION,
    runId,
    generatedAt,
    status,
    required_tests: requiredTests,
    test_runs: testRuns,
    inputs,
    diagnostics: {
      required_test_count: requiredTests.length,
      passed_required_test_count: requiredTests.filter((file) => coverage.passed.has(file)).length,
      failed_required_tests: failedTests,
      missing_required_tests: missingTests,
      missing_input_hashes: missingInputHashes
    },
    releaseGate: {
      status,
      reason
    },
    environment: {
      node_version: options.nodeVersion || process.version,
      platform: process.platform
    }
  };
}

async function runNodeTestFile(testFile = '', options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || options.timeout_ms || 120000));
  const startedAt = Date.now();
  const command = `${process.execPath} --test ${testFile}`;
  try {
    const result = await execFileAsync(process.execPath, ['--test', testFile], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });
    return normalizeTestRun({
      test_file: testFile,
      command,
      status: 'passed',
      exit_code: 0,
      duration_ms: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    return normalizeTestRun({
      test_file: testFile,
      command,
      status: 'failed',
      exit_code: Number.isFinite(Number(error.code)) ? Number(error.code) : 1,
      signal: error.signal || null,
      duration_ms: Date.now() - startedAt,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || ''
    });
  }
}

export async function prepareEngineeringReleaseEvidence(options = {}) {
  const cwd = options.cwd || process.cwd();
  const outputDir = compactText(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const requiredTests = unique(asArray(options.requiredTests || options.required_tests || REQUIRED_ENGINEERING_TESTS).map(normalizePathText));
  const testRuns = [];
  for (const testFile of requiredTests) {
    testRuns.push(await runNodeTestFile(testFile, { cwd, timeoutMs: options.timeoutMs || options.timeout_ms }));
  }
  const absoluteOutputDir = path.resolve(cwd, outputDir);
  const reportPath = path.join(absoluteOutputDir, 'engineering-release-evidence.json');
  const reportMarkdownPath = path.join(absoluteOutputDir, 'engineering-release-evidence.md');
  const manifestPath = path.join(absoluteOutputDir, 'manifest.json');
  const report = buildEngineeringReleaseEvidenceReport({
    ...options,
    requiredTests,
    testRuns,
    inputs: await buildInputRecords(requiredTests, cwd)
  });
  const reportWithArtifacts = {
    ...report,
    artifacts: {
      outputDir: absoluteOutputDir,
      reportPath,
      reportMarkdownPath,
      manifestPath
    }
  };
  await ensureDir(absoluteOutputDir);
  await writeJson(reportPath, reportWithArtifacts);
  await writeText(reportMarkdownPath, renderEngineeringReleaseEvidenceMarkdown(reportWithArtifacts));
  await writeJson(manifestPath, {
    contractVersion: ENGINEERING_RELEASE_EVIDENCE_VERSION,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    releaseGate: report.releaseGate,
    required_tests: report.required_tests,
    diagnostics: report.diagnostics,
    artifacts: reportWithArtifacts.artifacts
  });
  return reportWithArtifacts;
}

export function renderEngineeringReleaseEvidenceMarkdown(report = {}) {
  const lines = [
    `# Engineering Release Evidence: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Required Tests',
    '',
    '| Test | Status | Duration ms |',
    '|---|---:|---:|'
  ];
  for (const file of asArray(report.required_tests)) {
    const run = asArray(report.test_runs).find((entry) => asArray(entry.test_files).includes(file));
    lines.push(`| ${file} | ${run?.status || 'missing'} | ${run?.duration_ms ?? ''} |`);
  }
  lines.push('', '## Diagnostics', '');
  for (const [key, value] of Object.entries(report.diagnostics || {})) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  return `${lines.join('\n')}\n`;
}
