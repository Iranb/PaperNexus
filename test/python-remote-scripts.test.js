import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const examplesRoot = path.join(repoRoot, 'examples');

async function runPython(scriptName, args = [], options = {}) {
  const scriptPath = path.join(repoRoot, 'scripts', scriptName);
  const { stdout, stderr } = await execFileAsync('python3', [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

async function createImportFixture() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-remote-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-remote-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const uploadRoot = path.join(workspaceRoot, 'uploads');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;
  process.env.PAPERNEXUS_HOME = tempHome;

  await fs.mkdir(inputRoot, { recursive: true });
  await fs.mkdir(uploadRoot, { recursive: true });
  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(path.join(examplesRoot, fileName), path.join(inputRoot, fileName));
  }

  const [ingestion, enhancements] = await Promise.all([
    import('../src/core/ingestion/pipeline.js'),
    import('../src/core/enhancements/worker.js')
  ]);

  await ingestion.analyzeCorpus(inputRoot, {
    rootPath: indexRoot,
    name: 'python-remote-test',
    force: true
  });

  await enhancements.runEnhancementQueueUntilIdle(indexRoot, {
    maxPasses: 8,
    backfillLimit: 2
  });

  const markdownUploadPath = path.join(uploadRoot, 'server-side-upload.md');
  await fs.writeFile(
    markdownUploadPath,
    '# Remote Script Upload\n\n## Abstract\n\nUploaded through the Python remote scripts.\n',
    'utf8'
  );

  return {
    tempHome,
    workspaceRoot,
    inputRoot,
    uploadRoot,
    indexRoot,
    markdownUploadPath,
    previousHome
  };
}

async function cleanupFixture(fixture) {
  if (fixture.previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = fixture.previousHome;
  await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
}

async function startServer(fixture, port, options = {}) {
  const { serveCommand } = await import('../src/server/http.js');
  return serveCommand({
    host: '127.0.0.1',
    port,
    apiToken: 'secret-token',
    enableEnhancements: false,
    enableImports: options.enableImports ?? true,
    importIntervalMs: 200,
    config: {
      storage: {
        indexDir: fixture.indexRoot
      },
      serve: {
        apiToken: 'secret-token'
      }
    },
    configBaseDir: fixture.workspaceRoot
  });
}

test('pn_stage_sync.py stages files through ssh + rsync and reports remote paths', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-stage-'));
  const fakeBin = path.join(tempDir, 'bin');
  const callsDir = path.join(tempDir, 'calls');
  const localDir = path.join(tempDir, 'local');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(callsDir, { recursive: true });
  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(path.join(localDir, 'paper.md'), '# Demo\n', 'utf8');

  await fs.writeFile(path.join(fakeBin, 'ssh'), `#!/bin/sh
printf '%s\n' "$@" > "${path.join(callsDir, 'ssh.txt')}"
exit 0
`, { mode: 0o755 });

  await fs.writeFile(path.join(fakeBin, 'rsync'), `#!/bin/sh
printf '%s\n' "$@" > "${path.join(callsDir, 'rsync.txt')}"
exit 0
`, { mode: 0o755 });

  try {
    const result = await runPython('pn_stage_sync.py', [
      '--json',
      '--ssh-target', 'hyq@example.com',
      '--remote-dir', '/tmp/papernexus-import-staging/demo',
      localDir
    ], {
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ''}`
      }
    });

    const payload = JSON.parse(result.stdout);
    assert.equal(payload.remoteDir, '/tmp/papernexus-import-staging/demo');
    assert.equal(payload.remoteFiles.length, 1);
    assert.match(payload.remoteFiles[0], /paper\.md$/);
    const sshArgs = await fs.readFile(path.join(callsDir, 'ssh.txt'), 'utf8');
    const rsyncArgs = await fs.readFile(path.join(callsDir, 'rsync.txt'), 'utf8');
    assert.match(sshArgs, /mkdir -p/);
    assert.match(rsyncArgs, /--partial/);
    assert.match(rsyncArgs, /hyq@example\.com:\/tmp\/papernexus-import-staging\/demo/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pn_import_submit.py and pn_import_queue.py submit a server-side file and wait for completion', async () => {
  const fixture = await createImportFixture();
  const port = 54000 + Math.floor(Math.random() * 500);

  try {
    const server = await startServer(fixture, port, { enableImports: true });
    try {
      const submit = await runPython('pn_import_submit.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        '--server-file-path', fixture.markdownUploadPath
      ]);
      const submitted = JSON.parse(submit.stdout);
      assert.equal(submitted.task.status, 'pending');
      assert.ok(submitted.task.id);

      const wait = await runPython('pn_import_queue.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'wait',
        submitted.task.id,
        '--timeout', '30',
        '--interval', '0.2'
      ]);
      const waited = JSON.parse(wait.stdout);
      assert.equal(waited.task.status, 'completed');
      assert.equal(waited.task.stage, 'completed');
      assert.ok(waited.task.result.fastCommitted.paperCount >= 2);

      const status = await runPython('pn_import_queue.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'status',
        submitted.task.id
      ]);
      const statusPayload = JSON.parse(status.stdout);
      assert.equal(statusPayload.task.id, submitted.task.id);

      const log = await runPython('pn_import_queue.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'log',
        submitted.task.id
      ]);
      const logPayload = JSON.parse(log.stdout);
      assert.match(logPayload.log, /stage materialize|completed import task/i);
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test('pn_graph_query.py exposes query and brainstorm through the remote API', async () => {
  const fixture = await createImportFixture();
  const port = 54500 + Math.floor(Math.random() * 500);

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const query = await runPython('pn_graph_query.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'query',
        'experiment planning',
        '--limit', '5'
      ]);
      const queryPayload = JSON.parse(query.stdout);
      assert.equal(queryPayload.result.query, 'experiment planning');
      assert.ok(queryPayload.result.groups.length > 0);

      const brainstorm = await runPython('pn_graph_query.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'brainstorm',
        'experiment planning',
        '--mode', 'converge',
        '--limit', '5',
        '--max-hops', '2'
      ]);
      const brainstormPayload = JSON.parse(brainstorm.stdout);
      assert.equal(brainstormPayload.result.mode, 'converge');
      assert.ok(brainstormPayload.result.convergedDirections.length > 0);
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test('pn_research_chains.py exposes evidence, reflection, and brief endpoints through the remote API', async () => {
  const fixture = await createImportFixture();
  const port = 55000 + Math.floor(Math.random() * 500);

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const evidence = await runPython('pn_research_chains.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'evidence-chain',
        'experiment planning',
        '--limit', '3'
      ]);
      const evidencePayload = JSON.parse(evidence.stdout);
      assert.ok(evidencePayload.result.chains.length > 0);

      const reflection = await runPython('pn_research_chains.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'reflection-chain',
        'experiment planning',
        '--limit', '3'
      ]);
      const reflectionPayload = JSON.parse(reflection.stdout);
      assert.ok(reflectionPayload.result.chains.length > 0);

      const researchBrief = await runPython('pn_research_chains.py', [
        '--json',
        '--api-base', `http://127.0.0.1:${port}`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'research-brief',
        'experiment planning',
        '--limit', '3'
      ]);
      const briefPayload = JSON.parse(researchBrief.stdout);
      assert.ok(briefPayload.result.querySummary.groups.length > 0);
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});
