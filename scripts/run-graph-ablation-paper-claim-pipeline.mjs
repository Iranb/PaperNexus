#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import { runGraphRankingAblation } from './benchmark-graph-ranking-ablation.mjs';
import { runGraphAblationArtifactPreflight } from './prepare-graph-ablation-artifact.mjs';

const CONTRACT_VERSION = 'papernexus-graph-ablation-paper-claim-pipeline-v1';
const DEFAULT_MODES = ['text-only', 'graph-only', 'hybrid', 'hybrid+all'];
const DEFAULT_CUTOFFS = [10, 100];

function usage() {
  return [
    'Usage:',
    '  node scripts/run-graph-ablation-paper-claim-pipeline.mjs --dataset-path <artifact.json> [options]',
    '',
    'Options:',
    '  --run-id <id>',
    '  --output-dir <dir>',
    '  --min-queries <n>            Default: 30',
    '  --modes <csv>                Default: text-only,graph-only,hybrid,hybrid+all',
    '  --cutoffs <csv>              Default: 10,100',
    '  --max-candidates <n>         Default: 100',
    '',
    'The pipeline runs preflight first and refuses to run graph ablation unless',
    'the artifact is paper_ready.'
  ].join('\n');
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const equalsIndex = arg.indexOf('=');
    const rawKey = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
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

  const runId = raw.runId || `graph-ablation-paper-claim-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    help: raw.help,
    runId,
    datasetPath: raw.datasetPath || raw.dataset,
    outputDir: path.resolve(raw.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-claims', runId)),
    minQueries: parseInteger(raw.minQueries, 30),
    modes: parseCsv(raw.modes || raw.mode, DEFAULT_MODES),
    cutoffs: parseCsv(raw.cutoffs || raw.k, DEFAULT_CUTOFFS).map((value) => parseInteger(value, null)).filter(Boolean),
    maxCandidates: parseInteger(raw.maxCandidates || raw.maxResults, 100)
  };
}

function renderMarkdown(report = {}) {
  return [
    `# Graph Ablation Paper Claim Pipeline: ${report.runId}`,
    '',
    `Status: \`${report.status}\``,
    '',
    '## Preflight',
    '',
    `- status: \`${report.preflight?.status || ''}\``,
    `- reasons: ${(report.preflight?.gate?.reasons || []).map((reason) => `\`${reason}\``).join(', ') || 'none'}`,
    '',
    '## Boundary',
    '',
    report.status === 'completed'
      ? 'A graph ablation result was produced from a preflight-passing artifact. Any paper-facing use must still update the appendix and rebuild the PDF.'
      : 'No graph ablation result was produced. This run must not be used as a paper performance claim.'
  ].join('\n') + '\n';
}

export async function runGraphAblationPaperClaimPipeline(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-ablation-paper-claim-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-claims', runId));
  const artifacts = {
    reportPath: path.join(outputDir, 'graph-ablation-paper-claim-pipeline.json'),
    reportMarkdownPath: path.join(outputDir, 'graph-ablation-paper-claim-pipeline.md'),
    preflightDir: path.join(outputDir, 'preflight'),
    ablationDir: path.join(outputDir, 'graph-ranking-ablation')
  };

  await ensureDir(outputDir);
  const preflight = await runGraphAblationArtifactPreflight({
    datasetPath: inputOptions.datasetPath,
    benchmark: inputOptions.benchmark,
    runId: `${runId}-preflight`,
    outputDir: artifacts.preflightDir,
    minQueries: parseInteger(inputOptions.minQueries, 30)
  });

  if (preflight.status !== 'paper_ready') {
    const report = {
      contractVersion: CONTRACT_VERSION,
      kind: 'graph-ablation-paper-claim-pipeline',
      runId,
      status: 'blocked_by_preflight',
      evidenceClass: 'engineering_diagnostic',
      createdAt: new Date().toISOString(),
      preflight: {
        status: preflight.status,
        evidenceClass: preflight.evidenceClass,
        gate: preflight.gate,
        stats: preflight.stats,
        reportPath: preflight.artifacts.reportPath
      },
      artifacts
    };
    await writeJson(artifacts.reportPath, report);
    await writeText(artifacts.reportMarkdownPath, renderMarkdown(report));
    return report;
  }

  const ablation = await runGraphRankingAblation({
    datasetPath: inputOptions.datasetPath,
    benchmark: inputOptions.benchmark,
    runId: `${runId}-ablation`,
    outputDir: artifacts.ablationDir,
    modes: parseCsv(inputOptions.modes, DEFAULT_MODES),
    cutoffs: parseCsv(inputOptions.cutoffs, DEFAULT_CUTOFFS),
    maxCandidates: parseInteger(inputOptions.maxCandidates, 100)
  });
  const report = {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-paper-claim-pipeline',
    runId,
    status: ablation.status === 'completed' ? 'completed' : 'completed_with_ablation_warnings',
    evidenceClass: 'paper_ready',
    createdAt: new Date().toISOString(),
    paperIntegrationRequired: true,
    preflight: {
      status: preflight.status,
      evidenceClass: preflight.evidenceClass,
      gate: preflight.gate,
      stats: preflight.stats,
      reportPath: preflight.artifacts.reportPath
    },
    ablation: {
      status: ablation.status,
      reportPath: ablation.artifacts.reportPath,
      summaryTsvPath: ablation.artifacts.summaryTsvPath,
      modeSummaries: ablation.modeSummaries
    },
    artifacts
  };

  await writeJson(artifacts.reportPath, report);
  await writeText(artifacts.reportMarkdownPath, renderMarkdown(report));
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (!options.datasetPath) {
    process.stderr.write(`${usage()}\n\nMissing required --dataset-path.\n`);
    process.exitCode = 1;
  } else {
    runGraphAblationPaperClaimPipeline(options)
      .then((report) => {
        process.stdout.write(`${JSON.stringify({
          runId: report.runId,
          status: report.status,
          evidenceClass: report.evidenceClass,
          outputDir: path.dirname(report.artifacts.reportPath),
          reportPath: report.artifacts.reportPath,
          paperIntegrationRequired: Boolean(report.paperIntegrationRequired)
        }, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
