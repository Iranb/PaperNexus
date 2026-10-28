import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { executeLineageRefinementOperation, recoverLineageRefinements, launchLineageRefinement, lineageRefinementPaths } from '../src/core/research/lineage-refinement.js';
import { refinementFixture, finishRefinement } from './helpers/lineage-refinement-fixture.js';

for (const domain of ['learning', 'optimization']) test(`refinement reviews ${domain} through the same source-grounded flow without writing the graph`, async () => {
  const f = await refinementFixture(domain);
  try {
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: domain };
    const before = await fs.readFile(f.paths.liteGraphPath, 'utf8');
    const dry = await executeLineageRefinementOperation(f.root, 'start', { ...args, dryRun: true }, f.options);
    assert.equal(dry.graphWriteback, false); assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(lineageRefinementPaths(f.root).directory), { code: 'ENOENT' });
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    const result = await finishRefinement(f.root, 'refine-' + domain);
    assert.equal(result.status, 'completed'); assert.equal(result.counts.publishable, 1);
    assert.equal(result.entries[0].review.relations[0].bottleneck, null);
    assert.equal(result.gaps[0].kind, 'explanation_incomplete');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1].prompt.includes(f.parentQuote));
    assert.equal(await fs.readFile(f.paths.liteGraphPath, 'utf8'), before);
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    await executeLineageRefinementOperation(f.root, 'status', { runId: result.runId }, f.options);
    assert.equal(f.calls.length, 2);
    await executeLineageRefinementOperation(f.root, 'start', { ...args, idempotencyKey: 'reuse' }, f.options);
    const reused = await finishRefinement(f.root, 'refine-reuse');
    assert.equal(reused.entries[0].review.cacheHit, true); assert.equal(f.calls.length, 2);
    await fs.appendFile(f.parentSource, '\nMore parent evidence.');
    await executeLineageRefinementOperation(f.root, 'start', { ...args, idempotencyKey: 'changed' }, f.options);
    await finishRefinement(f.root, 'refine-changed');
    assert.equal(f.calls.length, 3); assert.equal(f.calls[2].stage, 'review');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

