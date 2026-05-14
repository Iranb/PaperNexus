#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateMethodEvolutionBenchmark } from '../src/core/graph/method-evolution-benchmark.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import { runGraphRankingAblation } from './benchmark-graph-ranking-ablation.mjs';
import { runGraphIdentityDiagnostics } from './diagnose-graph-identity.mjs';
import { runGraphProvenanceAudit } from './audit-graph-provenance.mjs';

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
  const runId = String(options.runId || `graph-quality-improvement-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'graph-quality-improvement', runId))
  };
}

function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function graphRankingFixture() {
  const decoys = Array.from({ length: 20 }, (_, index) => ({
    id: `decoy-${index + 1}`,
    title: `Retrieval methods source evidence decoy ${index + 1}`,
    abstract: 'A lexical match about retrieval methods, source evidence, and graph search.',
    references: []
  }));
  return {
    name: 'graph-ranker-quality-fixture',
    format: 'custom',
    corpus: [
      {
        id: 'anchor',
        title: 'Sparse anchor study',
        abstract: 'Anchor paper with typed method evidence.'
      },
      {
        id: 'target',
        title: 'Neighborhood reranking for scholarly discovery',
        abstract: 'Typed graph evidence recovers the relevant method paper.',
        exactQuote: 'Typed graph evidence recovers the relevant method paper.',
        sourceSpan: { sourceId: 'source:target', start: 0, end: 58 }
      },
      ...decoys
    ],
    graph: {
      edges: [
        { source: 'anchor', target: 'target', type: 'uses' },
        ...decoys.flatMap((paper, index) => [
          { source: 'anchor', target: paper.id, type: 'related' },
          { source: paper.id, target: `decoy-${((index + 1) % decoys.length) + 1}`, type: 'same_topic' }
        ])
      ]
    },
    queries: [
      {
        id: 'q-quality',
        query: 'retrieval methods that use source evidence',
        graphSeeds: ['anchor'],
        relationTypes: ['uses'],
        relevant: [{ id: 'target', title: 'Neighborhood reranking for scholarly discovery' }]
      }
    ]
  };
}

function addMethod(graph, id, name, aliases = []) {
  graph.addNode({
    id,
    type: NODE_TYPES.METHOD,
    name,
    properties: { aliases }
  });
}

function addAcceptedMethodEdge(graph, sourceId, targetId, type, properties = {}) {
  graph.addRelationship({
    id: properties.id || `rel:${sourceId}:${targetId}`,
    sourceId,
    targetId,
    type,
    properties: {
      methodEvolution: true,
      validationStatus: 'accepted',
      candidateId: properties.candidateId || `candidate:${sourceId}:${targetId}`,
      exactQuote: properties.exactQuote || `${sourceId} connects to ${targetId}.`,
      exactMatch: properties.exactMatch ?? true,
      confidence: properties.confidence ?? 0.9,
      bottleneckDimension: properties.bottleneckDimension || 'general',
      mechanismDescription: properties.mechanismDescription || 'uses a validated method-evolution mechanism',
      tradeoffDescription: properties.tradeoffDescription || 'adds computational or modeling tradeoffs',
      evidenceCompletenessStatus: properties.evidenceCompletenessStatus || 'complete',
      ...properties
    }
  });
}

function createSmallBenchmarkPredictionGraph() {
  const graph = createKnowledgeGraph();
  addMethod(graph, 'method:tfidf', 'TF-IDF Retrieval', ['term frequency inverse document frequency retrieval']);
  addMethod(graph, 'method:bm25', 'BM25', ['Okapi BM25']);
  addMethod(graph, 'method:bert', 'BERT', ['Bidirectional Encoder Representations from Transformers']);
  addMethod(graph, 'method:dpr', 'Dense Passage Retrieval', ['DPR']);
  addMethod(graph, 'method:rag', 'Retrieval-Augmented Generation', ['RAG']);
  addMethod(graph, 'method:colbert', 'ColBERT', ['Contextualized Late Interaction over BERT']);
  addMethod(graph, 'method:rerank', 'Cross-Encoder Reranking', ['cross encoder reranker']);
  addMethod(graph, 'method:hybrid', 'Hybrid Sparse-Dense Retrieval', ['hybrid retrieval']);
  addMethod(graph, 'method:realm', 'REALM', ['Retrieval-Augmented Language Model Pre-Training']);
  addMethod(graph, 'method:atlas', 'Atlas', ['few-shot learning with retrieval augmented language models']);
  addMethod(graph, 'method:replug', 'REPLUG', ['retrieval plugged language model']);

  addAcceptedMethodEdge(graph, 'method:bm25', 'method:tfidf', EDGE_TYPES.IMPROVES_METHOD, { bottleneckDimension: 'lexical-matching' });
  addAcceptedMethodEdge(graph, 'method:dpr', 'method:bert', EDGE_TYPES.USES_COMPONENT_METHOD, { bottleneckDimension: 'semantic-matching' });
  addAcceptedMethodEdge(graph, 'method:rag', 'method:dpr', EDGE_TYPES.USES_COMPONENT_METHOD, { bottleneckDimension: 'knowledge-grounding' });
  addAcceptedMethodEdge(graph, 'method:colbert', 'method:bert', EDGE_TYPES.ADAPTS_METHOD, { bottleneckDimension: 'token-interaction' });
  addAcceptedMethodEdge(graph, 'method:rerank', 'method:bert', EDGE_TYPES.USES_COMPONENT_METHOD, { bottleneckDimension: 'ranking-quality' });
  addAcceptedMethodEdge(graph, 'method:hybrid', 'method:bm25', EDGE_TYPES.ADAPTS_METHOD, { bottleneckDimension: 'lexical-semantic-recall' });
  addAcceptedMethodEdge(graph, 'method:hybrid', 'method:dpr', EDGE_TYPES.ADAPTS_METHOD, { bottleneckDimension: 'lexical-semantic-recall' });
  addAcceptedMethodEdge(graph, 'method:realm', 'method:bert', EDGE_TYPES.ADAPTS_METHOD, { bottleneckDimension: 'parametric-memory' });
  addAcceptedMethodEdge(graph, 'method:atlas', 'method:rag', EDGE_TYPES.EXTENDS_METHOD, { bottleneckDimension: 'few-shot-knowledge' });
  addAcceptedMethodEdge(graph, 'method:replug', 'method:rag', EDGE_TYPES.ADAPTS_METHOD, { bottleneckDimension: 'black-box-lm' });
  return graph;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function renderMethodEvolutionMarkdown(report = {}) {
  return [
    '# Method Evolution Small Gold',
    '',
    `- Benchmark: ${report.field || ''}`,
    `- Nodes: ${report.diagnostics?.goldNodeCount || 0}`,
    `- Edges: ${report.diagnostics?.goldEdgeCount || 0}`,
    `- Chains: ${report.diagnostics?.goldChainCount || 0}`,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| NMR | ${formatNumber(report.metrics?.nmr?.value)} |`,
    `| ERR | ${formatNumber(report.metrics?.err?.value)} |`,
    `| PSC | ${formatNumber(report.metrics?.psc?.value)} |`,
    `| NR | ${formatNumber(report.metrics?.nr?.value)} |`,
    `| ER | ${formatNumber(report.metrics?.er?.value)} |`,
    `| CAS | ${formatNumber(report.metrics?.cas?.value)} |`
  ].join('\n');
}

