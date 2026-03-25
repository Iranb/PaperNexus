import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EDGE_TYPES } from '../graph/schema.js';
import { jaccardSimilarity, normalizeText, stableHash, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';

const POSITIVE_CLAIM_TERMS = /\b(improve|improved|outperform|better|gain|achieve|support|enable|transparent|easier)\b/i;
const NEGATIVE_CLAIM_TERMS = /\b(degrade|degraded|worse|fail|fails|drop|limited|sensitive|cannot|unable)\b/i;

const LIMITATION_THEMES = [
  { name: 'label-efficiency', regex: /\b(label|labels|annotation|annotated|supervised|manual)\b/i },
  { name: 'efficiency', regex: /\b(cost|costly|expensive|latency|slow|memory|compute|throughput)\b/i },
  { name: 'robustness', regex: /\b(noise|noisy|robust|sensitive|corruption|shift)\b/i },
  { name: 'generalization', regex: /\b(domain|cross-domain|generaliz|transfer|out-of-domain)\b/i },
  { name: 'evidence', regex: /\b(audit|evidence|trace|provenance|interpret)\b/i },
  { name: 'structure', regex: /\b(structure|graph|context|long context|section|hierarchy)\b/i }
];

const METHOD_THEMES = [
  { name: 'label-efficiency', regex: /\b(few-shot|low-resource|semi-supervised|self-supervised|weak supervision|synthetic|active learning)\b/i },
  { name: 'efficiency', regex: /\b(efficient|adapter|lora|distill|sparse|compression|cache)\b/i },
  { name: 'robustness', regex: /\b(robust|augmentation|regularization|contrastive|noise)\b/i },
  { name: 'generalization', regex: /\b(transfer|domain adaptation|multi-domain|cross-domain|meta-learning)\b/i },
  { name: 'evidence', regex: /\b(retrieval|evidence|citation|audit|trace)\b/i },
  { name: 'structure', regex: /\b(graph|hierarchy|planning|structure|long context)\b/i }
];

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

function resolvePostprocessConcurrency(options = {}) {
  const explicit = Number(firstDefinedValue(
    options.graphPostprocessConcurrency,
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

function detectThemes(text, definitions) {
  const themes = [];
  for (const definition of definitions) {
    if (definition.regex.test(text)) themes.push(definition.name);
  }
  return themes;
}

function buildCandidatePairs(nodes) {
  const tokenIndex = new Map();
  const pairs = new Map();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const tokens = unique(tokenizeWithoutStopwords(node.name).filter((token) => token.length >= 4)).slice(0, 8);
    for (const token of tokens) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(index);
    }
  }

  for (const indices of tokenIndex.values()) {
    if (indices.length < 2 || indices.length > 48) continue;
    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const a = indices[left];
        const b = indices[right];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        pairs.set(key, [nodes[Math.min(a, b)], nodes[Math.max(a, b)]]);
      }
    }
  }

  if (pairs.size) {
    return [...pairs.values()];
  }

  if (nodes.length <= 40) {
    return nodes.flatMap((left, leftIndex) => nodes.slice(leftIndex + 1).map((right) => [left, right]));
  }

  return [];
}

function claimPolarity(text) {
  if (POSITIVE_CLAIM_TERMS.test(text) && !NEGATIVE_CLAIM_TERMS.test(text)) return 'positive';
  if (NEGATIVE_CLAIM_TERMS.test(text) && !POSITIVE_CLAIM_TERMS.test(text)) return 'negative';
  return 'mixed';
}

function buildSimilarityRelationships(nodes, type, threshold) {
  const relationships = [];
  for (const [left, right] of buildCandidatePairs(nodes)) {
    const similarity = jaccardSimilarity(left.name, right.name);
    if (similarity < threshold) continue;
    const properties = { score: Number(similarity.toFixed(3)) };
    relationships.push(createRelationship(left.id, right.id, type, properties));
    relationships.push(createRelationship(right.id, left.id, type, properties));
  }
  return relationships;
}

