import fs from 'node:fs/promises';
import { backupCorpus, loadCorpus, loadCorpusMeta, loadSourceManifest, resolveCorpus } from '../storage/corpus-store.js';
import { resolveLlmConfig, getDefaultLlmApiKeyEnv, getDefaultLlmBaseUrl } from '../core/llm/ollama.js';
import { getNodeLayer } from '../core/graph/schema.js';
import { resolvePathWithHome, saveRuntimeConfig } from '../lib/config.js';
import { buildDefaultLlmKeychainAccount } from '../lib/keychain.js';
import { getCorpusPaths } from '../storage/corpus-store.js';
import { getRegistryPath, loadRegistry } from '../storage/registry.js';
import { getEnhancementPaths, getPaperEnhancementPath, loadPaperEnhancement, summarizeEnhancements } from '../storage/enhancement-store.js';
import {
  createImportTask,
  listImportTasks,
  loadImportTask,
  loadImportTaskLog
} from '../storage/import-store.js';

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sortObjectEntries(object) {
  return Object.fromEntries(
    Object.entries(object).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function getApiNodeLayer(node) {
  return node.properties?.layer || getNodeLayer(node.type);
}

export function createApiCache() {
  return {
    corporaByPath: new Map(),
    corpusByRoot: new Map(),
    corpusMetaByRoot: new Map(),
    enhancementSummaryByRoot: new Map(),
    enhancementPaperByKey: new Map()
  };
}

function getConfiguredRootPath(options = {}) {
  const raw = options.config?.storage?.indexDir;
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  return resolvePathWithHome(raw.trim(), options.configBaseDir || process.cwd());
}

async function loadConfiguredCorpusEntry(options = {}) {
  const rootPath = getConfiguredRootPath(options);
  if (!rootPath) {
    return null;
  }

  try {
    const meta = await loadCorpusMeta(rootPath);
    return {
      name: meta.name,
      rootPath,
      indexedAt: meta.indexedAt,
      paperCount: meta.paperCount
    };
  } catch {
    return null;
  }
}

async function readPathStamp(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

async function resolveCachedPayload(cacheMap, key, stamp, loader) {
  const existing = cacheMap.get(key);
  if (existing?.stamp === stamp) {
    if (existing.promise) {
      return existing.promise;
    }
    if (existing.value) {
      return existing.value;
    }
  }

  const promise = (async () => {
    const value = await loader();
    cacheMap.set(key, {
      stamp,
      value,
      promise: null
    });
    return value;
  })().catch((error) => {
    const current = cacheMap.get(key);
    if (current?.promise === promise) {
      cacheMap.delete(key);
    }
    throw error;
  });

  cacheMap.set(key, {
    stamp,
    value: existing?.stamp === stamp ? existing.value : null,
    promise
  });
  return promise;
}

export async function listCorporaPayload(options = {}) {
  const configuredCorpus = await loadConfiguredCorpusEntry(options);
  if (configuredCorpus) {
    return {
      corpora: [configuredCorpus],
      generatedAt: new Date().toISOString()
    };
  }

  const registryPath = getRegistryPath();
  const cache = options.cache;
  const stamp = await readPathStamp(registryPath);

  if (!cache?.corporaByPath) {
    const registry = await loadRegistry();
    return {
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    };
  }

  return resolveCachedPayload(cache.corporaByPath, registryPath, stamp, async () => {
    const registry = await loadRegistry();
    return {
      corpora: registry.corpora,
      generatedAt: new Date().toISOString()
    };
  });
}

async function resolveCorpusForApi(candidate, options = {}) {
  if (candidate) {
    return resolveCorpus(candidate);
  }

  const configuredRoot = getConfiguredRootPath(options);
  if (configuredRoot) {
    return configuredRoot;
  }

  const registryPayload = await listCorporaPayload(options);
  if (!registryPayload.corpora.length) {
    throw new Error('No indexed corpora found. Run `papernexus analyze <path>` first.');
  }

  return registryPayload.corpora[0].rootPath;
}

export async function corpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const stamp = await readPathStamp(getCorpusPaths(rootPath).metaPath);

  if (!cache?.corpusByRoot) {
    const { meta, graph } = await loadCorpus(rootPath);
    return {
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    };
  }

  return resolveCachedPayload(cache.corpusByRoot, rootPath, stamp, async () => {
    const { meta, graph } = await loadCorpus(rootPath);
    return {
      meta,
      graph: graph.toJSON(),
      summary: {
        nodeTypes: sortObjectEntries(countBy(graph.nodes, (node) => node.type)),
        nodeLayers: sortObjectEntries(countBy(graph.nodes, (node) => getApiNodeLayer(node))),
        relationTypes: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.type)),
        layerPaths: sortObjectEntries(countBy(graph.relationships, (relationship) => relationship.properties?.layerPath || 'Unknown'))
      }
    };
  });
}

