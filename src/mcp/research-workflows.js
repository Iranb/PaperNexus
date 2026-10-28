import { summarizeResearchEnvelope, RESEARCH_SUMMARY_MAX_BYTES } from './research-summary.js';
import { PAPERNEXUS_TOOLS } from './tools.js';
import { loadDiscoveryRun } from '../core/discovery/store.js';
import { submitDiscoveryImports } from '../core/discovery/import-bridge.js';
import { resolveCorpusForApi } from '../server/api.js';
import { RESEARCH_DECISION_TOOL } from './tool-research-decision.js';
import { OPERATIONS as DECISION_OPERATIONS, DECISION_VERSION } from '../core/research/decision-contracts.js';
import { executeFieldResearchOperation } from '../core/research/field-research.js';
import { executeFieldStudyOperation, FIELD_STUDY_SCHEMA } from '../core/research/field-studies.js';
import { executeLineageEvidenceOperation, LINEAGE_CARD_VERSION } from '../core/research/lineage-evidence.js';
import { executeLineageRefinementOperation, LINEAGE_REFINEMENT_VERSION } from '../core/research/lineage-refinement.js';
import { executeLineagePublication } from '../core/research/lineage-publication.js';
import { readProjectEvidence, evaluateProject } from '../core/research/project-evaluation.js';
import { attachProjectEvidence } from '../core/research/project-evidence.js';

export const RESEARCH_WORKFLOW_VERSION = 'papernexus-research-tools-v1';

