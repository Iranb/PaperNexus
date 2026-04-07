import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Windows Credential Manager implementation
 * Uses cmdkey and credential manager commands to store/retrieve secrets
 * Falls back gracefully if not available
 */

export async function setSecret({ service, account, secret }, deps = {}) {
  if (!service || !account) {
    throw new Error('Credential service and account are required.');
  }
  if (!secret) {
    throw new Error('Secret value is required.');
  }

  const target = `${service}:${account}`;

  try {
    // Use cmdkey to store credential
    await execFileAsync('cmdkey', ['/add', target, '/user', account, '/pass', secret], {
      shell: true,
      ...(deps.runner ? {} : {})
    });
  } catch (error) {
    throw new Error(`Failed to store credential in Windows Credential Manager: ${error.message}`);
  }
}

export async function promptSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    throw new Error('Credential service and account are required.');
  }

  // For Windows, we don't have an interactive prompt like Keychain
  // Instead, guide the user to use `papernexus auth llm set --stdin`
  throw new Error(
    'Interactive prompt not supported on Windows. Use: papernexus auth llm set --stdin < secret.txt'
  );
}

export async function getSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return '';
  }

  const target = `${service}:${account}`;

  try {
    // Use cmdkey to retrieve credential
    const result = await execFileAsync('cmdkey', ['/list', target], {
      shell: true
    });
    
    if (result?.stdout && String(result.stdout).includes(target)) {
      // Credential exists, but cmdkey /list doesn't return the password
      // We need to use credential manager or PowerShell
      // For now, return a marker indicating credential exists
      return getStoredCredentialViaPs(target);
    }
    
    return '';
  } catch (error) {
    if (String(error?.message || '').includes('not found')) {
      return '';
    }
    return '';
  }
}

async function getStoredCredentialViaPs(target) {
  try {
    // Use PowerShell to retrieve the stored credential
    const psCommand = `
      [void][Windows.Security.Credentials.CredentialManager,Windows.Security.Credentials,ContentType=WindowsRuntime];
      $cred = [Windows.Security.Credentials.CredentialManager]::FindAllByResource('${target}');
      if ($cred) { [System.Runtime.InteropServices.Marshal]::PtrToStringUni([System.Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($cred[0].Password)) }
    `.replace(/\n/g, ' ');
    
    const result = await execFileAsync('powershell', ['-NoProfile', '-Command', psCommand]);
    return result?.stdout ? String(result.stdout).trim() : '';
  } catch {
    // If PowerShell method fails, return empty
    return '';
  }
}

export async function deleteSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return;
  }

  const target = `${service}:${account}`;

  try {
    await execFileAsync('cmdkey', ['/delete', target], {
      shell: true
    });
  } catch (error) {
    if (String(error?.message || '').includes('not found')) {
      return;
    }
    // Silently ignore other errors
  }
}

export async function isAvailable() {
  try {
    await execFileAsync('cmdkey', ['/?'], {
      shell: true
    });
    return true;
  } catch {
    return false;
  }
}

export function getDisplayName() {
  return 'Windows Credential Manager';
}
