import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EDGE_TYPES, getNodeLayer, NODE_TYPES } from '../graph/schema.js';
import { normalizeDomainTags, normalizeFieldOfStudy } from '../graph/domain-taxonomy.js';
import {
  normalizeAbstractMechanismNames,
  normalizeAbstractMechanismRecords
} from '../graph/abstract-mechanisms.js';
import { normalizeResearchQuestionRecords } from '../graph/research-questions.js';
import { buildChallengeVariantRecords } from '../graph/challenges.js';
import {
  normalizeEvidenceSnippetRecord,
  normalizeIdeaFragmentRecord,
  normalizeTakeawayRecord
} from '../graph/takeaways.js';
import { jaccardSimilarity, normalizeText, slugify, stableHash, unique } from '../../lib/utils.js';

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function resolveAvailableParallelism(options = {}) {
  const explicit = Number(options.availableParallelism);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  if (typeof os.availableParallelism === 'function') {
    return Math.max(1, os.availableParallelism());
  }

  return Math.max(1, os.cpus()?.length || 1);
}

function resolvePrecomputeConcurrency(options = {}) {
  const explicit = Number(firstDefinedValue(
    options.graphPrecomputeConcurrency,
    options.analyzeConcurrency,
    options.concurrency
  ));
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.floor(explicit));
  }

  return Math.max(1, Math.min(resolveAvailableParallelism(options), 4));
}

function createRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `rel:${stableHash(`${sourceId}:${type}:${targetId}:${JSON.stringify(properties)}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function uniqueTextList(values = []) {
  return unique(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function cleanSemanticName(text, fallback, maxLength = 140) {
  let normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9\u4e00-\u9fff]+/, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .trim();

  if (/^[\d\s.\-\[\]]+$/.test(normalized) || /^[\[\]A-Z'\s]+\?/.test(normalized)) {
    return fallback;
  }

  if (/^[\d.\-\s]+$/.test(normalized)) {
    return fallback;
  }

  if (/[^A-Za-z0-9\u4e00-\u9fff\s]{5,}/.test(normalized)) {
    normalized = normalized.replace(/[^A-Za-z0-9\u4e00-\u9fff\s]+/g, ' ').trim();
  }

  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function buildEvidenceProperties(record, paper, overrides = {}) {
  return {
    sourcePaperId: paper.paperId,
    sourcePaperTitle: paper.paperTitle,
    evidenceText: record.evidenceText || record.text || record.name || '',
    section: record.sectionHeading || record.section || '',
    sectionRole: record.sectionRole || record.role || '',
    confidence: record.confidence ?? 0.65,
    explicitOrInferred: record.explicitOrInferred || 'explicit',
    ...overrides
  };
}

function buildPaperScopedNodePayload(type, paper, seed, name, properties = {}) {
  return {
    id: `${type.toLowerCase()}:${stableHash(`${paper.paperId}:${seed}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      ...properties
    }
  };
}

function buildGlobalNodePayload(type, name, properties = {}) {
  const normalizedName = normalizeText(name);
  const node = {
    id: `${type.toLowerCase()}:${slugify(name)}:${stableHash(`${type}:${name}`)}`,
    type,
    name,
    properties: {
      layer: getNodeLayer(type),
      normalized: normalizedName,
      paperTitles: properties.paperTitle ? [properties.paperTitle] : [],
      aliases: uniqueTextList([...(properties.aliases || []), name]),
      mentionCount: 1,
      confidence: properties.confidence || 0.6
    }
  };

  if (properties.type) node.properties.type = properties.type;
  if (properties.category) node.properties.category = properties.category;
  if (typeof properties.higherIsBetter === 'boolean') node.properties.higherIsBetter = properties.higherIsBetter;
  if (properties.description) node.properties.description = properties.description;
  if (properties.text) node.properties.text = properties.text;
  if (properties.canonicalId) node.properties.canonicalId = properties.canonicalId;
  if (properties.normalizedName) node.properties.normalizedName = properties.normalizedName;
  if (properties.challengeType) node.properties.challengeType = properties.challengeType;
  if (properties.domainSpecificText) node.properties.domainSpecificText = properties.domainSpecificText;
  if (properties.domainAgnosticText) node.properties.domainAgnosticText = properties.domainAgnosticText;
  if (properties.abstractionLevel) node.properties.abstractionLevel = properties.abstractionLevel;
  if (properties.retrievalText) node.properties.retrievalText = properties.retrievalText;
  if (properties.analogyText) node.properties.analogyText = properties.analogyText;
  if (properties.bridgeRetrievalText) node.properties.bridgeRetrievalText = properties.bridgeRetrievalText;
  if (properties.relatedProblems?.length) node.properties.relatedProblems = properties.relatedProblems;
  if (properties.sourceDomains?.length) node.properties.sourceDomains = properties.sourceDomains;
  if (properties.targetDomain) node.properties.targetDomain = properties.targetDomain;
  if (properties.relatedChallenges?.length) node.properties.relatedChallenges = properties.relatedChallenges;
  if (properties.sourceTakeaways?.length) node.properties.sourceTakeaways = properties.sourceTakeaways;
  if (properties.addressesChallenges?.length) node.properties.addressesChallenges = properties.addressesChallenges;
  if (properties.fieldOfStudy) node.properties.fieldOfStudy = properties.fieldOfStudy;
  if (properties.fieldCandidates?.length) node.properties.fieldCandidates = properties.fieldCandidates;
  if (properties.domainTags?.length) node.properties.domainTags = properties.domainTags;
  if (properties.abstractMechanisms?.length) node.properties.abstractMechanisms = properties.abstractMechanisms;
  if (properties.abstractMechanismObjects?.length) node.properties.abstractMechanismObjects = properties.abstractMechanismObjects;
  if (typeof properties.brainstormEligible === 'boolean') node.properties.brainstormEligible = properties.brainstormEligible;
  if (typeof properties.brainstormScore === 'number') node.properties.brainstormScore = properties.brainstormScore;
  if (properties.brainstormTier) node.properties.brainstormTier = properties.brainstormTier;
  if (properties.admissionSource) node.properties.admissionSource = properties.admissionSource;
  if (properties.admissionReason) node.properties.admissionReason = properties.admissionReason;

  return node;
}

function createGlobalContribution(type, paper, record, paperRelationType, options = {}) {
  if (!record?.name) return null;

  const node = buildGlobalNodePayload(type, record.name, {
    paperTitle: paper.paperTitle,
    confidence: record.confidence,
    aliases: options.aliases || [],
    type: options.nodeType,
    category: options.category,
    higherIsBetter: options.higherIsBetter,
    description: options.description,
    text: options.text ?? record.text ?? record.name,
    canonicalId: options.canonicalId,
    normalizedName: options.normalizedName,
    challengeType: options.challengeType,
    abstractionLevel: options.abstractionLevel,
    domainSpecificText: options.domainSpecificText,
    domainAgnosticText: options.domainAgnosticText,
    retrievalText: options.retrievalText,
    analogyText: options.analogyText,
    fieldOfStudy: normalizeFieldOfStudy(record.fieldOfStudy, record.domainTags || []),
    fieldCandidates: normalizeDomainTags(record.fieldCandidates || []),
    domainTags: normalizeDomainTags(record.domainTags || []),
    abstractMechanismObjects: normalizeAbstractMechanismRecords(
      record.abstractMechanismObjects || record.abstractMechanisms || record.mechanismHints || []
    ),
    abstractMechanisms: normalizeAbstractMechanismNames(
      record.abstractMechanismObjects || record.abstractMechanisms || record.mechanismHints || []
    ),
    brainstormEligible: record.brainstormEligible,
    brainstormScore: record.brainstormScore,
    brainstormTier: record.brainstormTier,
    admissionSource: record.admissionSource,
    admissionReason: record.admissionReason,
    relatedProblems: options.relatedProblems,
    bridgeRetrievalText: options.bridgeRetrievalText,
    sourceDomains: options.sourceDomains,
    targetDomain: options.targetDomain,
    relatedChallenges: options.relatedChallenges,
    sourceTakeaways: options.sourceTakeaways,
    addressesChallenges: options.addressesChallenges
  });

  return {
    node,
    aliases: uniqueTextList([record.text, record.name, ...(options.aliases || [])]),
    paperRelationship: createRelationship(
      paper.paperId,
      node.id,
      paperRelationType,
      buildEvidenceProperties(record, paper, options.relationshipOverrides || {})
    )
  };
}

function createScopedContribution(node, paperRelationshipType, record, paper, aliases = [], extraRelationships = []) {
  return {
    node,
    aliases: uniqueTextList([record?.text, record?.name, ...aliases]),
    paperRelationship: createRelationship(
      paper.paperId,
      node.id,
      paperRelationshipType,
      buildEvidenceProperties(record, paper, {})
    ),
    extraRelationships
  };
}

function matchContributionNodesByNames(contributions = [], names = []) {
  const wanted = new Set(
    (names || [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
  );
  if (!wanted.size) return [];
  return contributions
    .filter((entry) => wanted.has(normalizeText(entry.node?.name || '')))
    .map((entry) => entry.node);
}

function createEvidenceSnippetContribution(paper, snippet, index, aliases = []) {
  const normalized = normalizeEvidenceSnippetRecord(snippet);
  if (!normalized) return null;

  const node = buildPaperScopedNodePayload(
    NODE_TYPES.EVIDENCE_SNIPPET,
    paper,
    `evidence-snippet:${index}`,
    cleanSemanticName(normalized.name, `${paper.paperTitle} evidence snippet`),
    {
      text: normalized.text,
      evidenceText: normalized.text,
      sectionHeading: normalized.sectionHeading,
      sectionRole: normalized.sectionRole,
      confidence: normalized.confidence,
      abstractMechanisms: normalized.supportsMechanisms
    }
  );

  return createScopedContribution(node, EDGE_TYPES.CONTAINS, normalized, paper, aliases);
}

export function precomputePaperGraphFragment(paper) {
  const paperDomainTags = normalizeDomainTags(paper.domainTags || []);
  const paperFieldCandidates = normalizeDomainTags(paper.fieldCandidates || []);
  const paperFieldOfStudy = normalizeFieldOfStudy(paper.fieldOfStudy, [
    ...paperDomainTags,
    ...paperFieldCandidates
  ]);
  const paperAbstractMechanismObjects = normalizeAbstractMechanismRecords(
    paper.abstractMechanismObjects || paper.abstractMechanisms || paper.mechanismHints || []
  );
  const paperAbstractMechanisms = normalizeAbstractMechanismNames(paperAbstractMechanismObjects);
  const paperNode = {
    id: paper.paperId,
    type: NODE_TYPES.PAPER,
    name: paper.paperTitle,
    properties: {
      layer: getNodeLayer(NODE_TYPES.PAPER),
      paperId: paper.paperId,
      paperTitle: paper.paperTitle,
      authors: paper.authors || [],
      abstract: paper.abstract || '',
      sourcePath: paper.sourcePath,
      sourceMarkdownPath: paper.sourceMarkdownPath,
      sourcePdfPath: paper.sourcePdfPath,
      sourceKind: paper.sourceKind,
      sourceFingerprint: paper.sourceFingerprint,
      fieldOfStudy: paperFieldOfStudy,
      fieldCandidates: paperFieldCandidates,
      domainTags: paperDomainTags,
      abstractMechanisms: paperAbstractMechanisms,
      abstractMechanismObjects: paperAbstractMechanismObjects
    }
  };

  const problems = paper.problems
    .map((problem) => createGlobalContribution(NODE_TYPES.PROBLEM, paper, problem, EDGE_TYPES.SOLVES))
    .filter(Boolean);
  const methods = paper.methods
    .map((method) => createGlobalContribution(NODE_TYPES.METHOD, paper, method, EDGE_TYPES.USES))
    .filter(Boolean);
  const datasets = paper.datasets
    .map((dataset) => createGlobalContribution(NODE_TYPES.DATASET, paper, dataset, EDGE_TYPES.EVALUATES_ON))
    .filter(Boolean);
  const benchmarks = (paper.benchmarks || [])
    .map((benchmark) => createGlobalContribution(NODE_TYPES.BENCHMARK, paper, benchmark, EDGE_TYPES.BENCHMARKED_ON))
    .filter(Boolean);
  const metrics = paper.metrics
    .map((metric) => createGlobalContribution(NODE_TYPES.METRIC, paper, metric, EDGE_TYPES.REPORTS, {
      higherIsBetter: metric.higherIsBetter
    }))
    .filter(Boolean);
  const limitations = paper.limitations
    .map((limitation) => createGlobalContribution(NODE_TYPES.LIMITATION, paper, limitation, EDGE_TYPES.HAS_LIMITATION, {
      nodeType: limitation.type,
      relationshipOverrides: { limitationType: limitation.type }
    }))
    .filter(Boolean);
  const assumptions = paper.assumptions
    .map((assumption) => createGlobalContribution(NODE_TYPES.ASSUMPTION, paper, assumption, EDGE_TYPES.ASSUMES, {
      nodeType: assumption.type,
      relationshipOverrides: { assumptionType: assumption.type }
    }))
    .filter(Boolean);
  const futureDirections = paper.futureDirections
    .map((futureDirection) => createGlobalContribution(NODE_TYPES.FUTURE_DIRECTION, paper, futureDirection, EDGE_TYPES.SUGGESTS_FUTURE))
    .filter(Boolean);
  const researchGoals = (paper.researchGoals || [])
    .map((researchGoal) => createGlobalContribution(NODE_TYPES.RESEARCH_GOAL, paper, researchGoal, EDGE_TYPES.LEADS_TO))
    .filter(Boolean);
  const researchQuestionRecords = normalizeResearchQuestionRecords(paper.researchQuestions || [], {
    fieldOfStudy: paperFieldOfStudy,
    domainTags: paperDomainTags
  });
  const researchQuestions = researchQuestionRecords
    .map((question) => createGlobalContribution(NODE_TYPES.RESEARCH_QUESTION, paper, question, EDGE_TYPES.CONTAINS, {
      text: question.domainSpecificText || question.name,
      description: question.domainSpecificText || question.name,
      fieldOfStudy: question.fieldOfStudy,
      domainTags: question.domainTags,
      abstractMechanisms: question.relatedMechanisms,
      canonicalId: question.canonicalId,
      normalizedName: question.normalizedName,
      relatedProblems: question.relatedProblems,
      domainSpecificText: question.domainSpecificText,
      domainAgnosticText: question.domainAgnosticText,
      retrievalText: question.retrievalText,
      analogyText: question.analogyText,
      aliases: unique([question.name, question.domainSpecificText, question.domainAgnosticText].filter(Boolean))
    }))
    .filter(Boolean);
  const challengeGroups = (paper.openChallenges || []).map((challenge) => {
    const variants = buildChallengeVariantRecords(challenge, {
      fieldOfStudy: paperFieldOfStudy,
      domainTags: paperDomainTags
    });
    const contributions = variants
      .map((variant) => createGlobalContribution(NODE_TYPES.CHALLENGE, paper, variant, EDGE_TYPES.CONTAINS, {
        text: variant.domainSpecificText || variant.name,
        category: variant.abstractionLevel,
        description: variant.domainAgnosticText || variant.domainSpecificText || variant.name,
        fieldOfStudy: variant.fieldOfStudy,
        domainTags: variant.domainTags,
        abstractMechanisms: variant.relatedMechanisms,
        canonicalId: variant.canonicalId,
        normalizedName: variant.normalizedName,
        abstractionLevel: variant.abstractionLevel,
        challengeType: variant.challengeType,
        domainSpecificText: variant.domainSpecificText,
        domainAgnosticText: variant.domainAgnosticText,
        retrievalText: variant.bridgeRetrievalText,
        bridgeRetrievalText: variant.bridgeRetrievalText,
        analogyText: variant.analogyText,
        aliases: unique([variant.name, variant.domainSpecificText, variant.domainAgnosticText].filter(Boolean))
      }))
      .filter(Boolean);
    return {
      record: challenge,
      variants,
      contributions
    };
  });
  const takeawayGroups = (paper.takeaways || [])
    .map((takeaway) => normalizeTakeawayRecord(takeaway, {
      fieldOfStudy: paperFieldOfStudy,
      sourceDomains: paperDomainTags
    }))
    .filter(Boolean)
    .map((takeaway) => ({
      record: takeaway,
      contribution: createGlobalContribution(NODE_TYPES.TAKEAWAY, paper, takeaway, EDGE_TYPES.HAS_TAKEAWAY, {
        text: takeaway.text,
        description: takeaway.text,
        fieldOfStudy: takeaway.sourceDomains[0] || paperFieldOfStudy,
        domainTags: takeaway.sourceDomains,
        sourceDomains: takeaway.sourceDomains,
        abstractMechanisms: takeaway.relatedMechanisms,
        relatedChallenges: takeaway.relatedChallenges,
        canonicalId: takeaway.canonicalId,
        normalizedName: takeaway.normalizedName,
        retrievalText: takeaway.retrievalText,
        analogyText: takeaway.analogyText,
        aliases: unique([takeaway.name, takeaway.text].filter(Boolean))
      })
    }))
    .filter((entry) => entry.contribution);
  const takeaways = takeawayGroups.map((entry) => entry.contribution);
  const ideaFragmentGroups = (paper.ideaFragments || [])
    .map((fragment) => normalizeIdeaFragmentRecord(fragment, {
      sourceDomains: paperDomainTags
    }))
    .filter(Boolean)
    .map((fragment) => ({
      record: fragment,
      contribution: createGlobalContribution(NODE_TYPES.IDEA_FRAGMENT, paper, fragment, EDGE_TYPES.CONTAINS, {
        text: fragment.text,
        description: fragment.text,
        fieldOfStudy: fragment.targetDomain || paperFieldOfStudy,
        domainTags: unique([fragment.targetDomain, ...fragment.sourceDomains].filter(Boolean)),
        sourceDomains: fragment.sourceDomains,
        targetDomain: fragment.targetDomain,
        abstractMechanisms: fragment.relatedMechanisms,
        sourceTakeaways: fragment.sourceTakeaways,
        addressesChallenges: fragment.addressesChallenges,
        canonicalId: fragment.canonicalId,
        normalizedName: fragment.normalizedName,
        retrievalText: fragment.retrievalText,
        analogyText: fragment.analogyText,
        aliases: unique([fragment.name, fragment.text].filter(Boolean))
      })
    }))
    .filter((entry) => entry.contribution);
  const ideaFragments = ideaFragmentGroups.map((entry) => entry.contribution);

  const datasetByName = new Map(datasets.map((entry) => [entry.node.name, entry.node]));
  const benchmarkByName = new Map(benchmarks.map((entry) => [entry.node.name, entry.node]));
  const metricByName = new Map(metrics.map((entry) => [entry.node.name, entry.node]));
  const assumptionNodes = assumptions.map((entry) => entry.node);
  const problemNodes = problems.map((entry) => entry.node);
  const methodNodes = methods.map((entry) => entry.node);
  const limitationNodes = limitations.map((entry) => entry.node);
  const futureDirectionNodes = futureDirections.map((entry) => entry.node);
  const researchQuestionNodes = researchQuestions.map((entry) => entry.node);
  const specificChallengeEntries = challengeGroups
    .flatMap((entry) => entry.contributions)
    .filter((entry) => entry.node.properties?.abstractionLevel === 'specific');
  const specificChallengeNodes = specificChallengeEntries.map((entry) => entry.node);

  const claimEntries = paper.claims.map((claim, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.CLAIM,
      paper,
      `claim:${index}`,
      cleanSemanticName(claim.text, `${paper.paperTitle} claim`),
      {
        text: claim.text,
        normalizedForm: claim.normalizedForm,
        claimType: claim.claimType,
        sectionHeading: claim.sectionHeading,
        sectionRole: claim.sectionRole,
        brainstormEligible: claim.brainstormEligible,
        brainstormScore: claim.brainstormScore,
        brainstormTier: claim.brainstormTier,
        admissionSource: claim.admissionSource,
        admissionReason: claim.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of claim.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const metricName of claim.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      if (normalizeText(claim.text || '').includes(normalizeText(benchmarkNode.name))) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.CLAIMS, claim, paper, [claim.name], extraRelationships);
  });

  const findingEntries = (paper.findings || []).map((finding, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.FINDING,
      paper,
      `finding:${index}`,
      cleanSemanticName(finding.text || finding.name, `${paper.paperTitle} finding`),
      {
        text: finding.text || finding.name,
        normalizedForm: finding.normalizedForm || normalizeText(finding.text || finding.name),
        findingType: finding.findingType,
        sectionHeading: finding.sectionHeading,
        sectionRole: finding.sectionRole,
        brainstormEligible: finding.brainstormEligible,
        brainstormScore: finding.brainstormScore,
        brainstormTier: finding.brainstormTier,
        admissionSource: finding.admissionSource,
        admissionReason: finding.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of finding.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const benchmarkName of finding.linkedBenchmarks || []) {
      const benchmarkNode = benchmarkByName.get(benchmarkName);
      if (benchmarkNode) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    for (const metricName of finding.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.REPORTS_FINDING, finding, paper, [finding.name], extraRelationships);
  });

  const evidenceEntries = paper.evidences.map((evidence, index) => {
    const node = buildPaperScopedNodePayload(
      NODE_TYPES.EVIDENCE,
      paper,
      `evidence:${index}`,
      cleanSemanticName(evidence.text, `${paper.paperTitle} evidence`),
      {
        text: evidence.text,
        section: evidence.section,
        sectionHeading: evidence.sectionHeading,
        sectionRole: evidence.sectionRole,
        confidence: evidence.confidence,
        brainstormEligible: evidence.brainstormEligible,
        brainstormScore: evidence.brainstormScore,
        brainstormTier: evidence.brainstormTier,
        admissionSource: evidence.admissionSource,
        admissionReason: evidence.admissionReason
      }
    );
    const extraRelationships = [];

    for (const datasetName of evidence.linkedDatasets || []) {
      const datasetNode = datasetByName.get(datasetName);
      if (datasetNode) {
        extraRelationships.push(createRelationship(node.id, datasetNode.id, EDGE_TYPES.OBSERVED_ON));
      }
    }

    for (const metricName of evidence.linkedMetrics || []) {
      const metricNode = metricByName.get(metricName);
      if (metricNode) {
        extraRelationships.push(createRelationship(node.id, metricNode.id, EDGE_TYPES.MEASURED_BY));
      }
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      if (normalizeText(evidence.text || '').includes(normalizeText(benchmarkNode.name))) {
        extraRelationships.push(createRelationship(node.id, benchmarkNode.id, EDGE_TYPES.BENCHMARKED_ON));
      }
    }

    return createScopedContribution(node, EDGE_TYPES.CONTAINS, evidence, paper, [evidence.name], extraRelationships);
  });

  const localRelationships = [];
  const claimNodes = claimEntries.map((entry) => entry.node);
  const findingNodes = findingEntries.map((entry) => entry.node);
  const evidenceNodes = evidenceEntries.map((entry) => entry.node);
  const relationBaseProperties = {
    sourcePaperId: paper.paperId,
    sourcePaperTitle: paper.paperTitle,
    relationSource: 'catalyst-metadata-v1'
  };

  const challengeGroupMatchKeys = challengeGroups.map((entry) => {
    const keys = new Set();
    const specificContribution = entry.contributions.find(
      (contribution) => contribution.node.properties?.abstractionLevel === 'specific'
    );
    const agnosticContribution = entry.contributions.find(
      (contribution) => contribution.node.properties?.abstractionLevel === 'agnostic'
    );
    for (const candidate of [
      entry.record?.name,
      entry.record?.domainSpecificText,
      entry.record?.domainAgnosticText,
      ...entry.variants.map((variant) => variant.name)
    ]) {
      const normalized = normalizeText(candidate);
      if (normalized) keys.add(normalized);
    }
    return {
      keys,
      specificNode: specificContribution?.node || null,
      agnosticNode: agnosticContribution?.node || null,
      allNodes: entry.contributions.map((contribution) => contribution.node)
    };
  });

  function resolveProblemNodesByNames(names = []) {
    const matched = matchContributionNodesByNames(problems, names);
    if (matched.length) return matched;
    return problemNodes.length === 1 ? problemNodes : [];
  }

  function resolveChallengeNodesByNames(names = [], preferredAbstractionLevel = 'specific') {
    const wanted = new Set(
      (names || [])
        .map((entry) => normalizeText(entry))
        .filter(Boolean)
    );
    if (!wanted.size) {
      return preferredAbstractionLevel === 'specific'
        ? specificChallengeNodes
        : challengeGroups.flatMap((entry) => entry.contributions).map((entry) => entry.node);
    }

    const matches = [];
    for (const group of challengeGroupMatchKeys) {
      const hit = [...group.keys].some((key) => wanted.has(key));
      if (!hit) continue;
      if (preferredAbstractionLevel === 'specific' && group.specificNode) {
        matches.push(group.specificNode);
        continue;
      }
      if (preferredAbstractionLevel === 'agnostic' && group.agnosticNode) {
        matches.push(group.agnosticNode);
        continue;
      }
      matches.push(...group.allNodes);
    }
    return unique(matches.map((node) => node?.id).filter(Boolean))
      .map((nodeId) => matches.find((node) => node.id === nodeId))
      .filter(Boolean);
  }

  function registerSupportingSnippets(ownerNode, snippets = [], ownerAliases = []) {
    const contributions = [];
    for (let index = 0; index < snippets.length; index += 1) {
      const snippet = snippets[index];
      const contribution = createEvidenceSnippetContribution(
        paper,
        snippet,
        `${ownerNode.id}:${index}`,
        ownerAliases
      );
      if (!contribution) continue;
      contributions.push(contribution);
      localRelationships.push(createRelationship(
        ownerNode.id,
        contribution.node.id,
        EDGE_TYPES.SUPPORTED_BY_SNIPPET,
        {
          ...relationBaseProperties,
          evidenceText: contribution.node.properties?.evidenceText || snippet.text || '',
          sectionHeading: contribution.node.properties?.sectionHeading || snippet.sectionHeading || '',
          sectionRole: contribution.node.properties?.sectionRole || snippet.sectionRole || '',
          confidence: contribution.node.properties?.confidence ?? snippet.confidence ?? 0.72
        }
      ));
    }
    return contributions;
  }

  for (const question of researchQuestions) {
    const sourceProblems = resolveProblemNodesByNames(question.node.properties?.relatedProblems || []);
    for (const problemNode of sourceProblems) {
      localRelationships.push(createRelationship(problemNode.id, question.node.id, EDGE_TYPES.DECOMPOSES_TO, {
        ...relationBaseProperties,
        evidenceText: question.node.properties?.domainSpecificText || question.node.name
      }));
    }
  }

  if (researchQuestionNodes.length && specificChallengeNodes.length) {
    for (const questionNode of researchQuestionNodes) {
      for (const challengeNode of specificChallengeNodes) {
        localRelationships.push(createRelationship(questionNode.id, challengeNode.id, EDGE_TYPES.HAS_OPEN_CHALLENGE, {
          ...relationBaseProperties,
          evidenceText: challengeNode.properties?.domainSpecificText || challengeNode.name
        }));
      }
    }
  }

  for (const group of challengeGroups) {
    const specificNode = group.contributions.find((entry) => entry.node.properties?.abstractionLevel === 'specific')?.node;
    const agnosticNode = group.contributions.find((entry) => entry.node.properties?.abstractionLevel === 'agnostic')?.node;
    if (specificNode && agnosticNode) {
      localRelationships.push(createRelationship(specificNode.id, agnosticNode.id, EDGE_TYPES.ABSTRACTS_TO, {
        ...relationBaseProperties,
        evidenceText: agnosticNode.properties?.domainAgnosticText || agnosticNode.name
      }));
    }
  }

  const evidenceSnippetEntries = [];
  for (const takeawayGroup of takeawayGroups) {
    const takeawayNode = takeawayGroup.contribution.node;
    localRelationships.push(takeawayGroup.contribution.paperRelationship);
    for (const challengeNode of resolveChallengeNodesByNames(takeawayGroup.record.relatedChallenges, 'specific')) {
      localRelationships.push(createRelationship(takeawayNode.id, challengeNode.id, EDGE_TYPES.ADDRESSES, {
        ...relationBaseProperties,
        evidenceText: takeawayGroup.record.text
      }));
    }
    evidenceSnippetEntries.push(
      ...registerSupportingSnippets(
        takeawayNode,
        takeawayGroup.record.supportingSnippets,
        [takeawayGroup.record.name, takeawayGroup.record.text]
      )
    );
  }

  for (const ideaFragmentGroup of ideaFragmentGroups) {
    const fragmentNode = ideaFragmentGroup.contribution.node;
    localRelationships.push(ideaFragmentGroup.contribution.paperRelationship);
    const sourceTakeawayNodes = matchContributionNodesByNames(takeaways, ideaFragmentGroup.record.sourceTakeaways);
    for (const takeawayNode of sourceTakeawayNodes) {
      localRelationships.push(createRelationship(takeawayNode.id, fragmentNode.id, EDGE_TYPES.RECONTEXTUALIZES_TO, {
        ...relationBaseProperties,
        evidenceText: ideaFragmentGroup.record.text
      }));
    }
    for (const challengeNode of resolveChallengeNodesByNames(ideaFragmentGroup.record.addressesChallenges, 'specific')) {
      localRelationships.push(createRelationship(fragmentNode.id, challengeNode.id, EDGE_TYPES.ADDRESSES, {
        ...relationBaseProperties,
        evidenceText: ideaFragmentGroup.record.text
      }));
    }
    evidenceSnippetEntries.push(
      ...registerSupportingSnippets(
        fragmentNode,
        ideaFragmentGroup.record.supportingSnippets,
        [ideaFragmentGroup.record.name, ideaFragmentGroup.record.text]
      )
    );
  }

  for (const claimNode of claimNodes) {
    for (const evidenceNode of evidenceNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, evidenceNode.properties.text || evidenceNode.name);
      if (similarity < 0.12) continue;
      localRelationships.push(createRelationship(claimNode.id, evidenceNode.id, EDGE_TYPES.SUPPORTED_BY, {
        score: Number(similarity.toFixed(3))
      }));
    }

    for (const findingNode of findingNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, findingNode.properties.text || findingNode.name);
      if (similarity < 0.14) continue;
      localRelationships.push(createRelationship(claimNode.id, findingNode.id, EDGE_TYPES.SUPPORTED_BY, {
        score: Number(similarity.toFixed(3)),
        relationSource: 'heuristic'
      }));
    }

    for (const assumptionNode of assumptionNodes) {
      const similarity = jaccardSimilarity(claimNode.properties.text || claimNode.name, assumptionNode.name);
      if (similarity < 0.08) continue;
      localRelationships.push(createRelationship(claimNode.id, assumptionNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationSource: 'heuristic'
      }));
    }
  }

  for (const findingNode of findingNodes) {
    for (const assumptionNode of assumptionNodes) {
      const similarity = jaccardSimilarity(findingNode.properties.text || findingNode.name, assumptionNode.name);
      if (similarity < 0.08) continue;
      localRelationships.push(createRelationship(findingNode.id, assumptionNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationSource: 'heuristic'
      }));
    }
  }

  for (const methodNode of methodNodes) {
    for (const problemNode of problemNodes) {
      localRelationships.push(createRelationship(methodNode.id, problemNode.id, EDGE_TYPES.APPLIES_TO, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const assumptionNode of assumptionNodes) {
      localRelationships.push(createRelationship(methodNode.id, assumptionNode.id, EDGE_TYPES.REQUIRES, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const datasetNode of datasetByName.values()) {
      localRelationships.push(createRelationship(methodNode.id, datasetNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        dependencyKind: 'dataset'
      }));
    }

    for (const benchmarkNode of benchmarkByName.values()) {
      localRelationships.push(createRelationship(methodNode.id, benchmarkNode.id, EDGE_TYPES.DEPENDS_ON, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        dependencyKind: 'benchmark'
      }));
    }
  }

  for (const problemNode of problemNodes) {
    for (const limitationNode of limitationNodes) {
      localRelationships.push(createRelationship(problemNode.id, limitationNode.id, EDGE_TYPES.HAS_GAP, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      }));
    }

    for (const futureDirectionNode of futureDirectionNodes) {
      localRelationships.push(createRelationship(futureDirectionNode.id, problemNode.id, EDGE_TYPES.RELATED_TO, {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle,
        relationKind: 'future-problem'
      }));
    }
  }

  for (let leftIndex = 0; leftIndex < methodNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < methodNodes.length; rightIndex += 1) {
      const leftNode = methodNodes[leftIndex];
      const rightNode = methodNodes[rightIndex];
      const baseProperties = {
        sourcePaperId: paper.paperId,
        sourcePaperTitle: paper.paperTitle
      };

      localRelationships.push(createRelationship(leftNode.id, rightNode.id, EDGE_TYPES.COMPATIBLE_WITH, baseProperties));
      localRelationships.push(createRelationship(rightNode.id, leftNode.id, EDGE_TYPES.COMPATIBLE_WITH, baseProperties));
      localRelationships.push(createRelationship(leftNode.id, rightNode.id, EDGE_TYPES.COMBINES_WITH, {
        ...baseProperties,
        relationSource: 'heuristic'
      }));
      localRelationships.push(createRelationship(rightNode.id, leftNode.id, EDGE_TYPES.COMBINES_WITH, {
        ...baseProperties,
        relationSource: 'heuristic'
      }));
    }
  }

  return {
    paperNode,
    globalContributions: [
      ...problems,
      ...methods,
      ...datasets,
      ...benchmarks,
      ...metrics,
      ...limitations,
      ...assumptions,
      ...futureDirections,
      ...researchGoals,
      ...researchQuestions,
      ...challengeGroups.flatMap((entry) => entry.contributions),
      ...takeaways,
      ...ideaFragments
    ],
    paperScopedContributions: [
      ...claimEntries,
      ...findingEntries,
      ...evidenceEntries,
      ...evidenceSnippetEntries
    ],
    localRelationships
  };
}

function runPrecomputeWorker(paper) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./graph-precompute.js', import.meta.url), {
      type: 'module',
      workerData: { paper }
    });

    let settled = false;

    worker.on('message', (message) => {
      if (settled) return;
      settled = true;
      if (message?.ok === false) {
        reject(new Error(message.error || 'Graph precompute worker failed.'));
        return;
      }
      resolve(message.fragment);
    });

    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        reject(new Error('Graph precompute worker exited without a result.'));
        return;
      }
      reject(new Error(`Graph precompute worker exited with code ${code}.`));
    });
  });
}

export async function precomputePaperGraphFragments(papers, options = {}) {
  if (!Array.isArray(papers) || !papers.length) return [];

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const concurrency = Math.min(resolvePrecomputeConcurrency(options), papers.length);
  if (concurrency <= 1 || papers.length <= 1) {
    return papers.map((paper, index) => {
      const fragment = precomputePaperGraphFragment(paper);
      onProgress?.({
        completed: index + 1,
        total: papers.length,
        paper
      });
      return fragment;
    });
  }

  const results = new Array(papers.length);
  let nextIndex = 0;
  let completed = 0;

  async function workerLoop() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= papers.length) {
        return;
      }

      const paper = papers[currentIndex];
      try {
        results[currentIndex] = await runPrecomputeWorker(paper);
      } catch {
        results[currentIndex] = precomputePaperGraphFragment(paper);
      }
      completed += 1;
      onProgress?.({
        completed,
        total: papers.length,
        paper
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  return results;
}

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage({
      ok: true,
      fragment: precomputePaperGraphFragment(workerData.paper)
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
