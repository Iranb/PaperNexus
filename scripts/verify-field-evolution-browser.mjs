// Exercise the evolution map against isolated fictional corpora in a real Chromium browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { createFieldEvolutionFixture } from '../test/fixtures/field-evolution-fixture.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';

const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'papernexus-field-acceptance'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-field-browser-'));
process.env.PAPERNEXUS_HOME = path.join(temporary, 'runtime');
const { getCorpusPaths } = await import('../src/storage/corpus-store.js');
const { serveCommand } = await import('../src/server/http.js');
const { registerCorpus } = await import('../src/storage/registry.js');
const roots = [];
for (const [name, graph] of [['evolution-demo', createFieldEvolutionFixture()], ['empty-demo', createKnowledgeGraph()]]) {
  const root = path.join(temporary, name);
  roots.push(root);
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  await fs.writeFile(paths.metaPath, JSON.stringify({ name, rootPath: root, indexedAt: new Date().toISOString(),
    paperCount: graph.nodes.filter(n => n.type === 'Paper').length, nodeCount: graph.nodeCount, relationshipCount: graph.relationshipCount }));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  await registerCorpus({ name, rootPath: root, paperCount: graph.nodes.filter(n => n.type === 'Paper').length });
}
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await serveCommand({ host: '127.0.0.1', port, rootPaths: roots, apiToken: 'local-field-demo-token',
  config: { serve: { mcp: { enabled: true } } }, enableEnhancements: false, enableImports: false,
  enableAuthoritativeSync: false, enableLiteratureDiscoveryRecovery: false,
  enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
const url = `http://127.0.0.1:${port}`;
await fs.writeFile(path.join(output, 'demo.json'), JSON.stringify({ url, roots, fictional: true }, null, 2));

if (process.argv.includes('--serve')) {
  console.log(`Fictional evolution demo: ${url}`);
  process.once('SIGINT', async () => { await server.stop(); await fs.rm(temporary, { recursive: true, force: true }); process.exit(0); });
} else {
  let browser;
  let page;
  const checks = [];
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.PAPERNEXUS_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#username').fill('admin');
    await page.locator('#password').fill('hhh123');
    await page.locator('button[type="submit"]').click();
    await page.locator('#corpus-select').selectOption('evolution-demo');
    await page.locator('#statusbar').filter({ hasText: 'evolution-demo' }).waitFor();
    await page.locator('#topic-query').fill('feedback calibration');
    await page.locator('#topic-domain').fill('Education');
    await page.locator('#field-build').click();
    await page.locator('[data-field-node="p-m0"]').waitFor();
    assert.ok(await page.locator('[data-field-node]').count() > 8);
    assert.ok((await page.locator('.field-scope').textContent()).includes('17 methods'));
    checks.push('Topic/domain selection displays more than eight methods and their papers.');
    await page.locator('[data-field-action="fit"]').click();
    await page.screenshot({ path: path.join(output, 'papers.png'), fullPage: true });
    await page.locator('[data-field-mode="methods"]').click();
    await page.locator('[data-field-node="m2"]').click();
    assert.ok((await page.locator('.field-details').textContent()).includes('Sparse feedback'));
    await page.locator('[data-field-edge="merge-branch"]').click();
    assert.ok((await page.locator('.field-details').textContent()).includes('merge extends branch by calibrating sparse feedback.'));
    await page.locator('.field-details summary').first().click();
    assert.ok((await page.locator('.field-details').textContent()).includes('span-merge-branch'));
    checks.push('Node and arrow selection exposes exact source quotes and span identifiers.');
    await page.screenshot({ path: path.join(output, 'evidence.png'), fullPage: true });
    await page.locator('[data-field-action="clear"]').click();
    await page.locator('[data-field-turning="convergence:merge"]').click();
    assert.ok((await page.locator('.field-details').textContent()).includes('2 distinct predecessors'));
    checks.push('Convergence candidate links both contributing evidence relations.');
    await page.locator('.field-family').selectOption({ label: 'Spectral feedback (2)' });
    assert.equal(await page.locator('[data-field-node]').count(), 2);
    const firstNode = page.locator('[data-field-node]').first();
    await firstNode.focus(); await page.keyboard.press('Enter');
    assert.ok((await page.locator('.field-details').textContent()).includes('Spectral feedback'));
    checks.push('Family filter and keyboard selection work.');
    const svgPromise = page.waitForEvent('download');
    await page.locator('[data-field-action="svg"]').click();
    const svgPath = path.join(output, 'filtered-map.svg');
    await (await svgPromise).saveAs(svgPath);
    const svg = await fs.readFile(svgPath, 'utf8');
    assert.ok(svg.includes('data-field-node="spectral"') && !svg.includes('data-field-node="m0"'));
    const jsonPromise = page.waitForEvent('download');
    await page.locator('[data-field-action="json"]').click();
    const jsonPath = path.join(output, 'analysis.json');
    await (await jsonPromise).saveAs(jsonPath);
    const exported = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    assert.equal(exported.view.familyId, 'family:spectral');
    assert.equal(exported.result.methods.length, 17);
    checks.push('SVG retains the active family; JSON retains full evidence and current view settings.');
    await page.locator('#field-from-year').fill('2015');
    await page.locator('#field-to-year').fill('2022');
    await page.locator('#field-build').click();
    await page.locator('[data-field-node="p-branch"]').waitFor();
    assert.equal(await page.locator('[data-field-node="p-m0"]').count(), 0);
    assert.equal(await page.locator('[data-field-node="p-unknown"]').count(), 1);
    checks.push('Year filtering excludes earlier papers and preserves the undated lane.');
    await page.locator('#topic-query').fill('nonexistentquantumterm');
    await page.locator('#field-build').click();
    await page.getByRole('heading', { name: 'No matching evidence' }).waitFor();
    assert.equal(await page.locator('[data-field-node]').count(), 0);
    checks.push('Empty analysis replaces the previous graph.');
    await page.locator('#topic-query').fill('feedback calibration');
    await page.locator('#field-from-year').fill(''); await page.locator('#field-to-year').fill('');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/field-evolution?*', async route => { await gate; await route.continue(); });
    await page.locator('#field-build').click();
    let releaseCorpus;
    const corpusGate = new Promise(resolve => { releaseCorpus = resolve; });
    await page.route('**/api/analysis-subgraph?name=empty-demo', async route => { await corpusGate; await route.continue(); });
    await page.locator('#corpus-select').selectOption('empty-demo');
    release();
    await page.locator('#field-evolution-panel').waitFor({ state: 'hidden' });
    await page.unroute('**/api/field-evolution?*');
    await page.locator('#field-build').click();
    assert.equal(await page.locator('#topic-status').textContent(), 'Load a corpus first.');
    assert.equal(await page.locator('#field-evolution-panel').isVisible(), false);
    checks.push('Starting a map while the selected corpus is loading cannot read the previous corpus.');
    releaseCorpus();
    await page.locator('#statusbar').filter({ hasText: 'empty-demo' }).waitFor();
    await page.unroute('**/api/analysis-subgraph?name=empty-demo');
    await page.locator('#field-build').click();
    await page.getByRole('heading', { name: 'No matching evidence' }).waitFor();
    assert.ok((await page.locator('.field-scope').textContent()).includes('empty-demo'));
    assert.equal(await page.locator('[data-field-node]').count(), 0);
    checks.push('A late response cannot restore the previous corpus after a corpus switch.');
    await page.locator('#corpus-select').selectOption('evolution-demo');
    await page.locator('#statusbar').filter({ hasText: 'evolution-demo' }).waitFor();
    await page.locator('#field-build').click();
    await page.locator('[data-field-node="p-m0"]').waitFor();
    await page.setViewportSize({ width: 780, height: 1000 });
    await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true });
    await page.locator('[data-field-action="close"]').click();
    await page.locator('#topic-submit').click();
    await page.locator('[data-analysis-view="evolution"]').click();
    assert.ok((await page.locator('#analysis-results').textContent()).includes('Method lineage'));
    checks.push('Narrow viewport and return to the existing topic analysis work.');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: checks.length, checks, browserErrors: errors, fictional: true }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output, browserErrors: errors }));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, checks, browserErrors: errors }, null, 2));
    throw error;
  } finally {
    await browser?.close(); await server.stop(); await fs.rm(temporary, { recursive: true, force: true });
  }
}
