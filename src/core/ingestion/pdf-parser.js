import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ensureDir, fileExists, listFilesRecursive, readText, removePath, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import { loadLlmApiKey, resolveLlmConfig } from '../llm/ollama.js';
import { createPdfParseTracker } from '../../storage/pdf-parse-store.js';

const PDF_PARSER_DOCLING = 'docling';
const PDF_PARSER_MARKITDOWN = 'markitdown';
const PDF_PARSER_MARKPDFDOWN = 'markpdfdown';
const PDF_PARSER_OPENDATALOADER = 'opendataloader';
const PDF_PARSER_MARKER = 'marker';
const PDF_PARSER_MINERU = 'mineru';
const PDF_PARSER_PADDLEOCR_VL = 'paddleocr-vl';
const DEFAULT_PDF_PARSER = PDF_PARSER_MARKITDOWN;
const DEFAULT_PDF_PARSE_TIMEOUT_MS = 100_000;
const DEFAULT_MINERU_PROBE_CACHE_TTL_MS = 15_000;
const DEFAULT_DOCLING_DEVICE = 'cuda';
const DEFAULT_DOCLING_IMAGE_EXPORT_MODE = 'placeholder';
const DEFAULT_DOCLING_PRELOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOCLING_GPU_LOCK_ROOT = '/tmp/papernexus-gpu-locks';
const DEFAULT_DOCLING_GPU_MIN_FREE_MB = 18_000;
const DEFAULT_DOCLING_GPU_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_DOCLING_GPU_POLL_INTERVAL_MS = 5000;
const DEFAULT_DOCLING_GPU_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DOCLING_CPU_THREADS = 4;
const DEFAULT_HUGGINGFACE_ENDPOINT = 'https://hf-mirror.com';
const DEFAULT_DOCLING_HF_HOME = path.join(os.homedir(), '.cache', 'papernexus', 'huggingface');
const mineruProbeCache = new Map();
const doclingWarmupCache = new Map();
const MARKITDOWN_WRAPPER_PATH = fileURLToPath(new URL('../../../scripts/markitdown_to_markdown.py', import.meta.url));
const MARKPDFDOWN_WRAPPER_PATH = fileURLToPath(new URL('../../../scripts/markpdfdown_to_markdown.py', import.meta.url));
const DOCLING_WRAPPER_PATH = fileURLToPath(new URL('../../../scripts/docling_to_markdown.py', import.meta.url));
const OPENDATALOADER_PDF_WRAPPER_PATH = fileURLToPath(new URL('../../../scripts/opendataloader_pdf_to_markdown.py', import.meta.url));
const PADDLEOCR_VL_WRAPPER_PATH = fileURLToPath(new URL('../../../scripts/paddleocr_vl_to_markdown.py', import.meta.url));

const PDF_PARSER_PROFILES = {
  [PDF_PARSER_MARKITDOWN]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 2,
    remoteConcurrency: 2,
    allowLlmConcurrencyBoost: false,
    leaseStrategy: 'none'
  },
  [PDF_PARSER_MARKPDFDOWN]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 1,
    remoteConcurrency: 1,
    allowLlmConcurrencyBoost: false,
    leaseStrategy: 'none'
  },
  [PDF_PARSER_OPENDATALOADER]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 2,
    remoteConcurrency: 2,
    leaseStrategy: 'none'
  },
  [PDF_PARSER_MARKER]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 1,
    remoteConcurrency: 4,
    allowLlmConcurrencyBoost: false,
    leaseStrategy: 'none'
  },
  [PDF_PARSER_DOCLING]: {
    fallbackParser: '',
    localConcurrency: 4,
    remoteConcurrency: 6,
    leaseStrategy: 'docling-gpu'
  },
  [PDF_PARSER_MINERU]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 3,
    remoteConcurrency: 6,
    leaseStrategy: 'none'
  },
  [PDF_PARSER_PADDLEOCR_VL]: {
    fallbackParser: PDF_PARSER_DOCLING,
    localConcurrency: 1,
    remoteConcurrency: 1,
    allowLlmConcurrencyBoost: false,
    leaseStrategy: 'none'
  }
};

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 0);
    const timeoutLabel = String(options.timeoutLabel || command);
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      options.onStdout?.(chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`));
    });
  });
}

function runCommandWithStdin(command, args, stdinBuffer, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 0);
    const timeoutLabel = String(options.timeoutLabel || command);
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      options.onStdout?.(chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`));
    });

    child.stdin.end(stdinBuffer);
  });
}

function createProgressReporter(label, tracker = null) {
  let trailing = '';

  const report = (chunk) => {
    const normalized = String(chunk).replace(/\r/g, '\n');
    const combined = trailing + normalized;
    const lines = combined.split('\n');
    trailing = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      process.stderr.write(`[${label}] ${trimmed}\n`);
      if (tracker?.log) {
        void tracker.log('info', trimmed).catch(() => {});
      }
    }
  };

  report.flush = () => {
    const trimmed = trailing.trimEnd();
    if (trimmed) {
      process.stderr.write(`[${label}] ${trimmed}\n`);
      if (tracker?.log) {
        void tracker.log('info', trimmed).catch(() => {});
      }
    }
    trailing = '';
  };

  return report;
}

function flushProgressReporter(reporter) {
  reporter.flush?.();
}

