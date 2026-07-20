import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const examplesRoot = path.join(projectRoot, 'examples');
const cliPath = path.join(projectRoot, 'src', 'cli', 'index.js');

let tempHome;
let tempCorpusRoot;
let pending;
let nextId = 1;
let loadCorpus;
let previousGraphBackend;

function startMcpClient(env) {
  const child = spawn('node', [cliPath, 'mcp'], {
    cwd: projectRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const requests = new Map();
  let buffer = Buffer.alloc(0);
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + bodyLength;
      if (buffer.length < messageEnd) return;

      const body = buffer.slice(headerEnd + 4, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      const pendingRequest = requests.get(message.id);
      if (!pendingRequest) continue;
      requests.delete(message.id);

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message));
        continue;
      }

      pendingRequest.resolve(message.result);
    }
  });

  return {
    child,
    async request(method, params = {}, requestOptions = {}) {
      const id = nextId;
      nextId += 1;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          requests.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}. stderr=${stderr.trim()}`));
        }, requestOptions.timeoutMs ?? 5000);

        requests.set(id, {
          resolve(result) {
            clearTimeout(timeout);
            resolve(result);
          },
          reject(error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
    },
    async close() {
      child.stdin.end();
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('close', () => resolve());
        setTimeout(resolve, 1000);
      });
    }
  };
}

before(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-home-'));
  tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-corpus-'));
  previousGraphBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;
  process.env.PAPERNEXUS_HOME = tempHome;
  process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(
      path.join(examplesRoot, fileName),
      path.join(tempCorpusRoot, fileName)
    );
  }

  const [{ analyzeCorpus }, corpusStore] = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/storage/corpus-store.js')
  ]);

  loadCorpus = corpusStore.loadCorpus;

  await analyzeCorpus(tempCorpusRoot, {
    name: 'mcp-papers',
    force: true
  });

  pending = startMcpClient({
    ...process.env,
    PAPERNEXUS_HOME: tempHome,
    PAPERNEXUS_GRAPH_BACKEND: 'json'
  });
});

after(async () => {
  if (pending) {
    await pending.close();
  }
  if (previousGraphBackend === undefined) {
    delete process.env.PAPERNEXUS_GRAPH_BACKEND;
  } else {
    process.env.PAPERNEXUS_GRAPH_BACKEND = previousGraphBackend;
  }
  await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  await fs.rm(tempHome, { recursive: true, force: true });
});

test('MCP initialize, tools, prompts, and resources endpoints return expected metadata', async () => {
  const initialized = await pending.request('initialize', {});
  assert.equal(initialized.serverInfo.name, 'papernexus');
  assert.equal(initialized.protocolVersion, '2024-11-05');

  const tools = await pending.request('tools/list', {});
  assert.ok(tools.tools.some((tool) => tool.name === 'brainstorm'));
  assert.ok(tools.tools.some((tool) => tool.name === 'query'));
  assert.ok(tools.tools.some((tool) => tool.name === 'mutate_graph'));
  assert.ok(tools.tools.some((tool) => tool.name === 'domain_distance'));
  assert.ok(tools.tools.some((tool) => tool.name === 'extract_takeaways'));
  assert.ok(tools.tools.some((tool) => tool.name === 'interdisciplinary_potential'));
  assert.ok(tools.tools.some((tool) => tool.name === 'corpus_sources'));
  assert.ok(tools.tools.some((tool) => tool.name === 'research_lookup'));
  assert.ok(tools.tools.some((tool) => tool.name === 'research_briefing'));
  assert.ok(tools.tools.some((tool) => tool.name === 'import_workflow'));
  assert.ok(tools.tools.some((tool) => tool.name === 'idea_catalyst'));
  const runtimeInitTool = tools.tools.find((tool) => tool.name === 'runtime_init');
  assert.ok(runtimeInitTool);
  assert.ok(Object.hasOwn(runtimeInitTool.inputSchema.properties, 'sourceInputs'));
  assert.deepEqual(runtimeInitTool.inputSchema.required, ['corpus']);
  assert.ok(Object.hasOwn(runtimeInitTool.inputSchema.properties, 'llm'));
  const createCorpusTool = tools.tools.find((tool) => tool.name === 'create_corpus');
  assert.ok(createCorpusTool);
  assert.ok(Object.hasOwn(createCorpusTool.inputSchema.properties, 'rootPath'));
  assert.ok(Object.hasOwn(createCorpusTool.inputSchema.properties, 'operation'));
  assert.ok(Object.hasOwn(createCorpusTool.inputSchema.properties, 'executionMode'));
  assert.ok(Object.hasOwn(createCorpusTool.inputSchema.properties, 'jobId'));
  const refreshCorpusTool = tools.tools.find((tool) => tool.name === 'refresh_corpus');
  assert.ok(refreshCorpusTool);
  assert.ok(refreshCorpusTool.inputSchema.properties.mode.enum.includes('llm_optimize'));
  assert.ok(Object.hasOwn(refreshCorpusTool.inputSchema.properties, 'llmBatchSize'));
  assert.ok(Object.hasOwn(refreshCorpusTool.inputSchema.properties, 'changedSourceKeys'));
  assert.ok(tools.tools.some((tool) => tool.name === 'refresh_paper_graph'));

  const prompts = await pending.request('prompts/list', {});
  assert.ok(prompts.prompts.some((prompt) => prompt.name === 'brainstorm_topic'));

  const brainstormPrompt = await pending.request('prompts/get', { name: 'brainstorm_topic' });
  assert.match(brainstormPrompt.description, /divergent exploration/i);
  assert.match(brainstormPrompt.messages[0].content.text, /Call brainstorm with mode diverge/);

  const resources = await pending.request('resources/list', {});
  assert.ok(resources.resources.some((resource) => resource.uri === 'papernexus://corpora'));
  assert.ok(resources.resources.some((resource) => resource.uri.includes('/context')));
  assert.ok(resources.resources.some((resource) => resource.uri.includes('/methods')));
  assert.ok(resources.resources.some((resource) => resource.uri.includes('/domain-taxonomy')));

  const resourceTemplates = await pending.request('resources/templates/list', {});
  assert.deepEqual(resourceTemplates.resourceTemplates, []);
});

test('MCP tool calls and resource reads work against an indexed corpus', async () => {
  const methodsResource = await pending.request('resources/read', {
    uri: 'papernexus://corpus/mcp-papers/methods'
  });
  assert.equal(methodsResource.contents[0].mimeType, 'text/markdown');
  assert.match(methodsResource.contents[0].text, /Methods:/);

  const domainTaxonomyResource = await pending.request('resources/read', {
    uri: 'papernexus://corpus/mcp-papers/domain-taxonomy'
  });
  assert.equal(domainTaxonomyResource.contents[0].mimeType, 'application/json');
  const taxonomy = JSON.parse(domainTaxonomyResource.contents[0].text);
  assert.equal(taxonomy.version, 'idea-catalyst-domain-distance-v1');
  assert.ok(Array.isArray(taxonomy.domains));
  assert.equal(typeof taxonomy.mechanismCoverage, 'object');

  const brainstormResult = await pending.request('tools/call', {
    name: 'brainstorm',
    arguments: {
      corpus: tempCorpusRoot,
      query: 'experiment planning',
      mode: 'converge',
      maxHops: 2,
      layers: 'ProblemLayer,MethodLayer,ConstraintLayer',
      layerMode: 'cross'
    }
  });
  assert.equal(brainstormResult.content[0].type, 'text');
  assert.match(brainstormResult.content[0].text, /Mode: converge/);
  assert.match(brainstormResult.content[0].text, /Converged directions:/);

  const brainstormDivergeResult = await pending.request('tools/call', {
    name: 'brainstorm',
    arguments: {
      corpus: tempCorpusRoot,
      query: 'experiment planning',
      mode: 'diverge',
      maxHops: 2
    }
  });
  assert.equal(brainstormDivergeResult.content[0].type, 'text');
  assert.match(brainstormDivergeResult.content[0].text, /Mode: diverge/);
  assert.equal(brainstormDivergeResult.content[1].type, 'text');
  const brainstormDivergePayload = JSON.parse(brainstormDivergeResult.content[1].text);
  assert.equal(brainstormDivergePayload.domainProfile.contractVersion, 'idea-catalyst-domain-community-profile-v1');
  assert.ok(Array.isArray(brainstormDivergePayload.domainProfile.topBridgeDomains));

  const queryResult = await pending.request('tools/call', {
    name: 'query',
    arguments: {
      corpus: tempCorpusRoot,
      query: 'graph augmented literature mapping',
      limit: 3
    }
  });
  assert.match(queryResult.content[0].text, /Results for/);

  const aggregatedLookup = await pending.request('tools/call', {
    name: 'research_lookup',
    arguments: {
      operation: 'query',
      corpus: tempCorpusRoot,
      query: 'graph augmented literature mapping',
      options: {
        limit: 3
      }
    }
  });
  const parsedLookup = JSON.parse(aggregatedLookup.content[0].text);
  assert.equal(parsedLookup.result.query, 'graph augmented literature mapping');
  assert.ok(parsedLookup.result.groups.length > 0);

  const preciseLookup = await pending.request('tools/call', {
    name: 'research_lookup',
    arguments: {
      operation: 'paper_index',
      corpus: tempCorpusRoot,
      paperTitle: 'Retrieval-Augmented Experiment Planning with Lab Notebooks'
    }
  });
  const parsedPreciseLookup = JSON.parse(preciseLookup.content[0].text);
  assert.equal(parsedPreciseLookup.result.contractVersion, 'paper-precise-index-v1');
  assert.equal(parsedPreciseLookup.result.matchCount, 1);
  assert.equal(parsedPreciseLookup.result.matches[0].paperTitle, 'Retrieval-Augmented Experiment Planning with Lab Notebooks');

  const methodEvidenceLookup = await pending.request('tools/call', {
    name: 'research_lookup',
    arguments: {
      operation: 'method_evidence',
      corpus: tempCorpusRoot,
      method: 'experiment planning',
      limit: 3
    }
  });
  const parsedMethodEvidence = JSON.parse(methodEvidenceLookup.content[0].text);
  assert.equal(parsedMethodEvidence.result.contractVersion, 'papernexus-method-evidence-v1');
  assert.equal(parsedMethodEvidence.result.diagnostics.queryTimeLlmCalls, 0);

  const methodRegistryLookup = await pending.request('tools/call', {
    name: 'research_lookup',
    arguments: {
      operation: 'method_registry',
      corpus: tempCorpusRoot
    }
  });
  const parsedMethodRegistry = JSON.parse(methodRegistryLookup.content[0].text);
  assert.equal(parsedMethodRegistry.result.contractVersion, 'papernexus-method-registry-v1');
  assert.ok(Array.isArray(parsedMethodRegistry.result.registry.methods));
  assert.equal(parsedMethodRegistry.result.diagnostics.queryTimeLlmCalls, 0);

  const ideaCatalystWriteback = await pending.request('tools/call', {
    name: 'idea_catalyst',
    arguments: {
      corpus: tempCorpusRoot,
      problem: 'make experiment planning more reproducible',
      targetDomain: 'Computer Science',
      outputMode: 'packet_bundle',
      writeBack: true,
      writeBackActor: 'mcp-test'
    }
  }, { timeoutMs: 15000 });
  const parsedIdeaCatalyst = JSON.parse(ideaCatalystWriteback.content[0].text);
  assert.equal(parsedIdeaCatalyst.writeback.requested, true);
  assert.equal(parsedIdeaCatalyst.writeback.dryRun, true);
  assert.equal(parsedIdeaCatalyst.writeback.applyStatus, 'blocked');
  assert.equal(parsedIdeaCatalyst.writeback.graphValidationStatus, 'not_run');
  assert.ok(parsedIdeaCatalyst.writeback.warnings.some((warning) => warning.code === 'no_contribution_claims'));
  let corpus = await loadCorpus(tempCorpusRoot);
  assert.ok(!corpus.graph.nodes.some((node) => node.type === 'ContributionClaim'));

  const aggregatedBriefing = await pending.request('tools/call', {
    name: 'research_briefing',
    arguments: {
      operation: 'evidence_chain',
      corpus: tempCorpusRoot,
      query: 'experiment planning',
      options: {
        limit: 3
      }
    }
  });
  const parsedBriefing = JSON.parse(aggregatedBriefing.content[0].text);
  assert.equal(parsedBriefing.result.query, 'experiment planning');
  assert.ok(parsedBriefing.result.chains.length > 0);

  const statusResult = await pending.request('tools/call', {
    name: 'corpus_status',
    arguments: {
      corpus: tempCorpusRoot
    }
  });
  assert.match(statusResult.content[0].text, /Graph mode: explicit-multilayer/);

  const sourcesResult = await pending.request('tools/call', {
    name: 'corpus_sources',
    arguments: {
      corpus: tempCorpusRoot
    }
  });
  const parsedSources = JSON.parse(sourcesResult.content[0].text);
  assert.equal(parsedSources.meta.name, 'mcp-papers');
  assert.equal(parsedSources.provenance.contractVersion, 'papernexus-corpus-source-provenance-v1');
  assert.ok(Array.isArray(parsedSources.sources));
  assert.equal(parsedSources.sources.length, 2);
  assert.ok(parsedSources.sources.every((entry) => entry.activeInGraph !== false));
  assert.equal(parsedSources.provenance.graphIndexEvidenceCount, 2);
  assert.equal(parsedSources.provenance.sourceSpanEvidenceCount, 2);
  assert.ok(parsedSources.sources.every((entry) => entry.graph_index_evidence?.available === true));
  assert.ok(parsedSources.sources.every((entry) => entry.graph_index_evidence?.paper_node_id));
  assert.ok(parsedSources.sources.every((entry) => entry.source_span_evidence?.available === true));
  assert.ok(parsedSources.sources.every((entry) => entry.source_span_evidence?.spans?.length > 0));
  assert.ok(parsedSources.sources.every((entry) => entry.source_span_evidence.spans[0].start_line >= 1));

  const domainDistanceResult = await pending.request('tools/call', {
    name: 'domain_distance',
    arguments: {
      corpus: tempCorpusRoot,
      targetDomain: 'Computer Science'
    }
  });
  const parsedDomainDistance = JSON.parse(domainDistanceResult.content[0].text);
  assert.equal(parsedDomainDistance.version, 'idea-catalyst-domain-distance-v1');
  assert.equal(parsedDomainDistance.targetDomain, 'Computer Science');
  assert.ok(Array.isArray(parsedDomainDistance.distances));

  const takeawayResult = await pending.request('tools/call', {
    name: 'extract_takeaways',
    arguments: {
      corpus: tempCorpusRoot,
      targetDomain: 'Computer Science',
      agnosticChallenges: ['experiment planning under retrieval constraints'],
      limit: 5
    }
  });
  const parsedTakeaways = JSON.parse(takeawayResult.content[0].text);
  assert.ok(Array.isArray(parsedTakeaways.takeaways));

  const interdisciplinaryResult = await pending.request('tools/call', {
    name: 'interdisciplinary_potential',
    arguments: {
      corpus: tempCorpusRoot,
      targetDomain: 'Computer Science',
      query: 'experiment planning under retrieval constraints',
      agnosticChallenges: ['experiment planning under retrieval constraints'],
      limit: 5
    }
  });
  const parsedInterdisciplinary = JSON.parse(interdisciplinaryResult.content[0].text);
  assert.equal(parsedInterdisciplinary.contractVersion, 'idea-catalyst-interdisciplinary-potential-v1');
  assert.equal(parsedInterdisciplinary.targetDomain, 'Computer Science');
  assert.ok(Array.isArray(parsedInterdisciplinary.rankedSourceDomains));
});

test('import_workflow exposes task progress and queue progress over MCP', async () => {
  const submitResult = await pending.request('tools/call', {
    name: 'import_workflow',
    arguments: {
      operation: 'submit',
      corpus: tempCorpusRoot,
      files: [
        {
          name: 'mcp-progress-upload.md',
          mimeType: 'text/markdown',
          contentBase64: Buffer.from('# MCP Progress Upload\n\n## Abstract\n\nTrack queue progress.\n', 'utf8').toString('base64'),
          identifiers: {
            doi: '10.48550/papernexus.mcp-progress-upload'
          }
        }
      ]
    }
  });
  const submitted = JSON.parse(submitResult.content[0].text);
  assert.equal(submitted.task.status, 'pending');
  assert.equal(submitted.task.progress.contractVersion, 'import-progress-v1');

  const progressResult = await pending.request('tools/call', {
    name: 'import_workflow',
    arguments: {
      operation: 'progress',
      corpus: tempCorpusRoot,
      taskId: submitted.task.id
    }
  });
  const progressPayload = JSON.parse(progressResult.content[0].text);
  assert.equal(progressPayload.task.id, submitted.task.id);
  assert.equal(progressPayload.task.progress.contractVersion, 'import-progress-v1');
  assert.equal(progressPayload.queueSummary.total >= 1, true);

  const queueProgressResult = await pending.request('tools/call', {
    name: 'import_workflow',
    arguments: {
      operation: 'queue_progress',
      corpus: tempCorpusRoot
    }
  });
  const queueProgressPayload = JSON.parse(queueProgressResult.content[0].text);
  assert.equal(queueProgressPayload.summary.total >= 1, true);
  assert.equal(typeof queueProgressPayload.summary.overallPercent, 'number');
  assert.ok(Array.isArray(queueProgressPayload.tasks));
  assert.ok(queueProgressPayload.tasks.some((task) => task.id === submitted.task.id));
});

test('refresh_paper_graph force-refreshes one paper over MCP without rebuilding the whole corpus', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-paper-refresh-home-'));
  const localCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-paper-refresh-corpus-'));
  const localPaperPath = path.join(localCorpusRoot, 'refresh-target.md');
  let localPending = null;

  try {
    await fs.writeFile(
      localPaperPath,
      '# Refresh Target Paper\n\n## Abstract\n\nOriginal abstract.\n\n## Method\n\nOriginal method.\n',
      'utf8'
    );

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);
    await analyzeCorpus(localCorpusRoot, {
      name: 'mcp-paper-refresh',
      force: true
    });

    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    await fs.writeFile(
      localPaperPath,
      '# Refresh Target Paper Revised\n\n## Abstract\n\nRevised abstract.\n\n## Method\n\nRevised method.\n',
      'utf8'
    );

    const refreshResult = await localPending.request('tools/call', {
      name: 'refresh_paper_graph',
      arguments: {
        corpus: localCorpusRoot,
        source: localPaperPath
      }
    }, { timeoutMs: 15000 });
    const refreshPayload = JSON.parse(refreshResult.content[0].text);
    assert.equal(refreshPayload.contractVersion, 'paper-graph-refresh-v1');
    assert.equal(refreshPayload.fastCommit.reused, false);
    assert.ok(refreshPayload.refreshedSourceKeys.includes(localPaperPath));
    assert.ok(refreshPayload.affectedSourceKeys.includes(localPaperPath));

    const manifest = await corpusStore.loadSourceManifest(localCorpusRoot);
    const manifestEntry = manifest.sources.find((entry) => entry.sourceKey === localPaperPath);
    assert.ok(manifestEntry);
    assert.equal(manifestEntry.paperTitle, 'Refresh Target Paper Revised');

    const snapshot = await corpusStore.loadSemanticPaperSnapshot(localCorpusRoot, localPaperPath);
    assert.ok(snapshot);
    assert.equal(snapshot.paperTitle, 'Refresh Target Paper Revised');
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(localCorpusRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('runtime_init and create_corpus expose zero-to-first-build setup over MCP', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-home-'));
  const localSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-source-'));
  const localIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-index-'));
  const localConfigPath = path.join(localHome, 'config.json');
  let localPending = null;

  try {
    await fs.writeFile(
      path.join(localSourceRoot, 'new-paper.md'),
      '# MCP Created Corpus\n\n## Abstract\n\nA paper about MCP-based corpus creation.\n\n## Method\n\nThe method builds a PaperNexus graph from a server-side source path.\n',
      'utf8'
    );

    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    const initResult = await localPending.request('tools/call', {
      name: 'runtime_init',
      arguments: {
        configPath: localConfigPath,
        sourceInputs: [localSourceRoot],
        corpus: 'mcp-created',
        indexDir: localIndexRoot,
        pdfParser: 'markitdown',
        serveMcpEnabled: true,
        serveMcpPath: 'mcp',
        llm: {
          provider: 'ollama',
          model: 'qwen2.5:0.5b',
          relations: false
        }
      }
    });
    const initPayload = JSON.parse(initResult.content[0].text);
    assert.equal(initPayload.contractVersion, 'papernexus-runtime-init-v1');
    assert.equal(initPayload.configPath, localConfigPath);
    assert.deepEqual(initPayload.resolvedSourceInputs, [localSourceRoot]);
    assert.equal(initPayload.resolvedIndexDir, localIndexRoot);
    assert.equal(initPayload.serve.mcp.path, '/mcp');

    const savedConfig = JSON.parse(await fs.readFile(localConfigPath, 'utf8'));
    assert.deepEqual(savedConfig.sources.inputs, [localSourceRoot]);
    assert.equal(savedConfig.storage.indexDir, localIndexRoot);
    assert.deepEqual(savedConfig.storage.indexDirs, []);
    assert.equal(savedConfig.analyze.name, 'mcp-created');
    assert.equal(savedConfig.global.corpus, 'mcp-created');
    assert.equal(savedConfig.analyze.pdfParser, 'markitdown');
    assert.equal(savedConfig.llm.provider, 'ollama');
    assert.equal(savedConfig.llm.model, 'qwen2.5:0.5b');
    assert.equal(savedConfig.llm.apiKey, undefined);

    const createResult = await localPending.request('tools/call', {
      name: 'create_corpus',
      arguments: {
        configPath: localConfigPath,
        semanticExtraction: 'heuristic-only',
        force: true
      }
    });
    const submitPayload = JSON.parse(createResult.content[0].text);
    assert.equal(submitPayload.contractVersion, 'papernexus-corpus-create-job-v1');
    assert.equal(submitPayload.corpus, 'mcp-created');
    assert.equal(submitPayload.rootPath, localIndexRoot);
    assert.equal(submitPayload.graphCommitted, false);
    assert.ok(submitPayload.jobId);

    const waitResult = await localPending.request('tools/call', {
      name: 'create_corpus',
      arguments: {
        operation: 'wait',
        jobId: submitPayload.jobId,
        waitTimeoutMs: 20000
      }
    }, { timeoutMs: 25000 });
    const waitPayload = JSON.parse(waitResult.content[0].text);
    assert.equal(waitPayload.contractVersion, 'papernexus-corpus-create-job-v1');
    assert.equal(waitPayload.status, 'completed');
    assert.equal(waitPayload.graphCommitted, true);
    assert.equal(waitPayload.timedOut, false);

    const createPayload = waitPayload.result;
    assert.equal(createPayload.contractVersion, 'papernexus-corpus-create-v1');
    assert.equal(createPayload.corpus, 'mcp-created');
    assert.equal(createPayload.rootPath, localIndexRoot);
    assert.equal(createPayload.graphCommitted, true);
    assert.equal(createPayload.options.semanticExtraction, 'heuristic-only');
    assert.ok(createPayload.meta.paperCount >= 1);

    const statusResult = await localPending.request('tools/call', {
      name: 'corpus_status',
      arguments: {
        corpus: localIndexRoot
      }
    });
    assert.match(statusResult.content[0].text, /mcp-created/);
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(localIndexRoot, { recursive: true, force: true });
    await fs.rm(localSourceRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('runtime_init and create_corpus reject raw Firecrawl API keys over MCP', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-firecrawl-key-home-'));
  const localIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-firecrawl-key-index-'));
  const localConfigPath = path.join(localHome, 'config.json');
  let localPending = null;

  try {
    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    await assert.rejects(
      () => localPending.request('tools/call', {
        name: 'runtime_init',
        arguments: {
          configPath: localConfigPath,
          corpus: 'mcp-firecrawl-key-check',
          indexDir: localIndexRoot,
          pdfParser: 'firecrawl',
          firecrawlApiKey: 'raw-firecrawl-key'
        }
      }),
      /runtime_init does not accept Firecrawl raw API keys/
    );

    await fs.writeFile(localConfigPath, JSON.stringify({
      storage: {
        indexDir: localIndexRoot
      },
      analyze: {
        name: 'mcp-firecrawl-key-check',
        pdfParser: 'firecrawl'
      },
      global: {
        corpus: 'mcp-firecrawl-key-check'
      }
    }, null, 2));

    await assert.rejects(
      () => localPending.request('tools/call', {
        name: 'create_corpus',
        arguments: {
          configPath: localConfigPath,
          firecrawl: {
            apiKey: 'raw-firecrawl-key'
          }
        }
      }),
      /create_corpus does not accept Firecrawl raw API keys/
    );
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(localIndexRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('runtime_init persists multiple storage indexDirs while keeping indexDir compatible', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-multi-home-'));
  const firstIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-multi-index-a-'));
  const secondIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-init-multi-index-b-'));
  const localConfigPath = path.join(localHome, 'config.json');
  let localPending = null;

  try {
    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    const initResult = await localPending.request('tools/call', {
      name: 'runtime_init',
      arguments: {
        configPath: localConfigPath,
        corpus: 'mcp-multi-index',
        indexDirs: [firstIndexRoot, secondIndexRoot],
        pdfParser: 'markitdown'
      }
    });
    const initPayload = JSON.parse(initResult.content[0].text);

    assert.equal(initPayload.contractVersion, 'papernexus-runtime-init-v1');
    assert.equal(initPayload.indexDir, firstIndexRoot);
    assert.deepEqual(initPayload.indexDirs, [firstIndexRoot, secondIndexRoot]);
    assert.deepEqual(initPayload.resolvedIndexDirs, [firstIndexRoot, secondIndexRoot]);

    const savedConfig = JSON.parse(await fs.readFile(localConfigPath, 'utf8'));
    assert.equal(savedConfig.storage.indexDir, firstIndexRoot);
    assert.deepEqual(savedConfig.storage.indexDirs, [firstIndexRoot, secondIndexRoot]);
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(secondIndexRoot, { recursive: true, force: true });
    await fs.rm(firstIndexRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('runtime_init and create_corpus reject sourceInputs that are not visible to the MCP server', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-path-home-'));
  const localIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-path-index-'));
  const localConfigPath = path.join(localHome, 'config.json');
  const workstationOnlyPath = '/Users/__papernexus_not_on_server__/missing-paper.pdf';
  let localPending = null;

  try {
    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    await assert.rejects(
      () => localPending.request('tools/call', {
        name: 'runtime_init',
        arguments: {
          configPath: localConfigPath,
          sourceInputs: [workstationOnlyPath],
          corpus: 'mcp-path-check',
          indexDir: localIndexRoot
        }
      }),
      /runtime_init sourceInputs\[0\] is not visible to this MCP server:.*local workstation path/
    );

    await fs.writeFile(localConfigPath, JSON.stringify({
      sources: {
        inputs: [workstationOnlyPath]
      },
      storage: {
        indexDir: localIndexRoot
      },
      analyze: {
        name: 'mcp-path-check',
        pdfParser: 'markitdown'
      },
      global: {
        corpus: 'mcp-path-check'
      }
    }, null, 2));

    await assert.rejects(
      () => localPending.request('tools/call', {
        name: 'create_corpus',
        arguments: {
          configPath: localConfigPath,
          semanticExtraction: 'heuristic-only'
        }
      }),
      /create_corpus sourceInputs\[0\] is not visible to this MCP server:.*local workstation path/
    );
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(localIndexRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('create_corpus can initialize an empty graph over MCP', async () => {
  const localHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-empty-home-'));
  const localIndexRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mcp-empty-index-'));
  const localConfigPath = path.join(localHome, 'config.json');
  let localPending = null;

  try {
    localPending = startMcpClient({
      ...process.env,
      PAPERNEXUS_HOME: localHome,
      PAPERNEXUS_GRAPH_BACKEND: 'json'
    });
    await localPending.request('initialize', {});

    const initResult = await localPending.request('tools/call', {
      name: 'runtime_init',
      arguments: {
        configPath: localConfigPath,
        corpus: 'mcp-empty',
        indexDir: localIndexRoot,
        pdfParser: 'markitdown'
      }
    });
    const initPayload = JSON.parse(initResult.content[0].text);
    assert.equal(initPayload.contractVersion, 'papernexus-runtime-init-v1');
    assert.deepEqual(initPayload.sourceInputs, []);
    assert.deepEqual(initPayload.resolvedSourceInputs, []);

    const savedConfig = JSON.parse(await fs.readFile(localConfigPath, 'utf8'));
    assert.deepEqual(savedConfig.sources.inputs, []);
    assert.equal(savedConfig.storage.indexDir, localIndexRoot);

    const createResult = await localPending.request('tools/call', {
      name: 'create_corpus',
      arguments: {
        configPath: localConfigPath,
        semanticExtraction: 'heuristic-only',
        force: true
      }
    }, { timeoutMs: 20000 });
    const createPayload = JSON.parse(createResult.content[0].text);
    assert.equal(createPayload.contractVersion, 'papernexus-corpus-create-v1');
    assert.equal(createPayload.corpus, 'mcp-empty');
    assert.equal(createPayload.rootPath, localIndexRoot);
    assert.equal(createPayload.stage, 'completed');
    assert.equal(createPayload.graphCommitted, true);
    assert.deepEqual(createPayload.sourceInputs, []);
    assert.deepEqual(createPayload.resolvedSourceInputs, []);
    assert.equal(createPayload.meta.paperCount, 0);
    assert.equal(createPayload.meta.sourceCount, 0);

    const statusResult = await localPending.request('tools/call', {
      name: 'corpus_status',
      arguments: {
        corpus: localIndexRoot
      }
    });
    assert.match(statusResult.content[0].text, /mcp-empty/);
    assert.match(statusResult.content[0].text, /Papers: 0/);
  } finally {
    if (localPending) {
      await localPending.close();
    }
    await fs.rm(localIndexRoot, { recursive: true, force: true });
    await fs.rm(localHome, { recursive: true, force: true });
  }
});

test('refresh_corpus exposes staged corpus maintenance modes over MCP', async () => {
  const refreshResult = await pending.request('tools/call', {
    name: 'refresh_corpus',
    arguments: {
      corpus: tempCorpusRoot,
      mode: 'llm_optimize',
      semanticExtraction: 'heuristic-only',
      force: true,
      llmBatchSize: 4
    }
  }, { timeoutMs: 15000 });
  const refreshPayload = JSON.parse(refreshResult.content[0].text);
  assert.equal(refreshPayload.contractVersion, 'papernexus-corpus-refresh-v1');
  assert.equal(refreshPayload.mode, 'llm_optimize');
  assert.equal(refreshPayload.stage, 'llm-optimized');
  assert.equal(refreshPayload.graphCommitted, false);
  assert.equal(refreshPayload.options.llmBatchSize, 4);
  assert.equal(refreshPayload.options.semanticExtraction, 'heuristic-only');
  assert.equal(refreshPayload.rootPath.length > 0, true);
});

test('MCP mutate_graph previews and applies validated graph edits', async () => {
  const preview = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: true,
      operations: [
        {
          action: 'create_node',
          type: 'Problem',
          name: 'pseudo-label collapse under class imbalance'
        }
      ]
    }
  });
  assert.match(preview.content[0].text, /Graph mutation preview/);
  assert.match(preview.content[0].text, /\+1 nodes/);

  let corpus = await loadCorpus(tempCorpusRoot);
  assert.ok(!corpus.graph.nodes.some((node) => node.name === 'pseudo-label collapse under class imbalance'));

  const applyResult = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: false,
      operations: [
        {
          action: 'create_node',
          type: 'Problem',
          name: 'pseudo-label collapse under class imbalance'
        },
        {
          action: 'create_node',
          type: 'Method',
          name: 'class-balanced uncertainty gating'
        },
        {
          action: 'create_relationship',
          source: { type: 'Method', name: 'class-balanced uncertainty gating' },
          target: { type: 'Problem', name: 'pseudo-label collapse under class imbalance' },
          type: 'APPLIES_TO'
        }
      ]
    }
  });
  assert.match(applyResult.content[0].text, /Graph mutation applied/);
  assert.match(applyResult.content[0].text, /Created relationship/);

  corpus = await loadCorpus(tempCorpusRoot);
  const problemNode = corpus.graph.nodes.find((node) => node.name === 'pseudo-label collapse under class imbalance');
  const methodNode = corpus.graph.nodes.find((node) => node.name === 'class-balanced uncertainty gating');
  assert.ok(problemNode);
  assert.ok(methodNode);
  assert.ok(
    corpus.graph.relationships.some((relationship) => {
      return relationship.type === 'APPLIES_TO'
        && relationship.sourceId === methodNode.id
        && relationship.targetId === problemNode.id;
    })
  );

  const invalid = await pending.request('tools/call', {
    name: 'mutate_graph',
    arguments: {
      corpus: tempCorpusRoot,
      actor: 'mcp-test',
      dryRun: true,
      operations: [
        {
          action: 'create_relationship',
          source: { id: methodNode.id },
          target: { id: problemNode.id },
          type: 'SUPPORTED_BY'
        }
      ]
    }
  }).then(() => null).catch((error) => error);
  assert.ok(invalid);
  assert.match(invalid.message, /Invalid relationship/);
});