function renderSummary(report = {}) {
  const rankingAll = report.ranking.modeSummaries.find((summary) => summary.mode === 'hybrid+all') || {};
  const rankingBase = report.ranking.modeSummaries.find((summary) => summary.mode === 'hybrid') || {};
  const rows = [
    ['ranking', 'Hit@10 delta', `${formatNumber((rankingAll.metrics?.['hit@10'] || 0) - (rankingBase.metrics?.['hit@10'] || 0))}`, 'fixture', 'graph-ranking-ablation/report.json'],
    ['ranking', 'Hit@100 delta', `${formatNumber((rankingAll.metrics?.['hit@100'] || 0) - (rankingBase.metrics?.['hit@100'] || 0))}`, 'fixture', 'graph-ranking-ablation/report.json'],
    ['provenance', 'source-span pass rate', formatNumber(report.provenance.metrics.source_span_presence_rate), 'fixture', 'provenance-audit/report.json'],
    ['provenance', 'dangling-link rate', formatNumber(report.provenance.metrics.dangling_source_link_rate), 'fixture', 'provenance-audit/report.json'],
    ['identity', 'duplicate canonical-key count', String(report.identity.metrics.duplicate_canonical_key_count), 'fixture', 'identity-diagnostics/report.json'],
    ['method evolution', 'NMR / ERR / PSC', `${formatNumber(report.methodEvolution.metrics.nmr.value)} / ${formatNumber(report.methodEvolution.metrics.err.value)} / ${formatNumber(report.methodEvolution.metrics.psc.value)}`, 'small gold fixture', 'method-evolution-small-gold/report.json'],
    ['lineage', 'NR / ER / CAS', `${formatNumber(report.methodEvolution.metrics.nr.value)} / ${formatNumber(report.methodEvolution.metrics.er.value)} / ${formatNumber(report.methodEvolution.metrics.cas.value)}`, 'small gold fixture', 'method-evolution-small-gold/report.json']
  ];
  return [
    `# PaperNexus Graph Quality Improvement Summary: ${report.runId}`,
    '',
    'Scope: fixture and small-gold validation only. No large dataset download, no full STaRK-MAG rerun, and no human review claims.',
    '',
    '| Area | Metric | Value | Scope | Artifact |',
    '|---|---|---:|---|---|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    `Graph ranking appendix table: \`${report.artifacts?.graphRankingAppendixTablePath || ''}\`.`,
    '',
    'Boundary: the graph ranking appendix table is `fixture_only` until the same ablation runner is executed on a frozen graph-aware real-corpus benchmark artifact.'
  ].join('\n');
}

