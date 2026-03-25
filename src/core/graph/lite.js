import { tokenizeWithoutStopwords, truncate, unique } from '../../lib/utils.js';
import { buildBrainstormViewPayload } from './brainstorm-view.js';

function pickNodeProperties(properties = {}) {
  const selected = {};
  const keys = [
    'layer',
    'paperId',
    'paperTitle',
    'paperTitles',
    'abstract',
    'text',
    'evidenceText',
    'sectionHeading',
    'sectionRole',
    'sourcePath',
    'aliases',
    'manual',
    'editSource',
    'createdAt',
    'createdBy',
    'updatedAt',
    'updatedBy',
    'confidence',
    'claimType',
    'findingType',
    'type',
    'category',
    'normalized',
    'brainstormEligible',
    'brainstormScore',
    'brainstormTier',
    'admissionSource',
    'admissionReason'
  ];

  for (const key of keys) {
    if (properties[key] === undefined || properties[key] === null || properties[key] === '') continue;
    if (typeof properties[key] === 'string') {
      selected[key] = truncate(properties[key], key === 'abstract' ? 600 : 360);
      continue;
    }
    selected[key] = properties[key];
  }

  return selected;
}

function pickRelationshipProperties(properties = {}) {
  const selected = {};
  const keys = [
    'sourceLayer',
    'targetLayer',
    'layerScope',
    'layerPath',
    'sourcePaperId',
    'sourcePaperTitle',
    'score',
    'confidence',
    'relationSource',
    'explicitOrInferred',
    'evidenceText',
    'manual',
    'editSource',
    'createdAt',
    'createdBy',
    'updatedAt',
    'updatedBy',
    'llmValidated',
    'llmConfidence'
  ];

  for (const key of keys) {
    if (properties[key] === undefined || properties[key] === null || properties[key] === '') continue;
    selected[key] = typeof properties[key] === 'string'
      ? truncate(properties[key], 280)
      : properties[key];
  }

  return selected;
}

export function getLiteNodeSearchTokens(node) {
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

export function createLiteNodePayload(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    properties: pickNodeProperties(node.properties)
  };
}

export function createLiteRelationshipPayload(relationship) {
  return {
    id: relationship.id,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    type: relationship.type,
    properties: pickRelationshipProperties(relationship.properties)
  };
}

export function buildTokenIndex(nodes) {
  const tokenMap = new Map();

  for (const node of nodes) {
    for (const token of getLiteNodeSearchTokens(node)) {
      if (!tokenMap.has(token)) tokenMap.set(token, []);
      tokenMap.get(token).push(node.id);
    }
  }

  return Object.fromEntries(
    [...tokenMap.entries()].map(([token, ids]) => [token, unique(ids)])
  );
}

export function createLiteGraphPayload(graph) {
  const nodes = graph.nodes.map((node) => createLiteNodePayload(node));
  const relationships = graph.relationships.map((relationship) => createLiteRelationshipPayload(relationship));

  return {
    nodes,
    relationships,
    indexes: {
      searchTokens: buildTokenIndex(nodes)
    },
    views: {
      brainstorm: buildBrainstormViewPayload(nodes)
    }
  };
}
