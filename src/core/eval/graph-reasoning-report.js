import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { ensureDir, readJson, writeJson, writeText } from '../../lib/fs.js';
import { stableHash, tokenizeWithoutStopwords } from '../../lib/utils.js';

export const GRAPH_REASONING_REPORT_VERSION = 'papernexus-graph-reasoning-report-v1';
export const GRAPH_REASONING_REPORT_MANIFEST_VERSION = 'papernexus-graph-reasoning-report-manifest-v1';
export const DETERMINISTIC_GLOBAL_LOCAL_GRAPH_REASONING_METHOD = 'deterministic-global-local-graph-reasoning-v1';
export const DEFAULT_GRAPH_REASONING_TOP_K = 10;

const FIXTURE_MARKERS = /\b(fixture|synthetic|mock|toy|mini|example|demo|sample|unit[-_\s]?test)\b/i;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = compactText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function roundMetric(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : 0;
}

function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return roundMetric(Math.max(0, Math.min(1, numeric)));
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTopK(value = DEFAULT_GRAPH_REASONING_TOP_K) {
  return Math.max(1, normalizePositiveInteger(value, DEFAULT_GRAPH_REASONING_TOP_K));
}

function normalizeThreshold(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sha256Text(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value = {}) {
  return JSON.stringify(value);
}

function tokensFor(text = '') {
  return tokenizeWithoutStopwords(text);
}

function tokenOverlapScore(leftTokens = [], rightTokens = []) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const right = new Set(rightTokens);
  let hits = 0;
  for (const token of leftTokens) {
    if (right.has(token)) hits += 1;
  }
  return hits / leftTokens.length;
}

function idList(value = []) {
  return unique(asArray(value).map((entry) => {
    if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
    const record = asObject(entry);
    return pickFirst(record.id, record.nodeId, record.node_id, record.paperId, record.paper_id, record.documentId, record.document_id);
  }));
}

function recordText(record = {}) {
  const properties = asObject(record.properties);
  return unique([
    record.name,
    record.title,
    record.label,
    record.text,
    record.summary,
    record.description,
    record.abstract,
    properties.name,
    properties.title,
    properties.label,
    properties.text,
    properties.summary,
    properties.description,
    properties.abstract
  ]).join(' ');
}

function normalizeNode(record = {}, index = 0) {
  const properties = asObject(record.properties);
  const id = compactText(pickFirst(record.id, record.nodeId, record.node_id, record.key, properties.id, `node-${index + 1}`));
  const type = compactText(pickFirst(record.type, record.nodeType, record.node_type, record.label, properties.type, 'Node'));
  const text = recordText(record) || id;
  return {
    id,
    type,
    name: compactText(pickFirst(record.name, record.title, record.label, properties.name, properties.title, id)),
    text,
    tokens: tokensFor(text),
    communityIds: idList([
      ...asArray(record.communityIds || record.community_ids || properties.communityIds || properties.community_ids),
      record.communityId || record.community_id || properties.communityId || properties.community_id
    ]),
    properties
  };
}

function normalizeRelationship(record = {}, index = 0) {
  const properties = asObject(record.properties);
  const sourceId = compactText(pickFirst(record.sourceId, record.source_id, record.source, record.from, properties.sourceId, properties.source_id));
  const targetId = compactText(pickFirst(record.targetId, record.target_id, record.target, record.to, properties.targetId, properties.target_id));
  const type = compactText(pickFirst(record.type, record.edgeType, record.edge_type, record.relation, properties.type, 'RELATED_TO'));
  return {
    id: compactText(pickFirst(record.id, record.relationshipId, record.relationship_id, `rel-${index + 1}`)),
    sourceId,
    targetId,
    type,
    properties
  };
}

function graphPayload(input = {}) {
  const root = asObject(input);
  return asObject(root.graph || root.knowledgeGraph || root.knowledge_graph || root);
}

function graphRows(input = {}) {
  const graph = graphPayload(input);
  return {
    nodes: asArray(graph.nodes || graph.vertices || input.nodes),
    relationships: asArray(graph.relationships || graph.edges || input.relationships || input.edges)
  };
}

