import { normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';
import { getNodeLayer, NODE_TYPES } from './schema.js';

function cleanQuestionText(value, maxLength = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

export function normalizeResearchQuestionRecord(value, defaults = {}) {
  if (!value) return null;

  const name = cleanQuestionText(
    value.name
    || value.text
    || value.domainSpecificText
    || value.domainAgnosticText
  , 180);
  if (!name) return null;

  const domainSpecificText = cleanQuestionText(value.domainSpecificText || value.text || name);
  const domainAgnosticText = cleanQuestionText(value.domainAgnosticText || '');
  const relatedProblems = unique(
    (Array.isArray(value.relatedProblems) ? value.relatedProblems : [])
      .map((entry) => cleanQuestionText(entry, 160))
      .filter(Boolean)
  );
  const relatedMechanisms = unique(
    (Array.isArray(value.relatedMechanisms) ? value.relatedMechanisms : [])
      .map((entry) => cleanQuestionText(entry, 120).toLowerCase())
      .filter(Boolean)
  );
  const domainTags = unique(
    [
      ...(Array.isArray(value.domainTags) ? value.domainTags : []),
      ...(Array.isArray(defaults.domainTags) ? defaults.domainTags : []),
      defaults.fieldOfStudy
    ]
      .map((entry) => cleanQuestionText(entry, 96))
      .filter(Boolean)
  );

  return {
    name,
    normalizedName: normalizeText(name),
    canonicalId: slugify(name),
    domainSpecificText,
    domainAgnosticText,
    relatedProblems,
    relatedMechanisms,
    fieldOfStudy: cleanQuestionText(defaults.fieldOfStudy || value.fieldOfStudy, 96) || null,
    domainTags,
    retrievalText: unique([name, domainSpecificText, domainAgnosticText].filter(Boolean)).join(' '),
    analogyText: domainAgnosticText || domainSpecificText || name
  };
}

export function normalizeResearchQuestionRecords(values = [], defaults = {}) {
  const records = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const record = normalizeResearchQuestionRecord(value, defaults);
    if (!record) continue;
    if (seen.has(record.normalizedName)) continue;
    seen.add(record.normalizedName);
    records.push(record);
  }
  return records;
}

export function buildResearchQuestionNode(record) {
  const normalized = normalizeResearchQuestionRecord(record);
  if (!normalized) return null;

  return {
    id: `${NODE_TYPES.RESEARCH_QUESTION.toLowerCase()}:${normalized.canonicalId}:${stableHash(`rq:${normalized.canonicalId}`)}`,
    type: NODE_TYPES.RESEARCH_QUESTION,
    name: normalized.name,
    properties: {
      layer: getNodeLayer(NODE_TYPES.RESEARCH_QUESTION),
      canonicalId: normalized.canonicalId,
      normalizedName: normalized.normalizedName,
      domainSpecificText: normalized.domainSpecificText,
      domainAgnosticText: normalized.domainAgnosticText,
      relatedProblems: normalized.relatedProblems,
      abstractMechanisms: normalized.relatedMechanisms,
      fieldOfStudy: normalized.fieldOfStudy,
      domainTags: normalized.domainTags,
      retrievalText: normalized.retrievalText,
      analogyText: normalized.analogyText
    }
  };
}