function buildClaimContradictionRelationships(claimNodes) {
  const relationships = [];
  for (const [left, right] of buildCandidatePairs(claimNodes)) {
    if ((left.properties?.paperId || null) === (right.properties?.paperId || null)) continue;

    const similarity = jaccardSimilarity(left.properties?.text || left.name, right.properties?.text || right.name);
    if (similarity < 0.32) continue;

    const leftPolarity = claimPolarity(left.properties?.text || left.name);
    const rightPolarity = claimPolarity(right.properties?.text || right.name);
    if (leftPolarity === 'mixed' || rightPolarity === 'mixed' || leftPolarity === rightPolarity) continue;

    const properties = { score: Number(similarity.toFixed(3)) };
    relationships.push(createRelationship(left.id, right.id, EDGE_TYPES.CONTRADICTS, properties));
    relationships.push(createRelationship(right.id, left.id, EDGE_TYPES.CONTRADICTS, properties));
  }
  return relationships;
}

function buildMethodTransferRelationships(methods, problems, appliesPairs = []) {
  const outgoingPairs = new Set(appliesPairs);
  const relationships = [];

  for (const method of methods) {
    const methodThemes = detectThemes(method.name, METHOD_THEMES);
    for (const problem of problems) {
      if (outgoingPairs.has(`${method.id}:${problem.id}`)) continue;

      const similarity = jaccardSimilarity(method.name, problem.name);
      const problemTokens = tokenizeWithoutStopwords(problem.name);
      const themeBoost = methodThemes.some((theme) => problemTokens.includes(theme.split('-')[0])) ? 0.14 : 0;
      const score = similarity + themeBoost;
      if (score < 0.22) continue;

      relationships.push(createRelationship(method.id, problem.id, EDGE_TYPES.TRANSFERABLE_TO, {
        relationSource: 'heuristic',
        score: Number(score.toFixed(3))
      }));
    }
  }

  return relationships;
}

function buildLimitationRemedyRelationships(limitations, methods) {
  const relationships = [];
  for (const limitation of limitations) {
    const limitationThemes = detectThemes(limitation.name, LIMITATION_THEMES);
    if (!limitationThemes.length) continue;

    for (const method of methods) {
      const methodThemes = detectThemes(method.name, METHOD_THEMES);
      const overlappingThemes = limitationThemes.filter((theme) => methodThemes.includes(theme));
      if (!overlappingThemes.length) continue;

      const score = Number((0.55 + overlappingThemes.length * 0.15).toFixed(2));
      relationships.push(createRelationship(limitation.id, method.id, EDGE_TYPES.MAY_BE_ADDRESSED_BY, {
        themes: overlappingThemes,
        score
      }));
    }
  }
  return relationships;
}

function buildCitationRelationships(papers) {
  const exactTitleMap = new Map();
  const tokenIndex = new Map();
  const paperById = new Map();

  for (const paper of papers) {
    const normalizedTitle = normalizeText(paper.paperTitle);
    if (!normalizedTitle) continue;
    exactTitleMap.set(normalizedTitle, paper);
    paperById.set(paper.paperId, paper);
    for (const token of unique(tokenizeWithoutStopwords(normalizedTitle).filter((entry) => entry.length >= 4)).slice(0, 10)) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(paper);
    }
  }

  const titleEntries = [...exactTitleMap.entries()];
  const relationships = [];

  for (const paper of papers) {
    for (const reference of paper.references || []) {
      const normalizedTitle = normalizeText(reference.titleGuess || reference.raw || '');
      if (!normalizedTitle) continue;

      let targetPaper = exactTitleMap.get(normalizedTitle) || null;

      if (!targetPaper) {
        const candidateScores = new Map();
        const tokens = unique(tokenizeWithoutStopwords(normalizedTitle).filter((entry) => entry.length >= 4)).slice(0, 10);
        for (const token of tokens) {
          for (const candidate of tokenIndex.get(token) || []) {
            candidateScores.set(candidate.paperId, (candidateScores.get(candidate.paperId) || 0) + 1);
          }
        }

        const rankedCandidates = [...candidateScores.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 12)
          .map(([paperId]) => paperById.get(paperId))
          .filter(Boolean);

        targetPaper = rankedCandidates.find((candidate) => {
          const candidateTitle = normalizeText(candidate.paperTitle);
          return candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle);
        }) || null;

        if (!targetPaper && papers.length <= 256) {
          targetPaper = titleEntries
            .find(([candidateTitle]) => candidateTitle.includes(normalizedTitle) || normalizedTitle.includes(candidateTitle))?.[1] || null;
        }
      }

      if (!targetPaper || targetPaper.paperId === paper.paperId) continue;

      relationships.push(createRelationship(paper.paperId, targetPaper.paperId, EDGE_TYPES.CITES, {
        raw: reference.raw
      }));
    }
  }

  return relationships;
}

