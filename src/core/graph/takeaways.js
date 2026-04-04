import { normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { getNodeLayer, NODE_TYPES } from './schema.js';

function cleanText(value, maxLength = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

export function normalizeEvidenceSnippetRecord(value) {
  if (!value) return null;
  const text = cleanText(value.text || value.evidenceText || value.name);
  if (!text) return null;

  return {
    name: cleanText(value.name || text, 160) || text,
    text,
    sectionHeading: cleanText(value.sectionHeading || value.section || '', 120),
    sectionRole: cleanText(value.sectionRole || value.role || '', 32),
    confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : 0.72,
    supportsTakeaways: unique((Array.isArray(value.supportsTakeaways) ? value.supportsTakeaways : []).map((entry) => cleanText(entry, 160)).filter(Boolean)),
    supportsChallenges: unique((Array.isArray(value.supportsChallenges) ? value.supportsChallenges : []).map((entry) => cleanText(entry, 180)).filter(Boolean)),
    supportsMechanisms: normalizeAbstractMechanismNames(value.supportsMechanisms || [])
  };
}

export function normalizeTakeawayRecord(value, defaults = {}) {
  if (!value) return null;
  const name = cleanText(value.name || value.text, 180);
  const text = cleanText(value.text || value.summary || name);
  if (!name || !text) return null;

  const sourceDomains = unique(
    [
      ...(Array.isArray(value.sourceDomains) ? value.sourceDomains : []),
      ...(Array.isArray(defaults.sourceDomains) ? defaults.sourceDomains : []),
      defaults.fieldOfStudy
    ]
      .map((entry) => cleanText(entry, 96))
      .filter(Boolean)
  );

  return {
    name,
    normalizedName: normalizeText(name),
    canonicalId: slugify(name),
    text,
    relatedMechanisms: normalizeAbstractMechanismNames(value.relatedMechanisms || []),
    relatedChallenges: unique((Array.isArray(value.relatedChallenges) ? value.relatedChallenges : []).map((entry) => cleanText(entry, 180)).filter(Boolean)),
    sourceDomains,
    supportingSnippets: (Array.isArray(value.supportingSnippets) ? value.supportingSnippets : [])
      .map((entry) => normalizeEvidenceSnippetRecord(entry))
      .filter(Boolean),
    retrievalText: unique([name, text, ...sourceDomains].filter(Boolean)).join(' '),
    analogyText: text
  };
}

export function normalizeIdeaFragmentRecord(value, defaults = {}) {
  if (!value) return null;
  const name = cleanText(value.name || value.text, 180);
  const text = cleanText(value.text || value.summary || name);
  if (!name || !text) return null;

  const sourceDomains = unique(
    [
      ...(Array.isArray(value.sourceDomains) ? value.sourceDomains : []),
      ...(Array.isArray(defaults.sourceDomains) ? defaults.sourceDomains : [])
    ]
      .map((entry) => cleanText(entry, 96))
      .filter(Boolean)
  );

  return {
    name,
    normalizedName: normalizeText(name),
    canonicalId: slugify(name),
    text,
    targetDomain: cleanText(value.targetDomain || defaults.targetDomain, 96) || null,
    sourceDomains,
    relatedMechanisms: normalizeAbstractMechanismNames(value.relatedMechanisms || []),
    sourceTakeaways: unique((Array.isArray(value.sourceTakeaways) ? value.sourceTakeaways : []).map((entry) => cleanText(entry, 180)).filter(Boolean)),
    addressesChallenges: unique((Array.isArray(value.addressesChallenges) ? value.addressesChallenges : []).map((entry) => cleanText(entry, 180)).filter(Boolean)),
    supportingSnippets: (Array.isArray(value.supportingSnippets) ? value.supportingSnippets : [])
      .map((entry) => normalizeEvidenceSnippetRecord(entry))
      .filter(Boolean),
    retrievalText: unique([name, text, value.targetDomain, ...sourceDomains].filter(Boolean)).join(' '),
    analogyText: text
  };
}

export function buildTakeawayNode(record) {
  if (!record?.canonicalId) return null;
  return {
    id: `${NODE_TYPES.TAKEAWAY.toLowerCase()}:${record.canonicalId}:${stableHash(`takeaway:${record.canonicalId}`)}`,
    type: NODE_TYPES.TAKEAWAY,
    name: record.name,
    properties: {
      layer: getNodeLayer(NODE_TYPES.TAKEAWAY),
      canonicalId: record.canonicalId,
      normalizedName: record.normalizedName,
      text: record.text,
      sourceDomains: record.sourceDomains,
      domainTags: record.sourceDomains,
      abstractMechanisms: record.relatedMechanisms,
      relatedChallenges: record.relatedChallenges,
      retrievalText: record.retrievalText,
      analogyText: record.analogyText
    }
  };
}

export function buildIdeaFragmentNode(record) {
  if (!record?.canonicalId) return null;
  return {
    id: `${NODE_TYPES.IDEA_FRAGMENT.toLowerCase()}:${record.canonicalId}:${stableHash(`idea-fragment:${record.canonicalId}`)}`,
    type: NODE_TYPES.IDEA_FRAGMENT,
    name: record.name,
    properties: {
      layer: getNodeLayer(NODE_TYPES.IDEA_FRAGMENT),
      canonicalId: record.canonicalId,
      normalizedName: record.normalizedName,
      text: record.text,
      sourceDomains: record.sourceDomains,
      targetDomain: record.targetDomain,
      domainTags: unique([record.targetDomain, ...record.sourceDomains].filter(Boolean)),
      abstractMechanisms: record.relatedMechanisms,
      sourceTakeaways: record.sourceTakeaways,
      addressesChallenges: record.addressesChallenges,
      retrievalText: record.retrievalText,
      analogyText: record.analogyText
    }
  };
}
