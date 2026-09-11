import { PAPERNEXUS_TOOLS } from './tools.js';
import { loadDiscoveryRun } from '../core/discovery/store.js';
import { submitDiscoveryImports } from '../core/discovery/import-bridge.js';
import { resolveCorpusForApi } from '../server/api.js';

export const RESEARCH_WORKFLOW_VERSION = 'papernexus-research-tools-v1';

const text = (description) => ({ type: 'string', minLength: 1, maxLength: 8000, description });
const count = (maximum, description) => ({ type: 'integer', minimum: 1, maximum, description });
const strings = (description) => ({ type: 'array', items: text('Value'), maxItems: 30, description });
const FIELDS = {
  corpus: text('Corpus name or indexed root. Use literature_review/corpora when unknown.'),
  query: text('Research topic, question, or exact node anchor.'),
  paperId: text('Exact committed paper id.'),
  identifier: text('Exact paper identifier such as DOI or arXiv id.'),
  targetDomain: text('Target research domain; generate uses cross-domain catalyst when supplied.'),
  constraints: { oneOf: [text('Conditions to respect'), strings('Conditions to respect'), {
    type: 'object', maxProperties: 30,
    additionalProperties: { oneOf: [text('Required condition value'), {type:'number'}, {type:'boolean'}] }
  }], description: 'Source-review conditions. Lineage overview/problem also accept up to 30 primitive method requirements, such as labelsAvailable=false or maxLatencyMs=40.' },
  method: text('Exact method id or method name.'),
  candidateMechanism: text('Concrete proposed mechanism for evidence and prior-art evaluation.'),
  mechanisms: strings('Candidate mechanism terms.'),
  removedComponents: strings('Assumptions or components the proposal removes.'),
  limit: count(20, 'Result budget, default 5.'),
  chunkLimit: count(40, 'Maximum source chunks in a paper view.'),
  maxDepth: count(4, 'Bounded graph traversal depth, default 2; never global frontier proof.'),
  maxNodes: count(500, 'Topic subgraph node budget, default 180.'),
  maxEdges: count(1000, 'Topic subgraph edge budget, default 350.'),
  seedNodeIds: strings('Explicit graph node anchors for a topic overview.'),
  fromYear: { type: 'integer', minimum: 1000, maximum: 9999, description: 'Inclusive topic observation lower year.' },
  toYear: { type: 'integer', minimum: 1000, maximum: 9999, description: 'Inclusive topic observation upper year.' },
  direction: { type: 'string', enum: ['backward', 'forward', 'both'], description: 'Method/evidence direction. Impact accepts backward or forward only.' },
  from: text('Starting graph node for path.'),
  to: text('Ending graph node for path.'),
  sourceMethod: text('Source method for an exact evidence edge lookup.'),
  targetMethod: text('Target method for an exact evidence edge lookup.'),
  edgeId: text('Exact method evolution edge id.'),
  layers: text('Comma-separated graph layer filter.'),
  sortBy: { type: 'string', enum: ['relevance', 'date'], description: 'Committed search ranking; defaults to relevance.' },
  selectionMode: { type: 'string', enum: ['topk', 'mmr', 'submodular', 'dpp'], description: 'Cross-domain candidate selection when targetDomain is supplied.' },
  selectionK: count(20, 'Number of cross-domain candidates retained.'),
  discoveryMode: { type: 'string', enum: ['search', 'resolve', 'run'], description: 'search finds metadata; resolve/run can fetch full text. Submitted asynchronously; never imports automatically.' },
  providers: strings('Optional discovery provider names.'),
  maxPapers: count(100, 'Maximum discovery papers; default 20.'),
  runId: { ...text('Existing literature discovery run id.'), maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
  serverFilePath: text('Already staged server-side PDF/Markdown file to import.'),
  doi: text('Optional DOI for an imported source.'),
  arxivId: text('Optional arXiv id for an imported source.'),
  jobId: text('Durable asynchronous import submission job id.'),
  taskId: text('Import task id from the authoritative queue.'),
  taskIds: { ...strings('Import task ids from a saved discovery run.'), minItems: 1, maxItems: 100 },
  idempotencyKey: { ...text('Stable id for an import submission; reuse to avoid duplicate async jobs.'), maxLength: 200 }
};

const read = (backend, operation, fields, required = [], anyRequired = []) => ({
  backend, operation, fields: ['corpus', ...fields], required, anyRequired, effect: 'committed_read'
});
const topicFields = ['query', 'targetDomain', 'constraints', 'maxDepth', 'maxNodes', 'maxEdges', 'seedNodeIds', 'fromYear', 'toYear'];
const materialFields = ['query', 'targetDomain', 'constraints', 'limit'];

function researchFieldSchema(tool, field) {
  if (field === 'constraints' && tool !== 'lineage_analysis') {
    return { oneOf: FIELDS.constraints.oneOf.slice(0, 2), description: 'Free-text source-review conditions; structured method requirements belong to lineage_analysis/overview or problem.' };
  }
  return FIELDS[field];
}

// One route owns each public operation. No arbitrary backend/options passthrough.
export const RESEARCH_ROUTES = {
  literature_review: {
    corpora: read('list_corpora', null, []),
    status: read('corpus_status', null, []),
    sources: read('corpus_sources', null, []),
    search: read('research_lookup', 'query', ['query', 'limit', 'layers', 'sortBy'], ['query']),
    paper: read('agent_materials', 'paper_material_view', ['query', 'paperId', 'identifier', 'chunkLimit'], [], ['query', 'paperId', 'identifier']),
    survey: read('agent_materials', 'research_material_pack', materialFields, ['query']),
    discover: { ...read('literature_discovery', 'submit', ['query', 'discoveryMode', 'providers', 'maxPapers'], ['query']), effect: 'discovery_submit' },
    discovery_status: { ...read('literature_discovery_progress', null, ['runId', 'limit']), effect: 'discovery_read' },
    discovery_report: { ...read('literature_discovery', 'report', ['runId'], ['runId']), effect: 'discovery_read' },
    import: { ...read('import_workflow', 'submit', ['serverFilePath', 'runId', 'doi', 'arxivId', 'idempotencyKey'], [], ['serverFilePath', 'runId']), effect: 'import_submit' },
    import_status: { ...read('import_workflow', 'queue_progress', ['jobId', 'taskId', 'taskIds']), effect: 'import_read' }
  },
  lineage_analysis: {
    overview: read('research_lookup', 'topic_analysis', topicFields),
    problem: read('research_lookup', 'problem_evolution', topicFields, ['query']),
    method: read('research_lookup', 'method_lineage', ['query', 'method', 'direction', 'maxDepth', 'limit'], [], ['query', 'method']),
    evidence: read('research_lookup', 'method_evidence', ['query', 'method', 'sourceMethod', 'targetMethod', 'edgeId', 'limit'], [], ['query', 'method', 'sourceMethod', 'targetMethod', 'edgeId']),
    path: read('research_briefing', 'path_trace', ['from', 'to', 'maxDepth', 'limit', 'layers'], ['from', 'to']),
    context: read('research_lookup', 'context', ['query', 'layers'], ['query']),
    impact: read('research_lookup', 'impact', ['query', 'direction', 'maxDepth', 'layers'], ['query'])
  },
  idea_generation: {
    generate: read('research_lookup', 'ideas', ['query', 'targetDomain', 'mechanisms', 'limit', 'selectionMode', 'selectionK'], ['query']),
    diverge: read('research_lookup', 'brainstorm', ['query', 'maxDepth', 'limit', 'layers'], ['query']),
    converge: read('research_lookup', 'brainstorm', ['query', 'maxDepth', 'limit', 'layers'], ['query']),
    gaps: read('agent_materials', 'structural_gap_pack', [...materialFields, 'method', 'maxDepth'], ['query']),
    evaluate: read('agent_materials', 'innovation_evidence_pack', [...materialFields, 'method', 'maxDepth', 'candidateMechanism', 'removedComponents'], ['query', 'candidateMechanism']),
    experiment_materials: read('agent_materials', 'experiment_cost_materials', materialFields, ['query'])
  }
};

const DESCRIPTIONS = {
  literature_review: 'Find and read papers, assemble a source-backed survey, and explicitly discover/import missing papers. corpora/status/sources inspect coverage; search reads the committed graph; paper reads source material; survey groups relevant evidence. discover submits a network job, discovery_status/report inspect it, import explicitly queues a staged file or resolved run, import_status tracks jobs/tasks. Discovery is not graph evidence until import and authoritative sync complete.',
  lineage_analysis: 'Analyze research evolution from committed evidence: overview maps a bounded topic graph; problem gives dated problem observations; method traces validated method lineage; evidence checks method-edge quotes; path/context/impact inspect graph connections. A graph path is not causal proof, and bounded endpoints are not global frontiers. Use literature_review for missing papers and idea_generation for proposals.',
  idea_generation: 'Generate and evaluate research hypotheses from committed sources: generate returns graph candidates (cross-domain catalyst if targetDomain is given); diverge/converge explore or focus; gaps separates structural gaps; evaluate audits a concrete candidateMechanism against prior work and evidence; experiment_materials returns evidence/cost anchors, not an executed experiment. No live discovery, graph writeback, or controller execution. Candidates and novelty audit artifacts do not prove novelty or gains.'
};

export const RESEARCH_TOOLS = Object.entries(RESEARCH_ROUTES).map(([name, operations]) => {
  const fields = [...new Set(Object.values(operations).flatMap((route) => route.fields))];
  return {
    name,
    description: DESCRIPTIONS[name],
    annotations: { readOnlyHint: name !== 'literature_review', destructiveHint: false, openWorldHint: name === 'literature_review' },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: {
          type: 'string', enum: Object.keys(operations),
          description: Object.entries(operations).map(([operation, route]) => operation + ': ' + route.fields.join(', ')).join('; ')
        },
        ...Object.fromEntries(fields.map((field) => [field, researchFieldSchema(name, field)]))
      },
      required: ['operation'],
      allOf: Object.entries(operations).map(([operation, route]) => ({
        if: { properties: { operation: { const: operation } } },
        then: {
          ...(route.required.length ? { required: route.required } : {}),
          ...(route.anyRequired.length ? { anyOf: route.anyRequired.map((field) => ({ required: [field] })) } : {}),
          properties: Object.fromEntries(fields.filter((field) => !route.fields.includes(field)).map((field) => [field, false]))
        }
      }))
    }
  };
});

