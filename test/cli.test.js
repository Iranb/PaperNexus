import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  appendRunEvent,
  startRun,
  updateRunStage,
  writeRunCheckpoint,
  writeRunWorkerLease
} from '../src/storage/run-store.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const cliPath = path.join(projectRoot, 'src', 'cli', 'index.js');
const examplesRoot = path.join(projectRoot, 'examples');

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function startFirecrawlServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      await handler(request, response, requests);
    } catch (error) {
      writeJson(response, 500, { success: false, error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function spawnCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cliPath, ...args], {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr
      });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function createImportQueueFixture(namePrefix = 'cli-imports') {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), `${namePrefix}-home-`));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${namePrefix}-corpus-`));
  const corpusName = `${namePrefix}-corpus`;
  const env = {
    ...process.env,
    PAPERNEXUS_HOME: tempHome
  };

  await fs.copyFile(
    path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
    path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.md')
  );

  await execFileAsync('node', [cliPath, 'analyze', '--no-config=true', tempCorpusRoot, '--name', corpusName, '--force'], {
    cwd: projectRoot,
    env
  });

  const importStore = await import('../src/storage/import-store.js');
  const runningTask = await importStore.createImportTask(tempCorpusRoot, {
    trigger: 'api',
    inputPaths: [tempCorpusRoot],
    files: [
      {
        name: 'running-paper.md',
        contentBase64: Buffer.from('# Running Paper\n\n## Abstract\n\nQueue fixture.\n', 'utf8').toString('base64'),
        mimeType: 'text/markdown'
      }
    ]
  });
  await importStore.reserveNextImportTask(tempCorpusRoot);
  await importStore.markImportTaskStage(tempCorpusRoot, runningTask.id, 'llm-optimize', 'semantic extraction');
  await importStore.updateImportTaskProgress(tempCorpusRoot, runningTask.id, {
    stage: 'llm-optimize',
    status: 'running',
    stagePercent: 45,
    processedUnits: 40,
    totalUnits: 96,
    currentStep: 'semantic extraction',
    message: 'batch 5/12, 40/96 papers completed'
  });
  await importStore.appendImportTaskLog(tempCorpusRoot, runningTask.id, {
    level: 'info',
    message: 'semantic batch started'
  });
  await importStore.appendImportTaskLog(tempCorpusRoot, runningTask.id, {
    level: 'info',
    message: 'semantic batch completed'
  });

  const pendingTask = await importStore.createImportTask(tempCorpusRoot, {
    trigger: 'api',
    inputPaths: [tempCorpusRoot],
    files: [
      {
        name: 'pending-paper.md',
        contentBase64: Buffer.from('# Pending Paper\n\n## Abstract\n\nQueue fixture.\n', 'utf8').toString('base64'),
        mimeType: 'text/markdown'
      }
    ]
  });

  const failedTask = await importStore.createImportTask(tempCorpusRoot, {
    trigger: 'api',
    inputPaths: [tempCorpusRoot],
    files: [
      {
        name: 'failed-paper.md',
        contentBase64: Buffer.from('# Failed Paper\n\n## Abstract\n\nQueue fixture.\n', 'utf8').toString('base64'),
        mimeType: 'text/markdown'
      }
    ]
  });
  await importStore.failImportTask(tempCorpusRoot, failedTask.id, new Error('synthetic failure'));

  return {
    tempHome,
    tempCorpusRoot,
    corpusName,
    env,
    runningTask,
    pendingTask,
    failedTask
  };
}

async function createMinimalCorpusFixture(namePrefix = 'cli-run') {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), `${namePrefix}-home-`));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${namePrefix}-corpus-`));
  const env = {
    ...process.env,
    PAPERNEXUS_HOME: tempHome
  };
  await fs.mkdir(path.join(tempCorpusRoot, '.papernexus'), { recursive: true });
  await fs.writeFile(path.join(tempCorpusRoot, '.papernexus', 'meta.json'), `${JSON.stringify({
    name: `${namePrefix}-corpus`,
    indexedAt: new Date().toISOString(),
    paperCount: 0,
    nodeCount: 0,
    relationshipCount: 0
  }, null, 2)}\n`);
  return {
    tempHome,
    tempCorpusRoot,
    env
  };
}

