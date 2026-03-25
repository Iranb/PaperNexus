import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_LLM_KEYCHAIN_SERVICE = 'papernexus.llm';

function ensureMacOsKeychain() {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain-backed secret storage is currently supported only on macOS.');
  }
}

async function runSecurity(args, runner = execFileAsync) {
  ensureMacOsKeychain();
  const result = await runner('security', args);
  return result?.stdout ? String(result.stdout).trim() : '';
}

async function runSecurityInteractive(args, runner = spawn) {
  ensureMacOsKeychain();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive Keychain prompt requires a TTY. Use `--stdin` to pipe the key instead.');
  }

  return new Promise((resolve, reject) => {
    const child = runner('security', args, {
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`security exited with ${code}`));
    });
  });
}

export function getDefaultLlmKeychainService() {
  return DEFAULT_LLM_KEYCHAIN_SERVICE;
}

export function buildDefaultLlmKeychainAccount({ provider, baseUrl }) {
  return `${String(provider || 'llm').trim().toLowerCase()}:${String(baseUrl || 'default').trim()}`;
}

export async function setKeychainSecret({ service, account, secret }, deps = {}) {
  if (!service || !account) {
    throw new Error('Keychain service and account are required.');
  }
  if (!secret) {
    throw new Error('Secret value is required.');
  }

  await runSecurity(
    ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret],
    deps.runner
  );
}

export async function promptKeychainSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    throw new Error('Keychain service and account are required.');
  }

  await runSecurityInteractive(
    ['add-generic-password', '-U', '-s', service, '-a', account, '-w'],
    deps.spawnRunner
  );
}

export async function getKeychainSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return '';
  }

  try {
    return await runSecurity(
      ['find-generic-password', '-w', '-s', service, '-a', account],
      deps.runner
    );
  } catch (error) {
    if (String(error?.message || '').includes('could not be found')) {
      return '';
    }
    throw error;
  }
}

export async function deleteKeychainSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return;
  }

  try {
    await runSecurity(
      ['delete-generic-password', '-s', service, '-a', account],
      deps.runner
    );
  } catch (error) {
    if (String(error?.message || '').includes('could not be found')) {
      return;
    }
    throw error;
  }
}