export function resolveMcpToolProfile(options = {}) {
  const profile = String(options.toolProfile ?? process.env.PAPERNEXUS_MCP_TOOL_PROFILE
    ?? options.config?.serve?.mcp?.toolProfile ?? 'research').trim().toLowerCase();
  if (!['research', 'legacy', 'all'].includes(profile)) {
    throw new Error('Unknown MCP tool profile: ' + profile + '. Choose research, legacy, or all.');
  }
  return profile;
}

export function listMcpTools(options = {}) {
  const profile = resolveMcpToolProfile(options);
  if (profile === 'legacy') return PAPERNEXUS_TOOLS;
  if (profile === 'all') return [...RESEARCH_TOOLS, ...PAPERNEXUS_TOOLS];
  return RESEARCH_TOOLS;
}

function validValue(value, schema) {
  if (schema.oneOf) return schema.oneOf.some((entry) => validValue(value, entry));
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) return false;
  if (schema.type === 'number' && !Number.isFinite(value)) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    if (entries.length > schema.maxProperties || !entries.every(([, item]) => validValue(item, schema.additionalProperties))) return false;
  }
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > (schema.maxLength || Infinity))) return false;
  if (schema.type === 'array' && (!Array.isArray(value) || value.length > schema.maxItems || !value.every((item) => validValue(item, schema.items)))) return false;
  if (schema.minItems && value.length < schema.minItems) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  return !schema.enum || schema.enum.includes(value);
}

