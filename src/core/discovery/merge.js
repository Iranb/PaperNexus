import {
  mergePaperIdentity,
  paperIdentifiersConflict,
  paperStrongIdentityOverlap
} from '../../lib/paper-identifiers.js';
import { jaccardSimilarity, scoreTokenOverlap, tokenizeWithoutStopwords, unique } from '../../lib/utils.js';

const FUZZY_MERGE_TITLE_THRESHOLD = 0.86;
const RELATION_TITLE_THRESHOLD = 0.72;

function hasAliasOverlap(left = [], right = []) {
  const rightSet = new Set(right);
  return left.some((alias) => rightSet.has(alias));
}

function hasNonTitleAliasOverlap(left = [], right = []) {
  const rightSet = new Set(right.filter((alias) => !String(alias).startsWith('title:')));
  return left.some((alias) => !String(alias).startsWith('title:') && rightSet.has(alias));
}

function hasTitleAliasOnly(candidate = {}) {
  return !candidate.identityAliases?.some((alias) => !String(alias).startsWith('title:'));
}

function normalizeTitleToken(token = '') {
  const value = String(token || '').trim();
  if (value.length > 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith('s') && !/(ss|is|us)$/i.test(value)) return value.slice(0, -1);
  return value;
}

function tokenSetSimilarity(left = '', right = '') {
  const leftTokens = new Set(tokenizeWithoutStopwords(left).map(normalizeTitleToken));
  const rightTokens = new Set(tokenizeWithoutStopwords(right).map(normalizeTitleToken));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function titleSimilarity(left = {}, right = {}) {
  const leftTitle = left.normalizedTitle || left.title || '';
  const rightTitle = right.normalizedTitle || right.title || '';
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle === rightTitle) return 1;
  return Math.max(
    jaccardSimilarity(leftTitle, rightTitle),
    tokenSetSimilarity(leftTitle, rightTitle)
  );
}

function yearDelta(left = {}, right = {}) {
  const leftYear = Number(left.year);
  const rightYear = Number(right.year);
  if (!Number.isInteger(leftYear) || !Number.isInteger(rightYear)) return null;
  return Math.abs(leftYear - rightYear);
}

function yearsCompatible(left = {}, right = {}, tolerance = 1) {
  const delta = yearDelta(left, right);
  return delta === null || delta <= tolerance;
}

function normalizeAuthorKey(value = '') {
  const tokens = tokenizeWithoutStopwords(value);
  return tokens[tokens.length - 1] || '';
}

function authorOverlap(left = {}, right = {}) {
  const leftKeys = new Set((left.authors || []).map(normalizeAuthorKey).filter(Boolean));
  const rightKeys = new Set((right.authors || []).map(normalizeAuthorKey).filter(Boolean));
  if (!leftKeys.size || !rightKeys.size) return false;
  for (const key of leftKeys) {
    if (rightKeys.has(key)) return true;
  }
  return false;
}

function venueCompatible(left = {}, right = {}) {
  if (left.venueFamily && right.venueFamily && left.venueFamily === right.venueFamily) return true;
  if (left.venue && right.venue && jaccardSimilarity(left.venue, right.venue) >= 0.75) return true;
  const leftPacks = new Set(left.venuePackHits || []);
  return (right.venuePackHits || []).some((pack) => leftPacks.has(pack));
}

function hasCompatibleSecondaryEvidence(group, candidate) {
  if (!yearsCompatible(group, candidate, 1)) return false;
  return authorOverlap(group, candidate) || venueCompatible(group, candidate);
}

function assessMergeIntoGroup(group, candidate) {
  if (paperStrongIdentityOverlap(group, candidate)) {
    return {
      merge: true,
      reason: 'strong_identifier_overlap',
      confidence: 'strong'
    };
  }
  if (hasAliasOverlap(group.identityAliases || [], candidate.identityAliases || [])) {
    if (!paperIdentifiersConflict(group, candidate) && hasNonTitleAliasOverlap(group.identityAliases || [], candidate.identityAliases || [])) {
      return {
        merge: true,
        reason: 'identity_alias_overlap',
        confidence: 'strong'
      };
    }
    if (
      !paperIdentifiersConflict(group, candidate)
      && (
        hasTitleAliasOnly(group)
        || hasTitleAliasOnly(candidate)
        || hasCompatibleSecondaryEvidence(group, candidate)
      )
    ) {
      return {
        merge: true,
        reason: 'exact_title_with_secondary_evidence',
        confidence: hasTitleAliasOnly(group) || hasTitleAliasOnly(candidate) ? 'provisional' : 'probable',
        titleSimilarity: 1
      };
    }
  }
  if (
    hasTitleAliasOnly(group)
    && hasTitleAliasOnly(candidate)
    && group.normalizedTitle
    && group.normalizedTitle === candidate.normalizedTitle
  ) {
    return {
      merge: true,
      reason: 'exact_title_only_match',
      confidence: 'provisional'
    };
  }

  const similarity = titleSimilarity(group, candidate);
  if (
    similarity >= FUZZY_MERGE_TITLE_THRESHOLD
    && !paperIdentifiersConflict(group, candidate)
    && hasCompatibleSecondaryEvidence(group, candidate)
  ) {
    return {
      merge: true,
      reason: 'fuzzy_title_with_secondary_evidence',
      confidence: 'probable',
      titleSimilarity: similarity
    };
  }

  return {
    merge: false,
    reason: similarity >= RELATION_TITLE_THRESHOLD
      ? 'near_title_match_without_safe_merge'
      : 'no_merge_evidence',
    confidence: 'none',
    titleSimilarity: similarity
  };
}

