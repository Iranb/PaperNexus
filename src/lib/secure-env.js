import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getKeychainSecret, setKeychainSecret } from './keychain.js';

const DEFAULT_SECURE_ENV_FILE = 'secure-env.enc.json';
const SECURE_ENV_KEY_SERVICE = 'papernexus.secure-env';
const SECURE_ENV_KEY_ACCOUNT = 'default';
const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;

function resolvePapernexusHome() {
  const configured = String(process.env.PAPERNEXUS_HOME || '').trim();
  if (!configured) return path.join(os.homedir(), '.papernexus');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

export function getDefaultSecureEnvPath() {
  return path.join(resolvePapernexusHome(), DEFAULT_SECURE_ENV_FILE);
}

export function resolveSecureEnvPath(value = '') {
  const configured = String(value || process.env.PAPERNEXUS_SECURE_ENV_FILE || '').trim();
  if (!configured) return getDefaultSecureEnvPath();
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function validateEnvName(name) {
  const normalized = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid env var name: ${name || '<empty>'}`);
  }
  return normalized;
}

function normalizeKey(encoded) {
  const key = Buffer.from(String(encoded || ''), 'base64');
  if (key.length !== 32) {
    throw new Error('Secure env encryption key must be 32 bytes.');
  }
  return key;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function resolveFileKey(options = {}) {
  if (options.key) return normalizeKey(options.key);

  let encoded = await getKeychainSecret({
    service: SECURE_ENV_KEY_SERVICE,
    account: SECURE_ENV_KEY_ACCOUNT
  }, options.deps);

  if (!encoded && options.createIfMissing) {
    encoded = crypto.randomBytes(32).toString('base64');
    await setKeychainSecret({
      service: SECURE_ENV_KEY_SERVICE,
      account: SECURE_ENV_KEY_ACCOUNT,
      secret: encoded
    }, options.deps);
  }

  if (!encoded) {
    throw new Error('Secure env encryption key was not found in the system keychain.');
  }

  return normalizeKey(encoded);
}

function encryptPayload(values, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(values);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: VERSION,
    algorithm: ALGORITHM,
    keyService: SECURE_ENV_KEY_SERVICE,
    keyAccount: SECURE_ENV_KEY_ACCOUNT,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptPayload(payload, key, filePath) {
  if (!payload || payload.version !== VERSION || payload.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported secure env file format: ${filePath}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  const values = JSON.parse(plaintext);

  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`Secure env file must decrypt to a JSON object: ${filePath}`);
  }

  return values;
}

async function loadSecureEnvMap(options = {}) {
  const filePath = resolveSecureEnvPath(options.path);
  const raw = await readFileIfExists(filePath);
  if (!raw) return { path: filePath, values: {}, exists: false };

  const key = await resolveFileKey({ ...options, createIfMissing: false });
  return {
    path: filePath,
    values: decryptPayload(JSON.parse(raw), key, filePath),
    exists: true
  };
}

async function saveSecureEnvMap(values, options = {}) {
  const filePath = resolveSecureEnvPath(options.path);
  const key = await resolveFileKey({ ...options, createIfMissing: true });
  const payload = encryptPayload(values, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
  return filePath;
}

function isDisabled(value) {
  return ['0', 'false', 'off', 'no'].includes(String(value || '').trim().toLowerCase());
}

export async function loadSecureEnv(options = {}) {
  if (options.disabled || isDisabled(process.env.PAPERNEXUS_SECURE_ENV)) {
    return { loaded: false, path: resolveSecureEnvPath(options.path), keys: [], appliedKeys: [] };
  }

  const targetEnv = options.targetEnv || process.env;
  const { path: filePath, values, exists } = await loadSecureEnvMap(options);
  if (!exists) return { loaded: false, path: filePath, keys: [], appliedKeys: [] };

  const keys = Object.keys(values).sort();
  const appliedKeys = [];
  for (const key of keys) {
    validateEnvName(key);
    if (options.override || targetEnv[key] === undefined) {
      targetEnv[key] = String(values[key] ?? '');
      appliedKeys.push(key);
    }
  }

  return { loaded: true, path: filePath, keys, appliedKeys };
}

export async function setSecureEnvValue(name, value, options = {}) {
  const envName = validateEnvName(name);
  const secret = String(value ?? '').trim();
  if (!secret) throw new Error(`Secure env value cannot be empty: ${envName}`);

  const { values } = await loadSecureEnvMap(options);
  values[envName] = secret;
  const filePath = await saveSecureEnvMap(values, options);
  return { path: filePath, name: envName };
}

export async function deleteSecureEnvValue(name, options = {}) {
  const envName = validateEnvName(name);
  const { values, path: filePath } = await loadSecureEnvMap(options);
  delete values[envName];
  await saveSecureEnvMap(values, options);
  return { path: filePath, name: envName };
}

export async function listSecureEnvKeys(options = {}) {
  const { path: filePath, values, exists } = await loadSecureEnvMap(options);
  return {
    path: filePath,
    keys: exists ? Object.keys(values).sort() : []
  };
}