const pick = (args, fields) => Object.fromEntries(fields.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));

export function resolveResearchWorkflowCall(name, args = {}) {
  const operations = Object.hasOwn(RESEARCH_ROUTES, name) ? RESEARCH_ROUTES[name] : null;
  if (!operations) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(name + ' requires an argument object.');
  const route = typeof args.operation === 'string' && Object.hasOwn(operations, args.operation) ? operations[args.operation] : null;
  if (!route) throw new Error(name + ' requires operation: ' + Object.keys(operations).join(', ') + '.');
  for (const [field, value] of Object.entries(args)) {
    if (field === 'operation') continue;
    if (!route.fields.includes(field)) throw new Error(name + '/' + args.operation + ' does not accept ' + field + '.');
    if (!validValue(value, researchFieldSchema(name, field))) throw new Error('Invalid ' + field + ' for ' + name + '/' + args.operation + '. Check the tool schema.');
  }
  if (route.required.some((field) => args[field] === undefined)
      || (route.anyRequired.length && !route.anyRequired.some((field) => args[field] !== undefined))) {
    throw new Error(name + '/' + args.operation + ' requires ' + route.required.join(', ')
      + (route.anyRequired.length ? '; one of ' + route.anyRequired.join(', ') : '') + '.');
  }
  if (args.fromYear && args.toYear && args.fromYear > args.toYear) throw new Error('fromYear must not exceed toYear.');
  let backend = route.backend;
  let backendArgs = { ...pick(args, route.fields), ...(route.operation ? { operation: route.operation } : {}) };
  const budget = { limit: args.limit ?? 5, maxDepth: args.maxDepth ?? 2 };
  if (backend === 'research_lookup') {
    if (['query', 'context', 'impact', 'ideas', 'brainstorm'].includes(route.operation)) {
      backendArgs = { corpus: args.corpus, query: args.query, operation: route.operation,
        options: { ...budget, ...pick(args, ['layers', 'sortBy']) } };
    } else {
      Object.assign(backendArgs, budget);
    }
  }
  if (name === 'lineage_analysis' && args.operation === 'impact') {
    if (args.direction === 'both') throw new Error('impact requires backward or forward; use method for bidirectional lineage.');
    backendArgs.options.direction = args.direction === 'forward' ? 'downstream' : 'upstream';
  }
  if (backend === 'research_briefing') {
    backendArgs = { corpus: args.corpus, operation: route.operation, from: args.from, to: args.to,
      options: { ...budget, ...pick(args, ['layers']) } };
  }
  if (backend === 'agent_materials') {
    Object.assign(backendArgs, budget, { targetProblem: args.query, outputDir: '',
      includeProviderEvidence: false, includeLiveDiscoveryEvidence: false,
      includeLiteratureDiscoveryEvidence: false, includeCostLlmExtraction: false,
      autoDiscoverSources: false, submitLiteratureDiscoveryImports: false, processLiteratureDiscoveryImports: false });
  }
  if (name === 'idea_generation') {
    if (['diverge', 'converge'].includes(args.operation)) {
      Object.assign(backendArgs.options, { mode: args.operation, maxHops: budget.maxDepth });
    }
    if (args.operation === 'generate' && args.targetDomain) {
      backend = 'idea_catalyst';
      backendArgs = { ...pick(args, ['corpus', 'targetDomain', 'mechanisms', 'selectionMode', 'selectionK']),
        problem: args.query, limit: budget.limit, mode: 'graph', outputMode: 'packet_bundle',
        writeBack: false, writeBackApply: false, writeBackDryRun: true, liveDiscovery: false };
    } else if (args.operation === 'generate' && ['selectionMode', 'selectionK', 'mechanisms'].some((key) => args[key] !== undefined)) {
      throw new Error('generate requires targetDomain when mechanisms or candidate selection options are supplied.');
    }
  }
  if (name === 'literature_review' && args.operation === 'discover') {
    const discoveryMode = args.discoveryMode ?? 'search';
    if (discoveryMode === 'search' && !args.query) throw new Error('discover/search requires query.');
    backendArgs = { ...pick(args, ['corpus', 'query', 'providers']),
      operation: 'submit', discoveryOperation: discoveryMode, maxCandidates: args.maxPapers ?? 20,
      maxResultsPerQuery: Math.min(args.maxPapers ?? 20, 20), searchMode: 'balanced', maxQueries: 6,
      importResolved: false, processImports: false, planningMode: 'rule_based', llmQueryPlanner: false };
  }
  if (name === 'literature_review' && args.operation === 'import') {
    if (args.serverFilePath && args.runId) throw new Error('import accepts serverFilePath or runId, not both.');
    if (args.runId) {
      if (['doi', 'arxivId', 'idempotencyKey'].some((key) => args[key] !== undefined)) {
        throw new Error('Discovery-run import accepts corpus and runId only; file metadata/idempotencyKey belong to serverFilePath import.');
      }
      backend = 'discovery_import_bridge';
      backendArgs = { corpus: args.corpus, runId: args.runId, operation: 'saved_source_import' };
    } else {
      backendArgs = { ...pick(args, ['corpus', 'serverFilePath', 'doi', 'arxivId', 'idempotencyKey']),
        operation: 'submit', async: true };
    }
  }
  if (name === 'literature_review' && args.operation === 'import_status') {
    if (['jobId', 'taskId', 'taskIds'].filter((key) => args[key] !== undefined).length > 1) {
      throw new Error('import_status accepts one of jobId, taskId or taskIds.');
    }
    backendArgs.operation = args.jobId ? 'async_status' : args.taskId ? 'status' : args.taskIds ? 'status_batch' : 'queue_progress';
  }
  return { tool: name, operation: args.operation, backend, args: backendArgs, effect: route.effect };
}

