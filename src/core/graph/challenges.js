import { normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';
import { normalizeAbstractMechanismNames } from './abstract-mechanisms.js';
import { getNodeLayer, NODE_TYPES } from './schema.js';

function cleanChallengeText(value, maxLength = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : '';
}

function normalizeChallengeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'domain-specific') return 'domain-specific';
  if (normalized === 'domain-agnostic') return 'domain-agnostic';
  if (normalized === 'mixed') return 'mixed';
  return 'mixed';
}

export function normalizeChallengeRecord(value, defaults = {}) {
  if (!value) return null;

  const name = cleanChallengeText(
    value.name
    || value.domainSpecificText
    || value.domainAgnosticText
    || value.text
  , 180);
  if (!name) return null;

  const domainSpecificText = cleanChallengeText(value.domainSpecificText || value.text || name);
  const domainAgnosticText = cleanChallengeText(value.domainAgnosticText || '');
  const relatedMechanisms = normalizeAbstractMechanismNames([
    ...(Array.isArray(value.relatedMechanisms) ? value.relatedMechanisms : []),
    ...(Array.isArray(defaults.relatedMechanisms) ? defaults.relatedMechanisms : [])
  ]);
  const domainTags = unique(
    [
      ...(Array.isArray(value.domainTags) ? value.domainTags : []),
      ...(Array.isArray(defaults.domainTags) ? defaults.domainTags : []),
      defaults.fieldOfStudy
    ]
      .map((entry) => cleanChallengeText(entry, 96))
      .filter(Boolean)
  );

  return {
    name,
    normalizedName: normalizeText(name),
    challengeType: normalizeChallengeType(value.challengeType),
    domainSpecificText,
    domainAgnosticText,
    relatedMechanisms,
    fieldOfStudy: cleanChallengeText(defaults.fieldOfStudy || value.fieldOfStudy, 96) || null,
    domainTags
  };
}

export function buildChallengeVariantRecords(value, defaults = {}) {
  const record = normalizeChallengeRecord(value, defaults);
  if (!record) return [];

  const variants = [];
  const pushVariant = (abstractionLevel, text) => {
    const cleaned = cleanChallengeText(text, 220);
    if (!cleaned) return;
    const canonicalId = slugify(`${abstractionLevel}-${cleaned}`);
    variants.push({
      ...record,
      name: cleaned,
      normalizedName: normalizeText(cleaned),
      canonicalId,
      abstractionLevel,
      bridgeRetrievalText: unique([
        cleaned,
        record.domainAgnosticText,
        record.domainSpecificText,
        ...record.relatedMechanisms
      ].filter(Boolean)).join(' '),
      analogyText: record.domainAgnosticText || cleaned
    });
  };

  pushVariant('specific', record.domainSpecificText || record.name);
  if (record.domainAgnosticText && normalizeText(record.domainAgnosticText) !== normalizeText(record.domainSpecificText || record.name)) {
    pushVariant('agnostic', record.domainAgnosticText);
  }

  return variants;
}

export function buildChallengeNode(record) {
  if (!record?.canonicalId) return null;

  return {
    id: `${NODE_TYPES.CHALLENGE.toLowerCase()}:${record.canonicalId}:${stableHash(`challenge:${record.canonicalId}`)}`,
    type: NODE_TYPES.CHALLENGE,
    name: record.name,
    properties: {
      layer: getNodeLayer(NODE_TYPES.CHALLENGE),
      canonicalId: record.canonicalId,
      normalizedName: record.normalizedName,
      abstractionLevel: record.abstractionLevel,
      challengeType: record.challengeType,
      domainSpecificText: record.domainSpecificText,
      domainAgnosticText: record.domainAgnosticText,
      abstractMechanisms: record.relatedMechanisms,
      fieldOfStudy: record.fieldOfStudy,
      domainTags: record.domainTags,
      bridgeRetrievalText: record.bridgeRetrievalText,
      analogyText: record.analogyText
    }
  };
}