function mergeUniqueArrays(...arrays) {
  return unique(arrays.flat().map((entry) => String(entry || '').trim()).filter(Boolean));
}

function pickBestText(...values) {
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || '';
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function tokenizeDiscoveryQuery(value = '') {
  return tokenizeWithoutStopwords(String(value || '').replace(/[-_/]+/g, ' '));
}

function scoreRetrievalEvidence(candidate = {}) {
  const titleTokens = tokenizeDiscoveryQuery(candidate.title || '');
  const abstractTokens = tokenizeDiscoveryQuery(candidate.abstract || '');
  const evidenceEntries = Array.isArray(candidate.retrievalEvidence) ? candidate.retrievalEvidence : [];
  let bestScore = 0;

  for (const evidence of evidenceEntries) {
    const queryTokens = tokenizeDiscoveryQuery(evidence?.query || '');
    if (!queryTokens.length) continue;
    const titleOverlap = scoreTokenOverlap(queryTokens, titleTokens);
    const abstractOverlap = Math.min(0.5, scoreTokenOverlap(queryTokens, abstractTokens) * 0.5);
    const familyBoost = /related_work|synonym|terminology|review|artifact|acronym/.test(evidence?.family || '')
      && titleOverlap >= 0.5
      ? 0.15
      : 0;
    bestScore = Math.max(bestScore, titleOverlap + abstractOverlap + familyBoost);
  }

  return Math.min(1.15, bestScore);
}

function scoreCandidate(candidate, topicTokens, preferredVenuePacks = []) {
  const titleTokens = tokenizeWithoutStopwords(candidate.title || '');
  const abstractTokens = tokenizeWithoutStopwords(candidate.abstract || '');
  const titleScore = scoreTokenOverlap(topicTokens, titleTokens);
  const abstractScore = Math.min(0.5, scoreTokenOverlap(topicTokens, abstractTokens) * 0.5);
  const retrievalScore = scoreRetrievalEvidence(candidate);
  const providerScore = Math.min(0.3, (candidate.providerAgreementCount || 1) * 0.08);
  const citationScore = candidate.citationCount ? Math.min(0.3, Math.log10(candidate.citationCount + 1) / 20) : 0;
  const recencyScore = candidate.year && candidate.year >= new Date().getFullYear() - 2 ? 0.12 : 0;
  const oaScore = candidate.pdfUrl || candidate.bestOaUrl ? 0.12 : 0;
  const venueScore = Math.min(0.25, (candidate.venuePackHits || []).filter((pack) => preferredVenuePacks.includes(pack)).length * 0.12);
  return Math.round((Math.max(titleScore + abstractScore, retrievalScore) + providerScore + citationScore + recencyScore + oaScore + venueScore) * 10000) / 10000;
}

function mergeGroupWithCandidate(group, candidate, mergeEvidence = null) {
  const identity = mergePaperIdentity(group, candidate);
  const providerRecords = [
    ...(group.providerRecords || []),
    {
      provider: candidate.provider,
      id: candidate.id,
      title: candidate.title,
      identifiers: candidate.identifiers
    }
  ];
  const providers = mergeUniqueArrays(group.providers || [], [candidate.provider]);
  const retrievalEvidence = [
    ...(group.retrievalEvidence || []),
    ...(candidate.retrievalEvidence || [])
  ];
  const dedupeEvidence = [
    ...(group.dedupeEvidence || []),
    ...(mergeEvidence ? [{
      provider: candidate.provider,
      candidateId: candidate.id,
      reason: mergeEvidence.reason,
      confidence: mergeEvidence.confidence,
      titleSimilarity: mergeEvidence.titleSimilarity ?? null
    }] : [])
  ];
  const sourceHints = mergeUniqueArrays(group.sourceHints || [], candidate.sourceHints || []);
  const venuePackHits = mergeUniqueArrays(group.venuePackHits || [], candidate.venuePackHits || []);
  const venueAliasesMatched = mergeUniqueArrays(group.venueAliasesMatched || [], candidate.venueAliasesMatched || []);
  const citationCount = Math.max(
    Number(group.citationCount || 0),
    Number(candidate.citationCount || 0)
  ) || null;

  return {
    ...group,
    ...identity,
    id: identity.canonicalId || group.id || candidate.id,
    title: pickBestText(group.title, candidate.title),
    authors: mergeUniqueArrays(group.authors || [], candidate.authors || []),
    year: group.year || candidate.year || null,
    publicationDate: group.publicationDate || candidate.publicationDate || null,
    venue: pickFirst(group.venue, candidate.venue),
    venueFamily: pickFirst(group.venueFamily, candidate.venueFamily),
    venueType: pickFirst(group.venueType, candidate.venueType),
    venuePackHits,
    venueAliasesMatched,
    publicationType: pickFirst(group.publicationType, candidate.publicationType),
    abstract: pickBestText(group.abstract, candidate.abstract),
    providers,
    providerAgreementCount: providers.length,
    providerRecords,
    dedupeEvidence,
    citationCount,
    openAccessStatus: pickFirst(group.openAccessStatus, candidate.openAccessStatus),
    license: pickFirst(group.license, candidate.license),
    pdfUrl: pickFirst(group.pdfUrl, candidate.pdfUrl),
    bestOaUrl: pickFirst(group.bestOaUrl, candidate.bestOaUrl),
    landingPageUrl: pickFirst(group.landingPageUrl, candidate.landingPageUrl),
    sourceHints,
    retrievalEvidence,
    conflicts: {
      ...(group.conflicts || {}),
      ...(identity.conflicts || {})
    }
  };
}

function createGroup(candidate) {
  const identity = mergePaperIdentity(candidate);
  return mergeGroupWithCandidate({
    ...identity,
    id: identity.canonicalId || candidate.id,
    providers: [],
    providerRecords: [],
    dedupeEvidence: [],
    retrievalEvidence: [],
    sourceHints: []
  }, candidate, {
    reason: 'initial_candidate',
    confidence: candidate.identityConfidence || 'provisional',
    titleSimilarity: null
  });
}

function relationTypeBetween(left = {}, right = {}) {
  const leftIsPreprint = left.publicationType === 'preprint' || (left.providers || []).includes('arxiv') || left.identifiers?.arxivId;
  const rightIsPreprint = right.publicationType === 'preprint' || (right.providers || []).includes('arxiv') || right.identifiers?.arxivId;
  if (leftIsPreprint && !rightIsPreprint) return 'preprint_of';
  if (!leftIsPreprint && rightIsPreprint) return 'has_preprint';
  if (yearDelta(left, right) !== null && yearDelta(left, right) > 1) return 'version_of';
  return 'same_work_candidate';
}

function buildRelationHint(left = {}, right = {}) {
  const similarity = titleSimilarity(left, right);
  if (similarity < RELATION_TITLE_THRESHOLD) return null;
  if (!yearsCompatible(left, right, 5)) return null;
  if (!authorOverlap(left, right) && !venueCompatible(left, right) && similarity < FUZZY_MERGE_TITLE_THRESHOLD) return null;
  return {
    type: relationTypeBetween(left, right),
    targetCanonicalId: right.canonicalId || right.id,
    targetTitle: right.title || '',
    evidence: {
      titleSimilarity: similarity,
      yearDelta: yearDelta(left, right),
      authorOverlap: authorOverlap(left, right),
      venueCompatible: venueCompatible(left, right),
      strongIdentifierConflict: paperIdentifiersConflict(left, right)
    }
  };
}

function attachRelationHints(groups = []) {
  return groups.map((group, index) => {
    const relationHints = [];
    for (let otherIndex = 0; otherIndex < groups.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const hint = buildRelationHint(group, groups[otherIndex]);
      if (hint) relationHints.push(hint);
    }
    return relationHints.length
      ? {
          ...group,
          relations: [
            ...(group.relations || []),
            ...relationHints
          ]
        }
      : group;
  });
}

export function mergeDiscoveryCandidates(params = {}) {
  const topicTokens = tokenizeWithoutStopwords(params.topic || '');
  const preferredVenuePacks = Array.isArray(params.preferredVenuePacks) ? params.preferredVenuePacks : [];
  const groups = [];

  for (const candidate of params.candidates || []) {
    if (!candidate?.title && !candidate?.canonicalId) continue;
    const match = groups
      .map((group) => ({
        group,
        evidence: assessMergeIntoGroup(group, candidate)
      }))
      .find((entry) => entry.evidence.merge);
    if (match) {
      const index = groups.indexOf(match.group);
      groups[index] = mergeGroupWithCandidate(match.group, candidate, match.evidence);
    } else {
      groups.push(createGroup(candidate));
    }
  }

  return attachRelationHints(groups)
    .map((candidate) => {
      const selectionScore = scoreCandidate(candidate, topicTokens, preferredVenuePacks);
      return {
        ...candidate,
        selectionScore,
        screening: {
          decision: candidate.identityConfidence === 'strong' || selectionScore >= 0.2 ? 'include' : 'maybe',
          reason: candidate.identityConfidence === 'strong'
            ? 'strong paper identity'
            : 'topic match requires review'
        }
      };
    })
    .sort((left, right) => (
      right.selectionScore - left.selectionScore
      || right.providerAgreementCount - left.providerAgreementCount
      || Number(right.citationCount || 0) - Number(left.citationCount || 0)
      || String(left.title).localeCompare(String(right.title))
    ));
}
