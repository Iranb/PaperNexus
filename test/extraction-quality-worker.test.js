import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('semantic worker settles a mixed batch without requeuing failures or retrying unpaid calls', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-quality-worker-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  const previousFetch = globalThis.fetch;
  const input = path.join(workspace, 'input');
  const root = path.join(workspace, 'corpus');
  let modelCalls = 0;
  const callKinds = [];
  try {
    process.env.PAPERNEXUS_HOME = path.join(workspace, 'home');
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith('https://extraction.test/')) {
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }
      modelCalls += 1;
      const request = JSON.parse(init.body);
      const prompt = request.messages.map(message => message.content).join('\n');
      const papers = JSON.parse(prompt.slice(prompt.lastIndexOf('Papers:\n') + 'Papers:\n'.length));
      callKinds.push({ prompt: prompt.split('\n')[0], titles: papers.map(paper => paper.title) });
      if (papers.some(paper => paper.title.includes('Quota'))) {
        return { ok: false, status: 402, statusText: 'Payment Required', text: async () => 'Insufficient Balance' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
        papers: papers.map(paper => ({ id: paper.id, fieldOfStudy: 'Computer Science',
          methods: paper.title.includes('Empty') ? [] : [{
            name: 'Replay classifier', evidenceText: 'We propose a replay classifier.'
          }]
        }))
      }) } }] }) };
    };
    await fs.mkdir(input, { recursive: true });
    await fs.writeFile(path.join(input, 'seed.md'), '# Seed Paper\n\n## Abstract\n\nA study of incremental learning.\n');
    const [ingestion, imports, worker, jobs] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'), import('../src/storage/import-store.js'),
      import('../src/core/imports/worker.js'), import('../src/storage/import-semantic-store.js')
    ]);
    await ingestion.analyzeCorpus(input, { rootPath: root, name: 'quality-worker', force: true,
      semanticExtraction: 'heuristic-only', quiet: true });
    const tasks = [];
    for (const title of ['Valid Output', 'Empty Output', 'Quota Failure']) {
      tasks.push(await imports.createImportTask(root, {
        processingProfile: 'fast-md-background-semantic', completionPolicy: 'graph-visible',
        llmExtractionStrategy: 'long-context-first', llmContextWindowTokens: 1_000_000,
        llmLongContextMaxPapersPerCall: 1,
        files: [{ name: `${title.replaceAll(' ', '-')}.md`, mimeType: 'text/markdown',
          contentBase64: Buffer.from(`# ${title}\n\n## Abstract\n\nWe study continual classification.\n\n## Method\n\nWe propose a replay classifier.\n`).toString('base64') }]
      }));
    }
    await worker.runImportQueueOnce(root, {
      semanticExtraction: 'llm-primary', batchEnabled: true, batchInitialTasks: 3, batchMaxTasks: 3,
      quiet: true
    });
    assert.equal(modelCalls, 0);
    const result = await worker.runImportSemanticEnrichmentQueueUntilIdle(root, {
      semanticExtraction: 'llm-primary', llmProvider: 'openai', llmModel: 'fixture-model',
      llmBaseUrl: 'https://extraction.test/v1', llmApiKey: 'fixture-key',
      llmRelations: false, llmLongContextStructuralFallback: false,
      llmBatchFailureSplitRetryCount: 0, llmBatchConcurrency: 1,
      importSemanticEnrichmentBatchMaxJobs: 3, maxPasses: 2, quiet: true
    });
    assert.equal(callKinds.filter(call => call.titles.includes('Quota Failure')).length, 1, JSON.stringify(callKinds));
    assert.equal(callKinds.filter(call => call.titles.includes('Valid Output')).length, 1, JSON.stringify(callKinds));
    assert.equal(result.completedJobIds.length, 1);
    assert.equal(result.failedCount, 2);
    const queue = await jobs.listImportSemanticEnrichmentJobs(root);
    assert.equal(queue.summary.completed, 1);
    assert.equal(queue.summary.failed, 2);
    assert.equal(queue.summary.pending, 0);
    const loaded = await Promise.all(tasks.map(task => imports.loadImportTask(root, task.id)));
    assert.deepEqual(loaded.map(task => task.semanticStatus), ['completed', 'failed', 'failed']);
    assert.ok(loaded.every(task => task.graphVisibilityStatus === 'completed'));
    const empty = queue.jobs.find(job => job.taskId === tasks[1].id);
    assert.equal(empty.result.semanticCompletion.papers[0].semanticObjectCount, 0);
    assert.equal(empty.result.semanticCompletion.complete, false);
    assert.equal(empty.attempts, 1);
    const unpaid = queue.jobs.find(job => job.taskId === tasks[2].id);
    assert.match(unpaid.error.message, /402|Insufficient Balance/);
    assert.equal(unpaid.attempts, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