export async function corpusMetaPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const stamp = await readPathStamp(getCorpusPaths(rootPath).metaPath);

  if (!cache?.corpusMetaByRoot) {
    return {
      meta: await loadCorpusMeta(rootPath)
    };
  }

  return resolveCachedPayload(cache.corpusMetaByRoot, rootPath, stamp, async () => ({
    meta: await loadCorpusMeta(rootPath)
  }));
}

export async function backupCorpusPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate);
  return {
    backup: await backupCorpus(rootPath, {
      backupDir: options.backupDir
    }),
    generatedAt: new Date().toISOString()
  };
}

function normalizeImportFiles(files = []) {
  const normalized = Array.isArray(files) ? files : [];
  return normalized.map((file) => ({
    name: String(file?.name || '').trim(),
    mimeType: String(file?.mimeType || '').trim(),
    contentBase64: String(file?.contentBase64 || '').trim()
  })).filter((file) => file.name && file.contentBase64);
}

async function resolveImportInputPaths(rootPath, options = {}) {
  const manifest = await loadSourceManifest(rootPath);
  const manifestInputs = Array.isArray(manifest?.inputPaths)
    ? manifest.inputPaths
    : (manifest?.inputPath ? [manifest.inputPath] : []);
  if (manifestInputs.length) {
    return manifestInputs;
  }

  const configuredInputs = Array.isArray(options.config?.sources?.inputs)
    ? options.config.sources.inputs
    : [];
  return configuredInputs.map((item) => String(item || '').trim()).filter(Boolean);
}

export async function createImportTaskPayload(candidate, body = {}, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const files = normalizeImportFiles(body.files);
  if (!files.length) {
    throw new Error('At least one uploaded file is required.');
  }

  const inputPaths = await resolveImportInputPaths(rootPath, options);
  const task = await createImportTask(rootPath, {
    trigger: body.trigger || 'api',
    inputPaths,
    files
  });

  return {
    rootPath,
    task,
    generatedAt: new Date().toISOString()
  };
}

export async function listImportTasksPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const payload = await listImportTasks(rootPath);
  return {
    rootPath,
    tasks: payload.tasks,
    generatedAt: new Date().toISOString()
  };
}

export async function importTaskPayload(candidate, taskId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!taskId) {
    throw new Error('taskId is required.');
  }
  const task = await loadImportTask(rootPath, taskId);
  if (!task) {
    throw new Error(`No import task found for ${taskId}.`);
  }
  return {
    rootPath,
    task,
    generatedAt: new Date().toISOString()
  };
}

export async function importTaskLogPayload(candidate, taskId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!taskId) {
    throw new Error('taskId is required.');
  }
  const task = await loadImportTask(rootPath, taskId);
  if (!task) {
    throw new Error(`No import task found for ${taskId}.`);
  }
  return {
    rootPath,
    taskId,
    log: await loadImportTaskLog(rootPath, taskId),
    generatedAt: new Date().toISOString()
  };
}

export async function enhancementSummaryPayload(candidate, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  const cache = options.cache;
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  const stamp = `${await readPathStamp(queuePath)}|${await readPathStamp(indexPath)}`;

  if (!cache?.enhancementSummaryByRoot) {
    return {
      rootPath,
      enhancements: await summarizeEnhancements(rootPath)
    };
  }

  return resolveCachedPayload(cache.enhancementSummaryByRoot, rootPath, stamp, async () => ({
    rootPath,
    enhancements: await summarizeEnhancements(rootPath)
  }));
}

export async function paperEnhancementPayload(candidate, paperId, options = {}) {
  const rootPath = await resolveCorpusForApi(candidate, options);
  if (!paperId) {
    throw new Error('paperId is required.');
  }

  const cache = options.cache;
  const { queuePath, indexPath } = getEnhancementPaths(rootPath);
  const overlayPath = getPaperEnhancementPath(rootPath, paperId);
  const stamp = `${await readPathStamp(queuePath)}|${await readPathStamp(indexPath)}|${await readPathStamp(overlayPath)}`;
  const cacheKey = `${rootPath}:${paperId}`;

  if (!cache?.enhancementPaperByKey) {
    const payload = await loadPaperEnhancement(rootPath, paperId);
    if (!payload.overlay) {
      throw new Error(`No enhancement overlay found for paper ${paperId}.`);
    }
    return {
      rootPath,
      paperId,
      ...payload
    };
  }

  return resolveCachedPayload(cache.enhancementPaperByKey, cacheKey, stamp, async () => {
    const payload = await loadPaperEnhancement(rootPath, paperId);
    if (!payload.overlay) {
      throw new Error(`No enhancement overlay found for paper ${paperId}.`);
    }
    return {
      rootPath,
      paperId,
      ...payload
    };
  });
}

function normalizeLlmProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'claude' || normalized === 'claudecode' || normalized === 'anthropic') return 'anthropic';
  if (normalized === 'openai') return 'openai';
  return 'ollama';
}

