#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runAuthoritativeSyncQueueOnce } from '../src/core/authoritative-sync/worker.js';
import { applyGraphDeltaPayload, buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { buildGraphV2Shadow, cutoverGraphV2, verifyGraphV2 } from '../src/core/graph-v2/migration.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { validatePipelineInvariants } from '../src/core/control/pipeline-invariants.js';
import { executeIdeaCatalystTool } from '../src/mcp/tool-idea-catalyst.js';
import { ensureDir, writeJson } from '../src/lib/fs.js';
import { slugify, stableHash } from '../src/lib/utils.js';
import {
  getCorpusPaths,
  loadCorpus,
  saveCorpus,
  saveCorpusFastLocalDelta,
  saveSourceManifest
} from '../src/storage/corpus-store.js';
import {
  loadLatestKuzuCommitReceipt,
  verifyKuzuCommitReceipt
} from '../src/storage/kuzu-commit-receipt-store.js';
import {
  startRun,
  updateRunStage,
  updateRunState,
  writeRunCheckpoint
} from '../src/storage/run-store.js';
import { loadTraceSpans } from '../src/storage/trace-store.js';
import {
  validateProvenanceRefs,
  writeProvenanceEnvelope
} from '../src/storage/provenance-store.js';

function nowIso() {
  return new Date().toISOString();
}

function timestampToken() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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

function buildCorpusId(name, rootPath) {
  return `corpus:${slugify(name)}:${stableHash(rootPath)}`;
}

async function writeSourceMarkdown(sourcePath, title, body) {
  await ensureDir(path.dirname(sourcePath));
  await fs.writeFile(sourcePath, `# ${title}\n\n${body}\n`, 'utf8');
}

function createSemanticPaper(sourcePath, overrides = {}) {
  const paperId = overrides.paperId || 'paper:new';
  const paperTitle = overrides.paperTitle || 'New Paper';
  const sourceKey = overrides.sourceKey || `source:${paperId.replace(/^paper:/, '')}`;
  return {
    paperId,
    paperTitle,
    sourceKey,
    sourcePath,
    sourceMarkdownPath: sourcePath,
    sourcePdfPath: null,
    sourceKind: 'markdown',
    sourceFingerprint: overrides.sourceFingerprint || `fp:${stableHash(sourcePath, 12)}`,
    authors: ['PaperNexus Acceptance Harness'],
    abstract: 'We study adaptive human-AI collaboration with prototype alignment and metacontrol switching.',
    problems: [{
      name: 'Adaptive Human-AI Collaboration',
      text: 'adaptive human-AI collaboration',
      evidenceText: 'Assistants need robust adaptation under shifting intent.',
      sectionRole: 'abstract',
      confidence: 0.86
    }],
    methods: [{
      name: 'prototype alignment',
      text: 'prototype alignment',
      evidenceText: 'Prototype alignment stabilizes the assistant policy.',
      sectionRole: 'method',
      confidence: 0.83
    }],
    datasets: [],
    benchmarks: [],
    metrics: [],
    claims: [{
      name: 'Metacontrol switching improves adaptive collaboration.',
      text: 'Metacontrol switching improves adaptive collaboration.',
      evidenceText: 'Metacontrol switching helps decide when to persist or switch goals.',
      sectionRole: 'results',
      confidence: 0.8
    }],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [{
      text: 'The acceptance harness preserves a source span for provenance validation.',
      section: 'Results',
      sectionHeading: 'Results',
      sectionRole: 'results',
      confidence: 0.78,
      linkedDatasets: [],
      linkedMetrics: []
    }],
    futureDirections: [],
    llmRelations: [],
    ...overrides
  };
}

function createFakeSemanticScholarResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null, entries: () => [][Symbol.iterator]() },
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    }
  };
}

function snippet(corpusId, title, text) {
  return {
    score: 0.92,
    paper: {
      corpusId,
      title,
      authors: ['Acceptance Author']
    },
    snippet: {
      text,
      snippetKind: 'abstract',
      section: 'Abstract'
    }
  };
}

