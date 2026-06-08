import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeText, stableHash, unique } from './utils.js';

export const PAPER_IDENTIFIER_FIELDS = ['arxivId', 'doi', 'pmid', 'pmcid', 'isbn', 'issn'];
export const PAPER_STRONG_IDENTIFIER_FIELDS = ['arxivId', 'doi', 'pmid', 'pmcid'];
export const PAPER_CANONICAL_IDENTITY_PRIORITY = ['arxivId', 'doi', 'pmid', 'pmcid'];
export const PAPER_RESOLUTION_STATUSES = new Set([
  'fulltext_ready',
  'metadata_only',
  'source_missing',
  'source_invalid'
]);

const PAPER_IDENTIFIER_LABELS = {
  arxivId: 'arXiv ID',
  doi: 'DOI',
  pmid: 'PMID',
  pmcid: 'PMCID',
  isbn: 'ISBN',
  issn: 'ISSN'
};

const PAPER_IDENTIFIER_PREFIXES = {
  arxivId: 'arxiv',
  doi: 'doi',
  pmid: 'pmid',
  pmcid: 'pmcid',
  isbn: 'isbn',
  issn: 'issn'
};

function pickFirstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = pickFirstValue(...value);
      if (nested !== '') return nested;
      continue;
    }
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function pickFirstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }
  return {};
}

function normalizeIdentifierFieldName(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'arxiv' || normalized === 'arxivid') return 'arxivId';
  if (normalized === 'doi') return 'doi';
  if (normalized === 'pmid' || normalized === 'pubmedid') return 'pmid';
  if (normalized === 'pmcid' || normalized === 'pubmedcentralid') return 'pmcid';
  if (normalized === 'isbn') return 'isbn';
  if (normalized === 'issn') return 'issn';
  return '';
}

export function normalizeDoi(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/i, '')
    .replace(/\s+/g, '');
}

function hasValidArxivMonth(value = '') {
  const month = Number.parseInt(String(value || ''), 10);
  return month >= 1 && month <= 12;
}

function isValidArxivId(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;

  const modernMatch = normalized.match(/^(\d{2})(\d{2})\.(\d{4,5})(v\d+)?$/);
  if (modernMatch) {
    return hasValidArxivMonth(modernMatch[2]);
  }

  const legacyMatch = normalized.match(/^([a-z.-]+)\/(\d{2})(\d{2})(\d{3})(v\d+)?$/);
  if (legacyMatch) {
    return hasValidArxivMonth(legacyMatch[3]);
  }

  return false;
}

function hasArxivVersion(value = '') {
  return /v\d+$/i.test(String(value || '').trim());
}

function stripArxivVersion(value = '') {
  return String(value || '').trim().toLowerCase().replace(/v\d+$/i, '');
}

export function normalizeArxivId(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//, '')
    .replace(/\.pdf$/i, '')
    .replace(/^arxiv:\s*/i, '')
    .replace(/\s+/g, '');
  return isValidArxivId(normalized) ? normalized : '';
}

export function normalizePmid(value = '') {
  return String(value || '')
    .trim()
    .replace(/^pmid:\s*/i, '')
    .replace(/\D+/g, '');
}

export function normalizePmcid(value = '') {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/^PMC/i, '')
    .replace(/^PMCID:\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/[^0-9]/g, '');
  return normalized ? `PMC${normalized}` : '';
}

export function normalizeIsbn(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9X]/g, '');
}

export function normalizeIssn(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9X]/g, '');
}

function normalizeIdentifierValue(field, value = '') {
  const raw = pickFirstValue(value);
  if (!raw) return '';
  if (field === 'arxivId') return normalizeArxivId(raw);
  if (field === 'doi') return normalizeDoi(raw);
  if (field === 'pmid') return normalizePmid(raw);
  if (field === 'pmcid') return normalizePmcid(raw);
  if (field === 'isbn') return normalizeIsbn(raw);
  if (field === 'issn') return normalizeIssn(raw);
  return '';
}

function collectIdentifierInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const identifiers = pickFirstObject(input.identifiers);
  const paperMetadata = pickFirstObject(input.paperMetadata, input.metadata);
  const metadataIdentifiers = pickFirstObject(paperMetadata.identifiers);

  return {
    arxivId: pickFirstValue(
      input.arxivId, input.arxiv, input.arxiv_id,
      identifiers.arxivId, identifiers.arxiv, identifiers.arxiv_id,
      paperMetadata.arxivId, paperMetadata.arxiv, paperMetadata.arxiv_id,
      metadataIdentifiers.arxivId, metadataIdentifiers.arxiv, metadataIdentifiers.arxiv_id
    ),
    doi: pickFirstValue(input.doi, identifiers.doi, paperMetadata.doi, metadataIdentifiers.doi),
    pmid: pickFirstValue(
      input.pmid, input.pubmedId, input.pubmed_id,
      identifiers.pmid, identifiers.pubmedId, identifiers.pubmed_id,
      paperMetadata.pmid, paperMetadata.pubmedId, paperMetadata.pubmed_id,
      metadataIdentifiers.pmid, metadataIdentifiers.pubmedId, metadataIdentifiers.pubmed_id
    ),
    pmcid: pickFirstValue(
      input.pmcid, input.pubmedCentralId, input.pubmed_central_id,
      identifiers.pmcid, identifiers.pubmedCentralId, identifiers.pubmed_central_id,
      paperMetadata.pmcid, paperMetadata.pubmedCentralId, paperMetadata.pubmed_central_id,
      metadataIdentifiers.pmcid, metadataIdentifiers.pubmedCentralId, metadataIdentifiers.pubmed_central_id
    ),
    isbn: pickFirstValue(input.isbn, identifiers.isbn, paperMetadata.isbn, metadataIdentifiers.isbn),
    issn: pickFirstValue(input.issn, identifiers.issn, paperMetadata.issn, metadataIdentifiers.issn)
  };
}

