import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { executeLineageEvidenceOperation, lineageEvidencePaths, recoverLineageExtractions } from '../src/core/research/lineage-evidence.js';
import { executeResearchWorkflow, resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';

const quote = 'We extend the Parent method with a calibrated update.';
const card = () => ({ paperRole: 'method', setting: 'Class-incremental learning.', contribution: 'A calibrated update.',
  limitations: ['Requires labels.'], missingEvidence: [],
  methods: [{ name: 'Child', role: 'method', description: 'Calibrated update.', exactQuote: quote, section: 'Method', pdfPage: 10 }],
  lineageCandidates: [{ childMethod: 'Child', parentMethod: 'Parent', parentPaperTitle: 'Parent method',
    parentIdentifier: '10.1234/parent', referenceId: '7', relationType: 'EXTENDS_METHOD', mechanism: 'Calibrates the update.',
    exactQuote: quote, section: 'Method', pdfPage: 10 }] });

async function fixture(count = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-lineage-cards-'));
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const nodes = [], sources = [];
  for (let i = 1; i <= count; i++) {
    const source = path.join(root, `paper${i}.md`);
    await fs.writeFile(source, `# Calibrated incremental learning ${i}\n\n` + 'Full paper body. '.repeat(1200) + '\n## PDF page 10\n' + quote);
    nodes.push({ id: `p${i}`, type: 'Paper', name: `Calibrated incremental learning ${i}`, properties: {} });
    sources.push({ paperId: `p${i}`, sourceKey: source, markdownCachePath: source, activeInGraph: true });
  }
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'lineage-test', rootPath: root }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify({ nodes, relationships: [] }));
  await fs.writeFile(paths.manifestPath, JSON.stringify({ sources }));
  return { root, paths, sources, options: { llmProvider: 'deepseek', llmModel: 'fixture-model', llmApiKey: 'fixture-key', llmRateLimitRetryCount: 0 } };
}

