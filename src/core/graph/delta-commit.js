import { createKnowledgeGraph, loadKnowledgeGraph } from './graph.js';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from './schema.js';
import { precomputePaperGraphFragments } from '../ingestion/graph-precompute.js';
import { normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function aggregateGlobalContributions(fragments = []) {
  const groups = new Map();

  for (const fragment of fragments) {
    for (const contribution of fragment.globalContributions || []) {
      const node = contribution?.node;
      if (!node?.type || !node?.name) continue;

      const key = `${node.type}:${normalizeText(node.name)}`;
      if (!groups.has(key)) {
        groups.set(key, {
          node,
          aliases: new Set(node.properties?.aliases || []),
          paperTitles: new Set(node.properties?.paperTitles || []),
          paperRelationships: [],
          confidence: Number(node.properties?.confidence || 0),
          mentionCount: 0
        });
      }

      const group = groups.get(key);
      for (const alias of contribution.aliases || []) {
        if (alias) group.aliases.add(alias);
      }
      for (const alias of node.properties?.aliases || []) {
        if (alias) group.aliases.add(alias);
      }
      for (const title of node.properties?.paperTitles || []) {
        if (title) group.paperTitles.add(title);
      }

      if (contribution.paperRelationship) {
        group.paperRelationships.push(contribution.paperRelationship);
        if (contribution.paperRelationship.properties?.sourcePaperTitle) {
          group.paperTitles.add(contribution.paperRelationship.properties.sourcePaperTitle);
        }
      }

      group.confidence = Math.max(group.confidence, Number(node.properties?.confidence || 0));
      group.mentionCount += 1;
    }
  }

  return [...groups.values()].map((group) => ({
    node: {
      ...group.node,
      properties: {
        ...group.node.properties,
        paperTitles: [...group.paperTitles].sort(),
        aliases: unique([group.node.name, ...group.aliases]),
        mentionCount: Math.max(1, group.mentionCount),
        confidence: group.confidence
      }
    },
    paperRelationships: group.paperRelationships
  }));
}

function buildPaperNode(paper) {
  return {
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
}

function sortStrings(values = []) {
  return [...new Set((values || []).filter(Boolean))].sort();
}

function mergeGlobalNode(existingNode, nextNode) {
  const existingProperties = existingNode?.properties || {};
  const nextProperties = nextNode?.properties || {};
  return {
    ...existingNode,
    ...nextNode,
    properties: {
      ...existingProperties,
      ...nextProperties,
      layer: nextProperties.layer || existingProperties.layer,
      normalized: nextProperties.normalized || existingProperties.normalized,
      paperTitles: sortStrings([...(existingProperties.paperTitles || []), ...(nextProperties.paperTitles || [])]),
      aliases: sortStrings([...(existingProperties.aliases || []), ...(nextProperties.aliases || []), nextNode.name]),
      mentionCount: Number(existingProperties.mentionCount || 0) + Number(nextProperties.mentionCount || 0),
      confidence: Math.max(Number(existingProperties.confidence || 0), Number(nextProperties.confidence || 0))
    }
  };
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildCorpusId(corpusName, rootPath) {
  return `corpus:${slugify(corpusName)}:${stableHash(rootPath)}`;
}

function buildSourceRemovalState(liteState, changedSourceKeys) {
  const nodeRefDeltas = new Map();
  const relationshipRefDeltas = new Map();
  const paperTitleBySourceKey = new Map();

  for (const sourceKey of changedSourceKeys) {
    const previous = liteState?.sources?.[sourceKey];
    if (!previous) continue;
    paperTitleBySourceKey.set(sourceKey, previous.paperTitle || '');
    for (const nodeId of previous.nodeIds || []) {
      nodeRefDeltas.set(nodeId, (nodeRefDeltas.get(nodeId) || 0) + 1);
    }
    for (const relationshipId of previous.relationshipIds || []) {
      relationshipRefDeltas.set(relationshipId, (relationshipRefDeltas.get(relationshipId) || 0) + 1);
    }
  }

  return {
    nodeRefDeltas,
    relationshipRefDeltas,
    paperTitleBySourceKey
  };
}

function computeDeletionIds(liteState, changedSourceKeys) {
  const deleteNodeIds = [];
  const deleteRelationshipIds = [];

  for (const sourceKey of changedSourceKeys) {
    const previous = liteState?.sources?.[sourceKey];
    if (!previous) continue;

    for (const nodeId of previous.nodeIds || []) {
      if (Number(liteState?.nodeRefs?.[nodeId] || 0) <= 1) {
        deleteNodeIds.push(nodeId);
      }
    }
    for (const relationshipId of previous.relationshipIds || []) {
      if (Number(liteState?.relationshipRefs?.[relationshipId] || 0) <= 1) {
        deleteRelationshipIds.push(relationshipId);
      }
    }
  }

  return {
    deleteNodeIds: sortStrings(deleteNodeIds),
    deleteRelationshipIds: sortStrings(deleteRelationshipIds)
  };
}

function buildSourceEntryFromFragment({ corpusId, paper, fragment }) {
  const nodeIds = new Set([fragment.paperNode?.id || paper.paperId]);
  const relationshipIds = new Set([
    createRelationship(corpusId, fragment.paperNode?.id || paper.paperId, EDGE_TYPES.CONTAINS).id
  ]);

  for (const contribution of fragment.globalContributions || []) {
    if (contribution.node?.id) {
      nodeIds.add(contribution.node.id);
      relationshipIds.add(createRelationship(corpusId, contribution.node.id, EDGE_TYPES.CONTAINS).id);
    }
    if (contribution.paperRelationship?.id) {
      relationshipIds.add(contribution.paperRelationship.id);
    }
  }

  for (const contribution of fragment.paperScopedContributions || []) {
    if (contribution.node?.id) {
      nodeIds.add(contribution.node.id);
      relationshipIds.add(createRelationship(corpusId, contribution.node.id, EDGE_TYPES.CONTAINS).id);
    }
    if (contribution.paperRelationship?.id) {
      relationshipIds.add(contribution.paperRelationship.id);
    }
    for (const relationship of contribution.extraRelationships || []) {
      if (relationship?.id) {
        relationshipIds.add(relationship.id);
      }
    }
  }

  for (const relationship of fragment.localRelationships || []) {
    if (relationship?.id) {
      relationshipIds.add(relationship.id);
    }
  }

  return {
    sourceKey: paper.sourceKey,
    paperId: paper.paperId,
    paperTitle: paper.paperTitle,
    fingerprint: paper.sourceFingerprint || '',
    nodeIds: [...nodeIds].sort(),
    relationshipIds: [...relationshipIds].sort()
  };
}

export async function buildGraphDeltaPayload({
  corpusName,
  rootPath,
  committedGraph,
  semanticPapers,
  liteState = null,
  changedSourceKeys: requestedChangedSourceKeys = [],
  options = {}
}) {
  const changedPapers = Array.isArray(semanticPapers) ? semanticPapers.filter(Boolean) : [];
  const changedSourceKeys = sortStrings([
    ...changedPapers.map((paper) => paper.sourceKey).filter(Boolean),
    ...(Array.isArray(requestedChangedSourceKeys) ? requestedChangedSourceKeys : [])
  ]);
  if (!changedSourceKeys.length) {
    return {
      changedSourceKeys: [],
      upsertNodes: [],
      upsertRelationships: [],
      deleteNodeIds: [],
      deleteRelationshipIds: [],
      sourceEntries: []
    };
  }

  const deltaGraph = createKnowledgeGraph();
  const corpusId = buildCorpusId(corpusName, rootPath);
  const fragments = changedPapers.length
    ? await precomputePaperGraphFragments(changedPapers, {
        graphPrecomputeConcurrency: options.graphPrecomputeConcurrency,
        analyzeConcurrency: options.analyzeConcurrency,
        concurrency: options.concurrency
      })
    : [];
  const aggregatedGlobalContributions = aggregateGlobalContributions(fragments);
  const removalState = buildSourceRemovalState(liteState, changedSourceKeys);
  const globalNodeById = new Map();
  const sourceEntries = [];

  const existingCorpusNode = committedGraph?.getNode(corpusId);
  if (!existingCorpusNode) {
    deltaGraph.addNode({
      id: corpusId,
      type: NODE_TYPES.CORPUS,
      name: corpusName,
      properties: {
        layer: getNodeLayer(NODE_TYPES.CORPUS),
        rootPath
      }
    });
  }

  for (const contributionGroup of aggregatedGlobalContributions) {
    const existingNode = committedGraph?.getNode(contributionGroup.node.id) || null;
    const nextNode = existingNode
      ? mergeGlobalNode(existingNode, contributionGroup.node)
      : contributionGroup.node;
    deltaGraph.addNode(nextNode);
    globalNodeById.set(nextNode.id, nextNode);

    if (!committedGraph?.getRelationship(createRelationship(corpusId, nextNode.id, EDGE_TYPES.CONTAINS).id)) {
      deltaGraph.addRelationship(createRelationship(corpusId, nextNode.id, EDGE_TYPES.CONTAINS));
    }
  }

  for (let index = 0; index < changedPapers.length; index += 1) {
    const paper = changedPapers[index];
    const fragment = fragments[index];
    const paperNode = fragment.paperNode || buildPaperNode(paper);
    deltaGraph.addNode(paperNode);
    deltaGraph.addRelationship(createRelationship(corpusId, paperNode.id, EDGE_TYPES.CONTAINS));

    for (const contribution of fragment.globalContributions || []) {
      const node = globalNodeById.get(contribution.node.id) || committedGraph?.getNode(contribution.node.id);
      if (node && !deltaGraph.getNode(node.id)) {
        deltaGraph.addNode(node);
      }
      if (contribution.paperRelationship) {
        deltaGraph.addRelationship(contribution.paperRelationship);
      }
    }

    for (const contribution of fragment.paperScopedContributions || []) {
      deltaGraph.addNode(contribution.node);
      deltaGraph.addRelationship(createRelationship(corpusId, contribution.node.id, EDGE_TYPES.CONTAINS));
      if (contribution.paperRelationship) {
        deltaGraph.addRelationship(contribution.paperRelationship);
      }
      for (const relationship of contribution.extraRelationships || []) {
        deltaGraph.addRelationship(relationship);
      }
    }

    for (const relationship of fragment.localRelationships || []) {
      deltaGraph.addRelationship(relationship);
    }

    sourceEntries.push(buildSourceEntryFromFragment({
      corpusId,
      paper,
      fragment
    }));
  }

  const upsertNodes = [];
  for (const node of deltaGraph.nodes) {
    const existingNode = committedGraph?.getNode(node.id);
    if (!existingNode || !sameRecord(existingNode, node)) {
      upsertNodes.push(node);
    }
  }

  const upsertRelationships = [];
  for (const relationship of deltaGraph.relationships) {
    const existingRelationship = committedGraph?.getRelationship(relationship.id);
    if (!existingRelationship || !sameRecord(existingRelationship, relationship)) {
      upsertRelationships.push(relationship);
    }
  }

  const deletions = computeDeletionIds(liteState, changedSourceKeys);

  return {
    changedSourceKeys,
    upsertNodes,
    upsertRelationships,
    deleteNodeIds: deletions.deleteNodeIds,
    deleteRelationshipIds: deletions.deleteRelationshipIds,
    removalState,
    sourceEntries
  };
}

export function applyGraphDeltaPayload(graph, deltaPayload = {}) {
  const nextGraph = loadKnowledgeGraph(graph.toJSON());

  for (const relationshipId of deltaPayload.deleteRelationshipIds || []) {
    nextGraph.removeRelationship(relationshipId);
  }

  for (const nodeId of deltaPayload.deleteNodeIds || []) {
    nextGraph.removeNode(nodeId);
  }

  for (const node of deltaPayload.upsertNodes || []) {
    if (nextGraph.getNode(node.id)) {
      nextGraph.updateNode(node);
    } else {
      nextGraph.addNode(node);
    }
  }

  for (const relationship of deltaPayload.upsertRelationships || []) {
    if (nextGraph.getRelationship(relationship.id)) {
      nextGraph.updateRelationship(relationship);
    } else {
      nextGraph.addRelationship(relationship);
    }
  }

  return nextGraph;
}
