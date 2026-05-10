import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { getCorpusPaths } from '../../storage/corpus-store.js';
import { buildDiscoveryDownloadManifest, countDiscoveryDownloadManifestStatuses } from './download-manifest.js';

export function createDiscoveryRunId(date = new Date()) {
  return `disc-${date.toISOString().replace(/[:.]/g, '-')}`;
}

export function getDiscoveryPaths(rootPath, runId = '') {
  const discoveryDir = path.join(getCorpusPaths(rootPath).corpusDir, 'discovery');
  const runsDir = path.join(discoveryDir, 'runs');
  const runDir = runId ? path.join(runsDir, runId) : '';
  return {
    discoveryDir,
    runsDir,
    runDir,
    runJsonPath: runDir ? path.join(runDir, 'discovery.json') : '',
    reportPath: runDir ? path.join(runDir, 'report.md') : '',
    downloadManifestPath: runDir ? path.join(runDir, 'download-manifest.json') : '',
    latestPath: path.join(discoveryDir, 'latest.json')
  };
}

export function renderDiscoveryReport(run = {}) {
  const coverage = run.coverage || {};
  const downloadSummary = countDiscoveryDownloadManifestStatuses(buildDiscoveryDownloadManifest(run));
  const lines = [
    `# Literature Discovery Report`,
    '',
    `Topic: ${run.topic || ''}`,
    `Run ID: ${run.runId || ''}`,
    `Generated: ${run.generatedAt || ''}`,
    `Verdict: ${coverage.verdict || 'unknown'}`,
    '',
    '## Coverage',
    '',
    `- raw candidates: ${coverage.candidateCount || 0}`,
    `- merged papers: ${coverage.mergedPaperCount || 0}`,
    `- strong identity: ${coverage.strongIdentityCount || 0}`,
    `- resolved full text: ${coverage.resolvedFullTextCount || 0}`,
    `- metadata only: ${coverage.metadataOnlyCount || 0}`,
    `- imported: ${coverage.importedCount || 0}`,
    `- download manifest: ${downloadSummary.downloaded} downloaded, ${downloadSummary.eligible} eligible, ${downloadSummary.skipped} skipped, ${downloadSummary.failed} failed, ${downloadSummary.not_pdf} not PDF`,
    '',
    '## Top Candidates',
    '',
    '| # | Title | Year | Providers | Full Text | Identifiers |',
    '| --- | --- | --- | --- | --- | --- |'
  ];

  for (const [index, candidate] of (run.candidates || []).slice(0, 20).entries()) {
    const identifiers = Object.entries(candidate.identifiers || {})
      .map(([key, value]) => `${key}:${value}`)
      .join(', ');
    lines.push(`| ${index + 1} | ${String(candidate.title || '').replace(/\|/g, ' ')} | ${candidate.year || ''} | ${(candidate.providers || []).join(', ')} | ${candidate.source?.fullTextStatus || 'unknown'} | ${identifiers} |`);
  }

  return `${lines.join('\n')}\n`;
}

export async function saveDiscoveryRun(rootPath, run) {
  const paths = getDiscoveryPaths(rootPath, run.runId);
  const downloadManifest = buildDiscoveryDownloadManifest(run);
  await ensureDir(paths.runDir);
  await writeJson(paths.runJsonPath, run);
  await writeText(paths.reportPath, renderDiscoveryReport(run));
  await writeJson(paths.downloadManifestPath, downloadManifest);
  await writeJson(paths.latestPath, {
    runId: run.runId,
    generatedAt: run.generatedAt,
    topic: run.topic,
    runJsonPath: paths.runJsonPath,
    reportPath: paths.reportPath,
    downloadManifestPath: paths.downloadManifestPath
  });
  return {
    ...paths,
    run
  };
}

export async function loadDiscoveryRun(rootPath, runId = '') {
  let resolvedRunId = String(runId || '').trim();
  if (!resolvedRunId) {
    const latest = await readJson(getDiscoveryPaths(rootPath).latestPath, null);
    resolvedRunId = latest?.runId || '';
  }
  if (!resolvedRunId) return null;
  return readJson(getDiscoveryPaths(rootPath, resolvedRunId).runJsonPath, null);
}

export async function listDiscoveryRuns(rootPath, limit = 20) {
  const paths = getDiscoveryPaths(rootPath);
  let entries = [];
  try {
    entries = await fs.readdir(paths.runsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = await readJson(getDiscoveryPaths(rootPath, entry.name).runJsonPath, null);
    if (!run) continue;
    runs.push({
      runId: run.runId,
      generatedAt: run.generatedAt,
      topic: run.topic,
      coverage: run.coverage
    });
  }
  return runs
    .sort((left, right) => String(right.generatedAt || '').localeCompare(String(left.generatedAt || '')))
    .slice(0, Math.max(1, Math.floor(Number(limit || 20))));
}