export function llmConfigPayload(config = {}) {
  const effective = resolveLlmConfig({
    llmProvider: config?.llm?.provider,
    llmModel: config?.llm?.model,
    llmBaseUrl: config?.llm?.baseUrl || config?.llm?.url,
    llmApiKeyEnv: config?.llm?.apiKeyEnv,
    llmApiKeySource: config?.llm?.apiKeySource,
    llmApiKeyService: config?.llm?.apiKeyService,
    llmApiKeyAccount: config?.llm?.apiKeyAccount,
    llmRelations: config?.llm?.relations,
    llmTimeoutMs: config?.llm?.timeoutMs,
    llmBatchSize: config?.llm?.batchSize,
    llmMaxTokens: config?.llm?.maxTokens,
    llmSshHost: config?.llm?.sshHost,
    ollamaModel: config?.ollama?.model,
    ollamaUrl: config?.ollama?.url,
    ollamaRelations: config?.ollama?.relations,
    ollamaTimeoutMs: config?.ollama?.timeoutMs,
    ollamaBatchSize: config?.ollama?.batchSize,
    ollamaSshHost: config?.ollama?.sshHost
  });

  return {
    llm: {
      provider: effective.provider,
      model: effective.model,
      baseUrl: effective.baseUrl,
      apiKeySource: config?.llm?.apiKeySource || effective.apiKeySource || '',
      apiKeyEnv: config?.llm?.apiKeyEnv || effective.apiKeyEnv || '',
      relations: effective.enabled,
      timeoutMs: effective.timeoutMs,
      batchSize: effective.batchSize,
      maxTokens: effective.maxTokens,
      sshHost: effective.sshHost || '',
      apiKeyService: config?.llm?.apiKeyService || effective.apiKeyService || '',
      apiKeyAccount: config?.llm?.apiKeyAccount || effective.apiKeyAccount || '',
      source: config?.llm ? 'llm' : config?.ollama ? 'ollama-legacy' : 'defaults'
    }
  };
}

export async function updateLlmConfigPayload(nextLlmConfig, options = {}) {
  const currentConfig = options.config && typeof options.config === 'object' ? options.config : {};
  const provider = normalizeLlmProvider(nextLlmConfig?.provider || currentConfig?.llm?.provider || currentConfig?.ollama?.provider || 'ollama');
  const model = String(nextLlmConfig?.model || '').trim();

  if (!model) {
    throw new Error('LLM model is required.');
  }

  const previousProvider = normalizeLlmProvider(currentConfig?.llm?.provider || currentConfig?.ollama?.provider || 'ollama');
  const previousBaseUrl = currentConfig?.llm?.baseUrl || currentConfig?.llm?.url || '';
  const previousDefaultAccount = buildDefaultLlmKeychainAccount({
    provider: previousProvider,
    baseUrl: previousBaseUrl || getDefaultLlmBaseUrl(previousProvider)
  });
  const shouldRotateBaseUrl = !previousBaseUrl || previousBaseUrl === getDefaultLlmBaseUrl(previousProvider);
  const nextBaseUrl = shouldRotateBaseUrl ? getDefaultLlmBaseUrl(provider) : previousBaseUrl;
  const currentApiKeyEnv = currentConfig?.llm?.apiKeyEnv || '';
  const previousDefaultApiKeyEnv = getDefaultLlmApiKeyEnv(previousProvider);
  const shouldRotateApiKeyEnv = !currentApiKeyEnv || currentApiKeyEnv === previousDefaultApiKeyEnv;
  const currentApiKeyAccount = currentConfig?.llm?.apiKeyAccount || '';
  const shouldRotateApiKeyAccount = !currentApiKeyAccount || currentApiKeyAccount === previousDefaultAccount;
  const nextConfig = {
    ...currentConfig,
    llm: {
      ...(currentConfig.llm || {}),
      provider,
      model,
      baseUrl: nextBaseUrl,
      relations: currentConfig?.llm?.relations ?? currentConfig?.ollama?.relations ?? true,
      timeoutMs: currentConfig?.llm?.timeoutMs ?? currentConfig?.ollama?.timeoutMs,
      batchSize: currentConfig?.llm?.batchSize ?? currentConfig?.ollama?.batchSize,
      maxTokens: currentConfig?.llm?.maxTokens,
      apiKeyEnv: shouldRotateApiKeyEnv
        ? getDefaultLlmApiKeyEnv(provider)
        : currentApiKeyEnv,
      apiKeySource: currentConfig?.llm?.apiKeySource,
      apiKeyService: currentConfig?.llm?.apiKeyService,
      apiKeyAccount: shouldRotateApiKeyAccount
        ? buildDefaultLlmKeychainAccount({ provider, baseUrl: nextBaseUrl })
        : currentApiKeyAccount,
      sshHost: currentConfig?.llm?.sshHost ?? currentConfig?.ollama?.sshHost
    }
  };

  const saved = await saveRuntimeConfig(nextConfig, {
    cwd: options.configBaseDir,
    path: options.configPath
  });

  return {
    ...llmConfigPayload(saved.config),
    configPath: saved.path,
    message: 'LLM configuration saved. Restart any running analyze/watch process to apply it there.'
  };
}
