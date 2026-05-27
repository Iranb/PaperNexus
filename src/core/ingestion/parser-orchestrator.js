import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';
import { buildCitationIntentArtifact } from './citation-intent.js';
import { buildClaimExtractionArtifact } from './claim-extraction.js';
import { readCociCitationGraph } from './coci.js';
import { readGrobidTeiCitationContexts } from './grobid-tei.js';
import { readS2orcCitationContexts } from './s2orc.js';

export const PARSER_ORCHESTRATOR_CONTRACT_VERSION = 'papernexus-parser-orchestrator-v1';
export const INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION = 'papernexus-ingestion-graph-mutations-v1';
export const INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION = 'papernexus-ingestion-graph-apply-plan-v1';
export const COMBINED_CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-citation-contexts-v1';
export const MULTIMODAL_ASSETS_CONTRACT_VERSION = 'papernexus-multimodal-assets-v1';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function hasText(value = '') {
  return Boolean(compactText(value));
}

function artifactPath(outputDir, fileName) {
  return outputDir ? path.join(outputDir, fileName) : '';
}

async function sha256File(filePath = '') {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function inputRecordFromPath(role = '', filePath = '') {
  if (!hasText(role) || !hasText(filePath)) return null;
  const absolutePath = path.resolve(process.cwd(), filePath);
  return {
    role,
    path: absolutePath,
    sha256: await sha256File(absolutePath)
  };
}

function nodeOperation(id, type, name, properties = {}) {
  return {
    action: 'create_node',
    id: compactText(id, 240),
    type,
    name: compactText(name || id, 240),
    properties
  };
}

function edgeOperation(sourceId, targetId, type, properties = {}) {
  return {
    action: 'create_edge',
    sourceId: compactText(sourceId, 240),
    targetId: compactText(targetId, 240),
    edgeType: type,
    properties
  };
}

function dedupeOperations(operations = []) {
  const seen = new Set();
  const output = [];
  for (const operation of operations) {
    if (!operation || !operation.action) continue;
    const key = operation.action === 'create_node'
      ? `node:${operation.id}`
      : `edge:${operation.sourceId}:${operation.edgeType}:${operation.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(operation);
  }
  return output;
}

function normalizePaperList(artifact = {}) {
  if (Array.isArray(artifact.papers)) return artifact.papers;
  if (artifact.paper && typeof artifact.paper === 'object') return [artifact.paper];
  return [];
}

function normalizeReferenceList(artifact = {}) {
  return asArray(artifact.references);
}

function contextId(context = {}, index = 0) {
  const explicit = compactText(context.id || context.citationContextId || context.citation_context_id, 240);
  if (explicit) return explicit;
  return `citation-context:${stableHash([
    context.paperId || context.paper_id || '',
    context.referenceId || context.reference_id || '',
    context.citationRaw || context.citation_raw || '',
    context.exactQuote || context.exact_quote || '',
    index
  ].join(':'), 16)}`;
}

function normalizeContext(context = {}, index = 0, source = {}) {
  const id = contextId(context, index);
  return {
    ...asObject(context),
    id,
    citationContextId: id,
    contractVersion: COMBINED_CITATION_CONTEXTS_CONTRACT_VERSION,
    sourceProvider: compactText(context.sourceProvider || context.source_provider || source.sourceProvider || source.provider, 120),
    sourceArtifact: compactText(source.role || '', 120)
  };
}

export function combineCitationContextArtifacts(artifacts = [], options = {}) {
  const normalizedArtifacts = asArray(artifacts).filter((artifact) => artifact && typeof artifact === 'object');
  const contexts = [];
  const references = [];
  const papers = [];
  const sourceContracts = [];
  const warnings = [];

  for (const [artifactIndex, artifact] of normalizedArtifacts.entries()) {
    const role = compactText(artifact.orchestratorRole || artifact.adapterContractVersion || artifact.contractVersion || `artifact:${artifactIndex + 1}`, 180);
    sourceContracts.push({
      role,
      contractVersion: artifact.contractVersion || '',
      adapterContractVersion: artifact.adapterContractVersion || '',
      contextCount: asArray(artifact.contexts).length
    });
    papers.push(...normalizePaperList(artifact));
    references.push(...normalizeReferenceList(artifact).map((reference) => ({
      ...asObject(reference),
      sourceArtifact: role
    })));
    contexts.push(...asArray(artifact.contexts).map((context, index) => normalizeContext(context, contexts.length + index, {
      role,
      provider: context.sourceProvider || context.source_provider || artifact.source?.sourceProvider
    })));
  }

  const dedupedContexts = [...new Map(contexts.map((context) => [context.id, context])).values()];
  const dedupedReferences = [...new Map(references.map((reference, index) => [
    compactText(reference.id || reference.referenceId || reference.refId || reference.doi || reference.titleGuess || `reference:${index}`, 240),
    reference
  ])).values()];
  const dedupedPapers = [...new Map(papers.map((paper, index) => [
    compactText(paper.paperId || paper.paper_id || paper.id || paper.title || `paper:${index}`, 240),
    paper
  ])).values()];

  if (!dedupedContexts.length) {
    warnings.push({
      code: 'no_citation_contexts',
      message: 'No GROBID or S2ORC citation contexts were available for orchestration.'
    });
  }

  return {
    contractVersion: COMBINED_CITATION_CONTEXTS_CONTRACT_VERSION,
    orchestratorContractVersion: PARSER_ORCHESTRATOR_CONTRACT_VERSION,
    parserPolicy: {
      defaultCitationParser: 'grobid-tei',
      fallbackCitationParser: 's2orc',
      citationGraphSupplement: 'opencitations-coci'
    },
    paper: options.paper || dedupedPapers[0] || null,
    papers: dedupedPapers,
    references: dedupedReferences,
    contexts: dedupedContexts,
    diagnostics: {
      contextCount: dedupedContexts.length,
      referenceCount: dedupedReferences.length,
      paperCount: dedupedPapers.length,
      sourceContracts,
      warnings
    }
  };
}

function projectionNodeOperation(node = {}, source = '') {
  const id = compactText(node.id || node.nodeId, 240);
  if (!id) return null;
  return nodeOperation(id, node.type || node.nodeType, node.name || id, {
    ...asObject(node.properties),
    relationSource: source || node.properties?.relationSource || 'ingestion-orchestrator'
  });
}

function projectionEdgeOperation(edge = {}, source = '') {
  const sourceId = compactText(edge.sourceId || edge.source || edge.from, 240);
  const targetId = compactText(edge.targetId || edge.target || edge.to, 240);
  const type = edge.edgeType || edge.type || edge.relationType;
  if (!sourceId || !targetId || !type) return null;
  return edgeOperation(sourceId, targetId, type, {
    ...asObject(edge.properties),
    relationSource: source || edge.properties?.relationSource || 'ingestion-orchestrator'
  });
}

function normalizeAssetKind(value = '') {
  const normalized = compactText(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['fig', 'figure', 'image', 'picture', 'chart', 'plot', 'diagram'].includes(normalized)) return 'figure';
  if (['tbl', 'table'].includes(normalized)) return 'table';
  if (['formula', 'equation', 'math', 'latex'].includes(normalized)) return 'formula';
  return normalized || 'figure';
}

function edgeTypeForAsset(asset = {}, link = {}) {
  const explicit = link.edgeType || link.edge_type || asset.edgeType || asset.edge_type;
  if (explicit && Object.values(EDGE_TYPES).includes(explicit)) return explicit;
  const kind = normalizeAssetKind(link.assetType || link.asset_type || asset.assetType || asset.asset_type || asset.kind || asset.modality || asset.type);
  if (kind === 'table') return EDGE_TYPES.EXTRACTED_FROM_TABLE;
  if (kind === 'formula') return EDGE_TYPES.EXTRACTED_FROM_FORMULA;
  return EDGE_TYPES.EXTRACTED_FROM_FIGURE;
}

function collectAssetRecords(artifact = {}) {
  if (Array.isArray(artifact)) return artifact.map((asset) => asObject(asset));
  const object = asObject(artifact);
  return [
    ...asArray(object.assets || object.multimodal_assets || object.multimodalAssets),
    ...asArray(object.figures).map((asset) => ({ ...asObject(asset), asset_type: asset.asset_type || asset.assetType || 'figure' })),
    ...asArray(object.tables).map((asset) => ({ ...asObject(asset), asset_type: asset.asset_type || asset.assetType || 'table' })),
    ...asArray(object.formulas || object.equations).map((asset) => ({ ...asObject(asset), asset_type: asset.asset_type || asset.assetType || 'formula' }))
  ].map(asObject);
}

function assetIdFor(asset = {}, index = 0) {
  const explicit = compactText(asset.asset_id || asset.assetId || asset.id || asset.node_id || asset.nodeId, 240);
  if (explicit) return explicit.startsWith('asset:') ? explicit : `asset:${explicit}`;
  return `asset:${stableHash([
    asset.paper_id || asset.paperId || '',
    asset.asset_type || asset.assetType || asset.kind || asset.modality || asset.type || 'figure',
    asset.source_anchor || asset.sourceAnchor || '',
    asset.caption || asset.ocr_text || asset.ocrText || asset.text || '',
    index
  ].join(':'), 16)}`;
}

function assetLinks(asset = {}) {
  const directTargets = [
    ...asArray(asset.target_id || asset.targetId),
    ...asArray(asset.target_ids || asset.targetIds),
    ...asArray(asset.extracted_target_ids || asset.extractedTargetIds),
    ...asArray(asset.claim_ids || asset.claimIds),
    ...asArray(asset.citation_context_ids || asset.citationContextIds),
    ...asArray(asset.evidence_span_ids || asset.evidenceSpanIds),
    ...asArray(asset.source_span_ids || asset.sourceSpanIds)
  ].map((targetId) => ({ targetId }));
  const structured = asArray(asset.links || asset.extracted_from || asset.extractedFrom || asset.targets)
    .map((link) => {
      const object = asObject(link);
      const targetId = compactText(object.target_id || object.targetId || object.id || object.node_id || object.nodeId, 240);
      if (!targetId) return null;
      return { targetId, edgeType: object.edgeType || object.edge_type, role: object.role || object.target_role || object.targetRole };
    })
    .filter(Boolean);
  return [...directTargets, ...structured]
    .map((link) => ({
      ...link,
      targetId: compactText(link.targetId, 240)
    }))
    .filter((link) => link.targetId);
}

function buildMultimodalAssetOperations(artifact = {}, metadata = {}) {
  const assets = collectAssetRecords(artifact);
  const operations = [];
  const warnings = [];
  let linkCount = 0;
  for (const [index, asset] of assets.entries()) {
    const id = assetIdFor(asset, index);
    const kind = normalizeAssetKind(asset.asset_type || asset.assetType || asset.kind || asset.modality || asset.type);
    const links = assetLinks(asset);
    const evidenceHash = compactText(asset.evidence_hash || asset.evidenceHash || asset.sha256 || asset.source_hash || asset.sourceHash, 240);
    const explicitSourceAnchor = compactText(asset.source_anchor || asset.sourceAnchor || asset.anchor, 360);
    const fallbackSourceAnchor = compactText([
      asset.paper_id || asset.paperId || metadata.paperId || metadata.paper_id || '',
      asset.page || asset.page_number || asset.pageNumber || '',
      asset.figure_id || asset.figureId || asset.table_id || asset.tableId || asset.formula_id || asset.formulaId || id
    ].filter(Boolean).join('#'), 360);
    const sourceAnchor = explicitSourceAnchor || fallbackSourceAnchor;
    operations.push(nodeOperation(id, NODE_TYPES.MULTIMODAL_ASSET, asset.caption || asset.title || asset.name || id, {
      assetId: asset.asset_id || asset.assetId || asset.id || id,
      assetType: kind,
      modality: asset.modality || kind,
      paperId: asset.paper_id || asset.paperId || metadata.paperId || metadata.paper_id || null,
      paperTitle: asset.paper_title || asset.paperTitle || metadata.paperTitle || metadata.paper_title || '',
      page: asset.page ?? asset.page_number ?? asset.pageNumber ?? null,
      bbox: asset.bbox || asset.bounding_box || asset.boundingBox || null,
      caption: asset.caption || '',
      ocrText: asset.ocr_text || asset.ocrText || asset.text || '',
      sourceParser: asset.source_parser || asset.sourceParser || asset.parser || '',
      sourcePath: asset.source_path || asset.sourcePath || metadata.sourcePath || metadata.source_path || '',
      assetPath: asset.asset_path || asset.assetPath || asset.path || '',
      licenseScope: asset.license_scope || asset.licenseScope || artifact.license_scope || artifact.licenseScope || '',
      evidenceHash: evidenceHash || null,
      sourceAnchor: sourceAnchor || null,
      sourceAnchorProvenance: explicitSourceAnchor ? 'explicit' : (sourceAnchor ? 'derived' : 'missing'),
      relationSource: 'ingestion-orchestrator:multimodal-asset'
    }));
    if (!links.length) {
      warnings.push({
        code: 'unlinked_multimodal_asset',
        asset_id: id,
        message: 'Multimodal asset has no claim, citation-context, or evidence-span target ids.'
      });
      continue;
    }
    for (const link of links) {
      linkCount += 1;
      operations.push(edgeOperation(id, link.targetId, edgeTypeForAsset(asset, link), {
        role: link.role || 'multimodal_evidence',
        assetType: kind,
        sourceAnchor: sourceAnchor || null,
        evidenceHash: evidenceHash || null,
        relationSource: 'ingestion-orchestrator:multimodal-asset'
      }));
    }
  }
  return {
    operations,
    warnings,
    assetCount: assets.length,
    linkCount
  };
}

const MULTIMODAL_ASSET_EDGE_TYPES = new Set([
  EDGE_TYPES.EXTRACTED_FROM_FIGURE,
  EDGE_TYPES.EXTRACTED_FROM_TABLE,
  EDGE_TYPES.EXTRACTED_FROM_FORMULA
]);

function operationNodeType(operation = {}) {
  return compactText(operation.node?.type || operation.nodeType || operation.type, 120);
}

function operationNodeId(operation = {}) {
  return compactText(operation.node?.id || operation.id || operation.nodeId, 240);
}

function operationProperties(operation = {}) {
  return asObject(operation.node?.properties || operation.properties);
}

function operationSourceId(operation = {}) {
  return compactText(operation.relationship?.sourceId || operation.sourceId || operation.source || operation.from, 240);
}

function operationTargetId(operation = {}) {
  return compactText(operation.relationship?.targetId || operation.targetId || operation.target || operation.to, 240);
}

function operationEdgeType(operation = {}) {
  return compactText(operation.relationship?.type || operation.relationship?.edgeType || operation.edgeType || operation.type, 120);
}

function multimodalAssetAudit(graphMutations = {}) {
  const operations = asArray(graphMutations.operations);
  const assetNodes = operations.filter((operation) => (
    operation?.action === 'create_node'
    && operationNodeType(operation) === NODE_TYPES.MULTIMODAL_ASSET
    && operationNodeId(operation)
  ));
  const linksByAssetId = new Map();

  for (const operation of operations) {
    if (operation?.action !== 'create_edge') continue;
    const edgeType = operationEdgeType(operation);
    if (!MULTIMODAL_ASSET_EDGE_TYPES.has(edgeType)) continue;
    const sourceId = operationSourceId(operation);
    const targetId = operationTargetId(operation);
    if (!sourceId || !targetId) continue;
    const links = linksByAssetId.get(sourceId) || [];
    links.push({ edgeType, targetId });
    linksByAssetId.set(sourceId, links);
  }

  const invalidAssets = [];
  for (const assetNode of assetNodes) {
    const assetId = operationNodeId(assetNode);
    const properties = operationProperties(assetNode);
    const sourceAnchorProvenance = compactText(properties.sourceAnchorProvenance || properties.source_anchor_provenance, 80);
    const missing = [];
    if (!hasText(properties.licenseScope || properties.license_scope)) missing.push('license_scope');
    if (!hasText(properties.evidenceHash || properties.evidence_hash || properties.sha256)) missing.push('evidence_hash');
    if (!hasText(properties.sourceAnchor || properties.source_anchor) || sourceAnchorProvenance === 'derived') missing.push('source_anchor');
    if (!asArray(linksByAssetId.get(assetId)).length) missing.push('target_link');
    if (missing.length) {
      invalidAssets.push({
        asset_id: assetId,
        missing
      });
    }
  }

  return {
    assetCount: assetNodes.length,
    auditedAssetCount: assetNodes.length - invalidAssets.length,
    linkedAssetCount: assetNodes.filter((assetNode) => asArray(linksByAssetId.get(operationNodeId(assetNode))).length > 0).length,
    invalidAssetCount: invalidAssets.length,
    invalidAssets
  };
}

function citationContextNode(context = {}) {
  const id = compactText(context.id || context.citationContextId || context.citation_context_id, 240);
  if (!id) return null;
  return nodeOperation(id, NODE_TYPES.CITATION_CONTEXT, context.exactQuote || context.citationRaw || id, {
    paperId: context.paperId || context.paper_id || null,
    paperTitle: context.paperTitle || context.paper_title || '',
    referenceId: context.referenceId || context.reference_id || null,
    referenceTitleGuess: context.referenceTitleGuess || context.reference_title_guess || '',
    referenceYear: context.referenceYear ?? context.reference_year ?? null,
    citationRaw: context.citationRaw || context.citation_raw || '',
    exactQuote: context.exactQuote || context.exact_quote || '',
    sectionRole: context.sectionRole || context.section_role || '',
    sourceProvider: context.sourceProvider || context.source_provider || '',
    sourceArtifact: context.sourceArtifact || context.source_artifact || '',
    extractionStatus: context.extractionStatus || context.extraction_status || '',
    relationSource: 'ingestion-orchestrator:citation-context'
  });
}

function claimIntentEdges(claimArtifact = {}, citationIntentsArtifact = {}) {
  const intentsByContext = new Map(asArray(citationIntentsArtifact.intents).map((intent) => [intent.citationContextId, intent]));
  const contextIdsByClaim = new Map();
  for (const edge of asArray(claimArtifact.graph?.edges)) {
    if (edge.type !== EDGE_TYPES.SUPPORTED_BY && edge.edgeType !== EDGE_TYPES.SUPPORTED_BY) continue;
    const role = compactText(edge.properties?.role, 120);
    if (role !== 'citation_context') continue;
    const claimId = compactText(edge.sourceId || edge.source || edge.from, 240);
    const contextId = compactText(edge.targetId || edge.target || edge.to, 240);
    if (!claimId || !contextId) continue;
    contextIdsByClaim.set(claimId, unique([...(contextIdsByClaim.get(claimId) || []), contextId]));
  }
  const operations = [];
  for (const claim of asArray(claimArtifact.claims)) {
    const claimId = compactText(claim.id || claim.claim_id || claim.claimId, 240);
    if (!claimId) continue;
    const contextIds = unique([
      ...asArray(claim.citation_context_ids || claim.citationContextIds),
      ...(contextIdsByClaim.get(claimId) || [])
    ].map((entry) => compactText(entry, 240)).filter(Boolean));
    for (const contextId of contextIds) {
      const intent = intentsByContext.get(contextId);
      if (!intent) continue;
      operations.push(edgeOperation(contextId, claimId, EDGE_TYPES.HAS_CITATION_INTENT, {
        intentId: intent.id,
        intent: intent.intent,
        confidence: intent.confidence,
        graphEdgeType: intent.graphEdgeType,
        requiresHumanReview: intent.requiresHumanReview,
        relationSource: 'ingestion-orchestrator:citation-intent'
      }));
    }
  }
  return operations;
}

export function buildIngestionGraphMutations(input = {}, options = {}) {
  const citationContextsArtifact = asObject(input.citationContextsArtifact || input.citation_contexts_artifact);
  const citationIntentsArtifact = asObject(input.citationIntentsArtifact || input.citation_intents_artifact);
  const claimArtifact = asObject(input.claimExtractionArtifact || input.claim_extraction_artifact);
  const cociArtifact = asObject(input.cociCitationGraph || input.coci_citation_graph);
  const multimodalAssetsArtifact = input.multimodalAssetsArtifact || input.multimodal_assets_artifact;
  const operations = [];
  const warnings = [];

  for (const context of asArray(citationContextsArtifact.contexts)) {
    const operation = citationContextNode(context);
    if (operation) operations.push(operation);
  }

  for (const node of asArray(claimArtifact.graph?.nodes)) {
    const operation = projectionNodeOperation(node, 'ingestion-orchestrator:claim-extraction');
    if (operation) operations.push(operation);
  }
  for (const edge of asArray(claimArtifact.graph?.edges)) {
    const operation = projectionEdgeOperation(edge, 'ingestion-orchestrator:claim-extraction');
    if (operation) operations.push(operation);
  }

  for (const node of asArray(cociArtifact.graphProjection?.nodes)) {
    const operation = projectionNodeOperation(node, 'ingestion-orchestrator:coci');
    if (operation) operations.push(operation);
  }
  for (const relationship of asArray(cociArtifact.graphProjection?.relationships)) {
    const operation = projectionEdgeOperation(relationship, 'ingestion-orchestrator:coci');
    if (operation) operations.push(operation);
  }

  operations.push(...claimIntentEdges(claimArtifact, citationIntentsArtifact));
  const multimodalAssetOperations = buildMultimodalAssetOperations(multimodalAssetsArtifact, options.metadata || {});
  operations.push(...multimodalAssetOperations.operations);
  warnings.push(...multimodalAssetOperations.warnings);

  const deduped = dedupeOperations(operations);
  if (!deduped.length) {
    warnings.push({
      code: 'no_graph_mutation_operations',
      message: 'No graph mutation operations were produced from the available ingestion artifacts.'
    });
  }

  return {
    contractVersion: INGESTION_GRAPH_MUTATIONS_CONTRACT_VERSION,
    dryRun: options.dryRun !== false,
    writePolicy: options.writePolicy || 'preview_only',
    operations: deduped,
    diagnostics: {
      operationCount: deduped.length,
      nodeOperationCount: deduped.filter((operation) => operation.action === 'create_node').length,
      edgeOperationCount: deduped.filter((operation) => operation.action === 'create_edge').length,
      citationContextNodeCount: deduped.filter((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CITATION_CONTEXT).length,
      claimNodeCount: deduped.filter((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.CLAIM).length,
      multimodalAssetNodeCount: deduped.filter((operation) => operation.action === 'create_node' && operation.type === NODE_TYPES.MULTIMODAL_ASSET).length,
      multimodalAssetEdgeCount: deduped.filter((operation) => (
        operation.action === 'create_edge'
        && [EDGE_TYPES.EXTRACTED_FROM_FIGURE, EDGE_TYPES.EXTRACTED_FROM_TABLE, EDGE_TYPES.EXTRACTED_FROM_FORMULA].includes(operation.edgeType)
      )).length,
      cociCitationEdgeCount: deduped.filter((operation) => operation.action === 'create_edge' && operation.edgeType === EDGE_TYPES.CITES).length,
      warnings
    }
  };
}

function stage(status, extra = {}) {
  return { status, ...extra };
}

function releaseGateStatus(artifacts = {}) {
  const evaluations = [
    artifacts.citationIntents?.evaluation,
    artifacts.claimExtraction?.evaluation
  ].filter(Boolean);
  if (!evaluations.length) return 'incomplete';
  if (evaluations.some((evaluation) => evaluation.status === 'failed')) return 'failed';
  if (evaluations.every((evaluation) => evaluation.status === 'passed')) return 'passed';
  return 'incomplete';
}

function normalizeGraphApplyMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized) return 'preview';
  if (['0', 'false', 'no', 'off', 'disabled', 'none', 'preview', 'dry-run', 'dryrun'].includes(normalized)) return 'preview';
  if (['release', 'release-gated', 'gold-gated', 'benchmark-gated', 'apply-plan'].includes(normalized)) return 'release-gated';
  return normalized;
}

function evaluationGate(name, label, evaluation = null) {
  if (!evaluation) {
    return {
      name,
      label,
      status: 'incomplete',
      ok: false,
      message: 'missing benchmark evaluation'
    };
  }
  const status = evaluation.status === 'passed' ? 'passed' : evaluation.status === 'failed' ? 'failed' : 'incomplete';
  return {
    name,
    label,
    status,
    ok: status === 'passed',
    metrics: Object.fromEntries(Object.entries(evaluation).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean')),
    message: status === 'passed' ? '' : `benchmark evaluation is ${status}`
  };
}

export function buildIngestionGraphApplyPlan(input = {}, options = {}) {
  const graphMutations = asObject(input.graphMutations || input.graph_mutations);
  const artifacts = asObject(input.artifacts);
  const artifactPaths = asObject(input.artifactPaths || input.artifact_paths);
  const inputs = asArray(input.inputs || input.releaseEvidenceInputs || input.release_evidence_inputs);
  const operationCount = asArray(graphMutations.operations).length;
  const mode = normalizeGraphApplyMode(options.graphApplyMode || options.graph_apply_mode || options.applyMode || options.apply_mode);
  const releaseStatus = releaseGateStatus(artifacts);
  const assetAudit = multimodalAssetAudit(graphMutations);
  const assetAuditPassed = assetAudit.assetCount > 0 && assetAudit.invalidAssetCount === 0;
  const gates = [
    {
      name: 'graph_mutations_present',
      label: 'Graph mutation operations were generated',
      status: operationCount > 0 ? 'passed' : 'incomplete',
      ok: operationCount > 0,
      metrics: { operation_count: operationCount },
      message: operationCount > 0 ? '' : 'missing graph mutation operations'
    },
    {
      name: 'multimodal_asset_audit_complete',
      label: 'Multimodal asset license, evidence hash, source anchor, and graph links are complete',
      status: assetAuditPassed ? 'passed' : 'incomplete',
      ok: assetAuditPassed,
      metrics: {
        asset_count: assetAudit.assetCount,
        audited_asset_count: assetAudit.auditedAssetCount,
        linked_asset_count: assetAudit.linkedAssetCount,
        invalid_asset_count: assetAudit.invalidAssetCount
      },
      invalidAssets: assetAudit.invalidAssets.slice(0, 20),
      message: assetAuditPassed
        ? (assetAudit.assetCount ? '' : 'no multimodal assets present')
        : 'one or more multimodal assets are missing license scope, evidence hash, source anchor, or target graph links'
    },
    evaluationGate(
      'citation_intent_benchmark_passed',
      'Citation-intent benchmark gate passed',
      artifacts.citationIntents?.evaluation
    ),
    evaluationGate(
      'claim_extraction_benchmark_passed',
      'Claim extraction benchmark gate passed',
      artifacts.claimExtraction?.evaluation
    ),
    {
      name: 'explicit_release_gated_apply_requested',
      label: 'Operator explicitly requested a release-gated apply plan',
      status: mode === 'release-gated' ? 'passed' : 'incomplete',
      ok: mode === 'release-gated',
      message: mode === 'release-gated' ? '' : 'graph apply mode is preview'
    }
  ];
  const blockingReasons = gates
    .filter((gateEntry) => gateEntry.status !== 'passed')
    .map((gateEntry) => ({
      code: gateEntry.name,
      status: gateEntry.status,
      message: gateEntry.message || gateEntry.label
    }));
  const failed = gates.some((gateEntry) => gateEntry.status === 'failed') || releaseStatus === 'failed';
  const canApply = !failed && mode === 'release-gated' && gates.every((gateEntry) => gateEntry.status === 'passed');
  const status = canApply ? 'ready_to_apply' : (failed ? 'blocked' : (mode === 'release-gated' ? 'blocked' : 'preview_only'));
  const generatedAt = options.generatedAt || options.generated_at || new Date().toISOString();
  return {
    contractVersion: INGESTION_GRAPH_APPLY_PLAN_CONTRACT_VERSION,
    generatedAt,
    mode,
    status,
    canApply,
    dryRun: true,
    writePolicy: canApply ? 'release-gated-apply' : 'preview-only',
    releaseGateStatus: releaseStatus,
    operationCount,
    operationArtifactPath: artifactPaths.graphMutations || null,
    inputs,
    multimodalAssetAudit: assetAudit,
    gates,
    blockingReasons,
    applyInstructions: {
      tool: 'mutate_graph',
      operationArtifactPath: artifactPaths.graphMutations || null,
      operationCount,
      requiredOperatorAction: canApply
        ? 'Review graph-mutations.json, then apply through mutate_graph or an equivalent graph mutation executor.'
        : 'Do not apply. Resolve blocking gates and rerun with graphApplyMode=release-gated.'
    },
    safety: {
      defaultBehavior: 'preview-only',
      authoritativeGraphWritePerformed: false,
      reason: canApply
        ? 'All benchmark gates passed and release-gated apply was explicitly requested.'
        : 'Graph writes remain disabled until benchmark gates pass and release-gated apply is explicitly requested.'
    }
  };
}

function pipelineStatus(graphMutations = {}, artifacts = {}) {
  const releaseStatus = releaseGateStatus(artifacts);
  if (releaseStatus === 'failed') return 'failed';
  if (!asArray(graphMutations.operations).length) return 'incomplete';
  return 'ready';
}

async function maybeWriteJson(filePath, payload) {
  if (!filePath || payload === undefined || payload === null) return '';
  await writeJson(filePath, payload);
  return filePath;
}

export async function runParserOrchestrator(options = {}) {
  const outputDir = compactText(options.outputDir || options.output_dir, 1000);
  if (outputDir) await ensureDir(outputDir);

  const stages = {};
  const artifacts = {};
  const artifactPaths = {};
  const warnings = [];
  const metadata = {
    paperId: options.paperId || options.paper_id,
    paperTitle: options.paperTitle || options.paper_title,
    sourceKey: options.sourceKey || options.source_key,
    sourcePath: options.sourcePath || options.source_path,
    sourcePdfPath: options.sourcePdfPath || options.source_pdf_path
  };

  if (hasText(options.teiPath || options.tei_path)) {
    artifacts.grobid = await readGrobidTeiCitationContexts(options.teiPath || options.tei_path, metadata);
    artifacts.grobid.orchestratorRole = 'grobid-tei';
    artifactPaths.grobid = await maybeWriteJson(artifactPath(outputDir, 'grobid-citation-contexts.json'), artifacts.grobid);
    stages.grobid = stage('completed', { contextCount: artifacts.grobid.contexts.length });
  } else {
    stages.grobid = stage('skipped', { reason: 'no_tei_path' });
  }

  if (hasText(options.s2orcPath || options.s2orc_path)) {
    artifacts.s2orc = await readS2orcCitationContexts(options.s2orcPath || options.s2orc_path, {
      sourceKey: options.s2orcSourceKey || options.s2orc_source_key || metadata.sourceKey,
      maxPapers: options.maxS2orcPapers ?? options.max_s2orc_papers
    });
    artifacts.s2orc.orchestratorRole = 's2orc';
    artifactPaths.s2orc = await maybeWriteJson(artifactPath(outputDir, 's2orc-citation-contexts.json'), artifacts.s2orc);
    stages.s2orc = stage('completed', { contextCount: artifacts.s2orc.contexts.length });
  } else {
    stages.s2orc = stage('skipped', { reason: 'no_s2orc_path' });
  }

  artifacts.citationContexts = combineCitationContextArtifacts([
    artifacts.grobid,
    artifacts.s2orc
  ].filter(Boolean));
  artifactPaths.citationContexts = await maybeWriteJson(artifactPath(outputDir, 'citation-contexts.json'), artifacts.citationContexts);
  stages.citationContexts = stage(
    artifacts.citationContexts.contexts.length ? 'completed' : 'incomplete',
    { contextCount: artifacts.citationContexts.contexts.length }
  );

  if (artifacts.citationContexts.contexts.length) {
    const citationIntentGoldPath = options.citationIntentGoldPath || options.citation_intent_gold_path;
    const citationIntentGold = hasText(citationIntentGoldPath)
      ? await readJson(citationIntentGoldPath)
      : options.citationIntentGold;
    if (!hasText(citationIntentGoldPath) && citationIntentGold) {
      artifactPaths.citationIntentGold = await maybeWriteJson(artifactPath(outputDir, 'citation-intent-gold.json'), citationIntentGold);
    }
    artifacts.citationIntents = buildCitationIntentArtifact(artifacts.citationContexts, {
      gold: citationIntentGold,
      minAccuracy: options.minCitationIntentAccuracy ?? options.min_citation_intent_accuracy,
      minMacroF1: options.minCitationIntentMacroF1 ?? options.min_citation_intent_macro_f1,
      lowConfidenceThreshold: options.lowConfidenceThreshold ?? options.low_confidence_threshold
    });
    artifactPaths.citationIntents = await maybeWriteJson(artifactPath(outputDir, 'citation-intents.json'), artifacts.citationIntents);
    stages.citationIntents = stage('completed', {
      intentCount: artifacts.citationIntents.intents.length,
      evaluationStatus: artifacts.citationIntents.evaluation?.status || null
    });
  } else {
    stages.citationIntents = stage('skipped', { reason: 'no_citation_contexts' });
  }

  if (hasText(options.paperPath || options.paper_path)) {
    const paperInput = await readJson(options.paperPath || options.paper_path);
    const claimGoldPath = options.claimGoldPath || options.claim_gold_path;
    const claimGold = hasText(claimGoldPath)
      ? await readJson(claimGoldPath)
      : options.claimGold;
    if (!hasText(claimGoldPath) && claimGold) {
      artifactPaths.claimGold = await maybeWriteJson(artifactPath(outputDir, 'claim-extraction-gold.json'), claimGold);
    }
    artifacts.claimExtraction = buildClaimExtractionArtifact(paperInput, {
      citationContextsArtifact: artifacts.citationContexts,
      citationIntentsArtifact: artifacts.citationIntents,
      gold: claimGold,
      maxClaims: options.maxClaims ?? options.max_claims,
      matchThreshold: options.matchThreshold ?? options.match_threshold,
      minClaimRecall: options.minClaimRecall ?? options.min_claim_recall,
      minSourceSpanCompleteness: options.minSourceSpanCompleteness ?? options.min_source_span_completeness,
      minTypeAccuracy: options.minTypeAccuracy ?? options.min_type_accuracy
    });
    artifactPaths.claimExtraction = await maybeWriteJson(artifactPath(outputDir, 'claims.json'), artifacts.claimExtraction);
    stages.claimExtraction = stage('completed', {
      claimCount: artifacts.claimExtraction.claims.length,
      evaluationStatus: artifacts.claimExtraction.evaluation?.status || null
    });
  } else {
    stages.claimExtraction = stage('skipped', { reason: 'no_paper_path' });
  }

  if (hasText(options.cociPath || options.coci_path)) {
    artifacts.coci = await readCociCitationGraph(options.cociPath || options.coci_path, {
      sourceKey: options.cociSourceKey || options.coci_source_key || metadata.sourceKey,
      sourceFormat: options.cociFormat || options.coci_format,
      maxRecords: options.maxCociRecords ?? options.max_coci_records
    });
    artifactPaths.coci = await maybeWriteJson(artifactPath(outputDir, 'coci-citation-graph.json'), artifacts.coci);
    stages.coci = stage('completed', { edgeCount: artifacts.coci.citationEdges.length });
  } else {
    stages.coci = stage('skipped', { reason: 'no_coci_path' });
  }

  if (hasText(options.multimodalAssetsPath || options.multimodal_assets_path)) {
    artifacts.multimodalAssets = await readJson(options.multimodalAssetsPath || options.multimodal_assets_path);
    artifacts.multimodalAssets.contractVersion = artifacts.multimodalAssets.contractVersion || MULTIMODAL_ASSETS_CONTRACT_VERSION;
    artifactPaths.multimodalAssets = await maybeWriteJson(artifactPath(outputDir, 'multimodal-assets.json'), artifacts.multimodalAssets);
    stages.multimodalAssets = stage('completed', { assetCount: collectAssetRecords(artifacts.multimodalAssets).length });
  } else if (options.multimodalAssets || options.multimodal_assets) {
    artifacts.multimodalAssets = {
      contractVersion: MULTIMODAL_ASSETS_CONTRACT_VERSION,
      ...(Array.isArray(options.multimodalAssets || options.multimodal_assets)
        ? { assets: options.multimodalAssets || options.multimodal_assets }
        : asObject(options.multimodalAssets || options.multimodal_assets))
    };
    artifactPaths.multimodalAssets = await maybeWriteJson(artifactPath(outputDir, 'multimodal-assets.json'), artifacts.multimodalAssets);
    stages.multimodalAssets = stage('completed', { assetCount: collectAssetRecords(artifacts.multimodalAssets).length });
  } else {
    stages.multimodalAssets = stage('skipped', { reason: 'no_multimodal_assets_path' });
  }

  artifacts.graphMutations = buildIngestionGraphMutations({
    citationContextsArtifact: artifacts.citationContexts,
    citationIntentsArtifact: artifacts.citationIntents,
    claimExtractionArtifact: artifacts.claimExtraction,
    cociCitationGraph: artifacts.coci,
    multimodalAssetsArtifact: artifacts.multimodalAssets
  }, {
    metadata
  });
  artifactPaths.graphMutations = await maybeWriteJson(artifactPath(outputDir, 'graph-mutations.json'), artifacts.graphMutations);
  stages.graphMutations = stage(
    artifacts.graphMutations.operations.length ? 'completed' : 'incomplete',
    { operationCount: artifacts.graphMutations.operations.length }
  );

  const releaseEvidenceInputs = (await Promise.all([
    inputRecordFromPath('paper_source', options.paperPath || options.paper_path),
    inputRecordFromPath('grobid_tei', options.teiPath || options.tei_path || options.grobidTeiPath || options.grobid_tei_path),
    inputRecordFromPath('s2orc_citation_contexts', options.s2orcPath || options.s2orc_path),
    inputRecordFromPath('coci_citation_graph', options.cociPath || options.coci_path),
    inputRecordFromPath('citation_intent_gold_labels', options.citationIntentGoldPath || options.citation_intent_gold_path || artifactPaths.citationIntentGold),
    inputRecordFromPath('claim_extraction_gold_labels', options.claimGoldPath || options.claim_gold_path || artifactPaths.claimGold),
    inputRecordFromPath('multimodal_assets', options.multimodalAssetsPath || options.multimodal_assets_path || artifactPaths.multimodalAssets)
  ])).filter(Boolean);

  artifacts.graphApplyPlan = buildIngestionGraphApplyPlan({
    graphMutations: artifacts.graphMutations,
    artifacts,
    artifactPaths,
    inputs: releaseEvidenceInputs
  }, {
    graphApplyMode: options.graphApplyMode || options.graph_apply_mode,
    generatedAt: options.generatedAt || options.generated_at
  });
  artifactPaths.graphApplyPlan = await maybeWriteJson(artifactPath(outputDir, 'graph-apply-plan.json'), artifacts.graphApplyPlan);
  stages.graphApplyPlan = stage('completed', {
    status: artifacts.graphApplyPlan.status,
    canApply: artifacts.graphApplyPlan.canApply,
    mode: artifacts.graphApplyPlan.mode
  });

  if (stages.citationContexts.status === 'incomplete') warnings.push(...artifacts.citationContexts.diagnostics.warnings);
  if (!hasText(options.paperPath || options.paper_path)) warnings.push({ code: 'no_paper_path', message: 'Claim extraction was skipped because no parsed paper JSON was provided.' });
  if (!hasText(options.cociPath || options.coci_path)) warnings.push({ code: 'no_coci_path', message: 'COCI/OpenCitations citation graph supplement was skipped.' });

  const manifest = {
    contractVersion: PARSER_ORCHESTRATOR_CONTRACT_VERSION,
    status: pipelineStatus(artifacts.graphMutations, artifacts),
    releaseGateStatus: releaseGateStatus(artifacts),
    generatedAt: new Date().toISOString(),
    parserPolicy: artifacts.citationContexts.parserPolicy,
    graphApplyPlan: {
      status: artifacts.graphApplyPlan.status,
      mode: artifacts.graphApplyPlan.mode,
      canApply: artifacts.graphApplyPlan.canApply,
      writePolicy: artifacts.graphApplyPlan.writePolicy,
      blockingReasons: artifacts.graphApplyPlan.blockingReasons
    },
    stages,
    artifacts: artifactPaths,
    diagnostics: {
      warningCount: warnings.length,
      warnings,
      citationContextCount: artifacts.citationContexts.contexts.length,
      citationIntentCount: artifacts.citationIntents?.intents.length || 0,
      claimCount: artifacts.claimExtraction?.claims.length || 0,
      multimodalAssetCount: collectAssetRecords(artifacts.multimodalAssets).length,
      multimodalAssetEdgeCount: artifacts.graphMutations.diagnostics.multimodalAssetEdgeCount,
      cociCitationEdgeCount: artifacts.coci?.citationEdges.length || 0,
      graphMutationOperationCount: artifacts.graphMutations.operations.length,
      graphApplyPlanStatus: artifacts.graphApplyPlan.status,
      graphApplyCanApply: artifacts.graphApplyPlan.canApply
    }
  };
  artifactPaths.manifest = await maybeWriteJson(artifactPath(outputDir, 'ingestion-orchestrator-manifest.json'), manifest);
  manifest.artifacts = artifactPaths;

  return {
    manifest,
    artifacts
  };
}