function decodeResult(result) {
  if (typeof result !== 'string') return result;
  try { return JSON.parse(result); } catch { return { text: result }; }
}

function nextActions(call, args, result) {
  const shared = args.corpus ? { corpus: args.corpus } : {};
  const next = (tool, operation, fields = {}) => ({ tool, arguments: { operation, ...shared, ...fields } });
  const runId = result?.runId || result?.run_id || args.runId;
  if (call.effect === 'discovery_submit' && runId) return [next('literature_review', 'discovery_status', { runId })];
  if (call.effect === 'discovery_read') {
    if (call.operation !== 'discovery_status' || !runId) return [];
    const progress = result?.current || result?.progress || result;
    if (['failed', 'blocked', 'cancelled'].includes(progress?.status)) return [];
    return [next('literature_review', progress?.isTerminal || progress?.status === 'completed' ? 'discovery_report' : 'discovery_status', { runId })];
  }
  if (call.effect === 'import_submit') {
    const jobId = result?.jobId || result?.job?.jobId;
    const taskIds = [...new Set((result?.results || []).map((item) => item.taskId).filter(Boolean))];
    if (call.backend === 'discovery_import_bridge') return taskIds.length ? [next('literature_review', 'import_status', { taskIds })] : [];
    return [next('literature_review', 'import_status', jobId ? { jobId } : {})];
  }
  if (call.effect === 'import_read') {
    // A durable submission job owns submission state, not graph readiness.
    const taskId = result?.result?.taskId || result?.result?.task?.id;
    return taskId ? [next('literature_review', 'import_status', { taskId })] : [];
  }
  if (args.query && call.tool === 'literature_review') return [next('lineage_analysis', 'overview', { query: args.query })];
  if (args.query && call.tool === 'lineage_analysis') return [next('idea_generation', 'gaps', { query: args.query })];
  if (args.query && call.tool === 'idea_generation' && call.operation !== 'evaluate') {
    return [next('literature_review', 'survey', { query: args.query })];
  }
  return [];
}

