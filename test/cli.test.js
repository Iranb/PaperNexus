import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const cliPath = path.join(projectRoot, 'src', 'cli', 'index.js');
const examplesRoot = path.join(projectRoot, 'examples');

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

test('CLI auth llm set stores an API key binding in config.json and macOS Keychain', async () => {
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

    const authRun = await spawnCli(['auth', 'llm', 'set', '--stdin'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_SECURITY_STORE: storePath
      },
      stdin: 'dashscope-test-key\n'
    });

    assert.equal(authRun.code, 0, authRun.stderr);
    assert.match(authRun.stdout, /Stored API key in macOS Keychain/);

    const savedConfig = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8'));
    assert.equal(savedConfig.llm.provider, 'openai');
    assert.equal(savedConfig.llm.baseUrl, 'https://coding.dashscope.aliyuncs.com/v1');
    assert.equal(savedConfig.llm.apiKeySource, 'keychain');
    assert.equal(savedConfig.llm.apiKeyService, 'papernexus.llm');
    assert.equal(savedConfig.llm.apiKeyAccount, 'openai:https://coding.dashscope.aliyuncs.com/v1');

    const fakeKeychain = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(
      fakeKeychain['papernexus.llm|openai:https://coding.dashscope.aliyuncs.com/v1'],
      'dashscope-test-key'
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI init creates a first-run config.json from interactive answers', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-cli-init-'));

  try {
    const initRun = await spawnCli(['init'], {
      cwd: workspaceRoot,
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
    assert.match(initRun.stdout, /Next: run `papernexus analyze --force`/);
    assert.match(initRun.stdout, /Step 1: Paper Sources/);
    assert.match(initRun.stdout, /Step 3: Index Directory/);
    assert.match(initRun.stdout, /stores its generated index data/i);

    const savedConfig = JSON.parse(await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8'));
    assert.deepEqual(savedConfig.sources.inputs, ['./papers']);
    assert.equal(savedConfig.analyze.name, 'first-run-corpus');
    assert.equal(savedConfig.analyze.pdfParser, 'docling');
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
  }
});