export function normalizeGraphReasoningGraph(input = {}) {
  const rows = graphRows(input);
  const nodes = rows.nodes.map(normalizeNode).filter((node) => node.id);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relationships = rows.relationships.map(normalizeRelationship)
    .filter((relationship) => nodeIds.has(relationship.sourceId) && nodeIds.has(relationship.targetId));
  return {
    nodes,
    relationships,
    diagnostics: {
      nodeCount: nodes.length,
      relationshipCount: relationships.length,
      droppedRelationshipCount: rows.relationships.length - relationships.length
    }
  };
}

function summaryRows(input = {}) {
  const root = asObject(input);
  return [
    root.summaries,
    root.community_summaries,
    root.communitySummaries,
    root.graphRagSummaries,
    root.graphrag_summaries,
    root.globalLocalSummaries,
    root.items
  ].find(Array.isArray) || [];
}

function normalizeSummary(record = {}, index = 0) {
  const properties = asObject(record.properties);
  const text = unique([
    record.title,
    record.name,
    record.summary,
    record.text,
    record.description,
    properties.title,
    properties.summary,
    properties.text,
    properties.description
  ]).join(' ');
  return {
    id: compactText(pickFirst(record.id, record.summaryId, record.summary_id, `summary-${index + 1}`)),
    type: compactText(pickFirst(record.type, record.summaryType, record.summary_type, 'community_summary')),
    text,
    nodeIds: idList(record.nodeIds || record.node_ids || record.nodes || properties.nodeIds || properties.node_ids),
    communityIds: idList([
      ...asArray(record.communityIds || record.community_ids || properties.communityIds || properties.community_ids),
      record.communityId || record.community_id || properties.communityId || properties.community_id
    ]),
    tokens: tokensFor(text),
    properties
  };
}

export function normalizeGraphReasoningSummaries(input = {}) {
  return summaryRows(input).map(normalizeSummary).filter((summary) => summary.id && summary.text);
}

function taskRows(input = {}) {
  const root = asObject(input);
  return [
    root.tasks,
    root.queries,
    root.questions,
    root.items,
    Array.isArray(input) ? input : null
  ].find(Array.isArray) || [];
}

function normalizeTask(record = {}, index = 0) {
  const gold = asObject(record.gold || record.labels || record.answer || record.answers);
  const query = compactText(pickFirst(record.query, record.question, record.prompt, record.text, record.title, record.topic));
  const goldNodeIds = unique([
    ...idList(record.goldNodeIds || record.gold_node_ids),
    ...idList(record.relevantNodeIds || record.relevant_node_ids),
    ...idList(record.answerNodeIds || record.answer_node_ids),
    ...idList(record.goldPaperIds || record.gold_paper_ids),
    ...idList(record.relevantPaperIds || record.relevant_paper_ids),
    ...idList(record.relevant_nodes),
    ...idList(record.answers),
    ...idList(gold.nodeIds || gold.node_ids || gold.paperIds || gold.paper_ids || gold.relevantNodeIds)
  ]);
  const seedNodeIds = unique([
    ...idList(record.seedNodeIds || record.seed_node_ids),
    ...idList(record.contextNodeIds || record.context_node_ids),
    ...idList(record.queryNodeIds || record.query_node_ids),
    ...idList(record.sourceNodeIds || record.source_node_ids)
  ]);
  return {
    task_id: compactText(pickFirst(record.taskId, record.task_id, record.queryId, record.query_id, record.id, `task-${index + 1}`)),
    query,
    queryTokens: tokensFor(query),
    goldNodeIds,
    seedNodeIds,
    metadata: asObject(record.metadata)
  };
}

export function normalizeGraphReasoningTasks(input = {}) {
  return taskRows(input).map(normalizeTask).filter((task) => task.task_id);
}