async function resolvePdfParseTracker(pdfPath, parser, options = {}) {
  if (options.pdfParseTracker) {
    return {
      tracker: options.pdfParseTracker,
      owned: false
    };
  }

  const tracker = await createPdfParseTracker(pdfPath, parser, {
    selectedParser: options.pdfParseSelectedParser || normalizePdfParser(options.pdfParser || parser),
    fallbackFromParser: options.pdfParseFallbackFrom || null,
    rootPath: options.rootPath,
    sourceKey: options.sourceKey,
    importTaskId: options.importTaskId,
    importStage: options.importStage,
    pdfParseStateRoot: options.pdfParseStateRoot
  });

  return {
    tracker,
    owned: true
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function normalizePdfParser(value) {
  const normalized = String(value || process.env.PAPERNEXUS_PDF_PARSER || DEFAULT_PDF_PARSER).trim().toLowerCase();
  if (normalized === PDF_PARSER_MARKITDOWN) return PDF_PARSER_MARKITDOWN;
  if (normalized === PDF_PARSER_MARKPDFDOWN) return PDF_PARSER_MARKPDFDOWN;
  if (normalized === PDF_PARSER_OPENDATALOADER) return PDF_PARSER_OPENDATALOADER;
  if (normalized === PDF_PARSER_MARKER) return PDF_PARSER_MARKER;
  if (normalized === PDF_PARSER_MINERU) return PDF_PARSER_MINERU;
  if (normalized === PDF_PARSER_PADDLEOCR_VL) return PDF_PARSER_PADDLEOCR_VL;
  return PDF_PARSER_DOCLING;
}

export function getPdfParserProfile(parserName, options = {}) {
  const parser = normalizePdfParser(parserName);
  const baseProfile = PDF_PARSER_PROFILES[parser] || PDF_PARSER_PROFILES[PDF_PARSER_DOCLING];
  const hasRemoteRuntime = Boolean(
    options.doclingSshHost
    || options.markerSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || options.mineruHttpUrl
  );
  return {
    parser,
    ...baseProfile,
    hasRemoteRuntime,
    recommendedConcurrency: hasRemoteRuntime ? baseProfile.remoteConcurrency : baseProfile.localConcurrency
  };
}

function resolvePdfParserFallback(parserName, options = {}) {
  if (options.disableDoclingFallback) return '';
  const parser = normalizePdfParser(parserName);
  return getPdfParserProfile(parser, options).fallbackParser || '';
}

function resolveMarkItDownPython(options = {}) {
  return String(
    options.markitdownPython
    || options.pythonCommand
    || process.env.PAPERNEXUS_MARKITDOWN_PYTHON
    || process.env.PAPERNEXUS_PYTHON_COMMAND
    || 'python3'
  ).trim() || 'python3';
}

function resolveMarkItDownUseLlm(options = {}) {
  return normalizeBooleanOption(
    options.markitdownUseLlm ?? process.env.PAPERNEXUS_MARKITDOWN_USE_LLM,
    true
  );
}

function resolveMarkItDownEnablePlugins(options = {}) {
  return normalizeBooleanOption(
    options.markitdownEnablePlugins ?? process.env.PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS,
    resolveMarkItDownUseLlm(options)
  );
}

function hasExplicitMarkItDownUseLlmSetting(options = {}) {
  return options.markitdownUseLlm !== undefined
    || process.env.PAPERNEXUS_MARKITDOWN_USE_LLM !== undefined;
}

function hasExplicitMarkItDownEnablePluginsSetting(options = {}) {
  return options.markitdownEnablePlugins !== undefined
    || process.env.PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS !== undefined;
}

function resolveMarkItDownLlmPrompt(options = {}) {
  return String(
    options.markitdownLlmPrompt
    || process.env.PAPERNEXUS_MARKITDOWN_LLM_PROMPT
    || ''
  ).trim();
}

function resolvePdfParserCommandOption(parserName, options = {}) {
  const parser = normalizePdfParser(parserName);
  if (parser === PDF_PARSER_MARKITDOWN) {
    return options.markitdownPython || options.pdfCommand;
  }
  if (parser === PDF_PARSER_MARKPDFDOWN) {
    return options.markpdfdownPython || options.pdfCommand;
  }
  if (parser === PDF_PARSER_OPENDATALOADER) {
    return options.opendataloaderPdfPython || options.pdfCommand;
  }
  if (parser === PDF_PARSER_MARKER) {
    return options.markerCommand || options.pdfCommand;
  }
  if (parser === PDF_PARSER_MINERU) {
    return options.mineruCommand || options.pdfCommand;
  }
  if (parser === PDF_PARSER_PADDLEOCR_VL) {
    return options.paddleocrVlPython || options.pdfCommand;
  }
  return options.doclingCommand || options.pdfCommand;
}

function resolveMarkPdfDownPython(options = {}) {
  return String(
    options.markpdfdownPython
    || options.pythonCommand
    || process.env.PAPERNEXUS_MARKPDFDOWN_PYTHON
    || process.env.PAPERNEXUS_PYTHON_COMMAND
    || 'python3'
  ).trim() || 'python3';
}

function resolveOpenDataLoaderPdfPython(options = {}) {
  return String(
    options.opendataloaderPdfPython
    || options.pythonCommand
    || process.env.PAPERNEXUS_OPENDATALOADER_PDF_PYTHON
    || process.env.PAPERNEXUS_PYTHON_COMMAND
    || 'python3'
  ).trim() || 'python3';
}

function resolveDoclingPython(options = {}) {
  return String(
    options.doclingPython
    || options.pythonCommand
    || process.env.PAPERNEXUS_DOCLING_PYTHON
    || process.env.PAPERNEXUS_PYTHON_COMMAND
    || 'python3'
  ).trim() || 'python3';
}

function resolveDoclingUseVlm(options = {}) {
  const raw = options.doclingUseVlm ?? process.env.PAPERNEXUS_DOCLING_USE_VLM ?? false;
  return raw === true || raw === '1' || raw === 'true';
}

function resolveDoclingVlmPreset(options = {}) {
  return String(
    options.doclingVlmPreset
    || process.env.PAPERNEXUS_DOCLING_VLM_PRESET
    || 'granite_docling'
  ).trim() || 'granite_docling';
}

function normalizeBooleanOption(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(value);
}

function resolvePositiveInteger(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return defaultValue;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function resolveDoclingDevice(options = {}) {
  return String(
    options.doclingDevice
    || process.env.PAPERNEXUS_DOCLING_DEVICE
    || DEFAULT_DOCLING_DEVICE
  ).trim() || DEFAULT_DOCLING_DEVICE;
}

function doclingUsesCuda(options = {}) {
  return resolveDoclingDevice(options).trim().toLowerCase().startsWith('cuda');
}

function resolveDoclingCudaVisibleDevices(options = {}) {
  const value = String(
    options.doclingCudaVisibleDevices
    ?? process.env.PAPERNEXUS_DOCLING_CUDA_VISIBLE_DEVICES
    ?? process.env.CUDA_VISIBLE_DEVICES
    ?? ''
  ).trim();
  return value.toLowerCase() === 'auto' ? '' : value;
}

function resolveDoclingAutoGpu(options = {}) {
  return normalizeBooleanOption(
    options.doclingAutoGpu ?? process.env.PAPERNEXUS_DOCLING_AUTO_GPU,
    true
  );
}

function resolveDoclingGpuLockRoot(options = {}) {
  return String(
    options.doclingGpuLockRoot
    || process.env.PAPERNEXUS_DOCLING_GPU_LOCK_ROOT
    || process.env.PAPERNEXUS_GPU_LOCK_ROOT
    || DEFAULT_DOCLING_GPU_LOCK_ROOT
  ).trim() || DEFAULT_DOCLING_GPU_LOCK_ROOT;
}

function resolveDoclingGpuMinFreeMb(options = {}) {
  return resolvePositiveInteger(
    options.doclingGpuMinFreeMb ?? process.env.PAPERNEXUS_DOCLING_GPU_MIN_FREE_MB,
    DEFAULT_DOCLING_GPU_MIN_FREE_MB
  );
}

function resolveDoclingGpuWaitTimeoutMs(options = {}) {
  return resolvePositiveInteger(
    options.doclingGpuWaitTimeoutMs ?? process.env.PAPERNEXUS_DOCLING_GPU_WAIT_TIMEOUT_MS,
    DEFAULT_DOCLING_GPU_WAIT_TIMEOUT_MS
  );
}

function resolveDoclingGpuPollIntervalMs(options = {}) {
  return resolvePositiveInteger(
    options.doclingGpuPollIntervalMs ?? process.env.PAPERNEXUS_DOCLING_GPU_POLL_INTERVAL_MS,
    DEFAULT_DOCLING_GPU_POLL_INTERVAL_MS,
    { min: 250 }
  );
}

function resolveDoclingGpuLockStaleMs(options = {}) {
  return resolvePositiveInteger(
    options.doclingGpuLockStaleMs ?? process.env.PAPERNEXUS_DOCLING_GPU_LOCK_STALE_MS,
    DEFAULT_DOCLING_GPU_LOCK_STALE_MS
  );
}

function resolveDoclingCpuThreads(options = {}) {
  return resolvePositiveInteger(
    options.doclingCpuThreads
    ?? process.env.PAPERNEXUS_DOCLING_CPU_THREADS
    ?? process.env.PAPERNEXUS_PDF_CPU_THREADS,
    DEFAULT_DOCLING_CPU_THREADS
  );
}

function resolveDoclingArtifactsPath(options = {}) {
  return String(
    options.doclingArtifactsPath
    || process.env.PAPERNEXUS_DOCLING_ARTIFACTS_PATH
    || ''
  ).trim();
}

function resolveDoclingImageExportMode(options = {}) {
  return String(
    options.doclingImageExportMode
    || process.env.PAPERNEXUS_DOCLING_IMAGE_EXPORT_MODE
    || DEFAULT_DOCLING_IMAGE_EXPORT_MODE
  ).trim() || DEFAULT_DOCLING_IMAGE_EXPORT_MODE;
}

function resolveDoclingEnrichPictureClasses(options = {}) {
  return normalizeBooleanOption(
    options.doclingEnrichPictureClasses ?? process.env.PAPERNEXUS_DOCLING_ENRICH_PICTURE_CLASSES,
    false
  );
}

function resolveDoclingEnrichPictureDescription(options = {}) {
  return normalizeBooleanOption(
    options.doclingEnrichPictureDescription ?? process.env.PAPERNEXUS_DOCLING_ENRICH_PICTURE_DESCRIPTION,
    false
  );
}

function resolveDoclingPreload(options = {}) {
  return normalizeBooleanOption(
    options.doclingPreload ?? process.env.PAPERNEXUS_DOCLING_PRELOAD,
    true
  );
}

function resolveDoclingPreloadTimeoutMs(options = {}) {
  const raw = Number(
    options.doclingPreloadTimeoutMs
    ?? process.env.PAPERNEXUS_DOCLING_PRELOAD_TIMEOUT_MS
    ?? DEFAULT_DOCLING_PRELOAD_TIMEOUT_MS
  );
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DOCLING_PRELOAD_TIMEOUT_MS;
  return Math.max(1, Math.round(raw));
}

function buildDoclingHuggingFaceEnv(options = {}) {
  const hfEndpoint = firstNonEmptyString(
    options.doclingHfEndpoint,
    options.hfEndpoint,
    process.env.PAPERNEXUS_DOCLING_HF_ENDPOINT,
    process.env.PAPERNEXUS_HF_ENDPOINT,
    process.env.HF_ENDPOINT,
    DEFAULT_HUGGINGFACE_ENDPOINT
  );
  const hfHome = firstNonEmptyString(
    options.doclingHfHome,
    options.hfHome,
    process.env.PAPERNEXUS_DOCLING_HF_HOME,
    process.env.PAPERNEXUS_HF_HOME,
    process.env.HF_HOME,
    DEFAULT_DOCLING_HF_HOME
  );
  const hfHubCache = firstNonEmptyString(
    options.doclingHfHubCache,
    options.hfHubCache,
    process.env.PAPERNEXUS_DOCLING_HF_HUB_CACHE,
    process.env.PAPERNEXUS_HF_HUB_CACHE,
    process.env.HF_HUB_CACHE,
    path.join(hfHome, 'hub')
  );
  const transformersCache = firstNonEmptyString(
    options.doclingTransformersCache,
    options.transformersCache,
    process.env.PAPERNEXUS_DOCLING_TRANSFORMERS_CACHE,
    process.env.PAPERNEXUS_TRANSFORMERS_CACHE,
    process.env.TRANSFORMERS_CACHE,
    path.join(hfHome, 'transformers')
  );
  const hfHubDisableTelemetry = firstNonEmptyString(
    options.doclingHfHubDisableTelemetry,
    options.hfHubDisableTelemetry,
    process.env.PAPERNEXUS_DOCLING_HF_HUB_DISABLE_TELEMETRY,
    process.env.PAPERNEXUS_HF_HUB_DISABLE_TELEMETRY,
    process.env.HF_HUB_DISABLE_TELEMETRY,
    '1'
  );

  return {
    HF_ENDPOINT: hfEndpoint,
    HF_HOME: hfHome,
    HF_HUB_CACHE: hfHubCache,
    TRANSFORMERS_CACHE: transformersCache,
    HF_HUB_DISABLE_TELEMETRY: hfHubDisableTelemetry
  };
}

function resolvePaddleOcrVlPython(options = {}) {
  return String(
    options.paddleocrVlPython
    || options.pythonCommand
    || process.env.PAPERNEXUS_PADDLEOCR_VL_PYTHON
    || process.env.PAPERNEXUS_PYTHON_COMMAND
    || 'python3'
  ).trim() || 'python3';
}

function resolvePaddleOcrVlServerUrl(options = {}) {
  return String(
    options.paddleocrVlServerUrl
    || process.env.PAPERNEXUS_PADDLEOCR_VL_SERVER_URL
    || 'http://127.0.0.1:8080/v1'
  ).trim() || 'http://127.0.0.1:8080/v1';
}

function resolvePaddleOcrVlLayoutModel(options = {}) {
  return String(
    options.paddleocrVlLayoutModel
    || process.env.PAPERNEXUS_PADDLEOCR_VL_LAYOUT_MODEL
    || 'PP-DocLayout-S'
  ).trim() || 'PP-DocLayout-S';
}

function resolveMarkPdfDownTemperature(options = {}) {
  const raw = Number(options.markpdfdownTemperature ?? process.env.PAPERNEXUS_MARKPDFDOWN_TEMPERATURE ?? 0.3);
  if (!Number.isFinite(raw)) return 0.3;
  return raw;
}

function resolveMarkPdfDownRetryTimes(options = {}) {
  const raw = Number(options.markpdfdownRetryTimes ?? process.env.PAPERNEXUS_MARKPDFDOWN_RETRY_TIMES ?? 3);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.max(1, Math.round(raw));
}

function normalizeMarkPdfDownModelName(provider, model) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return '';
  if (normalizedModel.includes('/')) return normalizedModel;
  if (normalizedProvider === 'openai') return `openai/${normalizedModel}`;
  if (normalizedProvider === 'anthropic') return `anthropic/${normalizedModel}`;
  if (normalizedProvider === 'ollama') return `ollama/${normalizedModel}`;
  return normalizedModel;
}

function resolveMarkPdfDownPageWindow(pageRange) {
  const normalized = String(pageRange || '').trim();
  if (!normalized) {
    return {
      startPage: 1,
      endPage: 0
    };
  }

  if (/^\d+$/.test(normalized)) {
    const singlePage = Math.max(1, Number(normalized));
    return {
      startPage: singlePage,
      endPage: singlePage
    };
  }

  const rangeMatch = normalized.match(/^(\d+)\s*-\s*(\d+)?$/);
  if (rangeMatch) {
    const startPage = Math.max(1, Number(rangeMatch[1] || 1));
    const endPage = rangeMatch[2] ? Math.max(startPage, Number(rangeMatch[2])) : 0;
    return {
      startPage,
      endPage
    };
  }

  return {
    startPage: 1,
    endPage: 0
  };
}

async function buildMarkPdfDownRuntime(options = {}) {
  const llmConfig = resolveLlmConfig(options);
  const provider = String(llmConfig.provider || '').trim().toLowerCase();
  const modelName = normalizeMarkPdfDownModelName(provider, llmConfig.model);

  if (!modelName) {
    throw new Error(
      'MarkPDFDown requires a configured LLM model. Set `llm.model` in PaperNexus config or pass `--model` / `--ollama-model`.'
    );
  }

  const apiKey = llmConfig.apiKey || await loadLlmApiKey(llmConfig);
  if ((provider === 'openai' || provider === 'anthropic') && !apiKey) {
    throw new Error(
      `MarkPDFDown requires an API key for the ${provider} provider. `
      + `Configure \`llm.apiKey\`, \`llm.apiKeySource="keychain"\`, or ${llmConfig.apiKeyEnv || 'the provider API key env var'}.`
    );
  }

  const env = {
    MODEL_NAME: modelName,
    TEMPERATURE: String(resolveMarkPdfDownTemperature(options)),
    MAX_TOKENS: String(
      Number.isFinite(Number(options.markpdfdownMaxTokens ?? llmConfig.maxTokens))
        ? Number(options.markpdfdownMaxTokens ?? llmConfig.maxTokens)
        : 8192
    ),
    RETRY_TIMES: String(resolveMarkPdfDownRetryTimes(options))
  };

  if (provider === 'openai') {
    env.OPENAI_API_KEY = apiKey;
    if (llmConfig.baseUrl) {
      env.OPENAI_BASE_URL = llmConfig.baseUrl;
      env.OPENAI_API_BASE = llmConfig.baseUrl;
    }
  } else if (provider === 'anthropic') {
    env.ANTHROPIC_API_KEY = apiKey;
    if (llmConfig.baseUrl) {
      env.ANTHROPIC_BASE_URL = llmConfig.baseUrl;
      env.ANTHROPIC_API_BASE = llmConfig.baseUrl;
    }
  } else if (provider === 'ollama' && llmConfig.baseUrl) {
    env.OLLAMA_API_BASE = llmConfig.baseUrl;
  }

  return {
    llmConfig,
    modelName,
    env
  };
}

async function buildMarkItDownRuntime(options = {}) {
  const requestedUseLlm = resolveMarkItDownUseLlm(options);
  const explicitUseLlm = hasExplicitMarkItDownUseLlmSetting(options);
  const requestedEnablePlugins = resolveMarkItDownEnablePlugins(options);
  const explicitEnablePlugins = hasExplicitMarkItDownEnablePluginsSetting(options);
  const env = {
    PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS: '0'
  };

  if (!requestedUseLlm) {
    return {
      useLlm: false,
      enablePlugins: requestedEnablePlugins,
      env
    };
  }

  const llmConfig = resolveLlmConfig(options);
  const provider = String(llmConfig.provider || '').trim().toLowerCase();
  if (provider === 'anthropic') {
    throw new Error('MarkItDown LLM mode currently expects an OpenAI-compatible client. Use an openai/ollama-style PaperNexus profile instead of Anthropic.');
  }

  const modelName = String(llmConfig.model || '').trim();
  const baseUrl = String(llmConfig.baseUrl || '').trim();
  const missingPrereqs = [];
  if (!modelName) missingPrereqs.push('llm.model');
  if (!baseUrl) missingPrereqs.push('llm.baseUrl');

  if (missingPrereqs.length) {
    if (explicitUseLlm) {
      throw new Error(
        `MarkItDown LLM mode requires ${missingPrereqs.join(' and ')}. `
        + 'Configure those fields in PaperNexus `llm.*` config or disable `markitdownUseLlm`.'
      );
    }
    return {
      useLlm: false,
      enablePlugins: explicitEnablePlugins ? requestedEnablePlugins : false,
      env
    };
  }

  const apiKey = llmConfig.apiKey || await loadLlmApiKey(llmConfig);
  if (provider !== 'ollama' && !apiKey) {
    if (explicitUseLlm) {
      throw new Error(
        `MarkItDown LLM mode requires an API key for provider \`${provider || 'openai-compatible'}\`. `
        + `Configure \`llm.apiKey\`, \`llm.apiKeySource="keychain"\`, or ${llmConfig.apiKeyEnv || 'the provider API key env var'}.`
      );
    }
    return {
      useLlm: false,
      enablePlugins: explicitEnablePlugins ? requestedEnablePlugins : false,
      env
    };
  }

  const enablePlugins = explicitEnablePlugins ? requestedEnablePlugins : true;
  env.PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS = enablePlugins ? '1' : '0';
  env.PAPERNEXUS_MARKITDOWN_USE_LLM = '1';
  env.PAPERNEXUS_MARKITDOWN_LLM_MODEL = modelName;
  env.PAPERNEXUS_MARKITDOWN_LLM_BASE_URL = baseUrl;
  env.PAPERNEXUS_MARKITDOWN_LLM_API_KEY = apiKey || 'ollama';

  const prompt = resolveMarkItDownLlmPrompt(options);
  if (prompt) {
    env.PAPERNEXUS_MARKITDOWN_LLM_PROMPT = prompt;
  }

  return {
    useLlm: true,
    enablePlugins,
    llmConfig,
    modelName,
    env
  };
}

function normalizeDoclingChatCompletionsUrl(baseUrl = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  if (normalized.endsWith('/chat/completions')) return normalized;
  return `${normalized}/chat/completions`;
}

async function buildDoclingVlmRuntime(options = {}) {
  if (!resolveDoclingUseVlm(options)) {
    return null;
  }

  const llmConfig = resolveLlmConfig(options);
  const provider = String(llmConfig.provider || '').trim().toLowerCase();
  if (provider === 'anthropic') {
    throw new Error('Docling VLM currently supports openai-compatible or ollama endpoints, not Anthropic-compatible message APIs.');
  }

  const modelName = String(llmConfig.model || '').trim();
  if (!modelName) {
    throw new Error('Docling VLM requires a configured LLM model. Set `llm.model` in PaperNexus config or pass `--model` / `--ollama-model`.');
  }

  const apiKey = llmConfig.apiKey || await loadLlmApiKey(llmConfig);
  const env = {};
  if (apiKey) {
    env.PAPERNEXUS_DOCLING_VLM_API_KEY = apiKey;
  }

  const baseUrl = normalizeDoclingChatCompletionsUrl(llmConfig.baseUrl);
  if (!baseUrl) {
    throw new Error('Docling VLM requires an OpenAI-compatible base URL. Configure `llm.baseUrl` or use an ollama/openai profile with a resolved base URL.');
  }

  return {
    llmConfig,
    env,
    provider,
    modelName,
    baseUrl,
    preset: resolveDoclingVlmPreset(options),
    maxTokens: Number.isFinite(Number(options.doclingVlmMaxTokens ?? llmConfig.maxTokens))
      ? Number(options.doclingVlmMaxTokens ?? llmConfig.maxTokens)
      : 4096
  };
}

function resolveRemoteMarkerHost(options = {}) {
  return options.markerSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || process.env.PAPERNEXUS_MARKER_SSH_HOST
    || process.env.PAPERNEXUS_PDF_PARSER_SSH_HOST
    || '';
}

function normalizeMarkerBlockName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['table', 'tables'].includes(normalized)) return 'table';
  if (['image', 'images', 'picture', 'pictures', 'figure', 'figures'].includes(normalized)) return 'image';
  return '';
}

