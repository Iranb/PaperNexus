#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFixedCorpusRetrievalSuite } from './run-fixed-corpus-retrieval-suite.mjs';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_SCRIPTS_DIR = path.join(
  REPO_ROOT,
  'papers',
  'papernexus-icml-ai4research-2026-05-13',
  'evaluation-artifacts',
  'literature-benchmark-20260516',
  'scripts'
);

const DEFAULT_DENSE_SCRIPT = path.join(EVAL_SCRIPTS_DIR, 'run_litsearch_dense_fastembed.py');
const DEFAULT_RERANK_SCRIPT = path.join(EVAL_SCRIPTS_DIR, 'run_litsearch_cross_encoder_rerank.py');
const DEFAULT_CUTOFFS = [10, 100];
const DEFAULT_MODES = ['lexical', 'dense', 'hybrid', 'rerank', 'hybrid-rerank'];

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseNumberCsv(value, fallback = []) {
  const parsed = parseCsv(value, fallback)
    .map((item) => parseInteger(item, null))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      raw[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      raw[key] = next;
      index += 1;
    } else {
      raw[key] = 'true';
    }
  }
  return normalizeOptions(raw);
}

function normalizeOptions(raw = {}) {
  const runId = String(raw.runId || `litsearch-retrieval-pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const outputDir = path.resolve(raw.outputDir || path.join('.papernexus', 'benchmarks', 'litsearch-retrieval-pipelines', runId));
  const runDense = parseBoolean(raw.runDense, false);
  const runRerank = parseBoolean(raw.runRerank, false);
  const denseOutputDir = path.resolve(raw.denseOutputDir || path.join(outputDir, 'dense-fastembed'));
  const rerankOutputPath = path.resolve(raw.rerankOutput || path.join(outputDir, 'rerank-bge-base-top100.jsonl'));
  const explicitDenseTopk = raw.denseTopk || raw.denseTopkPath || raw.fixedCorpusDenseScores;
  const explicitRerankScores = raw.rerankScores || raw.rerankScoresPath || raw.fixedCorpusRerankScores;
  return {
    runId,
    outputDir,
    dryRun: parseBoolean(raw.dryRun, false),
    runDense,
    runRerank,
    runSuite: parseBoolean(raw.runSuite, true),
    python: raw.python || process.env.PYTHON || 'python3',
    node: raw.node || process.execPath,
    queriesPath: raw.queries || raw.query || null,
    corpusPath: raw.corpus || null,
    datasetPath: raw.datasetPath || raw.dataset || null,
    format: raw.format || 'litsearch',
    denseScript: path.resolve(raw.denseScript || DEFAULT_DENSE_SCRIPT),
    rerankScript: path.resolve(raw.rerankScript || DEFAULT_RERANK_SCRIPT),
    denseOutputDir,
    denseTopkPath: explicitDenseTopk ? path.resolve(explicitDenseTopk) : (runDense ? path.join(denseOutputDir, 'top100.jsonl') : null),
    denseCacheDir: path.resolve(raw.denseCacheDir || raw.cacheDirDense || path.join(outputDir, 'dense-cache')),
    denseModel: raw.denseModel || 'BAAI/bge-small-en-v1.5',
    denseTopK: parseInteger(raw.denseTopK || raw.topK, 100),
    denseBatchSize: parseInteger(raw.denseBatchSize, 64),
    denseChunkSize: parseInteger(raw.denseChunkSize, 256),
    denseThreads: parseInteger(raw.denseThreads, 4),
    denseMaxTextChars: parseInteger(raw.denseMaxTextChars || raw.maxTextChars, 1000),
    forceReembed: parseBoolean(raw.forceReembed, false),
    rerankScoresPath: explicitRerankScores ? path.resolve(explicitRerankScores) : (runRerank ? rerankOutputPath : null),
    rerankSummaryPath: path.resolve(raw.rerankSummary || path.join(outputDir, 'rerank-bge-base-summary.json')),
    rerankModel: raw.rerankModel || 'BAAI/bge-reranker-base',
    rerankDevice: raw.rerankDevice || 'auto',
    rerankCacheDir: raw.rerankCacheDir || process.env.HF_HOME || null,
    rerankMaxCandidates: parseInteger(raw.rerankMaxCandidates || raw.maxCandidates, 100),
    rerankBatchSize: parseInteger(raw.rerankBatchSize, 16),
    rerankTextChars: parseInteger(raw.rerankTextChars, 1000),
    rerankMaxLength: parseInteger(raw.rerankMaxLength, 512),
    maxQueries: parseInteger(raw.maxQueries || raw.limitQueries, null),
    suiteOutputDir: path.resolve(raw.suiteOutputDir || path.join(outputDir, 'suite')),
    suiteCacheDir: path.resolve(raw.suiteCacheDir || path.join(outputDir, 'fixed-corpus-cache')),
    modes: parseCsv(raw.modes || raw.mode, null),
    cutoffs: parseNumberCsv(raw.cutoffs || raw.k, DEFAULT_CUTOFFS),
    fixedCorpusScanLimit: parseInteger(raw.fixedCorpusScanLimit || raw.scanLimit, 50000),
    maxCandidates: parseInteger(raw.maxCandidates, 100),
    fixedCorpusRrfK: parseInteger(raw.fixedCorpusRrfK || raw.rrfK, null),
    resume: parseBoolean(raw.resume, false),
    continueOnError: parseBoolean(raw.continueOnError, false)
  };
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function commandToShell(command) {
  return [command.bin, ...command.args].map(shellQuote).join(' ');
}

function buildDenseCommand(options) {
  const args = [
    options.denseScript,
    '--query', options.queriesPath,
    '--corpus', options.corpusPath,
    '--output', options.denseOutputDir,
    '--cache-dir', options.denseCacheDir,
    '--model', options.denseModel,
    '--top-k', String(options.denseTopK),
    '--cutoffs', options.cutoffs.join(','),
    '--batch-size', String(options.denseBatchSize),
    '--chunk-size', String(options.denseChunkSize),
    '--threads', String(options.denseThreads),
    '--max-text-chars', String(options.denseMaxTextChars)
  ];
  if (options.maxQueries) args.push('--limit-queries', String(options.maxQueries));
  if (options.forceReembed) args.push('--force-reembed');
  return { key: 'dense', bin: options.python, args };
}

function buildRerankCommand(options) {
  const args = [
    options.rerankScript,
    '--queries', options.queriesPath,
    '--corpus', options.corpusPath,
    '--dense-topk', options.denseTopkPath,
    '--output', options.rerankScoresPath,
    '--summary', options.rerankSummaryPath,
    '--model', options.rerankModel,
    '--device', options.rerankDevice,
    '--max-candidates', String(options.rerankMaxCandidates),
    '--text-chars', String(options.rerankTextChars),
    '--batch-size', String(options.rerankBatchSize),
    '--max-length', String(options.rerankMaxLength)
  ];
  if (options.rerankCacheDir) args.push('--cache-dir', options.rerankCacheDir);
  if (options.maxQueries) args.push('--max-queries', String(options.maxQueries));
  return { key: 'rerank', bin: options.python, args };
}

function buildSuiteCommand(options) {
  const modes = options.modes || DEFAULT_MODES;
  const args = [
    path.join(REPO_ROOT, 'scripts', 'run-fixed-corpus-retrieval-suite.mjs'),
    '--dataset-path', options.datasetPath,
    '--format', options.format,
    '--output-dir', options.suiteOutputDir,
    '--run-id', `${options.runId}-suite`,
    '--modes', modes.join(','),
    '--fixed-corpus-scan-limit', String(options.fixedCorpusScanLimit),
    '--fixed-corpus-cache-dir', options.suiteCacheDir,
    '--max-candidates', String(options.maxCandidates),
    '--k', options.cutoffs.join(',')
  ];
  if (options.denseTopkPath) args.push('--fixed-corpus-dense-scores', options.denseTopkPath);
  if (options.rerankScoresPath) args.push('--fixed-corpus-rerank-scores', options.rerankScoresPath);
  if (options.fixedCorpusRrfK) args.push('--fixed-corpus-rrf-k', String(options.fixedCorpusRrfK));
  if (options.maxQueries) args.push('--max-queries', String(options.maxQueries));
  if (options.resume) args.push('--resume');
  if (options.continueOnError) args.push('--continue-on-error');
  return { key: 'suite', bin: options.node, args };
}

function plannedCommands(options) {
  const commands = [];
  if (options.runDense) commands.push(buildDenseCommand(options));
  if (options.runRerank) commands.push(buildRerankCommand(options));
  if (options.runSuite) commands.push(buildSuiteCommand(options));
  return commands;
}

function validateOptions(options) {
  const errors = [];
  if (options.runDense && (!options.queriesPath || !options.corpusPath)) {
    errors.push('--run-dense requires --queries and --corpus');
  }
  if (options.runRerank && (!options.queriesPath || !options.corpusPath)) {
    errors.push('--run-rerank requires --queries and --corpus');
  }
  if (options.runRerank && !options.denseTopkPath) {
    errors.push('--run-rerank requires a dense top-k artifact path');
  }
  if (options.runSuite && !options.datasetPath) {
    errors.push('--run-suite requires --dataset-path');
  }
  if (errors.length) throw new Error(`Invalid LitSearch retrieval pipeline options: ${errors.join('; ')}`);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, options = {}) {
  await ensureDir(options.cwd || process.cwd());
  const startedAt = new Date().toISOString();
  const logPath = options.logPath;
  let logHandle = null;
  if (logPath) {
    await ensureDir(path.dirname(logPath));
    logHandle = await fs.open(logPath, 'a');
    await logHandle.appendFile(`\n# ${startedAt} ${commandToShell(command)}\n`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (logHandle) logHandle.appendFile(chunk).catch(() => {});
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      if (logHandle) logHandle.appendFile(chunk).catch(() => {});
    });
    child.on('error', async (error) => {
      if (logHandle) await logHandle.close();
      reject(error);
    });
    child.on('close', async (code) => {
      if (logHandle) await logHandle.close();
      if (code === 0) {
        resolve({ status: 'completed', code, startedAt, completedAt: new Date().toISOString(), logPath });
      } else {
        reject(new Error(`${command.key} command failed with exit code ${code}`));
      }
    });
  });
}

