import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readJson, writeJson, ensureDir } from './fs.js';

/**
 * Encrypted local secret storage fallback
 * Uses AES-256-GCM with crypto module (no external dependencies)
 * Stores encrypted secrets in ~/.papernexus/secrets.json
 */

const SECRETS_DIR = path.join(os.homedir(), '.papernexus');
const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');
const SALT_FILE = path.join(SECRETS_DIR, '.secrets.salt');
const IV_LENGTH = 16; // 128-bit IV
const SALT_LENGTH = 32; // 256-bit salt
const TAG_LENGTH = 16; // 128-bit auth tag

let cachedKey = null;
let cachedKeyDerived = null;

async function getSalt() {
  try {
    const saltData = await fs.readFile(SALT_FILE, 'utf8');
    return Buffer.from(saltData, 'hex');
  } catch {
    // Generate new salt if it doesn't exist
    const salt = crypto.randomBytes(SALT_LENGTH);
    await ensureDir(SECRETS_DIR);
    await fs.writeFile(SALT_FILE, salt.toString('hex'), 'utf8');
    return salt;
  }
}

async function deriveKey(password) {
  // Use PBKDF2 to derive a strong key from the password
  const salt = await getSalt();
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(ciphertext, key) {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

async function getPassword() {
  // For now, derive key from a simple hash of machine ID and username
  // In the future, could prompt user or use system entropy
  const machineId = `${os.hostname()}-${os.userInfo().username}`;
  const hash = crypto.createHash('sha256');
  hash.update(machineId);
  return hash.digest('hex').substring(0, 32);
}

async function loadSecrets() {
  try {
    const data = await readJson(SECRETS_FILE, {});
    return data || {};
  } catch {
    return {};
  }
}

async function saveSecrets(secrets) {
  await ensureDir(SECRETS_DIR);
  await writeJson(SECRETS_FILE, secrets);
  // Restrict permissions to owner only
  await fs.chmod(SECRETS_FILE, 0o600);
}

export async function setSecret({ service, account, secret }) {
  if (!service || !account) {
    throw new Error('Service and account are required.');
  }
  if (!secret) {
    throw new Error('Secret value is required.');
  }

  const password = await getPassword();
  const key = await deriveKey(password);
  const secrets = await loadSecrets();
  
  const key_id = `${service}:${account}`;
  secrets[key_id] = encrypt(secret, key);
  
  await saveSecrets(secrets);
}

export async function promptSecret({ service, account }) {
  // Not applicable for encrypted storage
  throw new Error('Encrypted storage does not support interactive prompts.');
}

export async function getSecret({ service, account }) {
  if (!service || !account) {
    return '';
  }

  try {
    const password = await getPassword();
    const key = await deriveKey(password);
    const secrets = await loadSecrets();
    
    const key_id = `${service}:${account}`;
    const encrypted = secrets[key_id];
    
    if (!encrypted) {
      return '';
    }

    return decrypt(encrypted, key);
  } catch (error) {
    console.error(`Failed to retrieve encrypted secret: ${error.message}`);
    return '';
  }
}

export async function deleteSecret({ service, account }) {
  if (!service || !account) {
    return;
  }

  try {
    const secrets = await loadSecrets();
    const key_id = `${service}:${account}`;
    
    if (key_id in secrets) {
      delete secrets[key_id];
      await saveSecrets(secrets);
    }
  } catch (error) {
    // Silently ignore
  }
}

export async function isAvailable() {
  // Encrypted storage is always available
  return true;
}

export function getDisplayName() {
  return 'Encrypted Local Storage';
}

export function getSecretFileLocation() {
  return SECRETS_FILE;
}