function resolveMarkerBlockBlacklist(options = {}) {
  const raw = options.markerBlockBlacklist ?? process.env.PAPERNEXUS_MARKER_BLOCK_BLACKLIST ?? [];
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const normalized = [];
  for (const value of values) {
    const candidate = normalizeMarkerBlockName(value);
    if (candidate && !normalized.includes(candidate)) {
      normalized.push(candidate);
    }
  }
  return normalized;
}

function isMarkdownTableBlock(block) {
  const lines = String(block || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  if (/<table[\s>]/i.test(block)) return true;
  if (lines.length < 2) return false;
  const separatorPattern = /^\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?$/;
  const separatorIndex = lines.findIndex((line) => separatorPattern.test(line));
  if (separatorIndex <= 0) return false;
  return lines.every((line) => line.includes('|') || separatorPattern.test(line));
}

function isImageBlock(block) {
  const trimmed = String(block || '').trim();
  if (!trimmed) return false;
  return /^!\[[^\]]*\]\([^)]+\)(?:\s*\n.*)?$/s.test(trimmed)
    || /^<img[\s\S]*?>$/i.test(trimmed)
    || /^<figure[\s\S]*<\/figure>$/i.test(trimmed);
}

function filterMarkerMarkdown(markdown, blacklist = []) {
  const normalizedBlacklist = Array.isArray(blacklist) ? blacklist : resolveMarkerBlockBlacklist({
    markerBlockBlacklist: blacklist
  });
  if (!normalizedBlacklist.length) {
    return markdown;
  }

  const dropTables = normalizedBlacklist.includes('table');
  const dropImages = normalizedBlacklist.includes('image');
  const blocks = String(markdown || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  const filteredBlocks = [];

  for (const block of blocks) {
    let nextBlock = String(block || '').trim();
    if (!nextBlock) continue;
    if (dropTables && isMarkdownTableBlock(nextBlock)) continue;
    if (dropImages && isImageBlock(nextBlock)) continue;
    if (dropImages) {
      nextBlock = nextBlock
        .replace(/<figure[\s\S]*?<\/figure>/gi, '')
        .replace(/^\s*!\[[^\]]*\]\([^)]+\)\s*$/gm, '')
        .replace(/^\s*<img[\s\S]*?>\s*$/gim, '')
        .trim();
    }
    if (nextBlock) {
      filteredBlocks.push(nextBlock);
    }
  }

  return filteredBlocks.length ? `${filteredBlocks.join('\n\n').trim()}\n` : '';
}

function resolveRemoteDoclingHost(options = {}) {
  return options.doclingSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || process.env.PAPERNEXUS_DOCLING_SSH_HOST
    || process.env.PAPERNEXUS_PDF_PARSER_SSH_HOST
    || '';
}

function buildDoclingCliArgv({
  inputPath,
  outputPath,
  ocrEngine = '',
  pdfBackend = '',
  device = DEFAULT_DOCLING_DEVICE,
  artifactsPath = '',
  imageExportMode = DEFAULT_DOCLING_IMAGE_EXPORT_MODE,
  enrichPictureClasses = false,
  enrichPictureDescription = false
} = {}) {
  const argv = [
    inputPath,
    '--device',
    device || DEFAULT_DOCLING_DEVICE,
    '--output',
    outputPath,
    '--image-export-mode',
    imageExportMode || DEFAULT_DOCLING_IMAGE_EXPORT_MODE
  ];
  if (artifactsPath) {
    argv.push('--artifacts-path', artifactsPath);
  }
  if (!enrichPictureClasses) {
    argv.push('--no-enrich-picture-classes');
  }
  if (!enrichPictureDescription) {
    argv.push('--no-enrich-picture-description');
  }
  if (ocrEngine) {
    argv.push('--ocr-engine', ocrEngine);
  }
  if (pdfBackend) {
    argv.push('--pdf-backend', pdfBackend);
  }
  return argv;
}

function parseNvidiaSmiGpuLines(raw = '') {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(',').map((part) => part.trim());
      const index = parts[0];
      const name = parts.length > 2 ? parts.slice(1, -1).join(', ').trim() : (parts[1] || '');
      const freeMemoryMb = Number(parts[parts.length - 1]);
      if (!index || !Number.isFinite(freeMemoryMb)) return null;
      return {
        index,
        name,
        freeMemoryMb
      };
    })
    .filter(Boolean);
}

async function queryAvailableNvidiaGpus(options = {}) {
  try {
    const { stdout } = await runCommand('nvidia-smi', [
      '--query-gpu=index,name,memory.free',
      '--format=csv,noheader,nounits'
    ], {
      timeoutMs: resolvePositiveInteger(
        options.doclingGpuProbeTimeoutMs ?? process.env.PAPERNEXUS_DOCLING_GPU_PROBE_TIMEOUT_MS,
        5000,
        { min: 250 }
      ),
      timeoutLabel: 'nvidia-smi GPU probe'
    });
    return parseNvidiaSmiGpuLines(stdout);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    return [];
  }
}

async function cleanupStaleGpuLocks(lockRoot, staleMs) {
  try {
    const entries = await fs.readdir(lockRoot, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^gpu-.+\.lock$/.test(entry.name)) return;
      const lockPath = path.join(lockRoot, entry.name);
      try {
        const stats = await fs.stat(lockPath);
        if (now - Number(stats.mtimeMs || now) >= staleMs) {
          await fs.rm(lockPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore races with other workers creating/removing the same lock.
      }
    }));
  } catch {
    // Missing or unreadable lock roots should not prevent a fresh mkdir attempt.
  }
}

function shouldUseDoclingGpuScheduler(options = {}) {
  if (!doclingUsesCuda(options)) return false;
  if (!resolveDoclingAutoGpu(options)) return false;
  return !resolveDoclingCudaVisibleDevices(options);
}

