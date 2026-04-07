import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Linux Secret Service implementation
 * Uses secret-tool (part of libsecret) to store/retrieve secrets
 * Falls back gracefully if not available
 */

async function runSecretTool(args, runner = execFileAsync) {
  try {
    const result = await runner('secret-tool', args);
    return result?.stdout ? String(result.stdout).trim() : '';
  } catch (error) {
    // If secret-tool is not found, throw a helpful error
    if (String(error?.message || '').includes('ENOENT')) {
      throw new Error(
        'secret-tool not found. Install libsecret-tools: sudo apt install libsecret-tools (Ubuntu/Debian) '
        + 'or sudo dnf install libsecret (Fedora)'
      );
    }
    throw error;
  }
}

export async function setSecret({ service, account, secret }, deps = {}) {
  if (!service || !account) {
    throw new Error('Secret service and account are required.');
  }
  if (!secret) {
    throw new Error('Secret value is required.');
  }

  // Store using secret-tool: secret-tool store --label "service:account" service service account account
  try {
    await runSecretTool(
      ['store', '--label', `${service}:${account}`, 'service', service, 'account', account],
      deps.runner
    );
    // Write secret to stdin
    const child = require('child_process').spawn('secret-tool', 
      ['store', '--label', `${service}:${account}`, 'service', service, 'account', account]
    );
    
    await new Promise((resolve, reject) => {
      child.stdin.write(secret);
      child.stdin.end();
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`secret-tool exited with ${code}`));
      });
      child.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Failed to store secret in Secret Service: ${error.message}`);
  }
}

export async function promptSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    throw new Error('Secret service and account are required.');
  }

  // For Linux, we don't have an interactive prompt like Keychain
  // Instead, guide the user to use `papernexus auth llm set --stdin`
  throw new Error(
    'Interactive prompt not supported on Linux. Use: papernexus auth llm set --stdin < secret.txt'
  );
}

export async function getSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return '';
  }

  try {
    return await runSecretTool(
      ['lookup', 'service', service, 'account', account],
      deps.runner
    );
  } catch (error) {
    if (String(error?.message || '').includes('Secret not found')) {
      return '';
    }
    // If secret-tool not available, return empty (will fall back to other methods)
    if (String(error?.message || '').includes('secret-tool not found')) {
      return '';
    }
    throw error;
  }
}

export async function deleteSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return;
  }

  try {
    await runSecretTool(
      ['clear', 'service', service, 'account', account],
      deps.runner
    );
  } catch (error) {
    if (String(error?.message || '').includes('Secret not found')) {
      return;
    }
    // Silently ignore if secret-tool not available
    if (String(error?.message || '').includes('secret-tool not found')) {
      return;
    }
    throw error;
  }
}

export async function isAvailable() {
  try {
    await execFileAsync('which', ['secret-tool']);
    return true;
  } catch {
    return false;
  }
}

export function getDisplayName() {
  return 'Secret Service (Linux systemd)';
}
