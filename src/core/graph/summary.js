import { deriveDomainTaxonomyFromGraph } from './domain-taxonomy.js';
import { getNodeLayer, NODE_TYPES } from './schema.js';

export function summarizeCorpusGraph(graph) {
  const layerCounts = {};
  const layerPathCounts = {};
  const brainstormNodeCounts = {};
  const problemNodes = graph.nodes
    .filter((node) => node.type === NODE_TYPES.PROBLEM)
    .sort((left, right) => (right.properties?.paperTitles?.length || 0) - (left.properties?.paperTitles?.length || 0));

  for (const node of graph.nodes) {
    const layer = node.properties?.layer || getNodeLayer(node.type);
    layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    if (node.properties?.brainstormEligible) {
      brainstormNodeCounts[node.type] = (brainstormNodeCounts[node.type] || 0) + 1;
    }
  }

  for (const relationship of graph.relationships) {
    const pathKey = relationship.properties?.layerPath || 'unknown';
    layerPathCounts[pathKey] = (layerPathCounts[pathKey] || 0) + 1;
  }

  return {
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    topProblems: problemNodes.slice(0, 12).map((problem) => problem.name),
    topDomains: problemNodes.slice(0, 12).map((problem) => problem.name),
    layers: layerCounts,
    layerPaths: layerPathCounts,
    brainstormView: {
      eligibleNodeCount: Object.values(brainstormNodeCounts).reduce((total, count) => total + count, 0),
      nodeTypes: brainstormNodeCounts
    },
    domainDistanceMatrix: deriveDomainTaxonomyFromGraph(graph)
  };
}
