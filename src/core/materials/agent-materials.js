import path from 'node:path';

import { ensureDir, fileExists, readText, writeJson, writeText } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { searchGraph } from '../search/search.js';
import { loadChunkText, loadPaperChunks } from '../../storage/chunk-store.js';
import {
  loadCorpusLite,
  loadCorpusMeta,
  loadSourceManifest,
  resolveCorpus
} from '../../storage/corpus-store.js';
import { NODE_TYPES } from '../graph/schema.js';

export const AGENT_MATERIALS_CONTRACT_VERSION = 'papernexus-agent-materials-v1';

const DEFAULT_ROLES = [
  'target_prior',
  'near_source_method',
  'far_source_story',
  'novelty_risk',
  'baseline_candidate'
];

const ROLE_PURPOSES = {
  target_prior: 'Check target-domain coverage and closest prior work.',
  near_source_method: 'Find adjacent methods that may transfer into the target problem.',
  far_source_story: 'Find distant mechanisms, stories, or analogies for reframing.',
  novelty_risk: 'Surface prior work, limitations, and assumptions that may weaken novelty.',
  baseline_candidate: 'Collect baselines, datasets, benchmarks, and evaluation anchors.',
  negative_evidence: 'Record searched areas that did not produce direct matches.'
};

function nowIso() {
  return new Date().toISOString();
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function normalizeRoles(value) {
  const roles = asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map((entry) => compactText(entry).toLowerCase().replace(/[-\s]+/g, '_'))
    .filter(Boolean);
  return roles.length ? unique(roles) : DEFAULT_ROLES;
}

function normalizeConstraints(value) {
  return asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map(compactText)
    .filter(Boolean);
}

function boundedInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sourceKind(entry = {}) {
  return compactText(entry.kind || entry.sourceKind || entry.source_kind).toLowerCase();
}

function isMarkdownSource(entry = {}) {
  const kind = sourceKind(entry);
  const source = compactText(entry.sourcePath || entry.inputPath || entry.source || '');
  return kind.includes('markdown') || /\.m(?:d|arkdown)$/i.test(source);
}

function isPdfSource(entry = {}) {
  const kind = sourceKind(entry);
  const source = compactText(entry.sourcePath || entry.inputPath || entry.source || '');
  return kind.includes('pdf') || /\.pdf$/i.test(source);
}

function paperTitleFromEntry(entry = {}) {
  return compactText(entry.paperTitle || entry.paper_title || entry.title || entry.name);
}

function paperIdFromEntry(entry = {}) {
  return compactText(entry.paperId || entry.paper_id);
}

function sourceKeyFromEntry(entry = {}) {
  return compactText(entry.sourceKey || entry.source_key || entry.canonicalSourceKey || entry.canonical_source_key);
}

function normalizeTitle(value = '') {
  return compactText(value).toLowerCase();
}

function identifiersOf(entry = {}) {
  const identifiers = entry.identifiers && typeof entry.identifiers === 'object' ? entry.identifiers : {};
  return {
    ...identifiers,
    ...(entry.doi ? { doi: entry.doi } : {}),
    ...(entry.arxivId ? { arxivId: entry.arxivId } : {}),
    ...(entry.pmid ? { pmid: entry.pmid } : {}),
    ...(entry.pmcid ? { pmcid: entry.pmcid } : {})
  };
}

function sourceMatchesSelector(entry = {}, selector = {}) {
  const paperId = compactText(selector.paperId || selector.paper_id);
  const sourceKey = compactText(selector.sourceKey || selector.source_key);
  const title = normalizeTitle(selector.paperTitle || selector.title || selector.query);
  const identifier = compactText(selector.identifier || selector.doi || selector.arxivId || selector.pmid || selector.pmcid);
  const identifiers = identifiersOf(entry);

  if (paperId && paperIdFromEntry(entry) === paperId) return true;
  if (sourceKey && sourceKeyFromEntry(entry) === sourceKey) return true;
  if (title && normalizeTitle(paperTitleFromEntry(entry)) === title) return true;
  if (identifier) {
    const values = Object.values(identifiers).map((value) => compactText(value).toLowerCase()).filter(Boolean);
    if (values.includes(identifier.toLowerCase())) return true;
  }
  return false;
}

function graphPaperNodeMatches(node = {}, selector = {}) {
  const props = node.properties || {};
  const paperId = compactText(selector.paperId || selector.paper_id);
  const title = normalizeTitle(selector.paperTitle || selector.title || selector.query);
  if (node.type !== NODE_TYPES.PAPER) return false;
  if (paperId && (node.id === paperId || props.paperId === paperId)) return true;
  if (title && normalizeTitle(node.name || props.paperTitle) === title) return true;
  return false;
}

function findPaperNode(graph, selector = {}) {
  const paperId = compactText(selector.paperId || selector.paper_id);
  if (paperId && typeof graph?.getNode === 'function') {
    const direct = graph.getNode(paperId);
    if (direct) return direct;
  }
  return (typeof graph?.getNodesByType === 'function' ? graph.getNodesByType(NODE_TYPES.PAPER) : [])
    .find((node) => graphPaperNodeMatches(node, selector)) || null;
}

function findSourceEntries(manifest = {}, selector = {}) {
  const sources = Array.isArray(manifest?.sources) ? manifest.sources : [];
  const matched = sources.filter((entry) => sourceMatchesSelector(entry, selector));
  if (matched.length) return matched;

  const paperId = compactText(selector.paperId || selector.paper_id);
  const title = normalizeTitle(selector.paperTitle || selector.title || selector.query);
  return sources.filter((entry) => {
    if (paperId && paperIdFromEntry(entry) === paperId) return true;
    return title && normalizeTitle(paperTitleFromEntry(entry)).includes(title);
  });
}

async function firstReadablePath(rootPath, entry = {}) {
  const candidates = [
    entry.sourcePath,
    entry.source_path,
    entry.inputPath,
    entry.input_path,
    entry.path
  ].map(compactText).filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(rootPath, candidate);
    if (await fileExists(resolved)) return resolved;
  }
  return '';
}