function createAcceptanceLlmJson() {
  return async ({ task }) => {
    if (task === 'decompose') {
      return {
        research_questions: [{
          id: 'q1',
          domain_specific_question: 'How can assistants adapt to shifting user intent?',
          domain_agnostic_question: 'How can behavior adapt to shifting collaborators?',
          target_search_queries: ['adaptive intent collaboration']
        }]
      };
    }
    if (task === 'target_assessment') {
      return {
        progress: 'partially addressed',
        remaining_challenges: [{
          id: 'challenge:shift',
          domain_specific_challenge: 'Assistants need robust intent-shift adaptation.',
          domain_agnostic_challenge: 'How can behavior adapt to shifting collaborators?',
          target_evidence_ids: ['target-1']
        }]
      };
    }
    if (task === 'source_domains') {
      return {
        source_domains: [
          {
            domain: 'Psychology',
            rationale: 'Psychology studies metacontrol under shifting goals.',
            source_search_queries: ['metacontrol shifting goals']
          },
          {
            domain: 'Human Factors',
            rationale: 'Human factors studies handoff and interruption recovery.',
            source_search_queries: ['human factors interruption recovery']
          }
        ]
      };
    }
    if (task === 'source_relevance') {
      return {
        papers: [
          { paper_key: 'psy1', relevant: true, reason: 'Metacontrol is transferable.' },
          { paper_key: 'hf1', relevant: true, reason: 'Interruption recovery is transferable.' }
        ]
      };
    }
    if (task === 'source_takeaways') {
      return {
        takeaways: [
          {
            id: 'takeaway:metacontrol',
            concept: 'Metacontrol switching',
            mechanism: 'Systems switch between persistence and flexibility under changing goals.',
            source_logic: 'Goal regulation provides the transfer mechanism.',
            paper_keys: ['psy1']
          },
          {
            id: 'takeaway:handoff',
            concept: 'Handoff recovery',
            mechanism: 'Operators recover context through explicit handoff cues.',
            source_logic: 'Context handoff provides the transfer mechanism.',
            paper_keys: ['hf1']
          }
        ]
      };
    }
    if (task === 'idea_fragments') {
      return {
        idea_fragments: [
          {
            id: 'fragment:metacontrol',
            title: 'Metacontrol-inspired intent switching',
            target_challenge_id: 'challenge:shift',
            target_challenge: 'Assistants need robust intent-shift adaptation.',
            source_domain: 'Psychology',
            source_takeaway_ids: ['takeaway:metacontrol'],
            integration_rationale: 'Use metacontrol to decide when to persist or switch assistant goals.',
            novelty_score: 0.74,
            usefulness_score: 0.82,
            supporting_paper_keys: ['psy1']
          },
          {
            id: 'fragment:handoff',
            title: 'Handoff-cued conversation repair',
            target_challenge_id: 'challenge:shift',
            target_challenge: 'Assistants need robust intent-shift adaptation.',
            source_domain: 'Human Factors',
            source_takeaway_ids: ['takeaway:handoff'],
            integration_rationale: 'Use explicit handoff cues to recover the user intent context after interruption.',
            novelty_score: 0.68,
            usefulness_score: 0.76,
            supporting_paper_keys: ['hf1']
          }
        ]
      };
    }
    if (task === 'pairwise_ranking') {
      return {
        comparisons: [{
          winner_id: 'fragment:metacontrol',
          loser_id: 'fragment:handoff',
          rationale: 'Metacontrol directly addresses the switching decision.'
        }]
      };
    }
    return {};
  };
}