async function importSavedDiscoverySources(args, options) {
  const rootPath = await resolveCorpusForApi(args.corpus, options);
  const run = await loadDiscoveryRun(rootPath, args.runId);
  if (!run) throw new Error('No saved discovery run found: ' + args.runId);
  const candidates = (run.candidates || []).filter((candidate) => (
    (candidate.source?.resolutionStatus || candidate.source?.resolution_status) === 'fulltext_ready'
    && (candidate.source?.sourcePath || candidate.source?.source_path)
  ));
  if (candidates.length > 100) throw new Error('Saved run exceeds 100 ready sources; import selected serverFilePath entries in bounded batches.');
  return {
    runId: args.runId,
    sourceAuthority: 'Saved discovery candidates; no provider search or source resolution performed.',
    eligibleSources: candidates.length,
    ...await submitDiscoveryImports({ corpus: rootPath, candidates, maxImported: 100, options })
  };
}

export async function executeResearchWorkflow(name, args, options, invoke) {
  const call = resolveResearchWorkflowCall(name, args);
  if (!call) throw new Error('Unknown research tool: ' + name);
  const result = call.backend === 'discovery_import_bridge'
    ? await importSavedDiscoverySources(call.args, options)
    : decodeResult(await invoke(call.backend, call.args, options));
  return {
    contractVersion: RESEARCH_WORKFLOW_VERSION,
    tool: name,
    operation: call.operation,
    backend: call.backend === 'discovery_import_bridge'
      ? { tool: null, component: 'submitDiscoveryImports', operation: 'saved_source_import' }
      : { tool: call.backend, operation: call.args.operation || null },
    result,
    evidenceBoundary: {
      basis: call.effect,
      statusAuthority: 'The backend result and original discovery/import/graph-sync records; this envelope creates no completion state.',
      limitation: name === 'idea_generation'
        ? 'Candidate hypotheses and bounded prior-art evidence do not prove novelty, causal transfer, or experimental gains.'
        : 'Discovery, import submission, graph visibility, and authoritative synchronization are distinct. Graph paths are not causal proof.'
    },
    nextActions: nextActions(call, args, result)
  };
}
