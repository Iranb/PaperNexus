import { normalizeText, stableHash, truncate } from '../../lib/utils.js';
import { EDGE_TYPES } from './schema.js';
import { loadKnowledgeGraph } from './graph.js';
import {
  buildLayerPathProperties,
  describeCompatibility,
  ensureNodeProperties,
  normalizeNodeTypeName,
  normalizeRelationTypeName,
  resolveCompatibleRelationType
} from './rules.js';

const ACTION_ALIASES = {
  create_node: 'upsert_node',
  update_node: 'upsert_node',
  edit_node: 'upsert_node',
  upsert_node: 'upsert_node',
  delete_node: 'delete_node',
  create_relationship: 'upsert_relationship',
  update_relationship: 'upsert_relationship',
  edit_relationship: 'upsert_relationship',
  upsert_relationship: 'upsert_relationship',
  delete_relationship: 'delete_relationship'
};

const BIDIRECTIONAL_RELATION_TYPES = new Set([
  EDGE_TYPES.RELATED_TO,
  EDGE_TYPES.SIMILAR_TO,
  EDGE_TYPES.COMPATIBLE_WITH,
  EDGE_TYPES.COMBINES_WITH,
  EDGE_TYPES.CONTRADICTS
]);

function normalizeAction(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ACTION_ALIASES[key] || null;
}

function cleanName(value, maxLength = 180) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), maxLength);
}

