import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { saveDiscoveryRun } from '../src/core/discovery/store.js';
import { listImportTasks, completeImportTask } from '../src/storage/import-store.js';
import { executeFieldResearchOperation, fieldResearchPaths, normalizeFieldResearchRequest, startFieldResearchRecoveryWorker } from '../src/core/research/field-research.js';
import { matchFieldResearchPaper, selectFieldResearchCandidates, summarizeFieldResearchImports } from '../src/core/research/field-research-scope.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-field-research-'));
  const paths = getCorpusPaths(root);
  const graph = createFieldEvolutionFixture();
  const paper = graph.getNode('p-m0');
  graph.updateNode({ ...paper, properties: { ...paper.properties, doi: '10.1234/known' } });
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'field-research-demo', rootPath: root, paperCount: 19 }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  const source = path.join(root, 'new-paper.md');
  await fs.writeFile(source, '# Cross-domain feedback operator\n\n## Abstract\n\nA different vocabulary for adaptive control with sparse observations.\n');
  return { root, paths, graph, source, options: { workerRootPaths: [root] } };
}

async function waitUntil(read, predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for field research fixture.');
}

test('field research validates explicit bounded requests and previews without writes', async () => {
  assert.throws(() => normalizeFieldResearchRequest({ query: 'feedback' }), /idempotencyKey/);
  assert.throws(() => normalizeFieldResearchRequest({ query: 'feedback', dryRun: true, maxPapers: 101 }), /maxPapers/);
  assert.throws(() => normalizeFieldResearchRequest({ query: 'feedback', dryRun: true, providers: ['invalid'] }), /providers/);
  assert.throws(() => normalizeFieldResearchRequest({ query: 'feedback', dryRun: true, llmApiKey: 'ignored' }), /does not accept/);
  const f = await fixture();
  try {
    const result = await executeFieldResearchOperation(f.root, 'start', { query: 'feedback', dryRun: true }, f.options);
    assert.equal(result.status, 'planned');
    assert.equal(result.execution.maxPapers, 20);
    assert.equal(result.readiness.ready, true);
    await assert.rejects(fs.stat(fieldResearchPaths(f.root).directory), { code: 'ENOENT' });
    await assert.rejects(executeFieldResearchOperation(f.root, 'start', { query: 'feedback', idempotencyKey: 'disabled' },
      { ...f.options, fieldResearchWorkers: { imports: false } }), /enabled import worker/);
    assert.equal((await listImportTasks(f.root)).tasks.length, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('candidate selection keeps early and recent research and skips indexed sources before the download budget', () => {
  const papers = [{ id: 'known-paper', type: 'Paper', properties: { doi: '10.1234/known' } }];
  const candidates = [
    { id: 'known', title: 'Known', year: 2025, identifiers: { doi: '10.1234/known' } },
    { id: 'old', title: 'Foundational control', year: 1982, selectionScore: 1 },
    { id: 'mid', title: 'Middle development', year: 2005, selectionScore: 2 },
    { id: 'new', title: 'Recent extension', year: 2024, selectionScore: 10 },
    { id: 'undated', title: 'Uncertain date', selectionScore: 20 },
    { id: 'new2', title: 'Another recent paper', year: 2025, selectionScore: 9 }
  ];
  const selected = selectFieldResearchCandidates(candidates, { papers, phase: 'source_resolution', request: { maxPapers: 4 } });
  assert.deepEqual(selected.candidates.map(c => c.id), ['old', 'mid', 'new', 'undated']);
  assert.equal(selected.selection.counts.already_indexed, 1);
  assert.equal(selected.selection.counts.budget_omitted, 1);
  const filtered = selectFieldResearchCandidates(candidates, { papers, phase: 'source_resolution', request: { maxPapers: 4, fromYear: 2020 } });
  assert.equal(filtered.selection.counts.outside_year_range, 2);
  assert.ok(filtered.candidates.some(c => c.id === 'undated'));
});

test('paper mapping requires a unique strong identifier or an exact imported source path', () => {
  const papers = [
    { id: 'a', type: 'Paper', name: 'Shared title', properties: { doi: '10.1234/a', sourcePath: '/tmp/a.md' } },
    { id: 'b', type: 'Paper', name: 'Shared title', properties: { doi: '10.1234/b', sourcePath: '/tmp/b.md' } }
  ];
  assert.equal(matchFieldResearchPaper({ title: 'Shared title' }, papers), null);
  assert.equal(matchFieldResearchPaper({ identifiers: { doi: '10.1234/a' } }, papers), 'a');
  assert.equal(matchFieldResearchPaper({ title: 'Shared title' }, papers, ['/tmp/b.md']), 'b');
  assert.equal(matchFieldResearchPaper({ doi: '10.1234/a' }, [...papers, { ...papers[0], id: 'duplicate' }]), null);
  assert.equal(matchFieldResearchPaper({ doi: '10.1234/b' }, [papers[0]], ['/tmp/a.md']), null);
});

test('readiness distinguishes task completion, semantic completion and authoritative synchronization', () => {
  const receipt = { results: [{ taskId: 'one', status: 'submitted' }] };
  const complete = { id: 'one', status: 'completed', graphVisibilityStatus: 'completed', semanticStatus: 'completed', authoritativeSyncStatus: 'completed' };
  assert.equal(summarizeFieldResearchImports(receipt, [{ ...complete, semanticStatus: 'queued' }]).stage, 'extracting');
  assert.equal(summarizeFieldResearchImports(receipt, [{ ...complete, authoritativeSyncStatus: 'running' }]).stage, 'synchronizing');
  assert.equal(summarizeFieldResearchImports(receipt, [{ ...complete, semanticStatus: 'unknown' }]).terminal, false);
  const structural = summarizeFieldResearchImports(receipt, [{ ...complete, semanticStatus: 'not-required' }]);
  assert.equal(structural.counts.failed, 1);
  assert.match(structural.issues[0].message, /structural/);
  assert.equal(summarizeFieldResearchImports(receipt, []).stage, 'needs_attention');
  const ready = summarizeFieldResearchImports(receipt, [complete]);
  assert.equal(ready.terminal, true);
  assert.deepEqual(ready.readyTaskIds, ['one']);
});

test('provider failures and skipped calls prevent completed imports from becoming evidence-ready', () => {
  const receipt = { results: [{ taskId: 'one', status: 'submitted' }] };
  const complete = { id: 'one', status: 'completed', graphVisibilityStatus: 'completed',
    semanticStatus: 'completed', authoritativeSyncStatus: 'completed' };
  for (const llmBatches of [
    { completedBatchCount: 13, failedBatchCount: 13, failureReasons: { 'provider-network': 13 } },
    { completedBatchCount: 13, failedBatchCount: 1 },
    { completedBatchCount: 13, skippedProviderCallCount: 1 }
  ]) {
    const result = summarizeFieldResearchImports(receipt, [{ ...complete,
      result: { metrics: { importPerformance: { llmBatches } } } }]);
    assert.equal(result.counts.ready, 0);
    assert.equal(result.counts.failed, 1);
    assert.deepEqual(result.readyTaskIds, []);
    assert.equal(result.issues[0].stage, 'extraction');
  }
  const cached = summarizeFieldResearchImports(receipt, [{ ...complete,
    result: { metrics: { importPerformance: { llmBatches: {
      completedBatchCount: 13, cachedBatchCount: 13, skippedBatchCount: 13,
      failedBatchCount: 0, skippedProviderCallCount: 0
    } } } } }]);
  assert.deepEqual(cached.readyTaskIds, ['one']);
});

test('one durable request queues real imports once and exposes new admitted papers only after completion', async () => {
  const f = await fixture();
  let discoveries = 0;
  const candidate = { id: 'new', title: 'Cross-domain feedback operator', year: 2025, identifiers: { doi: '10.1234/new' },
    source: { resolutionStatus: 'fulltext_ready', sourcePath: f.source } };
  const options = { ...f.options, fieldResearchDependencies: { async discover(args, supplied) {
    discoveries++;
    await supplied.onLiteratureDiscoveryProgress({ stage: 'provider_search', rawCandidateCount: 1 });
    const selected = await supplied.selectDiscoveryCandidates([candidate], { phase: 'source_resolution' });
    const run = { runId: args.runId, topic: args.query, candidates: selected.candidates, candidateSelection: selected.selection,
      coverage: { providerFailureSummary: [] }, queryResults: [], plan: { queries: [] } };
    await saveDiscoveryRun(f.root, run);
    return run;
  } } };
  const request = { query: 'feedback calibration', targetDomain: 'Education', idempotencyKey: 'first', maxPapers: 2 };
  try {
    const [started, duplicate] = await Promise.all([
      executeFieldResearchOperation(f.root, 'start', request, options),
      executeFieldResearchOperation(f.root, 'start', request, options)
    ]);
    assert.equal(started.runId, duplicate.runId);
    assert.ok(started.replayed !== duplicate.replayed);
    const read = () => executeFieldResearchOperation(f.root, 'status', { runId: started.runId }, options);
    const pending = await waitUntil(read, status => Boolean(status.imports));
    assert.equal(pending.stage, 'importing');
    assert.equal(pending.analysis, undefined);
    assert.equal(discoveries, 1);
    const { tasks } = await listImportTasks(f.root);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].processingProfile, 'full');
    assert.equal(tasks[0].completionPolicy, 'semantic-complete');
    await assert.rejects(executeFieldResearchOperation(f.root, 'start', { ...request, maxPapers: 3 }, options), /different field research request/);
    f.graph.addNode({ id: 'new-paper', type: 'Paper', name: candidate.title,
      properties: { year: 2025, fieldOfStudy: 'Engineering', doi: '10.1234/new' } });
    await fs.writeFile(f.paths.liteGraphPath, JSON.stringify(f.graph.toJSON()));
    await completeImportTask(f.root, tasks[0].id, { authoritativeSync: { status: 'completed' } });
    const finished = await read();
    assert.equal(finished.terminal, true);
    assert.ok(finished.analysis.result.papers.some(p => p.id === 'new-paper'));
    assert.ok(finished.analysis.result.scope.research.linkedPaperIds.includes('new-paper'));
    assert.equal(finished.imports.counts.ready, 1);
    await executeFieldResearchOperation(f.root, 'start', request, options);
    assert.equal(discoveries, 1);
    assert.equal((await listImportTasks(f.root)).tasks.length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('recovery reuses a saved discovery report and completes the import handoff', async () => {
  const f = await fixture();
  let calls = 0;
  const runId = 'field-recovery';
  let worker;
  try {
    const paths = fieldResearchPaths(f.root, runId);
    await fs.mkdir(path.dirname(paths.record), { recursive: true });
    await fs.writeFile(paths.record, JSON.stringify({ runId, discoveryRunId: runId, stage: 'import_submission',
      request: { query: 'feedback', maxPapers: 2 }, execution: {}, importResults: null }));
    await saveDiscoveryRun(f.root, { runId, topic: 'feedback', candidates: [], coverage: {}, queryResults: [] });
    worker = startFieldResearchRecoveryWorker({ ...f.options, rootPaths: [f.root], fieldResearchDependencies: {
      discover() { throw new Error('Saved discovery must be reused'); },
      async submitImports() { calls++; return { submitted: 0, failed: 0, results: [] }; }
    } });
    const record = await waitUntil(async () => JSON.parse(await fs.readFile(paths.record, 'utf8')), record => Boolean(record.importResults));
    assert.equal(record.stage, 'evidence');
    assert.equal(calls, 1);
    await worker.pollNow();
    assert.equal(calls, 1);
  } finally { worker?.stop(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('a missing saved discovery report cannot report terminal success', async () => {
  const f = await fixture();
  const runId = 'field-missing-report';
  try {
    const paths = fieldResearchPaths(f.root, runId);
    await fs.mkdir(path.dirname(paths.record), { recursive: true });
    await fs.writeFile(paths.record, JSON.stringify({ runId, discoveryRunId: runId, stage: 'evidence',
      request: { query: 'feedback', maxPapers: 2 }, execution: {}, importResults: { results: [] } }));
    const status = await executeFieldResearchOperation(f.root, 'status', { runId }, f.options);
    assert.equal(status.status, 'needs_attention');
    assert.equal(status.terminal, false);
    assert.equal(status.analysis, undefined);
    assert.match(status.issues[0].message, /report is missing/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('real discovery applies chronological selection before source resolution and persists decisions', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const { runLiteratureDiscovery } = await import('../src/core/discovery/workflow.js');
  const phases = [];
  try {
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).hostname, 'api.openalex.org');
      return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
    };
    const run = await runLiteratureDiscovery({ rootPath: f.root, runId: 'field-selection-real', topic: 'feedback', providers: ['openalex'],
      maxQueries: 1, maxQueriesPerProvider: 1, providerRequestDelayMs: 0, discoveryRequestCache: false,
      citationExpansion: false, allowDownloads: false, resolveSources: false, persist: true,
      seedPapers: [
        { title: 'Known recent feedback', year: 2024, identifiers: { doi: '10.1234/known' } },
        { title: 'Foundational feedback control', year: 1980, identifiers: { doi: '10.1234/old' } },
        { title: 'Modern feedback control', year: 2025, identifiers: { doi: '10.1234/recent' } }
      ],
      selectCandidates(candidates, context) {
        phases.push(context.phase);
        return selectFieldResearchCandidates(candidates, { papers: f.graph.nodes.filter(n => n.type === 'Paper'),
          request: { maxPapers: 1 }, phase: context.phase });
      }
    });
    assert.deepEqual(phases, ['citation_seeds', 'source_resolution']);
    assert.equal(run.candidates.length, 1);
    assert.equal(run.candidates[0].year, 1980);
    assert.equal(run.candidateSelection.counts.already_indexed, 1);
    assert.equal(run.candidateSelection.counts.budget_omitted, 1);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});