function buildGraphState(nodes = [], relationships = []) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]));
  const directedEdges = new Set();
  for (const relationship of relationships) {
    directedEdges.add(`${relationship.sourceId}->${relationship.targetId}`);
    neighbors.get(relationship.sourceId)?.add(relationship.targetId);
    neighbors.get(relationship.targetId)?.add(relationship.sourceId);
  }
  return { byId, neighbors, directedEdges };
}

function shortestDistances(seedIds = [], state = {}, maxDepth = 2) {
  const distances = new Map();
  const queue = [];
  for (const seedId of seedIds) {
    if (!state.byId?.has(seedId)) continue;
    distances.set(seedId, 0);
    queue.push(seedId);
  }
  while (queue.length) {
    const current = queue.shift();
    const distance = distances.get(current);
    if (distance >= maxDepth) continue;
    for (const neighbor of state.neighbors.get(current) || []) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

function summaryBoostForNode(task = {}, node = {}, summaries = []) {
  let best = 0;
  for (const summary of summaries) {
    const mentionsNode = summary.nodeIds.includes(node.id)
      || node.communityIds.some((communityId) => summary.communityIds.includes(communityId));
    const overlap = tokenOverlapScore(task.queryTokens, summary.tokens);
    if (!mentionsNode && overlap < 0.5) continue;
    const score = (mentionsNode ? 0.18 : 0) + (overlap * 0.32);
    best = Math.max(best, score);
  }
  return normalizeScore(best);
}

function scoreNodeForTask(task = {}, node = {}, state = {}, summaries = [], distances = new Map()) {
  const baselineScore = normalizeScore(tokenOverlapScore(task.queryTokens, node.tokens));
  const distance = distances.get(node.id);
  const seedBoost = distance === 0 ? 0.08 : distance === 1 ? 0.5 : distance === 2 ? 0.24 : 0;
  const summaryBoost = summaryBoostForNode(task, node, summaries);
  const localGraphScore = normalizeScore(baselineScore + seedBoost);
  const graphScore = normalizeScore(localGraphScore + summaryBoost);
  return {
    node_id: node.id,
    node_type: node.type,
    node_name: node.name,
    baseline_score: baselineScore,
    local_graph_score: localGraphScore,
    graph_score: graphScore,
    seed_distance: Number.isFinite(distance) ? distance : null,
    summary_boost: summaryBoost
  };
}

function rankRows(rows = [], field = 'graph_score') {
  return rows.slice().sort((left, right) => (
    Number(right[field] || 0) - Number(left[field] || 0)
    || left.node_id.localeCompare(right.node_id)
  ));
}

function recallAtK(ranking = [], goldIds = [], topK = DEFAULT_GRAPH_REASONING_TOP_K) {
  const gold = new Set(goldIds);
  if (!gold.size) return 0;
  const retrieved = ranking.slice(0, topK).filter((row) => gold.has(row.node_id)).length;
  return retrieved / gold.size;
}

function reciprocalRank(ranking = [], goldIds = []) {
  const gold = new Set(goldIds);
  if (!gold.size) return 0;
  const index = ranking.findIndex((row) => gold.has(row.node_id));
  return index >= 0 ? 1 / (index + 1) : 0;
}

function coherenceScore(ranking = [], state = {}, topK = DEFAULT_GRAPH_REASONING_TOP_K) {
  const ids = ranking.slice(0, topK).map((row) => row.node_id);
  if (ids.length < 2) return 0;
  let linked = 0;
  let total = 0;
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      total += 1;
      if (state.neighbors.get(ids[left])?.has(ids[right])) linked += 1;
    }
  }
  return total ? linked / total : 0;
}

