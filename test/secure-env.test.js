import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSecureEnvValue,
  listSecureEnvKeys,
  loadSecureEnv,
  setSecureEnvValue
} from '../src/lib/secure-env.js';
import { executeProviderQueries } from '../src/core/discovery/providers.js';
import { resolvePaperIdentifiersExternally } from '../src/core/ingestion/identifier-resolution.js';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function createJsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-secure-env-'));
}

test('secure env encrypts values and applies them without overriding existing env', async () => {
  const tempDir = await makeTempDir();
  const secureEnvPath = path.join(tempDir, 'secure-env.enc.json');

  await setSecureEnvValue('OPENALEX_API_KEY', 'openalex-test-key', {
    path: secureEnvPath,
    key: TEST_KEY
  });

  const raw = await fs.readFile(secureEnvPath, 'utf8');
  assert.doesNotMatch(raw, /openalex-test-key/);

  const listed = await listSecureEnvKeys({ path: secureEnvPath, key: TEST_KEY });
  assert.deepEqual(listed.keys, ['OPENALEX_API_KEY']);

  const emptyEnv = {};
  const loaded = await loadSecureEnv({
    path: secureEnvPath,
    key: TEST_KEY,
    targetEnv: emptyEnv
  });
  assert.equal(loaded.loaded, true);
  assert.equal(emptyEnv.OPENALEX_API_KEY, 'openalex-test-key');

  const existingEnv = { OPENALEX_API_KEY: 'shell-value' };
  await loadSecureEnv({
    path: secureEnvPath,
    key: TEST_KEY,
    targetEnv: existingEnv
  });
  assert.equal(existingEnv.OPENALEX_API_KEY, 'shell-value');

  await deleteSecureEnvValue('OPENALEX_API_KEY', {
    path: secureEnvPath,
    key: TEST_KEY
  });
  const afterDelete = await listSecureEnvKeys({ path: secureEnvPath, key: TEST_KEY });
  assert.deepEqual(afterDelete.keys, []);
});

test('literature discovery sends OpenAlex api_key when configured', async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;

  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return createJsonResponse({ results: [] });
  };

  try {
    await executeProviderQueries({
      providers: ['openalex'],
      openAlexApiKey: 'openalex-test-key',
      plan: {
        queries: [{
          id: 'q1',
          query: 'graph retrieval',
          family: 'direct'
        }]
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(requestedUrl.hostname, 'api.openalex.org');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'openalex-test-key');
});

test('literature discovery reads OpenAlex api_key from a local file', async () => {
  const tempDir = await makeTempDir();
  const keyPath = path.join(tempDir, 'openalex-key.txt');
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;
  await fs.writeFile(keyPath, 'openalex-file-key\n', 'utf8');

  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return createJsonResponse({ results: [] });
  };

  try {
    await executeProviderQueries({
      providers: ['openalex'],
      openAlexApiKeyFile: keyPath,
      env: {},
      plan: {
        queries: [{
          id: 'q1',
          query: 'graph retrieval',
          family: 'direct'
        }]
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(requestedUrl.hostname, 'api.openalex.org');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'openalex-file-key');
});

test('literature discovery falls back to the default OpenAlex key file', async () => {
  const tempDir = await makeTempDir();
  const keyPath = path.join(tempDir, 'openalex_api_key');
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;
  await fs.writeFile(keyPath, 'openalex-default-file-key\n', 'utf8');

  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return createJsonResponse({ results: [] });
  };

  try {
    await executeProviderQueries({
      providers: ['openalex'],
      defaultOpenAlexApiKeyFile: keyPath,
      env: {},
      plan: {
        queries: [{
          id: 'q1',
          query: 'graph retrieval',
          family: 'direct'
        }]
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(requestedUrl.hostname, 'api.openalex.org');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'openalex-default-file-key');
});

test('identifier resolution sends OpenAlex api_key when configured', async () => {
  const tempDir = await makeTempDir();
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;

  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return createJsonResponse({ results: [] });
  };

  try {
    await resolvePaperIdentifiersExternally(
      tempDir,
      {
        paperTitle: 'Graph Retrieval for Literature Discovery',
        authors: ['Ada Lovelace'],
        titleValidation: {
          rawTitle: 'Graph Retrieval for Literature Discovery',
          isValid: true
        }
      },
      {},
      {
        identifierResolution: {
          providers: ['openalex'],
          openAlexApiKey: 'openalex-test-key',
          maxCandidates: 1,
          missCacheTtlMs: 1
        }
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(requestedUrl.hostname, 'api.openalex.org');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'openalex-test-key');
});

test('identifier resolution reads OpenAlex api_key from a local file', async () => {
  const tempDir = await makeTempDir();
  const keyPath = path.join(tempDir, 'openalex-key.txt');
  const previousFetch = globalThis.fetch;
  let requestedUrl = null;
  await fs.writeFile(keyPath, 'openalex-resolution-file-key\n', 'utf8');

  globalThis.fetch = async (url) => {
    requestedUrl = new URL(String(url));
    return createJsonResponse({ results: [] });
  };

  try {
    await resolvePaperIdentifiersExternally(
      tempDir,
      {
        paperTitle: 'Graph Retrieval for Literature Discovery',
        authors: ['Ada Lovelace'],
        titleValidation: {
          rawTitle: 'Graph Retrieval for Literature Discovery',
          isValid: true
        }
      },
      {},
      {
        identifierResolution: {
          providers: ['openalex'],
          openAlexApiKeyFile: keyPath,
          maxCandidates: 1,
          missCacheTtlMs: 1
        },
        env: {}
      }
    );
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(requestedUrl.hostname, 'api.openalex.org');
  assert.equal(requestedUrl.searchParams.get('api_key'), 'openalex-resolution-file-key');
});