function asProperties(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function cloneGraph(graph) {
  return loadKnowledgeGraph(graph.toJSON());
}

function uniqueId(graph, baseId, getItem) {
  if (!getItem.call(graph, baseId)) return baseId;
  let index = 2;
  while (getItem.call(graph, `${baseId}:${index}`)) {
    index += 1;
  }
  return `${baseId}:${index}`;
}

function createNodeId(graph, type, name) {
  const baseId = `manual:${String(type || 'node').toLowerCase()}:${stableHash(`${type}:${normalizeText(name)}`, 14)}`;
  return uniqueId(graph, baseId, graph.getNode);
}

function createRelationshipId(graph, sourceId, type, targetId) {
  const baseId = `rel:manual:${stableHash(`${sourceId}:${type}:${targetId}`, 16)}`;
  return uniqueId(graph, baseId, graph.getRelationship);
}

function findNodesByName(graph, name, type) {
  const normalized = normalizeText(name);
  if (!normalized) return [];

  const candidates = type ? graph.getNodesByType(type) : graph.nodes;
  return candidates.filter((node) => {
    const aliases = Array.isArray(node.properties?.aliases) ? node.properties.aliases : [];
    const nodeNames = [node.name, node.properties?.normalized, ...aliases];
    return nodeNames.some((value) => normalizeText(value) === normalized);
  });
}

function resolveNodeReference(graph, ref, label = 'node') {
  if (!ref) {
    throw new Error(`Missing ${label} reference.`);
  }

  if (typeof ref === 'string') {
    const byId = graph.getNode(ref);
    if (byId) return byId;
    return resolveNodeReference(graph, { name: ref }, label);
  }

  if (typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error(`Invalid ${label} reference.`);
  }

  if (ref.id) {
    const node = graph.getNode(ref.id);
    if (!node) {
      throw new Error(`Could not resolve ${label} id "${ref.id}".`);
    }
    return node;
  }

  const type = ref.type ? normalizeNodeTypeName(ref.type) : null;
  const name = cleanName(ref.name || ref.query || '');
  if (!name) {
    throw new Error(`Missing ${label} name or id.`);
  }

  const matches = findNodesByName(graph, name, type);
  if (!matches.length) {
    throw new Error(`Could not resolve ${label} "${name}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ${label} "${name}". Matches: ${matches.slice(0, 6).map((node) => `${node.type}:${node.id}`).join(', ')}`
    );
  }
  return matches[0];
}

function findRelationshipByShape(graph, draft) {
  if (draft.id) {
    return graph.getRelationship(draft.id) || null;
  }

  if (!draft.sourceId || !draft.targetId || !draft.type) {
    return null;
  }

  return graph.getOutgoing(draft.sourceId).find((relationship) => {
    return relationship.targetId === draft.targetId && relationship.type === draft.type;
  }) || null;
}

function withAuditProperties(existingProperties, nextProperties, actor, isCreate) {
  const timestamp = new Date().toISOString();
  return {
    ...existingProperties,
    ...nextProperties,
    manual: true,
    editSource: 'agent-rule',
    updatedAt: timestamp,
    updatedBy: actor || nextProperties.updatedBy || existingProperties.updatedBy || 'agent',
    createdAt: isCreate ? timestamp : (existingProperties.createdAt || nextProperties.createdAt || timestamp),
    createdBy: isCreate
      ? (actor || nextProperties.createdBy || 'agent')
      : (existingProperties.createdBy || nextProperties.createdBy || actor || 'agent')
  };
}

function prepareNodeDraft(existingNode, draft, actor) {
  const nextType = normalizeNodeTypeName(draft.type || existingNode?.type);
  const nextName = cleanName(draft.name || existingNode?.name);
  if (!nextType) {
    throw new Error('Node type is required and must match the PaperNexus schema.');
  }
  if (!nextName) {
    throw new Error('Node name is required.');
  }

  const nextProperties = draft.replaceProperties
    ? asProperties(draft.properties)
    : { ...(existingNode?.properties || {}), ...asProperties(draft.properties) };
  const auditedProperties = withAuditProperties(existingNode?.properties || {}, nextProperties, actor, !existingNode);

  return {
    id: existingNode?.id || draft.id,
    type: nextType,
    name: nextName,
    properties: ensureNodeProperties(nextType, nextName, auditedProperties)
  };
}

function upsertNode(graph, operation, actor) {
  const draft = operation.node || operation;
  const existingNode = draft.id
    ? graph.getNode(draft.id)
    : draft.match
      ? resolveNodeReference(graph, draft.match, 'node')
      : null;
  const node = prepareNodeDraft(existingNode, draft, actor);
  node.id = node.id || createNodeId(graph, node.type, node.name);

  if (existingNode) {
    graph.updateNode(node);
    return {
      mode: 'updated',
      entity: 'node',
      id: node.id,
      label: `${node.type}: ${node.name}`,
      message: `Updated node ${node.id}`,
      createdCount: 0,
      updatedCount: 1
    };
  }

  graph.addNode(node);
  return {
    mode: 'created',
    entity: 'node',
    id: node.id,
    label: `${node.type}: ${node.name}`,
    message: `Created node ${node.id}`,
    createdCount: 1,
    updatedCount: 0
  };
}

function deleteNode(graph, operation) {
  const draft = operation.node || operation;
  const node = resolveNodeReference(graph, draft.match || draft.id || draft.name ? draft.match || draft : draft.ref, 'node');
  const relationshipCount = graph.getOutgoing(node.id).length + graph.getIncoming(node.id).length;
  graph.removeNode(node.id);
  return {
    mode: 'deleted',
    entity: 'node',
    id: node.id,
    label: `${node.type}: ${node.name}`,
    message: `Deleted node ${node.id} and removed ${relationshipCount} attached relationships`,
    deletedCount: 1
  };
}

function prepareRelationshipDraft(graph, existingRelationship, draft, actor) {
  const sourceNode = resolveNodeReference(
    graph,
    draft.source || (draft.sourceId ? { id: draft.sourceId } : null),
    'relationship source'
  );
  const targetNode = resolveNodeReference(
    graph,
    draft.target || (draft.targetId ? { id: draft.targetId } : null),
    'relationship target'
  );

  const proposedType = normalizeRelationTypeName(draft.type || draft.relationType || existingRelationship?.type);
  if (!proposedType) {
    throw new Error('Relationship type is required and must match the PaperNexus schema.');
  }

  const resolvedType = resolveCompatibleRelationType(sourceNode.type, targetNode.type, proposedType);
  if (!resolvedType) {
    throw new Error(`Invalid relationship ${describeCompatibility(sourceNode.type, proposedType, targetNode.type)}.`);
  }

  const nextProperties = draft.replaceProperties
    ? asProperties(draft.properties)
    : { ...(existingRelationship?.properties || {}), ...asProperties(draft.properties) };
  const auditedProperties = withAuditProperties(existingRelationship?.properties || {}, nextProperties, actor, !existingRelationship);

  return {
    id: existingRelationship?.id || draft.id,
    sourceId: sourceNode.id,
    targetId: targetNode.id,
    type: resolvedType,
    properties: buildLayerPathProperties(sourceNode, targetNode, {
      ...auditedProperties,
      relationSource: auditedProperties.relationSource || 'agent-rule'
    })
  };
}

function upsertSingleRelationship(graph, operation, actor, sourceRef = null, targetRef = null) {
  const draft = operation.relationship || operation;
  const seededDraft = {
    ...draft,
    source: sourceRef || draft.source,
    target: targetRef || draft.target
  };
  const existingRelationship = findRelationshipByShape(graph, {
    id: draft.id,
    sourceId: sourceRef?.id || draft.sourceId,
    targetId: targetRef?.id || draft.targetId,
    type: normalizeRelationTypeName(draft.type || draft.relationType)
  });
  const relationship = prepareRelationshipDraft(graph, existingRelationship, seededDraft, actor);
  relationship.id = relationship.id || createRelationshipId(graph, relationship.sourceId, relationship.type, relationship.targetId);

  if (existingRelationship) {
    graph.updateRelationship(relationship);
    return {
      mode: 'updated',
      entity: 'relationship',
      id: relationship.id,
      label: `${relationship.type}: ${relationship.sourceId} -> ${relationship.targetId}`,
      message: `Updated relationship ${relationship.id}`,
      createdCount: 0,
      updatedCount: 1
    };
  }

  graph.addRelationship(relationship);
  return {
    mode: 'created',
    entity: 'relationship',
    id: relationship.id,
    label: `${relationship.type}: ${relationship.sourceId} -> ${relationship.targetId}`,
    message: `Created relationship ${relationship.id}`,
    createdCount: 1,
    updatedCount: 0
  };
}

function upsertRelationship(graph, operation, actor) {
  const draft = operation.relationship || operation;
  const forwardSource = resolveNodeReference(
    graph,
    draft.source || (draft.sourceId ? { id: draft.sourceId } : null),
    'relationship source'
  );
  const forwardTarget = resolveNodeReference(
    graph,
    draft.target || (draft.targetId ? { id: draft.targetId } : null),
    'relationship target'
  );
  const relationType = normalizeRelationTypeName(draft.type || draft.relationType);
  if (draft.bidirectional) {
    if (!BIDIRECTIONAL_RELATION_TYPES.has(relationType)) {
      throw new Error(`Relationship type ${relationType} does not support bidirectional mutation mode.`);
    }
    const forward = upsertSingleRelationship(graph, operation, actor, { id: forwardSource.id }, { id: forwardTarget.id });
    const reverse = upsertSingleRelationship(graph, operation, actor, { id: forwardTarget.id }, { id: forwardSource.id });
    return {
      mode: forward.mode === 'updated' && reverse.mode === 'updated' ? 'updated' : 'created',
      entity: 'relationship',
      id: `${forward.id},${reverse.id}`,
      label: `${relationType}: ${forwardSource.id} <-> ${forwardTarget.id}`,
      message: `Upserted bidirectional ${relationType} relationships`,
      relatedIds: [forward.id, reverse.id],
      createdCount: (forward.createdCount || 0) + (reverse.createdCount || 0),
      updatedCount: (forward.updatedCount || 0) + (reverse.updatedCount || 0)
    };
  }

  return upsertSingleRelationship(graph, operation, actor, { id: forwardSource.id }, { id: forwardTarget.id });
}

function deleteRelationship(graph, operation) {
  const draft = operation.relationship || operation;
  const relationType = normalizeRelationTypeName(draft.type || draft.relationType);
  const sourceNode = draft.source || draft.sourceId ? resolveNodeReference(graph, draft.source || { id: draft.sourceId }, 'relationship source') : null;
  const targetNode = draft.target || draft.targetId ? resolveNodeReference(graph, draft.target || { id: draft.targetId }, 'relationship target') : null;
  const relationship = findRelationshipByShape(graph, {
    id: draft.id,
    sourceId: sourceNode?.id,
    targetId: targetNode?.id,
    type: relationType
  });

  if (!relationship) {
    throw new Error('Could not resolve relationship to delete.');
  }

  const deleted = [relationship.id];
  graph.removeRelationship(relationship.id);

  if (draft.bidirectional && sourceNode && targetNode && relationType && BIDIRECTIONAL_RELATION_TYPES.has(relationType)) {
    const reverse = findRelationshipByShape(graph, {
      sourceId: targetNode.id,
      targetId: sourceNode.id,
      type: relationType
    });
    if (reverse) {
      graph.removeRelationship(reverse.id);
      deleted.push(reverse.id);
    }
  }

  return {
    mode: 'deleted',
    entity: 'relationship',
    id: deleted.join(','),
    label: `${relationship.type}: ${relationship.sourceId} -> ${relationship.targetId}`,
    message: deleted.length > 1
      ? `Deleted ${deleted.length} relationships`
      : `Deleted relationship ${relationship.id}`,
    relatedIds: deleted,
    deletedCount: deleted.length
  };
}

export function applyGraphMutations(graph, operations, options = {}) {
  if (!Array.isArray(operations) || !operations.length) {
    throw new Error('Mutation request must include at least one operation.');
  }

  const workingGraph = cloneGraph(graph);
  const actor = cleanName(options.actor || 'agent', 80) || 'agent';
  const results = [];
  const countsBefore = {
    nodes: workingGraph.nodeCount,
    relationships: workingGraph.relationshipCount
  };
  const summary = {
    nodesCreated: 0,
    nodesUpdated: 0,
    nodesDeleted: 0,
    relationshipsCreated: 0,
    relationshipsUpdated: 0,
    relationshipsDeleted: 0
  };

  operations.forEach((operation, index) => {
    const action = normalizeAction(operation?.action);
    if (!action) {
      throw new Error(`Unsupported mutation action at index ${index}: ${operation?.action || 'unknown'}`);
    }

    let result;
    if (action === 'upsert_node') {
      result = upsertNode(workingGraph, operation, actor);
      summary.nodesCreated += result.createdCount || 0;
      summary.nodesUpdated += result.updatedCount || 0;
    } else if (action === 'delete_node') {
      result = deleteNode(workingGraph, operation);
      summary.nodesDeleted += result.deletedCount || 1;
    } else if (action === 'upsert_relationship') {
      result = upsertRelationship(workingGraph, operation, actor);
      summary.relationshipsCreated += result.createdCount || 0;
      summary.relationshipsUpdated += result.updatedCount || 0;
    } else if (action === 'delete_relationship') {
      result = deleteRelationship(workingGraph, operation);
      summary.relationshipsDeleted += result.deletedCount || 1;
    }

    results.push({
      index,
      action,
      ...result
    });
  });

  return {
    graph: workingGraph,
    dryRun: Boolean(options.dryRun),
    actor,
    operationsCount: operations.length,
    countsBefore,
    countsAfter: {
      nodes: workingGraph.nodeCount,
      relationships: workingGraph.relationshipCount
    },
    summary,
    results
  };
}