async function acquireDoclingGpuLease(options = {}, label = 'docling', tracker = null) {
  if (!shouldUseDoclingGpuScheduler(options)) {
    return null;
  }

  const lockRoot = resolveDoclingGpuLockRoot(options);
  const minFreeMb = resolveDoclingGpuMinFreeMb(options);
  const waitTimeoutMs = resolveDoclingGpuWaitTimeoutMs(options);
  const pollIntervalMs = resolveDoclingGpuPollIntervalMs(options);
  const staleMs = resolveDoclingGpuLockStaleMs(options);
  const startedAt = Date.now();
  let lastMessageAt = 0;

  await fs.mkdir(lockRoot, { recursive: true });
  await tracker?.update?.({
    status: 'waiting-resource',
    currentStep: 'waiting for available docling GPU',
    message: `Waiting for a Docling GPU with >= ${minFreeMb} MiB free memory`,
    activeParser: PDF_PARSER_DOCLING
  });

  while (true) {
    await cleanupStaleGpuLocks(lockRoot, staleMs);
    const probedGpus = await queryAvailableNvidiaGpus(options);
    if (probedGpus === null) {
      process.stderr.write(`[${label}] nvidia-smi not found; running Docling without automatic GPU scheduling\n`);
      await tracker?.log?.('warn', 'nvidia-smi not found; running without automatic GPU scheduling');
      return null;
    }
    const gpus = probedGpus
      .filter((gpu) => gpu.freeMemoryMb >= minFreeMb)
      .sort((left, right) => right.freeMemoryMb - left.freeMemoryMb);

    for (const gpu of gpus) {
      const lockPath = path.join(lockRoot, `gpu-${gpu.index}.lock`);
      try {
        await fs.mkdir(lockPath);
        await writeText(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          pid: process.pid,
          label,
          gpuIndex: gpu.index,
          gpuName: gpu.name,
          freeMemoryMb: gpu.freeMemoryMb,
          acquiredAt: new Date().toISOString()
        }, null, 2)}\n`);
        const waitMs = Date.now() - startedAt;
        process.stderr.write(
          `[${label}] Using GPU ${gpu.index}${gpu.name ? ` (${gpu.name})` : ''} with ${gpu.freeMemoryMb} MiB free memory`
          + (waitMs > 0 ? ` after waiting ${waitMs}ms` : '')
          + '\n'
        );
        await tracker?.update?.({
          status: 'running',
          currentStep: `using GPU ${gpu.index}`,
          message: `Using GPU ${gpu.index}${gpu.name ? ` (${gpu.name})` : ''}`,
          activeParser: PDF_PARSER_DOCLING,
          gpuIndex: gpu.index,
          gpuName: gpu.name,
          gpuFreeMemoryMb: gpu.freeMemoryMb
        });
        return {
          gpuIndex: gpu.index,
          env: {
            CUDA_VISIBLE_DEVICES: String(gpu.index),
            PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True'
          },
          async release() {
            await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
          }
        };
      } catch {
        // Another parser won this GPU slot; try the next candidate.
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= waitTimeoutMs) {
      throw new Error(
        `Timed out waiting ${waitTimeoutMs}ms for an available Docling GPU with at least ${minFreeMb} MiB free memory.`
      );
    }

    if (Date.now() - lastMessageAt >= Math.max(1000, pollIntervalMs)) {
      lastMessageAt = Date.now();
      process.stderr.write(
        `[${label}] Waiting for an available Docling GPU slot (minFreeMb=${minFreeMb}, elapsedMs=${elapsedMs})\n`
      );
      await tracker?.update?.({
        status: 'waiting-resource',
        currentStep: 'waiting for available docling GPU',
        message: `Waiting for Docling GPU slot (elapsed ${elapsedMs}ms)`,
        activeParser: PDF_PARSER_DOCLING
      });
    }
    await sleep(pollIntervalMs);
  }
}

function buildDoclingThreadEnv(options = {}) {
  const threads = String(resolveDoclingCpuThreads(options));
  return {
    OPENBLAS_NUM_THREADS: threads,
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    VECLIB_MAXIMUM_THREADS: threads
  };
}

function buildDoclingExecutionEnv(options = {}) {
  const env = {};
  const cudaVisibleDevices = resolveDoclingCudaVisibleDevices(options);
  if (cudaVisibleDevices) {
    env.CUDA_VISIBLE_DEVICES = cudaVisibleDevices;
    env.PYTORCH_CUDA_ALLOC_CONF = process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True';
  }
  return {
    ...buildDoclingHuggingFaceEnv(options),
    ...buildDoclingThreadEnv(options),
    ...env
  };
}

function buildPdfParserExecutionEnv(parserName, options = {}) {
  const parser = normalizePdfParser(parserName);
  if (parser === PDF_PARSER_DOCLING) {
    return buildDoclingExecutionEnv(options);
  }
  return {};
}

async function acquirePdfParserLease(parserName, options = {}, label = 'pdf-parser', tracker = null) {
  const profile = getPdfParserProfile(parserName, options);
  if (profile.leaseStrategy === 'docling-gpu') {
    return acquireDoclingGpuLease(options, label, tracker);
  }
  return null;
}

function buildShellCommand(command, argv = []) {
  return [String(command || '').trim(), ...argv.map((value) => shellQuote(value))].filter(Boolean).join(' ');
}

function createMinimalPdfBuffer(text = 'PaperNexus Docling Warmup') {
  const safeText = String(text || 'Warmup').replace(/[()\\]/g, '\\$&');
  const stream = `BT\n/F1 18 Tf\n36 120 Td\n(${safeText}) Tj\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`
  ];

  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(content, 'utf8'));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(content, 'utf8');
  content += `xref\n0 ${objects.length + 1}\n`;
  content += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    content += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content, 'utf8');
}

export function resolveMineruHttpUrl(options = {}) {
  return options.mineruHttpUrl
    || options.pdfParserHttpUrl
    || process.env.PAPERNEXUS_MINERU_HTTP_URL
    || '';
}

function resolveMineruRemoteFailureMode(options = {}) {
  const normalized = String(
    options.mineruRemoteFailureMode
    || process.env.PAPERNEXUS_MINERU_REMOTE_FAILURE_MODE
    || 'error'
  ).trim().toLowerCase();
  return normalized === 'docling' ? 'docling' : 'error';
}

function resolvePdfParseTimeoutMs(options = {}) {
  const raw = Number(
    options.pdfParseTimeoutMs
    || process.env.PAPERNEXUS_PDF_PARSE_TIMEOUT_MS
    || DEFAULT_PDF_PARSE_TIMEOUT_MS
  );
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PDF_PARSE_TIMEOUT_MS;
  return Math.max(1, Math.round(raw));
}

function resolveMineruProbeCacheTtlMs(options = {}) {
  const raw = Number(
    options.cacheTtlMs
    ?? options.mineruProbeCacheTtlMs
    ?? process.env.PAPERNEXUS_MINERU_PROBE_CACHE_TTL_MS
    ?? DEFAULT_MINERU_PROBE_CACHE_TTL_MS
  );
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MINERU_PROBE_CACHE_TTL_MS;
  return Math.max(0, Math.round(raw));
}

function resetMineruProbeCache(url = '') {
  const normalized = String(url || '').trim();
  if (!normalized) {
    mineruProbeCache.clear();
    return;
  }
  mineruProbeCache.delete(normalized);
}

function createMineruParserTimings() {
  return {
    probeHttpMs: 0,
    pdfReadMs: 0,
    mineruRequestMs: 0,
    markdownWriteMs: 0
  };
}

function mergeMineruParserTimings(target = {}, source = {}) {
  for (const key of Object.keys(createMineruParserTimings())) {
    const value = Number(source?.[key] || 0);
    if (Number.isFinite(value) && value > 0) {
      target[key] = Number(target[key] || 0) + value;
    }
  }
  return target;
}

async function measureDuration(timings, key, action) {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    if (timings && key) {
      timings[key] = Number(timings[key] || 0) + (Date.now() - startedAt);
    }
  }
}

async function probeHttpEndpoint(url, timeoutMs = 6000, options = {}) {
  const normalizedUrl = String(url || '').trim();
  const cacheTtlMs = resolveMineruProbeCacheTtlMs(options);
  if (cacheTtlMs > 0 && normalizedUrl) {
    const cached = mineruProbeCache.get(normalizedUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.result,
        cached: true,
        durationMs: 0
      };
    }
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal
    });
    const result = {
      reachable: true,
      status: response.status,
      error: null,
      cached: false,
      durationMs: Date.now() - startedAt
    };
    if (cacheTtlMs > 0 && normalizedUrl) {
      mineruProbeCache.set(normalizedUrl, {
        expiresAt: Date.now() + cacheTtlMs,
        result: {
          reachable: result.reachable,
          status: result.status,
          error: result.error
        }
      });
    }
    return result;
  } catch (error) {
    const result = {
      reachable: false,
      status: null,
      error: error?.name === 'AbortError'
        ? `Connection probe timed out after ${timeoutMs}ms`
        : (error?.message || 'Unknown connectivity error'),
      cached: false,
      durationMs: Date.now() - startedAt
    };
    if (cacheTtlMs > 0 && normalizedUrl) {
      mineruProbeCache.set(normalizedUrl, {
        expiresAt: Date.now() + cacheTtlMs,
        result: {
          reachable: result.reachable,
          status: result.status,
          error: result.error
        }
      });
    }
    return result;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildRemoteMarkerScript({ markerCommand, remotePdfPath, remoteRunDir, pageRange }) {
  const markerArgs = [
    shellQuote(remotePdfPath),
    '--output_format',
    'markdown',
    '--disable_image_extraction',
    '--output_dir',
    shellQuote(remoteRunDir)
  ];

  if (pageRange) {
    markerArgs.push('--page_range', shellQuote(String(pageRange)));
  }

  return [
    'set -e',
    `tmp_root=${shellQuote(path.posix.dirname(remoteRunDir))}`,
    `run_dir=${shellQuote(remoteRunDir)}`,
    'gpu_lock_root=/tmp/papernexus-gpu-locks',
    'gpu_wait_seconds=900',
    'gpu_poll_seconds=5',
    'gpu_min_free_mb=18000',
    'gpu_min_compute_cap=70',
    'GPU_LOCK_DIR=""',
    'select_gpu() {',
    '  command -v nvidia-smi >/dev/null 2>&1 || return 0',
    '  mkdir -p "$gpu_lock_root"',
    '  start_ts=$(date +%s)',
    '  while true; do',
    '    gpu_lines_file="$tmp_root/gpu-lines.txt"',
    '    nvidia-smi --query-gpu=index,name,compute_cap,memory.free --format=csv,noheader,nounits > "$gpu_lines_file" 2>/dev/null || true',
    '    best_gpu=""',
    '    best_free=0',
    '    best_name=""',
    '    while IFS= read -r line; do',
    '      idx=$(printf "%s" "$line" | cut -d"," -f1 | tr -d " ")',
    '      name=$(printf "%s" "$line" | cut -d"," -f2 | sed "s/^ *//;s/ *$//")',
    '      compute_cap=$(printf "%s" "$line" | cut -d"," -f3 | tr -d " ")',
    '      free=$(printf "%s" "$line" | cut -d"," -f4 | tr -d " ")',
    '      compute_cap_num=$(printf "%s" "$compute_cap" | tr -d ".")',
    '      [ -n "$idx" ] || continue',
    '      [ -n "$compute_cap_num" ] || continue',
    '      [ -n "$free" ] || continue',
    '      [ "$compute_cap_num" -ge "$gpu_min_compute_cap" ] || continue',
    '      [ "$free" -ge "$gpu_min_free_mb" ] || continue',
    '      [ -d "$gpu_lock_root/gpu-$idx.lock" ] && continue',
    '      if [ -z "$best_gpu" ] || [ "$free" -gt "$best_free" ]; then',
    '        best_gpu="$idx"',
    '        best_free="$free"',
    '        best_name="$name"',
    '      fi',
    '    done < "$gpu_lines_file"',
    '    if [ -n "$best_gpu" ]; then',
    '      lock_dir="$gpu_lock_root/gpu-$best_gpu.lock"',
    '      if mkdir "$lock_dir" 2>/dev/null; then',
    '        GPU_LOCK_DIR="$lock_dir"',
    '        export CUDA_VISIBLE_DEVICES="$best_gpu"',
    '        export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
    '        echo "Using GPU $best_gpu ($best_name) with ${best_free} MiB free memory" >&2',
    '        return 0',
    '      fi',
    '    fi',
    '    now_ts=$(date +%s)',
    '    elapsed=$((now_ts - start_ts))',
    '    if [ "$elapsed" -ge "$gpu_wait_seconds" ]; then',
    '      echo "Timed out waiting for an available GPU with at least ${gpu_min_free_mb} MiB free memory" >&2',
    '      return 1',
    '    fi',
    '    echo "Waiting for an available GPU..." >&2',
    '    sleep "$gpu_poll_seconds"',
    '  done',
    '}',
    'cleanup() { [ -n "$GPU_LOCK_DIR" ] && rm -rf "$GPU_LOCK_DIR"; rm -rf "$tmp_root"; }',
    'trap cleanup EXIT',
    'select_gpu',
    'mkdir -p "$run_dir"',
    `${markerCommand} ${markerArgs.join(' ')} 1>&2`,
    'markdown_file=$(find "$run_dir" -type f -name \'*.md\' | head -n 1)',
    'if [ -z "$markdown_file" ]; then',
    '  echo "Marker finished but no markdown file was found." >&2',
    '  exit 1',
    'fi',
    'cat "$markdown_file"'
  ].join('\n');
}

function buildRemoteDoclingScript({
  doclingCommand,
  remotePdfPath,
  remoteRunDir,
  ocrEngine,
  pdfBackend,
  device,
  cudaVisibleDevices,
  artifactsPath,
  imageExportMode,
  enrichPictureClasses,
  enrichPictureDescription,
  gpuLockRoot = DEFAULT_DOCLING_GPU_LOCK_ROOT,
  gpuMinFreeMb = DEFAULT_DOCLING_GPU_MIN_FREE_MB,
  gpuWaitTimeoutMs = DEFAULT_DOCLING_GPU_WAIT_TIMEOUT_MS,
  gpuPollIntervalMs = DEFAULT_DOCLING_GPU_POLL_INTERVAL_MS,
  gpuLockStaleMs = DEFAULT_DOCLING_GPU_LOCK_STALE_MS,
  cpuThreads = DEFAULT_DOCLING_CPU_THREADS,
  hfEndpoint,
  hfHome,
  hfHubCache,
  transformersCache,
  hfHubDisableTelemetry,
  autoGpu = true
}) {
  const command = buildShellCommand(
    doclingCommand,
    buildDoclingCliArgv({
      inputPath: remotePdfPath,
      outputPath: remoteRunDir,
      ocrEngine,
      pdfBackend,
      device,
      artifactsPath,
      imageExportMode,
      enrichPictureClasses,
      enrichPictureDescription
    })
  );
  const shouldAutoSelectGpu = String(device || '').trim().toLowerCase().startsWith('cuda')
    && autoGpu !== false
    && !String(cudaVisibleDevices || '').trim();
  const gpuWaitSeconds = Math.max(1, Math.ceil(Number(gpuWaitTimeoutMs || DEFAULT_DOCLING_GPU_WAIT_TIMEOUT_MS) / 1000));
  const gpuPollSeconds = Math.max(1, Math.ceil(Number(gpuPollIntervalMs || DEFAULT_DOCLING_GPU_POLL_INTERVAL_MS) / 1000));
  const gpuLockStaleMinutes = Math.max(1, Math.floor(Number(gpuLockStaleMs || DEFAULT_DOCLING_GPU_LOCK_STALE_MS) / 60000));
  const threadCount = String(resolvePositiveInteger(cpuThreads, DEFAULT_DOCLING_CPU_THREADS));
  const remoteHfEndpoint = firstNonEmptyString(hfEndpoint);
  const remoteHfHome = firstNonEmptyString(hfHome);
  const remoteHfHubCache = firstNonEmptyString(hfHubCache);
  const remoteTransformersCache = firstNonEmptyString(transformersCache);
  const remoteHfHubDisableTelemetry = firstNonEmptyString(hfHubDisableTelemetry);

  return [
    'set -e',
    `tmp_root=${shellQuote(path.posix.dirname(remoteRunDir))}`,
    `run_dir=${shellQuote(remoteRunDir)}`,
    `gpu_lock_root=${shellQuote(gpuLockRoot || DEFAULT_DOCLING_GPU_LOCK_ROOT)}`,
    `gpu_wait_seconds=${shellQuote(String(gpuWaitSeconds))}`,
    `gpu_poll_seconds=${shellQuote(String(gpuPollSeconds))}`,
    `gpu_min_free_mb=${shellQuote(String(resolvePositiveInteger(gpuMinFreeMb, DEFAULT_DOCLING_GPU_MIN_FREE_MB)))}`,
    `gpu_lock_stale_minutes=${shellQuote(String(gpuLockStaleMinutes))}`,
    `export OPENBLAS_NUM_THREADS=${shellQuote(threadCount)}`,
    `export OMP_NUM_THREADS=${shellQuote(threadCount)}`,
    `export MKL_NUM_THREADS=${shellQuote(threadCount)}`,
    `export NUMEXPR_NUM_THREADS=${shellQuote(threadCount)}`,
    `export VECLIB_MAXIMUM_THREADS=${shellQuote(threadCount)}`,
    remoteHfEndpoint
      ? `export HF_ENDPOINT=${shellQuote(remoteHfEndpoint)}`
      : `export HF_ENDPOINT="\${HF_ENDPOINT:-${DEFAULT_HUGGINGFACE_ENDPOINT}}"`,
    remoteHfHome
      ? `export HF_HOME=${shellQuote(remoteHfHome)}`
      : 'export HF_HOME="${HF_HOME:-$HOME/.cache/papernexus/huggingface}"',
    remoteHfHubCache
      ? `export HF_HUB_CACHE=${shellQuote(remoteHfHubCache)}`
      : 'export HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"',
    remoteTransformersCache
      ? `export TRANSFORMERS_CACHE=${shellQuote(remoteTransformersCache)}`
      : 'export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME/transformers}"',
    remoteHfHubDisableTelemetry
      ? `export HF_HUB_DISABLE_TELEMETRY=${shellQuote(remoteHfHubDisableTelemetry)}`
      : 'export HF_HUB_DISABLE_TELEMETRY="${HF_HUB_DISABLE_TELEMETRY:-1}"',
    ...(cudaVisibleDevices ? [`export CUDA_VISIBLE_DEVICES=${shellQuote(cudaVisibleDevices)}`] : []),
    ...(cudaVisibleDevices ? ['export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"'] : []),
    'GPU_LOCK_DIR=""',
    'select_gpu() {',
    '  command -v nvidia-smi >/dev/null 2>&1 || { echo "nvidia-smi is required for Docling GPU scheduling but was not found." >&2; return 1; }',
    '  mkdir -p "$gpu_lock_root"',
    '  start_ts=$(date +%s)',
    '  while true; do',
    '    find "$gpu_lock_root" -maxdepth 1 -type d -name "gpu-*.lock" -mmin +"$gpu_lock_stale_minutes" -exec rm -rf {} + 2>/dev/null || true',
    '    gpu_lines_file="$tmp_root/gpu-lines.txt"',
    '    nvidia-smi --query-gpu=index,name,memory.free --format=csv,noheader,nounits > "$gpu_lines_file" 2>/dev/null || true',
    '    best_gpu=""',
    '    best_free=0',
    '    best_name=""',
    '    while IFS= read -r line; do',
    '      idx=$(printf "%s" "$line" | cut -d"," -f1 | tr -d " ")',
    '      name=$(printf "%s" "$line" | cut -d"," -f2 | sed "s/^ *//;s/ *$//")',
    '      free=$(printf "%s" "$line" | awk -F"," \'{gsub(/ /, "", $NF); print $NF}\')',
    '      [ -n "$idx" ] || continue',
    '      [ -n "$free" ] || continue',
    '      [ "$free" -ge "$gpu_min_free_mb" ] || continue',
    '      [ -d "$gpu_lock_root/gpu-$idx.lock" ] && continue',
    '      if [ -z "$best_gpu" ] || [ "$free" -gt "$best_free" ]; then',
    '        best_gpu="$idx"',
    '        best_free="$free"',
    '        best_name="$name"',
    '      fi',
    '    done < "$gpu_lines_file"',
    '    if [ -n "$best_gpu" ]; then',
    '      lock_dir="$gpu_lock_root/gpu-$best_gpu.lock"',
    '      if mkdir "$lock_dir" 2>/dev/null; then',
    '        GPU_LOCK_DIR="$lock_dir"',
    '        export CUDA_VISIBLE_DEVICES="$best_gpu"',
    '        export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"',
    '        printf \'{"pid":%s,"gpuIndex":"%s","gpuName":"%s","freeMemoryMb":%s,"acquiredAt":"%s"}\\n\' "$$" "$best_gpu" "$best_name" "$best_free" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock_dir/owner.json" 2>/dev/null || true',
    '        echo "Using GPU $best_gpu ($best_name) with ${best_free} MiB free memory" >&2',
    '        return 0',
    '      fi',
    '    fi',
    '    now_ts=$(date +%s)',
    '    elapsed=$((now_ts - start_ts))',
    '    if [ "$elapsed" -ge "$gpu_wait_seconds" ]; then',
    '      echo "Timed out waiting for an available Docling GPU with at least ${gpu_min_free_mb} MiB free memory" >&2',
    '      return 1',
    '    fi',
    '    echo "Waiting for an available Docling GPU..." >&2',
    '    sleep "$gpu_poll_seconds"',
    '  done',
    '}',
    'cleanup() { [ -n "$GPU_LOCK_DIR" ] && rm -rf "$GPU_LOCK_DIR"; rm -rf "$tmp_root"; }',
    'trap cleanup EXIT',
    ...(shouldAutoSelectGpu ? ['select_gpu'] : []),
    'mkdir -p "$run_dir"',
    `${command} 1>&2`,
    'markdown_file=$(find "$run_dir" -type f -name \'*.md\' | head -n 1)',
    'if [ -z "$markdown_file" ]; then',
    '  echo "Docling finished but no markdown file was found." >&2',
    '  exit 1',
    'fi',
    'cat "$markdown_file"'
  ].join('\n');
}

async function runRemoteCommand(sshHost, script, options = {}) {
  return runCommand('ssh', [sshHost, script], options);
}

async function runRemoteCommandWithStdin(sshHost, script, stdinBuffer, options = {}) {
  return runCommandWithStdin('ssh', [sshHost, script], stdinBuffer, options);
}

async function extractPdfViaRemotePypdf(pdfPath, sshHost) {
  const pdfBuffer = await fs.readFile(pdfPath);
  const remoteTmpPath = `/tmp/papernexus-${stableHash(`${pdfPath}:${Date.now()}`, 16)}.pdf`;
  await runRemoteCommandWithStdin(sshHost, `cat > ${shellQuote(remoteTmpPath)}`, pdfBuffer);

  try {
    const { stdout } = await runRemoteCommand(
      sshHost,
      `pdftotext -layout ${shellQuote(remoteTmpPath)} -; rm -f ${shellQuote(remoteTmpPath)}`
    );
    const text = String(stdout || '').trim();
    if (text) return text;
  } catch {}

  const pythonCode = [
    'import sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'chunks = []',
    'for index, page in enumerate(reader.pages, start=1):',
    '    text = (page.extract_text() or "").strip()',
    '    if not text:',
    '        continue',
    '    chunks.append(f"# Page {index}\\n\\n{text}")',
    'sys.stdout.write("\\n\\n".join(chunks))'
  ].join('; ');

  const { stdout } = await runRemoteCommand(
    sshHost,
    `python3 -c ${shellQuote(pythonCode)} ${shellQuote(remoteTmpPath)}; rm -f ${shellQuote(remoteTmpPath)}`
  );
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote PDF text extraction returned empty text for ${pdfPath}.`);
  }
  return markdown;
}

