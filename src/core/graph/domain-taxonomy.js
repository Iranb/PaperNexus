import { EDGE_TYPES, NODE_TYPES } from './schema.js';

function canonicalizeTag(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned
    .split(' ')
    .map((token) => (token ? token[0].toUpperCase() + token.slice(1).toLowerCase() : token))
    .join(' ');
}

export function normalizeDomainTags(values = []) {
  const seen = new Set();
  const normalized = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const canonical = canonicalizeTag(value);
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(canonical);
  }
  return normalized;
}

export function normalizeFieldOfStudy(value, fallbacks = []) {
  const [first] = normalizeDomainTags([value, ...fallbacks]);
  return first || null;
}

function toNeighborMap(rows = []) {
  const neighbors = new Map();
  for (const row of rows) {
    const target = normalizeFieldOfStudy(row?.targetDomain);
    const relatedDomains = normalizeDomainTags(row?.relatedDomains || []);
    if (!target) continue;
    if (!neighbors.has(target)) neighbors.set(target, new Set([target]));
    for (const domain of relatedDomains) {
      neighbors.get(target).add(domain);
      if (!neighbors.has(domain)) neighbors.set(domain, new Set([domain]));
      neighbors.get(domain).add(target);
    }
  }
  return neighbors;
}

export function buildDomainDistanceMatrix(rows = []) {
  const neighbors = toNeighborMap(rows);
  const domains = [...neighbors.keys()].sort();
  const distances = {};
  for (const left of domains) {
    distances[left] = {};
    for (const right of domains) {
      if (left === right) {
        distances[left][right] = 0;
        continue;
      }
      const leftSet = neighbors.get(left) || new Set();
      const rightSet = neighbors.get(right) || new Set();
      const overlap = [...leftSet].filter((value) => rightSet.has(value)).length;
      const union = new Set([...leftSet, ...rightSet]).size || 1;
      distances[left][right] = Number((1 - overlap / union).toFixed(4));
    }
  }
  return {
    version: 'idea-catalyst-domain-distance-v1',
    domains,
    neighbors: Object.fromEntries(
      domains.map((domain) => [domain, [...(neighbors.get(domain) || [])].sort()])
    ),
    distances
  };
}

const DOMAIN_CONNECTIVITY_EDGE_TYPES = new Set([
  EDGE_TYPES.BELONGS_TO_DOMAIN,
  EDGE_TYPES.STUDIED_IN,
  EDGE_TYPES.ORIGINATED_IN
]);

const DOMAIN_CONNECTIVITY_NODE_TYPES = new Set([
  NODE_TYPES.PAPER,
  NODE_TYPES.PROBLEM,
  NODE_TYPES.RESEARCH_QUESTION,
  NODE_TYPES.CHALLENGE,
  NODE_TYPES.METHOD,
  NODE_TYPES.TAKEAWAY,
  NODE_TYPES.IDEA_FRAGMENT,
  NODE_TYPES.LIMITATION,
  NODE_TYPES.ASSUMPTION
]);

function ensureDomainEntitySet(map, domain) {
  if (!domain) return null;
  if (!map.has(domain)) {
    map.set(domain, new Set());
  }
  return map.get(domain);
}

export function deriveDomainTaxonomyFromGraph(graph) {
  const domainEntitySets = new Map();

  for (const domainNode of graph.getNodesByType(NODE_TYPES.DOMAIN)) {
    const entitySet = ensureDomainEntitySet(domainEntitySets, normalizeFieldOfStudy(domainNode.name));
    for (const relationship of graph.getIncoming(domainNode.id)) {
      if (!DOMAIN_CONNECTIVITY_EDGE_TYPES.has(relationship.type)) continue;
      entitySet?.add(relationship.sourceId);
    }
  }

  for (const node of graph.nodes || []) {
    if (!DOMAIN_CONNECTIVITY_NODE_TYPES.has(node.type)) continue;
    const domains = normalizeDomainTags([
      node.properties?.fieldOfStudy,
      ...(node.properties?.fieldCandidates || []),
      ...(node.properties?.domainTags || []),
      ...(node.properties?.sourceDomains || []),
      node.properties?.targetDomain
    ]);
    for (const domain of domains) {
      ensureDomainEntitySet(domainEntitySets, domain)?.add(node.id);
    }
  }

  const rows = [...domainEntitySets.entries()].map(([targetDomain, entitySet]) => {
    const relatedDomains = [...domainEntitySets.entries()]
      .filter(([otherDomain]) => otherDomain !== targetDomain)
      .filter(([, otherEntitySet]) => [...entitySet].some((entityId) => otherEntitySet.has(entityId)))
      .map(([otherDomain]) => otherDomain)
      .sort((left, right) => left.localeCompare(right));

    return {
      targetDomain,
      relatedDomains
    };
  });

  return buildDomainDistanceMatrix(rows);
}

export function scoreDomainDistance(matrix, left, right) {
  const from = normalizeFieldOfStudy(left);
  const to = normalizeFieldOfStudy(right);
  if (!from || !to) return 1;
  if (from === to) return 0;
  return matrix?.distances?.[from]?.[to] ?? 1;
}
