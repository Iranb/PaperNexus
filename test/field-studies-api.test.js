import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { createFieldEvolutionFixture } from './fixtures/field-evolution-fixture.js';
import { serveCommand } from '../src/server/http.js';
import { executeTool } from '../src/mcp/core.js';

const idleWorker = () => ({ stop() {}, pollNow() {} });

test('HTTP and MCP share saved study state and reject stale or invalid updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-study-http-'));
  const paths = getCorpusPaths(root);
  let server;
  try {
    await fs.mkdir(paths.corpusDir, { recursive: true });
    await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'study-api', rootPath: root }));
    await fs.writeFile(paths.liteGraphPath, JSON.stringify(createFieldEvolutionFixture().toJSON()));
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    server = await serveCommand({ host: '127.0.0.1', port, rootPaths: [root], apiToken: 'study-api-token',
      config: { serve: { mcp: { enabled: true } } }, enableEnhancements: false,
      startImportWorker: idleWorker, startAuthoritativeSyncWorker: idleWorker,
      enableFastMdImportLane: false, enableMineruWarmup: false, enableDoclingWarmup: false,
      enableLiteratureDiscoveryRecovery: false, enableImportWorkflowRecovery: false, enableRegistryReconcile: false });
    const base = `http://127.0.0.1:${server.port}`;
    const endpoint = '/api/field-studies?name=' + encodeURIComponent(root);
    const headers = { authorization: 'Bearer study-api-token', 'content-type': 'application/json' };
    assert.equal((await fetch(base + endpoint)).status, 401);
    const study = { title: 'Native study', query: 'feedback', scope: 'Fictional API scope.',
      branches: [{ id: 'core', label: 'Core', description: 'Control.', reviewStatus: 'pending', reviewSummary: 'Source review pending.', gaps: [] }],
      searches: [], papers: [{ paperId: 'p-m0', role: 'method', methodIds: ['m0'], branchIds: ['core'], reason: 'Original method.', evidenceRefs: ['https://example.org/m0'] }],
      coverage: { status: 'in_progress', summary: 'Coverage not established.', gaps: ['More branches need review.'], nextActions: ['Inspect successors.'] } };
    const args = { studyId: 'native-study', expectedRevision: 0, study };
    const saved = await executeTool('literature_review', { operation: 'study_save', corpus: root, ...args }, {});
    assert.equal(saved.result.revision, 1);
    const list = await (await fetch(base + endpoint, { headers })).json();
    assert.equal(list.studies[0].studyId, args.studyId);
    const read = await (await fetch(base + endpoint + '&studyId=native-study', { headers })).json();
    assert.equal(read.analysis.result.papers[0].id, 'p-m0');
    assert.equal(read.coverageAssessment.status, 'in_progress');
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(args) })).status, 409);
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify({ ...args, expectedRevision: 1 }) })).status, 200);
    const mcp = await executeTool('literature_review', { operation: 'study', corpus: root, studyId: args.studyId }, {});
    assert.equal(mcp.result.revision, 2);
    await assert.rejects(executeTool('literature_review', { operation: 'study_save', corpus: root,
      ...args, study: { ...study, unknownField: true } }, {}), /Invalid study/);
    await assert.rejects(executeTool('literature_review', { operation: 'study_save', corpus: root,
      ...args, study: { ...study, papers: [{ ...study.papers[0], methodIds: 'm0' }] } }, {}), /Invalid study/);
  } finally { await server?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
