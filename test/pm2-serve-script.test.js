import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pm2-papernexus-serve.sh');

test('pm2 wrapper recent prints import-focused lines from the newest daily log', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-logs-'));
  const logDir = path.join(tempDir, 'logs');
  await fs.mkdir(logDir, { recursive: true });

  const olderLog = path.join(logDir, 'papernexus-serve-2026-04-07.log');
  const latestLog = path.join(logDir, 'papernexus-serve-2026-04-08.log');

  await fs.writeFile(olderLog, '[imports] GCD: completed task imp:old-task\n', 'utf8');
  await fs.writeFile(latestLog, [
    '[2026-04-08 10:00:00] [pm2-wrapper] starting papernexus serve',
    '[serve] import worker started (/tmp/demo-index)',
    '[2026-04-08T10:01:00Z] [mcp-http] 127.0.0.1 method=tools/call status=200 durationMs=5 transport=streamable-http',
    '[imports] GCD: completed task imp:recent-success',
    '[imports] GCD: task imp:recent-failure failed (boom)',
  ].join('\n'), 'utf8');

  try {
    const { stdout } = await execFileAsync(scriptPath, ['recent', '--lines', '2'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERNEXUS_LOG_DIR: logDir,
      }
    });

    assert.match(stdout, /Log file: .*papernexus-serve-2026-04-08\.log/);
    assert.match(stdout, /\[imports\] GCD: completed task imp:recent-success/);
    assert.match(stdout, /\[imports\] GCD: task imp:recent-failure failed \(boom\)/);
    assert.doesNotMatch(stdout, /mcp-http/);
    assert.doesNotMatch(stdout, /imp:old-task/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper recent can filter by task id', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-logs-filter-'));
  const logDir = path.join(tempDir, 'logs');
  await fs.mkdir(logDir, { recursive: true });

  const latestLog = path.join(logDir, 'papernexus-serve-2026-04-08.log');
  await fs.writeFile(latestLog, [
    '[imports] GCD: completed task imp:target-task',
    '[imports] GCD: task imp:other-task failed (boom)',
    '[imports] GCD: background preparse prepared PDF markdown cache for paper.pdf',
  ].join('\n'), 'utf8');

  try {
    const { stdout } = await execFileAsync(scriptPath, ['recent', '--task-id', 'imp:target-task'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERNEXUS_LOG_DIR: logDir,
      }
    });

    assert.match(stdout, /imp:target-task/);
    assert.doesNotMatch(stdout, /imp:other-task/);
    assert.doesNotMatch(stdout, /background preparse/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper recent stays import-focused with stricter awk compatibility', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-logs-strict-awk-'));
  const logDir = path.join(tempDir, 'logs');
  const binDir = path.join(tempDir, 'bin');
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  const latestLog = path.join(logDir, 'papernexus-serve-2026-04-08.log');
  await fs.writeFile(latestLog, [
    '[2026-04-08T10:01:00Z] [mcp-http] 127.0.0.1 method=tools/call status=200 durationMs=5 transport=streamable-http',
    '[imports] GCD: completed task imp:recent-success',
    '[imports] GCD: task imp:recent-failure failed (boom)',
  ].join('\n'), 'utf8');

  const fakeAwkPath = path.join(binDir, 'awk');
  await fs.writeFile(fakeAwkPath, `#!/bin/sh
echo "strict awk should not be invoked" >&2
exit 99
`, 'utf8');
  await fs.chmod(fakeAwkPath, 0o755);

  try {
    const { stdout } = await execFileAsync(scriptPath, ['recent', '--lines', '2'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PAPERNEXUS_LOG_DIR: logDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      }
    });

    assert.match(stdout, /\[imports\] GCD: completed task imp:recent-success/);
    assert.match(stdout, /\[imports\] GCD: task imp:recent-failure failed \(boom\)/);
    assert.doesNotMatch(stdout, /mcp-http/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper can locate pm2 from a common home-local install path when PATH does not provide it', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-bin-discovery-'));
  const homeDir = path.join(tempDir, 'home');
  const fakePm2Dir = path.join(homeDir, 'miniconda3', 'bin');
  const fakePm2Path = path.join(fakePm2Dir, 'pm2');
  const fakeNodePath = path.join(fakePm2Dir, 'node');

  await fs.mkdir(fakePm2Dir, { recursive: true });
  await fs.writeFile(fakePm2Path, '#!/bin/sh\necho \"FAKE_PM2:$@\"\n', 'utf8');
  await fs.writeFile(fakeNodePath, '#!/bin/sh\necho \"FAKE_NODE:$@\"\n', 'utf8');
  await fs.chmod(fakePm2Path, 0o755);
  await fs.chmod(fakeNodePath, 0o755);

  try {
    const { stdout } = await execFileAsync(scriptPath, ['status'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: '/usr/bin:/bin'
      }
    });

    assert.match(stdout, /FAKE_PM2:status papernexus-serve/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper can locate pm2 from the /home/disk0 user install path used by the GPU server', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-disk0-discovery-'));
  const fakeRoot = path.join(tempDir, 'disk0');
  const fakeUser = `pnuser-${process.pid}`;
  const fakePm2Dir = path.join(fakeRoot, fakeUser, 'miniconda3', 'bin');
  const fakePm2Path = path.join(fakePm2Dir, 'pm2');
  const fakeNodePath = path.join(fakePm2Dir, 'node');

  await fs.mkdir(fakePm2Dir, { recursive: true });
  await fs.writeFile(fakePm2Path, '#!/bin/sh\necho \"FAKE_DISK0_PM2:$@\"\n', 'utf8');
  await fs.writeFile(fakeNodePath, '#!/bin/sh\necho \"FAKE_DISK0_NODE:$@\"\n', 'utf8');
  await fs.chmod(fakePm2Path, 0o755);
  await fs.chmod(fakeNodePath, 0o755);

  try {
    const { stdout } = await execFileAsync(scriptPath, ['status'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: path.join(tempDir, 'home'),
        USER: fakeUser,
        PATH: '/usr/bin:/bin',
        PAPERNEXUS_DISK0_ROOT: fakeRoot
      }
    });

    assert.match(stdout, /FAKE_DISK0_PM2:status papernexus-serve/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper can locate node from a common home-local install path for run mode', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-bin-discovery-'));
  const homeDir = path.join(tempDir, 'home');
  const fakeNodeDir = path.join(homeDir, 'miniconda3', 'bin');
  const fakeNodePath = path.join(fakeNodeDir, 'node');
  const logDir = path.join(tempDir, 'logs');

  await fs.mkdir(fakeNodeDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(fakeNodePath, '#!/bin/sh\necho \"FAKE_NODE:$@\"\n', 'utf8');
  await fs.chmod(fakeNodePath, 0o755);

  try {
    await assert.rejects(
      execFileAsync(scriptPath, ['run'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          PATH: '/usr/bin:/bin',
          PAPERNEXUS_LOG_DIR: logDir,
          SLEEP_BIN: '/bin/false'
        }
      })
    );

    const latestLog = path.join(logDir, (await fs.readdir(logDir)).sort().at(-1));
    const log = await fs.readFile(latestLog, 'utf8');
    assert.match(log, new RegExp(`node=${fakeNodePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));
    assert.doesNotMatch(log, /unable to locate a usable node binary/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper prefers a common home-local node install over an older PATH node', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-node-precedence-'));
  const homeDir = path.join(tempDir, 'home');
  const fakeNodeDir = path.join(homeDir, 'miniconda3', 'bin');
  const fakeHomeNodePath = path.join(fakeNodeDir, 'node');
  const fakePathDir = path.join(tempDir, 'bin');
  const fakePathNodePath = path.join(fakePathDir, 'node');
  const logDir = path.join(tempDir, 'logs');

  await fs.mkdir(fakeNodeDir, { recursive: true });
  await fs.mkdir(fakePathDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(fakeHomeNodePath, '#!/bin/sh\necho "HOME_NODE:$@"\n', 'utf8');
  await fs.writeFile(fakePathNodePath, '#!/bin/sh\necho "PATH_NODE:$@"\n', 'utf8');
  await fs.chmod(fakeHomeNodePath, 0o755);
  await fs.chmod(fakePathNodePath, 0o755);

  try {
    await assert.rejects(
      execFileAsync(scriptPath, ['run'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          PATH: `${fakePathDir}${path.delimiter}/usr/bin:/bin`,
          PAPERNEXUS_LOG_DIR: logDir,
          SLEEP_BIN: '/bin/false'
        }
      })
    );

    const latestLog = path.join(logDir, (await fs.readdir(logDir)).sort().at(-1));
    const log = await fs.readFile(latestLog, 'utf8');
    assert.match(log, new RegExp(`node=${fakeHomeNodePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));
    assert.doesNotMatch(log, new RegExp(`node=${fakePathNodePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('pm2 wrapper prefers a common home-local pm2 install over an older PATH pm2', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pm2-precedence-'));
  const homeDir = path.join(tempDir, 'home');
  const fakePm2Dir = path.join(homeDir, 'miniconda3', 'bin');
  const fakeHomePm2Path = path.join(fakePm2Dir, 'pm2');
  const fakeHomeNodePath = path.join(fakePm2Dir, 'node');
  const fakePathDir = path.join(tempDir, 'bin');
  const fakePathPm2Path = path.join(fakePathDir, 'pm2');

  await fs.mkdir(fakePm2Dir, { recursive: true });
  await fs.mkdir(fakePathDir, { recursive: true });
  await fs.writeFile(fakeHomePm2Path, '#!/bin/sh\necho "HOME_PM2:$@"\n', 'utf8');
  await fs.writeFile(fakeHomeNodePath, '#!/bin/sh\necho "HOME_NODE:$@"\n', 'utf8');
  await fs.writeFile(fakePathPm2Path, '#!/bin/sh\necho "PATH_PM2:$@"\n', 'utf8');
  await fs.chmod(fakeHomePm2Path, 0o755);
  await fs.chmod(fakeHomeNodePath, 0o755);
  await fs.chmod(fakePathPm2Path, 0o755);

  try {
    const { stdout } = await execFileAsync(scriptPath, ['status'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${fakePathDir}${path.delimiter}/usr/bin:/bin`,
      }
    });

    assert.match(stdout, /HOME_PM2:status papernexus-serve/);
    assert.doesNotMatch(stdout, /PATH_PM2:status papernexus-serve/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
