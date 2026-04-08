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
const skillRoot = path.join(repoRoot, 'SKILL');

async function runPython(scriptName, args = [], options = {}) {
  const scriptPath = path.join(repoRoot, 'scripts', scriptName);
  return runPythonPath(scriptPath, args, options);
}

async function runPythonPath(scriptPath, args = [], options = {}) {
  const { stdout, stderr } = await execFileAsync('python3', [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAPERNEXUS_ALLOW_LOCAL_MCP: '1',
      ...(options.env || {})
    }
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim()
  };
}

function getSkillScriptPath(...segments) {
  return path.join(skillRoot, ...segments);
}

test('PaperNexus skill scripts live under skill directories and skills do not point agents at top-level scripts', async () => {
  const canonicalSkillScripts = [
    ['PaperNexusMainGraphName', 'scripts', 'pn_main_graph_name.py'],
    ['PaperNexus', 'scripts', 'pn_common.py'],
    ['PaperNexus', 'scripts', 'pn_stage_sync.py'],
    ['PaperNexus', 'scripts', 'pn_import_submit.py'],
    ['PaperNexus', 'scripts', 'pn_import_queue.py'],
    ['PaperNexus', 'scripts', 'pn_graph_query.py'],
    ['PaperNexus', 'scripts', 'pn_research_chains.py'],
    ['PaperNexus', 'scripts', 'pn_batch_import.py'],
  ];
  const localEntryPoints = [
    ['PaperNexusAgenticReasoning', 'scripts', 'pn_import_submit.py'],
    ['PaperNexusAgenticReasoning', 'scripts', 'pn_batch_import.py'],
    ['PaperNexusAgenticReasoning', 'scripts', 'pn_stage_sync.py'],
    ['PaperNexusAgenticReasoning', 'scripts', 'pn_graph_query.py'],
    ['PaperNexusAgenticReasoning', 'scripts', 'pn_research_chains.py'],
    ['PaperNexusBatchImport', 'scripts', 'pn_batch_import.py'],
    ['PaperNexusReflection', 'scripts', 'pn_batch_import.py'],
    ['PaperNexusReflection', 'scripts', 'pn_stage_sync.py'],
    ['PaperNexusReflection', 'scripts', 'pn_import_submit.py'],
    ['PaperNexusReflection', 'scripts', 'pn_import_queue.py'],
    ['PaperNexusReflection', 'scripts', 'pn_research_chains.py'],
    ['PaperNexusResearchChains', 'scripts', 'pn_graph_query.py'],
    ['PaperNexusResearchChains', 'scripts', 'pn_research_chains.py'],
  ];

  for (const segments of [...canonicalSkillScripts, ...localEntryPoints]) {
    await fs.access(getSkillScriptPath(...segments));
  }

  for (const skillDoc of [
    'PaperNexusMainGraphName/SKILL.md',
    'PaperNexus/SKILL.md',
    'PaperNexusAgenticReasoning/SKILL.md',
    'PaperNexusBatchImport/SKILL.md',
    'PaperNexusReflection/SKILL.md',
    'PaperNexusResearchChains/SKILL.md',
  ]) {
    const text = await fs.readFile(getSkillScriptPath(skillDoc), 'utf8');
    assert.doesNotMatch(text, /\bpython3 scripts\/pn_/);
  }
});

test('pn_main_graph_name.py resolves the current live corpus name over remote HTTP MCP', async () => {
  const fixture = await createImportFixture();
  const port = 56200 + Math.floor(Math.random() * 500);
  const scriptPath = path.join(repoRoot, 'SKILL', 'PaperNexusMainGraphName', 'scripts', 'pn_main_graph_name.py');

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const result = await runPythonPath(scriptPath, [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
      ]);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.primaryGraphName, 'python-remote-test');
      assert.equal(payload.resolvedBy, 'single-remote-corpus');
      assert.ok(Array.isArray(payload.availableCorpora));
      assert.ok(payload.availableCorpora.includes('python-remote-test'));
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});

test('PaperNexusIdeaCatalyst exposes exactly one canonical skill file and one canonical scripts directory', async () => {
  const catalystRoot = path.join(skillRoot, 'PaperNexusIdeaCatalyst');
  const entries = await fs.readdir(catalystRoot, { withFileTypes: true });
  const skillFiles = entries.filter((entry) => entry.isFile() && /^SKILL.*\.md$/.test(entry.name)).map((entry) => entry.name).sort();
  const scriptDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('scripts')).map((entry) => entry.name).sort();

  assert.deepEqual(skillFiles, ['SKILL.md']);
  assert.deepEqual(scriptDirs, ['scripts']);

  await fs.access(path.join(catalystRoot, 'SKILL.md'));
  await fs.access(path.join(catalystRoot, 'scripts', 'pn_idea_catalyst.py'));
});

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
        apiToken: 'secret-token',
        mcp: {
          enabled: true
        }
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

