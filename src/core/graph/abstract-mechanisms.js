import { stableHash, slugify } from '../../lib/utils.js';
import { getNodeLayer, NODE_TYPES } from './schema.js';

export const ABSTRACT_MECHANISM_SUPPORT_VERSION = 'idea-catalyst-mechanism-support-v1';

function cleanMechanismText(value, maxLength = 220) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : '';
}

function normalizeMechanismName(value) {
  const cleaned = cleanMechanismText(value, 140).toLowerCase();
  return cleaned || null;
}

function normalizeMechanismLabel(value) {
  return normalizeMechanismName(value);
}

function normalizeMechanismType(value) {
  const normalized = normalizeMechanismName(value);
  return normalized || 'general';
}

function normalizeMechanismCategory(value) {
  const normalized = normalizeMechanismName(value);
  return normalized || null;
}

function pickPreferredMechanismName(candidates = []) {
  return [...new Set(candidates.filter(Boolean))]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))[0] || null;
}

function uniqueMechanismStrings(values = []) {
  const ordered = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function mergeMechanismRecords(primary, secondary) {
  const names = uniqueMechanismStrings([
    primary.name,
    secondary.name,
    ...(primary.aliases || []),
    ...(secondary.aliases || [])
  ]);
  const preferredName = pickPreferredMechanismName(names) || primary.name || secondary.name || null;
  const mechanismType = primary.mechanismType !== 'general'
    ? primary.mechanismType
    : secondary.mechanismType !== 'general'
      ? secondary.mechanismType
      : 'general';
  const mechanismCategory = primary.mechanismCategory || secondary.mechanismCategory || null;
  const description = (
    [primary.description, secondary.description]
      .map((value) => cleanMechanismText(value, 320))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length || left.localeCompare(right))[0]
  ) || preferredName;

  return {
    name: preferredName,
    normalizedName: preferredName,
    canonicalId: slugify(preferredName),
    mechanismType,
    mechanismCategory,
    description,
    aliases: uniqueMechanismStrings(names)
  };
}

export function normalizeAbstractMechanismRecord(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const name = normalizeMechanismLabel(value);
    if (!name) return null;
    return {
      name,
      normalizedName: name,
      canonicalId: slugify(name),
      mechanismType: 'general',
      mechanismCategory: null,
      description: name,
      aliases: [name]
    };
  }

  if (typeof value !== 'object') return null;

  const name = normalizeMechanismLabel(
    value.name
    || value.normalizedName
    || value.text
    || value.label
  );
  if (!name) return null;

  const aliases = uniqueMechanismStrings([
    name,
    ...(Array.isArray(value.aliases) ? value.aliases.map((alias) => normalizeMechanismLabel(alias)) : []),
    normalizeMechanismLabel(value.canonicalName),
    normalizeMechanismLabel(value.normalizedName)
  ]);

  const preferredName = pickPreferredMechanismName([
    name,
    normalizeMechanismLabel(value.canonicalName),
    normalizeMechanismLabel(value.normalizedName),
    ...aliases
  ]) || name;

  return {
    name: preferredName,
    normalizedName: preferredName,
    canonicalId: slugify(preferredName),
    mechanismType: normalizeMechanismType(value.mechanismType || value.type || value.kind),
    mechanismCategory: normalizeMechanismCategory(value.mechanismCategory || value.category || value.classification),
    description: cleanMechanismText(value.description || value.summary || preferredName, 320) || preferredName,
    aliases
  };
}

export function normalizeAbstractMechanismRecords(values = []) {
  const records = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const record = normalizeAbstractMechanismRecord(value);
    if (!record) continue;

    const existingIndex = records.findIndex((entry) => (
      entry.canonicalId === record.canonicalId
      || entry.aliases.includes(record.name)
      || record.aliases.includes(entry.name)
      || entry.aliases.some((alias) => record.aliases.includes(alias))
    ));

    if (existingIndex === -1) {
      records.push(record);
      continue;
    }

    records[existingIndex] = mergeMechanismRecords(records[existingIndex], record);
  }

  return records;
}

export function normalizeAbstractMechanismNames(values = []) {
  return normalizeAbstractMechanismRecords(values).map((entry) => entry.name);
}

export function buildAbstractMechanismNode(value, properties = {}) {
  const record = normalizeAbstractMechanismRecord(value);
  if (!record) return null;
  const merged = mergeMechanismRecords(record, normalizeAbstractMechanismRecord(properties) || {});

  return {
    id: `${NODE_TYPES.ABSTRACT_MECHANISM.toLowerCase()}:${merged.canonicalId}:${stableHash(`mechanism:${merged.canonicalId}`)}`,
    type: NODE_TYPES.ABSTRACT_MECHANISM,
    name: merged.name,
    properties: {
      layer: getNodeLayer(NODE_TYPES.ABSTRACT_MECHANISM),
      canonicalId: merged.canonicalId,
      normalizedName: merged.normalizedName,
      mechanismType: merged.mechanismType,
      mechanismCategory: merged.mechanismCategory,
      category: merged.mechanismCategory,
      description: merged.description,
      aliases: merged.aliases
    }
  };
}

function uniqueSorted(items = []) {
  return [...new Set(items.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function buildAbstractMechanismSupportProperties(entries = [], options = {}) {
  const sampleLimit = Math.max(1, Number(options.sampleLimit || 8));
  const paperLimit = Math.max(sampleLimit, Number(options.paperLimit || 12));
  const supportingNodeTypes = uniqueSorted(entries.map((entry) => entry.nodeType));
  const supportingDomains = uniqueSorted(entries.flatMap((entry) => entry.domains || []));
  const supportingPaperTitles = uniqueSorted(entries.flatMap((entry) => entry.paperTitles || []));
  const supportingRelationshipTypes = uniqueSorted(entries.map((entry) => entry.relationshipType));

  return {
    provenanceVersion: ABSTRACT_MECHANISM_SUPPORT_VERSION,
    supportingNodeCount: entries.length,
    supportingPaperCount: supportingPaperTitles.length,
    supportingDomains,
    supportingNodeTypes,
    supportingRelationshipTypes,
    supportingPaperTitles: supportingPaperTitles.slice(0, paperLimit),
    supportingSourceNodes: entries.slice(0, sampleLimit).map((entry) => ({
      nodeId: entry.nodeId,
      nodeName: entry.nodeName,
      nodeType: entry.nodeType,
      role: entry.role,
      relationshipType: entry.relationshipType,
      domains: Array.isArray(entry.domains) ? [...entry.domains] : [],
      paperTitles: Array.isArray(entry.paperTitles) ? [...entry.paperTitles] : []
    }))
  };
}