function extractArxivIdFromDoi(value = '') {
  const normalizedDoi = normalizeDoi(value);
  const prefix = '10.48550/arxiv.';
  if (!normalizedDoi.startsWith(prefix)) return '';
  return normalizeArxivId(normalizedDoi.slice(prefix.length));
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function doiContainsArxivFragment(doi = '', arxivId = '') {
  const normalizedDoi = normalizeDoi(doi);
  const normalizedArxivId = normalizeArxivId(arxivId);
  if (!normalizedDoi || !normalizedArxivId) return false;
  const candidates = unique([normalizedArxivId, stripArxivVersion(normalizedArxivId)]);
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(candidate)}(?:$|[^a-z0-9])`);
    return pattern.test(normalizedDoi);
  });
}

function reconcilePaperIdentifiers(identifiers = {}) {
  const reconciled = { ...identifiers };
  const doiArxivId = extractArxivIdFromDoi(reconciled.doi);

  if (doiArxivId && !reconciled.arxivId) {
    reconciled.arxivId = doiArxivId;
    return reconciled;
  }

  if (doiArxivId && reconciled.arxivId) {
    const doiBase = stripArxivVersion(doiArxivId);
    const arxivBase = stripArxivVersion(reconciled.arxivId);
    if (doiBase !== arxivBase) {
      reconciled.arxivId = doiArxivId;
      return reconciled;
    }
    if (!hasArxivVersion(reconciled.arxivId) && hasArxivVersion(doiArxivId)) {
      reconciled.arxivId = doiArxivId;
    }
    return reconciled;
  }

  if (
    !doiArxivId
    && reconciled.doi
    && reconciled.arxivId
    && doiContainsArxivFragment(reconciled.doi, reconciled.arxivId)
  ) {
    delete reconciled.arxivId;
  }

  return reconciled;
}

export function normalizePaperIdentifiers(input = {}) {
  const collected = collectIdentifierInput(input);
  const normalized = {};

  for (const field of PAPER_IDENTIFIER_FIELDS) {
    const value = normalizeIdentifierValue(field, collected[field]);
    if (value) {
      normalized[field] = value;
    }
  }

  return reconcilePaperIdentifiers(normalized);
}

export function flattenPaperIdentifiers(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  const flattened = {};
  for (const field of PAPER_IDENTIFIER_FIELDS) {
    if (identifiers[field]) flattened[field] = identifiers[field];
  }
  return flattened;
}

export function hasAnyPaperIdentifiers(input = {}) {
  return Object.keys(normalizePaperIdentifiers(input)).length > 0;
}

export function hasStrongPaperIdentifiers(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  return PAPER_STRONG_IDENTIFIER_FIELDS.some((field) => identifiers[field]);
}

export function listPaperIdentifierEntries(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  return PAPER_IDENTIFIER_FIELDS
    .filter((field) => identifiers[field])
    .map((field) => ({
      field,
      label: PAPER_IDENTIFIER_LABELS[field],
      value: identifiers[field]
    }));
}

export function createPaperIdentifierKeys(input = {}) {
  return listPaperIdentifierEntries(input).map((entry) => `${entry.field}:${entry.value}`);
}

function createIdentifierAlias(field, value = '') {
  const normalized = normalizeIdentifierValue(field, value);
  if (!normalized) return '';
  return `${PAPER_IDENTIFIER_PREFIXES[field]}:${normalized}`;
}

export function normalizeExactPaperTitle(value = '') {
  return normalizeText(String(value || '')).replace(/\s+/g, ' ').trim();
}

export function createPaperTitleSignature(value = '') {
  const normalizedTitle = normalizeExactPaperTitle(value);
  return normalizedTitle ? stableHash(`title:${normalizedTitle}`, 20) : '';
}

export function createPaperTitleAlias(value = '') {
  const normalizedTitle = normalizeExactPaperTitle(value);
  return normalizedTitle ? `title:${normalizedTitle}` : '';
}

const INVALID_TITLE_ALIAS_VALUES = new Set(['undefined', 'null', 'nan', 'none', 'unknown', 'untitled', 'n/a', 'na']);

function normalizePaperIdentityAlias(alias = '') {
  const raw = String(alias || '').trim();
  if (!raw) return '';
  const titleMatch = raw.match(/^title:(.*)$/i);
  if (!titleMatch) return raw;
  const normalizedTitle = normalizeExactPaperTitle(titleMatch[1]);
  if (!normalizedTitle || INVALID_TITLE_ALIAS_VALUES.has(normalizedTitle)) {
    return '';
  }
  return `title:${normalizedTitle}`;
}

export function createPaperIdentityAliases(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  const aliases = [];

  for (const field of PAPER_IDENTIFIER_FIELDS) {
    const alias = createIdentifierAlias(field, identifiers[field]);
    if (alias) aliases.push(alias);
  }

  const titleAlias = createPaperTitleAlias(
    input.normalizedTitle || input.paperTitle || input.title || ''
  );
  if (titleAlias) aliases.push(titleAlias);

  const explicitAliases = Array.isArray(input.identityAliases)
    ? input.identityAliases
    : (Array.isArray(input.canonicalAliases) ? input.canonicalAliases : []);
  for (const alias of explicitAliases) {
    const normalizedAlias = normalizePaperIdentityAlias(alias);
    if (normalizedAlias) aliases.push(normalizedAlias);
  }

  return unique(aliases.map(normalizePaperIdentityAlias).filter(Boolean)).sort();
}

export function selectCanonicalPaperIdentity(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  for (const field of PAPER_CANONICAL_IDENTITY_PRIORITY) {
    const alias = createIdentifierAlias(field, identifiers[field]);
    if (alias) {
      return {
        canonicalId: alias,
        canonicalIdSource: field,
        identityConfidence: 'strong'
      };
    }
  }

  const titleAlias = createPaperTitleAlias(
    input.normalizedTitle || input.paperTitle || input.title || ''
  );
  if (titleAlias) {
    return {
      canonicalId: titleAlias,
      canonicalIdSource: 'title',
      identityConfidence: 'provisional'
    };
  }

  return {
    canonicalId: '',
    canonicalIdSource: '',
    identityConfidence: 'provisional'
  };
}

export function createPaperIdentity(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  const normalizedTitle = normalizeExactPaperTitle(
    input.normalizedTitle || input.paperTitle || input.title || ''
  );
  const titleSignature = input.titleSignature
    ? String(input.titleSignature).trim()
    : createPaperTitleSignature(normalizedTitle);
  const selection = selectCanonicalPaperIdentity({
    ...input,
    identifiers,
    normalizedTitle
  });
  const identityAliases = createPaperIdentityAliases({
    ...input,
    identifiers,
    normalizedTitle
  });

  return {
    identifiers,
    normalizedTitle,
    titleSignature,
    canonicalId: selection.canonicalId,
    canonicalIdSource: selection.canonicalIdSource,
    identityConfidence: selection.identityConfidence,
    identityAliases
  };
}

export function mergePaperIdentifiers(...inputs) {
  const merged = {};
  const conflicts = {};

  for (const input of inputs) {
    const identifiers = normalizePaperIdentifiers(input);
    for (const field of PAPER_IDENTIFIER_FIELDS) {
      const value = identifiers[field];
      if (!value) continue;
      if (!merged[field]) {
        merged[field] = value;
        continue;
      }
      if (merged[field] !== value) {
        conflicts[field] = unique([merged[field], value]);
      }
    }
  }

  return {
    identifiers: normalizePaperIdentifiers(merged),
    conflicts
  };
}

export function mergePaperIdentity(...inputs) {
  const mergedIdentifiers = mergePaperIdentifiers(...inputs);
  const normalizedTitle = pickFirstValue(
    ...inputs.map((input) => normalizeExactPaperTitle(input?.normalizedTitle || input?.paperTitle || input?.title || ''))
  );
  const titleSignature = pickFirstValue(
    ...inputs.map((input) => String(input?.titleSignature || '').trim()),
    createPaperTitleSignature(normalizedTitle)
  );
  const explicitAliases = unique(inputs.flatMap((input) => (
    Array.isArray(input?.identityAliases)
      ? input.identityAliases
      : (Array.isArray(input?.canonicalAliases) ? input.canonicalAliases : [])
  )).map(normalizePaperIdentityAlias).filter(Boolean)).sort();
  const canonicalSelection = selectCanonicalPaperIdentity({
    identifiers: mergedIdentifiers.identifiers,
    normalizedTitle
  });
  const identityAliases = unique([
    ...createPaperIdentityAliases({
      identifiers: mergedIdentifiers.identifiers,
      normalizedTitle
    }),
    ...explicitAliases
  ]).sort();

  return {
    identifiers: mergedIdentifiers.identifiers,
    conflicts: mergedIdentifiers.conflicts,
    normalizedTitle,
    titleSignature,
    canonicalId: canonicalSelection.canonicalId,
    canonicalIdSource: canonicalSelection.canonicalIdSource,
    identityConfidence: canonicalSelection.identityConfidence,
    identityAliases
  };
}

function extractStrongAliasSet(input = {}) {
  const identifiers = normalizePaperIdentifiers(input);
  return new Set(
    PAPER_STRONG_IDENTIFIER_FIELDS
      .map((field) => createIdentifierAlias(field, identifiers[field]))
      .filter(Boolean)
  );
}

export function paperIdentifiersConflict(left = {}, right = {}) {
  const leftIdentifiers = normalizePaperIdentifiers(left);
  const rightIdentifiers = normalizePaperIdentifiers(right);
  return PAPER_IDENTIFIER_FIELDS.some((field) => (
    leftIdentifiers[field]
    && rightIdentifiers[field]
    && leftIdentifiers[field] !== rightIdentifiers[field]
  ));
}

export function paperStrongIdentityOverlap(left = {}, right = {}) {
  const leftStrongAliases = extractStrongAliasSet(left);
  const rightStrongAliases = extractStrongAliasSet(right);
  if (!leftStrongAliases.size || !rightStrongAliases.size) return false;
  for (const alias of leftStrongAliases) {
    if (rightStrongAliases.has(alias)) return true;
  }
  return false;
}

export function paperIdentifiersOverlap(left = {}, right = {}) {
  if (paperStrongIdentityOverlap(left, right)) {
    return true;
  }

  const leftIdentifiers = normalizePaperIdentifiers(left);
  const rightIdentifiers = normalizePaperIdentifiers(right);
  return PAPER_IDENTIFIER_FIELDS.some((field) => (
    leftIdentifiers[field]
    && rightIdentifiers[field]
    && leftIdentifiers[field] === rightIdentifiers[field]
  ));
}

export function normalizePaperIdentifierQuery(input = {}) {
  const normalized = normalizePaperIdentifiers(input);
  const identifier = pickFirstValue(input.identifier);
  if (!identifier) return normalized;

  const identifierType = normalizeIdentifierFieldName(input.identifierType || input.type || '');
  if (identifierType) {
    const value = normalizeIdentifierValue(identifierType, identifier);
    return value ? normalizePaperIdentifiers({ ...normalized, [identifierType]: value }) : normalized;
  }

  const inferred = inferPaperIdentifierType(identifier);
  if (!inferred) return normalized;
  const value = normalizeIdentifierValue(inferred, identifier);
  if (!value) return normalized;
  return normalizePaperIdentifiers({
    ...normalized,
    [inferred]: value
  });
}

export function inferPaperIdentifierType(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (normalizeDoi(raw).startsWith('10.')) return 'doi';
  if (normalizeArxivId(raw)) {
    return 'arxivId';
  }
  if ((/^pmid:\s*/i.test(raw) || /^\d+$/.test(raw)) && normalizePmid(raw)) return 'pmid';
  if ((/^pmcid:\s*/i.test(raw) || /^PMC\d+$/i.test(raw)) && normalizePmcid(raw)) return 'pmcid';
  const isbn = normalizeIsbn(raw);
  if (/^(?:isbn:\s*)?[0-9xX-]+$/.test(raw) && (isbn.length === 10 || isbn.length === 13)) return 'isbn';
  const issn = normalizeIssn(raw);
  if (/^(?:issn:\s*)?[0-9xX-]+$/.test(raw) && issn.length === 8) return 'issn';
  return '';
}

export function normalizeSha256(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '')
    .replace(/[^a-f0-9]/g, '');
  return normalized ? `sha256:${normalized}` : '';
}

export function createContentSha256(value) {
  if (value === undefined || value === null) return '';
  const buffer = Buffer.isBuffer(value)
    ? value
    : (value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), 'utf8'));
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

export function normalizeSourceProvider(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'filesystem';
  return normalized
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'filesystem';
}

export function inferSourceProvider(input = {}) {
  const explicit = pickFirstValue(
    input.sourceProvider,
    input.source_provider,
    input.provider,
    input.paperMetadata?.sourceProvider,
    input.paperMetadata?.provider
  );
  if (explicit) return normalizeSourceProvider(explicit);

  const sourcePath = pickFirstValue(input.sourcePath, input.inputPath, input.sourcePdfPath, input.sourceMarkdownPath);
  if (sourcePath) {
    const normalizedPath = path.resolve(String(sourcePath));
    if (normalizedPath.includes(`${path.sep}.papernexus${path.sep}imports${path.sep}`)) {
      return 'import-upload';
    }
  }
  return 'filesystem';
}

export function normalizeResolutionStatus(value = '', fallback = 'metadata_only') {
  const normalized = String(value || '').trim().toLowerCase();
  if (PAPER_RESOLUTION_STATUSES.has(normalized)) return normalized;
  return fallback;
}

export function createSourceIdentity(input = {}, options = {}) {
  const paperIdentity = createPaperIdentity(input);
  const sourceKind = String(input.sourceKind || input.kind || '').trim().toLowerCase();
  const sourceProvider = inferSourceProvider(input);
  const contentSha256 = normalizeSha256(
    input.contentSha256 || input.content_sha256 || input.artifactSha256 || input.contentFingerprint || ''
  );
  const normalizedTextSha256 = normalizeSha256(
    input.normalizedTextSha256 || input.normalized_text_sha256 || ''
  );
  const resolutionStatus = normalizeResolutionStatus(
    input.resolutionStatus,
    input.sourceMissing
      ? 'source_missing'
      : (sourceKind && contentSha256 ? 'fulltext_ready' : 'metadata_only')
  );
  const sourceId = (
    paperIdentity.canonicalId
    && sourceKind
    && sourceProvider
    && contentSha256
  )
    ? `${paperIdentity.canonicalId}#${sourceKind}#${sourceProvider}#${contentSha256}`
    : '';

  return {
    sourceKind,
    sourceProvider,
    contentSha256,
    normalizedTextSha256,
    sourceId,
    resolutionStatus,
    ...(options.includePaperIdentity === false ? {} : paperIdentity)
  };
}

export function formatRequiredPaperIdentifierMessage() {
  return 'Each paper should provide at least one precise identifier. Strong paper identity prefers DOI, arXiv ID, PMID, or PMCID; ISBN/ISSN are stored as metadata but do not replace article-level identity.';
}