async function findGeneratedMarkdown(runDir, basename) {
  const files = await listFilesRecursive(runDir);
  const markdownFiles = files.filter((filePath) => path.extname(filePath).toLowerCase() === '.md');
  if (!markdownFiles.length) {
    throw new Error(`Marker finished but no markdown file was found in ${runDir}.`);
  }

  return (
    markdownFiles.find((filePath) => path.basename(filePath, '.md') === basename) ||
    markdownFiles.find((filePath) => filePath.includes(`${path.sep}${basename}${path.sep}`)) ||
    markdownFiles[0]
  );
}

function getParserCachePaths(parser, basename, directories = {}) {
  return {
    cachedMarkdownPath: path.join(directories.markdownDir, parser, `${basename}.md`),
    runDir: path.join(directories.markerDir, parser, basename)
  };
}

export function getPdfMarkdownCachePath(pdfPath, options = {}) {
  const parser = normalizePdfParser(options.pdfParser);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  return getParserCachePaths(parser, basename, {
    markerDir: options.markerDir,
    markdownDir: options.markdownDir
  }).cachedMarkdownPath;
}

export function getMarkdownSourceCachePath(markdownPath, directories = {}) {
  const basename = path.basename(markdownPath, path.extname(markdownPath));
  const suffix = stableHash(path.resolve(markdownPath), 10);
  return path.join(directories.markdownDir, 'source', `${basename}-${suffix}.md`);
}

export async function cacheMarkdownSource(markdownPath, options = {}) {
  const {
    markdownDir,
    force = false
  } = options;

  const cachedMarkdownPath = getMarkdownSourceCachePath(markdownPath, { markdownDir });
  await ensureDir(path.dirname(cachedMarkdownPath));

  if (!force && await fileExists(cachedMarkdownPath)) {
    return {
      markdownPath: cachedMarkdownPath,
      generated: false,
      parser: 'source'
    };
  }

  await writeText(cachedMarkdownPath, await readText(markdownPath));
  return {
    markdownPath: cachedMarkdownPath,
    generated: true,
    parser: 'source'
  };
}

async function convertPdfToMarkdownWithMarkItDown(pdfPath, options = {}) {
  const {
    markerDir,
    markdownDir,
    force = false,
    pageRange
  } = options;

  if (pageRange) {
    throw new Error('MarkItDown page-range forwarding is not currently supported. Use `--pdf-parser marker` or `--pdf-parser markpdfdown` when you need `--page-range`.');
  }

  const pythonCommand = resolveMarkItDownPython(options);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`markitdown:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const runtime = await buildMarkItDownRuntime(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MARKITDOWN, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_MARKITDOWN,
      currentStep: 'reusing cached markitdown markdown',
      message: 'Reusing cached MarkItDown markdown',
      parserCommand: `${pythonCommand} ${MARKITDOWN_WRAPPER_PATH}`
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MARKITDOWN,
      parserCommand: `${pythonCommand} ${MARKITDOWN_WRAPPER_PATH}`
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  await tracker?.update?.({
    status: 'running',
    activeParser: PDF_PARSER_MARKITDOWN,
    currentStep: 'running markitdown',
    message: runtime.useLlm ? 'Running MarkItDown with project LLM config' : 'Running MarkItDown'
  });
  const lease = await acquirePdfParserLease(PDF_PARSER_MARKITDOWN, options, `markitdown:${basename}`, tracker);
  try {
    process.stderr.write(`[markitdown:${basename}] Running MarkItDown\n`);
    await runCommand(pythonCommand, [
      MARKITDOWN_WRAPPER_PATH,
      '--input',
      pdfPath,
      '--output',
      cachedMarkdownPath
    ], {
      env: {
        ...buildPdfParserExecutionEnv(PDF_PARSER_MARKITDOWN, options),
        ...runtime.env,
        ...(lease?.env || {})
      },
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `markitdown parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    throw new Error(
      `MarkItDown failed for ${pdfPath}. ${error.message}\n`
      + 'Tip: install `markitdown[pdf]` in the selected Python environment and verify the runtime can import `markitdown`.'
    );
  } finally {
    await lease?.release?.();
  }

  if (!await fileExists(cachedMarkdownPath)) {
    throw new Error(
      `MarkItDown finished for ${pdfPath} but no markdown cache was written to ${cachedMarkdownPath}.`
    );
  }

  const markdown = await readText(cachedMarkdownPath);
  if (!markdown.trim()) {
    throw new Error(`MarkItDown produced empty markdown for ${pdfPath}.`);
  }

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MARKITDOWN,
    parserCommand: `${pythonCommand} ${MARKITDOWN_WRAPPER_PATH}`
  };
}

async function convertPdfToMarkdownViaRemoteMarker(pdfPath, options = {}) {
  const { markerCommand, markerSshHost, pageRange } = options;
  const pdfBuffer = await fs.readFile(pdfPath);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`marker:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const remoteRoot = `/tmp/papernexus-marker-${stableHash(`${pdfPath}:${Date.now()}`, 16)}`;
  const remotePdfPath = `${remoteRoot}/${basename}.pdf`;
  const remoteRunDir = `${remoteRoot}/out`;

  process.stderr.write(`[marker:${basename}] Uploading PDF to ${markerSshHost}\n`);
  await tracker?.update?.({
    status: 'running',
    activeParser: PDF_PARSER_MARKER,
    currentStep: `uploading PDF to ${markerSshHost}`,
    message: `Uploading PDF to remote marker host ${markerSshHost}`
  });
  await runRemoteCommand(markerSshHost, `mkdir -p ${shellQuote(remoteRoot)}`, {
    timeoutMs,
    timeoutLabel: `remote marker setup for ${pdfPath}`
  });
  await runRemoteCommandWithStdin(markerSshHost, `cat > ${shellQuote(remotePdfPath)}`, pdfBuffer, {
    timeoutMs,
    timeoutLabel: `remote marker upload for ${pdfPath}`
  });
  process.stderr.write(`[marker:${basename}] Running remote marker on ${markerSshHost}\n`);
  await tracker?.update?.({
    status: 'running',
    activeParser: PDF_PARSER_MARKER,
    currentStep: `running remote marker on ${markerSshHost}`,
    message: `Running remote Marker on ${markerSshHost}`
  });

  const script = buildRemoteMarkerScript({
    markerCommand,
    remotePdfPath,
    remoteRunDir,
    pageRange
  });

  const { stdout } = await runRemoteCommand(markerSshHost, script, {
    onStderr: progress,
    timeoutMs,
    timeoutLabel: `remote marker parse for ${pdfPath}`
  });
  flushProgressReporter(progress);
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote Marker returned empty markdown for ${pdfPath}.`);
  }

  const filteredMarkdown = filterMarkerMarkdown(markdown, resolveMarkerBlockBlacklist(options));
  if (!filteredMarkdown.trim()) {
    throw new Error(`Remote Marker returned empty markdown for ${pdfPath} after applying the marker block blacklist.`);
  }

  return {
    markdown: filteredMarkdown,
    markerCommand: `${markerCommand} (remote@${markerSshHost})`
  };
}