function buildAvailability(entries = [], paperNode = null, chunks = []) {
  return {
    abstract: Boolean(
      paperNode?.properties?.abstract
      || entries.some((entry) => compactText(entry.abstract || entry.summary))
    ),
    markdown: entries.some(isMarkdownSource),
    pdf: entries.some(isPdfSource),
    graph_context: Boolean(paperNode),
    chunks: chunks.length > 0,
    source: entries.length > 0
  };
}

function materialStatus(availability = {}, entries = []) {
  if (availability.graph_context) return 'in_graph';
  if (entries.some((entry) => entry.import?.status === 'submitted')) return 'submitted_import';
  if (availability.markdown || availability.pdf || availability.source) return 'resolved_source';
  return 'material_unavailable';
}

function graphContextForPaper(graph, paperNode = null, limit = 12) {
  if (!graph || !paperNode) return [];
  const relationships = [
    ...(typeof graph.getOutgoing === 'function' ? graph.getOutgoing(paperNode.id) : []),
    ...(typeof graph.getIncoming === 'function' ? graph.getIncoming(paperNode.id) : [])
  ];
  return relationships.slice(0, limit).map((relationship) => {
    const neighborId = relationship.sourceId === paperNode.id ? relationship.targetId : relationship.sourceId;
    const neighbor = typeof graph.getNode === 'function' ? graph.getNode(neighborId) : null;
    return {
      relationship_id: relationship.id,
      relationship_type: relationship.type,
      direction: relationship.sourceId === paperNode.id ? 'outgoing' : 'incoming',
      node_id: neighbor?.id || neighborId,
      node_type: neighbor?.type || null,
      node_name: neighbor?.name || null,
      provenance: relationship.properties?.sourceSpanId || relationship.properties?.spanId || null
    };
  });
}

