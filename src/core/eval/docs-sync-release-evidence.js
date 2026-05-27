import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureDir, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const DOCS_SYNC_RELEASE_EVIDENCE_VERSION = 'papernexus-docs-sync-release-evidence-v1';

export const REQUIRED_DOCS_SYNC_CHECKS = [
  {
    id: 'docs_build',
    label: 'VitePress docs build and generated reference refresh',
    command: 'npm',
    args: ['run', 'docs:build']
  },
  {
    id: 'mcp_schema_snapshot',
    label: 'MCP public schema snapshot matches reviewed fixture',
    command: 'node',
    args: ['--test', 'test/mcp-schema-snapshot.test.js']
  },
  {
    id: 'packet_fixture_drift',
    label: 'Idea-Catalyst packet and schema fixtures match current contract',
    command: 'node',
    args: [
      '--test',
      'test/idea-catalyst-packets.test.js',
      'test/idea-catalyst-live.test.js',
      'test/idea-catalyst-schema.test.js'
    ]
  },
  {
    id: 'migration_notes_present',
    label: 'Migration notes for Idea-Catalyst v2 contracts are present',
    kind: 'file_presence',
    files: ['docs/eval/idea-catalyst-v2-migration-notes.md']
  }
];

export const REQUIRED_DOCS_SYNC_INPUTS = [
  'package.json',
  'scripts/generate-docs-reference.mjs',
  'docs/.vitepress/config.mjs',
  'docs/eval/idea-catalyst-release-gate.md',
  'docs/eval/release-evidence-bundle.md',
  'docs/eval/idea-catalyst-v2-migration-notes.md',
  'docs/eval/idea-catalyst-historical-replay.schema.json',
  'docs/eval/idea-catalyst-replay-suite.schema.json',
  'docs/interfaces/mcp-skill-contracts.md',
  'docs/reference/generated/graph-schema.md',
  'docs/reference/generated/mcp-tools.md',
  'test/fixtures/mcp-tools-schema.snapshot.json',
  'test/mcp-schema-snapshot.test.js',
  'test/idea-catalyst-packets.test.js',
  'test/idea-catalyst-live.test.js',
  'test/idea-catalyst-schema.test.js'
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

function normalizeCheckId(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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

async function inputRecord(relativePath = '', cwd = process.cwd(), role = 'required_sync_input') {
  const normalized = normalizePathText(relativePath);
  const absolutePath = path.resolve(cwd, normalized);
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return {
        role,
        path: absolutePath,
        relative_path: normalized,
        exists: false,
        sha256: null,
        reason: 'not_a_file'
      };
    }
    return {
      role,
      path: absolutePath,
      relative_path: normalized,
      exists: true,
      size_bytes: stats.size,
      sha256: await sha256File(absolutePath)
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      role,
      path: absolutePath,
      relative_path: normalized,
      exists: false,
      sha256: null,
      reason: 'missing'
    };
  }
}

async function buildInputRecords(files = [], cwd = process.cwd()) {
  const records = [];
  for (const file of unique(files.map(normalizePathText))) {
    records.push(await inputRecord(file, cwd));
  }
  return records;
}

function normalizeCommand(command = '') {
  const text = compactText(command);
  return text === 'node' ? process.execPath : text;
}

function commandText(command = '', args = []) {
  const displayCommand = compactText(command) === 'node' ? process.execPath : compactText(command);
  return [displayCommand, ...asArray(args).map(compactText)].filter(Boolean).join(' ');
}

function normalizeCheckRun(run = {}) {
  const id = normalizeCheckId(run.id || run.check_id || run.name);
  const status = compactText(run.status || (run.ok === false ? 'failed' : 'passed')).toLowerCase();
  return {
    id,
    label: compactText(run.label || run.name || id),
    command: compactText(run.command || ''),
    status: status === 'passed' ? 'passed' : (status === 'skipped' ? 'skipped' : (status === 'incomplete' ? 'incomplete' : 'failed')),
    exit_code: Number.isFinite(Number(run.exit_code ?? run.exitCode)) ? Number(run.exit_code ?? run.exitCode) : null,
    signal: run.signal || null,
    duration_ms: Number.isFinite(Number(run.duration_ms ?? run.durationMs)) ? Number(run.duration_ms ?? run.durationMs) : null,
    stdout_tail: tailText(run.stdout_tail || run.stdout || ''),
    stderr_tail: tailText(run.stderr_tail || run.stderr || ''),
    files: asArray(run.files).map(normalizePathText).filter(Boolean),
    reason: compactText(run.reason || '')
  };
}

function defaultCheckIds() {
  return REQUIRED_DOCS_SYNC_CHECKS.map((entry) => normalizeCheckId(entry.id));
}

function coveredInputs(inputs = [], requiredInputs = []) {
  const inputPaths = asArray(inputs)
    .filter((entry) => compactText(entry.sha256 || entry.hash || entry.checksum))
    .map((entry) => normalizePathText(entry.relative_path || entry.path || entry.file || ''));
  return requiredInputs.filter((file) => inputPaths.some((entry) => entry === file || entry.endsWith(file)));
}