function metricValue(summary = {}, key = '') {
  const value = summary.metrics?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function deltaValue(summary = {}, baseline = {}, key = '') {
  const current = metricValue(summary, key);
  const base = metricValue(baseline, key);
  if (current === null || base === null) return null;
  return current - base;
}

function buildGraphRankingAppendixRows(ranking = {}) {
  const baseline = ranking.modeSummaries?.find((summary) => summary.mode === 'hybrid') || {};
  return (ranking.modeSummaries || []).map((summary) => ({
    area: 'graph-ranking-ablation',
    mode: summary.mode,
    scope: 'fixture_only',
    gate: 'not_paper_ready',
    evaluatedQueries: summary.evaluatedQueries || 0,
    hit10: metricValue(summary, 'hit@10'),
    hit10DeltaVsHybrid: deltaValue(summary, baseline, 'hit@10'),
    hit100: metricValue(summary, 'hit@100'),
    recall20: metricValue(summary, 'recall@20'),
    recall100: metricValue(summary, 'recall@100'),
    recall100DeltaVsHybrid: deltaValue(summary, baseline, 'recall@100'),
    mrr10: metricValue(summary, 'mrr@10'),
    mrr10DeltaVsHybrid: deltaValue(summary, baseline, 'mrr@10'),
    ndcg10: metricValue(summary, 'ndcg@10'),
    averageLatencyMs: summary.averageLatencyMs,
    p95LatencyMs: summary.p95LatencyMs,
    averageExpandedCandidateCount: summary.averageExpandedCandidateCount,
    averageHubSuppressedCount: summary.averageHubSuppressedCount,
    averageEvidenceBoostedCount: summary.averageEvidenceBoostedCount,
    artifact: 'graph-ranking-ablation/report.json'
  }));
}

function tsvCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function renderGraphRankingAppendixTsv(rows = []) {
  const headers = [
    'area',
    'mode',
    'scope',
    'gate',
    'evaluated_queries',
    'hit@10',
    'hit@10_delta_vs_hybrid',
    'hit@100',
    'recall@20',
    'recall@100',
    'recall@100_delta_vs_hybrid',
    'mrr@10',
    'mrr@10_delta_vs_hybrid',
    'ndcg@10',
    'average_latency_ms',
    'p95_latency_ms',
    'average_expanded_candidates',
    'average_hub_suppressed',
    'average_evidence_boosted',
    'artifact'
  ];
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push([
      row.area,
      row.mode,
      row.scope,
      row.gate,
      row.evaluatedQueries,
      formatNumber(row.hit10),
      formatNumber(row.hit10DeltaVsHybrid),
      formatNumber(row.hit100),
      formatNumber(row.recall20),
      formatNumber(row.recall100),
      formatNumber(row.recall100DeltaVsHybrid),
      formatNumber(row.mrr10),
      formatNumber(row.mrr10DeltaVsHybrid),
      formatNumber(row.ndcg10),
      formatNumber(row.averageLatencyMs),
      formatNumber(row.p95LatencyMs),
      formatNumber(row.averageExpandedCandidateCount),
      formatNumber(row.averageHubSuppressedCount),
      formatNumber(row.averageEvidenceBoostedCount),
      row.artifact
    ].map(tsvCell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export async function runGraphQualityImprovementReport(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-quality-improvement-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'graph-quality-improvement', runId));
  const fixtureRoot = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
  const methodOutputDir = path.join(outputDir, 'method-evolution-small-gold');
  const manifestPath = path.join(outputDir, 'run-manifest.json');
  const summaryPath = path.join(outputDir, 'summary.md');
  const graphRankingAppendixTablePath = path.join(outputDir, 'graph-ranking-ablation-table.tsv');
  await ensureDir(outputDir);
  await ensureDir(methodOutputDir);

  const ranking = await runGraphRankingAblation({
    runId: `${runId}-ranking`,
    outputDir: path.join(outputDir, 'graph-ranking-ablation'),
    benchmark: graphRankingFixture(),
    modes: ['text-only', 'graph-only', 'hybrid', 'hybrid+relation-aware-seeds', 'hybrid+hub-penalty', 'hybrid+evidence-boost', 'hybrid+all'],
    cutoffs: [10, 20, 100],
    maxCandidates: 30,
    graphHopLimit: 1,
    hubDegreeThreshold: 2,
    hybridTextWeight: 0.25,
    hybridGraphWeight: 0.75,
    evidenceBoostWeight: 0.3
  });

  const provenance = await runGraphProvenanceAudit({
    runId: `${runId}-provenance`,
    outputDir: path.join(outputDir, 'provenance-audit'),
    inputPaths: [path.join(fixtureRoot, 'graph-provenance-audit-fixture.json')]
  });

  const identity = await runGraphIdentityDiagnostics({
    runId: `${runId}-identity`,
    outputDir: path.join(outputDir, 'identity-diagnostics'),
    inputPath: path.join(fixtureRoot, 'graph-identity-diagnostics-fixture.json')
  });

  const methodBenchmark = await readJson(path.join(fixtureRoot, 'method-evolution-benchmark-v1-small.json'));
  const methodEvolution = evaluateMethodEvolutionBenchmark(createSmallBenchmarkPredictionGraph(), methodBenchmark);
  await writeJson(path.join(methodOutputDir, 'report.json'), methodEvolution);
  await writeText(path.join(methodOutputDir, 'report.md'), renderMethodEvolutionMarkdown(methodEvolution));

  const graphRankingAblationRows = buildGraphRankingAppendixRows(ranking);
  const report = {
    runId,
    kind: 'graph-quality-improvement-summary',
    status: 'completed',
    outputDir,
    generatedAt: new Date().toISOString(),
    scope: 'fixture-and-small-gold',
    constraints: {
      noLargeDatasetDownload: true,
      noStarkMagRerun: true,
      noHumanReviewClaim: true
    },
    paperAppendix: {
      claimClass: 'fixture_only',
      gate: 'not_paper_ready',
      reason: 'Graph ranking ablation was generated from a controlled fixture, not a frozen graph-aware real-corpus benchmark artifact.',
      requiredNextStep: 'Run the same ablation modes on a named frozen real-corpus graph benchmark before promoting this table to a paper performance claim.',
      graphRankingAblationRows
    },
    ranking,
    provenance,
    identity,
    methodEvolution,
    artifacts: {
      manifestPath,
      summaryPath,
      rankingReportPath: ranking.artifacts.reportPath,
      graphRankingAppendixTablePath,
      provenanceReportPath: provenance.artifacts.reportPath,
      identityReportPath: identity.artifacts.reportPath,
      methodEvolutionReportPath: path.join(methodOutputDir, 'report.json')
    }
  };

  await writeJson(manifestPath, {
      runId,
      kind: report.kind,
      status: report.status,
      generatedAt: report.generatedAt,
      scope: report.scope,
      constraints: report.constraints,
      paperAppendix: {
        claimClass: report.paperAppendix.claimClass,
        gate: report.paperAppendix.gate,
        reason: report.paperAppendix.reason,
        requiredNextStep: report.paperAppendix.requiredNextStep
      },
      artifacts: report.artifacts
    });
  await writeText(graphRankingAppendixTablePath, renderGraphRankingAppendixTsv(graphRankingAblationRows));
  await writeText(summaryPath, renderSummary(report));
  return report;
}

async function main() {
  const report = await runGraphQualityImprovementReport(parseArgs());
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    summaryPath: report.artifacts.summaryPath
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
