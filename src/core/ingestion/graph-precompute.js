import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from '../graph/schema.js';
import { jaccardSimilarity, normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function resolveAvailableParallelism(options = {}) {
  const explicit = Number(options.availableParallelism);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  if (typeof os.availableParallelism === 'function') {
    return Math.max(1, os.availableParallelism());
  }

  return Math.max(1, os.cpus()?.length || 1);
}

function resolvePrecomputeConcurrency(options = {}) {
  const explicit = Number(firstDefinedValue(
    options.graphPrecomputeConcurrency,
    options.analyzeConcurrency,
    options.concurrency
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  return Math.max(1, Math.min(resolveAvailableParallelism(options), 4));
}

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function uniqueTextList(values = []) {
  return unique(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function cleanSemanticName(text, fallback, maxLength = 140) {
  let normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9\u4e00-\u9fff]+/, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .trim();

  if (/^[\d\s.\-\[\]]+$/.test(normalized) || /^[\[\]A-Z'\s]+\?/.test(normalized)) {
    return fallback;
  }

  if (/^[\d.\-\s]+$/.test(normalized)) {
    return fallback;
  }

  if (/[^A-Za-z0-9\u4e00-\u9fff\s]{5,}/.test(normalized)) {
    normalized = normalized.replace(/[^A-Za-z0-9\u4e00-\u9fff\s]+/g, ' ').trim();
  }

  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function buildEvidenceProperties(record, paper, overrides = {}) {
  return {
    sourcePaperId: paper.paperId,
    sourcePaperTitle: paper.paperTitle,
    evidenceText: record.evidenceText || record.text || record.name || '',
    section: record.sectionHeading || record.section || '',
    sectionRole: record.sectionRole || record.role || '',
    confidence: record.confidence ?? 0.65,
    explicitOrInferred: record.explicitOrInferred || 'explicit',
    ...overrides
  };
}

function buildPaperScopedNodePayload(type, paper, seed, name, properties = {}) {
  return {
    id: `${type.toLowerCase()}:${stableHash(`${paper.paperId}:${seed}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      ...properties
    }
  };
}

function buildGlobalNodePayload(type, name, properties = {}) {
  const normalizedName = normalizeText(name);
  const node = {
    id: `${type.toLowerCase()}:${slugify(name)}:${stableHash(`${type}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      normalized: normalizedName,
      paperTitles: properties.paperTitle ? [properties.paperTitle] : [],
      aliases: uniqueTextList([...(properties.aliases || []), name]),
      mentionCount: 1,
      confidence: properties.confidence || 0.6
    }
  };

  if (properties.type) node.properties.type = properties.type;
  if (properties.category) node.properties.category = properties.category;
  if (typeof properties.higherIsBetter === 'boolean') node.properties.higherIsBetter = properties.higherIsBetter;
  if (properties.description) node.properties.description = properties.description;
  if (typeof properties.brainstormEligible === 'boolean') node.properties.brainstormEligible = properties.brainstormEligible;
  if (typeof properties.brainstormScore === 'number') node.properties.brainstormScore = properties.brainstormScore;
  if (properties.brainstormTier) node.properties.brainstormTier = properties.brainstormTier;
  if (properties.admissionSource) node.properties.admissionSource = properties.admissionSource;
  if (properties.admissionReason) node.properties.admissionReason = properties.admissionReason;

  return node;
}

function createGlobalContribution(type, paper, record, paperRelationType, options = {}) {
  if (!record?.name) return null;

  const node = buildGlobalNodePayload(type, record.name, {
    paperTitle: paper.paperTitle,
    confidence: record.confidence,
    aliases: options.aliases || [],
    type: options.nodeType,
    category: options.category,
    higherIsBetter: options.higherIsBetter,
    description: options.description,
    brainstormEligible: record.brainstormEligible,
    brainstormScore: record.brainstormScore,
    brainstormTier: record.brainstormTier,
    admissionSource: record.admissionSource,
    admissionReason: record.admissionReason
  });

  return {
    node,
    aliases: uniqueTextList([record.text, record.name, ...(options.aliases || [])]),
    paperRelationship: createRelationship(
      paper.paperId,
      node.id,
      paperRelationType,
      buildEvidenceProperties(record, paper, options.relationshipOverrides || {})
    )
  };
}

function createScopedContribution(node, paperRelationshipType, record, paper, aliases = [], extraRelationships = []) {
  return {
    node,
    aliases: uniqueTextList([record?.text, record?.name, ...aliases]),
    paperRelationship: createRelationship(
      paper.paperId,
      node.id,
      paperRelationshipType,
      buildEvidenceProperties(record, paper, {})
    ),
    extraRelationships
  };
}

export function precomputePaperGraphFragment(paper) {
  const paperNode = {
    id: paper.paperId,
    type: NODE_TYPES.PAPER,
    name: paper.paperTitle,
    properties: {
      layer: getNodeLayer(NODE_TYPES.PAPER),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      authors: paper.authors || [],
      abstract: paper.abstract || '',
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      sourceFingerprint: paper.sourceFingerprint
    }
  };

  const problems = paper.problems
    .map((problem) => createGlobalContribution(NODE_TYPES.PROBLEM, paper, problem, EDGE_TYPES.SOLVES))
    .filter(Boolean);
  const methods = paper.methods
    .map((method) => createGlobalContribution(NODE_TYPES.METHOD, paper, method, EDGE_TYPES.USES))
    .filter(Boolean);
  const datasets = paper.datasets
    .map((dataset) => createGlobalContribution(NODE_TYPES.DATASET, paper, dataset, EDGE_TYPES.EVALUATES_ON))
    .filter(Boolean);
  const benchmarks = (paper.benchmarks || [])
    .map((benchmark) => createGlobalContribution(NODE_TYPES.BENCHMARK, paper, benchmark, EDGE_TYPES.BENCHMARKED_ON))
    .filter(Boolean);
  const metrics = paper.metrics
    .map((metric) => createGlobalContribution(NODE_TYPES.METRIC, paper, metric, EDGE_TYPES.REPORTS, {
      higherIsBetter: metric.higherIsBetter
    }))
    .filter(Boolean);
  const limitations = paper.limitations
    .map((limitation) => createGlobalContribution(NODE_TYPES.LIMITATION, paper, limitation, EDGE_TYPES.HAS_LIMITATION, {
      nodeType: limitation.type,
      relationshipOverrides: { limitationType: limitation.type }
    }))
    .filter(Boolean);
  const assumptions = paper.assumptions
    .map((assumption) => createGlobalContribution(NODE_TYPES.ASSUMPTION, paper, assumption, EDGE_TYPES.ASSUMES, {
      nodeType: assumption.type,
      relationshipOverrides: { assumptionType: assumption.type }
    }))
    .filter(Boolean);
  const futureDirections = paper.futureDirections
    .map((futureDirection) => createGlobalContribution(NODE_TYPES.FUTURE_DIRECTION, paper, futureDirection, EDGE_TYPES.SUGGESTS_FUTURE))
    .filter(Boolean);
  const researchGoals = (paper.researchGoals || [])
    .map((researchGoal) => createGlobalContribution(NODE_TYPES.RESEARCH_GOAL, paper, researchGoal, EDGE_TYPES.LEADS_TO))
    .filter(Boolean);

  const datasetByName = new Map(datasets.map((entry) => [entry.node.name, entry.node]));
  const benchmarkByName = new Map(benchmarks.map((entry) => [entry.node.name, entry.node]));
  const metricByName = new Map(metrics.map((entry) => [entry.node.name, entry.node]));
  const assumptionNodes = assumptions.map((entry) => entry.node);
  const problemNodes = problems.map((entry) => entry.node);
  const methodNodes = methods.map((entry) => entry.node);
  const limitationNodes = limitations.map((entry) => entry.node);
  const futureDirectionNodes = futureDirections.map((entry) => entry.node);

  const claimEntries = paper.claims.map((claim, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.CLAIM,
      paper,
      `claim:${index}`,
      cleanSemanticName(claim.text, `${paper.paperTitle} claim`),
      {
        text: claim.text,
        normalizedForm: claim.normalizedForm,
        claimType: claim.claimType,
        sectionHeading: claim.sectionHeading,
        sectionRole: claim.sectionRole,
        brainstormEligible: claim.brainstormEligible,
        brainstormScore: claim.brainstormScore,
        brainstormTier: claim.brainstormTier,
        admissionSource: claim.admissionSource,
        admissionReason: claim.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of claim.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const metricName of claim.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      if (normalizeText(claim.text || '').includes(normalizeText(benchmarkNode.name))) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.CLAIMS, claim, paper, [claim.name], extraRelationships);
  });

  const findingEntries = (paper.findings || []).map((finding, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.FINDING,
      paper,
      `finding:${index}`,
      cleanSemanticName(finding.text || finding.name, `${paper.paperTitle} finding`),
      {
        text: finding.text || finding.name,
        normalizedForm: finding.normalizedForm || normalizeText(finding.text || finding.name),
        findingType: finding.findingType,
        sectionHeading: finding.sectionHeading,
        sectionRole: finding.sectionRole,
        brainstormEligible: finding.brainstormEligible,
        brainstormScore: finding.brainstormScore,
        brainstormTier: finding.brainstormTier,
        admissionSource: finding.admissionSource,
        admissionReason: finding.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of finding.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const benchmarkName of finding.linkedBenchmarks || []) {
      const benchmarkNode = benchmarkByName.get(benchmarkName);
      if (benchmarkNode) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    for (const metricName of finding.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.REPORTS_FINDING, finding, paper, [finding.name], extraRelationships);
  });

  const evidenceEntries = paper.evidences.map((evidence, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.EVIDENCE,
      paper,
      `evidence:${index}`,
      cleanSemanticName(evidence.text, `${paper.paperTitle} evidence`),
      {
        text: evidence.text,
        section: evidence.section,
        sectionHeading: evidence.sectionHeading,
        sectionRole: evidence.sectionRole,
        confidence: evidence.confidence,
        brainstormEligible: evidence.brainstormEligible,
        brainstormScore: evidence.brainstormScore,
        brainstormTier: evidence.brainstormTier,
        admissionSource: evidence.admissionSource,
        admissionReason: evidence.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of evidence.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const metricName of evidence.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      if (normalizeText(evidence.text || '').includes(normalizeText(benchmarkNode.name))) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.CONTAINS, evidence, paper, [evidence.name], extraRelationships);
  });

  const localRelationships = [];
  const claimNodes = claimEntries.map((entry) => entry.node);
  const findingNodes = findingEntries.map((entry) => entry.node);
  const evidenceNodes = evidenceEntries.map((entry) => entry.node);

  for (const claimNode of claimNodes) {
    for (const evidenceNode of evidenceNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, evidenceNode.properties.text || evidenceNode.name);
      if (similarity < 0.12) continue;
      localRelationships.push(createRelationship(claimNode.id, evidenceNode.id, EDGE_TYPES.SUPPORTED_BY, {
        score: Number(similarity.toFixed(3))
      }));
    }

    for (const findingNode of findingNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, findingNode.properties.text || findingNode.name);
      if (similarity < 0.14) continue;
      localRelationships.push(createRelationship(claimNode.id, findingNode.id, EDGE_TYPES.SUPPORTED_BY, {
        score: Number(similarity.toFixed(3)),
        relationSource: 'heuristic'
      }));
    }

    for (const assumptionNode of assumptionNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, assumptionNode.name);
      if (similarity < 0.08) continue;
      localRelationships.push(createRelationship(claimNode.id, assumptionNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationSource: 'heuristic'
      }));
    }
  }

  for (const findingNode of findingNodes) {
    for (const assumptionNode of assumptionNodes) {
      const similarity = jaccardSimilarity(findingNode.properties.text || findingNode.name, assumptionNode.name);
      if (similarity < 0.08) continue;
      localRelationships.push(createRelationship(findingNode.id, assumptionNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationSource: 'heuristic'
      }));
    }
  }

  for (const methodNode of methodNodes) {
    for (const problemNode of problemNodes) {
      localRelationships.push(createRelationship(methodNode.id, problemNode.id, EDGE_TYPES.APPLIES_TO, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const assumptionNode of assumptionNodes) {
      localRelationships.push(createRelationship(methodNode.id, assumptionNode.id, EDGE_TYPES.REQUIRES, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const datasetNode of datasetByName.values()) {
      localRelationships.push(createRelationship(methodNode.id, datasetNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        dependencyKind: 'dataset'
      }));
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      localRelationships.push(createRelationship(methodNode.id, benchmarkNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        dependencyKind: 'benchmark'
      }));
    }
  }

  for (const problemNode of problemNodes) {
    for (const limitationNode of limitationNodes) {
      localRelationships.push(createRelationship(problemNode.id, limitationNode.id, EDGE_TYPES.HAS_GAP, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const futureDirectionNode of futureDirectionNodes) {
      localRelationships.push(createRelationship(futureDirectionNode.id, problemNode.id, EDGE_TYPES.RELATED_TO, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationKind: 'future-problem'
      }));
    }
  }

  for (let leftIndex = 0; leftIndex < methodNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < methodNodes.length; rightIndex += 1) {
      const leftNode = methodNodes[leftIndex];
      const rightNode = methodNodes[rightIndex];
      const baseProperties = {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      };

      localRelationships.push(createRelationship(leftNode.id, rightNode.id, EDGE_TYPES.COMPATIBLE_WITH, baseProperties));
      localRelationships.push(createRelationship(rightNode.id, leftNode.id, EDGE_TYPES.COMPATIBLE_WITH, baseProperties));
      localRelationships.push(createRelationship(leftNode.id, rightNode.id, EDGE_TYPES.COMBINES_WITH, {
        ...baseProperties,
        relationSource: 'heuristic'
      }));
      localRelationships.push(createRelationship(rightNode.id, leftNode.id, EDGE_TYPES.COMBINES_WITH, {
        ...baseProperties,
        relationSource: 'heuristic'
      }));
    }
  }

  return {
    paperNode,
    globalContributions: [
      ...problems,
      ...methods,
      ...datasets,
      ...benchmarks,
      ...metrics,
      ...limitations,
      ...assumptions,
      ...futureDirections,
      ...researchGoals
    ],
    paperScopedContributions: [
      ...claimEntries,
      ...findingEntries,
      ...evidenceEntries
    ],
    localRelationships
  };
}

function runPrecomputeWorker(paper) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./graph-precompute.js', import.meta.url), {
      type: 'module',
      workerData: { paper }
    });

    let settled = false;

    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      if (message?.ok === false) {
        reject(new Error(message.error || 'Graph precompute worker failed.'));
        return;
      }
      resolve(message.fragment);
    });

    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        reject(new Error('Graph precompute worker exited without a result.'));
        return;
      }
      reject(new Error(`Graph precompute worker exited with code ${code}.`));
    });
  });
}

export async function precomputePaperGraphFragments(papers, options = {}) {
  if (!Array.isArray(papers) || !papers.length) return [];

  const concurrency = Math.min(resolvePrecomputeConcurrency(options), papers.length);
  if (concurrency <= 1 || papers.length <= 1) {
    return papers.map((paper) => precomputePaperGraphFragment(paper));
  }

  const results = new Array(papers.length);
  let nextIndex = 0;

  async function workerLoop() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= papers.length) {
        return;
      }

      const paper = papers[currentIndex];
      try {
        results[currentIndex] = await runPrecomputeWorker(paper);
      } catch {
        results[currentIndex] = precomputePaperGraphFragment(paper);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  return results;
}

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      fragment: precomputePaperGraphFragment(workerData.paper)
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
