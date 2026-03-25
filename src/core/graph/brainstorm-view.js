import { tokenizeWithoutStopwords, unique } from '../../lib/utils.js';
import { NODE_TYPES } from './schema.js';

export const BRAINSTORM_VIEW_NODE_TYPES = [
  NODE_TYPES.PROBLEM,
  NODE_TYPES.METHOD,
  NODE_TYPES.CLAIM,
  NODE_TYPES.FINDING,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION,
  NODE_TYPES.FUTURE_DIRECTION,
  NODE_TYPES.RESEARCH_GOAL,
  NODE_TYPES.DATASET,
  NODE_TYPES.BENCHMARK
];

export function isBrainstormEligibleNode(node) {
  return Boolean(node?.properties?.brainstormEligible);
}

export function isBrainstormSupportNode(node) {
  if (!node) return false;
  return node.type === NODE_TYPES.PAPER
    || node.type === NODE_TYPES.CORPUS
    || isBrainstormEligibleNode(node);
}

export function getBrainstormNodeSearchTokens(node) {
  if (!isBrainstormEligibleNode(node)) return [];

  const text = [
    node.name,
    node.properties?.abstract,
    node.properties?.text,
    node.properties?.evidenceText,
    Array.isArray(node.properties?.paperTitles) ? node.properties.paperTitles.join(' ') : '',
    Array.isArray(node.properties?.aliases) ? node.properties.aliases.join(' ') : ''
  ].filter(Boolean).join(' ');

  return unique(tokenizeWithoutStopwords(text)).slice(0, 64);
}

function buildTokenIndex(nodes) {
  const tokenMap = new Map();

  for (const node of nodes) {
    for (const token of getBrainstormNodeSearchTokens(node)) {
      if (!tokenMap.has(token)) tokenMap.set(token, []);
      tokenMap.get(token).push(node.id);
    }
  }

  return Object.fromEntries(
    [...tokenMap.entries()].map(([token, ids]) => [token, unique(ids)])
  );
}

export function buildBrainstormViewPayload(nodes = []) {
  const eligibleNodes = nodes.filter((node) => isBrainstormEligibleNode(node));
  const nodeIds = eligibleNodes.map((node) => node.id).sort();
  const nodeIdsByType = Object.fromEntries(
    BRAINSTORM_VIEW_NODE_TYPES
      .map((type) => [
        type,
        eligibleNodes
          .filter((node) => node.type === type)
          .map((node) => node.id)
          .sort()
      ])
      .filter(([, ids]) => ids.length)
  );

  return {
    nodeCount: eligibleNodes.length,
    nodeIds,
    nodeIdsByType,
    indexes: {
      searchTokens: buildTokenIndex(eligibleNodes)
    }
  };
}
