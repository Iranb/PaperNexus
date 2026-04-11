import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Linux secret storage implementation with multiple fallback methods:
 * 1. secret-tool (systemd Secret Service) - no root needed if already installed
 * 2. pass (password-store) - per-user password manager, no root needed
 * 3. Encrypted local storage - fallback (handled by keychain router)
 */

async function runCommand(cmd, args, runner = execFileAsync) {
  try {
    const result = await runner(cmd, args);
    return result?.stdout ? String(result.stdout).trim() : '';
  } catch (error) {
    return null;
  }
}

async function getAvailableTool() {
  // Check which tools are available without requiring root
  if (await runCommand('which', ['secret-tool'])) {
    return 'secret-tool';
  }
  if (await runCommand('which', ['pass'])) {
    return 'pass';
  }
  return null;
}

async function storeViaSecretTool({ service, account, secret }) {
  const label = `${service}:${account}`;
  
  try {
    const child = spawn('secret-tool',
      ['store', '--label', label, 'service', service, 'account', account]
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
    throw new Error(`Failed to store secret via secret-tool: ${error.message}`);
  }
}

async function retrieveViaSecretTool({ service, account }) {
  try {
    const result = await execFileAsync('secret-tool', 
      ['lookup', 'service', service, 'account', account]
    );
    return result?.stdout ? String(result.stdout).trim() : '';
  } catch {
    return '';
  }
}

async function deleteViaSecretTool({ service, account }) {
  try {
    await execFileAsync('secret-tool', 
      ['clear', 'service', service, 'account', account]
    );
  } catch {
    // Ignore errors
  }
}

async function storeViaPass({ service, account, secret }) {
  const passPath = `papernexus/${service}/${account}`;
  
  try {
    const child = spawn('pass',
      ['insert', '--force', passPath]
    );
    
    await new Promise((resolve, reject) => {
      child.stdin.write(secret);
      child.stdin.end();
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pass exited with ${code}`));
      });
      child.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Failed to store secret via pass: ${error.message}`);
  }
}

async function retrieveViaPass({ service, account }) {
  const passPath = `papernexus/${service}/${account}`;
  
  try {
    const result = await execFileAsync('pass', ['show', passPath]);
    return result?.stdout ? String(result.stdout).trim() : '';
  } catch {
    return '';
  }
}

async function deleteViaPass({ service, account }) {
  const passPath = `papernexus/${service}/${account}`;
  
  try {
    await execFileAsync('pass', ['rm', '--force', passPath]);
  } catch {
    // Ignore errors
  }
}

export async function setSecret({ service, account, secret }, deps = {}) {
  if (!service || !account) {
    throw new Error('Secret service and account are required.');
  }
  if (!secret) {
    throw new Error('Secret value is required.');
  }

  const tool = await getAvailableTool();

  if (tool === 'secret-tool') {
    return storeViaSecretTool({ service, account, secret });
  }

  if (tool === 'pass') {
    return storeViaPass({ service, account, secret });
  }

  throw new Error(
    'No password manager available. Install one of:\n'
    + '  • pass (password-store): https://www.passwordstore.org/ (no root needed)\n'
    + '  • secret-tool: Part of libsecret (may already be installed)\n'
    + 'Or use encrypted local storage by running: papernexus init'
  );
}

export async function promptSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    throw new Error('Secret service and account are required.');
  }

  throw new Error(
    'Interactive prompt not supported on Linux. Use one of:\n'
    + '  1. papernexus auth llm set --stdin < api_key.txt\n'
    + '  2. echo "sk-..." | papernexus auth llm set --stdin\n'
    + '  3. Install pass and use: papernexus auth llm set --provider openai'
  );
}

export async function getSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return '';
  }

  const tool = await getAvailableTool();

  if (tool === 'secret-tool') {
    return retrieveViaSecretTool({ service, account });
  }

  if (tool === 'pass') {
    return retrieveViaPass({ service, account });
  }

  return '';
}

export async function deleteSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return;
  }

  const tool = await getAvailableTool();

  if (tool === 'secret-tool') {
    return deleteViaSecretTool({ service, account });
  }

  if (tool === 'pass') {
    return deleteViaPass({ service, account });
  }
}

export async function isAvailable() {
  const tool = await getAvailableTool();
  return tool !== null;
}

export async function getDisplayName() {
  const tool = await getAvailableTool();
  
  if (tool === 'secret-tool') {
    return 'Secret Service (systemd)';
  }
  
  if (tool === 'pass') {
    return 'pass (password-store)';
  }
  
  return 'Linux (no password manager available)';
}

export async function getAvailableTools() {
  const tools = [];
  
  if (await runCommand('which', ['secret-tool'])) {
    tools.push({
      name: 'secret-tool',
      displayName: 'Secret Service (systemd)',
      description: 'System-wide password manager (if installed)',
      needsRoot: false
    });
  }
  
  if (await runCommand('which', ['pass'])) {
    tools.push({
      name: 'pass',
      displayName: 'pass (password-store)',
      description: 'User password manager - no root needed',
      url: 'https://www.passwordstore.org/',
      needsRoot: false
    });
  }
  
  return tools;
}

export function getSetupInstructions() {
  return `
Install a password manager (no root access required):

Option 1: pass (password-store) - Recommended for non-root users
  1. Install:
     • macOS: brew install pass
     • Linux: apt install pass (without sudo, if available in home)
     • Or build from source: https://git.zx2c4.com/password-store/

  2. Initialize:
     pass init your-gpg-key-id
     (You may need to generate a GPG key first)

  3. Then use PaperNexus:
     papernexus auth llm set --provider openai --base-url https://api.openai.com/v1

Option 2: Use encrypted local storage (easiest, no installation)
  papernexus init
  # Select: Store in encrypted local storage
  # Keys stored in ~/.papernexus/secrets.json (encrypted with AES-256-GCM)

Option 3: Use environment variables (simplest, less secure)
  export OPENAI_API_KEY="sk-..."
  papernexus serve
  `;
}