async function withAcceptanceFetch(fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/snippet/search')) {
      throw new Error(`Unexpected acceptance fetch URL: ${url.toString()}`);
    }
    const field = url.searchParams.get('fieldsOfStudy');
    if (field === 'Computer Science') {
      return createFakeSemanticScholarResponse({
        data: [snippet('target-1', 'Adaptive Assistants', 'Assistants adapt to user intent.')]
      });
    }
    if (field === 'Psychology') {
      return createFakeSemanticScholarResponse({
        data: [snippet('psy1', 'Metacontrol', 'Metacontrol balances persistence and flexibility.')]
      });
    }
    if (field === 'Human Factors') {
      return createFakeSemanticScholarResponse({
        data: [snippet('hf1', 'Handoff Recovery', 'Handoff cues help operators recover context.')]
      });
    }
    return createFakeSemanticScholarResponse({ data: [] });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function seedInitialCorpus(rootPath, corpusName, oldSourcePath) {
  const corpusId = buildCorpusId(corpusName, rootPath);
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: corpusId,
    type: NODE_TYPES.CORPUS,
    name: corpusName,
    properties: {
      layer: 'CorpusLayer',
      rootPath
    }
  });
  graph.addNode({
    id: 'paper:old',
    type: NODE_TYPES.PAPER,
    name: 'Seed Paper',
    properties: {
      layer: 'DocumentLayer',
      paperId: 'paper:old',
      paperTitle: 'Seed Paper',
      sourcePath: oldSourcePath
    }
  });
  graph.addRelationship(createRelationship(corpusId, 'paper:old', EDGE_TYPES.CONTAINS));

  await saveCorpus(rootPath, graph, {
    name: corpusName,
    indexedAt: nowIso(),
    paperCount: 1,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, {
    liteViewMode: 'incremental',
    liteViewSources: [{
      sourceKey: 'source:old',
      paperId: 'paper:old',
      paperTitle: 'Seed Paper',
      sourceFingerprint: 'fp:old'
    }]
  });
  await saveSourceManifest(rootPath, {
    corpusName,
    rootPath,
    sources: [{
      sourceKey: 'source:old',
      paperId: 'paper:old',
      paperTitle: 'Seed Paper',
      fingerprint: 'fp:old',
      path: oldSourcePath,
      activeInGraph: true
    }]
  });
  return graph;
}

function parseArgs(argv = []) {
  const parsed = {
    outputDir: '',
    reset: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--output-dir') {
      parsed.outputDir = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--reset') {
      parsed.reset = true;
    } else if (arg === '--json') {
      parsed.json = true;
    }
  }
  return parsed;
}