async function convertPdfToMarkdownViaRemoteDocling(pdfPath, options = {}) {
  const {
    doclingCommand,
    doclingSshHost,
    pageRange,
    doclingOcrEngine,
    doclingPdfBackend
  } = options;
  if (pageRange) {
    throw new Error('Docling page-range forwarding is not currently supported.');
  }

  const pdfBuffer = await fs.readFile(pdfPath);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`docling:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const gpuWaitTimeoutMs = resolveDoclingGpuWaitTimeoutMs(options);
  const remoteRoot = `/tmp/papernexus-docling-${stableHash(`${pdfPath}:${Date.now()}`, 16)}`;
  const remotePdfPath = `${remoteRoot}/${basename}.pdf`;
  const remoteRunDir = `${remoteRoot}/out`;

  process.stderr.write(`[docling:${basename}] Uploading PDF to ${doclingSshHost}\n`);
  await tracker?.update?.({
    status: 'running',
    activeParser: PDF_PARSER_DOCLING,
    currentStep: `uploading PDF to ${doclingSshHost}`,
    message: `Uploading PDF to remote Docling host ${doclingSshHost}`
  });
  await runRemoteCommand(doclingSshHost, `mkdir -p ${shellQuote(remoteRoot)}`, {
    timeoutMs,
    timeoutLabel: `remote docling setup for ${pdfPath}`
  });
  await runRemoteCommandWithStdin(doclingSshHost, `cat > ${shellQuote(remotePdfPath)}`, pdfBuffer, {
    timeoutMs,
    timeoutLabel: `remote docling upload for ${pdfPath}`
  });
  process.stderr.write(`[docling:${basename}] Running remote docling on ${doclingSshHost}\n`);
  await tracker?.update?.({
    status: 'running',
    activeParser: PDF_PARSER_DOCLING,
    currentStep: `running remote docling on ${doclingSshHost}`,
    message: `Running remote Docling on ${doclingSshHost}`
  });

  const script = buildRemoteDoclingScript({
    doclingCommand,
    remotePdfPath,
    remoteRunDir,
    ocrEngine: doclingOcrEngine,
    pdfBackend: doclingPdfBackend,
    device: resolveDoclingDevice(options),
    cudaVisibleDevices: resolveDoclingCudaVisibleDevices(options),
    artifactsPath: resolveDoclingArtifactsPath(options),
    imageExportMode: resolveDoclingImageExportMode(options),
    enrichPictureClasses: resolveDoclingEnrichPictureClasses(options),
    enrichPictureDescription: resolveDoclingEnrichPictureDescription(options),
    gpuLockRoot: resolveDoclingGpuLockRoot(options),
    gpuMinFreeMb: resolveDoclingGpuMinFreeMb(options),
    gpuWaitTimeoutMs,
    gpuPollIntervalMs: resolveDoclingGpuPollIntervalMs(options),
    gpuLockStaleMs: resolveDoclingGpuLockStaleMs(options),
    cpuThreads: resolveDoclingCpuThreads(options),
    autoGpu: resolveDoclingAutoGpu(options)
  });

  const { stdout } = await runRemoteCommand(doclingSshHost, script, {
    onStderr: progress,
    timeoutMs: timeoutMs + gpuWaitTimeoutMs,
    timeoutLabel: `remote docling parse for ${pdfPath}`
  });
  flushProgressReporter(progress);
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote Docling returned empty markdown for ${pdfPath}.`);
  }

  return {
    markdown,
    parserCommand: `${doclingCommand} (remote@${doclingSshHost})`
  };
}

async function runLocalDoclingCli(pdfPath, runDir, options = {}, executionOptions = {}) {
  const argv = buildDoclingCliArgv({
    inputPath: pdfPath,
    outputPath: runDir,
    ocrEngine: options.doclingOcrEngine,
    pdfBackend: options.doclingPdfBackend,
    device: resolveDoclingDevice(options),
    artifactsPath: resolveDoclingArtifactsPath(options),
    imageExportMode: resolveDoclingImageExportMode(options),
    enrichPictureClasses: resolveDoclingEnrichPictureClasses(options),
    enrichPictureDescription: resolveDoclingEnrichPictureDescription(options)
  });
  const env = buildPdfParserExecutionEnv(PDF_PARSER_DOCLING, options);
  const tracker = executionOptions.tracker || options.pdfParseTracker || null;
  const lease = await acquirePdfParserLease(
    PDF_PARSER_DOCLING,
    options,
    executionOptions.label || `docling:${path.basename(pdfPath, path.extname(pdfPath))}`,
    tracker
  );
  try {
    return await runCommand('/bin/sh', ['-lc', buildShellCommand(options.doclingCommand, argv)], {
      ...executionOptions,
      env: {
        ...env,
        ...(lease?.env || {}),
        ...(executionOptions.env || {})
      }
    });
  } finally {
    await lease?.release?.();
  }
}

export async function warmDoclingRuntime(options = {}) {
  if (!resolveDoclingPreload(options)) {
    return {
      attempted: false,
      warmed: false,
      skipped: true,
      reason: 'docling preload disabled'
    };
  }

  const warmupKey = stableHash(JSON.stringify({
    doclingCommand: options.doclingCommand || process.env.PAPERNEXUS_DOCLING_CMD || 'docling',
    doclingPython: resolveDoclingPython(options),
    doclingUseVlm: resolveDoclingUseVlm(options),
    doclingVlmPreset: resolveDoclingVlmPreset(options),
    doclingSshHost: resolveRemoteDoclingHost(options),
    doclingOcrEngine: options.doclingOcrEngine || '',
    doclingPdfBackend: options.doclingPdfBackend || '',
    doclingDevice: resolveDoclingDevice(options),
    doclingCudaVisibleDevices: resolveDoclingCudaVisibleDevices(options),
    doclingArtifactsPath: resolveDoclingArtifactsPath(options),
    doclingImageExportMode: resolveDoclingImageExportMode(options),
    doclingEnrichPictureClasses: resolveDoclingEnrichPictureClasses(options),
    doclingEnrichPictureDescription: resolveDoclingEnrichPictureDescription(options),
    doclingAutoGpu: resolveDoclingAutoGpu(options),
    doclingGpuLockRoot: resolveDoclingGpuLockRoot(options),
    doclingGpuMinFreeMb: resolveDoclingGpuMinFreeMb(options),
    doclingGpuWaitTimeoutMs: resolveDoclingGpuWaitTimeoutMs(options),
    doclingGpuPollIntervalMs: resolveDoclingGpuPollIntervalMs(options),
    doclingGpuLockStaleMs: resolveDoclingGpuLockStaleMs(options),
    doclingCpuThreads: resolveDoclingCpuThreads(options),
    llmProvider: options.llmProvider,
    llmModel: options.llmModel,
    llmBaseUrl: options.llmBaseUrl
  }), 20);
  if (doclingWarmupCache.has(warmupKey)) {
    return doclingWarmupCache.get(warmupKey);
  }

  const warmupPromise = (async () => {
    const timeoutMs = resolveDoclingPreloadTimeoutMs(options);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docling-warmup-'));
    const warmupPdfPath = path.join(tempRoot, 'warmup.pdf');
    const warmupMarkdownPath = path.join(tempRoot, 'warmup.md');
    const warmupRunDir = path.join(tempRoot, 'out');
    await fs.writeFile(warmupPdfPath, createMinimalPdfBuffer(), 'utf8');

    try {
      const remoteDoclingHost = resolveRemoteDoclingHost(options);
      if (remoteDoclingHost) {
        await convertPdfToMarkdownViaRemoteDocling(warmupPdfPath, {
          ...options,
          doclingSshHost: remoteDoclingHost,
          pageRange: ''
        });
      } else if (resolveDoclingUseVlm(options)) {
        const runtime = await buildDoclingVlmRuntime(options);
        const args = [
          DOCLING_WRAPPER_PATH,
          '--input',
          warmupPdfPath,
          '--output',
          warmupMarkdownPath,
          '--use-vlm',
          '--vlm-preset',
          runtime.preset,
          '--provider',
          runtime.provider,
          '--model-name',
          runtime.modelName,
          '--base-url',
          runtime.baseUrl,
          '--max-tokens',
          String(runtime.maxTokens),
          ...(options.doclingOcrEngine ? ['--ocr-engine', options.doclingOcrEngine] : []),
          ...(options.doclingPdfBackend ? ['--pdf-backend', options.doclingPdfBackend] : [])
        ];
        const lease = await acquirePdfParserLease(PDF_PARSER_DOCLING, options, 'docling:warmup:vlm');
        try {
          await runCommand(resolveDoclingPython(options), args, {
            env: {
              ...buildPdfParserExecutionEnv(PDF_PARSER_DOCLING, options),
              ...runtime.env,
              ...(lease?.env || {})
            },
            timeoutMs,
            timeoutLabel: 'docling VLM warmup'
          });
        } finally {
          await lease?.release?.();
        }
      } else {
        await fs.mkdir(warmupRunDir, { recursive: true });
        await runLocalDoclingCli(warmupPdfPath, warmupRunDir, {
          ...options,
          doclingCommand: options.doclingCommand || process.env.PAPERNEXUS_DOCLING_CMD || 'docling'
        }, {
          timeoutMs,
          timeoutLabel: 'docling warmup'
        });
      }
      return {
        attempted: true,
        warmed: true,
        remote: Boolean(resolveRemoteDoclingHost(options)),
        useVlm: resolveDoclingUseVlm(options)
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  })();

  doclingWarmupCache.set(warmupKey, warmupPromise);
  try {
    return await warmupPromise;
  } catch (error) {
    doclingWarmupCache.delete(warmupKey);
    throw error;
  }
}

async function convertPdfToMarkdownWithOpenDataLoader(pdfPath, options = {}) {
  const {
    markerDir,
    markdownDir,
    force = false
  } = options;

  const pythonCommand = resolveOpenDataLoaderPdfPython(options);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`opendataloader:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_OPENDATALOADER, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_OPENDATALOADER,
      currentStep: 'reusing cached opendataloader markdown',
      message: 'Reusing cached OpenDataLoader markdown',
      parserCommand: `${pythonCommand} ${OPENDATALOADER_PDF_WRAPPER_PATH}`
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_OPENDATALOADER,
      parserCommand: `${pythonCommand} ${OPENDATALOADER_PDF_WRAPPER_PATH}`
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const args = [
    OPENDATALOADER_PDF_WRAPPER_PATH,
    '--input',
    pdfPath,
    '--output',
    cachedMarkdownPath
  ];

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_OPENDATALOADER,
      currentStep: 'running opendataloader',
      message: 'Running OpenDataLoader PDF'
    });
    process.stderr.write(`[opendataloader:${basename}] Running OpenDataLoader PDF\n`);
    await runCommand(pythonCommand, args, {
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `opendataloader parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    throw new Error(
      `OpenDataLoader PDF failed for ${pdfPath}. ${error.message}\n` +
      `Tip: install \`opendataloader-pdf\`, verify Java 11+ is available, and confirm \`${pythonCommand}\` can import \`opendataloader_pdf\`.`
    );
  }

  if (!await fileExists(cachedMarkdownPath)) {
    throw new Error(
      `OpenDataLoader PDF finished for ${pdfPath} but no markdown cache was written to ${cachedMarkdownPath}.`
    );
  }

  const markdown = await readText(cachedMarkdownPath);
  if (!markdown.trim()) {
    throw new Error(
      `OpenDataLoader PDF produced empty markdown for ${pdfPath}.\n` +
      'Tip: verify the PDF is valid and the OpenDataLoader runtime can parse the selected document.'
    );
  }

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_OPENDATALOADER,
    parserCommand: `${pythonCommand} ${OPENDATALOADER_PDF_WRAPPER_PATH}`
  };
}

async function convertPdfToMarkdownWithMarkPdfDown(pdfPath, options = {}) {
  const {
    markerDir,
    markdownDir,
    force = false
  } = options;

  const pythonCommand = resolveMarkPdfDownPython(options);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`markpdfdown:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { startPage, endPage } = resolveMarkPdfDownPageWindow(options.pageRange);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MARKPDFDOWN, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_MARKPDFDOWN,
      currentStep: 'reusing cached markpdfdown markdown',
      message: 'Reusing cached MarkPDFDown markdown',
      parserCommand: `${pythonCommand} ${MARKPDFDOWN_WRAPPER_PATH}`
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MARKPDFDOWN,
      parserCommand: `${pythonCommand} ${MARKPDFDOWN_WRAPPER_PATH}`
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const runtime = await buildMarkPdfDownRuntime(options);
  const args = [
    MARKPDFDOWN_WRAPPER_PATH,
    '--input',
    pdfPath,
    '--output',
    cachedMarkdownPath,
    '--provider',
    runtime.llmConfig.provider,
    '--model-name',
    runtime.modelName,
    '--max-tokens',
    runtime.env.MAX_TOKENS,
    '--temperature',
    runtime.env.TEMPERATURE,
    '--retry-times',
    runtime.env.RETRY_TIMES,
    '--start-page',
    String(startPage),
    '--end-page',
    String(endPage)
  ];

  if (runtime.llmConfig.baseUrl) {
    args.push('--base-url', runtime.llmConfig.baseUrl);
  }

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_MARKPDFDOWN,
      currentStep: 'running markpdfdown',
      message: `Running MarkPDFDown with provider ${runtime.llmConfig.provider}`
    });
    process.stderr.write(`[markpdfdown:${basename}] Running MarkPDFDown with provider ${runtime.llmConfig.provider}\n`);
    await runCommand(pythonCommand, args, {
      env: runtime.env,
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `markpdfdown parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    throw new Error(
      `MarkPDFDown failed for ${pdfPath}. ${error.message}\n`
      + `Tip: install \`markpdfdown\` in the selected Python environment and verify PaperNexus LLM config is valid for provider \`${runtime.llmConfig.provider}\`.`
    );
  }

  if (!await fileExists(cachedMarkdownPath)) {
    throw new Error(
      `MarkPDFDown finished for ${pdfPath} but no markdown cache was written to ${cachedMarkdownPath}.`
    );
  }

  const markdown = await readText(cachedMarkdownPath);
  if (!markdown.trim()) {
    throw new Error(
      `MarkPDFDown produced empty markdown for ${pdfPath}.\n`
      + 'Tip: verify the PDF is valid and the configured multimodal model can access the upstream API endpoint.'
    );
  }

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MARKPDFDOWN,
    parserCommand: `${pythonCommand} ${MARKPDFDOWN_WRAPPER_PATH}`
  };
}