for (const [label, change, blocker] of [
  ['comparison', f => { f.review.relations[0].context = 'comparison'; }, 'relation_context_mismatch'],
  ['negative ablation', f => { f.review.relations[0].context = 'negative_ablation'; }, 'relation_context_mismatch'],
  ['refuted hypothesis', f => { f.review.relations[0].epistemicStatus = 'refuted'; }, 'relation_not_established'],
  ['wrong owner', f => { f.review.relations[0].attribution = 'another method'; }, 'relation_attribution_mismatch'],
  ['unmatched quote', f => { f.review.relations[0].exactQuote = 'Absent quote'; }, 'relation_quote_unmatched'],
  ['wrong parent method', f => { f.card.lineageCandidates[0].parentMethod = 'Another parent'; }, 'parent_method_unverified'],
  ['unresolved parent', f => { f.card.lineageCandidates[0].parentPaperTitle = 'Missing parent'; }, 'parent_identity_unresolved']
]) test(`${label} cannot become publishable despite a supported model decision`, async () => {
  const f = await refinementFixture(); change(f);
  try {
    await executeLineageRefinementOperation(f.root, 'start', { papers: [{ paperId: 'child' }], idempotencyKey: 'blocked' }, f.options);
    const state = await finishRefinement(f.root, 'refine-blocked');
    assert.equal(state.counts.publishable, 0);
    assert.ok(state.entries[0].review.relations[0].blockers.includes(blocker));
    assert.equal(state.entries[0].review.relations[0].modelDecision, 'supported');
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('interrupted runs resume from cached extraction; failed review retries require explicit intent', async () => {
  const f = await refinementFixture(); const original = f.options.lineageRefinementDependencies.generate;
  try {
    f.options.lineageRefinementDependencies.generate = async () => { throw new Error('review provider offline'); };
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'retry' };
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    const partial = await finishRefinement(f.root, 'refine-retry');
    assert.equal(partial.status, 'partial'); assert.equal(f.calls.length, 1);
    f.options.lineageRefinementDependencies.generate = original;
    await recoverLineageRefinements(f.root, f.options);
    assert.equal(f.calls.length, 1);
    await executeLineageRefinementOperation(f.root, 'start', { ...args, retryFailed: true }, f.options);
    const completed = await finishRefinement(f.root, 'refine-retry');
    assert.equal(completed.status, 'completed'); assert.equal(f.calls.length, 2);
    const file = lineageRefinementPaths(f.root, 'refine-retry').record;
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.status = 'running'; record.stage = 'review'; record.entries[0].status = 'pending'; record.entries[0].review = null;
    await fs.writeFile(file, JSON.stringify(record));
    await recoverLineageRefinements(f.root, f.options);
    const recovered = await finishRefinement(f.root, 'refine-retry');
    assert.equal(recovered.status, 'completed'); assert.equal(f.calls.length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('supplementation obeys cumulative budgets and waits for authoritative import synchronization', async () => {
  const f = await refinementFixture(); let discoverCalls = 0, submitCalls = 0, reads = 0, synced = false;
  try {
    // Begin with only the child; the cited predecessor must enter through the import bridge.
    await fs.writeFile(f.paths.manifestPath, JSON.stringify({ sources: [f.sources[0]] }));
    const childGraph = { nodes: [f.graph.nodes[0]], relationships: [] };
    for (const file of [f.paths.graphPath, f.paths.liteGraphPath]) await fs.writeFile(file, JSON.stringify(childGraph));
    const original = f.options.lineageRefinementDependencies.generate;
    f.options.lineageRefinementDependencies.generate = async prompt => prompt.startsWith('Plan')
      ? f.response({ queries: [{ query: f.names[1], gapIndex: 0, reason: 'Resolve the cited predecessor.' }] }) : original(prompt);
    f.options.lineageRefinementDependencies.discover = async args => {
      discoverCalls++; assert.equal(args.maxQueries, 1); assert.equal(args.maxDownloads, 1);
      return { candidates: [{ id: 'found-parent', title: f.names[1], source: { sourcePath: f.parentSource, resolutionStatus: 'fulltext_ready' } }] };
    };
    f.options.lineageRefinementDependencies.submitImports = async params => {
      submitCalls++; assert.equal(params.maxImported, 1); assert.equal(params.processingProfile, 'fast-md-structural');
      return { results: [{ taskId: 'import-parent', title: f.names[1], sourcePath: f.parentSource, status: 'submitted' }] };
    };
    f.options.lineageRefinementDependencies.readImports = async () => {
      reads++;
      return { tasks: [{ id: 'import-parent', status: 'completed', graphVisibilityStatus: 'completed', semanticStatus: 'not-required',
        authoritativeSyncStatus: synced ? 'completed' : 'running', files: [{ storedPath: f.parentSource }] }] };
    };
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'supplement', maxQueries: 1, maxNewPapers: 1, maxRounds: 3 };
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    await launchLineageRefinement(f.root, 'refine-supplement', f.options);
    const waiting = await finishRefinement(f.root, 'refine-supplement');
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.counts.publishable, 0); assert.equal(waiting.entries.length, 1);
    const beforeReads = reads;
    await executeLineageRefinementOperation(f.root, 'status', { runId: waiting.runId });
    assert.equal(reads, beforeReads); assert.equal(submitCalls, 1); assert.equal(discoverCalls, 1);
    f.graph.nodes[1].properties.sourcePath = f.parentSource;
    for (const file of [f.paths.graphPath, f.paths.liteGraphPath]) await fs.writeFile(file, JSON.stringify(f.graph));
    await fs.writeFile(f.paths.manifestPath, JSON.stringify({ sources: f.sources }));
    synced = true;
    // Imported parent is an independent method with no predecessor in this fixture.
    const extraction = f.options.lineageEvidenceDependencies.generate;
    f.options.lineageEvidenceDependencies.generate = async prompt => prompt.includes('"paperId":"parent"')
      ? f.response({ ...f.card, methods: [], lineageCandidates: [] }) : extraction(prompt);
    const review = f.options.lineageRefinementDependencies.generate;
    f.options.lineageRefinementDependencies.generate = async prompt => prompt.startsWith('Review') && prompt.includes('CANDIDATE_CARD: {"paperRole":"method","setting":"learning","contribution":"State update","limitations":[],"missingEvidence":[],"methods":[]')
      ? f.response({ methods: [], relations: [] }) : review(prompt);
    await recoverLineageRefinements(f.root, f.options);
    await launchLineageRefinement(f.root, waiting.runId, f.options);
    const result = await finishRefinement(f.root, waiting.runId);
    assert.equal(result.status, 'completed'); assert.equal(result.counts.publishable, 1);
    assert.equal(result.entries.length, 2); assert.equal(result.budget.queries, 1); assert.equal(result.budget.newPapers, 1);
    assert.equal(discoverCalls, 1); assert.equal(submitCalls, 1);
    assert.equal(f.calls.filter(call => call.stage === 'extract').length, 1);
    assert.equal(f.calls.filter(call => call.stage === 'review').length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('same-paper variants resolve locally and ambiguous external titles stay blocked', async () => {
  const f = await refinementFixture();
  try {
    await fs.appendFile(f.source, '\n' + f.parentQuote);
    f.card.methods.push({ name: f.names[1], role: 'variant', description: 'Within-paper reference variant.', exactQuote: f.parentQuote });
    f.card.lineageCandidates[0].parentPaperTitle = f.names[0]; f.card.lineageCandidates[0].relationType = 'VARIANT_OF';
    f.review.methods.push({ methodIndex: 1, decision: 'supported', reason: 'Named within-paper variant.', exactQuote: f.parentQuote, attribution: f.names[1], epistemicStatus: 'asserted' });
    f.review.relations[0].context = 'variant';
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'variant' };
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    const variant = await finishRefinement(f.root, 'refine-variant');
    assert.equal(variant.counts.publishable, 1);
    assert.equal(variant.entries[0].review.relations[0].parentIdentity.paperId, 'child');
    f.card.lineageCandidates[0].parentPaperTitle = f.names[1];
    f.graph.nodes.push({ ...f.graph.nodes[1], id: 'duplicate-parent' });
    for (const file of [f.paths.graphPath, f.paths.liteGraphPath]) await fs.writeFile(file, JSON.stringify(f.graph));
    await fs.appendFile(f.source, '\nDifferent candidate input.');
    await executeLineageRefinementOperation(f.root, 'start', { ...args, idempotencyKey: 'ambiguous' }, f.options);
    const ambiguous = await finishRefinement(f.root, 'refine-ambiguous');
    assert.equal(ambiguous.counts.publishable, 0);
    assert.ok(ambiguous.entries[0].review.relations[0].blockers.includes('parent_identity_ambiguous'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('rejected candidates stay rejected and duplicated explanations remain unknown', async () => {
  const f = await refinementFixture();
  try {
    const explanation = { text: 'Update the state', exactQuote: f.quote, attribution: f.names[0], epistemicStatus: 'asserted' };
    f.review.relations[0].bottleneck = { ...explanation, kind: 'bottleneck' };
    f.review.relations[0].mechanismEvidence = { ...explanation, kind: 'mechanism' };
    f.review.relations[0].decision = 'rejected'; f.review.relations[0].reason = 'The passage is a comparison.';
    await executeLineageRefinementOperation(f.root, 'start', { papers: [{ paperId: 'child' }], idempotencyKey: 'rejected' }, f.options);
    const state = await finishRefinement(f.root, 'refine-rejected');
    assert.equal(state.counts.rejected, 1); assert.equal(state.counts.publishable, 0);
    assert.equal(state.entries[0].review.relations[0].bottleneck, null);
    assert.ok(state.entries[0].review.relations[0].explanationIssues.includes('bottleneck_repeats_mechanism'));
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('explicit failed import retry preserves the cumulative budget and completed reviews', async () => {
  const f = await refinementFixture(); let submissions = 0;
  try {
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'import-retry', maxQueries: 1, maxNewPapers: 1 };
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    await launchLineageRefinement(f.root, 'refine-import-retry', f.options);
    const file = lineageRefinementPaths(f.root, 'refine-import-retry').record;
    const record = JSON.parse(await fs.readFile(file));
    const selected = { id: 'candidate', title: f.names[1], source: { sourcePath: f.parentSource, resolutionStatus: 'fulltext_ready' } };
    record.status = 'partial'; record.stage = 'done'; record.round = 1; record.budget = { queries: 1, newPapers: 1 };
    record.queries = [{ query: f.names[1], discoveryRunId: 'saved-query', status: 'failed', started: true,
      discovery: { candidates: [selected] }, selected: [selected], importResults: [{ status: 'failed', error: 'Submission failed.' }] }];
    await fs.writeFile(file, JSON.stringify(record));
    f.options.lineageRefinementDependencies.submitImports = async () => { submissions++; return { results: [{ taskId: 'retry-task', status: 'submitted', sourcePath: f.parentSource }] }; };
    f.options.lineageRefinementDependencies.readImports = async () => ({ tasks: [{ id: 'retry-task', status: 'failed', error: { message: 'Parser failed.' } }] });
    await recoverLineageRefinements(f.root, f.options);
    assert.equal(submissions, 0);
    await executeLineageRefinementOperation(f.root, 'start', { ...args, retryFailed: true }, f.options);
    await launchLineageRefinement(f.root, 'refine-import-retry', f.options);
    const result = await finishRefinement(f.root, 'refine-import-retry');
    assert.equal(submissions, 1); assert.deepEqual(result.budget, { queries: 1, newPapers: 1 });
    assert.equal(result.status, 'partial'); assert.equal(result.entries[0].status, 'reviewed');
    assert.equal(result.queries[0].importResults[0].priorAttempts.length, 1);
    assert.equal(f.calls.filter(call => call.stage !== 'plan').length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('recovery reuses valid saved responses before cache writes and failed-only retry leaves completed runs unchanged', async () => {
  const f = await refinementFixture();
  try {
    const args = { papers: [{ paperId: 'child' }], idempotencyKey: 'response-recovery', maxQueries: 1, maxNewPapers: 1 };
    await executeLineageRefinementOperation(f.root, 'start', args, f.options);
    await launchLineageRefinement(f.root, 'refine-response-recovery', f.options);
    const paths = lineageRefinementPaths(f.root, 'refine-response-recovery');
    const record = JSON.parse(await fs.readFile(paths.record));
    const calls = f.calls.length;
    await fs.rm(f.paths.corpusDir + '/lineage-evidence/cards', { recursive: true });
    await fs.rm(paths.directory + '/reviews', { recursive: true });
    await fs.unlink(paths.run + '/queries-0.json');
    record.entries[0].review = null; record.entries[0].status = 'pending'; record.status = 'running'; record.stage = 'review';
    await fs.writeFile(paths.record, JSON.stringify(record));
    await recoverLineageRefinements(f.root, f.options);
    await launchLineageRefinement(f.root, record.runId, f.options);
    const recovered = await finishRefinement(f.root, record.runId);
    assert.equal(recovered.status, 'completed'); assert.equal(f.calls.length, calls);
    await fs.appendFile(f.source, '\nSource update after this completed request.');
    await executeLineageRefinementOperation(f.root, 'start', { ...args, retryFailed: true }, f.options);
    await launchLineageRefinement(f.root, record.runId, f.options);
    assert.equal(f.calls.length, calls);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
