/**
 * Cross-platform secret storage manager
 * Routes to platform-specific implementations:
 * - macOS: Keychain
 * - Linux: Secret Service (systemd)
 * - Windows: Credential Manager
 * - Fallback: Encrypted local storage (all platforms)
 */

import * as darwinKeychain from './keychain-darwin.js';
import * as linuxKeychain from './keychain-linux.js';
import * as windowsKeychain from './keychain-windows.js';
import * as encryptedStorage from './encrypted-storage.js';

const DEFAULT_LLM_KEYCHAIN_SERVICE = 'papernexus.llm';

function getPlatformKeychain() {
  const platform = process.platform;
  
  if (platform === 'darwin') {
    return { backend: darwinKeychain, name: 'darwin' };
  }
  
  if (platform === 'linux') {
    return { backend: linuxKeychain, name: 'linux' };
  }
  
  if (platform === 'win32') {
    return { backend: windowsKeychain, name: 'windows' };
  }
  
  // Default fallback
  return { backend: encryptedStorage, name: 'encrypted' };
}

/**
 * Get all available key storage backends for current platform
 */
export async function getAvailableBackends() {
  const backends = [];
  const platform = process.platform;
  
  if (platform === 'darwin') {
    if (await darwinKeychain.isAvailable()) {
      backends.push({ id: 'keychain', name: darwinKeychain.getDisplayName(), backend: darwinKeychain });
    }
  }
  
  if (platform === 'linux') {
    if (await linuxKeychain.isAvailable()) {
      backends.push({ id: 'secret-service', name: linuxKeychain.getDisplayName(), backend: linuxKeychain });
    }
  }
  
  if (platform === 'win32') {
    if (await windowsKeychain.isAvailable()) {
      backends.push({ id: 'credential-manager', name: windowsKeychain.getDisplayName(), backend: windowsKeychain });
    }
  }
  
  // Encrypted storage always available as fallback
  backends.push({ id: 'encrypted', name: encryptedStorage.getDisplayName(), backend: encryptedStorage });
  
  return backends;
}

/**
 * Get the recommended storage backend for current platform
 */
export async function getRecommendedBackend() {
  const backends = await getAvailableBackends();
  // Prefer system keyring if available, otherwise encrypted storage
  const systemBackend = backends.find(b => b.id !== 'encrypted');
  return systemBackend || backends[0];
}

/**
 * Store a secret using the platform-appropriate backend
 */
export async function setKeychainSecret({ service, account, secret }, deps = {}) {
  const { backend } = getPlatformKeychain();
  
  try {
    await backend.setSecret({ service, account, secret }, deps);
  } catch (error) {
    // If primary backend fails, try encrypted storage
    if (backend !== encryptedStorage) {
      console.warn(`Warning: ${error.message}. Falling back to encrypted storage.`);
      await encryptedStorage.setSecret({ service, account, secret });
    } else {
      throw error;
    }
  }
}

/**
 * Prompt user for a secret (interactive, macOS only)
 */
export async function promptKeychainSecret({ service, account }, deps = {}) {
  const { backend } = getPlatformKeychain();
  
  try {
    await backend.promptSecret({ service, account }, deps);
  } catch (error) {
    // Fall back to environment variable or encrypted storage
    throw new Error(
      `${error.message}\n\n` +
      `Alternative: Set the API key via environment variable or use 'papernexus auth llm set --stdin'.`
    );
  }
}

/**
 * Retrieve a secret from secure storage
 * Tries platform-specific backend first, then falls back to encrypted storage
 */
export async function getKeychainSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return '';
  }

  const { backend, name } = getPlatformKeychain();
  
  try {
    const secret = await backend.getSecret({ service, account }, deps);
    if (secret) {
      return secret;
    }
  } catch (error) {
    // If primary backend fails, try encrypted storage
    if (backend !== encryptedStorage) {
      console.debug(`Debug: ${name} backend unavailable, trying encrypted storage.`);
    }
  }
  
  // Try encrypted storage as fallback
  if (backend !== encryptedStorage) {
    try {
      return await encryptedStorage.getSecret({ service, account });
    } catch {
      // Silently fail, let caller handle missing secret
    }
  }
  
  return '';
}

/**
 * Delete a secret from secure storage
 */
export async function deleteKeychainSecret({ service, account }, deps = {}) {
  if (!service || !account) {
    return;
  }

  const { backend } = getPlatformKeychain();
  
  try {
    await backend.deleteSecret({ service, account }, deps);
  } catch (error) {
    // Try encrypted storage
    if (backend !== encryptedStorage) {
      try {
        await encryptedStorage.deleteSecret({ service, account });
      } catch {
        // Silently fail
      }
    }
  }
}

export function getDefaultLlmKeychainService() {
  return DEFAULT_LLM_KEYCHAIN_SERVICE;
}

export function buildDefaultLlmKeychainAccount({ provider, baseUrl }) {
  return `${String(provider || 'llm').trim().toLowerCase()}:${String(baseUrl || 'default').trim()}`;
}
