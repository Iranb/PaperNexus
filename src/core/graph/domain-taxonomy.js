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

export function scoreDomainDistance(matrix, left, right) {
  const from = normalizeFieldOfStudy(left);
  const to = normalizeFieldOfStudy(right);
  if (!from || !to) return 1;
  if (from === to) return 0;
  return matrix?.distances?.[from]?.[to] ?? 1;
}