async function collectChunks(rootPath, entries = [], limit = 8) {
  const chunks = [];
  for (const entry of entries) {
    const sourceKey = sourceKeyFromEntry(entry);
    if (!sourceKey) continue;
    const record = await loadPaperChunks(rootPath, sourceKey);
    for (const chunk of record?.chunks || []) {
      if (chunks.length >= limit) return chunks;
      const text = await loadChunkText(chunk).catch(() => '');
      chunks.push({
        chunk_id: chunk.chunkId,
        source_key: chunk.sourceKey,
        section_id: chunk.sectionId,
        section_heading: chunk.sectionHeading,
        section_role: chunk.sectionRole,
        section_order: chunk.sectionOrder,
        chunk_order: chunk.chunkOrder,
        token_estimate: chunk.tokenEstimate,
        text: truncate(text, 900),
        provenance: {
          text_path: chunk.textPath || null,
          char_start: chunk.charStart ?? null,
          char_end: chunk.charEnd ?? null
        }
      });
    }
  }
  return chunks;
}

async function sourceSpans(rootPath, entries = [], limit = 4) {
  const spans = [];
  for (const entry of entries) {
    if (spans.length >= limit) break;
    const sourcePath = await firstReadablePath(rootPath, entry);
    if (!sourcePath) continue;
    const text = await readText(sourcePath).catch(() => '');
    const excerpt = truncate(text.replace(/\s+/g, ' '), 700);
    if (!excerpt) continue;
    spans.push({
      source_key: sourceKeyFromEntry(entry) || null,
      source_path: sourcePath,
      role: isMarkdownSource(entry) ? 'markdown_excerpt' : 'source_excerpt',
      text: excerpt
    });
  }
  return spans;
}

function requisitionForPaper(input = {}, reason = 'material unavailable') {
  const title = compactText(input.title || input.paperTitle || input.paper_title);
  const identifiers = identifiersOf(input);
  return {
    requisition_id: `req:${stableHash(`${title}:${JSON.stringify(identifiers)}:${reason}`, 16)}`,
    title: title || null,
    identifiers,
    expected_role: input.role || input.expected_role || null,
    priority: input.priority || 'medium',
    why_needed: reason,
    preferred_source: input.markdownUrl || input.markdown_url ? 'markdown' : 'markdown_or_open_pdf',
    source_hints: unique([
      input.markdownUrl,
      input.markdown_url,
      input.pdfUrl,
      input.pdf_url,
      input.bestOaUrl,
      input.best_oa_url,
      ...asArray(input.sourceHints || input.source_hints)
    ].map(compactText).filter(Boolean)),
    status: 'material_unavailable'
  };
}

async function loadMaterialContext(args = {}, options = {}) {
  const rootPath = await resolveCorpus(args.corpus);
  const [meta, manifest, lite] = await Promise.all([
    loadCorpusMeta(rootPath),
    loadSourceManifest(rootPath),
    loadCorpusLite(rootPath).catch((error) => ({ error, graph: null, meta: null }))
  ]);
  return {
    rootPath,
    meta,
    manifest: manifest || { sources: [] },
    graph: lite.graph || null,
    graphLoadError: lite.error ? (lite.error.message || String(lite.error)) : null,
    options
  };
}

export async function buildPaperMaterialView(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  const selector = {
    paperId: args.paperId || args.paper_id,
    sourceKey: args.sourceKey || args.source_key,
    paperTitle: args.paperTitle || args.paper_title || args.title,
    identifier: args.identifier,
    doi: args.doi,
    arxivId: args.arxivId,
    pmid: args.pmid,
    pmcid: args.pmcid,
    query: args.query
  };
  const entries = findSourceEntries(context.manifest, selector);
  const representative = entries[0] || {};
  const paperNode = findPaperNode(context.graph, {
    ...selector,
    paperId: selector.paperId || paperIdFromEntry(representative),
    paperTitle: selector.paperTitle || paperTitleFromEntry(representative)
  });
  const chunkLimit = boundedInteger(args.chunkLimit || args.chunk_limit, 8, { max: 40 });
  const chunks = await collectChunks(context.rootPath, entries, chunkLimit);
  const spans = await sourceSpans(context.rootPath, entries, 4);
  const availability = buildAvailability(entries, paperNode, chunks);
  const status = materialStatus(availability, entries);
  const paperId = paperNode?.properties?.paperId || paperNode?.id || paperIdFromEntry(representative) || selector.paperId || null;
  const title = paperNode?.properties?.paperTitle || paperNode?.name || paperTitleFromEntry(representative) || selector.paperTitle || null;
  const importRequisitions = status === 'material_unavailable' || (!availability.markdown && !availability.graph_context)
    ? [requisitionForPaper({ title, identifiers: identifiersOf(representative), role: args.role }, availability.graph_context ? 'markdown source missing for paper material view' : 'paper is not graph-visible or source-backed')]
    : [];

  return {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'paper_material_view',
    rootPath: context.rootPath,
    corpus: context.meta.name || args.corpus || context.rootPath,
    paper: {
      paper_id: paperId,
      title,
      identifiers: identifiersOf(representative),
      status,
      availability
    },
    sources: entries.map((entry) => ({
      source_key: sourceKeyFromEntry(entry) || null,
      source_path: entry.sourcePath || entry.source_path || entry.inputPath || entry.input_path || null,
      kind: sourceKind(entry) || null,
      provider: entry.sourceProvider || entry.source_provider || null,
      active_in_graph: entry.activeInGraph !== false && entry.active_in_graph !== false
    })),
    graph_context: graphContextForPaper(context.graph, paperNode),
    materials: {
      abstract: paperNode?.properties?.abstract || representative.abstract || null,
      chunks,
      source_spans: spans,
      tables: [],
      figures: []
    },
    import_requisitions: importRequisitions,
    generatedAt: nowIso()
  };
}

