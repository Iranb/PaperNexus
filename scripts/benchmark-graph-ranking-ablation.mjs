#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  evaluateRetrievalResults,
  loadRetrievalBenchmark
} from '../src/core/benchmarks/retrieval.js';
import {
  normalizePaperIdentifiers,
  paperIdentifiersOverlap
} from '../src/lib/paper-identifiers.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import {
  scoreTokenOverlap,
  stableHash,
  tokenizeWithoutStopwords,
  unique
} from '../src/lib/utils.js';

const DEFAULT_MODES = ['text-only', 'graph-only', 'hybrid'];
const DEFAULT_CUTOFFS = [1, 5, 10, 20, 100];
const RELATION_WEIGHTS = {
  cites: 1,
  citation: 1,
  references: 1,
  reference: 1,
  related: 0.85,
  uses: 1.2,
  extends: 1.15,
  improves: 1.15,
  compares: 0.75,
  same_topic: 0.8,
  co_citation: 0.7,
  bibliographic_coupling: 0.7
};

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

function parseNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
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

  const runId = String(options.runId || `graph-ranking-ablation-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    datasetPath: options.datasetPath || options.dataset,
    format: options.format,
    rootPath: options.rootPath,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'graph-ranking-ablations', runId)),
    modes: parseCsv(options.modes || options.mode, DEFAULT_MODES),
    cutoffs: parseCsv(options.cutoffs || options.k, DEFAULT_CUTOFFS).map((value) => parseInteger(value, null)).filter(Boolean),
    benchmarkLimit: parseInteger(options.benchmarkLimit || options.limit, null),
    maxCandidates: parseInteger(options.maxCandidates || options.maxResults, 100),
    textSeedLimit: parseInteger(options.textSeedLimit, 5),
    graphHopLimit: parseInteger(options.graphHopLimit || options.hops, 2),
    graphNeighborLimit: parseInteger(options.graphNeighborLimit || options.neighbors, 100),
    hybridTextWeight: parseNumber(options.hybridTextWeight, 0.55),
    hybridGraphWeight: parseNumber(options.hybridGraphWeight, 0.45),
    includeSeedPapers: parseBoolean(options.includeSeedPapers, false),
    resume: parseBoolean(options.resume, false)
  };
}

async function appendJsonl(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function mean(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function paperTitle(paper = {}) {
  return compactText(paper.title || paper.paperTitle || paper.name);
}

function paperAbstract(paper = {}) {
  return compactText(paper.abstract || paper.summary || paper.description);
}

function normalizePaper(paper = {}, index = 0) {
  const identifiers = normalizePaperIdentifiers({
    ...asObject(paper.identifiers),
    ...paper
  });
  const title = paperTitle(paper);
  const id = compactText(
    paper.id
    || paper.paperId
    || paper.paper_id
    || paper.corpusId
    || paper.corpus_id
    || paper.canonicalId
    || paper.canonical_id
    || identifiers.doi
    || identifiers.arxivId
    || title
    || `paper-${index}`
  );
  return {
    ...paper,
    id,
    canonicalId: compactText(paper.canonicalId || paper.canonical_id || id),
    title,
    abstract: paperAbstract(paper),
    identifiers
  };
}

function identifierAliases(paper = {}) {
  const aliases = [
    paper.id,
    paper.paperId,
    paper.paper_id,
    paper.corpusId,
    paper.corpus_id,
    paper.canonicalId,
    paper.canonical_id,
    ...(Array.isArray(paper.identityAliases) ? paper.identityAliases : [])
  ];
  const identifiers = normalizePaperIdentifiers({
    ...asObject(paper.identifiers),
    ...paper
  });
  for (const [field, value] of Object.entries(identifiers)) {
    aliases.push(`${field}:${String(value).toLowerCase()}`, value);
  }
  const title = paperTitle(paper).toLowerCase();
  if (title) aliases.push(`title:${title}`);
  return unique(aliases.map((entry) => compactText(entry).toLowerCase()).filter(Boolean));
}

function buildCorpusIndex(corpus = []) {
  const papers = corpus.map((paper, index) => normalizePaper(paper, index));
  const aliasToIndex = new Map();
  papers.forEach((paper, index) => {
    for (const alias of identifierAliases(paper)) {
      if (!aliasToIndex.has(alias)) aliasToIndex.set(alias, index);
    }
  });
  return { papers, aliasToIndex };
}

function resolvePaperIndex(value, corpusIndex) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < corpusIndex.papers.length) return value;
  const raw = compactText(value).toLowerCase();
  if (corpusIndex.aliasToIndex.has(raw)) return corpusIndex.aliasToIndex.get(raw);
  if (corpusIndex.aliasToIndex.has(`title:${raw}`)) return corpusIndex.aliasToIndex.get(`title:${raw}`);
  for (let index = 0; index < corpusIndex.papers.length; index += 1) {
    if (paperIdentifiersOverlap(corpusIndex.papers[index], { id: value, canonicalId: value })) return index;
  }
  return null;
}

function relationWeight(type = '') {
  const normalized = compactText(type).toLowerCase().replace(/[\s-]+/g, '_');
  return RELATION_WEIGHTS[normalized] || 0.8;
}

function addAdjacency(adjacency, leftIndex, rightIndex, type = 'related', directed = false) {
  if (leftIndex === null || rightIndex === null || leftIndex === rightIndex) return;
  const weight = relationWeight(type);
  adjacency.get(leftIndex).push({ target: rightIndex, type, weight });
  if (!directed) adjacency.get(rightIndex).push({ target: leftIndex, type, weight });
}

function graphEdgesFromPaper(paper = {}) {
  const edges = [];
  for (const field of ['references', 'referenceIds', 'reference_ids', 'citedPaperIds', 'cited_paper_ids']) {
    for (const target of asArray(paper[field])) {
      edges.push({ source: paper.id || paper.canonicalId, target, type: 'references', directed: false });
    }
  }
  for (const field of ['citations', 'citationIds', 'citation_ids', 'citedBy', 'cited_by']) {
    for (const target of asArray(paper[field])) {
      edges.push({ source: paper.id || paper.canonicalId, target, type: 'cites', directed: false });
    }
  }
  return edges;
}

function normalizeGraphEdge(edge = {}) {
  if (Array.isArray(edge)) {
    return {
      source: edge[0],
      target: edge[1],
      type: edge[2] || 'related',
      directed: false
    };
  }
  return {
    source: edge.source ?? edge.sourceId ?? edge.from ?? edge.left ?? edge.paperId ?? edge.paper_id,
    target: edge.target ?? edge.targetId ?? edge.to ?? edge.right ?? edge.relatedPaperId ?? edge.related_paper_id,
    type: edge.type || edge.relation || edge.relationship || 'related',
    directed: Boolean(edge.directed)
  };
}

function collectGraphEdges(benchmark = {}, papers = []) {
  return [
    ...asArray(benchmark.graph?.edges),
    ...asArray(benchmark.graph?.relationships),
    ...asArray(benchmark.edges),
    ...asArray(benchmark.relationships),
    ...papers.flatMap((paper) => graphEdgesFromPaper(paper))
  ].map(normalizeGraphEdge);
}

function buildGraphIndex(benchmark = {}, corpusIndex = {}) {
  const adjacency = new Map(corpusIndex.papers.map((_, index) => [index, []]));
  let edgeCount = 0;
  for (const edge of collectGraphEdges(benchmark, corpusIndex.papers)) {
    const source = resolvePaperIndex(edge.source, corpusIndex);
    const target = resolvePaperIndex(edge.target, corpusIndex);
    if (source === null || target === null || source === target) continue;
    addAdjacency(adjacency, source, target, edge.type, edge.directed);
    edgeCount += 1;
  }
  return {
    adjacency,
    edgeCount,
    nodeCount: corpusIndex.papers.length
  };
}

function querySourceAliases(queryCase = {}) {
  const metadata = asObject(queryCase.metadata);
  return unique([
    queryCase.sourcePaperId,
    queryCase.source_paper_id,
    queryCase.queryPaperId,
    queryCase.query_paper_id,
    metadata.sourcePaperId,
    metadata.source_paper_id,
    metadata.queryPaperId,
    metadata.query_paper_id,
    metadata.native?.sourcePaperId,
    metadata.native?.queryPaperId
  ].map((entry) => compactText(entry)).filter(Boolean));
}

function textScore(queryCase = {}, paper = {}) {
  const query = compactText(queryCase.query);
  const queryTokens = tokenizeWithoutStopwords(query);
  const titleTokens = tokenizeWithoutStopwords(paper.title);
  const abstractTokens = tokenizeWithoutStopwords(paper.abstract);
  const titleOverlap = scoreTokenOverlap(queryTokens, titleTokens);
  const abstractOverlap = scoreTokenOverlap(queryTokens, abstractTokens);
  const compactQuery = query.toLowerCase();
  const compactTitle = compactText(paper.title).toLowerCase();
  const exactTitle = compactQuery && compactQuery === compactTitle ? 2.5 : 0;
  const phrase = compactQuery && compactTitle.includes(compactQuery) ? 1 : 0;
  return (titleOverlap * 2.5) + abstractOverlap + exactTitle + phrase;
}

function scoreAllText(queryCase = {}, papers = []) {
  return papers.map((paper, index) => ({
    index,
    score: textScore(queryCase, paper)
  }));
}

function resolveSeedIndexes(queryCase = {}, textScores = [], corpusIndex = {}, options = {}) {
  const explicitSeeds = querySourceAliases(queryCase)
    .map((alias) => resolvePaperIndex(alias, corpusIndex))
    .filter((index) => index !== null);
  if (explicitSeeds.length) return unique(explicitSeeds);
  return textScores
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Number(options.textSeedLimit || 5)))
    .map((entry) => entry.index);
}

function scoreGraphNeighborhood(seedIndexes = [], graphIndex = {}, options = {}) {
  const hopLimit = Math.max(1, Number(options.graphHopLimit || 2));
  const neighborLimit = Math.max(1, Number(options.graphNeighborLimit || 100));
  const adjacency = graphIndex.adjacency || new Map();
  const seedSet = new Set(seedIndexes);
  const scores = new Map();
  const queue = seedIndexes.map((index) => ({ index, depth: 0, seedWeight: 1 }));
  const visitedDepth = new Map(seedIndexes.map((index) => [index, 0]));

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= hopLimit) continue;
    const neighbors = [...(adjacency.get(current.index) || [])]
      .sort((left, right) => right.weight - left.weight)
      .slice(0, neighborLimit);
    for (const edge of neighbors) {
      const nextDepth = current.depth + 1;
      const degree = Math.max(1, (adjacency.get(edge.target) || []).length);
      const contribution = (edge.weight * current.seedWeight) / (nextDepth * Math.sqrt(degree));
      if (!seedSet.has(edge.target) || options.includeSeedPapers) {
        scores.set(edge.target, (scores.get(edge.target) || 0) + contribution);
      }
      const previousDepth = visitedDepth.get(edge.target);
      if ((previousDepth === undefined || nextDepth < previousDepth) && nextDepth < hopLimit) {
        visitedDepth.set(edge.target, nextDepth);
        queue.push({ index: edge.target, depth: nextDepth, seedWeight: Math.max(0.25, contribution) });
      }
    }
  }
  return scores;
}

function normalizedScoreMap(entries = []) {
  const scores = entries.map((entry) => Number(entry.score || 0)).filter(Number.isFinite);
  const max = scores.length ? Math.max(...scores) : 0;
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.index, max > 0 ? Number(entry.score || 0) / max : 0);
  }
  return map;
}

function rankedCandidatesForMode(queryCase = {}, corpusIndex = {}, graphIndex = {}, mode = 'hybrid', options = {}) {
  const textScores = scoreAllText(queryCase, corpusIndex.papers);
  const seedIndexes = resolveSeedIndexes(queryCase, textScores, corpusIndex, options);
  const seedSet = new Set(seedIndexes);
  const graphScores = scoreGraphNeighborhood(seedIndexes, graphIndex, options);
  const sourceAliases = new Set(querySourceAliases(queryCase).map((entry) => entry.toLowerCase()));
  const textNorm = normalizedScoreMap(textScores);
  const graphNorm = normalizedScoreMap([...graphScores.entries()].map(([index, score]) => ({ index, score })));
  const maxCandidates = Math.max(1, Number(options.maxCandidates || 100));

  const rows = corpusIndex.papers.map((paper, index) => {
    const rawTextScore = textScores[index]?.score || 0;
    const rawGraphScore = graphScores.get(index) || 0;
    const score = mode === 'text-only'
      ? rawTextScore
      : mode === 'graph-only'
        ? rawGraphScore
        : ((Number(options.hybridTextWeight ?? 0.55) * (textNorm.get(index) || 0))
          + (Number(options.hybridGraphWeight ?? 0.45) * (graphNorm.get(index) || 0)));
    return {
      paper,
      index,
      score,
      textScore: rawTextScore,
      graphScore: rawGraphScore
    };
  }).filter((entry) => {
    if (!options.includeSeedPapers && seedSet.has(entry.index)) return false;
    const aliases = identifierAliases(entry.paper).map((alias) => alias.toLowerCase());
    if (!options.includeSeedPapers && aliases.some((alias) => sourceAliases.has(alias))) return false;
    return entry.score > 0;
  });

  return {
    seedIndexes,
    candidates: rows
      .sort((left, right) => right.score - left.score || left.paper.title.localeCompare(right.paper.title))
      .slice(0, maxCandidates)
      .map((entry) => ({
        ...entry.paper,
        score: entry.score,
        ablationMode: mode,
        ablationTextScore: entry.textScore,
        ablationGraphScore: entry.graphScore,
        sourceProvider: `graph_ablation_${mode}`
      }))
  };
}

function benchmarkQueryKey(queryCase = {}, index = 0) {
  return compactText(queryCase.id || queryCase.queryId || queryCase.query_id || `query-${index}`)
    || stableHash(`${index}:${queryCase.query || ''}`, 16);
}

function aggregateMetrics(results = []) {
  const keys = unique(results.flatMap((result) => Object.keys(result.metrics || {}))).sort();
  return Object.fromEntries(keys.map((key) => [key, mean(results.map((result) => result.metrics?.[key] || 0))]));
}

function summarizeMode(mode = '', results = []) {
  const completed = results.filter((result) => result.status === 'completed');
  const withGold = completed.filter((result) => result.relevantCount > 0);
  return {
    mode,
    status: completed.length === results.length ? 'completed' : 'partial',
    evaluatedQueries: completed.length,
    queriesWithGold: withGold.length,
    zeroMatchQueries: withGold.filter((result) => !result.firstRelevantRank).length,
    averageRetrievedCount: mean(completed.map((result) => result.retrievedCount || 0)),
    averageSeedCount: mean(completed.map((result) => result.ablation?.seedCount || 0)),
    metrics: aggregateMetrics(completed)
  };
}

function renderSummaryTsv(modeSummaries = []) {
  const metricKeys = unique(modeSummaries.flatMap((summary) => Object.keys(summary.metrics || {}))).sort();
  const lines = [[
    'mode',
    'evaluated_queries',
    'queries_with_gold',
    'zero_match_queries',
    'average_retrieved_count',
    'average_seed_count',
    ...metricKeys
  ].join('\t')];
  for (const summary of modeSummaries) {
    lines.push([
      summary.mode,
      summary.evaluatedQueries,
      summary.queriesWithGold,
      summary.zeroMatchQueries,
      formatNumber(summary.averageRetrievedCount),
      formatNumber(summary.averageSeedCount),
      ...metricKeys.map((key) => formatNumber(summary.metrics?.[key]))
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown(report = {}) {
  const metricKeys = unique((report.modeSummaries || []).flatMap((summary) => Object.keys(summary.metrics || {}))).sort();
  return [
    `# Graph Ranking Ablation: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Dataset: ${report.benchmark?.name || report.benchmark?.sourcePath || ''}`,
    `- Corpus size: ${report.graph?.nodeCount || 0}`,
    `- Graph edges: ${report.graph?.edgeCount || 0}`,
    `- Hop limit: ${report.config?.graphHopLimit || 0}`,
    `- Max candidates: ${report.config?.maxCandidates || 0}`,
    '',
    '## Mode Summary',
    '',
    `| Mode | Queries | Zero-match | Avg candidates | Avg seeds | ${metricKeys.join(' | ')} |`,
    `|---|---:|---:|---:|---:|${metricKeys.map(() => '---:').join('|')}|`,
    ...(report.modeSummaries || []).map((summary) => [
      summary.mode,
      summary.evaluatedQueries,
      summary.zeroMatchQueries,
      formatNumber(summary.averageRetrievedCount),
      formatNumber(summary.averageSeedCount),
      ...metricKeys.map((key) => formatNumber(summary.metrics?.[key]))
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
    '## Artifacts',
    '',
    `- \`${report.artifacts?.manifestPath || ''}\``,
    `- \`${report.artifacts?.perQueryResultsPath || ''}\``,
    `- \`${report.artifacts?.summaryTsvPath || ''}\``,
    `- \`${report.artifacts?.reportPath || ''}\``
  ].join('\n');
}

function selectQueries(benchmark = {}, options = {}) {
  const limit = Math.max(0, Number(options.benchmarkLimit || options.limit || 0));
  return limit ? asArray(benchmark.queries).slice(0, limit) : asArray(benchmark.queries);
}

async function writeCheckpoint(artifactPaths = {}, payload = {}) {
  if (!artifactPaths.checkpointPath) return;
  await writeJson(artifactPaths.checkpointPath, {
    ...payload,
    updatedAt: new Date().toISOString()
  });
}

export async function runGraphRankingAblation(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-ranking-ablation-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const options = {
    runId,
    modes: DEFAULT_MODES,
    cutoffs: DEFAULT_CUTOFFS,
    maxCandidates: 100,
    textSeedLimit: 5,
    graphHopLimit: 2,
    graphNeighborLimit: 100,
    hybridTextWeight: 0.55,
    hybridGraphWeight: 0.45,
    includeSeedPapers: false,
    resume: false,
    ...inputOptions
  };
  const outputDir = path.resolve(options.outputDir || path.join('.papernexus', 'benchmarks', 'graph-ranking-ablations', runId));
  const benchmark = options.benchmark || await loadRetrievalBenchmark(options.datasetPath, options);
  const selectedQueries = selectQueries(benchmark, options);
  const corpus = asArray(options.corpus || benchmark.corpus);
  if (!corpus.length) {
    throw new Error(`Benchmark ${benchmark.name || benchmark.format || ''} does not include a local corpus for graph ranking ablation.`);
  }

  const modes = parseCsv(options.modes, DEFAULT_MODES).filter((mode) => DEFAULT_MODES.includes(mode));
  const cutoffs = asArray(options.cutoffs?.length ? options.cutoffs : DEFAULT_CUTOFFS)
    .map((value) => parseInteger(value, null))
    .filter(Boolean);
  const artifacts = {
    manifestPath: path.join(outputDir, 'graph-ranking-ablation-manifest.json'),
    perQueryResultsPath: path.join(outputDir, 'per-query-results.jsonl'),
    failuresPath: path.join(outputDir, 'failures.jsonl'),
    checkpointPath: path.join(outputDir, 'checkpoint.json'),
    summaryTsvPath: path.join(outputDir, 'summary.tsv'),
    reportPath: path.join(outputDir, 'report.json'),
    reportMarkdownPath: path.join(outputDir, 'report.md'),
    timePath: path.join(outputDir, 'time.txt')
  };
  await ensureDir(outputDir);

  if (!options.resume) {
    await Promise.all([
      fs.rm(artifacts.perQueryResultsPath, { force: true }),
      fs.rm(artifacts.failuresPath, { force: true })
    ]);
  }

  const startedAt = new Date().toISOString();
  const startTime = performance.now();
  await writeJson(artifacts.manifestPath, {
    contractVersion: 'graph-ranking-ablation-v1',
    kind: 'graph-ranking-ablation',
    runId,
    startedAt,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      sourcePath: benchmark.sourcePath,
      queryCount: selectedQueries.length,
      corpusSize: corpus.length
    },
    config: {
      modes,
      cutoffs,
      maxCandidates: options.maxCandidates,
      textSeedLimit: options.textSeedLimit,
      graphHopLimit: options.graphHopLimit,
      graphNeighborLimit: options.graphNeighborLimit,
      includeSeedPapers: options.includeSeedPapers,
      hybridTextWeight: options.hybridTextWeight,
      hybridGraphWeight: options.hybridGraphWeight
    }
  });

  const completedRows = options.resume ? await readJsonl(artifacts.perQueryResultsPath) : [];
  const completedKeys = new Set(completedRows.map((row) => `${row.mode}:${row.queryKey}`));
  const corpusIndex = buildCorpusIndex(corpus);
  const graphIndex = buildGraphIndex(benchmark, corpusIndex);
  const rows = [...completedRows];

  await writeCheckpoint(artifacts, {
    status: 'running',
    totalRows: selectedQueries.length * modes.length,
    completedRows: rows.length,
    resumedRows: completedRows.length
  });

  for (let queryIndex = 0; queryIndex < selectedQueries.length; queryIndex += 1) {
    const queryCase = selectedQueries[queryIndex];
    const queryKey = benchmarkQueryKey(queryCase, queryIndex);
    for (const mode of modes) {
      const rowKey = `${mode}:${queryKey}`;
      if (completedKeys.has(rowKey)) continue;
      const queryStartedAt = performance.now();
      try {
        const ranked = rankedCandidatesForMode(queryCase, corpusIndex, graphIndex, mode, options);
        const evaluation = evaluateRetrievalResults(queryCase, ranked.candidates, {
          cutoffs,
          titleMatchThreshold: options.titleMatchThreshold
        });
        const row = {
          ...evaluation,
          status: 'completed',
          runId,
          mode,
          queryKey,
          durationMs: performance.now() - queryStartedAt,
          ablation: {
            seedCount: ranked.seedIndexes.length,
            seedPaperIds: ranked.seedIndexes.map((index) => corpusIndex.papers[index]?.id).filter(Boolean),
            graphEdgeCount: graphIndex.edgeCount,
            graphNodeCount: graphIndex.nodeCount
          }
        };
        rows.push(row);
        completedKeys.add(rowKey);
        await appendJsonl(artifacts.perQueryResultsPath, row);
      } catch (error) {
        const failure = {
          runId,
          mode,
          queryKey,
          queryId: queryCase.id || null,
          query: queryCase.query || '',
          status: 'failed',
          error: {
            name: error?.name || 'Error',
            message: error?.message || String(error)
          },
          updatedAt: new Date().toISOString()
        };
        await appendJsonl(artifacts.failuresPath, failure);
        rows.push({
          id: queryCase.id,
          query: queryCase.query,
          status: 'failed',
          runId,
          mode,
          queryKey,
          metrics: {}
        });
      }
      await writeCheckpoint(artifacts, {
        status: 'running',
        totalRows: selectedQueries.length * modes.length,
        completedRows: rows.length,
        lastMode: mode,
        lastQueryKey: queryKey
      });
    }
  }

  const modeSummaries = modes.map((mode) => summarizeMode(mode, rows.filter((row) => row.mode === mode)));
  const endedAt = new Date().toISOString();
  const report = {
    contractVersion: 'graph-ranking-ablation-v1',
    kind: 'graph-ranking-ablation',
    runId,
    status: rows.some((row) => row.status === 'failed') ? 'completed_with_failures' : 'completed',
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    wallMs: performance.now() - startTime,
    benchmark: {
      name: benchmark.name,
      format: benchmark.format,
      sourcePath: benchmark.sourcePath,
      evaluatedQueries: selectedQueries.length,
      corpusSize: corpus.length
    },
    graph: {
      nodeCount: graphIndex.nodeCount,
      edgeCount: graphIndex.edgeCount,
      averageDegree: graphIndex.nodeCount ? (graphIndex.edgeCount * 2) / graphIndex.nodeCount : 0
    },
    config: {
      modes,
      cutoffs,
      maxCandidates: options.maxCandidates,
      textSeedLimit: options.textSeedLimit,
      graphHopLimit: options.graphHopLimit,
      graphNeighborLimit: options.graphNeighborLimit,
      includeSeedPapers: options.includeSeedPapers,
      hybridTextWeight: options.hybridTextWeight,
      hybridGraphWeight: options.hybridGraphWeight
    },
    modeSummaries,
    rows,
    artifacts
  };

  await writeText(artifacts.summaryTsvPath, renderSummaryTsv(modeSummaries));
  await writeJson(artifacts.reportPath, report);
  await writeText(artifacts.reportMarkdownPath, renderMarkdown(report));
  await writeText(artifacts.timePath, [
    `started_at=${startedAt}`,
    `ended_at=${endedAt}`,
    `wall_ms=${formatNumber(report.wallMs)}`,
    `status=${report.status}`,
    `queries=${selectedQueries.length}`,
    `modes=${modes.join(',')}`,
    `graph_edges=${graphIndex.edgeCount}`
  ].join('\n') + '\n');
  await writeCheckpoint(artifacts, {
    status: report.status,
    totalRows: selectedQueries.length * modes.length,
    completedRows: rows.length
  });

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGraphRankingAblation(parseArgs())
    .then((report) => {
      process.stdout.write(`${JSON.stringify({
        runId: report.runId,
        status: report.status,
        outputDir: path.dirname(report.artifacts.reportPath),
        reportPath: report.artifacts.reportPath,
        summaryTsvPath: report.artifacts.summaryTsvPath,
        modeSummaries: report.modeSummaries
      }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    });
}