async function createRegisteredCleanCorpus(rootPath, name, paperCount = 1) {
  const corpusDir = path.join(rootPath, '.papernexus');
  await fs.mkdir(corpusDir, { recursive: true });
  await fs.writeFile(path.join(corpusDir, 'meta.json'), `${JSON.stringify({
    name,
    indexedAt: new Date().toISOString(),
    paperCount,
    nodeCount: paperCount,
    relationshipCount: 0
  }, null, 2)}\n`);
  return {
    name,
    rootPath,
    indexedAt: new Date().toISOString(),
    paperCount
  };
}

test('CLI run status and report accept corpus as the first positional after subcommand', async () => {
  const { tempHome, tempCorpusRoot, env } = await createMinimalCorpusFixture('papernexus-cli-run');

  try {
    const run = await startRun(tempCorpusRoot, {
      kind: 'graph-v2-migration',
      command: 'build-shadow',
      currentStage: 'inventory',
      manifestToken: 'manifest:cli-test',
      configSignature: 'config:cli-test'
    });
    await updateRunStage(tempCorpusRoot, run.runId, 'inventory', {
      status: 'running',
      processedUnits: 1,
      totalUnits: 4,
      percent: 25,
      message: 'inventory progress'
    });
    await writeRunCheckpoint(tempCorpusRoot, run.runId, 'inventory/shard-0001', {
      status: 'completed',
      inputHash: 'input:test',
      outputHash: 'output:test'
    });
    await writeRunWorkerLease(tempCorpusRoot, run.runId, 'worker-1', {
      stage: 'inventory',
      shardId: 'shard-0001'
    });
    await appendRunEvent(tempCorpusRoot, run.runId, {
      event: 'stage-progress',
      stage: 'inventory',
      message: 'inventory progress'
    });

    const status = await spawnCli(['run', 'status', tempCorpusRoot, '--no-config=true'], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Run ${run.runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(status.stdout, /Current stage: inventory/);

    const report = await spawnCli(['run', 'report', tempCorpusRoot, '--no-config=true', '--tail', '5'], { env });
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /# PaperNexus Run Report/);
    assert.match(report.stdout, /## Checkpoint Summary/);
    assert.match(report.stdout, /inventory\/shard-0001/);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('CLI clean supports safe batch dry-run and explicit apply for temporary corpora', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-clean-home-'));
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-clean-first-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-clean-second-'));
  const env = {
    ...process.env,
    PAPERNEXUS_HOME: tempHome
  };

  try {
    const first = await createRegisteredCleanCorpus(firstRoot, 'cli-clean-first', 1);
    const second = await createRegisteredCleanCorpus(secondRoot, 'cli-clean-second', 2);
    await fs.writeFile(path.join(tempHome, 'registry.json'), `${JSON.stringify({
      corpora: [first, second]
    }, null, 2)}\n`);

    const preview = await spawnCli([
      'clean',
      '--no-config=true',
      '--corpora',
      'cli-clean-first,cli-clean-second'
    ], { env });
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /Batch clean preview/);
    assert.match(preview.stdout, /cli-clean-first: would remove/);
    assert.match(preview.stdout, /No files were deleted/);
    await fs.access(path.join(firstRoot, '.papernexus', 'meta.json'));
    await fs.access(path.join(secondRoot, '.papernexus', 'meta.json'));

    const apply = await spawnCli([
      'clean',
      '--no-config=true',
      '--corpora',
      'cli-clean-first,cli-clean-second',
      '--apply'
    ], { env });
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /Batch clean completed/);
    assert.match(apply.stdout, /cli-clean-first: cleaned/);

    await assert.rejects(
      fs.access(path.join(firstRoot, '.papernexus', 'meta.json')),
      { code: 'ENOENT' }
    );
    await assert.rejects(
      fs.access(path.join(secondRoot, '.papernexus', 'meta.json')),
      { code: 'ENOENT' }
    );
    const registry = JSON.parse(await fs.readFile(path.join(tempHome, 'registry.json'), 'utf8'));
    assert.deepEqual(registry.corpora, []);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('CLI graph-v2 inventory starts a new run when no run id is supplied', async () => {
  const { tempHome, tempCorpusRoot, env } = await createMinimalCorpusFixture('papernexus-cli-graph-v2');

  try {
    const result = await spawnCli(['graph-v2', 'inventory', tempCorpusRoot, '--no-config=true', '--json'], { env });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.report.type, 'inventory');
    assert.equal(payload.report.rootPath, tempCorpusRoot);
    assert.ok(payload.runId);
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('CLI analyze and brainstorm commands work end-to-end on example corpus', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-corpus-'));

  try {
    const { resolveGraphStorageMode } = await import('../src/storage/corpus-store.js');

    for (const fileName of [
      'retrieval-augmented-experiment-planning.md',
      'graph-augmented-literature-mapping.md'
    ]) {
      await fs.copyFile(
        path.join(examplesRoot, fileName),
        path.join(tempCorpusRoot, fileName)
      );
    }

    const env = {
      ...process.env,
      PAPERNEXUS_HOME: tempHome
    };

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--no-config=true', tempCorpusRoot, '--name', 'cli-papers', '--force'], {
      cwd: projectRoot,
      env
    });

    assert.match(analyzeRun.stdout, /Graph mode: explicit-multilayer/);
    assert.match(
      analyzeRun.stdout,
      new RegExp(`Storage mode: ${(await resolveGraphStorageMode()).replace('+', '\\+')}`)
    );

    const brainstormRun = await execFileAsync('node', [
      cliPath,
      'brainstorm',
      '--no-config=true',
      'experiment planning',
      '--corpus',
      tempCorpusRoot,
      '--mode',
      'converge',
      '--hops',
      '2'
    ], {
      cwd: projectRoot,
      env
    });

    assert.match(brainstormRun.stdout, /Mode: converge/);
    assert.match(brainstormRun.stdout, /Converged directions:/);
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('CLI can load defaults from config.json', async () => {
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-config-corpus-'));
  const configuredHome = path.join(tempCorpusRoot, '.configured-home');

  try {
    for (const fileName of [
      'retrieval-augmented-experiment-planning.md',
      'graph-augmented-literature-mapping.md'
    ]) {
      await fs.copyFile(
        path.join(examplesRoot, fileName),
        path.join(tempCorpusRoot, fileName)
      );
    }

    await fs.writeFile(path.join(tempCorpusRoot, 'config.json'), `${JSON.stringify({
      storage: {
        home: '.configured-home'
      },
      analyze: {
        name: 'configured-papers'
      },
      brainstorm: {
        mode: 'converge',
        hops: 2
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '.', '--force'], {
      cwd: tempCorpusRoot,
      env: process.env
    });

    assert.match(analyzeRun.stdout, /Corpus: configured-papers/);

    const brainstormRun = await execFileAsync('node', [cliPath, 'brainstorm', 'experiment planning'], {
      cwd: tempCorpusRoot,
      env: process.env
    });

    assert.match(brainstormRun.stdout, /Mode: converge/);

    const registry = JSON.parse(await fs.readFile(path.join(configuredHome, 'registry.json'), 'utf8'));
    assert.equal(registry.corpora[0].name, 'configured-papers');
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
  }
});

test('CLI can analyze PDFs with paddleocr-vl selected from config.json', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-paddleocr-vl-'));
  const fakePdfPath = path.join(workspaceRoot, 'paper.pdf');
  const fakePythonPath = path.join(workspaceRoot, 'fake-python.sh');

  try {
    await fs.writeFile(fakePdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'server_url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    --server-url) server_url="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# Configured PaddleOCR-VL\\n\\n## Abstract\\n\\nRemote server: %s\\n" "$server_url" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      sources: {
        inputs: ['.']
      },
      storage: {
        home: '.configured-home',
        indexDir: './index-store'
      },
      analyze: {
        name: 'configured-paddleocr-vl',
        pdfParser: 'paddleocr-vl',
        paddleocrVlPython: './fake-python.sh',
        paddleocrVlServerUrl: 'http://127.0.0.1:8080/v1'
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: process.env
    });
    assert.match(analyzeRun.stdout, /Corpus: configured-paddleocr-vl/);

    const statusRun = await execFileAsync('node', [cliPath, 'status'], {
      cwd: workspaceRoot,
      env: process.env
    });
    assert.match(statusRun.stdout, /PDF parser: paddleocr-vl/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI imports status and running report local queue progress directly from the corpus store', async () => {
  const fixture = await createImportQueueFixture('papernexus-cli-import-status');

  try {
    const statusRun = await execFileAsync('node', [cliPath, 'imports', 'status', '--corpus', fixture.corpusName], {
      cwd: projectRoot,
      env: fixture.env
    });

    assert.match(statusRun.stdout, new RegExp(`Import queue for ${fixture.corpusName}`));
    assert.match(statusRun.stdout, /Summary: 3 total, 1 pending, 1 running, 0 completed, 1 failed/);
    assert.match(statusRun.stdout, new RegExp(fixture.runningTask.id));
    assert.match(statusRun.stdout, new RegExp(fixture.pendingTask.id));
    assert.match(statusRun.stdout, new RegExp(fixture.failedTask.id));

    const runningRun = await execFileAsync('node', [cliPath, 'imports', 'running', '--corpus', fixture.corpusName], {
      cwd: projectRoot,
      env: fixture.env
    });

    assert.match(runningRun.stdout, new RegExp(`Running import tasks for ${fixture.corpusName}`));
    assert.match(runningRun.stdout, new RegExp(fixture.runningTask.id));
    assert.match(runningRun.stdout, /semantic extraction/);
    assert.doesNotMatch(runningRun.stdout, new RegExp(fixture.pendingTask.id));
  } finally {
    await fs.rm(fixture.tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(fixture.tempHome, { recursive: true, force: true });
  }
});

test('CLI imports log can default to the active task and tail the task log', async () => {
  const fixture = await createImportQueueFixture('papernexus-cli-import-log');

  try {
    const logRun = await execFileAsync('node', [cliPath, 'imports', 'log', '--corpus', fixture.corpusName, '--tail', '1'], {
      cwd: projectRoot,
      env: fixture.env
    });

    assert.match(logRun.stdout, new RegExp(`Import log for ${fixture.runningTask.id}`));
    assert.match(logRun.stdout, /semantic batch completed/);
    assert.doesNotMatch(logRun.stdout, /semantic batch started/);
  } finally {
    await fs.rm(fixture.tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(fixture.tempHome, { recursive: true, force: true });
  }
});

test('CLI defaults to markitdown for configured PDF analyze runs', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-markitdown-'));
  const fakePdfPath = path.join(workspaceRoot, 'paper.pdf');
  const fakePythonPath = path.join(workspaceRoot, 'fake-python.sh');

  try {
    await fs.writeFile(fakePdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# Configured MarkItDown\\n\\n## Abstract\\n\\nConfigured parser output.\\n" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      sources: {
        inputs: ['.']
      },
      storage: {
        home: '.configured-home',
        indexDir: './index-store'
      },
      analyze: {
        name: 'configured-markitdown',
        pythonCommand: './fake-python.sh'
      },
      llm: {
        provider: 'openai',
        model: 'qwen-vl-max',
        baseUrl: 'https://dashscope.example/v1',
        apiKey: 'test-key'
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: process.env
    });
    assert.match(analyzeRun.stdout, /Corpus: configured-markitdown/);

    const statusRun = await execFileAsync('node', [cliPath, 'status'], {
      cwd: workspaceRoot,
      env: process.env
    });
    assert.match(statusRun.stdout, /PDF parser: markitdown/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI test-pdf-config reuses the standalone PDF config probe script', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-test-pdf-config-'));
  const fakePdfPath = path.join(workspaceRoot, 'paper.pdf');
  const fakePythonPath = path.join(workspaceRoot, 'fake-python.sh');

  try {
    await fs.writeFile(fakePdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'server_url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    --server-url) server_url="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# Config Test\\n\\n## Abstract\\n\\nRemote server: %s\\n" "$server_url" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      analyze: {
        pdfParser: 'paddleocr-vl',
        paddleocrVlPython: './fake-python.sh',
        paddleocrVlServerUrl: 'http://127.0.0.1:8080/v1'
      }
    }, null, 2)}\n`);

    const probeRun = await execFileAsync('node', [cliPath, 'test-pdf-config', 'paper.pdf', '--force', '--json'], {
      cwd: workspaceRoot,
      env: process.env
    });

    const payload = JSON.parse(probeRun.stdout);
    assert.equal(payload.result.parser, 'paddleocr-vl');
    assert.equal(payload.result.generated, true);
    assert.match(payload.result.markdownPath, /paddleocr-vl/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI test-pdf-config can run firecrawl through config.json', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-firecrawl-pdf-config-'));
  const fakePdfPath = path.join(workspaceRoot, 'paper.pdf');
  const server = await startFirecrawlServer(async (request, response, requests) => {
    const body = await readRequestBody(request);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: body.toString('utf8')
    });
    writeJson(response, 200, {
      success: true,
      data: {
        markdown: '# CLI Firecrawl\n\nFirecrawl markdown from CLI wrapper.'
      }
    });
  });

  try {
    await fs.writeFile(fakePdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      analyze: {
        pdfParser: 'firecrawl',
        firecrawlApiBaseUrl: server.baseUrl,
        firecrawlApiKeyEnv: 'PAPERNEXUS_TEST_CLI_FIRECRAWL_KEY',
        firecrawlMode: 'fast'
      }
    }, null, 2)}\n`);

    const probeRun = await execFileAsync('node', [cliPath, 'test-pdf-config', 'paper.pdf', '--force', '--json'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PAPERNEXUS_TEST_CLI_FIRECRAWL_KEY: 'test-cli-firecrawl-key'
      }
    });

    const payload = JSON.parse(probeRun.stdout);
    assert.equal(payload.config.parser, 'firecrawl');
    assert.equal(payload.result.parser, 'firecrawl');
    assert.match(payload.result.markdownPath, /firecrawl/);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].url, '/v2/parse');
    assert.equal(server.requests[0].headers.authorization, 'Bearer test-cli-firecrawl-key');
    assert.match(server.requests[0].body, /"mode":"fast"/);
  } finally {
    await server.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI scrub-degenerate-papers removes degenerate graph sources and purges missing backing files', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-scrub-degenerate-'));
  const badPdfPath = path.join(workspaceRoot, 'bad-paper.pdf');
  const goodMarkdownPath = path.join(workspaceRoot, 'good-paper.md');
  const fakeDoclingPath = path.join(workspaceRoot, 'fake-docling.sh');

  try {
    await fs.writeFile(badPdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(goodMarkdownPath, '# Good Paper\n\n## Abstract\n\nKeep me.\n', 'utf8');
    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'pdf_path="$1"',
        'out_dir=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) out_dir="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$out_dir"',
        'base="$(basename "$pdf_path" .pdf)"',
        'cat > "$out_dir/$base.md" <<\'EOF\'',
        '## Abstract',
        '',
        'Degenerate parser output.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      sources: {
        inputs: ['.']
      },
      storage: {
        home: '.configured-home',
        indexDir: './index-store'
      },
      analyze: {
        name: 'degenerate-scrub-test',
        pdfParser: 'docling',
        doclingCommand: './fake-docling.sh'
      }
    }, null, 2)}\n`);

    await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: process.env
    });

    const corpusStore = await import('../src/storage/corpus-store.js');
    const manifestBefore = await corpusStore.loadSourceManifest(path.join(workspaceRoot, 'index-store'));
    const degenerateEntry = manifestBefore.sources.find((entry) => path.basename(entry.inputPath) === 'bad-paper.pdf');
    assert.ok(degenerateEntry, 'expected the degenerate PDF source to be tracked before scrubbing');
    assert.ok(await fs.stat(corpusStore.getSemanticPaperSnapshotPath(path.join(workspaceRoot, 'index-store'), degenerateEntry.sourceKey)));

    await fs.rm(badPdfPath, { force: true });

    const scrubRun = await execFileAsync('node', [cliPath, 'scrub-degenerate-papers'], {
      cwd: workspaceRoot,
      env: process.env
    });

    assert.match(scrubRun.stdout, /Removed 1 degenerate source/);
    assert.match(scrubRun.stdout, /Purged 1 missing source/);

    const manifestAfter = await corpusStore.loadSourceManifest(path.join(workspaceRoot, 'index-store'));
    assert.equal(manifestAfter.sources.length, 1);
    assert.equal(path.basename(manifestAfter.sources[0].inputPath), 'good-paper.md');

    const metaAfter = await corpusStore.loadCorpusMeta(path.join(workspaceRoot, 'index-store'));
    assert.equal(metaAfter.paperCount, 1);
    await assert.rejects(fs.access(corpusStore.getSemanticPaperSnapshotPath(path.join(workspaceRoot, 'index-store'), degenerateEntry.sourceKey)));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI can analyze multiple configured source directories from config.json', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-multi-source-'));
  const inputA = path.join(workspaceRoot, 'papers-a');
  const inputB = path.join(workspaceRoot, 'papers-b');

  try {
    await fs.mkdir(inputA, { recursive: true });
    await fs.mkdir(inputB, { recursive: true });

    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputA, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.copyFile(
      path.join(examplesRoot, 'graph-augmented-literature-mapping.md'),
      path.join(inputB, 'graph-augmented-literature-mapping.md')
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      storage: {
        home: '.configured-home'
      },
      sources: {
        inputs: ['./papers-a', './papers-b']
      },
      analyze: {
        name: 'multi-source-papers'
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: process.env
    });

    assert.match(analyzeRun.stdout, /Corpus: multi-source-papers/);
    assert.match(analyzeRun.stdout, /Papers: 2/);

    const statusRun = await execFileAsync('node', [cliPath, 'status'], {
      cwd: workspaceRoot,
      env: process.env
    });

    const meta = JSON.parse(await fs.readFile(path.join(workspaceRoot, '.papernexus', 'meta.json'), 'utf8'));
    assert.match(statusRun.stdout, new RegExp(`Root: .*${path.basename(meta.rootPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(meta.paperCount, 2);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI can write the corpus index under storage.indexDir', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-index-dir-'));
  const inputA = path.join(workspaceRoot, 'papers-a');
  const inputB = path.join(workspaceRoot, 'papers-b');
  const indexRoot = path.join(workspaceRoot, 'index-store');

  try {
    await fs.mkdir(inputA, { recursive: true });
    await fs.mkdir(inputB, { recursive: true });

    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputA, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.copyFile(
      path.join(examplesRoot, 'graph-augmented-literature-mapping.md'),
      path.join(inputB, 'graph-augmented-literature-mapping.md')
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      storage: {
        home: '.configured-home',
        indexDir: './index-store'
      },
      sources: {
        inputs: ['./papers-a', './papers-b']
      },
      analyze: {
        name: 'stored-elsewhere'
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: process.env
    });

    assert.match(analyzeRun.stdout, /Indexed corpus "stored-elsewhere" at /);
    await fs.access(path.join(indexRoot, '.papernexus', 'meta.json'));
    const { resolveGraphStorageMode } = await import('../src/storage/corpus-store.js');
    await fs.access(path.join(
      indexRoot,
      '.papernexus',
      (await resolveGraphStorageMode()) === 'kuzu+lite-index' ? 'graph.kuzu' : 'graph.json'
    ));

    await assert.rejects(fs.access(path.join(workspaceRoot, '.papernexus', 'meta.json')));

    const statusRun = await execFileAsync('node', [cliPath, 'status'], {
      cwd: workspaceRoot,
      env: process.env
    });
    assert.match(statusRun.stdout, new RegExp(`Root: .*${path.basename(indexRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI backup-export defaults to ~/.papernexus/backups and backup-unpack prints stage banners', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-backup-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-backup-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const unpackRoot = path.join(workspaceRoot, 'unpacked');

  try {
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const env = {
      ...process.env,
      PAPERNEXUS_HOME: tempHome
    };

    await execFileAsync('node', [
      cliPath,
      'analyze',
      '--no-config=true',
      inputRoot,
      '--name',
      'cli-backup-papers',
      '--force'
    ], {
      cwd: projectRoot,
      env
    });

    const exportRun = await execFileAsync('node', [
      cliPath,
      'backup-export',
      '--no-config=true',
      '--corpus',
      'cli-backup-papers'
    ], {
      cwd: projectRoot,
      env
    });

    assert.match(exportRun.stdout, /Stage 1\/1: Exporting backup archive/);
    assert.match(exportRun.stdout, /Exported backup archive to/);
    const archivePathMatch = exportRun.stdout.match(/Exported backup archive to (.+)\n/);
    assert.ok(archivePathMatch, 'expected backup-export to print the generated archive path');
    const archivePath = archivePathMatch[1].trim();
    assert.match(archivePath, new RegExp(`${tempHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}backups`));
    await fs.access(archivePath);

    const unpackRun = await execFileAsync('node', [
      cliPath,
      'backup-unpack',
      '--no-config=true',
      archivePath,
      '--output',
      unpackRoot
    ], {
      cwd: projectRoot,
      env
    });

    assert.match(unpackRun.stdout, /Stage 1\/1: Unpacking backup archive/);
    assert.match(unpackRun.stdout, /Unpacked backup archive to/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('CLI expands tilde-prefixed storage.indexDir to the user home directory', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-tilde-index-'));
  const papersRoot = path.join(workspaceRoot, 'papers');
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-home-tilde-'));
  const indexRoot = path.join(fakeHome, '.papernexus', 'index-store');

  try {
    await fs.mkdir(papersRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(papersRoot, 'retrieval-augmented-experiment-planning.md')
    );

    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      storage: {
        indexDir: '~/.papernexus/index-store'
      },
      sources: {
        inputs: ['./papers']
      },
      analyze: {
        name: 'tilde-index'
      }
    }, null, 2)}\n`);

    const analyzeRun = await execFileAsync('node', [cliPath, 'analyze', '--force'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        HOME: fakeHome
      }
    });

    assert.match(analyzeRun.stdout, new RegExp(indexRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await fs.access(path.join(indexRoot, '.papernexus', 'meta.json'));
    await assert.rejects(fs.access(path.join(workspaceRoot, '~', '.papernexus', 'index-store', '.papernexus', 'meta.json')));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});

test('CLI logs watch prints the tmp watch log path and contents', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-logs-watch-'));

  try {
    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      storage: {
        indexDir: './index-store'
      }
    }, null, 2)}\n`);

    const firstLogsRun = await execFileAsync('node', [cliPath, 'logs', 'watch'], {
      cwd: workspaceRoot,
      env: process.env
    });

    const reportedLogPath = firstLogsRun.stdout
      .split('\n')
      .find((line) => line.startsWith('Watch log: '))
      ?.replace('Watch log: ', '')
      .trim();

    assert.ok(reportedLogPath);
    assert.match(reportedLogPath, /papernexus-watch-.*\.log$/);

    await fs.writeFile(reportedLogPath, '[2026-03-25T00:00:00.000Z] [info] [watch] Reindexed "demo"\n', 'utf8');

    const logsRun = await execFileAsync('node', [cliPath, 'logs', 'watch'], {
      cwd: workspaceRoot,
      env: process.env
    });

    assert.match(logsRun.stdout, /Watch log: .*papernexus-watch-.*\.log/);
    assert.match(logsRun.stdout, /\[watch\] Reindexed "demo"/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI auth llm set can switch an existing Qwen config to a DeepSeek key binding', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-auth-'));
  const binDir = path.join(workspaceRoot, 'bin');
  const storePath = path.join(workspaceRoot, 'fake-keychain.json');

  try {
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'config.json'), `${JSON.stringify({
      llm: {
        provider: 'openai',
        model: 'qwen-plus',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1'
      }
    }, null, 2)}\n`);
    await fs.writeFile(path.join(binDir, 'security'), `#!/usr/bin/env node
const fs = require('node:fs');
const storePath = process.env.FAKE_SECURITY_STORE;
const args = process.argv.slice(2);
const command = args.shift();
let service = '';
let account = '';
let password = '';
let wantsOutput = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '-s') {
    service = args[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg === '-a') {
    account = args[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg === '-w') {
    if (command === 'find-generic-password') {
      wantsOutput = true;
    } else {
      password = args[index + 1] || '';
      index += 1;
    }
  }
}

const key = service + '|' + account;
const store = fs.existsSync(storePath)
  ? JSON.parse(fs.readFileSync(storePath, 'utf8'))
  : {};

if (command === 'add-generic-password') {
  store[key] = password;
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\\n');
  process.exit(0);
}

if (command === 'find-generic-password') {
  if (!Object.prototype.hasOwnProperty.call(store, key)) {
    console.error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    process.exit(44);
  }
  if (wantsOutput) {
    process.stdout.write(String(store[key]));
  }
  process.exit(0);
}

if (command === 'delete-generic-password') {
  delete store[key];
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\\n');
  process.exit(0);
}

process.exit(0);
`);
    await fs.chmod(path.join(binDir, 'security'), 0o755);

    const authRun = await spawnCli(['auth', 'llm', 'set', '--provider', 'deepseek', '--stdin'], {
      cwd: workspaceRoot,
	      env: {
	        ...process.env,
	        PATH: `${binDir}:${process.env.PATH}`,
	        FAKE_SECURITY_STORE: storePath,
	        PAPERNEXUS_HOME: workspaceRoot
	      },
      stdin: 'deepseek-test-key\n'
    });

    assert.equal(authRun.code, 0, authRun.stderr);
    assert.match(authRun.stdout, /Stored API key securely for deepseek/);

    const savedConfig = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8'));
    assert.equal(savedConfig.llm.provider, 'deepseek');
    assert.equal(savedConfig.llm.model, 'deepseek-v4-flash');
    assert.equal(savedConfig.llm.baseUrl, 'https://api.deepseek.com');
    assert.equal(savedConfig.llm.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(savedConfig.llm.apiKeySource, 'keychain');
    assert.equal(savedConfig.llm.apiKeyService, 'papernexus.llm');
    assert.equal(savedConfig.llm.apiKeyAccount, 'deepseek:https://api.deepseek.com');

    const fakeKeychain = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(
      fakeKeychain['papernexus.llm|deepseek:https://api.deepseek.com'],
      'deepseek-test-key'
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI init creates a first-run config.json from interactive answers', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-init-'));
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-init-home-'));

  try {
    const initRun = await spawnCli(['init', '--no-config=true'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PAPERNEXUS_HOME: tempHome
      },
      stdin: [
        './papers',
        'first-run-corpus',
        './index-store',
        'y',
        '2',
        'qwen-plus',
        'https://coding.dashscope.aliyuncs.com/v1',
        'y',
        'n'
      ].join('\n') + '\n'
    });

    assert.equal(initRun.code, 0, initRun.stderr);
    assert.match(initRun.stdout, /Saved PaperNexus config to/);
    assert.match(initRun.stdout, /Next: run `papernexus analyze` to build the first index/);
    assert.doesNotMatch(initRun.stdout, /Next: run `papernexus analyze --force`/);
    assert.match(initRun.stdout, /Step 1: Paper Sources/);
    assert.match(initRun.stdout, /Step 3: Index Directory/);
    assert.match(initRun.stdout, /stores its generated index data/i);

    const savedConfig = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8'));
    assert.deepEqual(savedConfig.sources.inputs, ['./papers']);
    assert.equal(savedConfig.analyze.name, 'first-run-corpus');
    assert.equal(savedConfig.analyze.pdfParser, 'markitdown');
    assert.equal(savedConfig.global.corpus, 'first-run-corpus');
    assert.equal(savedConfig.storage.indexDir, './index-store');
    assert.equal(savedConfig.serve.host, '127.0.0.1');
    assert.equal(savedConfig.serve.port, 4821);
    assert.equal(savedConfig.llm.provider, 'openai');
    assert.equal(savedConfig.llm.model, 'qwen-plus');
    assert.equal(savedConfig.llm.baseUrl, 'https://coding.dashscope.aliyuncs.com/v1');
    assert.equal(savedConfig.llm.relations, true);
    assert.equal(savedConfig.llm.apiKeyEnv, 'OPENAI_API_KEY');
    assert.equal(savedConfig.llm.apiKeySource, undefined);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('CLI warns that --force is for deliberate full rebuilds', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-force-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-force-corpus-'));

  try {
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const env = {
      ...process.env,
      PAPERNEXUS_HOME: tempHome
    };

    const analyzeRun = await execFileAsync('node', [
      cliPath,
      'analyze',
      '--no-config=true',
      tempCorpusRoot,
      '--name',
      'force-warning-test',
      '--force'
    ], {
      cwd: projectRoot,
      env
    });

    assert.match(
      analyzeRun.stderr,
      /Warning: `--force` is intended for deliberate full rebuilds/
    );
    assert.match(
      analyzeRun.stderr,
      /Prefer plain `papernexus analyze` or `--continue` for routine updates/
    );
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('CLI stage commands print a stage banner even when stdout is not a TTY', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-stage-banner-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-stage-banner-corpus-'));

  try {
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const env = {
      ...process.env,
      PAPERNEXUS_HOME: tempHome
    };

    await execFileAsync('node', [
      cliPath,
      'materialize',
      '--no-config=true',
      tempCorpusRoot,
      '--name',
      'stage-banner-test'
    ], {
      cwd: projectRoot,
      env
    });

    const buildGraphRun = await execFileAsync('node', [
      cliPath,
      'stage3',
      '--no-config=true',
      tempCorpusRoot,
      '--name',
      'stage-banner-test'
    ], {
      cwd: projectRoot,
      env
    });

    assert.match(buildGraphRun.stdout, /Stage 1\/1: Building graph structure/);
    assert.match(buildGraphRun.stdout, /Built staged graph for "stage-banner-test"/);
  } finally {
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('CLI stage command --help prints help text instead of executing the stage', async () => {
  const helpRun = await execFileAsync('node', [cliPath, 'stage3', '--help'], {
    cwd: projectRoot,
    env: process.env
  });

  assert.match(helpRun.stdout, /PaperNexus/);
  assert.match(helpRun.stdout, /papernexus stage3/);
  assert.doesNotMatch(helpRun.stdout, /Stage 1\/1: Building graph structure/);
});