function mean(values = []) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function evaluateTask(task = {}, graph = {}, summaries = [], state = {}, topK = DEFAULT_GRAPH_REASONING_TOP_K) {
  const distances = shortestDistances(task.seedNodeIds, state, 2);
  const scoredRows = graph.nodes.map((node) => scoreNodeForTask(task, node, state, summaries, distances));
  const baselineRanking = rankRows(scoredRows, 'baseline_score');
  const localRanking = rankRows(scoredRows, 'local_graph_score');
  const graphRanking = rankRows(scoredRows, 'graph_score');
  const baselineRecall = recallAtK(baselineRanking, task.goldNodeIds, topK);
  const localRecall = recallAtK(localRanking, task.goldNodeIds, topK);
  const graphRecall = recallAtK(graphRanking, task.goldNodeIds, topK);
  const baselineMrr = reciprocalRank(baselineRanking, task.goldNodeIds);
  const graphMrr = reciprocalRank(graphRanking, task.goldNodeIds);
  const baselineCoherence = coherenceScore(baselineRanking, state, topK);
  const graphCoherence = coherenceScore(graphRanking, state, topK);
  return {
    task_id: task.task_id,
    query: task.query,
    gold_node_ids: task.goldNodeIds,
    seed_node_ids: task.seedNodeIds,
    evaluable: Boolean(task.query && task.goldNodeIds.length),
    metrics: {
      baseline_recall_at_k: roundMetric(baselineRecall),
      local_graph_recall_at_k: roundMetric(localRecall),
      graph_recall_at_k: roundMetric(graphRecall),
      baseline_mrr: roundMetric(baselineMrr),
      graph_mrr: roundMetric(graphMrr),
      baseline_coherence: roundMetric(baselineCoherence),
      graph_coherence: roundMetric(graphCoherence)
    },
    top_results: graphRanking.slice(0, topK).map((row, index) => ({
      rank: index + 1,
      node_id: row.node_id,
      node_type: row.node_type,
      node_name: row.node_name,
      graph_score: row.graph_score,
      baseline_score: row.baseline_score,
      local_graph_score: row.local_graph_score,
      summary_boost: row.summary_boost,
      seed_distance: row.seed_distance
    }))
  };
}

function aggregateTaskResults(results = []) {
  const evaluable = results.filter((entry) => entry.evaluable);
  const baselineRecall = mean(evaluable.map((entry) => entry.metrics.baseline_recall_at_k));
  const graphRecall = mean(evaluable.map((entry) => entry.metrics.graph_recall_at_k));
  const localRecall = mean(evaluable.map((entry) => entry.metrics.local_graph_recall_at_k));
  const baselineMrr = mean(evaluable.map((entry) => entry.metrics.baseline_mrr));
  const graphMrr = mean(evaluable.map((entry) => entry.metrics.graph_mrr));
  const baselineCoherence = mean(evaluable.map((entry) => entry.metrics.baseline_coherence));
  const graphCoherence = mean(evaluable.map((entry) => entry.metrics.graph_coherence));
  return {
    baseline_recall_at_k: roundMetric(baselineRecall),
    graph_recall_at_k: roundMetric(graphRecall),
    local_graph_recall_at_k: roundMetric(localRecall),
    retrieval_score_delta: roundMetric(graphRecall - baselineRecall),
    graph_reasoning_score_delta: roundMetric(graphMrr - baselineMrr),
    global_local_summary_delta: roundMetric(graphRecall - localRecall),
    storyline_coherence_delta: roundMetric(graphCoherence - baselineCoherence),
    baseline_mrr: roundMetric(baselineMrr),
    graph_mrr: roundMetric(graphMrr),
    baseline_coherence: roundMetric(baselineCoherence),
    graph_coherence: roundMetric(graphCoherence)
  };
}

function thresholdsFromOptions(options = {}) {
  return {
    retrieval_score_delta: normalizeThreshold(options.minRetrievalScoreDelta ?? options.min_retrieval_score_delta, 0),
    graph_reasoning_score_delta: normalizeThreshold(options.minGraphReasoningScoreDelta ?? options.min_graph_reasoning_score_delta, 0),
    global_local_summary_delta: normalizeThreshold(options.minGlobalLocalSummaryDelta ?? options.min_global_local_summary_delta, 0),
    storyline_coherence_delta: normalizeThreshold(options.minStorylineCoherenceDelta ?? options.min_storyline_coherence_delta, 0)
  };
}

function gate(name, label, status, metrics = {}, message = '') {
  return {
    name,
    label,
    status,
    ok: status === 'passed',
    metrics,
    message
  };
}

