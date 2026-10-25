// Verify the research UI with offline discovery fixtures and real HTTP/import storage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { createFieldEvolutionFixture } from '../test/fixtures/field-evolution-fixture.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';

const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'papernexus-field-research-acceptance'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-field-research-browser-'));
process.env.PAPERNEXUS_HOME = path.join(temporary, 'runtime');
const { getCorpusPaths } = await import('../src/storage/corpus-store.js');
const { serveCommand } = await import('../src/server/http.js');
const { registerCorpus } = await import('../src/storage/registry.js');
const { saveDiscoveryRun } = await import('../src/core/discovery/store.js');
const { listImportTasks, completeImportTask } = await import('../src/storage/import-store.js');
const roots = [];
const graph = createFieldEvolutionFixture();
for (const [name, data] of [['research-demo', graph], ['empty-demo', createKnowledgeGraph()]]) {
  const root = path.join(temporary, name);
  roots.push(root);
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name, rootPath: root, indexedAt: new Date().toISOString(),
    paperCount: data.nodes.filter(n => n.type === 'Paper').length, nodeCount: data.nodeCount, relationshipCount: data.relationshipCount }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(data.toJSON()));
  await registerCorpus({ name, rootPath: root });
}
const source = path.join(roots[0], 'new-method.md');
await fs.writeFile(source, '# Adaptive feedback operator\n\n## Abstract\n\nA fictional fixture for feedback research.\n');
let releaseDiscovery;
const discoveryGate = new Promise(resolve => { releaseDiscovery = resolve; });
let discoveries = 0;
const idleWorker = () => ({ stop() {}, pollNow() {} });
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await serveCommand({ host: '127.0.0.1', port, rootPaths: roots, apiToken: 'field-research-browser-token',
  config: { serve: { mcp: { enabled: true } } }, enableEnhancements: false,
  startImportWorker: idleWorker, startAuthoritativeSyncWorker: idleWorker,
  enableFastMdImportLane: false, enableDoclingWarmup: false, enableMineruWarmup: false,
  enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false,
  fieldResearchDependencies: { async discover(args, options) {
    discoveries++;
    await options.onLiteratureDiscoveryProgress({ stage: 'provider_search', rawCandidateCount: 2 });
    await discoveryGate;
    const candidates = [
      { id: 'new', title: 'Adaptive feedback operator', year: 2026, identifiers: { doi: '10.1234/browser-new' }, providers: ['offline-fixture'], source: { resolutionStatus: 'fulltext_ready', sourcePath: source } },
      { id: 'unavailable', title: 'Historical feedback archive', year: 1980, identifiers: { doi: '10.1234/unavailable' }, providers: ['offline-fixture'], source: { resolutionStatus: 'metadata_only' } }
    ];
    const selection = options.selectDiscoveryCandidates(candidates, { phase: 'source_resolution' });
    const run = { runId: args.runId, topic: args.query, candidates: selection.candidates, candidateSelection: selection.selection,
      coverage: {}, queryResults: [], plan: { queries: ['feedback calibration'] } };
    await saveDiscoveryRun(roots[0], run);
    return run;
  } }
});
let browser;
const checks = [];
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.PAPERNEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#username').fill('admin'); await page.locator('#password').fill('hhh123');
  await page.locator('button[type="submit"]').click();
  await page.locator('#corpus-select').selectOption('research-demo');
  await page.locator('#statusbar').filter({ hasText: 'research-demo' }).waitFor();
  await page.locator('#topic-query').fill('feedback calibration');
  await page.locator('#topic-domain').fill('Education');
  await page.locator('#field-max-papers').fill('2');
  const submitted = [];
  let dropResponse = true;
  await page.route('**/api/field-research?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted.push(route.request().postDataJSON());
    if (dropResponse) { dropResponse = false; await route.fetch(); return route.abort('failed'); }
    return route.continue();
  });
  await page.locator('#field-research').click();
  await page.locator('[data-research-retry="submit"]').waitFor();
  await page.locator('[data-research-retry="submit"]').click();
  await page.locator('.field-research-heading strong').filter({ hasText: 'Searching literature' }).waitFor();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].idempotencyKey, submitted[1].idempotencyKey);
  assert.equal(discoveries, 1);
  checks.push('A lost submission response retries the same request key without duplicate discovery.');
  releaseDiscovery();
  await page.locator('.field-research-heading strong').filter({ hasText: 'Importing papers' }).waitFor();
  assert.equal(await page.locator('[data-field-node]').count(), 0);
  const { tasks } = await listImportTasks(roots[0]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].processingProfile, 'full');
  checks.push('Resolved full text creates one real full-profile import task; the map waits for evidence.');
  await page.reload();
  await page.locator('.field-research-heading strong').filter({ hasText: 'Importing papers' }).waitFor();
  assert.equal(submitted.length, 2);
  assert.equal(discoveries, 1);
  checks.push('Reload resumes the saved run through read-only status calls.');
  await page.screenshot({ path: path.join(output, 'progress.png'), fullPage: true });
  graph.addNode({ id: 'new-browser-paper', type: 'Paper', name: 'Adaptive feedback operator',
    properties: { year: 2026, fieldOfStudy: 'Engineering', doi: '10.1234/browser-new' } });
  await fs.writeFile(getCorpusPaths(roots[0]).liteGraphPath, JSON.stringify(graph.toJSON()));
  await completeImportTask(roots[0], tasks[0].id, { authoritativeSync: { status: 'completed' } });
  await page.locator('[data-field-node="new-browser-paper"]').waitFor();
  await page.locator('.field-research-heading strong').filter({ hasText: 'coverage gaps' }).waitFor();
  assert.match(await page.locator('.field-research-summary').textContent(), /Full text unavailable/);
  checks.push('Fresh admitted papers join the map even with a different domain; unavailable full text is an explicit coverage gap.');
  await page.screenshot({ path: path.join(output, 'research-map.png'), fullPage: true });
  const download = page.waitForEvent('download');
  await page.locator('[data-field-action="json"]').click();
  const resultPath = path.join(output, 'research-map.json');
  await (await download).saveAs(resultPath);
  const exported = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(exported.research.status, 'partial');
  assert.equal(exported.research.survey.sources.length, 2);
  assert.equal(exported.result.scope.research.runId, 'field-' + submitted[0].idempotencyKey);
  checks.push('JSON export includes the map, run identity, import readiness, sources and gaps.');
  await page.locator('[data-field-action="close"]').click();
  await page.reload();
  await page.locator('#statusbar').filter({ hasText: 'research-demo' }).waitFor();
  assert.equal(await page.locator('#field-evolution-panel').isVisible(), false);
  await page.locator('#field-research-resume').click();
  await page.locator('[data-field-node="new-browser-paper"]').waitFor();
  assert.equal(submitted.length, 2);
  checks.push('Closing persists across reload; explicit resume reads the completed result without starting another run.');
  await page.locator('#corpus-select').selectOption('empty-demo');
  await page.locator('#statusbar').filter({ hasText: 'empty-demo' }).waitFor();
  assert.equal(await page.locator('#field-evolution-panel').isVisible(), false);
  assert.equal(await page.locator('[data-field-node]').count(), 0);
  checks.push('Changing corpus clears the previous research view.');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify({ passed: checks.length, checks, browserErrors: errors,
    evidenceBoundary: 'Offline discovery fixture; real HTTP, import submission and status storage. Import completion and graph publication are supplied fixtures, not live extraction.' }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally { releaseDiscovery(); await browser?.close(); await server.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