const text = (description) => ({ type: 'string', minLength: 1, maxLength: 8000, description });
const count = (maximum, description) => ({ type: 'integer', minimum: 1, maximum, description });
const strings = (description) => ({ type: 'array', items: text('Value'), maxItems: 30, description });
const FIELDS = {
  responseMode: { type: 'string', enum: ['full', 'summary'], description: 'Batch, search and overview operations default to summary. Exact paper, lineage_card, method/evidence/path and capability reads default to full. Explicit full preserves backend output.' },
  corpus: text('Corpus name or indexed root. Use literature_review/corpora when unknown.'),
  project: text('Registered research decision project.'),
  purpose: { type: 'string', enum: ['novelty_audit', 'mechanism_diagnosis', 'performance_validation'], description: 'Evaluate purpose; defaults to novelty_audit. Project task gates do not authorize execution.' },
  actionId: text('Registered action id for project evaluation.'),
  actionVersion: count(1000000, 'Registered action version; defaults to the latest version.'),
  query: text('Research topic, question, or exact node anchor.'),
  paperId: text('Exact committed paper id.'),
  papers: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false,
    required: ['paperId'], properties: { paperId: { ...text('Exact committed paper id.'), maxLength: 1000 },
      sourceKey: text('Exact active source key; required when source selection is ambiguous.') } },
    description: 'Papers for source-versioned lineage evidence cards. Reuses completed cards before calling the configured model.' },
  cardId: { ...text('Exact card id returned by lineage_status.'), pattern: '^card-[a-f0-9]{24}$' },
  retryFailed: { type: 'boolean', description: 'Explicitly retry only failed or unprocessed entries in an existing lineage run. Completed cards are preserved.' },
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
  maxNodes: count(500, 'Node budget, default 180. Landscape applies this separately to methods and papers.'),
  maxEdges: count(1000, 'Edge budget, default 350. Landscape applies this separately to method and paper relations.'),
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
  maxQueries: { type: 'integer', minimum: 0, maximum: 8, description: 'Cumulative gap search budget; default 0. Each query uses one configured provider.' },
  maxNewPapers: { type: 'integer', minimum: 0, maximum: 20, description: 'Cumulative new paper import budget; default 0. Set with maxQueries to enable supplementation.' },
  maxRounds: count(3, 'Maximum supplementation rounds; default 1.'),
  requestId: { ...text('Stable publication request id. Reuse it to reconcile publication or revocation.'), maxLength: 160 },
  apply: { type: 'boolean', description: 'Publish or revoke the reviewed relationships. False by default: read-only preview.' },
  revoke: { type: 'boolean', description: 'Revoke the publication identified by runId and requestId; requires apply=true to change the graph.' },
  studyId: { ...text('Saved field study identifier.'), maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
  branchId: { ...text('Optional branch within a saved field study.'), maxLength: 100 },
  expectedRevision: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Read-back study revision; use 0 to create.' },
  study: { ...FIELD_STUDY_SCHEMA, description: 'Field scope, branch reviews, search records and paper/method selection. Saving does not mutate graph evidence.' },
  dryRun: { type: 'boolean', description: 'Preview field research scope and worker readiness without searching, downloading, importing or creating a run.' },
  runId: { ...text('Existing literature discovery run id.'), maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
  serverFilePath: text('Already staged server-side PDF/Markdown file to import.'),
  processingProfile: { type: 'string', enum: ['fast-md-structural', 'full'], description: 'fast-md-structural indexes already-materialized Markdown without generic LLM extraction; use before lineage_extract. full runs the general semantic pipeline.' },
  completionPolicy: { type: 'string', enum: ['graph-visible', 'semantic-complete'], description: 'Import completion target. Use graph-visible with fast imports, then review lineage cards separately.' },
  doi: text('Optional DOI for an imported source.'),
  arxivId: text('Optional arXiv id for an imported source.'),
  jobId: text('Durable asynchronous import submission job id.'),
  taskId: text('Import task id from the authoritative queue.'),
  taskIds: { ...strings('Import task ids from a saved discovery run.'), minItems: 1, maxItems: 100 },
  idempotencyKey: { ...text('Stable id for an import submission; reuse to avoid duplicate async jobs.'), maxLength: 200 }
};

const read = (backend, operation, fields, required = [], anyRequired = []) => ({
  backend, operation, fields: ['corpus', 'responseMode', ...fields], required, anyRequired, effect: 'committed_read'
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
    capabilities: { ...read('capabilities', null, []), effect: 'capability_read' },
    corpora: read('list_corpora', null, []),
    status: read('corpus_status', null, []),
    sources: read('corpus_sources', null, []),
    search: read('research_lookup', 'query', ['query', 'limit', 'layers', 'sortBy'], ['query']),
    paper: read('agent_materials', 'paper_material_view', ['query', 'paperId', 'identifier', 'chunkLimit'], [], ['query', 'paperId', 'identifier']),
    lineage_extract: { ...read('lineage_evidence', 'extract', ['papers', 'idempotencyKey', 'retryFailed', 'dryRun'], ['papers', 'idempotencyKey']), effect: 'lineage_extract_submit' },
    lineage_status: { ...read('lineage_evidence', 'status', ['runId'], ['runId']), effect: 'lineage_extract_read' },
    lineage_card: { ...read('lineage_evidence', 'card', ['cardId'], ['cardId']), effect: 'lineage_card_read' },
    lineage_refine: { ...read('lineage_refinement', 'start', ['papers', 'studyId', 'idempotencyKey', 'maxPapers', 'maxQueries', 'maxNewPapers', 'maxRounds', 'retryFailed', 'dryRun'], ['idempotencyKey'], ['papers', 'studyId']), effect: 'lineage_refine_submit' },
    lineage_refine_status: { ...read('lineage_refinement', 'status', ['runId'], ['runId']), effect: 'lineage_refine_read' },
    lineage_publish: { ...read('lineage_publication', 'publish', ['runId', 'requestId', 'apply', 'revoke'], ['runId', 'requestId']), effect: 'lineage_publish_write' },
    survey: read('agent_materials', 'research_material_pack', materialFields, ['query']),
    field_research: { ...read('field_research', 'start', ['query', 'targetDomain', 'fromYear', 'toYear', 'maxDepth', 'maxNodes', 'maxEdges', 'maxPapers', 'providers', 'idempotencyKey', 'dryRun'], [], ['query', 'targetDomain']), effect: 'field_research_submit' },
    field_research_status: { ...read('field_research', 'status', ['runId']), effect: 'field_research_read' },
    study_save: { ...read('field_study', 'save', ['studyId', 'expectedRevision', 'study'], ['studyId', 'expectedRevision', 'study']), effect: 'study_write' },
    study: { ...read('field_study', 'read', ['studyId', 'branchId', 'maxNodes', 'maxEdges'], ['studyId']), effect: 'study_read' },
    studies: { ...read('field_study', 'list', []), effect: 'study_read' },
    discover: { ...read('literature_discovery', 'submit', ['query', 'discoveryMode', 'providers', 'maxPapers'], ['query']), effect: 'discovery_submit' },
    discovery_status: { ...read('literature_discovery_progress', null, ['runId', 'limit']), effect: 'discovery_read' },
    discovery_report: { ...read('literature_discovery', 'report', ['runId'], ['runId']), effect: 'discovery_read' },
    import: { ...read('import_workflow', 'submit', ['serverFilePath', 'runId', 'doi', 'arxivId', 'idempotencyKey', 'processingProfile', 'completionPolicy'], [], ['serverFilePath', 'runId']), effect: 'import_submit' },
    import_status: { ...read('import_workflow', 'queue_progress', ['jobId', 'taskId', 'taskIds']), effect: 'import_read' }
  },
  lineage_analysis: {
    landscape: read('research_lookup', 'field_evolution', ['query', 'targetDomain', 'seedNodeIds', 'fromYear', 'toYear', 'maxDepth', 'maxNodes', 'maxEdges'], [], ['query', 'targetDomain', 'seedNodeIds']),
    overview: read('research_lookup', 'topic_analysis', topicFields),
    problem: read('research_lookup', 'problem_evolution', topicFields, ['query']),
    method: read('research_lookup', 'method_lineage', ['query', 'method', 'direction', 'maxDepth', 'limit'], [], ['query', 'method']),
    evidence: read('research_lookup', 'method_evidence', ['query', 'method', 'sourceMethod', 'targetMethod', 'edgeId', 'limit'], [], ['query', 'method', 'sourceMethod', 'targetMethod', 'edgeId']),
    path: read('research_briefing', 'path_trace', ['from', 'to', 'maxDepth', 'limit', 'layers'], ['from', 'to']),
    context: read('research_lookup', 'context', ['query', 'layers'], ['query']),
    impact: read('research_lookup', 'impact', ['query', 'direction', 'maxDepth', 'layers'], ['query'])
  },
  idea_generation: {
    generate: read('research_lookup', 'ideas', ['query', 'targetDomain', 'mechanisms', 'limit', 'selectionMode', 'selectionK', 'project'], ['query']),
    diverge: read('research_lookup', 'brainstorm', ['query', 'maxDepth', 'limit', 'layers'], ['query']),
    converge: read('research_lookup', 'brainstorm', ['query', 'maxDepth', 'limit', 'layers'], ['query']),
    gaps: read('agent_materials', 'structural_gap_pack', [...materialFields, 'method', 'maxDepth'], ['query']),
    evaluate: read('agent_materials', 'innovation_evidence_pack', [...materialFields, 'method', 'maxDepth', 'candidateMechanism', 'removedComponents', 'project', 'purpose', 'actionId', 'actionVersion']),
    experiment_materials: read('agent_materials', 'experiment_cost_materials', materialFields, ['query'])
  }
};

const DESCRIPTIONS = {
  literature_review: 'Find and read papers, survey sources, and explicitly discover/import missing papers. capabilities lists contracts; corpora/status/sources inspect coverage; search queries the graph; paper reads source evidence. For method genealogy, lineage_extract reads each selected full text once and caches methods, variants and relation candidates by source version; lineage_status reads progress and token usage; lineage_card reads exact evidence and freshness. lineage_refine independently reviews candidates and can supplement missing sources within explicit cumulative budgets; lineage_refine_status is read-only. lineage_publish previews by default and writes supported current relations only with apply=true; revoke withdraws that publication. Model review does not establish scientific validity. discover/import submit jobs; their status/report operations reconcile existing jobs. Use fast-md-structural imports for materialized Markdown before lineage_extract. field_research runs bounded discovery plus general semantic extraction; batch completion is separate from field coverage. study_save/study/studies manage reviewed scopes and native Web maps. Batch and overview responses default to compact summaries; exact evidence reads retain full detail.',
  lineage_analysis: 'Analyze research evolution from committed evidence: landscape builds a field timeline of papers and methods, connected families, structural mainlines and turning-point candidates with source evidence and coverage limits; overview maps a bounded topic graph; problem gives dated problem observations; method traces validated method lineage; evidence checks method-edge quotes; path/context/impact inspect graph connections. A graph path is not causal proof, and bounded endpoints are not global frontiers. Use literature_review for missing papers and idea_generation for proposals.',
  idea_generation: 'Generate and evaluate research hypotheses from committed sources: generate returns graph candidates (cross-domain catalyst if targetDomain is given), with scoped experimental feedback when project is supplied. diverge/converge explore or focus; gaps separates structural gaps. evaluate defaults to novelty_audit with query/candidateMechanism; mechanism_diagnosis and performance_validation require project/actionId and read a registered action. Design readiness is not execution authorization. experiment_materials returns evidence/cost anchors. No live discovery, graph writeback, or controller execution. Candidates and novelty audits do not prove novelty or gains.'
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
          properties: Object.fromEntries(fields.filter((field) => !route.fields.includes(field)).map((field) => [field, false])),
          ...(name === 'idea_generation' && operation === 'evaluate' ? { allOf: [{
            if: { required: ['purpose'], properties: { purpose: { enum: ['mechanism_diagnosis', 'performance_validation'] } } },
            then: { required: ['project', 'actionId'], properties: { candidateMechanism: false, removedComponents: false, targetDomain: false, method: false } },
            else: { required: ['query', 'candidateMechanism'], properties: { project: false, actionId: false, actionVersion: false } }
          }] } : {})
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
  if (profile === 'all') return [...RESEARCH_TOOLS, RESEARCH_DECISION_TOOL, ...PAPERNEXUS_TOOLS];
  return [...RESEARCH_TOOLS, RESEARCH_DECISION_TOOL];
}

function validValue(value, schema) {
  if (schema.oneOf) return schema.oneOf.some((entry) => validValue(value, entry));
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) return false;
  if (schema.type === 'number' && !Number.isFinite(value)) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    if (entries.length > (schema.maxProperties ?? Infinity)) return false;
    if ((schema.required || []).some(key => value[key] === undefined)) return false;
    if (!entries.every(([key, item]) => {
      const child = schema.properties?.[key];
      if (child) return validValue(item, child);
      return schema.additionalProperties === true || (schema.additionalProperties && validValue(item, schema.additionalProperties));
    })) return false;
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
  let backendArgs = { ...pick(args, route.fields.filter(field => field !== 'responseMode')), ...(route.operation ? { operation: route.operation } : {}) };
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
    if (args.operation === 'evaluate') {
      if (args.purpose && args.purpose !== 'novelty_audit') {
        if (!args.project || !args.actionId) throw new Error('Project evaluation requires project and actionId.');
        if (['candidateMechanism', 'removedComponents', 'targetDomain', 'method'].some(k => args[k] !== undefined)) throw new Error('Project evaluation uses the registered action; candidate overrides are not accepted.');
        backend = 'project_evaluation';
        backendArgs = pick(args, ['corpus', 'project', 'purpose', 'actionId', 'actionVersion', 'query']);
      } else {
        if (!args.query || !args.candidateMechanism) throw new Error('novelty_audit requires query and candidateMechanism.');
        if (['project', 'actionId', 'actionVersion'].some(k => args[k] !== undefined)) throw new Error('Action references require a project evaluation purpose.');
        delete backendArgs.purpose;
      }
    }
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
    if (args.processingProfile === 'fast-md-structural' && args.serverFilePath && !/\.(md|markdown)$/i.test(args.serverFilePath)) {
      throw new Error('fast-md-structural requires materialized Markdown; convert the PDF before this import.');
    }
    if (args.runId) {
      if (['doi', 'arxivId', 'idempotencyKey'].some((key) => args[key] !== undefined)) {
        throw new Error('Discovery-run import accepts corpus and runId only; file metadata/idempotencyKey belong to serverFilePath import.');
      }
      backend = 'discovery_import_bridge';
      backendArgs = { ...pick(args, ['corpus', 'runId', 'processingProfile', 'completionPolicy']), operation: 'saved_source_import' };
    } else {
      backendArgs = { ...pick(args, ['corpus', 'serverFilePath', 'doi', 'arxivId', 'idempotencyKey', 'processingProfile', 'completionPolicy']),
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
  if (call.backend === 'project_evaluation') return [next('research_decision', result.task_gate.status === 'ready_for_design' ? 'recommend_next' : 'evidence_view', { project: args.project })];
  if (call.tool === 'idea_generation' && args.project) return [next('research_decision', 'evidence_view', { project: args.project })];
  const runId = result?.runId || result?.run_id || args.runId;
  if (call.backend === 'lineage_refinement') {
    if (result?.dryRun) return [];
    if (!result?.terminal) return [next('literature_review', 'lineage_refine_status', { runId })];
    return [next('literature_review', 'lineage_publish', { runId, requestId: runId.slice(7), apply: false })];
  }
  if (call.backend === 'lineage_publication') return [next('literature_review', 'lineage_publish', {
    runId, requestId: args.requestId, apply: false, ...(args.revoke ? { revoke: true } : {}) })];
  if (call.backend === 'lineage_evidence') {
    if (result?.dryRun || call.args.operation === 'card') return [];
    if (call.args.operation === 'extract' || !result?.terminal) return [next('literature_review', 'lineage_status', { runId })];
    return (result?.entries || []).filter(entry => entry.cardId).slice(0, 3)
      .map(entry => next('literature_review', 'lineage_card', { cardId: entry.cardId }));
  }
  if (call.effect === 'study_write') return [next('literature_review', 'study', { studyId: args.studyId })];
  if (call.backend === 'field_research') return runId && !result?.terminal && !result?.dryRun
    ? [next('literature_review', 'field_research_status', { runId })] : [];
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
  if (args.processingProfile === 'fast-md-structural' && candidates.some(candidate => !/\.(md|markdown)$/i.test(candidate.source.sourcePath || candidate.source.source_path))) {
    throw new Error('This run contains non-Markdown sources. Materialize them first and import selected Markdown files with fast-md-structural.');
  }
  return {
    runId: args.runId,
    sourceAuthority: 'Saved discovery candidates; no provider search or source resolution performed.',
    eligibleSources: candidates.length,
    ...await submitDiscoveryImports({ corpus: rootPath, candidates, maxImported: 100,
      processingProfile: args.processingProfile, completionPolicy: args.completionPolicy, options })
  };
}

export async function executeResearchWorkflow(name, args, options, invoke) {
  const call = resolveResearchWorkflowCall(name, args);
  if (!call) throw new Error('Unknown research tool: ' + name);
  let result = call.backend === 'capabilities'
    ? researchCapabilities(options)
    : call.backend === 'discovery_import_bridge'
    ? await importSavedDiscoverySources(call.args, options)
    : call.backend === 'field_research'
    ? await executeFieldResearchOperation(call.args.corpus, call.args.operation,
        Object.fromEntries(Object.entries(call.args).filter(([key]) => !['corpus', 'operation'].includes(key))), options)
    : call.backend === 'field_study'
    ? await executeFieldStudyOperation(call.args.corpus, call.args.operation,
        Object.fromEntries(Object.entries(call.args).filter(([key]) => !['corpus', 'operation'].includes(key))), options)
    : call.backend === 'lineage_evidence'
    ? await executeLineageEvidenceOperation(call.args.corpus, call.args.operation,
        Object.fromEntries(Object.entries(call.args).filter(([key]) => !['corpus', 'operation'].includes(key))), options)
    : call.backend === 'lineage_refinement'
    ? await executeLineageRefinementOperation(call.args.corpus, call.args.operation,
        Object.fromEntries(Object.entries(call.args).filter(([key]) => !['corpus', 'operation'].includes(key))), options)
    : call.backend === 'lineage_publication'
    ? await executeLineagePublication(call.args.corpus,
        Object.fromEntries(Object.entries(call.args).filter(([key]) => !['corpus', 'operation'].includes(key))), options)
    : call.backend === 'project_evaluation'
    ? await evaluateProject(await resolveCorpusForApi(args.corpus, options), call.args)
    : decodeResult(await invoke(call.backend, call.args, options));
  if (name === 'idea_generation' && args.operation === 'generate' && args.project) {
    const { view } = await readProjectEvidence(await resolveCorpusForApi(args.corpus, options), args.project, { limit: 50 });
    result = attachProjectEvidence(result, view);
  }
  const envelope = {
    contractVersion: RESEARCH_WORKFLOW_VERSION,
    tool: name,
    operation: call.operation,
    backend: call.backend === 'discovery_import_bridge'
      ? { tool: null, component: 'submitDiscoveryImports', operation: 'saved_source_import' }
      : call.backend === 'field_research'
      ? { tool: null, component: 'executeFieldResearchOperation', operation: call.args.operation }
      : call.backend === 'field_study'
      ? { tool: null, component: 'executeFieldStudyOperation', operation: call.args.operation }
      : call.backend === 'lineage_evidence'
      ? { tool: null, component: 'executeLineageEvidenceOperation', operation: call.args.operation }
      : call.backend === 'lineage_refinement'
      ? { tool: null, component: 'executeLineageRefinementOperation', operation: call.args.operation }
      : call.backend === 'lineage_publication'
      ? { tool: null, component: 'executeLineagePublication', operation: call.args.operation }
      : { tool: call.backend, operation: call.args.operation || null },
    result,
    evidenceBoundary: {
      basis: result?.dryRun && ['field_research', 'lineage_evidence', 'lineage_refinement'].includes(call.backend) ? 'dry_run'
        : call.backend === 'lineage_publication' && !args.apply ? 'lineage_publish_preview' : call.effect,
      statusAuthority: 'The backend result and original discovery/import/graph-sync records; this envelope creates no completion state.',
      limitation: name === 'idea_generation'
        ? 'Candidate hypotheses and bounded prior-art evidence do not prove novelty, causal transfer, or experimental gains.'
        : 'Discovery, import submission, graph visibility, and authoritative synchronization are distinct. Graph paths are not causal proof.'
    },
    nextActions: nextActions(call, args, result)
  };
  const defaultFull = ['capabilities', 'paper', 'lineage_card', 'method', 'evidence', 'path'].includes(call.operation);
  const mode = args.responseMode || (defaultFull ? 'full' : 'summary');
  return mode === 'summary' ? summarizeResearchEnvelope(envelope, args) : envelope;
}

export function researchCapabilities(options = {}) {
  return {
    contractVersion: RESEARCH_WORKFLOW_VERSION,
    advertisedProfile: resolveMcpToolProfile(options),
    workflows: { ...Object.fromEntries(Object.entries(RESEARCH_ROUTES).map(([name, routes]) => [name, Object.keys(routes)])), research_decision: DECISION_OPERATIONS },
    researchDecision: { contractVersion: DECISION_VERSION, stateAuthority: 'project/research-decision-state.json', executionAuthority: 'external_executor', writesRequire: ['requestId', 'expectedRevision (except init)'],
      evidenceView: { readOnly: true, maxLimit: 50, includeHistory: true }, multiComparison: true, codeEvidenceOrigin: 'code_inspected',
      evaluationPurposes: ['novelty_audit', 'mechanism_diagnosis', 'performance_validation'], precision: 'anticipated_interval_width requires basis_refs; plan thresholds are not achievable precision evidence' },
    responseModes: ['full', 'summary'], summaryMaxBytes: RESEARCH_SUMMARY_MAX_BYTES,
    responseDefaults: { batchAndOverview: 'summary', exactEvidence: 'full' },
    lineageEvidence: { contractVersion: LINEAGE_CARD_VERSION, extraction: 'one_fulltext_pass_per_source_version',
      cache: 'paper_source_version_model_contract', retries: 'explicit_failed_only', graphWriteback: false,
      usage: 'provider_reported_by_phase', statusOperation: 'lineage_status', cardOperation: 'lineage_card' },
    lineageRefinement: { contractVersion: LINEAGE_REFINEMENT_VERSION, startOperation: 'lineage_refine',
      statusOperation: 'lineage_refine_status', publishOperation: 'lineage_publish',
      statusReadOnly: true, review: 'full_source_model_review_with_identity_and_quote_checks',
      externalBudgetsDefault: 0, publicationDefault: 'preview', publicationRequires: ['terminal runId', 'requestId', 'apply=true'],
      persistence: 'source_bound_publications_replayed_on_graph_load', scientificValidation: false },
    advanced: { tool: 'agent_materials', operations: ['proposal_graph_session', 'research_controller'],
      profileHint: 'Legacy names remain callable; clients needing schema discovery can use the all or legacy profile.',
      proposalExecution: 'caller_supplied_actions', proposalRequiredInput: 'proposalActions or proposalSlates',
      sourceAdmission: 'research-quality-v1' },
    evidenceBoundary: 'Graph visibility, source admission, semantic readiness and scientific verification are distinct.'
  };
}
