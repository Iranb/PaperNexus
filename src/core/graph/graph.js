import { tokenizeWithoutStopwords, unique } from '../../lib/utils.js';

export function createKnowledgeGraph() {
  const nodeMap = new Map();
  const relationshipMap = new Map();
  const nodeTypeMap = new Map();
  const outgoingMap = new Map();
  const incomingMap = new Map();
  const searchTokenMap = new Map();
  let cachedNodes = null;
  let cachedRelationships = null;

  function appendToMap(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  function removeFromMapList(map, key, predicate) {
    const values = map.get(key);
    if (!values?.length) return;
    const nextValues = values.filter((item) => !predicate(item));
    if (nextValues.length) {
      map.set(key, nextValues);
    } else {
      map.delete(key);
    }
  }

  function markDirty() {
    cachedNodes = null;
    cachedRelationships = null;
  }

  function nodeSearchText(node) {
    const propertyText = Object.values(node.properties || {})
      .flatMap((value) => {
        if (Array.isArray(value)) return value.map((item) => String(item));
        if (value && typeof value === 'object') return [];
        return value === null || value === undefined ? [] : [String(value)];
      })
      .join(' ');

    return [node.name, propertyText].filter(Boolean).join(' ');
  }

  function indexNodeSearch(node) {
    const tokens = unique(tokenizeWithoutStopwords(nodeSearchText(node))).slice(0, 64);
    for (const token of tokens) {
      if (!searchTokenMap.has(token)) searchTokenMap.set(token, new Set());
      searchTokenMap.get(token).add(node.id);
    }
  }

  function removeNodeSearch(node) {
    const tokens = unique(tokenizeWithoutStopwords(nodeSearchText(node))).slice(0, 64);
    for (const token of tokens) {
      const ids = searchTokenMap.get(token);
      if (!ids) continue;
      ids.delete(node.id);
      if (!ids.size) {
        searchTokenMap.delete(token);
      }
    }
  }

  function removeRelationshipById(id) {
    const relationship = relationshipMap.get(id);
    if (!relationship) return null;
    relationshipMap.delete(id);
    removeFromMapList(outgoingMap, relationship.sourceId, (entry) => entry.id === id);
    removeFromMapList(incomingMap, relationship.targetId, (entry) => entry.id === id);
    return relationship;
  }

  return {
    addNode(node) {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, node);
        appendToMap(nodeTypeMap, node.type, node);
        indexNodeSearch(node);
        markDirty();
      }
      return nodeMap.get(node.id);
    },

    addRelationship(relationship) {
      if (!relationshipMap.has(relationship.id)) {
        relationshipMap.set(relationship.id, relationship);
        appendToMap(outgoingMap, relationship.sourceId, relationship);
        appendToMap(incomingMap, relationship.targetId, relationship);
        markDirty();
      }
      return relationshipMap.get(relationship.id);
    },

    getNode(id) {
      return nodeMap.get(id);
    },

    getRelationship(id) {
      return relationshipMap.get(id);
    },

    removeNode(id) {
      const node = nodeMap.get(id);
      if (!node) return;
      nodeMap.delete(id);
      removeFromMapList(nodeTypeMap, node.type, (entry) => entry.id === id);
      removeNodeSearch(node);
      markDirty();

      for (const relationship of [...(outgoingMap.get(id) || []), ...(incomingMap.get(id) || [])]) {
        removeRelationshipById(relationship.id);
      }
    },

    updateNode(node) {
      const previous = nodeMap.get(node.id);
      if (!previous) {
        return this.addNode(node);
      }

      removeFromMapList(nodeTypeMap, previous.type, (entry) => entry.id === previous.id);
      removeNodeSearch(previous);
      nodeMap.set(node.id, node);
      appendToMap(nodeTypeMap, node.type, node);
      indexNodeSearch(node);
      markDirty();
      return node;
    },

    removeRelationship(id) {
      const removed = removeRelationshipById(id);
      if (removed) {
        markDirty();
      }
      return removed;
    },

    updateRelationship(relationship) {
      const previous = relationshipMap.get(relationship.id);
      if (!previous) {
        return this.addRelationship(relationship);
      }

      removeRelationshipById(relationship.id);
      relationshipMap.set(relationship.id, relationship);
      appendToMap(outgoingMap, relationship.sourceId, relationship);
      appendToMap(incomingMap, relationship.targetId, relationship);
      markDirty();
      return relationship;
    },

    forEachNode(fn) {
      nodeMap.forEach(fn);
    },

    forEachRelationship(fn) {
      relationshipMap.forEach(fn);
    },

    get nodes() {
      if (!cachedNodes) {
        cachedNodes = [...nodeMap.values()];
      }
      return cachedNodes;
    },

    get relationships() {
      if (!cachedRelationships) {
        cachedRelationships = [...relationshipMap.values()];
      }
      return cachedRelationships;
    },

    get nodeCount() {
      return nodeMap.size;
    },

    get relationshipCount() {
      return relationshipMap.size;
    },

    getNodesByType(type) {
      return nodeTypeMap.get(type) || [];
    },

    getOutgoing(nodeId) {
      return outgoingMap.get(nodeId) || [];
    },

    getIncoming(nodeId) {
      return incomingMap.get(nodeId) || [];
    },

    getSearchCandidates(query) {
      const tokens = tokenizeWithoutStopwords(query);
      const nodeIds = new Set();
      for (const token of tokens) {
        for (const nodeId of searchTokenMap.get(token) || []) {
          nodeIds.add(nodeId);
        }
      }
      return [...nodeIds].map((nodeId) => nodeMap.get(nodeId)).filter(Boolean);
    },

    toJSON() {
      return {
        nodes: this.nodes,
        relationships: this.relationships,
        indexes: {
          searchTokens: Object.fromEntries(
            [...searchTokenMap.entries()].map(([token, nodeIds]) => [token, [...nodeIds]])
          )
        }
      };
    }
  };
}

export function loadKnowledgeGraph(data) {
  const graph = createKnowledgeGraph();
  for (const node of data?.nodes || []) {
    graph.addNode(node);
  }
  for (const relationship of data?.relationships || []) {
    graph.addRelationship(relationship);
  }
  return graph;
}