export async function runEngineeringControlAcceptance(options = {}) {
  const startedAtMs = Date.now();
  const outputDir = path.resolve(options.outputDir || path.join(
    process.cwd(),
    '.papernexus',
    'engineering-control-acceptance',
    timestampToken()
  ));
  if (options.reset) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await ensureDir(outputDir);

  const corpusRoot = path.join(outputDir, 'corpus');
  const sourcesDir = path.join(corpusRoot, 'sources');
  const artifactsDir = path.join(outputDir, 'artifacts');
  const ledgerDir = path.join(artifactsDir, 'idea-catalyst-ledger');
  await ensureDir(artifactsDir);

  const corpusName = 'engineering-control-acceptance';
  const oldSourcePath = path.join(sourcesDir, 'seed-paper.md');
  const newSourcePath = path.join(sourcesDir, 'adaptive-collaboration.md');
  await writeSourceMarkdown(
    oldSourcePath,
    'Seed Paper',
    'This seed paper initializes a small graph-v2 corpus for the engineering-control acceptance run.'
  );
  await writeSourceMarkdown(
    newSourcePath,
    'Adaptive Collaboration',
    'Assistants need robust adaptation under shifting intent. Prototype alignment and metacontrol switching provide the tested evidence spans.'
  );

  const traceId = `trace:engineering-control:${stableHash(outputDir, 16)}`;
  const runId = `engineering-control:${stableHash(outputDir, 16)}`;
  const run = await startRun(corpusRoot, {
    kind: 'engineering-control-acceptance',
    runId,
    traceId,
    command: 'engineering-control-acceptance',
    currentStage: 'seed_corpus',
    manifestToken: 'manifest:acceptance-base',
    configSignature: 'engineering-control-acceptance-v1',
    paperIds: ['paper:new'],
    metadata: {
      outputDir,
      persistentAcceptance: true
    }
  });

  let previousGraphBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await updateRunStage(corpusRoot, runId, 'seed_corpus', {
      status: 'running',
      processedUnits: 0,
      totalUnits: 1,
      percent: 0,
      artifactPaths: [oldSourcePath],
      message: 'Seeding minimal persistent corpus'
    });
    await seedInitialCorpus(corpusRoot, corpusName, oldSourcePath);
    await updateRunStage(corpusRoot, runId, 'seed_corpus', {
      status: 'completed',
      processedUnits: 1,
      totalUnits: 1,
      percent: 100,
      completedAt: nowIso(),
      artifactPaths: [oldSourcePath, getCorpusPaths(corpusRoot).metaPath],
      message: 'Seed corpus saved'
    });

    const buildShadow = await buildGraphV2Shadow(corpusRoot, {
      runId,
      force: true,
      resetShadow: true
    });
    const cutover = await cutoverGraphV2(corpusRoot, {
      runId,
      force: true
    });
    const preDeltaGraphVerification = await verifyGraphV2(corpusRoot, { runId });

    await updateRunStage(corpusRoot, runId, 'fast_delta_commit', {
      status: 'running',
      processedUnits: 0,
      totalUnits: 1,
      percent: 0,
      artifactPaths: [newSourcePath],
      message: 'Building incremental graph delta'
    });
    const activeCorpus = await loadCorpus(corpusRoot);
    const semanticPaper = createSemanticPaper(newSourcePath);
    const delta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: corpusRoot,
      committedGraph: activeCorpus.graph,
      semanticPapers: [semanticPaper]
    });
    const nextGraph = applyGraphDeltaPayload(activeCorpus.graph, delta);
    const targetManifest = {
      corpusName,
      rootPath: corpusRoot,
      sources: [
        {
          sourceKey: 'source:old',
          paperId: 'paper:old',
          paperTitle: 'Seed Paper',
          fingerprint: 'fp:old',
          path: oldSourcePath,
          activeInGraph: true
        },
        {
          sourceKey: semanticPaper.sourceKey,
          paperId: semanticPaper.paperId,
          paperTitle: semanticPaper.paperTitle,
          fingerprint: semanticPaper.sourceFingerprint,
          path: newSourcePath,
          activeInGraph: true
        }
      ]
    };
    const fastDelta = await saveCorpusFastLocalDelta(corpusRoot, delta, {
      ...activeCorpus.meta,
      paperCount: 2,
      nodeCount: nextGraph.nodeCount,
      relationshipCount: nextGraph.relationshipCount,
      graphV2Status: 'active'
    }, targetManifest, {
      baseManifestToken: 'manifest:acceptance-base',
      targetManifestToken: 'manifest:acceptance-target'
    });
    await updateRunStage(corpusRoot, runId, 'fast_delta_commit', {
      status: 'completed',
      processedUnits: 1,
      totalUnits: 1,
      percent: 100,
      completedAt: nowIso(),
      checkpointKey: fastDelta.syncJob?.jobId || null,
      artifactPaths: [newSourcePath, getCorpusPaths(corpusRoot).liteGraphPath],
      message: 'Fast local delta saved and authoritative sync queued'
    });

    const authoritativeSync = await runAuthoritativeSyncQueueOnce(corpusRoot, {
      runId,
      traceId
    });
    const latestReceipt = await loadLatestKuzuCommitReceipt(corpusRoot);
    const receiptVerification = await verifyKuzuCommitReceipt(corpusRoot, 'latest');
    await updateRunStage(corpusRoot, runId, 'kuzu_commit', {
      status: receiptVerification.ok ? 'completed' : 'needs_repair',
      processedUnits: receiptVerification.ok ? 1 : 0,
      totalUnits: 1,
      percent: receiptVerification.ok ? 100 : 50,
      completedAt: receiptVerification.ok ? nowIso() : null,
      artifactPaths: [
        latestReceipt?.kuzu_database_path,
        getCorpusPaths(corpusRoot).metaPath
      ].filter((entry) => typeof entry === 'string' && entry),
      message: receiptVerification.ok ? 'Kuzu receipt verified' : 'Kuzu receipt verification needs repair'
    });

    const mcpResponse = await withAcceptanceFetch(() => executeIdeaCatalystTool({
      mode: 'live_discovery',
      outputMode: 'idea_fragments',
      includeAnalysis: true,
      problem: 'adaptive human-AI collaboration under shifting intent',
      targetDomain: 'Natural Language Processing',
      numQuestions: 1,
      numSourceDomains: 2,
      maxPapersPerQuery: 5,
      sourceRelevanceThreshold: 0.5,
      semanticScholarRequestDelayMs: 0,
      semanticScholarMaxConcurrent: 1,
      retryCount: 0,
      llmJson: createAcceptanceLlmJson(),
      llmBatchLedgerDir: ledgerDir,
      llmBatchRunId: runId,
      traceId,
      runId
    }, {}));
    const evidenceExportPath = path.join(artifactsDir, 'idea-catalyst-evidence-export.json');
    await writeJson(evidenceExportPath, mcpResponse.evidence_export);
    await updateRunStage(corpusRoot, runId, 'mcp_idea_catalyst', {
      status: mcpResponse.evidence_export?.evidence_status === 'source_backed' ? 'completed' : 'needs_repair',
      processedUnits: mcpResponse.idea_fragments?.length || 0,
      totalUnits: Math.max(1, mcpResponse.idea_fragments?.length || 0),
      percent: 100,
      completedAt: nowIso(),
      artifactPaths: [evidenceExportPath, path.join(ledgerDir, 'llm-results.jsonl')],
      message: 'Idea-Catalyst MCP response and evidence export generated'
    });

    const provenanceResult = await writeProvenanceEnvelope(corpusRoot, {
      generated_by_activity: 'engineering_control_acceptance',
      responsible_agent: 'papernexus-acceptance-harness',
      trace_id: traceId,
      run_id: runId,
      paper_id: semanticPaper.paperId,
      source_spans: [{
        artifact_path: newSourcePath,
        paper_key: semanticPaper.sourceKey,
        section: 'Abstract',
        text: 'Assistants need robust adaptation under shifting intent.'
      }],
      kuzu_commit_receipt: latestReceipt
        ? path.join(corpusRoot, '.papernexus', 'kuzu-receipts', `${encodeURIComponent(latestReceipt.receipt_id)}.json`)
        : null,
      llm_ledger_refs: [{
        ledger_path: path.join(ledgerDir, 'llm-results.jsonl')
      }],
      artifact_paths: [evidenceExportPath],
      output_hash: stableHash(JSON.stringify(mcpResponse.evidence_export), 24),
      graph_generation: latestReceipt?.graph_generation ?? null,
      evidence_status: mcpResponse.evidence_export?.evidence_status || null
    }, {
      path: path.join(artifactsDir, 'provenance.json')
    });
    const provenanceValidation = await validateProvenanceRefs(corpusRoot, provenanceResult.envelope);

    const terminalReportPath = path.join(artifactsDir, 'terminal-report.json');
    const invariantReport = validatePipelineInvariants({
      paper: {
        status: 'completed',
        parse_artifact_path: newSourcePath
      },
      llm: {
        llm_enhanced: true,
        llm_ledger_refs: mcpResponse.evidence_export?.llm_ledger_refs || []
      },
      graph: {
        graph_ready: true,
        kuzu_commit_receipt: latestReceipt
      },
      projection: {
        projection_ready: true,
        projection_graph_generation: latestReceipt?.graph_generation,
        kuzu_commit_receipt: latestReceipt
      },
      mcp: {
        mcp_research_lookup_ready: true,
        graph_generation: latestReceipt?.graph_generation
      },
      queue: {
        status: 'completed',
        terminal_report_path: terminalReportPath,
        failed_paper_count: 0,
        repair_actions: []
      },
      idea_catalyst_export: mcpResponse.evidence_export
    });

    const trace = await loadTraceSpans(corpusRoot, traceId);
    const acceptanceOk = Boolean(
      authoritativeSync.processed
      && !authoritativeSync.failed
      && receiptVerification.ok
      && mcpResponse.evidence_export?.evidence_status === 'source_backed'
      && provenanceValidation.ok
      && invariantReport.ok
      && trace.spans.length > 0
    );
    const terminalReport = {
      report_version: 'papernexus-engineering-control-acceptance-v1',
      status: acceptanceOk ? 'completed' : 'needs_repair',
      output_dir: outputDir,
      corpus_root: corpusRoot,
      run_id: runId,
      trace_id: traceId,
      graph_v2: {
        build_shadow_run_id: buildShadow.runId,
        cutover_run_id: cutover.runId,
        pre_delta_verify_ok: preDeltaGraphVerification.report.ok
      },
      authoritative_sync: {
        processed: authoritativeSync.processed,
        failed: authoritativeSync.failed,
        job_id: authoritativeSync.jobId || null
      },
      kuzu_commit_receipt: {
        receipt_id: latestReceipt?.receipt_id || null,
        status: latestReceipt?.status || null,
        verification_ok: receiptVerification.ok,
        graph_generation: latestReceipt?.graph_generation ?? null,
        receipt_path: latestReceipt
          ? path.join(corpusRoot, '.papernexus', 'kuzu-receipts', `${encodeURIComponent(latestReceipt.receipt_id)}.json`)
          : null
      },
      mcp_idea_catalyst: {
        response_run_id: mcpResponse.run_id || null,
        response_trace_id: mcpResponse.trace_id || null,
        idea_fragment_count: mcpResponse.idea_fragments?.length || 0,
        evidence_status: mcpResponse.evidence_export?.evidence_status || null,
        evidence_export_path: evidenceExportPath,
        llm_ledger_dir: ledgerDir
      },
      provenance: {
        path: provenanceResult.provenancePath,
        validation_ok: provenanceValidation.ok,
        dangling_ref_count: provenanceValidation.dangling_ref_count
      },
      trace: {
        trace_path: trace.tracePath,
        span_count: trace.spans.length
      },
      invariants: invariantReport,
      duration_ms: Date.now() - startedAtMs,
      generated_at: nowIso()
    };
    await writeJson(terminalReportPath, terminalReport);
    await writeRunCheckpoint(corpusRoot, runId, 'acceptance/terminal-report', {
      status: terminalReport.status,
      outputHash: stableHash(JSON.stringify(terminalReport), 24),
      reportPath: terminalReportPath
    });
    await updateRunStage(corpusRoot, runId, 'terminal_report', {
      status: terminalReport.status,
      processedUnits: acceptanceOk ? 1 : 0,
      totalUnits: 1,
      percent: acceptanceOk ? 100 : 50,
      completedAt: acceptanceOk ? nowIso() : null,
      artifactPaths: [terminalReportPath],
      message: acceptanceOk ? 'Acceptance terminal report completed' : 'Acceptance terminal report needs repair'
    });
    await updateRunState(corpusRoot, runId, {
      status: terminalReport.status,
      terminalReportPath,
      canContinue: !acceptanceOk,
      completedAt: acceptanceOk ? nowIso() : null,
      lastError: acceptanceOk ? null : { message: 'engineering-control acceptance needs repair' }
    });

    return terminalReport;
  } finally {
    if (previousGraphBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousGraphBackend;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runEngineeringControlAcceptance(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`PaperNexus engineering-control acceptance: ${report.status}`);
  console.log(`Output: ${report.output_dir}`);
  console.log(`Run: ${report.run_id}`);
  console.log(`Trace: ${report.trace_id}`);
  console.log(`Kuzu receipt: ${report.kuzu_commit_receipt.status} (${report.kuzu_commit_receipt.receipt_id || 'missing'})`);
  console.log(`Idea-Catalyst evidence: ${report.mcp_idea_catalyst.evidence_status}`);
  console.log(`Terminal report: ${path.join(report.output_dir, 'artifacts', 'terminal-report.json')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