function releaseMetadata(options = {}, inputs = []) {
  const benchmark = asObject(options.benchmark);
  const name = compactText(options.benchmarkName || options.benchmark_name || benchmark.name || 'SciRepEval OAG-Bench GraphRAG-Bench graph reasoning');
  const format = compactText(options.benchmarkFormat || options.benchmark_format || benchmark.format || 'scirepeval-oag-graphrag');
  const source = compactText(options.datasetSource || options.dataset_source || options.source || benchmark.source);
  const licenseScope = compactText(options.licenseScope || options.license_scope || options.license || benchmark.license_scope || benchmark.licenseScope);
  const hasInputHash = inputs.some((entry) => compactText(entry.sha256 || entry.hash || entry.checksum));
  const fixtureText = [name, format, source, licenseScope].join(' ');
  const releaseEvidence = Boolean(options.releaseEvidence || options.release_evidence);
  const missing = [];
  if (!source) missing.push('dataset_source');
  if (!licenseScope) missing.push('license_scope');
  if (!hasInputHash) missing.push('input_sha256');
  if (!releaseEvidence) missing.push('release_evidence_flag');
  return {
    benchmark: {
      name,
      format,
      source: source || null,
      license_scope: licenseScope || null
    },
    releaseEvidence,
    status: missing.length ? 'incomplete' : (FIXTURE_MARKERS.test(fixtureText) ? 'incomplete' : 'passed'),
    reason: missing.length ? `missing_${missing.join('_')}` : (FIXTURE_MARKERS.test(fixtureText) ? 'fixture_or_synthetic_evidence' : 'release_provenance_complete'),
    missing
  };
}

function buildGates(metrics = {}, diagnostics = {}, thresholds = {}, metadata = {}) {
  const gates = [];
  gates.push(gate(
    'evaluable_gold_tasks',
    'Graph reasoning tasks include gold answer nodes',
    diagnostics.evaluableTaskCount > 0 ? 'passed' : 'incomplete',
    { evaluable_task_count: diagnostics.evaluableTaskCount },
    diagnostics.evaluableTaskCount > 0 ? '' : 'missing evaluable graph reasoning tasks'
  ));
  const graphPass = metrics.retrieval_score_delta >= thresholds.retrieval_score_delta
    && metrics.graph_reasoning_score_delta >= thresholds.graph_reasoning_score_delta;
  gates.push(gate(
    'graph_reasoning_beats_baseline',
    'Global/local graph retrieval beats lexical baseline',
    diagnostics.evaluableTaskCount ? (graphPass ? 'passed' : 'failed') : 'incomplete',
    {
      retrieval_score_delta: metrics.retrieval_score_delta,
      graph_reasoning_score_delta: metrics.graph_reasoning_score_delta,
      min_retrieval_score_delta: thresholds.retrieval_score_delta,
      min_graph_reasoning_score_delta: thresholds.graph_reasoning_score_delta
    },
    graphPass ? '' : 'graph reasoning delta is below threshold'
  ));
  const summaryPass = diagnostics.summaryCount > 0 && metrics.global_local_summary_delta >= thresholds.global_local_summary_delta;
  gates.push(gate(
    'global_local_summary_evaluable',
    'GraphRAG/global-local summaries are present and non-regressing',
    diagnostics.summaryCount > 0 ? (summaryPass ? 'passed' : 'failed') : 'incomplete',
    {
      summary_count: diagnostics.summaryCount,
      global_local_summary_delta: metrics.global_local_summary_delta,
      min_global_local_summary_delta: thresholds.global_local_summary_delta
    },
    diagnostics.summaryCount > 0 ? (summaryPass ? '' : 'global/local summary delta is below threshold') : 'missing GraphRAG/global-local summaries'
  ));
  const coherencePass = metrics.storyline_coherence_delta >= thresholds.storyline_coherence_delta;
  gates.push(gate(
    'storyline_coherence_not_regressed',
    'Graph-ranked results do not regress storyline coherence',
    diagnostics.evaluableTaskCount ? (coherencePass ? 'passed' : 'failed') : 'incomplete',
    {
      storyline_coherence_delta: metrics.storyline_coherence_delta,
      min_storyline_coherence_delta: thresholds.storyline_coherence_delta
    },
    coherencePass ? '' : 'storyline coherence delta is below threshold'
  ));
  gates.push(gate(
    'release_provenance_complete',
    'Benchmark source, license, input hash, and release intent are present',
    metadata.status,
    {
      release_evidence: metadata.releaseEvidence,
      missing: metadata.missing
    },
    metadata.reason === 'release_provenance_complete' ? '' : metadata.reason
  ));
  return gates;
}