async function convertPdfToMarkdownViaMineru(pdfPath, options = {}) {
  const { mineruHttpUrl, mineruCommand, runDir, quiet = false } = options;
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const timings = createMineruParserTimings();

  // 如果使用 HTTP API 直接调用
  if (mineruHttpUrl && !runDir) {
    const pdfBuffer = await measureDuration(timings, 'pdfReadMs', () => fs.readFile(pdfPath));
    const formData = new FormData();
    formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `${basename}.pdf`);

    if (!quiet) {
      process.stderr.write(`[mineru:${basename}] Uploading PDF to ${mineruHttpUrl}\n`);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await measureDuration(timings, 'mineruRequestMs', () => fetch(mineruHttpUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      }));

      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new Error(`Mineru API returned ${response.status}`);
      }

      const result = await response.json();
      const markdown = result.markdown || result.content || result.text || '';

      if (!markdown) {
        throw new Error(`Mineru returned empty markdown for ${pdfPath}`);
      }

      return {
        markdown,
        parserCommand: `mineru (http@${mineruHttpUrl})`,
        timings
      };
    } catch (error) {
      clearTimeout(timeoutHandle);
      if (error.name === 'AbortError') {
        throw new Error(`Mineru request timed out after ${timeoutMs}ms for ${pdfPath}`);
      }
      throw error;
    }
  }

  // 如果使用本地 mineru 命令调用远程服务
  const args = [
    '-p',
    pdfPath,
    '-o',
    runDir,
    '-b',
    'vlm-http-client',
    '-u',
    mineruHttpUrl || mineruCommand
  ];

  if (!quiet) {
    process.stderr.write(`[mineru:${basename}] Running local mineru with remote backend\n`);
  }
  await measureDuration(timings, 'mineruRequestMs', () => runCommand('mineru', args, {
    onStdout: quiet ? () => {} : undefined,
    onStderr: quiet ? () => {} : undefined,
    timeoutMs,
    timeoutLabel: `mineru parse for ${pdfPath}`
  }));

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  const markdown = await readText(generatedMarkdownPath);

  return {
    markdown,
    parserCommand: `mineru -b vlm-http-client -u ${mineruHttpUrl || mineruCommand}`,
    timings
  };
}

async function convertPdfToMarkdownWithMarker(pdfPath, options = {}) {
  const {
    markerCommand = process.env.PAPERNEXUS_MARKER_CMD || 'marker_single',
    markerSshHost = '',
    pdfParserSshHost = '',
    markerDir,
    markdownDir,
    force = false,
    pageRange,
    pdfSshHost = process.env.PAPERNEXUS_PDF_SSH_HOST || ''
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`marker:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const markerBlockBlacklist = resolveMarkerBlockBlacklist(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MARKER, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_MARKER,
      currentStep: 'reusing cached marker markdown',
      message: 'Reusing cached Marker markdown',
      parserCommand: markerCommand
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MARKER,
      parserCommand: markerCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const remoteMarkerHost = resolveRemoteMarkerHost({
    markerSshHost,
    pdfParserSshHost,
    pdfSshHost
  });

  if (remoteMarkerHost) {
    try {
      await tracker?.update?.({
        status: 'running',
        activeParser: PDF_PARSER_MARKER,
        currentStep: `delegating to remote marker host ${remoteMarkerHost}`,
        message: `Delegating to remote Marker host ${remoteMarkerHost}`
      });
      const remoteResult = await convertPdfToMarkdownViaRemoteMarker(pdfPath, {
        ...options,
        markerCommand,
        markerSshHost: remoteMarkerHost,
        pageRange
      });
      await writeText(cachedMarkdownPath, remoteResult.markdown);
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_MARKER,
        parserCommand: remoteResult.markerCommand
      };
    } catch (error) {
      if (!pdfSshHost) {
        throw new Error(
          `Remote Marker failed for ${pdfPath}. ${error.message}\n` +
          'Tip: verify SSH access and the remote Marker command, or provide `--pdf-ssh-host` for remote pypdf fallback.'
        );
      }
    }
  }

  const args = [
    pdfPath,
    '--output_format',
    'markdown',
    '--disable_image_extraction',
    '--output_dir',
    runDir
  ];

  if (pageRange) {
    args.push('--page_range', String(pageRange));
  }

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_MARKER,
      currentStep: 'running local marker',
      message: 'Running local Marker'
    });
    process.stderr.write(`[marker:${basename}] Running local marker\n`);
    await runCommand(markerCommand, args, {
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `marker parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    if (!pdfSshHost) {
      throw new Error(
        `Marker failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify the PDF opens correctly, install Marker locally, provide `--marker-ssh-host` or `--pdf-ssh-host`, or ingest Markdown directly instead.'
      );
    }

    const fallbackMarkdown = await extractPdfViaRemotePypdf(pdfPath, pdfSshHost);
    await writeText(cachedMarkdownPath, fallbackMarkdown);
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: true,
      parser: PDF_PARSER_MARKER,
      parserCommand: `${markerCommand} (fallback: remote-pypdf@${pdfSshHost})`
    };
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  const filteredMarkdown = filterMarkerMarkdown(await readText(generatedMarkdownPath), markerBlockBlacklist);
  if (!filteredMarkdown.trim()) {
    throw new Error(
      `Marker finished for ${pdfPath} but the configured marker block blacklist removed all markdown content.`
    );
  }
  await writeText(cachedMarkdownPath, filteredMarkdown);

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MARKER,
    parserCommand: markerCommand
  };
}

async function convertPdfToMarkdownWithDocling(pdfPath, options = {}) {
  const {
    doclingCommand = process.env.PAPERNEXUS_DOCLING_CMD || 'docling',
    doclingPython = resolveDoclingPython(options),
    doclingOcrEngine = process.env.PAPERNEXUS_DOCLING_OCR_ENGINE || '',
    doclingPdfBackend = process.env.PAPERNEXUS_DOCLING_PDF_BACKEND || '',
    doclingSshHost = '',
    pdfParserSshHost = '',
    markerDir,
    markdownDir,
    force = false,
    pageRange,
    pdfSshHost = process.env.PAPERNEXUS_PDF_SSH_HOST || ''
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`docling:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_DOCLING, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_DOCLING,
      currentStep: 'reusing cached docling markdown',
      message: 'Reusing cached Docling markdown',
      parserCommand: doclingCommand
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_DOCLING,
      parserCommand: doclingCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  if (!options.skipDoclingWarmup) {
    try {
      await tracker?.update?.({
        status: 'running',
        activeParser: PDF_PARSER_DOCLING,
        currentStep: 'warming docling runtime',
        message: 'Warming Docling runtime'
      });
      await warmDoclingRuntime({
        ...options,
        doclingCommand,
        doclingPython,
        doclingOcrEngine,
        doclingPdfBackend,
        doclingSshHost,
        pdfParserSshHost,
        pdfSshHost,
        pdfParseTracker: null,
        skipDoclingWarmup: true
      });
    } catch (error) {
      process.stderr.write(`[docling:${basename}] Warmup failed; continuing with direct parse (${error.message || error})\n`);
    }
  }

  const remoteDoclingHost = resolveRemoteDoclingHost({
    doclingSshHost,
    pdfParserSshHost,
    pdfSshHost
  });
  const fallbackPdfHost = pdfSshHost || remoteDoclingHost;

  if (remoteDoclingHost) {
    try {
      await tracker?.update?.({
        status: 'running',
        activeParser: PDF_PARSER_DOCLING,
        currentStep: `delegating to remote docling host ${remoteDoclingHost}`,
        message: `Delegating to remote Docling host ${remoteDoclingHost}`
      });
      const remoteResult = await convertPdfToMarkdownViaRemoteDocling(pdfPath, {
        ...options,
        doclingCommand,
        doclingSshHost: remoteDoclingHost,
        pageRange,
        doclingOcrEngine,
        doclingPdfBackend
      });
      await writeText(cachedMarkdownPath, remoteResult.markdown);
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_DOCLING,
        parserCommand: remoteResult.parserCommand
      };
    } catch (error) {
      if (!fallbackPdfHost) {
        throw new Error(
          `Remote Docling failed for ${pdfPath}. ${error.message}\n` +
          'Tip: verify SSH access and the remote Docling command, or provide `--pdf-ssh-host` for remote pypdf fallback.'
        );
      }
    }
  }

  if (pageRange) {
    throw new Error('Docling page-range forwarding is not currently supported. Use `--pdf-parser marker` when you need `--page-range`.');
  }

  if (resolveDoclingUseVlm(options)) {
    const runtime = await buildDoclingVlmRuntime(options);
    const args = [
      DOCLING_WRAPPER_PATH,
      '--input',
      pdfPath,
      '--output',
      cachedMarkdownPath,
      '--use-vlm',
      '--vlm-preset',
      runtime.preset,
      '--provider',
      runtime.provider,
      '--model-name',
      runtime.modelName,
      '--base-url',
      runtime.baseUrl,
      '--max-tokens',
      String(runtime.maxTokens),
      ...(doclingOcrEngine ? ['--ocr-engine', doclingOcrEngine] : []),
      ...(doclingPdfBackend ? ['--pdf-backend', doclingPdfBackend] : [])
    ];

    const lease = await acquirePdfParserLease(PDF_PARSER_DOCLING, options, `docling:${basename}:vlm`, tracker);
    try {
      await tracker?.update?.({
        status: 'running',
        activeParser: PDF_PARSER_DOCLING,
        currentStep: 'running docling VLM pipeline',
        message: 'Running Docling VLM pipeline'
      });
      process.stderr.write(`[docling:${basename}] Running docling VLM pipeline\n`);
      await runCommand(doclingPython, args, {
        env: {
          ...buildPdfParserExecutionEnv(PDF_PARSER_DOCLING, options),
          ...runtime.env,
          ...(lease?.env || {})
        },
        onStdout: progress,
        onStderr: progress,
        timeoutMs,
        timeoutLabel: `docling VLM parse for ${pdfPath}`
      });
      flushProgressReporter(progress);
    } catch (error) {
      throw new Error(
        `Docling VLM failed for ${pdfPath}. ${error.message}\n`
        + 'Tip: verify the selected Python environment can import `docling`, and that the configured OpenAI-compatible endpoint is reachable.'
      );
    } finally {
      await lease?.release?.();
    }

    if (!await fileExists(cachedMarkdownPath)) {
      throw new Error(`Docling VLM finished for ${pdfPath} but no markdown cache was written to ${cachedMarkdownPath}.`);
    }

    const markdown = await readText(cachedMarkdownPath);
    if (!markdown.trim()) {
      throw new Error(`Docling VLM produced empty markdown for ${pdfPath}.`);
    }

    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: true,
      parser: PDF_PARSER_DOCLING,
      parserCommand: `${doclingPython} ${DOCLING_WRAPPER_PATH} --use-vlm`
    };
  }

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_DOCLING,
      currentStep: 'running local docling',
      message: 'Running local Docling'
    });
    process.stderr.write(`[docling:${basename}] Running local docling\n`);
    await runLocalDoclingCli(pdfPath, runDir, {
      ...options,
      doclingCommand,
      doclingOcrEngine,
      doclingPdfBackend
    }, {
      tracker,
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `docling parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    if (!fallbackPdfHost) {
      throw new Error(
        `Docling failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify Docling is installed locally, provide `--docling-ssh-host` for remote parsing, or use `--pdf-parser marker`.'
      );
    }

    const fallbackMarkdown = await extractPdfViaRemotePypdf(pdfPath, fallbackPdfHost);
    await writeText(cachedMarkdownPath, fallbackMarkdown);
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: true,
      parser: PDF_PARSER_DOCLING,
      parserCommand: `${doclingCommand} (fallback: remote-pypdf@${fallbackPdfHost})`
    };
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  await writeText(cachedMarkdownPath, await readText(generatedMarkdownPath));

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_DOCLING,
    parserCommand: doclingCommand
  };
}