async function complete(root, runId) {
  for (let i = 0; i < 150; i++) {
    const result = await executeLineageEvidenceOperation(root, 'status', { runId });
    if (result.terminal) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture extraction did not finish.');
}

function providerResponse(value = card(), usage = { prompt_tokens: 6000, completion_tokens: 500, total_tokens: 6500, prompt_cache_hit_tokens: 1000 }, finishReason = 'stop') {
  return { ok: true, json: async () => ({ id: 'response', model: 'fixture-model', usage,
    choices: [{ finish_reason: finishReason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) };
}

test('lineage cards reuse unchanged papers, process only additions, and invalidate changed source text', async () => {
  const f = await fixture(); const originalFetch = globalThis.fetch; const prompts = [];
  globalThis.fetch = async (_url, init) => { prompts.push(JSON.parse(init.body).messages[0].content); return providerResponse(); };
  try {
    const request = { papers: [{ paperId: 'p1' }, { paperId: 'p2' }], idempotencyKey: 'first' };
    const preview = await executeLineageEvidenceOperation(f.root, 'extract', { ...request, dryRun: true }, f.options);
    assert.equal(preview.counts.needsExtraction, 2);
    await assert.rejects(fs.stat(lineageEvidencePaths(f.root).directory), { code: 'ENOENT' });
    const submitted = await executeLineageEvidenceOperation(f.root, 'extract', request, f.options);
    const first = await complete(f.root, submitted.runId);
    assert.equal(first.counts.extracted, 2); assert.equal(prompts.length, 2);
    assert.ok(prompts.every(prompt => prompt.includes('PDF page 10\n' + quote)));
    assert.equal(first.usage.requests, 2); assert.equal(first.usage.totalTokens, 13000);
    const evidence = await executeLineageEvidenceOperation(f.root, 'card', { cardId: first.entries[0].cardId });
    assert.equal(evidence.evidence.reviewStatus, 'pending'); assert.equal(evidence.evidence.graphWriteback, false);
    assert.equal(evidence.evidence.lineageCandidates[0].quoteFound, true); assert.equal(evidence.freshness, 'current');
    await executeLineageEvidenceOperation(f.root, 'extract', { ...request, idempotencyKey: 'repeat' }, f.options);
    const repeat = await complete(f.root, 'lineage-repeat');
    assert.equal(repeat.counts.cached, 2); assert.equal(repeat.usage.requests, 0); assert.equal(prompts.length, 2);
    await executeLineageEvidenceOperation(f.root, 'extract', { papers: [...request.papers, { paperId: 'p3' }], idempotencyKey: 'added' }, f.options);
    const added = await complete(f.root, 'lineage-added');
    assert.equal(added.counts.extracted, 1); assert.equal(added.counts.cached, 2); assert.equal(prompts.length, 3);
    await fs.appendFile(f.sources[0].sourceKey, '\nNew source revision.');
    assert.equal((await executeLineageEvidenceOperation(f.root, 'card', { cardId: first.entries[0].cardId })).usableForReview, false);
    await executeLineageEvidenceOperation(f.root, 'extract', { ...request, idempotencyKey: 'changed' }, f.options);
    const changed = await complete(f.root, 'lineage-changed');
    assert.equal(changed.counts.extracted, 1); assert.equal(changed.counts.cached, 1); assert.equal(prompts.length, 4);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('explicit failed-only retry preserves completed cards and charges failed responses to usage', async () => {
  const f = await fixture(2); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => providerResponse(++calls === 2 ? '{"incomplete":' : card());
  try {
    const request = { papers: [{ paperId: 'p1' }, { paperId: 'p2' }], idempotencyKey: 'retry' };
    await executeLineageEvidenceOperation(f.root, 'extract', request, f.options);
    const first = await complete(f.root, 'lineage-retry');
    assert.equal(first.status, 'partial'); assert.equal(first.counts.failed, 1); assert.equal(first.usage.requests, 2);
    await executeLineageEvidenceOperation(f.root, 'extract', request, f.options);
    await complete(f.root, 'lineage-retry'); assert.equal(calls, 2);
    await executeLineageEvidenceOperation(f.root, 'extract', { ...request, retryFailed: true }, f.options);
    const retried = await complete(f.root, 'lineage-retry');
    assert.equal(calls, 3); assert.equal(retried.status, 'completed');
    assert.equal(retried.entries[0].cardId, first.entries[0].cardId); assert.equal(retried.usage.requests, 3);
    await assert.rejects(executeLineageEvidenceOperation(f.root, 'extract', { ...request, papers: [{ paperId: 'p2' }] }, f.options), /different papers/);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('unmatched quotes remain pending and truncated responses are never cached', async () => {
  const f = await fixture(2); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => {
    const value = card(); value.lineageCandidates[0].exactQuote = 'This quote is absent.';
    return providerResponse(value, undefined, ++calls === 2 ? 'length' : 'stop');
  };
  try {
    await executeLineageEvidenceOperation(f.root, 'extract', { papers: [{ paperId: 'p1' }, { paperId: 'p2' }], idempotencyKey: 'quotes' }, f.options);
    const status = await complete(f.root, 'lineage-quotes');
    assert.equal(status.counts.quoteFailures, 1); assert.equal(status.counts.failed, 1);
    assert.match(status.entries[1].error, /truncated/); assert.equal(status.entries[1].cardId, undefined);
    const read = await executeLineageEvidenceOperation(f.root, 'card', { cardId: status.entries[0].cardId });
    assert.equal(read.evidence.lineageCandidates[0].quoteFound, false);
    assert.equal(read.evidence.lineageCandidates[0].reviewStatus, 'pending');
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('ambiguous and inactive sources cannot silently become evidence', async () => {
  const f = await fixture(1); let calls = 0;
  const options = { ...f.options, lineageEvidenceDependencies: { generate: async () => { calls++; throw new Error('Unexpected model call'); } } };
  try {
    const second = { ...f.sources[0], sourceKey: path.join(f.root, 'other.md') };
    await fs.writeFile(f.paths.manifestPath, JSON.stringify({ sources: [...f.sources, second] }));
    const args = { papers: [{ paperId: 'p1' }], idempotencyKey: 'ambiguous', dryRun: true };
    assert.equal((await executeLineageEvidenceOperation(f.root, 'extract', args, options)).counts.unavailable, 1);
    await fs.writeFile(f.paths.manifestPath, JSON.stringify({ sources: [{ ...f.sources[0], activeInGraph: false }] }));
    assert.equal((await executeLineageEvidenceOperation(f.root, 'extract', args, options)).counts.unavailable, 1);
    assert.equal(calls, 0);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('different runs requesting the same source share the card lock and one provider call', async () => {
  const f = await fixture(1); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return providerResponse(); };
  try {
    const requests = ['one', 'two'].map(idempotencyKey => ({ papers: [{ paperId: 'p1' }], idempotencyKey }));
    await Promise.all(requests.map(args => executeLineageEvidenceOperation(f.root, 'extract', args, f.options)));
    const statuses = await Promise.all(requests.map(args => complete(f.root, 'lineage-' + args.idempotencyKey)));
    assert.equal(calls, 1); assert.equal(statuses.reduce((sum, status) => sum + status.counts.cached, 0), 1);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('provider balance errors stop remaining submissions and preserve unknown usage', async () => {
  const f = await fixture(3); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 402, text: async () => 'Insufficient balance' }; };
  try {
    await executeLineageEvidenceOperation(f.root, 'extract', { papers: f.sources.map(source => ({ paperId: source.paperId })), idempotencyKey: 'balance' }, f.options);
    const result = await complete(f.root, 'lineage-balance');
    assert.equal(calls, 1); assert.equal(result.counts.pending, 2); assert.equal(result.usage.unreportedRequests, 1);
    assert.equal(result.usage.complete, false);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('recovery resumes durable pending entries without reprocessing completed cards', async () => {
  const f = await fixture(1); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return providerResponse(); };
  try {
    await executeLineageEvidenceOperation(f.root, 'extract', { papers: [{ paperId: 'p1' }], idempotencyKey: 'recovery' }, f.options);
    const done = await complete(f.root, 'lineage-recovery');
    const paths = lineageEvidencePaths(f.root, done.runId);
    const record = JSON.parse(await fs.readFile(paths.record, 'utf8'));
    record.status = 'running'; record.entries[0] = { selection: record.entries[0].selection, status: 'pending' };
    await fs.writeFile(paths.record, JSON.stringify(record));
    await recoverLineageExtractions(f.root, f.options);
    const resumed = await complete(f.root, done.runId);
    assert.equal(resumed.counts.cached, 1); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});

test('MCP uses compact extraction receipts, exact full card reads and structural import profiles', async () => {
  const f = await fixture(1); const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => providerResponse();
  try {
    const args = { operation: 'lineage_extract', corpus: f.root, papers: [{ paperId: 'p1' }], idempotencyKey: 'mcp' };
    const receipt = await executeResearchWorkflow('literature_review', args, f.options);
    assert.equal(receipt.presentation.mode, 'summary');
    assert.equal(receipt.presentation.read_more.arguments.operation, 'lineage_status');
    const status = await complete(f.root, 'lineage-mcp');
    const exact = await executeResearchWorkflow('literature_review', { operation: 'lineage_card', corpus: f.root, cardId: status.entries[0].cardId }, f.options);
    assert.equal(exact.presentation, undefined); assert.equal(exact.result.evidence.methods[0].exactQuote, quote);
    const translated = resolveResearchWorkflowCall('literature_review', { operation: 'import', corpus: f.root,
      serverFilePath: f.sources[0].sourceKey, processingProfile: 'fast-md-structural', completionPolicy: 'graph-visible' });
    assert.equal(translated.args.processingProfile, 'fast-md-structural');
    assert.equal(translated.args.completionPolicy, 'graph-visible');
    assert.throws(() => resolveResearchWorkflowCall('literature_review', { operation: 'import', serverFilePath: '/tmp/paper.pdf', processingProfile: 'fast-md-structural' }), /materialized Markdown/);
  } finally { globalThis.fetch = originalFetch; await fs.rm(f.root, { recursive: true, force: true }); }
});