function statusFromGates(gates = []) {
  if (gates.some((entry) => entry.status === 'failed')) return 'failed';
  if (gates.some((entry) => entry.status === 'incomplete')) return 'incomplete';
  return 'passed';
}

function defaultInputRecords(options = {}) {
  const inputs = [];
  const records = asArray(options.inputs);
  if (records.length) return records;
  if (options.graph) {
    inputs.push({
      role: 'graph_snapshot',
      path: null,
      sha256: sha256Text(stableJson(options.graph))
    });
  }
  if (options.tasks) {
    inputs.push({
      role: 'graph_reasoning_tasks',
      path: null,
      sha256: sha256Text(stableJson(options.tasks))
    });
  }
  if (options.summaries) {
    inputs.push({
      role: 'graphrag_summaries',
      path: null,
      sha256: sha256Text(stableJson(options.summaries))
    });
  }
  return inputs;
}

export function buildGraphReasoningReport(options = {}) {
  const graph = normalizeGraphReasoningGraph(options.graph || options.input || {});
  const tasks = normalizeGraphReasoningTasks(options.tasks || {});
  const summaries = normalizeGraphReasoningSummaries(options.summaries || {});
  const topK = normalizeTopK(options.topK || options.k);
  const state = buildGraphState(graph.nodes, graph.relationships);
  const taskResults = tasks.map((task) => evaluateTask(task, graph, summaries, state, topK));
  const metrics = aggregateTaskResults(taskResults);
  const inputs = defaultInputRecords({
    inputs: options.inputs,
    graph: options.graph || options.input || {},
    tasks: options.tasks || {},
    summaries: options.summaries || null
  }).filter((entry) => compactText(entry.role));
  const metadata = releaseMetadata(options, inputs);
  const thresholds = thresholdsFromOptions(options);
  const diagnostics = {
    ...graph.diagnostics,
    taskCount: tasks.length,
    evaluableTaskCount: taskResults.filter((entry) => entry.evaluable).length,
    summaryCount: summaries.length,
    topK
  };
  const gates = buildGates(metrics, diagnostics, thresholds, metadata);
  const status = statusFromGates(gates);
  const generatedAt = compactText(options.generatedAt || options.generated_at || options.createdAt || options.created_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `graph-reasoning-${stableHash(`${generatedAt}:${diagnostics.nodeCount}:${diagnostics.taskCount}`, 10)}`;
  const method = compactText(options.method || DETERMINISTIC_GLOBAL_LOCAL_GRAPH_REASONING_METHOD);
  const model = compactText(options.model || 'deterministic-global-local-graph-reasoning');
  return {
    contractVersion: GRAPH_REASONING_REPORT_VERSION,
    runId,
    generatedAt,
    status,
    benchmark: metadata.benchmark,
    method,
    model,
    topK,
    thresholds,
    inputs,
    metrics,
    gates,
    diagnostics,
    releaseGate: {
      status,
      reason: status === 'passed' ? 'graph_reasoning_release_gates_passed' : gates.find((entry) => entry.status !== 'passed')?.message || 'graph reasoning evidence is incomplete',
      notes: status === 'passed'
        ? ['Graph reasoning report passed configured thresholds with release provenance.']
        : ['This report is suitable for plumbing and audit, but it is not release-pass evidence until all gates pass.']
    },
    task_results: taskResults
  };
}

export function renderGraphReasoningReportMarkdown(report = {}) {
  const lines = [
    `# Graph Reasoning Report: ${report.runId || 'run'}`,
    '',
    `Status: ${report.status || 'unknown'}`,
    '',
    '## Benchmark',
    '',
    `- name: ${report.benchmark?.name || ''}`,
    `- format: ${report.benchmark?.format || ''}`,
    `- source: ${report.benchmark?.source || ''}`,
    `- license_scope: ${report.benchmark?.license_scope || ''}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---:|'
  ];
  for (const [key, value] of Object.entries(asObject(report.metrics))) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push('', '## Gates', '', '| Gate | Status | Message |', '|---|---:|---|');
  for (const entry of asArray(report.gates)) {
    lines.push(`| ${entry.name} | ${entry.status} | ${entry.message || ''} |`);
  }
  lines.push('', '## Diagnostics', '');
  for (const [key, value] of Object.entries(asObject(report.diagnostics))) {
    lines.push(`- ${key}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolvePath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function readInputRecord(filePath = '', role = '') {
  const absolutePath = resolvePath(filePath);
  if (!absolutePath) return { payload: null, input: null };
  const raw = await fs.readFile(absolutePath, 'utf8');
  return {
    payload: JSON.parse(raw),
    input: {
      role,
      path: absolutePath,
      sha256: sha256Text(raw)
    }
  };
}

async function readJsonMaybe(filePath = '', fallback = null) {
  const absolutePath = resolvePath(filePath);
  if (!absolutePath) return fallback;
  return readJson(absolutePath, fallback);
}

export async function prepareGraphReasoningReport(options = {}) {
  const graphRecord = await readInputRecord(options.graphPath || options.graph_path || options.inputPath || options.input_path, 'graph_snapshot');
  const taskRecord = await readInputRecord(options.tasksPath || options.tasks_path || options.benchmarkPath || options.benchmark_path, 'graph_reasoning_tasks');
  const summaryRecord = await readInputRecord(options.summariesPath || options.summaries_path || options.graphragSummariesPath || options.graphrag_summaries_path, 'graphrag_summaries');
  return buildGraphReasoningReport({
    ...options,
    graph: options.graph || graphRecord.payload || {},
    tasks: options.tasks || taskRecord.payload || {},
    summaries: options.summaries || summaryRecord.payload || {},
    inputs: [
      ...asArray(options.inputs),
      graphRecord.input,
      taskRecord.input,
      summaryRecord.input
    ].filter(Boolean),
    benchmark: options.benchmark || await readJsonMaybe(options.benchmarkMetadataPath || options.benchmark_metadata_path, {})
  });
}

export async function writeGraphReasoningReportArtifacts(options = {}) {
  const outputDir = resolvePath(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const report = await prepareGraphReasoningReport(options);
  const reportJsonPath = path.join(outputDir, 'graph-reasoning-report.json');
  const reportMarkdownPath = path.join(outputDir, 'graph-reasoning-report.md');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const reportWithArtifacts = {
    ...report,
    artifacts: {
      reportJsonPath,
      reportMarkdownPath,
      manifestPath
    }
  };
  const manifest = {
    contractVersion: GRAPH_REASONING_REPORT_MANIFEST_VERSION,
    generatedBy: GRAPH_REASONING_REPORT_VERSION,
    runId: report.runId,
    generatedAt: report.generatedAt,
    status: report.status,
    releaseGateStatus: report.status,
    releaseGate: report.releaseGate,
    benchmark: report.benchmark,
    metrics: report.metrics,
    diagnostics: report.diagnostics,
    artifacts: reportWithArtifacts.artifacts
  };
  await ensureDir(outputDir);
  await writeJson(reportJsonPath, reportWithArtifacts);
  await writeText(reportMarkdownPath, renderGraphReasoningReportMarkdown(reportWithArtifacts));
  await writeJson(manifestPath, manifest);
  return {
    report: reportWithArtifacts,
    manifest
  };
}