function inputRecordsByPath(inputs = []) {
  const records = new Map();
  for (const entry of asArray(inputs)) {
    const key = normalizePathText(entry.relative_path || entry.path || entry.file || '');
    if (key) records.set(key, entry);
  }
  return records;
}

function inputFingerprint(record = null) {
  if (!record) return 'missing_record';
  const hash = compactText(record.sha256 || record.hash || record.checksum);
  if (hash) return hash;
  if (record.exists === false) return 'missing_file';
  return 'missing_hash';
}

function inputExists(record = null) {
  if (!record) return false;
  if (record.exists === false) return false;
  return Boolean(compactText(record.sha256 || record.hash || record.checksum));
}

function changedInputHashes(precheckInputs = [], inputs = [], requiredInputs = []) {
  const before = inputRecordsByPath(precheckInputs);
  const after = inputRecordsByPath(inputs);
  return requiredInputs
    .map((file) => {
      const key = normalizePathText(file);
      const beforeRecord = before.get(key);
      const afterRecord = after.get(key);
      const beforeFingerprint = inputFingerprint(beforeRecord);
      const afterFingerprint = inputFingerprint(afterRecord);
      if (beforeFingerprint === afterFingerprint) return null;
      return {
        relative_path: key,
        before_sha256: compactText(beforeRecord?.sha256 || beforeRecord?.hash || beforeRecord?.checksum) || null,
        after_sha256: compactText(afterRecord?.sha256 || afterRecord?.hash || afterRecord?.checksum) || null,
        before_exists: inputExists(beforeRecord),
        after_exists: inputExists(afterRecord)
      };
    })
    .filter(Boolean);
}

function checkCoverage(checkRuns = [], requiredCheckIds = defaultCheckIds()) {
  const byId = new Map();
  for (const run of checkRuns.map(normalizeCheckRun)) {
    if (run.id) byId.set(run.id, run);
  }
  const missing = requiredCheckIds.filter((id) => !byId.has(id));
  const failed = requiredCheckIds.filter((id) => byId.get(id)?.status === 'failed');
  const incomplete = requiredCheckIds.filter((id) => {
    const status = byId.get(id)?.status;
    return status && status !== 'passed' && status !== 'failed';
  });
  return { byId, missing, failed, incomplete };
}

export function buildDocsSyncReleaseEvidenceReport(options = {}) {
  const requiredCheckIds = unique(asArray(options.requiredChecks || options.required_checks || defaultCheckIds()).map(normalizeCheckId));
  const requiredInputs = unique(asArray(options.requiredInputs || options.required_inputs || REQUIRED_DOCS_SYNC_INPUTS).map(normalizePathText));
  const checkRuns = asArray(options.checkRuns || options.check_runs || options.checks).map(normalizeCheckRun);
  const inputs = asArray(options.inputs).filter(Boolean);
  const precheckInputs = asArray(options.precheckInputs || options.precheck_inputs || options.beforeInputs || options.before_inputs).filter(Boolean);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `docs-sync-release-evidence-${stableHash(`${generatedAt}:${requiredCheckIds.join(',')}`, 10)}`;
  const coverage = checkCoverage(checkRuns, requiredCheckIds);
  const hashedInputs = coveredInputs(inputs, requiredInputs);
  const missingInputHashes = requiredInputs.filter((file) => !hashedInputs.includes(file));
  const changedInputs = precheckInputs.length ? changedInputHashes(precheckInputs, inputs, requiredInputs) : [];
  let status = 'passed';
  let reason = 'docs_schema_fixtures_and_migration_notes_synced';
  if (coverage.failed.length || checkRuns.some((run) => run.status === 'failed')) {
    status = 'failed';
    reason = 'docs_sync_checks_failed';
  } else if (changedInputs.length) {
    status = 'failed';
    reason = 'docs_sync_inputs_changed_during_checks';
  } else if (coverage.missing.length || coverage.incomplete.length || !checkRuns.length) {
    status = 'incomplete';
    reason = 'missing_required_docs_sync_checks';
  } else if (missingInputHashes.length) {
    status = 'incomplete';
    reason = 'missing_required_docs_sync_input_hashes';
  }
  return {
    contractVersion: DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
    runId,
    generatedAt,
    status,
    required_checks: requiredCheckIds,
    required_inputs: requiredInputs,
    checks: checkRuns,
    ...(precheckInputs.length ? { precheck_inputs: precheckInputs } : {}),
    inputs,
    input_stability: {
      checked: precheckInputs.length > 0,
      changed_input_count: changedInputs.length,
      changed_inputs: changedInputs
    },
    diagnostics: {
      required_check_count: requiredCheckIds.length,
      passed_required_check_count: requiredCheckIds.filter((id) => coverage.byId.get(id)?.status === 'passed').length,
      failed_required_checks: coverage.failed,
      incomplete_required_checks: coverage.incomplete,
      missing_required_checks: coverage.missing,
      missing_input_hashes: missingInputHashes,
      changed_input_hashes: changedInputs.map((entry) => entry.relative_path)
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

async function runExecCheck(check = {}, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || options.timeout_ms || 120000));
  const startedAt = Date.now();
  const command = normalizeCommand(check.command);
  const args = asArray(check.args).map(compactText).filter(Boolean);
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 40 * 1024 * 1024
    });
    return normalizeCheckRun({
      id: check.id,
      label: check.label,
      command: commandText(check.command, args),
      status: 'passed',
      exit_code: 0,
      duration_ms: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    return normalizeCheckRun({
      id: check.id,
      label: check.label,
      command: commandText(check.command, args),
      status: 'failed',
      exit_code: Number.isFinite(Number(error.code)) ? Number(error.code) : 1,
      signal: error.signal || null,
      duration_ms: Date.now() - startedAt,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || ''
    });
  }
}

