import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'reinstall.sh');

test('reinstall script supports dry-run without config and does not trip on empty config args', async () => {
  const result = await execFileAsync('bash', [scriptPath, '--dry-run', '--skip-install', '--skip-link'], {
    cwd: projectRoot,
    env: process.env
  });

  assert.match(result.stdout, /\[reinstall\] project root:/);
  assert.match(result.stdout, /\[dry-run\] node .* service uninstall --services watch,serve/);
  assert.match(result.stdout, /\[dry-run\] node .* service install --services watch,serve/);
  assert.match(result.stdout, /\[dry-run\] node .* service status --services watch,serve/);
  assert.match(result.stdout, /\[reinstall\] reinstall complete/);
});
