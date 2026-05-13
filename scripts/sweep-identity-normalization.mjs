#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRetrievalBenchmark } from '../src/core/benchmarks/retrieval.js';
import {
  normalizeArxivId,
  normalizeDoi,
  normalizeExactPaperTitle,
  normalizePaperIdentifiers
} from '../src/lib/paper-identifiers.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const DEFAULT_POLICIES = [
  'baseline',
  'strong-identifiers',
  'expanded-identifiers',
  'expanded-with-title'
];

function compactText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseCsv(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }

  const runId = String(options.runId || `identity-normalization-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    datasetPath: options.datasetPath || options.dataset,
    format: options.format,
    rootPath: options.rootPath,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'identity-normalization-sweeps', runId)),
    policies: parseCsv(options.policies || options.policy, DEFAULT_POLICIES),
    benchmarkLimit: parseInteger(options.benchmarkLimit || options.limit, null)
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function addAlias(aliases, field, value = '') {
  const normalized = compactText(value).toLowerCase();
  if (!normalized) return;
  aliases.push({ field, value: `${field}:${normalized}` });
}

function addRawIdAliases(aliases, paper = {}) {
  for (const value of [
    paper.id,
    paper._id,
    paper.docId,
    paper.doc_id,
    paper.documentId,
    paper.document_id,
    paper.canonicalId,
    paper.canonical_id
  ]) {
    addAlias(aliases, 'id', value);
  }
}

function addExistingIdentifierAliases(aliases, paper = {}) {
  const identifiers = normalizePaperIdentifiers({
    ...asObject(paper.identifiers),
    ...paper
  });
  for (const [field, value] of Object.entries(identifiers)) {
    addAlias(aliases, field, value);
  }
}

function maybeAddArxivAliases(aliases, value = '') {
  const arxivId = normalizeArxivId(value);
  if (!arxivId) return;
  addAlias(aliases, 'arxiv', arxivId);
  addAlias(aliases, 'arxiv_base', arxivId.replace(/v\d+$/i, ''));
}

function maybeAddDoiAlias(aliases, value = '') {
  const doi = normalizeDoi(value);
  if (doi) addAlias(aliases, 'doi', doi);
}

function normalizeS2Id(value = '') {
  const raw = compactText(value);
  if (/^https?:\/\//i.test(raw) && !/^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\//i.test(raw)) {
    return '';
  }
  return raw
    .replace(/^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\//i, '')
    .replace(/^s2(?:paper)?[:/\s-]+/i, '')
    .replace(/^corpusid[:/\s-]+/i, '')
    .replace(/[#?].*$/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function normalizeOpenAlexId(value = '') {
  const normalized = compactText(value)
    .replace(/^https?:\/\/(?:www\.)?openalex\.org\//i, '')
    .replace(/^openalex[:/\s-]+/i, '')
    .replace(/[#?].*$/, '')
    .toLowerCase();
  const match = normalized.match(/^(?:works\/)?(w\d+)$/i);
  return match ? match[1].toLowerCase() : '';
}

function collectNestedValues(paper = {}, names = []) {
  const identifiers = asObject(paper.identifiers);
  const ids = asObject(paper.ids);
  const metadata = asObject(paper.metadata);
  const metadataIdentifiers = asObject(metadata.identifiers);
  const values = [];
  for (const name of names) {
    values.push(paper[name], identifiers[name], ids[name], metadata[name], metadataIdentifiers[name]);
  }
  return values.filter((value) => compactText(value));
}

function addExpandedIdentifierAliases(aliases, paper = {}) {
  for (const value of collectNestedValues(paper, [
    'doi',
    'DOI'
  ])) {
    maybeAddDoiAlias(aliases, value);
  }

  for (const value of collectNestedValues(paper, [
    'arxivId',
    'arxiv',
    'arxiv_id'
  ])) {
    maybeAddArxivAliases(aliases, value);
  }

  for (const value of collectNestedValues(paper, [
    's2PaperId',
    's2_paper_id',
    'semanticScholarId',
    'semantic_scholar_id',
    'paperId',
    'paperID',
    'paper_id'
  ])) {
    const normalized = normalizeS2Id(value);
    if (normalized) addAlias(aliases, 's2', normalized);
  }

  for (const value of collectNestedValues(paper, [
    'corpusId',
    'corpusid',
    'corpus_id'
  ])) {
    const normalized = normalizeS2Id(value);
    if (normalized) addAlias(aliases, 's2_corpus', normalized);
  }

  for (const value of collectNestedValues(paper, [
    'openAlexId',
    'openalexId',
    'openalex',
    'open_alex_id',
    'openalex_id',
    'openAlex'
  ])) {
    const normalized = normalizeOpenAlexId(value);
    if (normalized) addAlias(aliases, 'openalex', normalized);
  }

  for (const value of [
    paper.url,
    paper.uri,
    paper.sourceUrl,
    paper.source_url,
    asObject(paper.ids).openalex,
    asObject(paper.identifiers).openalex
  ]) {
    maybeAddDoiAlias(aliases, value);
    maybeAddArxivAliases(aliases, value);
    const s2Id = normalizeS2Id(value);
    if (s2Id) addAlias(aliases, 's2', s2Id);
    const openAlexId = normalizeOpenAlexId(value);
    if (openAlexId) addAlias(aliases, 'openalex', openAlexId);
  }
}

function addTitleAlias(aliases, paper = {}) {
  const title = normalizeExactPaperTitle(
    paper.normalizedTitle || paper.normalized_title || paper.paperTitle || paper.paper_title || paper.title || ''
  );
  if (title) addAlias(aliases, 'title', title);
}

function dedupeAliases(aliases = []) {
  const seen = new Set();
  const deduped = [];
  for (const alias of aliases) {
    if (!alias?.value || seen.has(alias.value)) continue;
    seen.add(alias.value);
    deduped.push(alias);
  }
  return deduped;
}

function collectPolicyAliases(paper = {}, policy = 'baseline') {
  const aliases = [];
  if (policy === 'baseline') {
    addRawIdAliases(aliases, paper);
    addExistingIdentifierAliases(aliases, paper);
    for (const alias of asArray(paper.identityAliases || paper.canonicalAliases)) {
      addAlias(aliases, 'explicit_alias', alias);
    }
    addTitleAlias(aliases, paper);
    return dedupeAliases(aliases);
  }

  if (policy === 'strong-identifiers') {
    addExistingIdentifierAliases(aliases, paper);
    addExpandedIdentifierAliases(aliases, paper);
    return dedupeAliases(aliases).filter((alias) => (
      ['doi', 'arxiv', 'arxiv_base', 'pmid', 'pmcid', 's2', 's2_corpus', 'openalex'].includes(alias.field)
    ));
  }

  if (policy === 'expanded-identifiers') {
    addRawIdAliases(aliases, paper);
    addExistingIdentifierAliases(aliases, paper);
    addExpandedIdentifierAliases(aliases, paper);
    return dedupeAliases(aliases);
  }

  if (policy === 'expanded-with-title') {
    addRawIdAliases(aliases, paper);
    addExistingIdentifierAliases(aliases, paper);
    addExpandedIdentifierAliases(aliases, paper);
    addTitleAlias(aliases, paper);
    return dedupeAliases(aliases);
  }

  throw new Error(`Unknown identity normalization policy: ${policy}`);
}

function paperLabel(paper = {}, fallback = '') {
  return compactText(paper.title || paper.paperTitle || paper.paper_title || paper.id || fallback);
}

function buildCorpusAliasMap(corpus = [], policy = 'baseline') {
  const aliasToCorpus = new Map();
  const corpusRecords = corpus.map((paper, index) => ({
    index,
    id: compactText(paper.id || paper.canonicalId || `corpus:${index}`),
    title: paperLabel(paper, `corpus:${index}`),
    aliases: collectPolicyAliases(paper, policy)
  }));

  for (const record of corpusRecords) {
    for (const alias of record.aliases) {
      const matches = aliasToCorpus.get(alias.value) || [];
      matches.push({ ...record, matchedAlias: alias });
      aliasToCorpus.set(alias.value, matches);
    }
  }

  return {
    corpusRecords,
    aliasToCorpus
  };
}

function resolveGoldPaper(gold = {}, aliasMap = new Map(), policy = 'baseline') {
  const aliases = collectPolicyAliases(gold, policy);
  const matchesByCorpusId = new Map();
  for (const alias of aliases) {
    for (const match of aliasMap.get(alias.value) || []) {
      const key = match.id || `corpus:${match.index}`;
      const existing = matchesByCorpusId.get(key);
      if (!existing) {
        matchesByCorpusId.set(key, {
          id: key,
          index: match.index,
          title: match.title,
          matchedAliases: [alias]
        });
      } else {
        existing.matchedAliases.push(alias);
      }
    }
  }
  const matches = [...matchesByCorpusId.values()];
  return {
    aliases,
    matches,
    status: matches.length === 1 ? 'resolved' : (matches.length > 1 ? 'collision' : 'unresolved')
  };
}

function summarizeRows(rows = [], baselineRows = []) {
  const baselineResolvedKeys = new Set(
    baselineRows
      .filter((row) => row.status === 'resolved')
      .map((row) => row.goldKey)
  );
  const goldCount = rows.length;
  const resolvedRows = rows.filter((row) => row.status === 'resolved');
  const collisionRows = rows.filter((row) => row.status === 'collision');
  const unresolvedRows = rows.filter((row) => row.status === 'unresolved');
  const fieldCounts = {};
  for (const row of resolvedRows) {
    const field = row.matchedAliases[0]?.field || 'unknown';
    fieldCounts[field] = (fieldCounts[field] || 0) + 1;
  }
  const queryIds = new Set(rows.map((row) => row.queryId));
  const queriesWithResolvedGold = new Set(resolvedRows.map((row) => row.queryId));
  const newResolutionsVsBaseline = resolvedRows.filter((row) => !baselineResolvedKeys.has(row.goldKey)).length;
  return {
    policy: rows[0]?.policy || '',
    goldCount,
    resolvedGoldCount: resolvedRows.length,
    unresolvedGoldCount: unresolvedRows.length,
    collisionGoldCount: collisionRows.length,
    resolutionRate: goldCount ? resolvedRows.length / goldCount : 0,
    unresolvedRate: goldCount ? unresolvedRows.length / goldCount : 0,
    collisionRate: goldCount ? collisionRows.length / goldCount : 0,
    queryCount: queryIds.size,
    queriesWithResolvedGold: queriesWithResolvedGold.size,
    queryResolutionRate: queryIds.size ? queriesWithResolvedGold.size / queryIds.size : 0,
    aliasMean: goldCount
      ? rows.reduce((sum, row) => sum + row.aliasCount, 0) / goldCount
      : 0,
    newResolutionsVsBaseline,
    resolvedByField: fieldCounts
  };
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderSummaryTsv(summaries = []) {
  const fields = [...new Set(summaries.flatMap((summary) => Object.keys(summary.resolvedByField || {})))].sort();
  const headers = [
    'policy',
    'gold_count',
    'resolved_gold',
    'resolution_rate',
    'unresolved_gold',
    'collision_gold',
    'query_count',
    'queries_with_resolved_gold',
    'query_resolution_rate',
    'alias_mean',
    'new_resolutions_vs_baseline',
    ...fields.map((field) => `resolved_by_${field}`)
  ];
  const lines = [headers.join('\t')];
  for (const summary of summaries) {
    lines.push([
      summary.policy,
      summary.goldCount,
      summary.resolvedGoldCount,
      formatNumber(summary.resolutionRate),
      summary.unresolvedGoldCount,
      summary.collisionGoldCount,
      summary.queryCount,
      summary.queriesWithResolvedGold,
      formatNumber(summary.queryResolutionRate),
      formatNumber(summary.aliasMean),
      summary.newResolutionsVsBaseline,
      ...fields.map((field) => summary.resolvedByField?.[field] || 0)
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report = {}) {
  const lines = [
    `# Identity Normalization Sweep: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Benchmark: ${report.benchmark?.name || 'unknown'}`,
    `- Dataset: ${report.datasetPath || 'in-memory benchmark'}`,
    '',
    '| Policy | Gold | Resolved | Resolution | Collisions | New vs baseline |',
    '|---|---:|---:|---:|---:|---:|'
  ];
  for (const summary of report.summaries || []) {
    lines.push(`| ${summary.policy} | ${summary.goldCount} | ${summary.resolvedGoldCount} | ${formatNumber(summary.resolutionRate)} | ${summary.collisionGoldCount} | ${summary.newResolutionsVsBaseline} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function appendJsonl(filePath, row) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

export async function runIdentityNormalizationSweep(inputOptions = {}) {
  const runId = inputOptions.runId || `identity-normalization-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'benchmarks', 'identity-normalization-sweeps', runId));
  const datasetPath = inputOptions.datasetPath || inputOptions.dataset;
  if (!inputOptions.benchmark && !datasetPath) {
    throw new Error('A datasetPath or in-memory benchmark is required for identity normalization sweep.');
  }

  const benchmark = inputOptions.benchmark || await loadRetrievalBenchmark(datasetPath, inputOptions);
  const queries = asArray(benchmark.queries).slice(0, inputOptions.benchmarkLimit || undefined);
  const corpus = asArray(benchmark.corpus);
  if (!corpus.length) {
    throw new Error(`Benchmark ${benchmark.name || benchmark.format || ''} does not include a local corpus for identity normalization sweep.`);
  }

  const policies = parseCsv(inputOptions.policies, DEFAULT_POLICIES);
  const manifestPath = path.join(outputDir, 'identity-normalization-manifest.json');
  const rowsPath = path.join(outputDir, 'identity-normalization-results.jsonl');
  const unresolvedPath = path.join(outputDir, 'unresolved-gold.jsonl');
  const collisionsPath = path.join(outputDir, 'collisions.jsonl');
  const reportPath = path.join(outputDir, 'report.json');
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  const summaryTsvPath = path.join(outputDir, 'summary.tsv');

  await ensureDir(outputDir);
  await Promise.all([
    fs.rm(rowsPath, { force: true }),
    fs.rm(unresolvedPath, { force: true }),
    fs.rm(collisionsPath, { force: true })
  ]);

  const startedAt = new Date().toISOString();
  await writeJson(manifestPath, {
    runId,
    kind: 'identity-normalization-sweep',
    startedAt,
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: queries.length,
      corpusSize: corpus.length
    },
    policies
  });

  const rowsByPolicy = new Map();
  for (const policy of policies) {
    const { aliasToCorpus } = buildCorpusAliasMap(corpus, policy);
    const policyRows = [];
    for (const [queryIndex, query] of queries.entries()) {
      const queryId = compactText(query.id || `query:${queryIndex}`);
      for (const [goldIndex, gold] of asArray(query.relevant).entries()) {
        const resolved = resolveGoldPaper(gold, aliasToCorpus, policy);
        const row = {
          policy,
          queryId,
          query: compactText(query.query),
          goldKey: `${queryId}:${goldIndex}`,
          goldIndex,
          goldTitle: paperLabel(gold, `gold:${goldIndex}`),
          status: resolved.status,
          aliasCount: resolved.aliases.length,
          aliases: resolved.aliases.slice(0, 20),
          matchedCorpusIds: resolved.matches.map((match) => match.id),
          matchedCorpusTitles: resolved.matches.map((match) => match.title),
          matchedAliases: resolved.matches.flatMap((match) => match.matchedAliases).slice(0, 20)
        };
        policyRows.push(row);
        await appendJsonl(rowsPath, row);
        if (row.status === 'unresolved') await appendJsonl(unresolvedPath, row);
        if (row.status === 'collision') await appendJsonl(collisionsPath, row);
      }
    }
    rowsByPolicy.set(policy, policyRows);
  }

  const baselineRows = rowsByPolicy.get('baseline') || [];
  const summaries = policies.map((policy) => summarizeRows(rowsByPolicy.get(policy) || [], baselineRows));
  const rows = policies.flatMap((policy) => rowsByPolicy.get(policy) || []);
  const report = {
    runId,
    kind: 'identity-normalization-sweep',
    status: 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    datasetPath: datasetPath ? path.resolve(datasetPath) : null,
    outputDir,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      queryCount: queries.length,
      corpusSize: corpus.length
    },
    policies,
    summaries,
    rows,
    artifacts: {
      manifestPath,
      rowsPath,
      unresolvedPath,
      collisionsPath,
      summaryTsvPath,
      reportPath,
      reportMarkdownPath
    }
  };

  await writeJson(reportPath, report);
  await writeText(reportMarkdownPath, renderMarkdown(report));
  await writeText(summaryTsvPath, renderSummaryTsv(summaries));
  return report;
}

async function main() {
  const options = parseArgs();
  const report = await runIdentityNormalizationSweep(options);
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    summaries: report.summaries.map((summary) => ({
      policy: summary.policy,
      resolutionRate: summary.resolutionRate,
      newResolutionsVsBaseline: summary.newResolutionsVsBaseline
    }))
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