function manifestFor(options, commands, state = {}) {
  return {
    contractVersion: 'litsearch-retrieval-pipeline-v1',
    runId: options.runId,
    kind: 'litsearch-retrieval-pipeline',
    status: state.status || 'planned',
    dryRun: options.dryRun,
    outputDir: options.outputDir,
    datasetPath: options.datasetPath,
    format: options.format,
    queriesPath: options.queriesPath,
    corpusPath: options.corpusPath,
    denseTopkPath: options.denseTopkPath,
    rerankScoresPath: options.rerankScoresPath,
    suiteOutputDir: options.suiteOutputDir,
    commands: commands.map((command) => ({
      key: command.key,
      argv: [command.bin, ...command.args],
      shell: commandToShell(command)
    })),
    artifacts: state.artifacts || {},
    commandResults: state.commandResults || []
  };
}

export async function runLitSearchRetrievalPipeline(inputOptions = {}) {
  const options = normalizeOptions(inputOptions);
  validateOptions(options);
  const commands = plannedCommands(options);
  await ensureDir(options.outputDir);

  const manifestPath = path.join(options.outputDir, 'pipeline-manifest.json');
  const commandsPath = path.join(options.outputDir, 'pipeline-commands.sh');
  await writeText(commandsPath, `#!/usr/bin/env bash\nset -euo pipefail\n${commands.map(commandToShell).join('\n')}\n`);
  await writeJson(manifestPath, manifestFor(options, commands, { status: options.dryRun ? 'planned' : 'running' }));

  if (options.dryRun) {
    const report = manifestFor(options, commands, {
      status: 'planned',
      artifacts: { manifestPath, commandsPath }
    });
    await writeJson(path.join(options.outputDir, 'pipeline-report.json'), report);
    return report;
  }

  const commandResults = [];
  if (options.runDense) {
    commandResults.push(await runCommand(buildDenseCommand(options), {
      cwd: REPO_ROOT,
      logPath: path.join(options.outputDir, 'dense-fastembed.log')
    }));
  }
  if (options.runRerank) {
    commandResults.push(await runCommand(buildRerankCommand(options), {
      cwd: REPO_ROOT,
      logPath: path.join(options.outputDir, 'rerank-bge-base.log')
    }));
  }

  let suiteReport = null;
  if (options.runSuite) {
    if (options.denseTopkPath && !await fileExists(options.denseTopkPath)) {
      throw new Error(`Dense artifact does not exist: ${options.denseTopkPath}`);
    }
    if (options.rerankScoresPath && !await fileExists(options.rerankScoresPath)) {
      throw new Error(`Rerank artifact does not exist: ${options.rerankScoresPath}`);
    }
    suiteReport = await runFixedCorpusRetrievalSuite({
      runId: `${options.runId}-suite`,
      datasetPath: options.datasetPath,
      format: options.format,
      outputDir: options.suiteOutputDir,
      modes: options.modes || DEFAULT_MODES,
      fixedCorpusDenseScoresPath: options.denseTopkPath,
      fixedCorpusRerankScoresPath: options.rerankScoresPath,
      fixedCorpusScanLimit: options.fixedCorpusScanLimit,
      fixedCorpusCacheDir: options.suiteCacheDir,
      fixedCorpusRrfK: options.fixedCorpusRrfK,
      maxQueries: options.maxQueries,
      benchmarkLimit: options.maxQueries,
      maxCandidates: options.maxCandidates,
      cutoffs: options.cutoffs,
      resume: options.resume,
      continueOnError: options.continueOnError
    });
  }

  const report = manifestFor(options, commands, {
    status: 'completed',
    commandResults,
    artifacts: {
      manifestPath,
      commandsPath,
      denseReportPath: options.runDense ? path.join(options.denseOutputDir, 'report.json') : null,
      denseTopkPath: options.denseTopkPath,
      rerankScoresPath: options.rerankScoresPath,
      rerankSummaryPath: options.runRerank ? options.rerankSummaryPath : null,
      suiteReportPath: suiteReport?.artifacts?.reportPath || null,
      suiteSummaryTsvPath: suiteReport?.artifacts?.summaryTsvPath || null
    }
  });
  await writeJson(path.join(options.outputDir, 'pipeline-report.json'), report);
  await writeJson(manifestPath, report);
  return report;
}

async function main() {
  const report = await runLitSearchRetrievalPipeline(parseArgs());
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    denseTopkPath: report.denseTopkPath,
    rerankScoresPath: report.rerankScoresPath,
    suiteReportPath: report.artifacts?.suiteReportPath || null
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