test('pn_stage_sync.py supports corpus-root compatibility args without requiring a corpus name', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-stage-compat-'));
  const fakeBin = path.join(tempDir, 'bin');
  const callsDir = path.join(tempDir, 'calls');
  const localDir = path.join(tempDir, 'literature');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(callsDir, { recursive: true });
  await fs.mkdir(localDir, { recursive: true });
  await fs.writeFile(path.join(localDir, '2305.18909.md'), '# Demo\n', 'utf8');

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
      '--corpus-root', localDir,
      '--mode', 'incremental'
    ], {
      env: {
        PATH: `${fakeBin}:${process.env.PATH || ''}`,
        PAPERNEXUS_REMOTE_STAGING_ROOT: '/tmp/papernexus-import-staging'
      }
    });

    const payload = JSON.parse(result.stdout);
    assert.match(payload.remoteDir, /^\/tmp\/papernexus-import-staging\//);
    assert.equal(payload.fileCount, 1);
    assert.match(payload.remoteFiles[0], /2305\.18909\.md$/);
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
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        '--server-file-path', fixture.markdownUploadPath
      ]);
      const submitted = JSON.parse(submit.stdout);
      assert.equal(submitted.task.status, 'pending');
      assert.ok(submitted.task.id);

      const wait = await runPython('pn_import_queue.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        'status',
        submitted.task.id
      ]);
      const statusPayload = JSON.parse(status.stdout);
      assert.equal(statusPayload.task.id, submitted.task.id);

      const log = await runPython('pn_import_queue.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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

test('pn_import_submit.py records task ids in a temp registry and pn_import_queue.py can resolve status by paper-id', async () => {
  const fixture = await createImportFixture();
  const port = 55200 + Math.floor(Math.random() * 500);
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-registry-'));
  const registryPath = path.join(registryDir, 'task-registry.json');

  try {
    const server = await startServer(fixture, port, { enableImports: true });
    try {
      const submit = await runPython('pn_import_submit.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--paper-id', '2305.18909',
        '--source', fixture.markdownUploadPath,
        '--source-kind', 'markdown'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const submitted = JSON.parse(submit.stdout);
      assert.equal(submitted.paperId, '2305.18909');
      assert.equal(submitted.synced, false);
      assert.ok(submitted.task.id);
      assert.equal(submitted.registry.path, registryPath);

      const registryPayload = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      assert.ok(Array.isArray(registryPayload.tasks));
      assert.equal(registryPayload.tasks[0].paperId, '2305.18909');
      assert.equal(registryPayload.tasks[0].taskId, submitted.task.id);

      const status = await runPython('pn_import_queue.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--paper-id', '2305.18909',
        '--status'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const statusPayload = JSON.parse(status.stdout);
      assert.equal(statusPayload.paperId, '2305.18909');
      assert.equal(statusPayload.task.id, submitted.task.id);
      assert.equal(statusPayload.registry.matchedBy, 'paper-id');

      const wait = await runPython('pn_import_queue.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        'wait',
        '--paper-id', '2305.18909',
        '--timeout', '30',
        '--interval', '0.2'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const waitPayload = JSON.parse(wait.stdout);
      assert.equal(waitPayload.task.status, 'completed');

      const refreshedRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      assert.equal(refreshedRegistry.tasks[0].status, 'completed');
      assert.equal(refreshedRegistry.tasks[0].paperId, '2305.18909');
      assert.ok(refreshedRegistry.tasks[0].finishedAt);
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test('pn_graph_query.py exposes query and brainstorm through remote HTTP MCP', async () => {
  const fixture = await createImportFixture();
  const port = 54500 + Math.floor(Math.random() * 500);

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const query = await runPython('pn_graph_query.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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

test('pn_batch_import.py submits a JSON manifest and supports batch wait/status', async () => {
  const fixture = await createImportFixture();
  const port = 55600 + Math.floor(Math.random() * 500);
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-py-batch-registry-'));
  const registryPath = path.join(registryDir, 'task-registry.json');
  const secondUploadPath = path.join(fixture.uploadRoot, 'second-upload.md');
  const manifestPath = path.join(fixture.uploadRoot, 'batch-import.json');

  try {
    await fs.writeFile(
      secondUploadPath,
      '# Second Upload\n\n## Abstract\n\nA second batch upload for the Python remote scripts.\n',
      'utf8'
    );
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        defaults: {
          corpus: 'python-remote-test'
        },
        papers: [
          {
            paperId: 'batch-paper-1',
            source: fixture.markdownUploadPath,
            sourceKind: 'markdown'
          },
          {
            paperId: 'batch-paper-2',
            source: secondUploadPath,
            sourceKind: 'markdown'
          }
        ]
      }, null, 2),
      'utf8'
    );

    const server = await startServer(fixture, port, { enableImports: true });
    try {
      const submit = await runPython('pn_batch_import.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--manifest', manifestPath,
        'submit'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const submitted = JSON.parse(submit.stdout);
      assert.equal(submitted.summary.total, 2);
      assert.equal(submitted.summary.submitted, 2);
      assert.equal(typeof submitted.summary.overallPercent, 'number');
      assert.equal(submitted.items.length, 2);
      assert.ok(submitted.items.every((item) => item.taskId));
      assert.ok(submitted.items.every((item) => item.progress && item.progress.contractVersion === 'import-progress-v1'));

      const status = await runPython('pn_batch_import.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--manifest', manifestPath,
        'status'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const statusPayload = JSON.parse(status.stdout);
      assert.equal(statusPayload.summary.total, 2);
      assert.equal(typeof statusPayload.summary.overallPercent, 'number');
      assert.ok(statusPayload.summary.remaining >= 0);
      assert.ok(statusPayload.items.every((item) => item.taskId));
      assert.ok(statusPayload.items.every((item) => item.progress && item.progress.contractVersion === 'import-progress-v1'));
      assert.ok(statusPayload.items.every((item) => item.registry.matchedBy === 'paper-id'));

      const wait = await runPython('pn_batch_import.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--manifest', manifestPath,
        'wait',
        '--timeout', '30',
        '--interval', '0.2'
      ], {
        env: {
          PAPERNEXUS_TASK_REGISTRY_PATH: registryPath
        }
      });
      const waited = JSON.parse(wait.stdout);
      assert.equal(waited.summary.total, 2);
      assert.equal(waited.summary.completed, 2);
      assert.equal(waited.summary.overallPercent, 100);
      assert.ok(waited.items.every((item) => item.status === 'completed'));
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
    await fs.rm(registryDir, { recursive: true, force: true });
  }
});

test('pn_batch_import.py template emits the fixed manifest schema', async () => {
  const result = await runPython('pn_batch_import.py', [
    '--json',
    'template'
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.version, 1);
  assert.ok(payload.defaults);
  assert.ok(Array.isArray(payload.papers));
  assert.equal(payload.papers.length, 1);
  assert.equal(typeof payload.papers[0].source, 'string');
});

test('pn_research_chains.py exposes evidence, reflection, and brief endpoints through remote HTTP MCP', async () => {
  const fixture = await createImportFixture();
  const port = 55000 + Math.floor(Math.random() * 500);

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const evidence = await runPython('pn_research_chains.py', [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
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

test('pn_idea_catalyst.py forwards fine-grained domain and bundle mode through remote HTTP MCP', async () => {
  const fixture = await createImportFixture();
  const port = 55800 + Math.floor(Math.random() * 500);
  const scriptPath = path.join(repoRoot, 'SKILL', 'PaperNexusIdeaCatalyst', 'scripts', 'pn_idea_catalyst.py');

  try {
    const server = await startServer(fixture, port, { enableImports: false });
    try {
      const result = await runPythonPath(scriptPath, [
        '--json',
        '--mcp-url', `http://127.0.0.1:${port}/mcp`,
        '--token', 'secret-token',
        '--corpus', 'python-remote-test',
        '--problem', 'experiment planning under retrieval constraints',
        '--target-domain', 'Computer Science',
        '--fine-grained-domain', 'Generalized Category Discovery',
        '--output-mode', 'packet_bundle',
        '--include-analysis',
        '--limit', '5'
      ]);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.request.tool, 'idea_catalyst');
      assert.equal(payload.request.arguments.fineGrainedDomain, 'Generalized Category Discovery');
      assert.equal(payload.request.arguments.outputMode, 'packet_bundle');
      assert.equal(payload.request.arguments.includeAnalysis, true);
      assert.ok(payload.packet_bundle);
      assert.ok(payload.analysis);
    } finally {
      await server.stop();
    }
  } finally {
    await cleanupFixture(fixture);
  }
});