function executeTask(task) {
  switch (task.kind) {
    case 'similarity':
      return buildSimilarityRelationships(task.nodes || [], task.edgeType, task.threshold);
    case 'claim-contradictions':
      return buildClaimContradictionRelationships(task.nodes || []);
    case 'method-transfer':
      return buildMethodTransferRelationships(task.methods || [], task.problems || [], task.appliesPairs || []);
    case 'limitation-remedy':
      return buildLimitationRemedyRelationships(task.limitations || [], task.methods || []);
    case 'citations':
      return buildCitationRelationships(task.papers || []);
    default:
      return [];
  }
}

function buildPostprocessTasks(input = {}) {
  const tasks = [];
  const pushTask = (task) => {
    if (task.kind === 'similarity' && (!Array.isArray(task.nodes) || task.nodes.length < 2)) return;
    if (task.kind === 'claim-contradictions' && (!Array.isArray(task.nodes) || task.nodes.length < 2)) return;
    if (task.kind === 'method-transfer' && (!Array.isArray(task.methods) || !Array.isArray(task.problems) || !task.methods.length || !task.problems.length)) return;
    if (task.kind === 'limitation-remedy' && (!Array.isArray(task.limitations) || !Array.isArray(task.methods) || !task.limitations.length || !task.methods.length)) return;
    if (task.kind === 'citations' && (!Array.isArray(task.papers) || !task.papers.length)) return;
    tasks.push(task);
  };

  pushTask({ kind: 'similarity', nodes: input.problems, edgeType: EDGE_TYPES.RELATED_TO, threshold: 0.35 });
  pushTask({ kind: 'similarity', nodes: input.methods, edgeType: EDGE_TYPES.SIMILAR_TO, threshold: 0.4 });
  pushTask({ kind: 'similarity', nodes: input.limitations, edgeType: EDGE_TYPES.RELATED_TO, threshold: 0.38 });
  pushTask({ kind: 'similarity', nodes: input.futureDirections, edgeType: EDGE_TYPES.RELATED_TO, threshold: 0.35 });
  pushTask({ kind: 'similarity', nodes: input.benchmarks, edgeType: EDGE_TYPES.SIMILAR_TO, threshold: 0.45 });
  pushTask({ kind: 'claim-contradictions', nodes: input.claims });
  pushTask({ kind: 'method-transfer', methods: input.methods, problems: input.problems, appliesPairs: input.appliesPairs });
  pushTask({ kind: 'limitation-remedy', limitations: input.limitations, methods: input.methods });
  pushTask({ kind: 'citations', papers: input.papers });

  return tasks;
}

function runTaskWorker(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./graph-postprocess.js', import.meta.url), {
      type: 'module',
      workerData: { task }
    });

    let settled = false;

    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      if (message?.ok === false) {
        reject(new Error(message.error || 'Graph postprocess worker failed.'));
        return;
      }
      resolve(message.relationships || []);
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
        reject(new Error('Graph postprocess worker exited without a result.'));
        return;
      }
      reject(new Error(`Graph postprocess worker exited with code ${code}.`));
    });
  });
}

export async function precomputeGraphPostprocess(input = {}, options = {}) {
  const tasks = buildPostprocessTasks(input);
  if (!tasks.length) return [];

  const concurrency = Math.min(resolvePostprocessConcurrency(options), tasks.length);
  if (concurrency <= 1 || tasks.length <= 1) {
    return tasks.flatMap((task) => executeTask(task));
  }

  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function workerLoop() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= tasks.length) {
        return;
      }

      const task = tasks[currentIndex];
      try {
        results[currentIndex] = await runTaskWorker(task);
      } catch {
        results[currentIndex] = executeTask(task);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  return results.flat();
}

export const __graphPostprocessTestables = {
  buildCitationRelationships,
  buildSimilarityRelationships,
  buildClaimContradictionRelationships
};

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      relationships: executeTask(workerData.task)
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
