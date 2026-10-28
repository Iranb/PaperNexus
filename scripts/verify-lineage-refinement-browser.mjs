import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';

const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'pn-lineage-browser'));
await fs.mkdir(output, { recursive: true });
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-lineage-browser-runtime-'));
process.env.PAPERNEXUS_HOME = runtime;
process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
const { refinementFixture } = await import('../test/helpers/lineage-refinement-fixture.js');
const { serveCommand } = await import('../src/server/http.js');
const { registerCorpus } = await import('../src/storage/registry.js');
const { executeFieldStudyOperation } = await import('../src/core/research/field-studies.js');
const { loadCorpus } = await import('../src/storage/corpus-store.js');
const f = await refinementFixture();
await fs.writeFile(f.paths.metaPath, JSON.stringify({ name: 'lineage-demo', rootPath: f.root }));
await registerCorpus({ name: 'lineage-demo', rootPath: f.root });
await executeFieldStudyOperation(f.root, 'save', { studyId: 'lineage-demo', expectedRevision: 0, study: {
  title: 'State update methods', query: 'State update', scope: 'Review the child and its cited predecessor.',
  branches: [{ id: 'updates', label: 'State updates', description: 'Method lineage', reviewStatus: 'pending', reviewSummary: 'Source review pending.', gaps: [] }],
  searches: [], papers: [{ paperId: 'child', role: 'context', branchIds: ['updates'], methodIds: [], reason: 'Selected method paper.', evidenceRefs: [f.source] }],
  coverage: { status: 'in_progress', summary: 'One selected paper.', gaps: [], nextActions: [] }
} });
const idleWorker = () => ({ stop() {}, pollNow() {} });
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let server, browser, page;
const errors = [], requests = [], checks = [];
try {
  server = await serveCommand({ ...f.options, host: '127.0.0.1', port, rootPaths: [f.root], apiToken: 'browser-fixture-token',
    config: { llm: { provider: 'deepseek', model: 'fixture', apiKey: 'fixture' }, serve: { mcp: { enabled: true } } },
    enableEnhancements: false, startImportWorker: idleWorker, startAuthoritativeSyncWorker: idleWorker,
    enableFastMdImportLane: false, enableDoclingWarmup: false, enableMineruWarmup: false,
    enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
  browser = await chromium.launch({ executablePath: process.env.PAPERNEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/lineage-') && request.method() === 'POST') requests.push({ url: request.url(), body: request.postDataJSON() }); });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#username').fill('admin'); await page.locator('#password').fill('hhh123');
  await page.locator('button[type="submit"]').click();
  await page.locator('#statusbar').filter({ hasText: 'lineage-demo' }).waitFor();
  await page.locator('#field-study-status').filter({ hasText: '1 studies' }).waitFor();
  await page.locator('#field-study-select option[value="lineage-demo"]').waitFor({ state: 'attached' });
  await page.locator('#field-study-select').selectOption('lineage-demo'); await page.locator('#field-study-open').click();
  await page.locator('.field-study-summary').filter({ hasText: 'State update methods' }).waitFor();
  await page.locator('.lineage-refinement > summary').click();
  let dropResponse = true;
  await page.route('**/api/lineage-refinement?*', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().dryRun || !dropResponse) return route.continue();
    dropResponse = false; await route.fetch(); return route.abort('failed');
  });
  await page.locator('[data-refine="start"]').click();
  await page.locator('[data-refine="retry"]').waitFor();
  await page.locator('[data-refine="retry"]').click();
  await page.locator('.lineage-refinement-status').filter({ hasText: '可发布 1 条' }).waitFor();
  assert.equal(f.calls.length, 2); assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
  const starts = requests.filter(request => request.url.includes('/api/lineage-refinement') && !request.body.dryRun);
  assert.equal(starts.length, 2); assert.equal(starts[0].body.idempotencyKey, starts[1].body.idempotencyKey);
  checks.push('A lost submission response retries the same saved request without duplicate model calls; publication remains explicit.');
  await page.locator('[data-refine="preview"]').click();
  await page.locator('.lineage-publication-preview').filter({ hasText: '发布预览' }).waitFor();
  assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
  await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
  checks.push('Publication preview displays the supported subset without changing the graph.');
  await page.locator('[data-refine="apply"]').click();
  await page.locator('[data-refine="revoke"]').waitFor();
  assert.equal((await loadCorpus(f.root)).graph.relationships.length, 1);
  await page.locator('.field-scope').filter({ hasText: '1 evidence relations' }).waitFor({ state: 'attached' });
  const publishedStudy = await executeFieldStudyOperation(f.root, 'read', { studyId: 'lineage-demo' });
  assert.equal(publishedStudy.analysis.result.scope.study.publishedContext.edgeIds.length, 1);
  assert.equal(publishedStudy.revision, 1);
  assert.equal(publishedStudy.study.papers.length, 1);
  checks.push('Publishing updates the native saved-study map, including predecessor context, without changing study membership or review status.');
  const submissionCount = requests.filter(request => request.url.includes('/api/lineage-refinement') && !request.body.dryRun).length;
  await page.reload();
  await page.locator('.lineage-refinement > summary').click();
  await page.locator('.lineage-refinement-status').filter({ hasText: '可发布 1 条' }).waitFor();
  assert.equal(f.calls.length, 2);
  assert.equal(requests.filter(request => request.url.includes('/api/lineage-refinement') && !request.body.dryRun).length, submissionCount);
  await page.locator('.lineage-refinement-status details').first().locator('summary').click();
  await page.locator('.lineage-refinement-status').filter({ hasText: '未知：当前没有足够原文证据' }).waitFor();
  await page.screenshot({ path: path.join(output, 'reviewed.png'), fullPage: true });
  checks.push('Reload reads the existing run; unknown explanations remain unknown and model calls are not repeated.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('[data-refine="preview"]').isVisible());
  await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
  await page.locator('[data-refine="revoke"]').click();
  await page.locator('.lineage-publication-preview').filter({ hasText: '撤回预览' }).waitFor();
  await page.locator('[data-refine="apply"]').click();
  await page.locator('.field-scope').filter({ hasText: '0 evidence relations' }).waitFor({ state: 'attached' });
  assert.equal((await loadCorpus(f.root)).graph.relationships.length, 0);
  checks.push('Revocation removes the owned relation and refreshes the native map.');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'browser-checks.json'), JSON.stringify({ checks, errors, modelCalls: f.calls.length }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser?.close(); await server?.stop(); await fs.rm(f.root, { recursive: true, force: true }); await fs.rm(runtime, { recursive: true, force: true });
}