async function convertPdfToMarkdownWithMineru(pdfPath, options = {}) {
  const {
    mineruCommand = process.env.PAPERNEXUS_MINERU_CMD || 'mineru',
    mineruHttpUrl = '',
    pdfParserHttpUrl = '',
    markerDir,
    markdownDir,
    force = false,
    quiet = false
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MINERU, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_MINERU,
      currentStep: 'reusing cached mineru markdown',
      message: 'Reusing cached MinerU markdown',
      parserCommand: mineruCommand
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MINERU,
      parserCommand: mineruCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const resolvedHttpUrl = resolveMineruHttpUrl({ mineruHttpUrl, pdfParserHttpUrl });
  const remoteFailureMode = resolveMineruRemoteFailureMode(options);
  const parserTimings = createMineruParserTimings();

  if (resolvedHttpUrl) {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_MINERU,
      currentStep: `probing mineru backend ${resolvedHttpUrl}`,
      message: `Probing MinerU backend ${resolvedHttpUrl}`
    });
    const reachability = await probeHttpEndpoint(resolvedHttpUrl, 6000, options);
    parserTimings.probeHttpMs = Number(reachability.durationMs || 0);
    if (!reachability.reachable) {
      const warning = `Remote MinerU backend is unreachable at ${resolvedHttpUrl}: ${reachability.error}`;
      process.stderr.write(`[mineru:${basename}] WARNING: ${warning}\n`);

      if (remoteFailureMode === 'docling') {
        process.stderr.write(`[mineru:${basename}] Falling back to docling because --mineru-remote-failure docling is enabled\n`);
        return convertPdfToMarkdownWithDocling(pdfPath, {
          ...options,
          force,
          quiet
        });
      }

      throw new Error(
        `${warning}\n` +
        'Tip: bring the MinerU HTTP backend back online, switch to `--pdf-parser docling`, or set `--mineru-remote-failure docling` to fall back automatically.'
      );
    }

    try {
      await tracker?.update?.({
        status: 'running',
        activeParser: PDF_PARSER_MINERU,
        currentStep: `running mineru via ${resolvedHttpUrl}`,
        message: `Running MinerU via remote backend ${resolvedHttpUrl}`
      });
      const remoteResult = await convertPdfToMarkdownViaMineru(pdfPath, {
        mineruCommand,
        mineruHttpUrl: resolvedHttpUrl,
        runDir,
        quiet
      });
      mergeMineruParserTimings(parserTimings, remoteResult.timings);
      await measureDuration(parserTimings, 'markdownWriteMs', () => writeText(cachedMarkdownPath, remoteResult.markdown));
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_MINERU,
        parserCommand: remoteResult.parserCommand,
        timings: parserTimings
      };
    } catch (error) {
      resetMineruProbeCache(resolvedHttpUrl);
      throw new Error(
        `Mineru failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify the mineru HTTP API endpoint is accessible, switch to `--pdf-parser docling`, or set `--mineru-remote-failure docling`.'
      );
    }
  }

  // Fallback: local mineru without remote backend
  const args = [
    '-p',
    pdfPath,
    '-o',
    runDir
  ];

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_MINERU,
      currentStep: 'running local mineru',
      message: 'Running local MinerU'
    });
    await runCommand('mineru', args, {
      onStdout: quiet ? () => {} : undefined,
      onStderr: quiet ? () => {} : undefined,
      timeoutMs,
      timeoutLabel: `mineru parse for ${pdfPath}`
    });
  } catch (error) {
    throw new Error(
      `Mineru failed for ${pdfPath}. ${error.message}\n` +
      'Tip: verify mineru is installed and the HTTP endpoint is provided via --mineru-http-url or PAPERNEXUS_MINERU_HTTP_URL.'
    );
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  await measureDuration(parserTimings, 'markdownWriteMs', async () => {
    await writeText(cachedMarkdownPath, await readText(generatedMarkdownPath));
  });

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MINERU,
    parserCommand: mineruCommand,
    timings: parserTimings
  };
}

async function convertPdfToMarkdownWithPaddleOcrVl(pdfPath, options = {}) {
  const {
    markerDir,
    markdownDir,
    force = false
  } = options;

  const pythonCommand = resolvePaddleOcrVlPython(options);
  const serverUrl = resolvePaddleOcrVlServerUrl(options);
  const layoutModel = resolvePaddleOcrVlLayoutModel(options);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const tracker = options.pdfParseTracker || null;
  const progress = createProgressReporter(`paddleocr-vl:${basename}`, tracker);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_PADDLEOCR_VL, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    await tracker?.update?.({
      status: 'cache-hit',
      activeParser: PDF_PARSER_PADDLEOCR_VL,
      currentStep: 'reusing cached paddleocr-vl markdown',
      message: 'Reusing cached PaddleOCR-VL markdown',
      parserCommand: `${pythonCommand} ${PADDLEOCR_VL_WRAPPER_PATH}`
    });
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_PADDLEOCR_VL,
      parserCommand: `${pythonCommand} ${PADDLEOCR_VL_WRAPPER_PATH}`
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const args = [
    PADDLEOCR_VL_WRAPPER_PATH,
    '--input',
    pdfPath,
    '--output',
    cachedMarkdownPath,
    '--server-url',
    serverUrl,
    '--layout-model',
    layoutModel
  ];

  try {
    await tracker?.update?.({
      status: 'running',
      activeParser: PDF_PARSER_PADDLEOCR_VL,
      currentStep: `running paddleocr-vl via ${serverUrl}`,
      message: `Running PaddleOCR-VL via remote server ${serverUrl}`
    });
    process.stderr.write(`[paddleocr-vl:${basename}] Running PaddleOCR-VL via remote server ${serverUrl}\n`);
    await runCommand(pythonCommand, args, {
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `paddleocr-vl parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    throw new Error(
      `PaddleOCR-VL failed for ${pdfPath}. ${error.message}\n` +
      `Tip: verify the PaddleOCR-VL remote server is reachable at \`${serverUrl}\` and \`${pythonCommand}\` can import \`PaddleOCRVL\`.`
    );
  }

  if (!await fileExists(cachedMarkdownPath)) {
    throw new Error(
      `PaddleOCR-VL finished for ${pdfPath} but no markdown cache was written to ${cachedMarkdownPath}.`
    );
  }

  const markdown = await readText(cachedMarkdownPath);
  if (!markdown.trim()) {
    throw new Error(
      `PaddleOCR-VL produced empty markdown for ${pdfPath}.\n` +
      'Tip: verify the PDF is valid and the PaddleOCR-VL runtime can parse the selected document.'
    );
  }

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_PADDLEOCR_VL,
    parserCommand: `${pythonCommand} ${PADDLEOCR_VL_WRAPPER_PATH}`
  };
}

export async function warmMineruHttpEndpoint(url, options = {}) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return {
      url: '',
      reachable: false,
      status: null,
      error: 'No MinerU HTTP URL configured.',
      cached: false
    };
  }

  const timeoutMs = Number(options.timeoutMs || options.probeTimeoutMs || 6000);
  const result = await probeHttpEndpoint(normalizedUrl, timeoutMs, options);
  return {
    url: normalizedUrl,
    reachable: result.reachable,
    status: result.status,
    error: result.error,
    cached: Boolean(result.cached)
  };
}

export async function convertPdfToMarkdown(pdfPath, options = {}) {
  const parser = normalizePdfParser(options.pdfParser);
  const selectedParser = options.pdfParseSelectedParser || parser;
  const { tracker, owned } = await resolvePdfParseTracker(pdfPath, parser, {
    ...options,
    pdfParseSelectedParser: selectedParser
  });
  await tracker?.update?.({
    selectedParser,
    activeParser: parser,
    status: 'starting',
    currentStep: `starting ${parser} parser`,
    message: `Starting ${parser} parser`
  });
  const convertWithSelectedParser = async () => {
    if (parser === PDF_PARSER_MARKITDOWN) {
      return convertPdfToMarkdownWithMarkItDown(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        markitdownPython: resolvePdfParserCommandOption(PDF_PARSER_MARKITDOWN, options)
      });
    }

    if (parser === PDF_PARSER_MARKPDFDOWN) {
      return convertPdfToMarkdownWithMarkPdfDown(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        markpdfdownPython: resolvePdfParserCommandOption(PDF_PARSER_MARKPDFDOWN, options)
      });
    }

    if (parser === PDF_PARSER_OPENDATALOADER) {
      return convertPdfToMarkdownWithOpenDataLoader(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        opendataloaderPdfPython: resolvePdfParserCommandOption(PDF_PARSER_OPENDATALOADER, options)
      });
    }

    if (parser === PDF_PARSER_MARKER) {
      return convertPdfToMarkdownWithMarker(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        markerCommand: resolvePdfParserCommandOption(PDF_PARSER_MARKER, options)
      });
    }

    if (parser === PDF_PARSER_MINERU) {
      return convertPdfToMarkdownWithMineru(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        mineruCommand: resolvePdfParserCommandOption(PDF_PARSER_MINERU, options)
      });
    }

    if (parser === PDF_PARSER_PADDLEOCR_VL) {
      return convertPdfToMarkdownWithPaddleOcrVl(pdfPath, {
        ...options,
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser
      });
    }

    return convertPdfToMarkdownWithDocling(pdfPath, {
      ...options,
      pdfParseTracker: tracker,
      pdfParseSelectedParser: selectedParser,
      doclingCommand: resolvePdfParserCommandOption(PDF_PARSER_DOCLING, options)
    });
  };

  try {
    const result = await convertWithSelectedParser();
    const withTracker = {
      ...result,
      pdfParseRunId: tracker?.runId || null,
      pdfParseStatePath: tracker?.statePath || null,
      pdfParseLogPath: tracker?.eventsPath || null
    };
    if (owned) {
      await tracker?.finish?.('completed', result.generated === false ? 'Reused cached parser output' : `Completed ${withTracker.parser} parse`, {
        activeParser: withTracker.parser,
        parserCommand: withTracker.parserCommand || null,
        fallbackFromParser: withTracker.fallbackFromParser || options.pdfParseFallbackFrom || null
      });
    }
    return withTracker;
  } catch (error) {
    const fallbackParser = resolvePdfParserFallback(parser, options);
    if (!fallbackParser) {
      if (owned) {
        await tracker?.finish?.('failed', error.message, {
          activeParser: parser
        });
      }
      throw error;
    }

    process.stderr.write(
      `[${parser}:${path.basename(pdfPath, path.extname(pdfPath))}] Primary parser failed; falling back to ${fallbackParser}\n`
    );
    await tracker?.log?.('warn', `Primary parser ${parser} failed; falling back to ${fallbackParser}: ${error.message}`);
    await tracker?.update?.({
      status: 'fallback',
      activeParser: fallbackParser,
      fallbackFromParser: parser,
      currentStep: `falling back from ${parser} to ${fallbackParser}`,
      message: `Falling back from ${parser} to ${fallbackParser}`
    });

    try {
      const fallbackResult = await convertPdfToMarkdown(pdfPath, {
        ...options,
        pdfParser: fallbackParser,
        pdfCommand: resolvePdfParserCommandOption(fallbackParser, options),
        pdfParseTracker: tracker,
        pdfParseSelectedParser: selectedParser,
        pdfParseFallbackFrom: parser,
        force: true
      });
      const withFallback = {
        ...fallbackResult,
        fallbackFromParser: parser
      };
      if (owned) {
        await tracker?.finish?.('completed', `Completed ${withFallback.parser} parse via fallback from ${parser}`, {
          activeParser: withFallback.parser,
          parserCommand: withFallback.parserCommand || null,
          fallbackFromParser: parser
        });
      }
      return withFallback;
    } catch (fallbackError) {
      if (owned) {
        await tracker?.finish?.('failed', `${error.message}\n${fallbackParser} fallback also failed for ${pdfPath}. ${fallbackError.message}`, {
          activeParser: fallbackParser,
          fallbackFromParser: parser
        });
      }
      throw new Error(`${error.message}\n${fallbackParser} fallback also failed for ${pdfPath}. ${fallbackError.message}`);
    }
  }
}

export const __pdfParserTestables = {
  shellQuote,
  normalizePdfParser,
  getPdfParserProfile,
  resolveMarkItDownPython,
  resolveMarkItDownUseLlm,
  resolveMarkItDownEnablePlugins,
  resolveMarkItDownLlmPrompt,
  hasExplicitMarkItDownUseLlmSetting,
  hasExplicitMarkItDownEnablePluginsSetting,
  buildMarkItDownRuntime,
  resolveMarkPdfDownPython,
  resolveMarkerBlockBlacklist,
  resolveOpenDataLoaderPdfPython,
  resolveDoclingPython,
  resolveDoclingDevice,
  resolveDoclingCudaVisibleDevices,
  resolveDoclingAutoGpu,
  resolveDoclingGpuLockRoot,
  resolveDoclingGpuMinFreeMb,
  resolveDoclingGpuWaitTimeoutMs,
  resolveDoclingGpuPollIntervalMs,
  resolveDoclingGpuLockStaleMs,
  resolveDoclingCpuThreads,
  resolveDoclingArtifactsPath,
  resolveDoclingImageExportMode,
  resolveDoclingEnrichPictureClasses,
  resolveDoclingEnrichPictureDescription,
  resolveDoclingPreload,
  resolveDoclingPreloadTimeoutMs,
  buildDoclingHuggingFaceEnv,
  resolvePaddleOcrVlPython,
  resolvePaddleOcrVlServerUrl,
  resolveRemoteMarkerHost,
  filterMarkerMarkdown,
  resolveMineruRemoteFailureMode,
  resolveMineruProbeCacheTtlMs,
  resolvePdfParseTimeoutMs,
  probeHttpEndpoint,
  resetMineruProbeCache,
  parseNvidiaSmiGpuLines,
  acquirePdfParserLease,
  acquireDoclingGpuLease,
  buildPdfParserExecutionEnv,
  buildDoclingExecutionEnv,
  buildRemoteMarkerScript,
  buildRemoteDoclingScript,
  warmDoclingRuntime
};

export const __markerTestables = __pdfParserTestables;