function querySetForRole(role, args = {}) {
  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  const constraints = normalizeConstraints(args.constraints || args.constraint).join(' ');
  const base = [targetDomain, targetProblem].filter(Boolean).join(' ');
  const roleQuery = {
    target_prior: `${base} prior baseline benchmark closest related work ${constraints}`,
    near_source_method: `${targetProblem} method transfer adaptation calibration robust learning ${constraints}`,
    far_source_story: `${targetProblem} mechanism analogy control cognition complex systems ${constraints}`,
    novelty_risk: `${base} limitation assumption failure gap prior ${constraints}`,
    baseline_candidate: `${base} baseline dataset benchmark metric evaluation ${constraints}`,
    negative_evidence: `${base} direct match ${constraints}`
  }[role] || `${base} ${role.replace(/_/g, ' ')} ${constraints}`;
  return unique([roleQuery, base, targetProblem].map(compactText).filter(Boolean));
}

function collectGraphPaperCandidates(graph, queries = [], limit = 5) {
  if (!graph) return [];
  const candidates = [];
  const seen = new Set();
  for (const query of queries) {
    const result = searchGraph(graph, query, { limit: Math.max(limit, 8) });
    for (const group of result.groups || []) {
      if (candidates.length >= limit) return candidates;
      if (group.scope !== 'paper') continue;
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      candidates.push({
        paper_id: group.id,
        title: group.title,
        query,
        score: Number(group.score || 0),
        matches: group.matches || [],
        status: 'in_graph'
      });
    }
  }
  return candidates;
}

function candidateDomainsFromGraph(graph, targetDomain = '', limit = 8) {
  if (!graph) return [];
  const domains = typeof graph.getNodesByType === 'function' ? graph.getNodesByType(NODE_TYPES.DOMAIN) : [];
  return domains
    .map((node) => compactText(node.name || node.properties?.name))
    .filter(Boolean)
    .filter((domain) => normalizeTitle(domain) !== normalizeTitle(targetDomain))
    .slice(0, limit)
    .map((domain, index) => ({
      domain,
      layer: index < Math.ceil(limit / 2) ? 'near_source' : 'far_source',
      rationale: 'Candidate domain surfaced from the committed graph domain layer.',
      source: 'graph_domain_layer'
    }));
}