async function runFilePresenceCheck(check = {}, options = {}) {
  const cwd = options.cwd || process.cwd();
  const startedAt = Date.now();
  const files = asArray(check.files).map(normalizePathText).filter(Boolean);
  const records = [];
  for (const file of files) {
    records.push(await inputRecord(file, cwd, 'migration_note'));
  }
  const missing = records.filter((entry) => !entry.exists || !entry.sha256 || Number(entry.size_bytes || 0) <= 0);
  return normalizeCheckRun({
    id: check.id,
    label: check.label,
    command: `internal:file-presence ${files.join(',')}`,
    status: missing.length ? 'failed' : 'passed',
    exit_code: missing.length ? 1 : 0,
    duration_ms: Date.now() - startedAt,
    files,
    stderr: missing.map((entry) => `${entry.relative_path || entry.path}: ${entry.reason || 'missing_or_empty'}`).join('\n')
  });
}

async function runCheck(check = {}, options = {}) {
  if (check.kind === 'file_presence') return runFilePresenceCheck(check, options);
  return runExecCheck(check, options);
}

export async function prepareDocsSyncReleaseEvidence(options = {}) {
  const cwd = options.cwd || process.cwd();
  const outputDir = compactText(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const checks = asArray(options.checks || options.requiredCheckSpecs || options.required_check_specs || REQUIRED_DOCS_SYNC_CHECKS);
  const requiredInputs = unique([
    ...REQUIRED_DOCS_SYNC_INPUTS,
    ...checks.flatMap((check) => asArray(check.files))
  ].map(normalizePathText));
  const precheckInputs = await buildInputRecords(requiredInputs, cwd);
  const checkRuns = [];
  for (const check of checks) {
    checkRuns.push(await runCheck(check, { cwd, timeoutMs: options.timeoutMs || options.timeout_ms }));
  }
  const absoluteOutputDir = path.resolve(cwd, outputDir);
  const reportPath = path.join(absoluteOutputDir, 'docs-sync-release-evidence.json');
  const reportMarkdownPath = path.join(absoluteOutputDir, 'docs-sync-release-evidence.md');
  const manifestPath = path.join(absoluteOutputDir, 'manifest.json');
  const report = buildDocsSyncReleaseEvidenceReport({
    ...options,
    requiredChecks: checks.map((check) => check.id),
    requiredInputs,
    checkRuns,
    precheckInputs,
    inputs: await buildInputRecords(requiredInputs, cwd)
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
  await writeText(reportMarkdownPath, renderDocsSyncReleaseEvidenceMarkdown(reportWithArtifacts));
  await writeJson(manifestPath, {
    contractVersion: DOCS_SYNC_RELEASE_EVIDENCE_VERSION,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    releaseGate: report.releaseGate,
    required_checks: report.required_checks,
    diagnostics: report.diagnostics,
    artifacts: reportWithArtifacts.artifacts
  });
  return reportWithArtifacts;
}

export function renderDocsSyncReleaseEvidenceMarkdown(report = {}) {
  const lines = [
    `# Docs Sync Release Evidence: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Required Checks',
    '',
    '| Check | Status | Duration ms |',
    '|---|---:|---:|'
  ];
  for (const id of asArray(report.required_checks)) {
    const run = asArray(report.checks).find((entry) => entry.id === id);
    lines.push(`| ${id} | ${run?.status || 'missing'} | ${run?.duration_ms ?? ''} |`);
  }
  lines.push('', '## Diagnostics', '');
  for (const [key, value] of Object.entries(report.diagnostics || {})) {
    lines.push(`- ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  lines.push('', '## Input Stability', '');
  lines.push(`- checked: ${report.input_stability?.checked ? 'yes' : 'no'}`);
  lines.push(`- changed_input_count: ${report.input_stability?.changed_input_count ?? 0}`);
  for (const entry of asArray(report.input_stability?.changed_inputs)) {
    lines.push(`- changed: ${entry.relative_path}`);
  }
  return `${lines.join('\n')}\n`;
}
