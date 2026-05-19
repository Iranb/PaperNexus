import path from 'node:path';
import { createRequire } from 'node:module';

import { ensureDir, fileExists, readText, writeJson, writeText } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { searchGraph } from '../search/search.js';
import { getDefaultLlmApiKeyEnv, loadLlmApiKey, resolveLlmConfig } from '../llm/ollama.js';
import {
  deriveDomainTaxonomyFromGraph,
  normalizeFieldOfStudy,
  scoreDomainDistance
} from '../graph/domain-taxonomy.js';
import {
  S2_FIELDS_OF_STUDY,
  normalizeS2FieldOfStudy,
  searchSemanticScholarSnippets
} from '../discovery/semantic-scholar-snippets.js';
import { runLiteratureDiscovery } from '../discovery/workflow.js';
import { submitDiscoveryImports } from '../discovery/import-bridge.js';
import { runImportQueueUntilIdle } from '../imports/worker.js';
import { runLiveIdeaCatalyst } from '../graph/idea-catalyst-live.js';
import { loadChunkText, loadPaperChunks } from '../../storage/chunk-store.js';
import { loadImportTask } from '../../storage/import-store.js';
import {
  executeEvidenceCart,
  executePaperRoleOverlay,
  executeWorkflowState,
  loadProjectOverlaySummary,
  overlayRolesForPaper
} from './project-overlay.js';
import {
  loadCorpusLite,
  loadCorpusMeta,
  loadSourceManifest,
  resolveCorpus
} from '../../storage/corpus-store.js';
import { NODE_TYPES } from '../graph/schema.js';

const require = createRequire(import.meta.url);
let jsonrepair = null;
try {
  ({ jsonrepair } = require('jsonrepair'));
} catch {}

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

const COST_SIGNAL_PATTERNS = {
  hardware: /\b(?:A100|H100|V100|T4|P100|RTX\s?\d{4}|GPU(?:s)?|TPU(?:s)?)\b/gi,
  runtime: /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|days?|minutes?|mins?)\b/gi,
  epochs: /\b\d+(?:\.\d+)?\s*epochs?\b/gi,
  batch_size: /\bbatch\s*size\s*(?:of\s*)?\d+\b/gi,
  dataset_scale: /\b\d+(?:\.\d+)?\s*(?:k|m|million|thousand)?\s*(?:images|samples|examples|instances|papers|documents)\b/gi,
  backbone: /\b(?:ResNet-\d+|ViT-[A-Z0-9/.-]+|BERT|RoBERTa|CLIP|ConvNeXt|Swin|DINOv2)\b/gi,
  code_availability: /\b(?:code\s+is\s+available|source\s+code|github\.com|available\s+at\s+https?:\/\/)\b/gi
};
const COST_LLM_FIELDS = Object.keys(COST_SIGNAL_PATTERNS);
const DEFAULT_COST_LLM_RECORD_LIMIT = 16;
const DEFAULT_COST_LLM_MAX_INPUT_CHARS = 12000;

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

function normalizeDomains(value) {
  return unique(asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map((entry) => normalizeFieldOfStudy(entry))
    .filter(Boolean));
}

function boundedInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function boundedNumber(value, fallback, { min = 0, max = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function firstDefined(...values) {
  return values.find((value) => (
    value !== undefined
    && value !== null
    && String(value).trim() !== ''
  )) ?? '';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clamp01(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function collectJsonCandidates(value = '') {
  const candidates = [];
  const trimmed = String(value || '').trim();
  if (!trimmed) return candidates;
  candidates.push(trimmed);

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function tryJsonRepair(candidate = '') {
  const text = String(candidate || '');
  if (!text) return text;
  if (typeof jsonrepair === 'function') {
    try {
      return jsonrepair(text);
    } catch {}
  }
  return text
    .replace(/^\uFEFF/, '')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseJsonText(text = '') {
  for (const candidate of collectJsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {}

    try {
      return JSON.parse(tryJsonRepair(candidate));
    } catch {}
  }
  throw new Error('Model response was not valid JSON.');
}

function excerptAround(text = '', index = 0, length = 0, window = 140) {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  return truncate(text.slice(start, end).replace(/\s+/g, ' '), window * 2);
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

function buildAvailability(entries = [], paperNode = null, chunks = [], structuredMaterials = {}) {
  return {
    abstract: Boolean(
      paperNode?.properties?.abstract
      || entries.some((entry) => compactText(entry.abstract || entry.summary))
    ),
    markdown: entries.some(isMarkdownSource),
    pdf: entries.some(isPdfSource),
    graph_context: Boolean(paperNode),
    chunks: chunks.length > 0,
    tables: (structuredMaterials.tables || []).length > 0,
    figures: (structuredMaterials.figures || []).length > 0,
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

function markdownTableCells(line = '') {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isMarkdownTableLine(line = '') {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && String(line || '').includes('|') && cells.some(Boolean);
}

function isMarkdownTableSeparator(line = '') {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function lineCaptionKind(line = '') {
  const match = compactText(line).match(/^(Table|Figure|Fig\.?)\s*[\w.-]*\s*[:.-]\s+(.+)$/i);
  if (!match) return null;
  return /^table$/i.test(match[1]) ? 'table' : 'figure';
}

function nearbyTableCaption(lines = [], tableStartIndex = 0) {
  for (let index = tableStartIndex - 1; index >= Math.max(0, tableStartIndex - 3); index -= 1) {
    const line = compactText(lines[index]);
    if (!line) continue;
    if (lineCaptionKind(line) === 'table') return line;
    break;
  }
  return null;
}

function structuredProvenance(record = {}, lineStart = null, lineEnd = null) {
  return {
    source_key: record.source_key || null,
    source_path: record.source_path || null,
    paper_id: record.paper_id || null,
    title: record.title || null,
    line_start: lineStart,
    line_end: lineEnd
  };
}

function extractMarkdownTables(text = '', record = {}, limit = 8) {
  const lines = String(text || '').split(/\r?\n/);
  const tables = [];
  const captionedTableLines = new Set();
  for (let index = 0; index < lines.length - 1 && tables.length < limit; index += 1) {
    if (!isMarkdownTableLine(lines[index]) || !isMarkdownTableSeparator(lines[index + 1])) continue;
    let end = index + 2;
    while (end < lines.length && isMarkdownTableLine(lines[end])) end += 1;
    const caption = nearbyTableCaption(lines, index);
    if (caption) captionedTableLines.add(index - 1);
    const markdown = lines.slice(index, end).join('\n');
    const columnCount = markdownTableCells(lines[index]).filter(Boolean).length;
    const rowCount = Math.max(0, end - index - 2);
    tables.push({
      table_id: `table:${stableHash(`${record.source_key}:${index}:${markdown}`, 18)}`,
      source_type: 'markdown_table',
      source_id: record.source_key || record.source_path || null,
      source_key: record.source_key || null,
      paper_id: record.paper_id || null,
      title: record.title || null,
      caption,
      row_count: rowCount,
      column_count: columnCount,
      markdown: truncate(markdown, 1600),
      text: truncate([caption, markdown].filter(Boolean).join('\n'), 1800),
      provenance: structuredProvenance(record, index + 1, end)
    });
    index = end - 1;
  }

  for (let index = 0; index < lines.length && tables.length < limit; index += 1) {
    if (captionedTableLines.has(index)) continue;
    const line = compactText(lines[index]);
    if (lineCaptionKind(line) !== 'table') continue;
    tables.push({
      table_id: `table:${stableHash(`${record.source_key}:${index}:${line}`, 18)}`,
      source_type: 'table_caption',
      source_id: record.source_key || record.source_path || null,
      source_key: record.source_key || null,
      paper_id: record.paper_id || null,
      title: record.title || null,
      caption: line,
      row_count: null,
      column_count: null,
      markdown: null,
      text: truncate(line, 800),
      provenance: structuredProvenance(record, index + 1, index + 1)
    });
  }

  return tables;
}

function extractFigureCaptions(text = '', record = {}, limit = 8) {
  const lines = String(text || '').split(/\r?\n/);
  const figures = [];
  for (let index = 0; index < lines.length && figures.length < limit; index += 1) {
    const line = compactText(lines[index]);
    if (lineCaptionKind(line) !== 'figure') continue;
    figures.push({
      figure_id: `figure:${stableHash(`${record.source_key}:${index}:${line}`, 18)}`,
      source_type: 'figure_caption',
      source_id: record.source_key || record.source_path || null,
      source_key: record.source_key || null,
      paper_id: record.paper_id || null,
      title: record.title || null,
      caption: truncate(line, 800),
      text: truncate(line, 800),
      provenance: structuredProvenance(record, index + 1, index + 1)
    });
  }
  return figures;
}

async function collectStructuredMaterials(rootPath, entries = [], paper = {}, limits = {}) {
  const tableLimit = boundedInteger(limits.tableLimit, 8, { max: 30 });
  const figureLimit = boundedInteger(limits.figureLimit, 8, { max: 30 });
  const tables = [];
  const figures = [];
  const visited = new Set();
  for (const entry of entries) {
    if (tables.length >= tableLimit && figures.length >= figureLimit) break;
    const sourcePath = await firstReadablePath(rootPath, entry);
    if (!sourcePath || visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const text = await readText(sourcePath).catch(() => '');
    if (!text) continue;
    const record = {
      source_key: sourceKeyFromEntry(entry) || null,
      source_path: sourcePath,
      paper_id: paper.paper_id || paperIdFromEntry(entry) || null,
      title: paper.title || paperTitleFromEntry(entry) || null
    };
    for (const table of extractMarkdownTables(text, record, tableLimit - tables.length)) {
      tables.push(table);
    }
    for (const figure of extractFigureCaptions(text, record, figureLimit - figures.length)) {
      figures.push(figure);
    }
  }
  return { tables, figures };
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
  const paperId = paperNode?.properties?.paperId || paperNode?.id || paperIdFromEntry(representative) || selector.paperId || null;
  const title = paperNode?.properties?.paperTitle || paperNode?.name || paperTitleFromEntry(representative) || selector.paperTitle || null;
  const structuredMaterials = await collectStructuredMaterials(context.rootPath, entries, {
    paper_id: paperId,
    title
  });
  const availability = buildAvailability(entries, paperNode, chunks, structuredMaterials);
  const status = materialStatus(availability, entries);
  const projectOverlay = await loadProjectOverlaySummary(context.rootPath, args.project);
  const sources = entries.map((entry) => ({
    source_key: sourceKeyFromEntry(entry) || null,
    source_path: entry.sourcePath || entry.source_path || entry.inputPath || entry.input_path || null,
    kind: sourceKind(entry) || null,
    provider: entry.sourceProvider || entry.source_provider || null,
    active_in_graph: entry.activeInGraph !== false && entry.active_in_graph !== false
  }));
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
    sources,
    overlay_roles: overlayRolesForPaper(projectOverlay.roles, { paper_id: paperId, title, sources }),
    graph_context: graphContextForPaper(context.graph, paperNode),
    materials: {
      abstract: paperNode?.properties?.abstract || representative.abstract || null,
      chunks,
      source_spans: spans,
      tables: structuredMaterials.tables,
      figures: structuredMaterials.figures
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

function querySetForSourceDomain(domain, layer, args = {}) {
  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  const constraints = normalizeConstraints(args.constraints || args.constraint).join(' ');
  const domainText = compactText(domain);
  const base = [domainText, targetProblem].filter(Boolean).join(' ');
  const layerQuery = layer === 'near_source'
    ? `${base} transfer adaptation calibration robust method ${targetDomain} ${constraints}`
    : `${base} mechanism analogy theory reframing abstraction ${targetDomain} ${constraints}`;
  return unique([layerQuery, base, `${domainText} ${targetProblem} ${constraints}`].map(compactText).filter(Boolean));
}

function providerEvidenceConfig(args = {}) {
  return {
    enabled: booleanFlag(args.includeProviderEvidence ?? args.include_provider_evidence, false),
    persist: booleanFlag(args.persistProviderEvidence ?? args.persist_provider_evidence, false),
    backend: 'semantic_scholar_snippets',
    query_limit: boundedInteger(args.providerEvidenceQueryLimit ?? args.provider_evidence_query_limit, 6, { max: 24 }),
    result_limit: boundedInteger(args.providerEvidenceLimit ?? args.provider_evidence_limit, 3, { max: 10 }),
    persist_limit: boundedInteger(args.providerEvidencePersistLimit ?? args.provider_evidence_persist_limit, 20, { max: 200 }),
    timeout_ms: boundedInteger(args.providerEvidenceTimeoutMs ?? args.provider_evidence_timeout_ms, 12000, { min: 1000, max: 60000 }),
    retry_count: boundedInteger(args.providerEvidenceRetryCount ?? args.provider_evidence_retry_count, 0, { min: 0, max: 3 }),
    fallback_to_abstract: booleanFlag(args.providerEvidenceFallbackToAbstract ?? args.provider_evidence_fallback_to_abstract, false)
  };
}

function providerFieldsOfStudy(domain = '') {
  const normalized = normalizeS2FieldOfStudy(domain);
  return S2_FIELDS_OF_STUDY.includes(normalized) ? [normalized] : [];
}

function dedupeProviderQueryRecords(records = [], queryLimit = 6) {
  const seen = new Set();
  const deduped = [];
  for (const record of records) {
    const query = compactText(record.query);
    if (!query) continue;
    const key = `${record.hit_classification || ''}:${record.role || ''}:${record.layer || ''}:${record.source_domain || ''}:${query.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...record,
      query,
      fieldsOfStudy: providerFieldsOfStudy(record.source_domain || record.target_domain || record.domain)
    });
    if (deduped.length >= queryLimit) break;
  }
  return deduped;
}

function providerQueryRecordsForSourcePlan({
  targetDomain = '',
  targetQueries = [],
  nearSourceQueries = [],
  farSourceQueries = [],
  sourceDomainQueries = []
} = {}, config = {}) {
  return dedupeProviderQueryRecords([
    ...targetQueries.map((query) => ({
      query,
      role: 'target_prior',
      layer: 'target_domain',
      target_domain: targetDomain,
      hit_classification: 'target'
    })),
    ...sourceDomainQueries.map((entry) => ({
      query: entry.query,
      role: entry.role,
      layer: entry.layer,
      source_domain: entry.domain,
      domain_distance: entry.domain_distance,
      proximal_leakage: entry.proximal_leakage,
      hit_classification: entry.layer === 'near_source' ? 'near_source' : 'far_source'
    })),
    ...nearSourceQueries.map((query) => ({
      query,
      role: 'near_source_method',
      layer: 'near_source',
      target_domain: targetDomain,
      hit_classification: 'near_source'
    })),
    ...farSourceQueries.map((query) => ({
      query,
      role: 'far_source_story',
      layer: 'far_source',
      target_domain: targetDomain,
      hit_classification: 'far_source'
    }))
  ], config.query_limit);
}

function identifiersFromProviderPaper(paper = {}) {
  const ids = paper.externalIds || {};
  return {
    ...(ids.DOI ? { doi: ids.DOI } : {}),
    ...(ids.ArXiv ? { arxivId: ids.ArXiv } : {}),
    ...(ids.PubMed ? { pmid: ids.PubMed } : {}),
    ...(ids.PubMedCentral ? { pmcid: ids.PubMedCentral } : {}),
    ...(ids.CorpusId ? { corpusId: String(ids.CorpusId) } : {}),
    ...(paper.corpusId ? { corpusId: String(paper.corpusId) } : {}),
    ...(paper.paperId ? { semanticScholarPaperId: paper.paperId } : {})
  };
}

function normalizeProviderHit(result = {}, record = {}) {
  const paper = result.paper || {};
  const identifiers = identifiersFromProviderPaper(paper);
  const providerPaperId = paper.paperId || (paper.corpusId ? `CorpusId:${paper.corpusId}` : '') || identifiers.doi || identifiers.arxivId || '';
  const openAccessPdf = typeof paper.openAccessPdf === 'string'
    ? paper.openAccessPdf
    : compactText(paper.openAccessPdf?.url);
  return {
    hit_id: result.snippetId || `provider-hit:${stableHash(`${record.query}:${providerPaperId}:${paper.title}`, 16)}`,
    provider: result.provider || 'semantic_scholar_snippets',
    query: record.query,
    role: record.role || null,
    layer: record.layer || null,
    source_domain: record.source_domain || null,
    domain_distance: record.domain_distance ?? null,
    proximal_leakage: record.proximal_leakage ?? null,
    hit_classification: record.hit_classification || 'provider_hit',
    provider_paper_id: providerPaperId || null,
    paper_id: providerPaperId || `provider:${stableHash(paper.title || result.text || record.query, 16)}`,
    title: paper.title || null,
    year: paper.year ?? null,
    venue: paper.venue || null,
    url: paper.url || null,
    identifiers,
    fields_of_study: paper.fieldsOfStudy || [],
    is_open_access: paper.isOpenAccess ?? null,
    open_access_pdf: openAccessPdf || null,
    score: result.score ?? null,
    snippet_id: result.snippetId || null,
    snippet_kind: result.snippetKind || null,
    section: result.section || null,
    text: truncate(result.text || result.evidenceText || '', 900),
    abstract_fallback: Boolean(result.abstractFallback),
    status: 'discovered'
  };
}

function normalizeProviderRun(result = {}, record = {}) {
  const hits = (result.results || []).map((entry) => normalizeProviderHit(entry, record));
  return {
    status: 'ok',
    provider: result.provider || 'semantic_scholar_snippets',
    query: record.query,
    role: record.role || null,
    layer: record.layer || null,
    source_domain: record.source_domain || null,
    fields_of_study: result.fieldsOfStudy || record.fieldsOfStudy || [],
    hit_classification: record.hit_classification || 'provider_hit',
    result_count: result.resultCount ?? hits.length,
    paper_count: result.paperCount ?? unique(hits.map((hit) => hit.paper_id).filter(Boolean)).length,
    abstract_fallback_count: result.abstractFallbackCount ?? hits.filter((hit) => hit.abstract_fallback).length,
    hits
  };
}

function providerErrorRun(record = {}, error) {
  return {
    status: 'error',
    provider: 'semantic_scholar_snippets',
    query: record.query,
    role: record.role || null,
    layer: record.layer || null,
    source_domain: record.source_domain || null,
    fields_of_study: record.fieldsOfStudy || [],
    hit_classification: record.hit_classification || 'provider_hit',
    result_count: 0,
    paper_count: 0,
    abstract_fallback_count: 0,
    hits: [],
    error: truncate(error?.message || String(error), 300)
  };
}

function flattenProviderHits(providerEvidence = {}) {
  return (providerEvidence.query_runs || []).flatMap((run) => run.hits || []);
}

async function collectProviderEvidence(queryRecords = [], args = {}, options = {}) {
  const config = providerEvidenceConfig(args);
  const policy = {
    backend: config.backend,
    enabled: config.enabled,
    persist_requested: config.persist,
    query_limit: config.query_limit,
    result_limit: config.result_limit,
    persist_limit: config.persist_limit,
    fallback_to_abstract: config.fallback_to_abstract,
    read_only: true,
    side_effects: []
  };
  if (!config.enabled) {
    return {
      ...policy,
      query_runs: [],
      result_count: 0,
      paper_count: 0,
      error_count: 0,
      limitation: 'Provider evidence is disabled by default; set includeProviderEvidence=true for bounded Semantic Scholar snippet evidence.'
    };
  }

  const runs = [];
  for (const record of dedupeProviderQueryRecords(queryRecords, config.query_limit)) {
    try {
      const result = await searchSemanticScholarSnippets({
        query: record.query,
        fieldsOfStudy: record.fieldsOfStudy,
        limit: config.result_limit,
        timeoutMs: config.timeout_ms,
        retryCount: config.retry_count,
        fallbackToAbstract: config.fallback_to_abstract,
        fetch: options.fetch
      });
      runs.push(normalizeProviderRun(result, record));
    } catch (error) {
      runs.push(providerErrorRun(record, error));
    }
  }

  const hits = runs.flatMap((run) => run.hits || []);
  return {
    ...policy,
    query_runs: runs,
    result_count: runs.reduce((sum, run) => sum + Number(run.result_count || 0), 0),
    paper_count: unique(hits.map((hit) => hit.paper_id || hit.title).filter(Boolean)).length,
    error_count: runs.filter((run) => run.status === 'error').length,
    limitation: 'Bounded provider snippet search; results are discovery materials, not graph facts or novelty judgments.'
  };
}

function evidenceRecordFromProviderHit(hit = {}, args = {}, scope = 'provider_evidence') {
  const evidenceId = `provider-evidence:${stableHash([
    args.project || '',
    scope,
    hit.provider || '',
    hit.query || '',
    hit.provider_paper_id || hit.paper_id || '',
    hit.snippet_id || hit.hit_id || '',
    hit.text || ''
  ].join(':'), 20)}`;
  return {
    action: 'add',
    project: args.project,
    actor: compactText(args.actor || args.createdBy || args.created_by) || 'agent_materials',
    evidenceId,
    itemType: 'provider_snippet',
    sourceType: 'provider_snippet',
    sourceId: hit.snippet_id || hit.hit_id || hit.provider_paper_id || hit.paper_id,
    role: hit.role || null,
    paperId: hit.paper_id || null,
    paperTitle: hit.title || null,
    text: hit.text || null,
    tags: unique([
      'provider_evidence',
      scope,
      hit.layer,
      hit.hit_classification,
      hit.source_domain
    ].map(compactText).filter(Boolean)),
    provenance: [{
      source_type: 'provider_search',
      provider: hit.provider || null,
      query: hit.query || null,
      source_domain: hit.source_domain || null,
      layer: hit.layer || null,
      hit_classification: hit.hit_classification || null,
      provider_paper_id: hit.provider_paper_id || null,
      identifiers: hit.identifiers || {},
      url: hit.url || null,
      open_access_pdf: hit.open_access_pdf || null
    }],
    notes: 'Persisted provider evidence material; not a graph fact or novelty judgment.'
  };
}

async function persistProviderEvidence(providerEvidence = {}, args = {}, context = {}, scope = 'provider_evidence') {
  const config = providerEvidenceConfig(args);
  if (!config.persist) {
    return {
      enabled: false,
      requested: false,
      status: 'not_requested',
      persisted_count: 0
    };
  }
  if (!config.enabled) {
    return {
      enabled: false,
      requested: true,
      status: 'skipped',
      reason: 'includeProviderEvidence must be true before provider evidence can be persisted.',
      persisted_count: 0
    };
  }
  if (!compactText(args.project)) {
    return {
      enabled: false,
      requested: true,
      status: 'skipped',
      reason: 'project is required to persist provider evidence into the evidence cart.',
      persisted_count: 0
    };
  }

  const hits = flattenProviderHits(providerEvidence).slice(0, config.persist_limit);
  const evidenceIds = [];
  for (const hit of hits) {
    const evidence = evidenceRecordFromProviderHit(hit, args, scope);
    const result = await executeEvidenceCart(evidence, { rootPath: context.rootPath });
    evidenceIds.push(result.event?.evidence_id || evidence.evidenceId);
  }
  return {
    enabled: true,
    requested: true,
    status: 'persisted',
    overlay: await loadProjectOverlaySummary(context.rootPath, args.project),
    persisted_count: evidenceIds.length,
    evidence_ids: evidenceIds
  };
}

function providerCandidatesFromEvidence(providerEvidence = {}, limit = 5) {
  const candidates = flattenProviderHits(providerEvidence).map((hit) => ({
    paper_id: hit.paper_id,
    title: hit.title,
    role: hit.role,
    layer: hit.layer,
    source_domain: hit.source_domain,
    domain_distance: hit.domain_distance,
    proximal_leakage: hit.proximal_leakage,
    query: hit.query,
    source_query: hit.query,
    score: hit.score ?? 0.25,
    status: 'discovered',
    provider: hit.provider,
    provider_paper_id: hit.provider_paper_id,
    identifiers: hit.identifiers,
    abstract: hit.text,
    provider_evidence: [hit],
    matches: [{
      node_type: 'provider_snippet',
      node_id: hit.snippet_id || hit.hit_id,
      node_name: hit.title,
      text: hit.text,
      score: hit.score
    }]
  })).filter((candidate) => candidate.title);
  return mergeCandidateLists(candidates, limit);
}

function providerRequisitionsFromEvidence(providerEvidence = {}, manifest = {}, limit = 12) {
  const requisitions = [];
  for (const hit of flattenProviderHits(providerEvidence)) {
    if (!hit.title) continue;
    const materialized = findSourceEntries(manifest, {
      paperId: hit.provider_paper_id,
      title: hit.title,
      identifiers: hit.identifiers,
      doi: hit.identifiers?.doi,
      arxivId: hit.identifiers?.arxivId,
      pmid: hit.identifiers?.pmid,
      pmcid: hit.identifiers?.pmcid
    }).length > 0;
    if (materialized) continue;
    requisitions.push(requisitionForPaper({
      title: hit.title,
      identifiers: hit.identifiers,
      role: hit.role,
      priority: hit.role === 'target_prior' || hit.role === 'novelty_risk' ? 'high' : 'medium',
      bestOaUrl: hit.open_access_pdf || hit.url,
      sourceHints: [hit.url, hit.open_access_pdf].filter(Boolean)
    }, `Provider evidence hit (${hit.provider}) is not materialized in this corpus.`));
    if (requisitions.length >= limit) break;
  }
  return dedupeRequisitions(requisitions);
}

function providerSeedPapersFromEvidence(providerEvidence = {}, limit = 8) {
  const seeds = [];
  const seen = new Set();
  for (const hit of flattenProviderHits(providerEvidence)) {
    const title = compactText(hit.title);
    if (!title) continue;
    const identifiers = identifiersOf(hit);
    const paperId = compactText(hit.provider_paper_id || hit.paper_id);
    const key = identifiers.doi || identifiers.arxivId || identifiers.pmid || identifiers.pmcid || paperId || normalizeTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({
      id: paperId || `provider:${stableHash(title, 16)}`,
      title,
      year: hit.year || null,
      venue: hit.venue || null,
      identifiers,
      abstract: truncate(hit.text || hit.abstract || '', 800),
      sourceDomain: compactText(hit.source_domain),
      source_domain: compactText(hit.source_domain),
      seedSource: 'provider_search',
      seed_source: 'provider_search',
      provider: hit.provider || null,
      providerPaperId: paperId,
      provider_paper_id: paperId,
      sourceHints: unique([
        hit.open_access_pdf,
        hit.url
      ].map((entry) => String(entry || '').trim()).filter(Boolean))
    });
    if (seeds.length >= limit) break;
  }
  return seeds;
}

function liveDiscoveryConfig(args = {}) {
  const includeAlways = booleanFlag(
    args.includeLiveDiscoveryEvidence
      ?? args.include_live_discovery_evidence
      ?? args.includeIdeaCatalystEvidence
      ?? args.include_idea_catalyst_evidence,
    false
  );
  const fallbackIfSparse = booleanFlag(
    args.runLiveIdeaCatalystIfNeeded
      ?? args.run_live_idea_catalyst_if_needed
      ?? args.liveDiscoveryFallbackIfSparse
      ?? args.live_discovery_fallback_if_sparse,
    false
  );
  return {
    enabled: includeAlways || fallbackIfSparse,
    include_always: includeAlways,
    fallback_if_sparse: fallbackIfSparse,
    trigger_mode: includeAlways ? 'always' : (fallbackIfSparse ? 'graph_sparse_fallback' : 'disabled'),
    persist: booleanFlag(args.persistLiveDiscoveryEvidence ?? args.persist_live_discovery_evidence, false),
    backend: 'idea_catalyst_live_discovery',
    num_questions: boundedInteger(args.liveDiscoveryNumQuestions ?? args.live_discovery_num_questions ?? args.numQuestions ?? args.num_questions, 1, { max: 3 }),
    source_domain_limit: boundedInteger(args.liveDiscoverySourceDomainLimit ?? args.live_discovery_source_domain_limit ?? args.numSourceDomains ?? args.num_source_domains, 2, { max: 6 }),
    max_papers_per_query: boundedInteger(args.liveDiscoveryMaxPapersPerQuery ?? args.live_discovery_max_papers_per_query ?? args.maxPapersPerQuery ?? args.max_papers_per_query, 5, { max: 20 }),
    source_relevance_threshold: boundedNumber(args.liveDiscoverySourceRelevanceThreshold ?? args.live_discovery_source_relevance_threshold ?? args.sourceRelevanceThreshold ?? args.source_relevance_threshold, 0.5),
    idea_fragment_limit: boundedInteger(args.liveDiscoveryIdeaFragmentLimit ?? args.live_discovery_idea_fragment_limit ?? args.ideaFragmentLimit ?? args.idea_fragment_limit, 3, { max: 8 }),
    persist_limit: boundedInteger(args.liveDiscoveryPersistLimit ?? args.live_discovery_persist_limit, 20, { max: 200 }),
    timeout_ms: boundedInteger(args.liveDiscoveryTimeoutMs ?? args.live_discovery_timeout_ms ?? args.timeoutMs ?? args.timeout_ms, 12000, { min: 1000, max: 60000 }),
    retry_count: boundedInteger(args.liveDiscoveryRetryCount ?? args.live_discovery_retry_count ?? args.retryCount ?? args.retry_count, 0, { min: 0, max: 3 }),
    sparse_role_threshold: boundedInteger(args.liveDiscoverySparseRoleThreshold ?? args.live_discovery_sparse_role_threshold, 1, { min: 1, max: 10 })
  };
}

function liveDiscoveryPolicy(config = {}) {
  return {
    backend: config.backend || 'idea_catalyst_live_discovery',
    enabled: Boolean(config.enabled),
    trigger_mode: config.trigger_mode || 'disabled',
    fallback_if_sparse: Boolean(config.fallback_if_sparse),
    sparse_role_threshold: config.sparse_role_threshold,
    persist_requested: Boolean(config.persist),
    num_questions: config.num_questions,
    source_domain_limit: config.source_domain_limit,
    max_papers_per_query: config.max_papers_per_query,
    source_relevance_threshold: config.source_relevance_threshold,
    idea_fragment_limit: config.idea_fragment_limit,
    persist_limit: config.persist_limit,
    read_only: true,
    side_effects: []
  };
}

function liveDiscoverySparsity(args = {}, config = {}) {
  const trigger = normalizeObject(args.liveDiscoveryTrigger || args.live_discovery_trigger);
  const sparseRoles = unique(asArray(trigger.sparse_roles || trigger.sparseRoles)
    .map((role) => compactText(role))
    .filter(Boolean));
  const sparseRoleCount = Number.isFinite(Number(trigger.sparse_role_count ?? trigger.sparseRoleCount))
    ? Number(trigger.sparse_role_count ?? trigger.sparseRoleCount)
    : sparseRoles.length;
  const graphSparse = trigger.graph_sparse !== undefined || trigger.graphSparse !== undefined
    ? booleanFlag(trigger.graph_sparse ?? trigger.graphSparse, false)
    : sparseRoleCount >= (config.sparse_role_threshold || 1);
  return {
    graph_sparse: graphSparse,
    sparse_roles: sparseRoles,
    sparse_role_count: sparseRoleCount,
    sparse_role_threshold: config.sparse_role_threshold || 1,
    graph_candidate_score_threshold: trigger.graph_candidate_score_threshold ?? trigger.graphCandidateScoreThreshold ?? null,
    role_graph_candidate_counts: normalizeObject(trigger.role_graph_candidate_counts || trigger.roleGraphCandidateCounts)
  };
}

function liveDiscoveryParams(args = {}, config = {}, targetDomain = '', targetProblem = '', options = {}) {
  const llmJson = args.llmJson || options.llmJson;
  return {
    ...args,
    problem: targetProblem,
    targetDomain,
    numQuestions: config.num_questions,
    numSourceDomains: config.source_domain_limit,
    maxPapersPerQuery: config.max_papers_per_query,
    sourceRelevanceThreshold: config.source_relevance_threshold,
    ideaFragmentLimit: config.idea_fragment_limit,
    retryCount: config.retry_count,
    timeoutMs: config.timeout_ms,
    runId: args.runId || args.run_id || `agent-materials-live:${stableHash(`${targetDomain}:${targetProblem}:${nowIso()}`, 16)}`,
    traceId: args.traceId || args.trace_id || null,
    targetFieldOfStudy: args.targetFieldOfStudy || args.target_field_of_study || args.fieldsOfStudy || args.fields_of_study,
    ...(typeof llmJson === 'function' ? { llmJson } : {}),
    ...(typeof options.fetch === 'function' ? { fetch: options.fetch } : {})
  };
}

function liveDiscoveryQueryRows(live = {}) {
  return asArray(live.packetBundle?.cross_domain_queries || live.packet_bundle?.cross_domain_queries || live.cross_domain_queries)
    .flatMap((entry) => asArray(entry.queries || entry.source_search_queries || entry.query)
      .map((query) => ({
        target_challenge_id: entry.target_challenge_id || null,
        target_challenge: entry.target_challenge || null,
        source_domain: compactText(entry.source_domain || entry.domain),
        rationale: compactText(entry.rationale),
        query: compactText(query)
      })))
    .filter((entry) => entry.query);
}

function normalizeLiveDiscoveryEvidence(live = {}, config = {}, sparsity = {}) {
  const evidenceExport = live.evidence_export || {};
  const sourceDomainAnalyses = asArray(live.source_domain_analyses).map((entry) => ({
    source_domain: compactText(entry.source_domain),
    target_challenge_id: entry.target_challenge_id || null,
    target_challenge: entry.target_challenge || null,
    accepted: entry.accepted === true,
    pruning_decision: entry.pruning_decision || null,
    relevance_ratio: entry.relevance_ratio ?? null,
    relevant_paper_count: entry.relevant_paper_count ?? null,
    retrieved_paper_count: entry.retrieved_paper_count ?? null,
    retrieved_snippet_count: entry.retrieved_snippet_count ?? null,
    source_search_queries: entry.source_search_queries || [],
    rationale: entry.rationale || ''
  })).filter((entry) => entry.source_domain);
  const supportingPapers = asArray(evidenceExport.supporting_papers);
  return {
    ...liveDiscoveryPolicy(config),
    status: 'ok',
    trigger: sparsity,
    run_id: live.run_id || evidenceExport.run_id || null,
    trace_id: live.trace_id || evidenceExport.trace_id || null,
    packet_contract_version: live.packetBundle?.contractVersion || live.packet_bundle?.contractVersion || null,
    target_questions: evidenceExport.target_questions || asArray(live.decomposition?.research_questions),
    target_challenges: evidenceExport.target_challenges || asArray(live.target_domain_analysis).flatMap((entry) => asArray(entry.remaining_challenges)),
    source_domains: evidenceExport.source_domains || sourceDomainAnalyses.map((entry) => ({
      source_domain: entry.source_domain,
      accepted: entry.accepted,
      relevance_ratio: entry.relevance_ratio,
      relevant_paper_count: entry.relevant_paper_count,
      retrieved_paper_count: entry.retrieved_paper_count
    })),
    source_domain_queries: liveDiscoveryQueryRows(live),
    source_domain_analyses: sourceDomainAnalyses,
    source_takeaways: evidenceExport.source_takeaways || [],
    source_spans: evidenceExport.source_spans || [],
    supporting_papers: supportingPapers,
    idea_fragments: evidenceExport.idea_fragments || live.idea_fragments || [],
    interdisciplinary_ranking: evidenceExport.interdisciplinary_ranking || live.interdisciplinary_ranking || {},
    live_retrieval: live.live_retrieval || {},
    faithfulness_report: live.faithfulness_report || {},
    evidence_status: evidenceExport.evidence_status || null,
    llm_ledger_refs: evidenceExport.llm_ledger_refs || live.llm_ledger_refs || [],
    paper_count: unique(supportingPapers.map((entry) => entry.paper_key || entry.title).filter(Boolean)).length,
    result_count: supportingPapers.length,
    error_count: 0,
    limitation: 'Opt-in live Idea Catalyst evidence; materials are discovery evidence, not graph facts or novelty judgments.'
  };
}

async function collectLiveDiscoveryEvidence(args = {}, options = {}) {
  const config = liveDiscoveryConfig(args);
  const policy = liveDiscoveryPolicy(config);
  const sparsity = liveDiscoverySparsity(args, config);
  if (!config.enabled) {
    return {
      ...policy,
      status: 'disabled',
      trigger: sparsity,
      source_domains: [],
      source_domain_queries: [],
      source_domain_analyses: [],
      source_takeaways: [],
      source_spans: [],
      supporting_papers: [],
      idea_fragments: [],
      paper_count: 0,
      result_count: 0,
      error_count: 0,
      limitation: 'Live discovery evidence is disabled by default; set includeLiveDiscoveryEvidence=true to run bounded idea_catalyst live_discovery.'
    };
  }
  if (config.fallback_if_sparse && !config.include_always && !sparsity.graph_sparse) {
    return {
      ...policy,
      status: 'skipped_not_sparse',
      trigger: sparsity,
      source_domains: [],
      source_domain_queries: [],
      source_domain_analyses: [],
      source_takeaways: [],
      source_spans: [],
      supporting_papers: [],
      idea_fragments: [],
      paper_count: 0,
      result_count: 0,
      error_count: 0,
      limitation: 'Sparse live-discovery fallback was requested, but committed-graph evidence met the configured sparsity threshold.'
    };
  }

  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  if (!targetDomain || !targetProblem) {
    return {
      ...policy,
      status: 'skipped',
      trigger: sparsity,
      source_domains: [],
      source_domain_queries: [],
      source_domain_analyses: [],
      source_takeaways: [],
      source_spans: [],
      supporting_papers: [],
      idea_fragments: [],
      paper_count: 0,
      result_count: 0,
      error_count: 0,
      reason: 'targetDomain and targetProblem are required for live discovery evidence.'
    };
  }

  try {
    const live = await runLiveIdeaCatalyst(liveDiscoveryParams(args, config, targetDomain, targetProblem, options), options);
    return normalizeLiveDiscoveryEvidence(live, config, sparsity);
  } catch (error) {
    return {
      ...policy,
      status: 'error',
      trigger: sparsity,
      source_domains: [],
      source_domain_queries: [],
      source_domain_analyses: [],
      source_takeaways: [],
      source_spans: [],
      supporting_papers: [],
      idea_fragments: [],
      paper_count: 0,
      result_count: 0,
      error_count: 1,
      error: truncate(error?.message || String(error), 360),
      limitation: 'Live discovery evidence failed; committed-graph and provider material assembly continued.'
    };
  }
}

function classifyLiveDiscoveryDomain(sourceDomain = '', targetDomain = '', matrix = null) {
  const domainDistance = scoreDomainDistance(matrix, targetDomain, sourceDomain);
  const layer = domainDistance <= 0.45 ? 'near_source' : 'far_source';
  return {
    layer,
    role: layer === 'near_source' ? 'near_source_method' : 'far_source_story',
    domain_distance: Number(domainDistance.toFixed(4))
  };
}

function liveDiscoveryCandidatesFromEvidence(liveEvidence = {}, context = {}, targetDomain = '', limit = 5) {
  if (liveEvidence.status !== 'ok') return [];
  const queryByDomain = new Map();
  for (const row of liveEvidence.source_domain_queries || []) {
    if (!queryByDomain.has(row.source_domain)) queryByDomain.set(row.source_domain, row.query);
  }
  const candidates = asArray(liveEvidence.supporting_papers).map((paper) => {
    const sourceDomain = compactText(paper.source_domain);
    const classification = classifyLiveDiscoveryDomain(sourceDomain, targetDomain, liveEvidence.domain_distance_matrix || context.domainDistanceMatrix);
    const sourceSpans = asArray(liveEvidence.source_spans).filter((span) => (
      compactText(span.paper_key) === compactText(paper.paper_key)
      || (paper.title && normalizeTitle(span.paper_title) === normalizeTitle(paper.title))
    ));
    const sourceTakeaways = asArray(liveEvidence.source_takeaways).filter((takeaway) => (
      normalizeTitle(takeaway.source_domain) === normalizeTitle(sourceDomain)
      && (!takeaway.paper_keys?.length || takeaway.paper_keys.includes(paper.paper_key))
    ));
    const ideaFragments = asArray(liveEvidence.idea_fragments).filter((fragment) => (
      normalizeTitle(fragment.source_domain) === normalizeTitle(sourceDomain)
      || asArray(fragment.supporting_paper_keys).includes(paper.paper_key)
    ));
    return {
      paper_id: compactText(paper.paper_key) || `live:${stableHash(paper.title || sourceDomain, 16)}`,
      title: compactText(paper.title || paper.paper_key),
      role: classification.role,
      layer: classification.layer,
      source_domain: sourceDomain || null,
      domain_distance: classification.domain_distance,
      proximal_leakage: false,
      query: queryByDomain.get(sourceDomain) || null,
      source_query: queryByDomain.get(sourceDomain) || null,
      score: Number(Math.min(1, 0.45 + Number(paper.snippet_count || sourceSpans.length || 0) * 0.08).toFixed(4)),
      status: 'discovered',
      discovery_source: 'idea_catalyst_live_discovery',
      live_discovery_evidence: {
        source_spans: sourceSpans,
        source_takeaways: sourceTakeaways,
        idea_fragments: ideaFragments
      },
      matches: sourceSpans.map((span) => ({
        node_type: 'live_discovery_span',
        node_id: span.span_id,
        node_name: paper.title,
        text: span.text,
        score: null
      }))
    };
  }).filter((candidate) => candidate.title);
  return mergeCandidateLists(candidates, limit);
}

function liveDiscoveryRequisitionsFromEvidence(liveEvidence = {}, manifest = {}, targetDomain = '', matrix = null, limit = 12) {
  if (liveEvidence.status !== 'ok') return [];
  const requisitions = [];
  for (const paper of asArray(liveEvidence.supporting_papers)) {
    if (!paper.title) continue;
    const materialized = findSourceEntries(manifest, {
      paperId: paper.paper_key,
      title: paper.title
    }).length > 0;
    if (materialized) continue;
    const classification = classifyLiveDiscoveryDomain(paper.source_domain, targetDomain, matrix);
    requisitions.push(requisitionForPaper({
      title: paper.title,
      role: classification.role,
      priority: classification.role === 'near_source_method' ? 'medium' : 'low',
      sourceHints: []
    }, `Idea Catalyst live_discovery supporting paper from ${paper.source_domain || 'source domain'} is not materialized in this corpus.`));
    if (requisitions.length >= limit) break;
  }
  return dedupeRequisitions(requisitions);
}

function liveDiscoverySeedPapersFromEvidence(liveEvidence = {}, limit = 8) {
  if (liveEvidence.status !== 'ok') return [];
  const sourceSpans = asArray(liveEvidence.source_spans);
  const seeds = [];
  const seen = new Set();
  for (const paper of asArray(liveEvidence.supporting_papers)) {
    const title = compactText(paper.title || paper.paperTitle || paper.paper_title);
    if (!title) continue;
    const paperKey = compactText(paper.paper_key || paper.paperKey || paper.paper_id || paper.paperId || paper.corpusId);
    const identifiers = identifiersOf(paper);
    const dedupeKey = identifiers.doi || identifiers.arxivId || identifiers.pmid || identifiers.pmcid || paperKey || normalizeTitle(title);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const matchedSpans = sourceSpans.filter((span) => (
      (paperKey && compactText(span.paper_key || span.paperKey) === paperKey)
      || normalizeTitle(span.paper_title || span.paperTitle) === normalizeTitle(title)
    ));
    const abstract = compactText(paper.abstract || paper.summary || matchedSpans.map((span) => span.text).filter(Boolean).join(' '));
    const sourceDomain = compactText(paper.source_domain || paper.sourceDomain);
    seeds.push({
      id: paperKey || `live:${stableHash(title, 16)}`,
      title,
      authors: asArray(paper.authors),
      year: paper.year || paper.publication_year || paper.publicationYear || null,
      venue: paper.venue || paper.journal || paper.conference || null,
      identifiers,
      abstract: truncate(abstract, 800),
      sourceDomain,
      source_domain: sourceDomain,
      seedSource: 'idea_catalyst_live_discovery',
      seed_source: 'idea_catalyst_live_discovery',
      paperKey,
      paper_key: paperKey,
      sourceHints: unique([
        paper.markdownUrl,
        paper.markdown_url,
        paper.pdfUrl,
        paper.pdf_url,
        paper.url,
        paper.landingPageUrl,
        paper.landing_page_url
      ].map((entry) => String(entry || '').trim()).filter(Boolean))
    });
    if (seeds.length >= limit) break;
  }
  return seeds;
}

function literatureDiscoveryConfig(args = {}) {
  const includeAlways = booleanFlag(
    args.includeLiteratureDiscoveryEvidence
      ?? args.include_literature_discovery_evidence,
    false
  );
  const fallbackIfSparse = booleanFlag(
    args.runLiteratureDiscoveryIfSparse
      ?? args.run_literature_discovery_if_sparse
      ?? args.literatureDiscoveryFallbackIfSparse
      ?? args.literature_discovery_fallback_if_sparse,
    false
  );
  const submitImports = booleanFlag(
    args.submitLiteratureDiscoveryImports
      ?? args.submit_literature_discovery_imports
      ?? args.literatureDiscoveryImportResolved
      ?? args.literature_discovery_import_resolved,
    false
  );
  const processImports = booleanFlag(
    args.processLiteratureDiscoveryImports
      ?? args.process_literature_discovery_imports
      ?? args.waitForLiteratureDiscoveryImports
      ?? args.wait_for_literature_discovery_imports,
    false
  );
  const resolveSources = booleanFlag(
    args.literatureDiscoveryResolveSources
      ?? args.literature_discovery_resolve_sources,
    true
  );
  const allowDownloads = booleanFlag(
    args.literatureDiscoveryAllowDownloads
      ?? args.literature_discovery_allow_downloads,
    true
  );
  return {
    enabled: includeAlways || fallbackIfSparse || submitImports || processImports,
    include_always: includeAlways,
    fallback_if_sparse: fallbackIfSparse,
    trigger_mode: includeAlways || submitImports || processImports
      ? 'always'
      : (fallbackIfSparse ? 'graph_sparse_fallback' : 'disabled'),
    backend: 'literature_discovery',
    resolve_sources: resolveSources,
    allow_downloads: allowDownloads,
    prefer_markdown: booleanFlag(args.literatureDiscoveryPreferMarkdown ?? args.literature_discovery_prefer_markdown, true),
    persist_run: booleanFlag(args.persistLiteratureDiscoveryRun ?? args.persist_literature_discovery_run, false),
    submit_imports: submitImports || processImports,
    process_imports: processImports,
    max_queries: boundedInteger(args.literatureDiscoveryMaxQueries ?? args.literature_discovery_max_queries, 4, { max: 16 }),
    max_results_per_query: boundedInteger(args.literatureDiscoveryMaxResultsPerQuery ?? args.literature_discovery_max_results_per_query, 8, { max: 50 }),
    max_candidates: boundedInteger(args.literatureDiscoveryMaxCandidates ?? args.literature_discovery_max_candidates, 16, { max: 120 }),
    max_downloads: boundedInteger(args.literatureDiscoveryMaxDownloads ?? args.literature_discovery_max_downloads, 6, { min: 0, max: 40 }),
    max_imported: boundedInteger(args.literatureDiscoveryMaxImported ?? args.literature_discovery_max_imported, 4, { min: 1, max: 40 }),
    max_import_passes: boundedInteger(args.literatureDiscoveryImportMaxPasses ?? args.literature_discovery_import_max_passes, 4, { min: 1, max: 40 }),
    provider_concurrency: boundedInteger(args.literatureDiscoveryProviderConcurrency ?? args.literature_discovery_provider_concurrency, 2, { min: 1, max: 8 }),
    download_concurrency: boundedInteger(args.literatureDiscoveryDownloadConcurrency ?? args.literature_discovery_download_concurrency, 2, { min: 1, max: 8 }),
    seed_query_limit: boundedInteger(args.literatureDiscoverySeedQueryLimit ?? args.literature_discovery_seed_query_limit, 8, { min: 0, max: 40 }),
    seed_provider_papers: booleanFlag(args.literatureDiscoverySeedProviderPapers ?? args.literature_discovery_seed_provider_papers, false),
    provider_seed_limit: boundedInteger(args.literatureDiscoveryProviderSeedLimit ?? args.literature_discovery_provider_seed_limit, 8, { min: 1, max: 80 }),
    seed_live_discovery_papers: booleanFlag(args.literatureDiscoverySeedLivePapers ?? args.literature_discovery_seed_live_papers, false),
    live_seed_limit: boundedInteger(args.literatureDiscoveryLiveSeedLimit ?? args.literature_discovery_live_seed_limit, 8, { min: 1, max: 80 }),
    requisition_limit: boundedInteger(args.literatureDiscoveryRequisitionLimit ?? args.literature_discovery_requisition_limit, 12, { min: 1, max: 80 }),
    sparse_role_threshold: boundedInteger(args.literatureDiscoverySparseRoleThreshold ?? args.literature_discovery_sparse_role_threshold, 1, { min: 1, max: 10 }),
    import_batch_enabled: booleanFlag(args.literatureDiscoveryImportBatchEnabled ?? args.literature_discovery_import_batch_enabled, true),
    import_batch_max_tasks: boundedInteger(args.literatureDiscoveryImportBatchMaxTasks ?? args.literature_discovery_import_batch_max_tasks, 8, { min: 1, max: 64 })
  };
}

function literatureDiscoveryPolicy(config = {}) {
  const sideEffects = ['provider_network_search'];
  if (config.resolve_sources) sideEffects.push('source_resolution');
  if (config.resolve_sources && config.allow_downloads) sideEffects.push('fulltext_download_staging');
  if (config.persist_run) sideEffects.push('discovery_run_artifact_write');
  if (config.submit_imports) sideEffects.push('import_queue_submit');
  if (config.process_imports) sideEffects.push('import_worker_process');
  return {
    backend: config.backend || 'literature_discovery',
    enabled: Boolean(config.enabled),
    trigger_mode: config.trigger_mode || 'disabled',
    fallback_if_sparse: Boolean(config.fallback_if_sparse),
    sparse_role_threshold: config.sparse_role_threshold,
    resolve_sources: Boolean(config.resolve_sources),
    allow_downloads: Boolean(config.allow_downloads),
    prefer_markdown: Boolean(config.prefer_markdown),
    persist_run: Boolean(config.persist_run),
    submit_imports: Boolean(config.submit_imports),
    process_imports: Boolean(config.process_imports),
    max_queries: config.max_queries,
    max_results_per_query: config.max_results_per_query,
    max_candidates: config.max_candidates,
    max_downloads: config.max_downloads,
    max_imported: config.max_imported,
    seed_provider_papers: Boolean(config.seed_provider_papers),
    provider_seed_limit: config.provider_seed_limit,
    seed_live_discovery_papers: Boolean(config.seed_live_discovery_papers),
    live_seed_limit: config.live_seed_limit,
    graph_read_only: !config.process_imports,
    queue_read_only: !config.submit_imports,
    side_effects: config.enabled ? sideEffects : []
  };
}

function literatureDiscoverySparsity(args = {}, config = {}, planning = {}) {
  const trigger = normalizeObject(args.literatureDiscoveryTrigger || args.literature_discovery_trigger);
  const sparseRoles = unique([
    ...asArray(trigger.sparse_roles || trigger.sparseRoles),
    ...asArray(planning.sparse_roles || planning.sparseRoles)
  ].map((role) => compactText(role)).filter(Boolean));
  const sparseRoleCount = Number.isFinite(Number(trigger.sparse_role_count ?? trigger.sparseRoleCount))
    ? Number(trigger.sparse_role_count ?? trigger.sparseRoleCount)
    : sparseRoles.length;
  const graphSparse = trigger.graph_sparse !== undefined || trigger.graphSparse !== undefined
    ? booleanFlag(trigger.graph_sparse ?? trigger.graphSparse, false)
    : sparseRoleCount >= (config.sparse_role_threshold || 1);
  return {
    graph_sparse: graphSparse,
    sparse_roles: sparseRoles,
    sparse_role_count: sparseRoleCount,
    sparse_role_threshold: config.sparse_role_threshold || 1,
    graph_candidate_score_threshold: planning.graph_candidate_score_threshold ?? trigger.graph_candidate_score_threshold ?? trigger.graphCandidateScoreThreshold ?? null,
    role_graph_candidate_counts: normalizeObject(planning.role_graph_candidate_counts || planning.roleGraphCandidateCounts || trigger.role_graph_candidate_counts || trigger.roleGraphCandidateCounts)
  };
}

function generatedLiteratureDiscoveryQueries(planning = {}, config = {}) {
  return unique([
    ...asArray(planning.target_queries),
    ...asArray(planning.near_source_queries),
    ...asArray(planning.far_source_queries),
    ...asArray(planning.source_domain_queries).map((entry) => entry?.query || entry)
  ].map(compactText).filter(Boolean)).slice(0, config.seed_query_limit);
}

function literatureDiscoverySeedPaperSummary(seed = {}) {
  return {
    title: compactText(seed.title || seed.paperTitle || seed.paper_title),
    identifiers: identifiersOf(seed),
    seed_source: compactText(seed.seed_source || seed.seedSource || 'client_seed'),
    source_domain: compactText(seed.source_domain || seed.sourceDomain),
    paper_key: compactText(seed.paper_key || seed.paperKey || seed.id)
  };
}

function dedupeLiteratureSeedPapers(seeds = []) {
  const seen = new Set();
  const deduped = [];
  for (const seed of seeds) {
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) continue;
    const summary = literatureDiscoverySeedPaperSummary(seed);
    const key = summary.identifiers.doi
      || summary.identifiers.arxivId
      || summary.identifiers.pmid
      || summary.identifiers.pmcid
      || summary.paper_key
      || normalizeTitle(summary.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(seed);
  }
  return deduped;
}

function literatureDiscoverySeedPapers(args = {}, planning = {}, config = {}) {
  const explicitSeeds = asArray(args.seedPapers || args.seed_papers);
  const providerSeeds = config.seed_provider_papers
    ? providerSeedPapersFromEvidence(planning.provider_evidence, config.provider_seed_limit)
    : [];
  const liveSeeds = config.seed_live_discovery_papers
    ? liveDiscoverySeedPapersFromEvidence(planning.live_discovery_evidence, config.live_seed_limit)
    : [];
  return dedupeLiteratureSeedPapers([
    ...explicitSeeds,
    ...providerSeeds,
    ...liveSeeds
  ]);
}

function literatureDiscoveryTopic(args = {}, planning = {}) {
  return compactText(
    args.literatureDiscoveryTopic
      || args.literature_discovery_topic
      || [
        planning.target_problem,
        planning.target_domain,
        ...normalizeConstraints(args.constraints || args.constraint).slice(0, 3)
      ].filter(Boolean).join(' ')
      || args.query
      || args.problem
  );
}

function literatureDiscoveryRunParams(args = {}, context = {}, planning = {}, config = {}) {
  const seedTexts = generatedLiteratureDiscoveryQueries(planning, config);
  const seedPapers = literatureDiscoverySeedPapers(args, planning, config);
  return {
    ...args,
    rootPath: context.rootPath,
    topic: literatureDiscoveryTopic(args, planning),
    depth: args.literatureDiscoveryDepth || args.literature_discovery_depth || 'quick',
    discipline: args.literatureDiscoveryDiscipline || args.literature_discovery_discipline || args.discipline,
    maxQueries: config.max_queries,
    maxResultsPerQuery: config.max_results_per_query,
    maxCandidates: config.max_candidates,
    maxDownloads: config.max_downloads,
    providerConcurrency: config.provider_concurrency,
    downloadConcurrency: config.download_concurrency,
    preferMarkdown: config.prefer_markdown,
    allowDownloads: config.allow_downloads,
    resolveSources: config.resolve_sources,
    persist: config.persist_run,
    seedTexts,
    seedPapers,
    maxSeedPapers: seedPapers.length || undefined,
    maxSeedQueries: seedTexts.length + seedPapers.length,
    maxEntityQueries: config.seed_query_limit,
    providers: args.literatureDiscoveryProviders || args.literature_discovery_providers || args.providers,
    runId: args.literatureDiscoveryRunId || args.literature_discovery_run_id || args.runId || args.run_id
  };
}

function normalizeLiteratureDiscoveryCandidate(candidate = {}, manifest = {}) {
  const identifiers = identifiersOf(candidate);
  const source = normalizeObject(candidate.source);
  const materialized = findSourceEntries(manifest, {
    paperId: candidate.canonicalId || candidate.id,
    title: candidate.title,
    identifiers,
    ...identifiers
  }).length > 0;
  return {
    candidate_id: candidate.id || null,
    canonical_id: candidate.canonicalId || null,
    title: compactText(candidate.title),
    authors: asArray(candidate.authors),
    year: candidate.year || null,
    venue: candidate.venue || null,
    identifiers,
    abstract: truncate(candidate.abstract || candidate.summary || '', 600),
    providers: asArray(candidate.providers || candidate.provider).filter(Boolean),
    provider_agreement_count: candidate.providerAgreementCount || null,
    identity_confidence: candidate.identityConfidence || null,
    source: {
      resolution_status: source.resolutionStatus || 'metadata_only',
      source_kind: source.sourceKind || 'metadata_only',
      full_text_status: source.fullTextStatus || 'unknown',
      source_provider: source.sourceProvider || '',
      source_path: source.sourcePath || '',
      markdown_url: source.markdownUrl || candidate.markdownUrl || '',
      pdf_url: source.pdfUrl || candidate.pdfUrl || ''
    },
    materialized,
    import: candidate.import || { status: 'not_submitted' }
  };
}

function literatureDiscoveryCandidatesFromEvidence(evidence = {}, limit = 12) {
  if (evidence.status !== 'ok') return [];
  return asArray(evidence.candidates).slice(0, limit).map((candidate) => ({
    paper_id: candidate.canonical_id || candidate.candidate_id || `literature:${stableHash(candidate.title || JSON.stringify(candidate), 16)}`,
    title: candidate.title,
    role: 'literature_discovery_candidate',
    layer: 'online_discovery',
    score: candidate.identity_confidence === 'strong' ? 0.55 : 0.35,
    status: candidate.materialized ? 'in_graph_or_manifest' : 'discovered',
    discovery_source: 'literature_discovery',
    identifiers: candidate.identifiers,
    abstract: candidate.abstract,
    literature_discovery_evidence: {
      source: candidate.source,
      import: candidate.import,
      providers: candidate.providers
    },
    matches: [{
      node_type: 'literature_discovery_candidate',
      node_id: candidate.canonical_id || candidate.candidate_id,
      node_name: candidate.title,
      text: candidate.abstract,
      score: null
    }]
  })).filter((candidate) => candidate.title);
}

function literatureDiscoveryRequisitionsFromEvidence(evidence = {}, manifest = {}, limit = 12) {
  if (evidence.status !== 'ok') return [];
  const requisitions = [];
  for (const candidate of asArray(evidence.candidates)) {
    if (!candidate.title || candidate.materialized) continue;
    const source = normalizeObject(candidate.source);
    const importStatus = candidate.import?.status || 'not_submitted';
    const hasResolvedSource = source.resolution_status === 'fulltext_ready' && source.source_path;
    const reason = hasResolvedSource
      ? (importStatus === 'not_submitted'
          ? 'Literature discovery resolved a full-text source; review and submit it for graph import.'
          : `Literature discovery submitted or reconciled this full-text source with import status ${importStatus}.`)
      : 'Literature discovery found a metadata-only candidate; supplement a legal markdown/open-PDF source before graph import.';
    requisitions.push(requisitionForPaper({
      title: candidate.title,
      identifiers: candidate.identifiers,
      role: 'literature_discovery_candidate',
      priority: hasResolvedSource ? 'high' : 'medium',
      markdownUrl: source.markdown_url,
      pdfUrl: source.pdf_url,
      sourceHints: [
        source.source_path,
        source.markdown_url,
        source.pdf_url
      ].filter(Boolean)
    }, reason));
    if (requisitions.length >= limit) break;
  }
  return dedupeRequisitions(requisitions.filter((requisition) => (
    !findSourceEntries(manifest, {
      title: requisition.title,
      identifiers: requisition.identifiers,
      ...requisition.identifiers
    }).length
  )));
}

function countProcessableLiteratureImportTasks(importResult = {}) {
  return asArray(importResult.results).filter((entry) => {
    if (!entry.taskId) return false;
    if (entry.status === 'submitted') return true;
    if (entry.status !== 'deduped') return false;
    const taskStatus = compactText(entry.taskStatus).toLowerCase();
    return taskStatus !== 'completed' && taskStatus !== 'failed';
  }).length;
}

async function refreshLiteratureImportTaskStatuses(rootPath, importResult = {}) {
  const results = [];
  for (const entry of asArray(importResult.results)) {
    if (!entry.taskId) {
      results.push(entry);
      continue;
    }
    try {
      const task = await loadImportTask(rootPath, entry.taskId);
      const taskStatus = compactText(task?.status).toLowerCase();
      const status = taskStatus === 'completed'
        ? 'completed'
        : (taskStatus === 'failed' ? 'failed' : entry.status);
      results.push({
        ...entry,
        status,
        taskStatus: taskStatus || entry.status,
        taskStage: task?.stage || '',
        graphUpdate: task?.result?.fastCommitted
          ? {
              paperCount: task.result.fastCommitted.paperCount || 0,
              nodeCount: task.result.fastCommitted.nodeCount || 0,
              relationshipCount: task.result.fastCommitted.relationshipCount || 0,
              authoritativeSyncStatus: task.result.authoritativeSync?.status || ''
            }
          : null,
        error: task?.error?.message || task?.error || entry.error || ''
      });
    } catch (error) {
      results.push({
        ...entry,
        taskStatus: entry.taskStatus || entry.status,
        error: entry.error || error?.message || ''
      });
    }
  }
  return {
    ...importResult,
    completed: results.filter((entry) => entry.status === 'completed').length,
    queued: results.filter((entry) => entry.status === 'submitted').length,
    deduped: results.filter((entry) => entry.status === 'deduped').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results
  };
}

function literatureDiscoveryImportProcessingOptions(args = {}, options = {}, importResult = {}, config = {}) {
  const runtimeConfig = normalizeObject(options.config);
  const importConfig = normalizeObject(runtimeConfig.imports || runtimeConfig.import);
  const submittedTaskCount = countProcessableLiteratureImportTasks(importResult);
  return {
    ...options,
    maxPasses: firstDefined(
      args.literatureDiscoveryImportMaxPasses,
      args.literature_discovery_import_max_passes,
      Math.max(1, Math.min(config.max_import_passes || 4, submittedTaskCount || config.max_imported || 1))
    ),
    importBatchEnabled: firstDefined(
      args.literatureDiscoveryImportBatchEnabled,
      args.literature_discovery_import_batch_enabled,
      args.importBatchEnabled,
      args.import_batch_enabled,
      options.importBatchEnabled,
      options.batchEnabled,
      importConfig.importBatchEnabled,
      importConfig.batchEnabled,
      config.import_batch_enabled,
      true
    ),
    importBatchMaxTasks: firstDefined(
      args.literatureDiscoveryImportBatchMaxTasks,
      args.literature_discovery_import_batch_max_tasks,
      args.importBatchMaxTasks,
      args.import_batch_max_tasks,
      options.importBatchMaxTasks,
      options.batchMaxTasks,
      importConfig.importBatchMaxTasks,
      importConfig.batchMaxTasks,
      config.import_batch_max_tasks,
      8
    ),
    importBatchMaxFiles: firstDefined(
      args.literatureDiscoveryImportBatchMaxFiles,
      args.literature_discovery_import_batch_max_files,
      args.importBatchMaxFiles,
      args.import_batch_max_files,
      options.importBatchMaxFiles,
      options.batchMaxFiles,
      importConfig.importBatchMaxFiles,
      importConfig.batchMaxFiles
    ),
    importBatchMaxBytes: firstDefined(
      args.literatureDiscoveryImportBatchMaxBytes,
      args.literature_discovery_import_batch_max_bytes,
      args.importBatchMaxBytes,
      args.import_batch_max_bytes,
      options.importBatchMaxBytes,
      options.batchMaxBytes,
      importConfig.importBatchMaxBytes,
      importConfig.batchMaxBytes
    )
  };
}

async function submitLiteratureDiscoveryImports(run = {}, args = {}, context = {}, config = {}, options = {}) {
  const submitter = typeof options.submitDiscoveryImports === 'function'
    ? options.submitDiscoveryImports
    : submitDiscoveryImports;
  let importResult = await submitter({
    corpus: args.corpus || context.rootPath,
    candidates: run.candidates || [],
    maxImported: config.max_imported,
    options
  });
  if (!config.process_imports) return importResult;

  importResult = await refreshLiteratureImportTaskStatuses(context.rootPath, importResult);
  const processableTaskCount = countProcessableLiteratureImportTasks(importResult);
  const runner = typeof options.runImportQueueUntilIdle === 'function'
    ? options.runImportQueueUntilIdle
    : runImportQueueUntilIdle;
  const processing = processableTaskCount > 0
    ? await runner(context.rootPath, literatureDiscoveryImportProcessingOptions(args, options, importResult, config))
    : {
        completedTaskIds: [],
        failedCount: 0,
        skipped: true,
        reason: 'no-submitted-imports'
      };
  return {
    ...(await refreshLiteratureImportTaskStatuses(context.rootPath, importResult)),
    processing
  };
}

function applyLiteratureDiscoveryImportsToRun(run = {}, importResult = {}) {
  const importsByCanonicalId = new Map(asArray(importResult.results).map((entry) => [entry.canonicalId, entry]));
  return {
    ...run,
    candidates: asArray(run.candidates).map((candidate) => {
      const importEntry = importsByCanonicalId.get(candidate.canonicalId);
      return {
        ...candidate,
        import: importEntry
          ? {
              status: importEntry.status,
              taskId: importEntry.taskId || null,
              taskStatus: importEntry.taskStatus || importEntry.status || '',
              taskStage: importEntry.taskStage || '',
              graphUpdate: importEntry.graphUpdate || null,
              error: importEntry.error || ''
            }
          : {
              status: 'not_submitted'
            }
      };
    }),
    importSummary: importResult
  };
}

function normalizeLiteratureDiscoveryEvidence(run = {}, config = {}, sparsity = {}, importResult = null, manifest = {}, seedPapers = []) {
  const candidates = asArray(run.candidates).map((candidate) => normalizeLiteratureDiscoveryCandidate(candidate, manifest));
  const importableCandidates = candidates.filter((candidate) => (
    candidate.source.resolution_status === 'fulltext_ready'
    && candidate.source.source_path
  ));
  return {
    ...literatureDiscoveryPolicy(config),
    status: 'ok',
    trigger: sparsity,
    run_id: run.runId || run.run_id || null,
    topic: run.topic || run.plan?.topic || null,
    plan_queries: asArray(run.plan?.queries).map((entry) => ({
      id: entry.id || null,
      query: entry.query || '',
      family: entry.family || '',
      rationale: entry.rationale || ''
    })),
    query_coverage: run.coverage?.queryCoverage || [],
    coverage: run.coverage || null,
    resolution_summary: run.resolutionSummary || null,
    artifacts: run.artifacts || null,
    seed_papers: seedPapers.map(literatureDiscoverySeedPaperSummary),
    seed_paper_count: seedPapers.length,
    candidates,
    candidate_count: candidates.length,
    importable_count: importableCandidates.length,
    importable_candidates: importableCandidates,
    import_summary: importResult,
    recommended_next_action: config.submit_imports
      ? (config.process_imports ? 'Inspect import_summary.processing and verify completed task ids before relying on graph visibility.' : 'Use import_workflow wait/status for submitted task ids before relying on graph visibility.')
      : (importableCandidates.length ? 'Review importable_candidates; set submitLiteratureDiscoveryImports=true to enqueue selected resolved sources.' : 'Supplement metadata-only candidates with legal markdown/open-PDF sources, or rerun with broader discovery limits.'),
    limitation: 'Opt-in online discovery/resolve/import bridge; returned candidates are discovery materials until import tasks complete and the graph is synced.'
  };
}

async function collectLiteratureDiscoveryEvidence(args = {}, context = {}, planning = {}, options = {}) {
  const config = literatureDiscoveryConfig(args);
  const policy = literatureDiscoveryPolicy(config);
  const sparsity = literatureDiscoverySparsity(args, config, planning);
  if (!config.enabled) {
    return {
      ...policy,
      status: 'disabled',
      trigger: sparsity,
      run_id: null,
      plan_queries: [],
      candidates: [],
      candidate_count: 0,
      importable_count: 0,
      importable_candidates: [],
      import_summary: null,
      limitation: 'Literature discovery evidence is disabled by default; set includeLiteratureDiscoveryEvidence=true to run bounded literature_discovery resolve evidence.'
    };
  }
  if (config.fallback_if_sparse && !config.include_always && !config.submit_imports && !sparsity.graph_sparse) {
    return {
      ...policy,
      status: 'skipped_not_sparse',
      trigger: sparsity,
      run_id: null,
      plan_queries: [],
      candidates: [],
      candidate_count: 0,
      importable_count: 0,
      importable_candidates: [],
      import_summary: null,
      limitation: 'Sparse literature-discovery fallback was requested, but committed-graph evidence met the configured sparsity threshold.'
    };
  }

  const topic = literatureDiscoveryTopic(args, planning);
  if (!topic) {
    return {
      ...policy,
      status: 'skipped',
      trigger: sparsity,
      run_id: null,
      plan_queries: [],
      candidates: [],
      candidate_count: 0,
      importable_count: 0,
      importable_candidates: [],
      import_summary: null,
      reason: 'targetProblem, query, or literatureDiscoveryTopic is required for literature discovery evidence.'
    };
  }

  try {
    const runner = typeof options.runLiteratureDiscovery === 'function'
      ? options.runLiteratureDiscovery
      : runLiteratureDiscovery;
    const runParams = literatureDiscoveryRunParams(args, context, planning, config);
    let run = await runner(runParams, options);
    let importResult = null;
    if (config.submit_imports) {
      importResult = await submitLiteratureDiscoveryImports(run, args, context, config, options);
      run = applyLiteratureDiscoveryImportsToRun(run, importResult);
    }
    return normalizeLiteratureDiscoveryEvidence(run, config, sparsity, importResult, context.manifest, runParams.seedPapers);
  } catch (error) {
    return {
      ...policy,
      status: 'error',
      trigger: sparsity,
      run_id: null,
      plan_queries: [],
      candidates: [],
      candidate_count: 0,
      importable_count: 0,
      importable_candidates: [],
      import_summary: null,
      error_count: 1,
      error: truncate(error?.message || String(error), 360),
      limitation: 'Literature discovery evidence failed; committed-graph, provider, and live-discovery material assembly continued.'
    };
  }
}

function liveDiscoveryEvidenceItems(liveEvidence = {}) {
  const spans = asArray(liveEvidence.source_spans).map((span) => ({
    item_type: 'live_discovery_span',
    source_type: 'idea_catalyst_live_discovery',
    source_id: span.span_id || span.paper_key,
    role: 'far_source_story',
    paper_id: span.paper_key || null,
    title: span.paper_title || null,
    text: span.text || null,
    source_domain: span.source_domain || null,
    provenance: {
      source_type: 'idea_catalyst_live_discovery',
      run_id: liveEvidence.run_id || null,
      trace_id: liveEvidence.trace_id || null,
      source_domain: span.source_domain || null,
      paper_key: span.paper_key || null,
      span_id: span.span_id || null,
      section: span.section || null
    }
  }));
  const fragments = asArray(liveEvidence.idea_fragments).map((fragment) => ({
    item_type: 'idea_fragment',
    source_type: 'idea_catalyst_live_discovery',
    source_id: fragment.id || fragment.fragment_id,
    role: 'far_source_story',
    paper_id: null,
    title: fragment.title || null,
    text: fragment.integration_rationale || fragment.target_challenge || null,
    source_domain: fragment.source_domain || null,
    provenance: {
      source_type: 'idea_catalyst_live_discovery',
      run_id: liveEvidence.run_id || null,
      trace_id: liveEvidence.trace_id || null,
      source_domain: fragment.source_domain || null,
      fragment_id: fragment.id || fragment.fragment_id || null,
      supporting_paper_keys: fragment.supporting_paper_keys || []
    }
  }));
  return [...spans, ...fragments].filter((entry) => entry.source_id || entry.text || entry.title);
}

function evidenceRecordFromLiveDiscoveryItem(item = {}, args = {}, scope = 'live_discovery_evidence') {
  const evidenceId = `live-discovery-evidence:${stableHash([
    args.project || '',
    scope,
    item.source_type || '',
    item.source_id || '',
    item.text || item.title || ''
  ].join(':'), 20)}`;
  return {
    action: 'add',
    project: args.project,
    actor: compactText(args.actor || args.createdBy || args.created_by) || 'agent_materials',
    evidenceId,
    itemType: item.item_type,
    sourceType: item.source_type,
    sourceId: item.source_id,
    role: item.role || null,
    paperId: item.paper_id || null,
    paperTitle: item.title || null,
    text: item.text || null,
    tags: unique([
      'live_discovery_evidence',
      scope,
      item.source_domain,
      item.item_type
    ].map(compactText).filter(Boolean)),
    provenance: [item.provenance],
    notes: 'Persisted idea_catalyst live_discovery material; not a graph fact or novelty judgment.'
  };
}

async function persistLiveDiscoveryEvidence(liveEvidence = {}, args = {}, context = {}, scope = 'live_discovery_evidence') {
  const config = liveDiscoveryConfig(args);
  if (!config.persist) {
    return {
      enabled: false,
      requested: false,
      status: 'not_requested',
      persisted_count: 0
    };
  }
  if (!config.enabled) {
    return {
      enabled: false,
      requested: true,
      status: 'skipped',
      reason: 'includeLiveDiscoveryEvidence must be true before live discovery evidence can be persisted.',
      persisted_count: 0
    };
  }
  if (!compactText(args.project)) {
    return {
      enabled: false,
      requested: true,
      status: 'skipped',
      reason: 'project is required to persist live discovery evidence into the evidence cart.',
      persisted_count: 0
    };
  }
  if (liveEvidence.status !== 'ok') {
    return {
      enabled: false,
      requested: true,
      status: 'skipped',
      reason: `live discovery evidence status is ${liveEvidence.status || 'unknown'}.`,
      persisted_count: 0
    };
  }

  const items = liveDiscoveryEvidenceItems(liveEvidence).slice(0, config.persist_limit);
  const evidenceIds = [];
  for (const item of items) {
    const evidence = evidenceRecordFromLiveDiscoveryItem(item, args, scope);
    const result = await executeEvidenceCart(evidence, { rootPath: context.rootPath });
    evidenceIds.push(result.event?.evidence_id || evidence.evidenceId);
  }
  return {
    enabled: true,
    requested: true,
    status: 'persisted',
    overlay: await loadProjectOverlaySummary(context.rootPath, args.project),
    persisted_count: evidenceIds.length,
    evidence_ids: evidenceIds
  };
}

function dedupeRequisitions(requisitions = []) {
  const byKey = new Map();
  for (const requisition of requisitions) {
    const identifiers = requisition.identifiers || {};
    const key = JSON.stringify({
      title: normalizeTitle(requisition.title),
      doi: identifiers.doi || '',
      arxivId: identifiers.arxivId || '',
      pmid: identifiers.pmid || '',
      pmcid: identifiers.pmcid || '',
      semanticScholarPaperId: identifiers.semanticScholarPaperId || ''
    });
    if (!byKey.has(key)) byKey.set(key, requisition);
  }
  return [...byKey.values()];
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

function collectGraphDomainNames(graph) {
  if (!graph) return [];
  const domains = [];
  if (typeof graph.getNodesByType === 'function') {
    for (const node of graph.getNodesByType(NODE_TYPES.DOMAIN)) {
      domains.push(node.name || node.properties?.name);
    }
  }
  for (const node of graph.nodes || []) {
    domains.push(
      node.properties?.fieldOfStudy,
      node.properties?.targetDomain,
      ...(Array.isArray(node.properties?.fieldCandidates) ? node.properties.fieldCandidates : []),
      ...(Array.isArray(node.properties?.domainTags) ? node.properties.domainTags : []),
      ...(Array.isArray(node.properties?.sourceDomains) ? node.properties.sourceDomains : [])
    );
  }
  return normalizeDomains(domains);
}

function buildSourceDomainRouter(graph, args = {}) {
  const targetDomain = normalizeFieldOfStudy(args.targetDomain || args.target_domain);
  const limit = boundedInteger(args.sourceDomainLimit || args.source_domain_limit, 8, { max: 40 });
  const minDomainDistance = boundedNumber(args.minDomainDistance ?? args.min_domain_distance, 0);
  const maxProximalResults = boundedInteger(args.maxProximalResults ?? args.max_proximal_results, 2, { min: 0, max: 20 });
  const excludeDomains = new Set(normalizeDomains(args.excludeDomains || args.exclude_domains));
  const preferDomains = new Set(normalizeDomains(args.preferDomains || args.prefer_domains));
  const nearDomains = new Set(normalizeDomains(args.nearSourceDomains || args.near_source_domains));
  const farDomains = new Set(normalizeDomains(args.farSourceDomains || args.far_source_domains));
  const domainDistanceMatrix = graph ? deriveDomainTaxonomyFromGraph(graph) : null;
  const allDomains = unique([
    ...nearDomains,
    ...farDomains,
    ...preferDomains,
    ...collectGraphDomainNames(graph)
  ]).filter(Boolean)
    .filter((domain) => normalizeTitle(domain) !== normalizeTitle(targetDomain))
    .filter((domain) => !excludeDomains.has(domain));

  let proximalKept = 0;
  const candidates = allDomains
    .map((domain, index) => {
      const distance = scoreDomainDistance(domainDistanceMatrix, targetDomain, domain);
      const explicitLayer = nearDomains.has(domain)
        ? 'near_source'
        : (farDomains.has(domain) ? 'far_source' : null);
      const layer = explicitLayer || (distance <= 0.45 ? 'near_source' : 'far_source');
      const proximalLeakage = distance < minDomainDistance;
      const source = explicitLayer
        ? 'user_layer_hint'
        : (preferDomains.has(domain) ? 'user_preference' : 'graph_domain_layer');
      const preferredBoost = preferDomains.has(domain) || nearDomains.has(domain) || farDomains.has(domain) ? 0.25 : 0;
      const distanceScore = layer === 'near_source'
        ? Math.max(0, 1 - distance)
        : Math.min(1, distance);
      return {
        domain,
        layer,
        role: layer === 'near_source' ? 'near_source_method' : 'far_source_story',
        domain_distance: Number(distance.toFixed(4)),
        source_relevance_score: Number(Math.min(1, 0.55 + preferredBoost + distanceScore * 0.2).toFixed(4)),
        proximal_leakage: proximalLeakage,
        source,
        rationale: proximalLeakage
          ? `Domain is closer than minDomainDistance=${minDomainDistance}; kept only within maxProximalResults policy.`
          : `Candidate ${layer.replace('_', ' ')} domain from ${source}.`,
        order: index
      };
    })
    .filter((entry) => {
      if (!entry.proximal_leakage) return true;
      if (proximalKept >= maxProximalResults) return false;
      proximalKept += 1;
      return true;
    })
    .sort((left, right) => (
      Number(right.source === 'user_layer_hint') - Number(left.source === 'user_layer_hint')
      || Number(right.source === 'user_preference') - Number(left.source === 'user_preference')
      || right.source_relevance_score - left.source_relevance_score
      || left.domain_distance - right.domain_distance
      || left.order - right.order
    ))
    .slice(0, limit)
    .map(({ order, ...entry }) => entry);

  return {
    policy: {
      backend: 'graph_native_source_router_v1',
      target_domain: targetDomain || null,
      min_domain_distance: minDomainDistance,
      max_proximal_results: maxProximalResults,
      exclude_domains: [...excludeDomains],
      prefer_domains: [...preferDomains],
      near_source_domains: [...nearDomains],
      far_source_domains: [...farDomains],
      limitation: 'Graph-native Phase 4 MVP. It does not call provider search or live_discovery internally.'
    },
    domain_distance_matrix: domainDistanceMatrix,
    candidate_source_domains: candidates
  };
}

function buildSourceDomainQueries(candidateSourceDomains = [], args = {}) {
  return candidateSourceDomains.flatMap((entry) => querySetForSourceDomain(entry.domain, entry.layer, args)
    .map((query) => ({
      domain: entry.domain,
      layer: entry.layer,
      role: entry.role,
      domain_distance: entry.domain_distance,
      proximal_leakage: entry.proximal_leakage,
      query
    })));
}

function mergeCandidateLists(candidates = [], limit = 5) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.role || ''}:${candidate.paper_id || candidate.title}`;
    const existing = byKey.get(key);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0) || candidate.source_domain) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, limit);
}

function collectDomainPaperCandidates(graph, sourceDomainQueries = [], role, limit = 5) {
  const candidates = [];
  for (const sourceQuery of sourceDomainQueries.filter((entry) => entry.role === role)) {
    for (const candidate of collectGraphPaperCandidates(graph, [sourceQuery.query], limit)) {
      candidates.push({
        ...candidate,
        role,
        layer: sourceQuery.layer,
        source_domain: sourceQuery.domain,
        domain_distance: sourceQuery.domain_distance,
        proximal_leakage: sourceQuery.proximal_leakage,
        source_query: sourceQuery.query
      });
    }
  }
  return mergeCandidateLists(candidates, limit);
}

export async function buildSourceDiscoveryPlan(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  const constraints = normalizeConstraints(args.constraints || args.constraint);
  const roles = normalizeRoles(args.roles || args.role);
  const limit = boundedInteger(args.limit, 5, { max: 30 });
  const router = buildSourceDomainRouter(context.graph, args);
  const sourceDomainQueries = buildSourceDomainQueries(router.candidate_source_domains, args);
  const targetQueries = querySetForRole('target_prior', args);
  const nearSourceQueries = querySetForRole('near_source_method', args);
  const farSourceQueries = querySetForRole('far_source_story', args);
  const targetCandidates = collectGraphPaperCandidates(context.graph, targetQueries, limit);
  const genericNearCandidates = collectGraphPaperCandidates(context.graph, nearSourceQueries, limit)
    .map((entry) => ({ ...entry, role: 'near_source_method', layer: 'near_source' }));
  const genericFarCandidates = collectGraphPaperCandidates(context.graph, farSourceQueries, limit)
    .map((entry) => ({ ...entry, role: 'far_source_story', layer: 'far_source' }));
  const nearCandidates = mergeCandidateLists([
    ...genericNearCandidates,
    ...collectDomainPaperCandidates(context.graph, sourceDomainQueries, 'near_source_method', limit)
  ], limit);
  const farCandidates = mergeCandidateLists([
    ...genericFarCandidates,
    ...collectDomainPaperCandidates(context.graph, sourceDomainQueries, 'far_source_story', limit)
  ], limit);
  const providerEvidence = await collectProviderEvidence(providerQueryRecordsForSourcePlan({
    targetDomain,
    targetQueries,
    nearSourceQueries,
    farSourceQueries,
    sourceDomainQueries
  }, providerEvidenceConfig(args)), args, options);
  const providerEvidencePersistence = await persistProviderEvidence(providerEvidence, args, context, 'source_discovery_plan');
  const providerCandidates = providerCandidatesFromEvidence(providerEvidence, limit);
  const seedPapers = asArray(args.seedPapers || args.seed_papers).filter((entry) => entry && typeof entry === 'object');
  const seedRequisitions = seedPapers
    .filter((seed) => !findSourceEntries(context.manifest, seed).length)
    .map((seed) => requisitionForPaper(seed, 'user-provided seed paper is not materialized in this corpus'));
  const sparseGraphScoreThreshold = boundedNumber(
    args.liveDiscoverySparseMinScore ?? args.live_discovery_sparse_min_score ?? args.sparseGraphMinScore ?? args.sparse_graph_min_score,
    0.05,
    { min: 0, max: 100 }
  );
  const roleGraphCandidateCounts = Object.fromEntries(roles.map((role) => {
    const queries = querySetForRole(role, args);
    const candidateCount = collectGraphPaperCandidates(context.graph, queries, limit)
      .filter((candidate) => Number(candidate.score || 0) >= sparseGraphScoreThreshold)
      .length;
    return [role, candidateCount];
  }));
  const sparseRoles = roles.filter((role) => Number(roleGraphCandidateCounts[role] || 0) === 0);
  const liveDiscoveryEvidence = await collectLiveDiscoveryEvidence({
    ...args,
    targetDomain,
    targetProblem,
    liveDiscoveryTrigger: {
      graph_sparse: sparseRoles.length > 0,
      sparse_roles: sparseRoles,
      sparse_role_count: sparseRoles.length,
      graph_candidate_score_threshold: sparseGraphScoreThreshold,
      role_graph_candidate_counts: roleGraphCandidateCounts
    }
  }, options);
  const liveDiscoveryEvidencePersistence = await persistLiveDiscoveryEvidence(liveDiscoveryEvidence, args, context, 'source_discovery_plan');
  const liveDiscoveryCandidates = liveDiscoveryCandidatesFromEvidence(liveDiscoveryEvidence, {
    ...context,
    domainDistanceMatrix: router.domain_distance_matrix
  }, targetDomain, limit);
  const sparseRequisitions = sparseRoles.map((role) => requisitionForPaper({
    title: `${targetProblem || targetDomain} ${role.replace(/_/g, ' ')}`,
    role,
    priority: role === 'target_prior' || role === 'novelty_risk' ? 'high' : 'medium'
  }, `No committed-graph candidate found for role ${role}; run literature_discovery with generated queries.`));
  const providerRequisitions = providerRequisitionsFromEvidence(providerEvidence, context.manifest);
  const liveDiscoveryRequisitions = liveDiscoveryRequisitionsFromEvidence(
    liveDiscoveryEvidence,
    context.manifest,
    targetDomain,
    router.domain_distance_matrix
  );
  const literatureDiscoveryEvidence = await collectLiteratureDiscoveryEvidence(args, context, {
    target_domain: targetDomain,
    target_problem: targetProblem,
    target_queries: targetQueries,
    near_source_queries: nearSourceQueries,
    far_source_queries: farSourceQueries,
    source_domain_queries: sourceDomainQueries,
    sparse_roles: sparseRoles,
    graph_candidate_score_threshold: sparseGraphScoreThreshold,
    role_graph_candidate_counts: roleGraphCandidateCounts,
    provider_evidence: providerEvidence,
    live_discovery_evidence: liveDiscoveryEvidence
  }, options);
  const literatureDiscoveryCandidates = literatureDiscoveryCandidatesFromEvidence(literatureDiscoveryEvidence, limit);
  const literatureDiscoveryRequisitions = literatureDiscoveryRequisitionsFromEvidence(
    literatureDiscoveryEvidence,
    context.manifest
  );

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
    router_policy: router.policy,
    target_queries: targetQueries,
    near_source_queries: nearSourceQueries,
    far_source_queries: farSourceQueries,
    source_domain_queries: sourceDomainQueries,
    source_relevance_scores: router.candidate_source_domains.map((entry) => ({
      domain: entry.domain,
      layer: entry.layer,
      role: entry.role,
      score: entry.source_relevance_score,
      domain_distance: entry.domain_distance,
      proximal_leakage: entry.proximal_leakage
    })),
    candidate_source_domains: router.candidate_source_domains,
    candidate_papers: [
      ...targetCandidates.map((entry) => ({ ...entry, role: 'target_prior', layer: 'target_domain' })),
      ...nearCandidates.map((entry) => ({ ...entry, role: 'near_source_method', layer: 'near_source' })),
      ...farCandidates.map((entry) => ({ ...entry, role: 'far_source_story', layer: 'far_source' })),
      ...providerCandidates,
      ...liveDiscoveryCandidates,
      ...literatureDiscoveryCandidates
    ],
    provider_evidence: {
      ...providerEvidence,
      persistence: providerEvidencePersistence
    },
    live_discovery_evidence: {
      ...liveDiscoveryEvidence,
      persistence: liveDiscoveryEvidencePersistence
    },
    literature_discovery_evidence: literatureDiscoveryEvidence,
    import_requisitions: dedupeRequisitions([
      ...seedRequisitions,
      ...sparseRequisitions,
      ...providerRequisitions,
      ...liveDiscoveryRequisitions,
      ...literatureDiscoveryRequisitions
    ]),
    negative_evidence: sparseRoles.map((role) => ({
      role,
      searched_queries: querySetForRole(role, args),
      direct_hit_count: 0,
      adjacent_hit_count: 0,
      absence_confidence: 'low',
      limitation: literatureDiscoveryEvidence.enabled
        ? 'Sparse-role evidence includes committed-graph misses; inspect literature_discovery_evidence for opt-in online resolve/import readiness.'
        : (liveDiscoveryEvidence.enabled
            ? 'Sparse-role evidence includes committed-graph misses; inspect live_discovery_evidence for opt-in source-domain materials.'
            : 'MVP searched committed graph only; set includeLiteratureDiscoveryEvidence=true or includeLiveDiscoveryEvidence=true for online coverage.')
    })),
    generatedAt: nowIso()
  };
}

async function materialItemFromCandidate(candidate = {}, args = {}, options = {}, overlayRoles = []) {
  const view = await buildPaperMaterialView({
    ...args,
    paperId: candidate.paper_id,
    paperTitle: candidate.title,
    role: candidate.role
  }, options);
  const providerSnippets = asArray(candidate.provider_evidence).filter(Boolean);
  const liveDiscoveryMaterials = candidate.live_discovery_evidence && typeof candidate.live_discovery_evidence === 'object'
    ? {
        source_spans: asArray(candidate.live_discovery_evidence.source_spans),
        source_takeaways: asArray(candidate.live_discovery_evidence.source_takeaways),
        idea_fragments: asArray(candidate.live_discovery_evidence.idea_fragments)
      }
    : null;
  const literatureDiscoveryMaterials = candidate.literature_discovery_evidence && typeof candidate.literature_discovery_evidence === 'object'
    ? {
        source: candidate.literature_discovery_evidence.source || null,
        import: candidate.literature_discovery_evidence.import || null,
        providers: asArray(candidate.literature_discovery_evidence.providers)
      }
    : null;
  const sourceType = candidate.discovery_source
    || (candidate.provider ? 'provider_search' : 'committed_graph_search');
  return {
    material_id: `material:${stableHash(`${candidate.role || ''}:${candidate.paper_id || candidate.title}`, 16)}`,
    paper_id: view.paper.paper_id,
    title: view.paper.title,
    status: view.paper.status,
    availability: view.paper.availability,
    role: candidate.role || null,
    layer: candidate.layer || null,
    source_domain: candidate.source_domain || null,
    domain_distance: candidate.domain_distance ?? null,
    proximal_leakage: candidate.proximal_leakage ?? null,
    match: {
      query: candidate.query || null,
      source_query: candidate.source_query || null,
      score: candidate.score || 0,
      matches: candidate.matches || []
    },
    materials: {
      ...view.materials,
      ...(providerSnippets.length ? { provider_snippets: providerSnippets } : {}),
      ...(liveDiscoveryMaterials ? { live_discovery: liveDiscoveryMaterials } : {}),
      ...(literatureDiscoveryMaterials ? { literature_discovery: literatureDiscoveryMaterials } : {})
    },
    graph_context: view.graph_context,
    sources: view.sources,
    overlay_roles: overlayRolesForPaper(overlayRoles, {
      paper_id: view.paper.paper_id,
      title: view.paper.title,
      sources: view.sources
    }),
    provenance: [{
      source_type: sourceType,
      source_id: candidate.paper_id || candidate.title || null,
      query: candidate.query || null,
      source_query: candidate.source_query || null,
      source_domain: candidate.source_domain || null,
      provider: candidate.provider || null
    }, ...providerSnippets.map((snippet) => ({
      source_type: 'provider_snippet',
      source_id: snippet.snippet_id || snippet.hit_id || null,
      query: snippet.query || null,
      provider: snippet.provider || null,
      hit_classification: snippet.hit_classification || null
    })), ...asArray(liveDiscoveryMaterials?.source_spans).map((span) => ({
      source_type: 'idea_catalyst_live_discovery',
      source_id: span.span_id || span.paper_key || null,
      query: candidate.source_query || candidate.query || null,
      source_domain: span.source_domain || candidate.source_domain || null,
      section: span.section || null
    })), ...(literatureDiscoveryMaterials ? [{
      source_type: 'literature_discovery',
      source_id: candidate.paper_id || candidate.title || null,
      query: candidate.query || null,
      source_path: literatureDiscoveryMaterials.source?.source_path || null,
      import_status: literatureDiscoveryMaterials.import?.status || 'not_submitted'
    }] : [])]
  };
}

function itemMatchesOverlayRole(item = {}, overlayRole = {}) {
  if (item.paper_id && overlayRole.paper_id && item.paper_id === overlayRole.paper_id) return true;
  if (normalizeTitle(item.title) && overlayRole.title && normalizeTitle(item.title) === normalizeTitle(overlayRole.title)) return true;
  return false;
}

async function materialItemFromOverlayRole(overlayRole = {}, args = {}, options = {}, overlayRoles = []) {
  const view = await buildPaperMaterialView({
    ...args,
    paperId: overlayRole.paper_id,
    paperTitle: overlayRole.title,
    sourceKey: overlayRole.source_key,
    role: overlayRole.role
  }, options);
  return {
    material_id: `material:${stableHash(`${overlayRole.role || ''}:${overlayRole.role_id}`, 16)}`,
    paper_id: view.paper.paper_id || overlayRole.paper_id,
    title: view.paper.title || overlayRole.title,
    status: view.paper.status,
    availability: view.paper.availability,
    role: overlayRole.role || null,
    layer: overlayRole.layer || null,
    match: {
      query: null,
      score: 0,
      matches: [],
      source: 'project_overlay'
    },
    materials: view.materials,
    graph_context: view.graph_context,
    sources: view.sources,
    overlay_roles: overlayRolesForPaper(overlayRoles, {
      paper_id: view.paper.paper_id || overlayRole.paper_id,
      title: view.paper.title || overlayRole.title,
      sources: view.sources
    }),
    provenance: [{
      source_type: 'project_overlay',
      source_id: overlayRole.role_id,
      role: overlayRole.role
    }]
  };
}

export async function buildResearchMaterialPack(args = {}, options = {}) {
  const plan = await buildSourceDiscoveryPlan(args, options);
  const projectOverlay = await loadProjectOverlaySummary(plan.rootPath, plan.project);
  const roles = normalizeRoles(args.roles || args.role);
  const limit = boundedInteger(args.limit, 5, { max: 20 });
  const groups = [];

  for (const role of roles) {
    const candidates = plan.candidate_papers.filter((entry) => entry.role === role).slice(0, limit);
    const items = [];
    for (const candidate of candidates) {
      items.push(await materialItemFromCandidate(candidate, args, options, projectOverlay.roles));
    }
    const overlayRoles = projectOverlay.roles.filter((entry) => entry.role === role);
    for (const overlayRole of overlayRoles) {
      if (items.some((item) => itemMatchesOverlayRole(item, overlayRole))) continue;
      items.push(await materialItemFromOverlayRole(overlayRole, args, options, projectOverlay.roles));
    }
    groups.push({
      role,
      purpose: ROLE_PURPOSES[role] || `Collect materials for ${role}.`,
      overlay_roles: overlayRoles,
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
      router_policy: plan.router_policy,
      target_queries: plan.target_queries,
      near_source_queries: plan.near_source_queries,
      far_source_queries: plan.far_source_queries,
      source_domain_queries: plan.source_domain_queries,
      source_relevance_scores: plan.source_relevance_scores,
      candidate_source_domains: plan.candidate_source_domains,
      candidate_papers: plan.candidate_papers,
      provider_evidence: plan.provider_evidence,
      live_discovery_evidence: plan.live_discovery_evidence,
      literature_discovery_evidence: plan.literature_discovery_evidence,
      import_requisitions: plan.import_requisitions
    },
    groups,
    missing_materials: missingMaterials,
    negative_evidence: plan.negative_evidence,
    import_requisitions: plan.import_requisitions,
    project_overlay: projectOverlay,
    generatedAt: nowIso()
  };

  return maybeExportPayload(pack, args);
}

export async function buildPaperRoleOverlay(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  return executePaperRoleOverlay({
    ...args,
    corpus: context.meta.name || args.corpus || context.rootPath
  }, {
    rootPath: context.rootPath
  });
}

export async function buildEvidenceCart(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  return executeEvidenceCart({
    ...args,
    corpus: context.meta.name || args.corpus || context.rootPath
  }, {
    rootPath: context.rootPath
  });
}

export async function buildWorkflowState(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  return executeWorkflowState({
    ...args,
    corpus: context.meta.name || args.corpus || context.rootPath
  }, {
    rootPath: context.rootPath
  });
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
      far_source: plan.far_source_queries,
      source_domains: plan.source_domain_queries
    },
    provider_evidence: plan.provider_evidence,
    live_discovery_evidence: plan.live_discovery_evidence,
    literature_discovery_evidence: plan.literature_discovery_evidence,
    generatedAt: nowIso()
  };
  return maybeExportPayload(payload, args);
}

function providerHitCount(providerEvidence = {}, classification) {
  return unique(flattenProviderHits(providerEvidence)
    .filter((hit) => !classification || hit.hit_classification === classification)
    .map((hit) => hit.paper_id || hit.title)
    .filter(Boolean)).length;
}

function providerNegativeQueryRecords(role, searchedQueries = [], adjacentQueries = [], targetDomain = '', config = {}) {
  return dedupeProviderQueryRecords([
    ...searchedQueries.map((query) => ({
      query,
      role,
      layer: role === 'far_source_story' ? 'far_source' : (role === 'near_source_method' ? 'near_source' : 'target_domain'),
      target_domain: targetDomain,
      hit_classification: 'direct'
    })),
    ...adjacentQueries.map((query) => ({
      query,
      role: 'target_prior',
      layer: 'target_domain',
      target_domain: targetDomain,
      hit_classification: 'adjacent'
    }))
  ], config.query_limit);
}

export async function buildNegativeEvidencePack(args = {}, options = {}) {
  const context = await loadMaterialContext(args, options);
  const targetDomain = compactText(args.targetDomain || args.target_domain);
  const targetProblem = compactText(args.targetProblem || args.target_problem || args.query || args.problem);
  const constraints = normalizeConstraints(args.constraints || args.constraint);
  const roles = normalizeRoles(args.roles || args.role || 'negative_evidence');
  const limit = boundedInteger(args.limit, 5, { max: 30 });
  const providerConfig = providerEvidenceConfig(args);
  const records = [];
  for (const role of roles) {
    const searchedQueries = querySetForRole(role, args);
    const directCandidates = collectGraphPaperCandidates(context.graph, searchedQueries, limit);
    const adjacentQueries = querySetForRole('target_prior', {
      ...args,
      targetProblem: targetProblem || targetDomain
    });
    const adjacentCandidates = collectGraphPaperCandidates(context.graph, adjacentQueries, limit)
      .filter((candidate) => !directCandidates.some((direct) => direct.paper_id === candidate.paper_id));
    const providerEvidence = await collectProviderEvidence(providerNegativeQueryRecords(role, searchedQueries, adjacentQueries, targetDomain, providerConfig), args, options);
    const providerEvidencePersistence = await persistProviderEvidence(providerEvidence, args, context, `negative_evidence_pack:${role}`);
    const directProviderHitCount = providerHitCount(providerEvidence, 'direct');
    const adjacentProviderHitCount = providerHitCount(providerEvidence, 'adjacent');
    records.push({
      role,
      searched_queries: searchedQueries,
      filters: {
        backend: providerConfig.enabled ? 'committed_graph_search+semantic_scholar_snippets' : 'committed_graph_search',
        corpus: context.meta.name || args.corpus || context.rootPath,
        target_domain: targetDomain || null,
        target_problem: targetProblem || null,
        constraints,
        time_window: compactText(args.timeWindow || args.time_window) || null
      },
      direct_hit_count: directCandidates.length,
      adjacent_hit_count: adjacentCandidates.length,
      direct_provider_hit_count: directProviderHitCount,
      adjacent_provider_hit_count: adjacentProviderHitCount,
      retrieved_papers: directCandidates.map((candidate) => ({
        paper_id: candidate.paper_id,
        title: candidate.title,
        query: candidate.query,
        score: candidate.score,
        status: candidate.status
      })),
      adjacent_papers: adjacentCandidates.map((candidate) => ({
        paper_id: candidate.paper_id,
        title: candidate.title,
        query: candidate.query,
        score: candidate.score,
        status: candidate.status
      })),
      provider_evidence: {
        ...providerEvidence,
        persistence: providerEvidencePersistence
      },
      absence_confidence: directCandidates.length === 0 && directProviderHitCount === 0 ? 'low' : 'none',
      provider_absence_scope: providerConfig.enabled
        ? (providerEvidence.error_count === 0 ? 'bounded_semantic_scholar_snippets' : 'partial_provider_errors')
        : 'not_requested',
      limitation: providerConfig.enabled
        ? 'Bounded Semantic Scholar snippet evidence is included; live-discovery evidence is exposed through source/material packs and is not persisted by negative_evidence_pack.'
        : 'This pack records committed-graph negative evidence only; set includeProviderEvidence=true for bounded provider snippets, or use source_discovery_plan/research_material_pack with includeLiveDiscoveryEvidence=true for live source-domain evidence.',
      recommended_next_queries: directCandidates.length === 0
        ? searchedQueries.map((query) => `${query} survey open access`)
        : []
    });
  }
  const payload = {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'negative_evidence_pack',
    run_id: `agent-materials-negative:${stableHash(`${targetDomain}:${targetProblem}:${nowIso()}`, 16)}`,
    rootPath: context.rootPath,
    corpus: context.meta.name || args.corpus || context.rootPath,
    project: compactText(args.project) || null,
    target_domain: targetDomain,
    target_problem: targetProblem,
    constraints,
    records,
    generatedAt: nowIso()
  };
  return maybeExportPayload(payload, args);
}

function costRecordProvenance(record = {}) {
  return {
    source_type: record.source_type,
    source_id: record.source_id,
    material_kind: record.material_kind || null,
    paper_id: record.paper_id,
    title: record.title,
    section_id: record.section_id || null,
    section_heading: record.section_heading || null,
    source_path: record.source_path || null,
    line_start: record.line_start ?? null,
    line_end: record.line_end ?? null
  };
}

function buildCostLlmInputRecords(textRecords = [], args = {}) {
  const recordLimit = boundedInteger(
    firstDefined(args.costLlmRecordLimit, args.cost_llm_record_limit),
    DEFAULT_COST_LLM_RECORD_LIMIT,
    { min: 1, max: 48 }
  );
  const maxInputChars = boundedInteger(
    firstDefined(args.costLlmMaxInputChars, args.cost_llm_max_input_chars),
    DEFAULT_COST_LLM_MAX_INPUT_CHARS,
    { min: 1000, max: 50000 }
  );
  const records = [];
  let inputChars = 0;
  for (const [index, record] of textRecords.entries()) {
    if (records.length >= recordLimit || inputChars >= maxInputChars) break;
    const text = compactText(record.text || '');
    if (!text) continue;
    const budget = maxInputChars - inputChars;
    const excerpt = truncate(text, Math.min(1600, budget));
    const provenance = costRecordProvenance(record);
    const recordId = `cost-record-${records.length + 1}-${stableHash(JSON.stringify({
      index,
      source_type: record.source_type,
      source_id: record.source_id,
      material_kind: record.material_kind,
      paper_id: record.paper_id,
      text: excerpt
    }), 10)}`;
    inputChars += excerpt.length;
    records.push({
      record_id: recordId,
      source_record_id: recordId,
      source_type: record.source_type,
      source_id: record.source_id,
      material_kind: record.material_kind || null,
      section_heading: record.section_heading || null,
      provenance,
      text: excerpt
    });
  }
  return {
    records,
    record_limit: recordLimit,
    max_input_chars: maxInputChars,
    input_chars: inputChars
  };
}

function summarizeCostRegexSignals(signals = {}) {
  return COST_LLM_FIELDS.map((field) => ({
    field,
    status: signals[field]?.status || 'not_reported',
    count: Number(signals[field]?.count || 0),
    top_matches: (signals[field]?.snippets || [])
      .slice(0, 3)
      .map((snippet) => compactText(snippet.match))
      .filter(Boolean)
  }));
}

function buildCostLlmPrompt(view = {}, promptInput = {}, regexSignals = {}) {
  const paper = view.paper || {};
  const records = (promptInput.records || []).map((record) => ({
    source_record_id: record.source_record_id,
    source_type: record.source_type,
    source_id: record.source_id,
    material_kind: record.material_kind,
    section_heading: record.section_heading,
    text: record.text
  }));
  return [
    'You extract experiment cost and reproducibility facts from paper material records.',
    'Use only the supplied records. Do not infer missing values and do not use outside knowledge.',
    '',
    'Return strict JSON only with this schema:',
    '{',
    '  "summary": "short optional summary",',
    '  "fields": {',
    '    "hardware": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "runtime": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "epochs": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "batch_size": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "dataset_scale": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "backbone": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"},',
    '    "code_availability": {"status": "reported|not_reported|uncertain", "value": "string|null", "confidence": 0.0, "evidence_text": "short quote|null", "source_record_id": "id|null"}',
    '  }',
    '}',
    '',
    'Guidelines:',
    '- Mark a field reported only when a record explicitly states it.',
    '- Put the shortest faithful value in value, not a long paragraph.',
    '- evidence_text must be copied from one supplied record and source_record_id must match that record.',
    '- If multiple values exist, summarize them compactly and cite the clearest record.',
    '',
    `Paper: ${paper.title || paper.paper_id || 'unknown'}`,
    `Regex hints: ${JSON.stringify(summarizeCostRegexSignals(regexSignals))}`,
    `Records: ${JSON.stringify(records)}`
  ].join('\n');
}

async function postJson(url, body, headers = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM cost extraction request failed (${response.status}): ${truncate(text, 240)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAiText(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function extractAnthropicText(payload = {}) {
  return (payload?.content || []).map((part) => (part?.type === 'text' ? part.text || '' : '')).join('');
}

function shouldDisableThinkingForJsonMode(config = {}) {
  return config.provider === 'openai'
    && String(config.baseUrl || '').toLowerCase().includes('dashscope.aliyuncs.com')
    && /^qwen3/i.test(String(config.model || '').trim());
}

function resolveCostLlmConfig(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const llmConfig = normalizeObject(config.llm);
  const ollamaConfig = normalizeObject(config.ollama);
  return resolveLlmConfig({
    llmProvider: firstDefined(args.costLlmProvider, args.cost_llm_provider, args.llmProvider, args.llm_provider, llmConfig.provider),
    llmModel: firstDefined(args.costLlmModel, args.cost_llm_model, args.llmModel, args.llm_model, args.ollamaModel, args.ollama_model, llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(args.costLlmBaseUrl, args.cost_llm_base_url, args.llmBaseUrl, args.llm_base_url, args.ollamaUrl, args.ollama_url, llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(args.costLlmApiKey, args.cost_llm_api_key, args.llmApiKey, args.llm_api_key, llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(args.costLlmApiKeyEnv, args.cost_llm_api_key_env, args.llmApiKeyEnv, args.llm_api_key_env, llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(args.costLlmApiKeySource, args.cost_llm_api_key_source, args.llmApiKeySource, args.llm_api_key_source, llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(args.costLlmApiKeyService, args.cost_llm_api_key_service, args.llmApiKeyService, args.llm_api_key_service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(args.costLlmApiKeyAccount, args.cost_llm_api_key_account, args.llmApiKeyAccount, args.llm_api_key_account, llmConfig.apiKeyAccount),
    llmTimeoutMs: firstDefined(args.costLlmTimeoutMs, args.cost_llm_timeout_ms, args.llmTimeoutMs, args.llm_timeout_ms, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmMaxTokens: firstDefined(args.costLlmMaxTokens, args.cost_llm_max_tokens, args.llmMaxTokens, args.llm_max_tokens, llmConfig.maxTokens)
  });
}

async function callConfiguredCostLlmJson(prompt, config = {}) {
  if (!config.enabled || !config.model) {
    throw new Error('LLM is not configured for experiment cost extraction.');
  }

  if (config.provider === 'openai') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for experiment cost extraction. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('openai')} or configure PaperNexus LLM auth.`);
    }
    const body = {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_completion_tokens: Math.min(2400, Math.max(512, Number(config.maxTokens || 1600)))
    };
    if (shouldDisableThinkingForJsonMode(config)) body.enable_thinking = false;
    const payload = await postJson(`${config.baseUrl}/chat/completions`, body, {
      authorization: `Bearer ${apiKey}`
    }, config.timeoutMs);
    return parseJsonText(extractOpenAiText(payload));
  }

  if (config.provider === 'anthropic') {
    const apiKey = config.apiKey || await loadLlmApiKey(config);
    if (!apiKey) {
      throw new Error(`Missing API key for experiment cost extraction. Set ${config.apiKeyEnv || getDefaultLlmApiKeyEnv('anthropic')} or configure PaperNexus LLM auth.`);
    }
    const payload = await postJson(`${config.baseUrl}/messages`, {
      model: config.model,
      max_tokens: Math.min(2400, Math.max(512, Number(config.maxTokens || 1600))),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    }, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, config.timeoutMs);
    return parseJsonText(extractAnthropicText(payload));
  }

  const payload = await postJson(`${config.baseUrl}/api/generate`, {
    model: config.model,
    prompt,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 }
  }, {}, config.timeoutMs);
  return parseJsonText(payload.response || '');
}

function normalizeCostLlmField(rawField, promptRecordsById = new Map()) {
  const field = normalizeObject(rawField);
  const value = compactText(field.value ?? field.answer ?? '');
  const evidenceText = compactText(field.evidence_text || field.evidenceText || field.evidence || field.quote || '');
  const sourceRecordId = compactText(field.source_record_id || field.sourceRecordId || field.record_id || field.recordId || '');
  const normalizedStatus = compactText(field.status).toLowerCase().replace(/[-\s]+/g, '_');
  let status = ['reported', 'not_reported', 'uncertain'].includes(normalizedStatus)
    ? normalizedStatus
    : '';
  if (!status) status = value || evidenceText ? 'reported' : 'not_reported';
  const promptRecord = promptRecordsById.get(sourceRecordId);
  return {
    status,
    value: status === 'not_reported' ? null : value || null,
    confidence: Number(clamp01(field.confidence, status === 'reported' ? 0.6 : 0).toFixed(3)),
    evidence_text: evidenceText || null,
    source_record_id: sourceRecordId || null,
    provenance: promptRecord?.provenance || null
  };
}

function normalizeCostLlmExtraction(raw = {}, promptRecords = []) {
  const payload = normalizeObject(raw);
  const rawFields = normalizeObject(payload.fields || payload.cost_fields || payload.extractions || payload);
  const promptRecordsById = new Map(promptRecords.map((record) => [record.source_record_id, record]));
  const fields = {};
  for (const field of COST_LLM_FIELDS) {
    fields[field] = normalizeCostLlmField(rawFields[field], promptRecordsById);
  }
  return {
    summary: compactText(payload.summary || payload.overall_summary || payload.rationale || '') || null,
    fields
  };
}

async function runCostLlmExtraction(view = {}, args = {}, options = {}, textRecords = [], regexSignals = {}) {
  const enabled = booleanFlag(firstDefined(args.includeCostLlmExtraction, args.include_cost_llm_extraction), false);
  const backend = 'llm_structured_json_v1';
  if (!enabled) {
    return {
      enabled: false,
      backend,
      status: 'disabled',
      fields: {}
    };
  }

  const promptInput = buildCostLlmInputRecords(textRecords, args);
  const base = {
    enabled: true,
    backend,
    status: 'pending',
    record_count: promptInput.records.length,
    record_limit: promptInput.record_limit,
    input_chars: promptInput.input_chars,
    max_input_chars: promptInput.max_input_chars
  };
  if (!promptInput.records.length) {
    return {
      ...base,
      status: 'no_input',
      fields: {}
    };
  }

  const prompt = buildCostLlmPrompt(view, promptInput, regexSignals);
  try {
    let result;
    let provider = null;
    let model = null;
    const hook = typeof options.llmJson === 'function'
      ? options.llmJson
      : (typeof args.llmJson === 'function' ? args.llmJson : null);
    if (hook) {
      const payload = await hook({
        task: 'experiment_cost_materials.cost_extraction',
        prompt,
        args,
        options,
        records: promptInput.records,
        regexSignals,
        paper: view.paper || null
      });
      result = typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload);
      provider = 'custom-llm-json';
    } else {
      const config = resolveCostLlmConfig(args, options);
      provider = config.provider || null;
      model = config.model || null;
      if (!config.enabled || !config.model) {
        return {
          ...base,
          status: 'unavailable',
          provider,
          model,
          fields: {},
          error: 'LLM is not configured. Set llmModel/PAPERNEXUS_LLM_MODEL or provide options.llmJson.'
        };
      }
      result = await callConfiguredCostLlmJson(prompt, config);
    }
    return {
      ...base,
      status: 'ok',
      provider,
      model,
      ...normalizeCostLlmExtraction(result, promptInput.records)
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      fields: {},
      error: truncate(error?.message || String(error), 320)
    };
  }
}

function collectCostSignalTexts(view = {}) {
  const chunks = (view.materials?.chunks || []).map((chunk) => ({
    source_type: 'chunk',
    source_id: chunk.chunk_id,
    material_kind: 'chunk',
    paper_id: view.paper?.paper_id || null,
    title: view.paper?.title || null,
    section_id: chunk.section_id || null,
    section_heading: chunk.section_heading || null,
    text: chunk.text || ''
  }));
  const spans = (view.materials?.source_spans || []).map((span) => ({
    source_type: span.role || 'source_span',
    source_id: span.source_key || span.source_path || null,
    material_kind: 'source_span',
    paper_id: view.paper?.paper_id || null,
    title: view.paper?.title || null,
    source_path: span.source_path || null,
    text: span.text || ''
  }));
  const tables = (view.materials?.tables || []).map((table) => ({
    source_type: table.source_type || 'table',
    source_id: table.table_id || table.source_id || null,
    material_kind: 'table',
    paper_id: table.paper_id || view.paper?.paper_id || null,
    title: table.title || view.paper?.title || null,
    source_path: table.provenance?.source_path || null,
    line_start: table.provenance?.line_start ?? null,
    line_end: table.provenance?.line_end ?? null,
    text: [table.caption, table.markdown || table.text].filter(Boolean).join('\n')
  }));
  const figures = (view.materials?.figures || []).map((figure) => ({
    source_type: figure.source_type || 'figure',
    source_id: figure.figure_id || figure.source_id || null,
    material_kind: 'figure',
    paper_id: figure.paper_id || view.paper?.paper_id || null,
    title: figure.title || view.paper?.title || null,
    source_path: figure.provenance?.source_path || null,
    line_start: figure.provenance?.line_start ?? null,
    line_end: figure.provenance?.line_end ?? null,
    text: figure.caption || figure.text || ''
  }));
  return [...chunks, ...spans, ...tables, ...figures].filter((entry) => entry.text);
}

function extractCostSignals(textRecords = []) {
  const signals = {};
  for (const [signal, pattern] of Object.entries(COST_SIGNAL_PATTERNS)) {
    const snippets = [];
    for (const record of textRecords) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of record.text.matchAll(regex)) {
        snippets.push({
          match: match[0],
          text: excerptAround(record.text, match.index || 0, match[0].length),
          provenance: {
            source_type: record.source_type,
            source_id: record.source_id,
            material_kind: record.material_kind || null,
            paper_id: record.paper_id,
            title: record.title,
            section_id: record.section_id || null,
            section_heading: record.section_heading || null,
            source_path: record.source_path || null,
            line_start: record.line_start ?? null,
            line_end: record.line_end ?? null
          }
        });
      }
    }
    signals[signal] = {
      status: snippets.length ? 'reported' : 'not_reported',
      count: snippets.length,
      snippets: snippets.slice(0, 12)
    };
  }
  return signals;
}

export async function buildExperimentCostMaterials(args = {}, options = {}) {
  const view = await buildPaperMaterialView(args, options);
  const textRecords = collectCostSignalTexts(view);
  const signals = extractCostSignals(textRecords);
  const llmExtraction = await runCostLlmExtraction(view, args, options, textRecords, signals);
  const payload = {
    contractVersion: AGENT_MATERIALS_CONTRACT_VERSION,
    operation: 'experiment_cost_materials',
    rootPath: view.rootPath,
    corpus: view.corpus,
    project: compactText(args.project) || null,
    paper: view.paper,
    availability: view.paper.availability,
    extraction_policy: {
      backend: 'regex_plus_structured_markdown_v1',
      inputs: ['chunks', 'source_spans', 'markdown_tables', 'table_captions', 'figure_captions'],
      llm_enabled: llmExtraction.enabled,
      llm_backend: llmExtraction.backend,
      llm_status: llmExtraction.status
    },
    signals,
    llm_extraction: llmExtraction,
    limitation: llmExtraction.enabled
      ? 'Regex snippets plus opt-in LLM structured extraction over bounded paper materials. Treat outputs as cost materials for Agent inspection, not final feasibility judgments.'
      : 'Regex-based extractor over chunks, source spans, markdown tables, and figure/table captions. Treat snippets as cost materials for Agent inspection, not final feasibility judgments.',
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

function sourceDiscoveryExportFromPack(payload = {}) {
  const discovery = payload.source_discovery || {};
  return {
    contractVersion: payload.contractVersion,
    operation: 'source_discovery_plan',
    run_id: payload.run_id,
    rootPath: payload.rootPath,
    corpus: payload.corpus,
    project: payload.project,
    target_domain: payload.target_domain,
    target_problem: payload.target_problem,
    constraints: payload.constraints || [],
    generated: true,
    router_policy: discovery.router_policy || null,
    target_queries: discovery.target_queries || [],
    near_source_queries: discovery.near_source_queries || [],
    far_source_queries: discovery.far_source_queries || [],
    source_domain_queries: discovery.source_domain_queries || [],
    source_relevance_scores: discovery.source_relevance_scores || [],
    candidate_source_domains: discovery.candidate_source_domains || [],
    candidate_papers: discovery.candidate_papers || [],
    provider_evidence: discovery.provider_evidence || null,
    live_discovery_evidence: discovery.live_discovery_evidence || null,
    literature_discovery_evidence: discovery.literature_discovery_evidence || null,
    import_requisitions: discovery.import_requisitions || payload.import_requisitions || [],
    negative_evidence: payload.negative_evidence || [],
    generatedAt: payload.generatedAt || nowIso()
  };
}

function namedExportPayload(payload = {}, operation, key, fallback) {
  return {
    contractVersion: payload.contractVersion,
    operation,
    run_id: payload.run_id,
    rootPath: payload.rootPath,
    corpus: payload.corpus,
    project: payload.project,
    target_domain: payload.target_domain,
    target_problem: payload.target_problem,
    [key]: payload[key] || fallback,
    generatedAt: payload.generatedAt || nowIso()
  };
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
    const sourceDiscoveryPath = path.join(resolvedDir, 'source_discovery_plan.json');
    const missingMaterialsPath = path.join(resolvedDir, 'missing_materials.json');
    const negativeEvidencePath = path.join(resolvedDir, 'negative_evidence.json');
    const overlaySummaryPath = path.join(resolvedDir, 'overlay_summary.json');
    await writeText(markdownPath, renderMaterialPackMarkdown(payload));
    await writeJson(sourceDiscoveryPath, sourceDiscoveryExportFromPack(payload));
    await writeJson(missingMaterialsPath, namedExportPayload(payload, 'missing_materials', 'missing_materials', []));
    await writeJson(negativeEvidencePath, namedExportPayload(payload, 'negative_evidence', 'negative_evidence', []));
    await writeJson(overlaySummaryPath, namedExportPayload(payload, 'overlay_summary', 'project_overlay', null));
    exports.markdown_path = markdownPath;
    exports.source_discovery_plan_path = sourceDiscoveryPath;
    exports.missing_materials_path = missingMaterialsPath;
    exports.negative_evidence_path = negativeEvidencePath;
    exports.overlay_summary_path = overlaySummaryPath;
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
  if (operation === 'negative_evidence_pack') return buildNegativeEvidencePack(args, options);
  if (operation === 'experiment_cost_materials') return buildExperimentCostMaterials(args, options);
  if (operation === 'paper_role_overlay') return buildPaperRoleOverlay(args, options);
  if (operation === 'evidence_cart') return buildEvidenceCart(args, options);
  if (operation === 'workflow_state') return buildWorkflowState(args, options);
  throw new Error(`Unknown agent_materials operation: ${args.operation || '<missing>'}`);
}