export async function buildSourceDiscoveryPlan(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  const constraints = normalizeConstraints(args.constraints || args.constraint);
  const roles = normalizeRoles(args.roles || args.role);
  const limit = boundedInteger(args.limit, 5, { max: 30 });
  const targetQueries = querySetForRole('target_prior', args);
  const nearSourceQueries = querySetForRole('near_source_method', args);
  const farSourceQueries = querySetForRole('far_source_story', args);
  const targetCandidates = collectGraphPaperCandidates(context.graph, targetQueries, limit);
  const nearCandidates = collectGraphPaperCandidates(context.graph, nearSourceQueries, limit);
  const farCandidates = collectGraphPaperCandidates(context.graph, farSourceQueries, limit);
  const seedPapers = asArray(args.seedPapers || args.seed_papers).filter((entry) => entry && typeof entry === 'object');
  const seedRequisitions = seedPapers
    .filter((seed) => !findSourceEntries(context.manifest, seed).length)
    .map((seed) => requisitionForPaper(seed, 'user-provided seed paper is not materialized in this corpus'));
  const sparseRoles = roles.filter((role) => {
    const queries = querySetForRole(role, args);
    return collectGraphPaperCandidates(context.graph, queries, 1).length === 0;
  });
  const sparseRequisitions = sparseRoles.map((role) => requisitionForPaper({
    title: `${targetProblem || targetDomain} ${role.replace(/_/g, ' ')}`,
    role,
    priority: role === 'target_prior' || role === 'novelty_risk' ? 'high' : 'medium'
  }, `No committed-graph candidate found for role ${role}; run literature_discovery with generated queries.`));

  return {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'source_discovery_plan',
    run_id: `agent-materials:${stableHash(`${targetDomain}:${targetProblem}:${nowIso()}`, 16)}`,
    rootPath: context.rootPath,
    corpus: context.meta.name || args.corpus || context.rootPath,
    project: compactText(args.project) || null,
    target_domain: targetDomain,
    target_problem: targetProblem,
    constraints,
    generated: true,
    target_queries: targetQueries,
    near_source_queries: nearSourceQueries,
    far_source_queries: farSourceQueries,
    candidate_source_domains: candidateDomainsFromGraph(context.graph, targetDomain),
    candidate_papers: [
      ...targetCandidates.map((entry) => ({ ...entry, role: 'target_prior', layer: 'target_domain' })),
      ...nearCandidates.map((entry) => ({ ...entry, role: 'near_source_method', layer: 'near_source' })),
      ...farCandidates.map((entry) => ({ ...entry, role: 'far_source_story', layer: 'far_source' }))
    ],
    import_requisitions: [...seedRequisitions, ...sparseRequisitions],
    negative_evidence: sparseRoles.map((role) => ({
      role,
      searched_queries: querySetForRole(role, args),
      direct_hit_count: 0,
      adjacent_hit_count: 0,
      absence_confidence: 'low',
      limitation: 'MVP searched committed graph only; run literature_discovery for online/provider coverage.'
    })),
    generatedAt: nowIso()
  };
}

async function materialItemFromCandidate(candidate = {}, args = {}, options = {}) {
  const view = await buildPaperMaterialView({
    ...args,
    paperId: candidate.paper_id,
    paperTitle: candidate.title,
    role: candidate.role
  }, options);
  return {
    material_id: `material:${stableHash(`${candidate.role || ''}:${candidate.paper_id || candidate.title}`, 16)}`,
    paper_id: view.paper.paper_id,
    title: view.paper.title,
    status: view.paper.status,
    availability: view.paper.availability,
    role: candidate.role || null,
    layer: candidate.layer || null,
    match: {
      query: candidate.query || null,
      score: candidate.score || 0,
      matches: candidate.matches || []
    },
    materials: view.materials,
    graph_context: view.graph_context,
    sources: view.sources,
    provenance: [{
      source_type: 'committed_graph_search',
      source_id: candidate.paper_id || candidate.title || null,
      query: candidate.query || null
    }]
  };
}

