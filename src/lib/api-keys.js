import fs from 'node:fs';
import { resolvePathWithHome } from './config.js';

export const DEFAULT_OPENALEX_API_KEY_FILE = '~/.papernexus/openalex_api_key';

function firstNonEmpty(...values) {
  return values
    .map((value) => String(value ?? '').trim())
    .find(Boolean) || '';
}

export function readSecretFileValue(filePath, options = {}) {
  const rawPath = String(filePath || '').trim();
  if (!rawPath) return '';
  const resolvedPath = resolvePathWithHome(rawPath, options.baseDir || process.cwd());
  try {
    return fs.readFileSync(resolvedPath, 'utf8').trim();
  } catch (error) {
    if (error?.code === 'ENOENT' && !options.required) return '';
    throw new Error(`Failed to read secret file ${resolvedPath}: ${error.message}`);
  }
}

export function resolveOpenAlexApiKey(options = {}) {
  const env = options.env || process.env;
  const directKey = firstNonEmpty(
    options.openAlexApiKey,
    options.openalexApiKey,
    options.openalex_api_key,
    options.apiKey
  );
  if (directKey) return directKey;

  const explicitFile = firstNonEmpty(
    options.openAlexApiKeyFile,
    options.openAlexApiKeyPath,
    options.openalexApiKeyFile,
    options.openalexApiKeyPath,
    options.openalex_api_key_file,
    options.openalex_api_key_path,
    options.apiKeyFile,
    options.apiKeyPath
  );
  if (explicitFile) {
    return readSecretFileValue(explicitFile, {
      baseDir: options.baseDir,
      required: true
    });
  }

  const envKey = firstNonEmpty(env.OPENALEX_API_KEY);
  if (envKey) return envKey;

  return readSecretFileValue(options.defaultOpenAlexApiKeyFile || DEFAULT_OPENALEX_API_KEY_FILE, {
    baseDir: options.baseDir,
    required: false
  });
}