export async function buildResearchMaterialPack(args = {}, options = {}) {
  const plan = await buildSourceDiscoveryPlan(args, options);
  const roles = normalizeRoles(args.roles || args.role);
  const limit = boundedInteger(args.limit, 5, { max: 20 });
  const groups = [];

  for (const role of roles) {
    const candidates = plan.candidate_papers.filter((entry) => entry.role === role).slice(0, limit);
    const items = [];
    for (const candidate of candidates) {
      items.push(await materialItemFromCandidate(candidate, args, options));
    }
    groups.push({
      role,
      purpose: ROLE_PURPOSES[role] || `Collect materials for ${role}.`,
      items
    });
  }

  const missingMaterials = groups
    .filter((group) => group.items.length === 0)
    .map((group) => ({
      role: group.role,
      reason: 'No committed-graph material matched this role in the MVP pack.',
      next_action: 'Run source_discovery_plan queries through literature_discovery and import useful resolved sources.'
    }));

  const pack = {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'research_material_pack',
    run_id: plan.run_id,
    rootPath: plan.rootPath,
    corpus: plan.corpus,
    project: plan.project,
    target_domain: plan.target_domain,
    target_problem: plan.target_problem,
    constraints: plan.constraints,
    source_discovery: {
      enabled: true,
      target_queries: plan.target_queries,
      near_source_queries: plan.near_source_queries,
      far_source_queries: plan.far_source_queries,
      candidate_source_domains: plan.candidate_source_domains,
      candidate_papers: plan.candidate_papers,
      import_requisitions: plan.import_requisitions
    },
    groups,
    missing_materials: missingMaterials,
    negative_evidence: plan.negative_evidence,
    import_requisitions: plan.import_requisitions,
    generatedAt: nowIso()
  };

  return maybeExportPayload(pack, args);
}

export async function buildImportRequisitionPack(args = {}, options = {}) {
  const plan = await buildSourceDiscoveryPlan(args, options);
  const payload = {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'import_requisition_pack',
    run_id: plan.run_id,
    rootPath: plan.rootPath,
    corpus: plan.corpus,
    project: plan.project,
    target_domain: plan.target_domain,
    target_problem: plan.target_problem,
    import_requisitions: plan.import_requisitions,
    generated_queries: {
      target: plan.target_queries,
      near_source: plan.near_source_queries,
      far_source: plan.far_source_queries
    },
    generatedAt: nowIso()
  };
  return maybeExportPayload(payload, args);
}

function renderMaterialPackMarkdown(payload = {}) {
  const lines = [
    `# PaperNexus Material Pack`,
    '',
    `- Project: ${payload.project || ''}`,
    `- Corpus: ${payload.corpus || ''}`,
    `- Target domain: ${payload.target_domain || ''}`,
    `- Target problem: ${payload.target_problem || ''}`,
    ''
  ];
  for (const group of payload.groups || []) {
    lines.push(`## ${group.role}`, '');
    if (!group.items?.length) {
      lines.push('- No material found in committed graph.', '');
      continue;
    }
    for (const item of group.items) {
      lines.push(`- ${item.title || item.paper_id || 'Untitled'} (${item.status})`);
    }
    lines.push('');
  }
  if (payload.import_requisitions?.length) {
    lines.push('## Import Requisitions', '');
    for (const req of payload.import_requisitions) {
      lines.push(`- ${req.title || req.requisition_id}: ${req.why_needed}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function maybeExportPayload(payload = {}, args = {}) {
  const outputDir = compactText(args.outputDir || args.output_dir);
  if (!outputDir) return payload;
  const baseName = payload.operation === 'research_material_pack'
    ? 'material_pack'
    : payload.operation;
  const resolvedDir = path.resolve(outputDir);
  await ensureDir(resolvedDir);
  const jsonPath = path.join(resolvedDir, `${baseName}.json`);
  const exports = { json_path: jsonPath };
  if (payload.operation === 'research_material_pack') {
    const markdownPath = path.join(resolvedDir, 'material_pack.md');
    await writeText(markdownPath, renderMaterialPackMarkdown(payload));
    exports.markdown_path = markdownPath;
  }
  const exportedPayload = {
    ...payload,
    exports
  };
  await writeJson(jsonPath, exportedPayload);
  return exportedPayload;
}

export async function executeAgentMaterialsOperation(args = {}, options = {}) {
  const operation = compactText(args.operation).toLowerCase().replace(/[-\s]+/g, '_');
  if (operation === 'paper_material_view') return buildPaperMaterialView(args, options);
  if (operation === 'source_discovery_plan') return maybeExportPayload(await buildSourceDiscoveryPlan(args, options), args);
  if (operation === 'research_material_pack') return buildResearchMaterialPack(args, options);
  if (operation === 'import_requisition_pack') return buildImportRequisitionPack(args, options);
  throw new Error(`Unknown agent_materials operation: ${args.operation || '<missing>'}`);
}
