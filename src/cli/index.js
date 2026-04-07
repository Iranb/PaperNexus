#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileExists } from '../lib/fs.js';
import { applyProcessConfig, getDefaultRuntimeConfigPath, getDefaultRuntimeConfigRoot, loadRuntimeConfig, resolvePathWithHome, saveRuntimeConfig } from '../lib/config.js';
import { toNumber } from '../lib/utils.js';
import { getWatchTmpLogPath } from '../lib/watch-log.js';

const HELP_TEXT = `
PaperNexus

Analysis and knowledge-graph engine for already-provided academic papers and corpora.
PaperNexus does not discover external literature or orchestrate multi-agent research workflows for you.

Global options:
  --config <path>     Use an explicit config JSON file
  --no-config         Ignore the default config search paths
  --quiet             Show minimal output with progress bar only

Commands:
  papernexus init [--force]
  papernexus analyze [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--pdf-parser <docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--pdf-parser-ssh-host <host>] [--docling-cmd <cmd>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--watch] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus materialize [<path>] [--name <corpus>] [--continue] [--force] [--rebuild-pdf-markdown] [--quiet] [--concurrency <n>] [--pdf-parser <docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--pdf-parser-ssh-host <host>] [--docling-cmd <cmd>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>]
  papernexus llm-optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus build-graph [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>]
  papernexus merge-graph [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus write-index [<path>] [--continue] [--force] [--quiet] [--node-llm-check]
  papernexus stage1 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage2 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage3 [<path>] [--name <corpus>] [--continue] [--force]
  papernexus stage4 [<path>] [--continue] [--force]
  papernexus optimize [<path>] [--name <corpus>] [--continue] [--force] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--node-llm-check] [--pdf-parser <docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--pdf-parser-ssh-host <host>] [--docling-cmd <cmd>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus watch [<path>] [--name <corpus>] [--quiet] [--concurrency <n>] [--semantic-extraction <auto|heuristic-only|llm-assisted|llm-primary>] [--pdf-parser <docling|marker|mineru|paddleocr-vl>] [--pdf-cmd <cmd>] [--pdf-parser-ssh-host <host>] [--docling-cmd <cmd>] [--docling-ssh-host <host>] [--docling-ocr-engine <name>] [--docling-pdf-backend <backend>] [--marker-cmd <cmd>] [--marker-ssh-host <host>] [--mineru-cmd <url>] [--mineru-http-url <url>] [--mineru-remote-failure <error|docling>] [--page-range <pages>] [--pdf-ssh-host <host>] [--debounce-ms <ms>] [--poll-interval-ms <ms>] [--ollama-model <name>] [--ollama-url <url>] [--ollama-relations] [--ollama-ssh-host <host>]
  papernexus probe [--provider <name>] [--model <name>] [--base-url <url>]  Test LLM connectivity
  papernexus clean [--corpus <name>]
  papernexus catalyst --target-domain <domain> [--challenge <text>] [--mechanism <name[,name...]>] [--limit <n>] [--corpus <name>]
  papernexus catalyst-backfill [<path>] [--name <corpus>] [--semantic-extraction <llm-assisted|llm-primary>] [--force]
  papernexus backup-export [archive-path] [--corpus <name>]
  papernexus backup-unpack <archive-path> --output <dir>
  papernexus backup-load <archive-path> --output <dir>
  papernexus logs watch
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus setup
  papernexus serve [--host 127.0.0.1] [--port 4821] [--api-token <token>]
  papernexus mcp

Scope boundary:
  - analyze, materialize, and import process papers, corpora, or manifests you already provide.
  - query, catalyst, and enhancement APIs operate on already-indexed graph state.
  - Discovery, external search, and orchestration live outside PaperNexus.

Docling PDF Backend Options:
  --docling-pdf-backend <backend>
    Choose the PDF parsing backend for Docling. Available backends:
    - pypdfium2    PyPDFium2 (recommended, fast and reliable)
    - pdfplumber   PdfPlumber (high precision, good for complex layouts)
    - fitz         PyMuPDF/Fitz (good for OCR-heavy documents)
    - pypdf        PyPDF (lightweight, basic functionality)
    Default: pypdfium2

Examples:
  papernexus init
  papernexus service install
  papernexus logs watch
  papernexus update [--force]                          Update PaperNexus to latest version from GitHub
  papernexus analyze ./papers --name ml-papers
  papernexus analyze ./papers --name ml-papers --concurrency 4
  papernexus analyze ./papers --name ml-papers --pdf-parser docling
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pypdfium2
  papernexus analyze ./papers --name ml-papers --pdf-parser docling --docling-pdf-backend pdfplumber
  papernexus analyze ./papers --name ml-papers --semantic-extraction auto --provider openai --model gpt-4o-mini
  papernexus analyze ./papers --name ml-papers --pdf-parser marker --marker-cmd marker_single --pdf-ssh-host 211.71.76.29 --ollama-model qwen2.5:0.5b --ollama-relations --ollama-ssh-host 211.71.76.29
  papernexus analyze ./papers --name ml-papers --pdf-parser mineru --mineru-http-url http://211.71.76.29:30000
  papernexus analyze ./papers --name ml-papers --pdf-parser paddleocr-vl
  papernexus materialize ./papers --name ml-papers --continue
  papernexus llm-optimize ./papers --name ml-papers --continue --semantic-extraction llm-primary --batch-size 16
  papernexus build-graph ./papers --name ml-papers --continue
  papernexus merge-graph ./papers --continue --node-llm-check
  papernexus write-index ./papers --continue --node-llm-check
  papernexus optimize ./papers --name ml-papers --continue --semantic-extraction llm-primary --node-llm-check --batch-size 16
  papernexus watch ./papers --name ml-papers
  papernexus enhance --once
  papernexus backup-export
  papernexus backup-export ./papernexus-backup.tgz
  papernexus backup-unpack ./papernexus-backup.tgz --output ./restored-papernexus
  papernexus auth llm set --provider openai --base-url https://coding.dashscope.aliyuncs.com/v1
  papernexus query "retrieval augmented experiment planning" --corpus ml-papers
  papernexus catalyst --target-domain Education --challenge "reduce confirmation bias during tutoring feedback" --mechanism "metacontrol policy" --corpus ml-papers
  papernexus catalyst-backfill ./papers --name ml-papers --semantic-extraction llm-assisted
  papernexus impact "semi-supervised learning" --corpus ml-papers --layers ProblemLayer,MethodLayer --layer-mode cross
  papernexus context "knowledge graph" --corpus ml-papers
  papernexus impact "Graph-Augmented Literature Mapping for Biomedical Discovery" --corpus ml-papers
  papernexus ideas "experiment planning with evidence tracing" --corpus ml-papers
  papernexus brainstorm "semi-supervised learning" --corpus ml-papers --mode diverge --hops 2
  papernexus serve
`;

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  const shortMap = {
    f: 'force'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [key, attachedValue] = arg.slice(2).split('=');
      if (attachedValue !== undefined) {
        flags[key] = attachedValue;
      } else if (argv[index + 1] && !argv[index + 1].startsWith('-')) {
        flags[key] = argv[index + 1];
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      for (const shortFlag of arg.slice(1)) {
        flags[shortMap[shortFlag] || shortFlag] = true;
      }
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseCommaSeparatedList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function maybeWarnAboutForceUsage(command, flags = {}) {
  if (!flags.force) {
    return;
  }

  const normalized = String(command || '').trim().toLowerCase();
  if (![
    'analyze',
    'materialize',
    'llm-optimize',
    'build-graph',
    'merge-graph',
    'write-index',
    'stage1',
    'stage2',
    'stage3',
    'stage4',
    'optimize'
  ].includes(normalized)) {
    return;
  }

  console.warn(
    `Warning: \`--force\` is intended for deliberate full rebuilds on \`${normalized}\`. `
    + 'Prefer plain `papernexus analyze` or `--continue` for routine updates, resume flows, and normal graph refreshes.'
  );
}

function maybeWarnAboutDisabledNodeLlmCheck(flags = {}) {
  if (!flags['node-llm-check']) {
    return;
  }

  console.warn(
    'Warning: `--node-llm-check` is temporarily disabled. '
    + 'PaperNexus will skip LLM-based node drop/rename decisions for the staged graph.'
  );
}

function createCliProgress(total, options = {}) {
  const quiet = Boolean(options.quiet);
  const prefix = options.prefix || 'Progress';
  let current = 0;
  let currentTotal = Math.max(1, Number(total || 1));
  let lastLabel = '';
  let startTime = Date.now();
  let redrawTimer = null;

  const formatTime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m${secs}s`;
  };

  const draw = (force = false) => {
    if (quiet || !process.stdout.isTTY) return;
    const safeTotal = Math.max(1, currentTotal);
    const displayCurrent = Math.min(current, safeTotal);
    const percent = Math.floor((displayCurrent / safeTotal) * 100);
    const width = 30;
    const filled = Math.floor((percent / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const elapsed = Date.now() - startTime;
    const rate = displayCurrent > 0 ? elapsed / displayCurrent : 0;
    const remaining = Math.max(0, safeTotal - displayCurrent) * rate;
    const eta = displayCurrent >= safeTotal ? '0s' : formatTime(remaining);
    const labelSuffix = lastLabel ? ` - ${lastLabel}` : '';
    process.stdout.write(`\r${prefix}: [${bar}] ${displayCurrent}/${safeTotal} (${percent}%) - ETA: ${eta} - Elapsed: ${formatTime(elapsed)}${labelSuffix}   `);
    if (force && displayCurrent >= safeTotal && !lastLabel) {
      process.stdout.write('');
    }
  };

  return {
    start() {
      if (!quiet && process.stdout.isTTY && !redrawTimer) {
        redrawTimer = setInterval(() => draw(), 1000);
      }
      draw(true);
    },
    update(completed, totalValue, label = '') {
      current = Math.max(0, Number(completed || 0));
      currentTotal = Math.max(1, Number(totalValue || currentTotal));
      lastLabel = String(label || '');
      draw(true);
    },
    done(label = '') {
      current = currentTotal;
      lastLabel = String(label || '');
      draw(true);
      if (redrawTimer) {
        clearInterval(redrawTimer);
        redrawTimer = null;
      }
      if (!quiet && process.stdout.isTTY) {
        const elapsed = formatTime(Date.now() - startTime);
        const suffix = lastLabel ? ` - ${lastLabel}` : '';
        process.stdout.write(`\r${prefix}: [${'█'.repeat(30)}] ${currentTotal}/${currentTotal} (100%) - Done in ${elapsed}${suffix}   \n`);
      }
    },
    stop() {
      if (redrawTimer) {
        clearInterval(redrawTimer);
        redrawTimer = null;
      }
      if (!quiet && process.stdout.isTTY) {
        process.stdout.write('\n');
      }
    }
  };
}

function announceCliStage(flags = {}, step, total, title, detail = '') {
  if (flags.quiet) return;
  const suffix = detail ? ` - ${detail}` : '';
  if (process.stdout.isTTY) {
    process.stdout.write(`\nStage ${step}/${total}: ${title}${suffix}\n`);
    return;
  }
  console.log(`Stage ${step}/${total}: ${title}${suffix}`);
}

function getGlobalConfig(config) {
  return normalizeObject(config.global);
}

function getSection(config, sectionName) {
  return normalizeObject(config[sectionName]);
}

function getSourcesConfig(config) {
  return normalizeObject(config.sources);
}

function getStorageConfig(config) {
  return normalizeObject(config.storage);
}

function normalizeConfiguredInputs(value, baseDir) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .map((item) => resolvePathWithHome(item, baseDir));
}

function resolveStorageRoot(config, baseDir) {
  const indexDir = getStorageConfig(config).indexDir;
  if (typeof indexDir !== 'string' || !indexDir.trim()) {
    return undefined;
  }

  return resolvePathWithHome(indexDir.trim(), baseDir);
}

function splitCommaSeparated(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSuggestedCorpusName(inputs, fallback = 'my-corpus') {
  if (inputs.length !== 1) return fallback;
  const normalized = inputs[0].replace(/[\\/]+$/, '');
  const baseName = path.basename(normalized);
  return baseName || fallback;
}

function getDefaultInitLlmModel(provider) {
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'anthropic') return 'claude-3-5-sonnet-latest';
  return 'qwen2.5:0.5b';
}

function buildLlmOptions(flags, config) {
  const llmConfig = getSection(config, 'llm');
  const ollamaConfig = getSection(config, 'ollama');

  return {
    llmProvider: firstDefined(flags.provider, llmConfig.provider),
    llmModel: firstDefined(flags.model, flags['ollama-model'], llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(flags['base-url'], flags.url, flags['ollama-url'], llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(flags['api-key'], llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(flags['api-key-env'], llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(flags['api-key-source'], llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(flags.service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(flags.account, llmConfig.apiKeyAccount),
    llmSshHost: firstDefined(flags['ssh-host'], flags['ollama-ssh-host'], llmConfig.sshHost, ollamaConfig.sshHost),
    llmRelations: firstDefined(flags.relations, flags['ollama-relations'], llmConfig.relations, ollamaConfig.relations),
    llmTimeoutMs: toNumber(firstDefined(flags['timeout-ms'], flags['ollama-timeout-ms'], llmConfig.timeoutMs, ollamaConfig.timeoutMs), undefined),
    llmBatchSize: toNumber(firstDefined(flags['batch-size'], flags['ollama-batch-size'], llmConfig.batchSize, ollamaConfig.batchSize), undefined),
    llmMaxTokens: toNumber(firstDefined(flags['max-tokens'], llmConfig.maxTokens), undefined),
    ollamaModel: firstDefined(flags['ollama-model'], ollamaConfig.model),
    ollamaUrl: firstDefined(flags['ollama-url'], ollamaConfig.url),
    ollamaSshHost: firstDefined(flags['ollama-ssh-host'], ollamaConfig.sshHost),
    ollamaRelations: firstDefined(flags['ollama-relations'], ollamaConfig.relations),
    ollamaTimeoutMs: toNumber(firstDefined(flags['ollama-timeout-ms'], ollamaConfig.timeoutMs), undefined),
    ollamaBatchSize: toNumber(firstDefined(flags['ollama-batch-size'], ollamaConfig.batchSize), undefined)
  };
}

function buildAnalyzeOptions(flags, config, commandName = 'analyze') {
  const analyzeConfig = getSection(config, 'analyze');
  const commandConfig = commandName === 'watch'
    ? { ...analyzeConfig, ...getSection(config, 'watch') }
    : analyzeConfig;
  const llmOptions = buildLlmOptions(flags, config);
  const llmSshHost = llmOptions.llmSshHost;

  return {
    name: firstDefined(flags.name, commandConfig.name),
    force: Boolean(firstDefined(flags.force, commandConfig.force)),
    continueMode: Boolean(firstDefined(flags.continue, commandConfig.continueMode, !firstDefined(flags.force, commandConfig.force))),
    quiet: Boolean(firstDefined(flags.quiet, commandConfig.quiet)),
    analyzeConcurrency: toNumber(firstDefined(flags.concurrency, flags['analyze-concurrency'], commandConfig.concurrency, commandConfig.analyzeConcurrency), undefined),
    semanticExtraction: firstDefined(flags['semantic-extraction'], commandConfig.semanticExtraction, 'auto'),
    nodeLlmCheck: Boolean(firstDefined(flags['node-llm-check'], commandConfig.nodeLlmCheck)),
    rebuildPdfMarkdown: Boolean(firstDefined(flags['rebuild-pdf-markdown'], commandConfig.rebuildPdfMarkdown)),
    pdfParser: firstDefined(flags['pdf-parser'], commandConfig.pdfParser, 'mineru'),
    pdfCommand: firstDefined(flags['pdf-cmd'], commandConfig.pdfCommand),
    pdfParserSshHost: firstDefined(flags['pdf-parser-ssh-host'], commandConfig.pdfParserSshHost),
    doclingCommand: firstDefined(flags['docling-cmd'], commandConfig.doclingCommand),
    doclingSshHost: firstDefined(flags['docling-ssh-host'], commandConfig.doclingSshHost, commandConfig.pdfParserSshHost, commandConfig.pdfSshHost),
    doclingOcrEngine: firstDefined(flags['docling-ocr-engine'], commandConfig.doclingOcrEngine),
    doclingPdfBackend: firstDefined(flags['docling-pdf-backend'], commandConfig.doclingPdfBackend),
    markerCommand: firstDefined(flags['marker-cmd'], commandConfig.markerCommand),
    markerSshHost: firstDefined(flags['marker-ssh-host'], commandConfig.markerSshHost, commandConfig.pdfParserSshHost, commandConfig.pdfSshHost),
    markerConcurrency: toNumber(firstDefined(flags['marker-concurrency'], commandConfig.markerConcurrency), undefined),
    mineruCommand: firstDefined(flags['mineru-cmd'], commandConfig.mineruCommand),
    mineruHttpUrl: firstDefined(flags['mineru-http-url'], commandConfig.mineruHttpUrl, commandConfig.pdfCommand),
    mineruRemoteFailureMode: firstDefined(flags['mineru-remote-failure'], commandConfig.mineruRemoteFailureMode, 'error'),
    paddleocrVlPython: firstDefined(commandConfig.paddleocrVlPython),
    paddleocrVlEnableHpi: firstDefined(commandConfig.paddleocrVlEnableHpi, true),
    paddleocrVlDevice: firstDefined(commandConfig.paddleocrVlDevice),
    paddleocrVlUseTensorRt: firstDefined(commandConfig.paddleocrVlUseTensorRt, false),
    pageRange: firstDefined(flags['page-range'], commandConfig.pageRange),
    pdfSshHost: firstDefined(flags['pdf-ssh-host'], commandConfig.pdfSshHost, commandConfig.pdfParserSshHost, llmSshHost),
    ...llmOptions,
    llmRelations: Boolean(llmOptions.llmRelations),
    ollamaSshHost: llmSshHost,
    ollamaRelations: Boolean(llmOptions.ollamaRelations),
    debounceMs: toNumber(firstDefined(flags['debounce-ms'], commandConfig.debounceMs), 700),
    pollIntervalMs: toNumber(firstDefined(flags['poll-interval-ms'], commandConfig.pollIntervalMs), 3000)
  };
}

function buildQueryOptions(flags, config) {
  const commandConfig = getSection(config, 'query');
  return {
    limit: toNumber(firstDefined(flags.limit, commandConfig.limit), 5),
    layers: firstDefined(flags.layers, commandConfig.layers)
  };
}

function buildContextOptions(flags, config) {
  const commandConfig = getSection(config, 'context');
  return {
    layers: firstDefined(flags.layers, commandConfig.layers),
    layerMode: firstDefined(flags['layer-mode'], commandConfig.layerMode, 'any')
  };
}

function buildImpactOptions(flags, config) {
  const commandConfig = getSection(config, 'impact');
  return {
    direction: firstDefined(flags.direction, commandConfig.direction, 'upstream'),
    maxDepth: toNumber(firstDefined(flags.depth, commandConfig.depth), 3),
    layers: firstDefined(flags.layers, commandConfig.layers),
    layerMode: firstDefined(flags['layer-mode'], commandConfig.layerMode, 'any')
  };
}

function buildIdeasOptions(flags, config) {
  const commandConfig = getSection(config, 'ideas');
  return {
    limit: toNumber(firstDefined(flags.limit, commandConfig.limit), 5),
    layers: firstDefined(flags.layers, commandConfig.layers)
  };
}

function buildBrainstormOptions(flags, config) {
  const commandConfig = getSection(config, 'brainstorm');
  return {
    mode: firstDefined(flags.mode, commandConfig.mode, 'diverge'),
    maxHops: toNumber(firstDefined(flags.hops, commandConfig.hops), 2),
    limit: toNumber(firstDefined(flags.limit, commandConfig.limit), 5),
    layers: firstDefined(flags.layers, commandConfig.layers),
    layerMode: firstDefined(flags['layer-mode'], commandConfig.layerMode, 'any')
  };
}

function buildCatalystOptions(flags, config) {
  const commandConfig = getSection(config, 'catalyst');
  return {
    limit: toNumber(firstDefined(flags.limit, commandConfig.limit), 5),
    targetDomain: firstDefined(flags['target-domain'], flags.domain, commandConfig.targetDomain),
    abstractChallenge: firstDefined(flags.challenge, commandConfig.challenge),
    mechanisms: parseCommaSeparatedList(firstDefined(flags.mechanisms, flags.mechanism, commandConfig.mechanisms))
  };
}

function buildCatalystBackfillOptions(flags, config) {
  const commandConfig = getSection(config, 'catalystBackfill');
  return {
    ...buildAnalyzeOptions(flags, config, 'analyze'),
    semanticExtraction: firstDefined(
      flags['semantic-extraction'],
      commandConfig.semanticExtraction,
      'llm-assisted'
    )
  };
}

function buildServeOptions(flags, config, baseDir = process.cwd(), configPath = null) {
  const commandConfig = getSection(config, 'serve');
  const storageConfig = getStorageConfig(config);
  const enhanceConfig = getSection(config, 'enhance');
  const rawBackupDir = firstDefined(commandConfig.backupDir, storageConfig.backupDir);
  return {
    host: firstDefined(flags.host, commandConfig.host),
    port: firstDefined(flags.port, commandConfig.port),
    apiToken: firstDefined(flags['api-token'], commandConfig.apiToken, process.env.PAPERNEXUS_API_TOKEN),
    backupDir: typeof rawBackupDir === 'string' && rawBackupDir.trim()
      ? resolvePathWithHome(rawBackupDir.trim(), baseDir)
      : undefined,
    enableEnhancements: firstDefined(flags.enhance, enhanceConfig.enabled, true) !== false,
    enhancementIntervalMs: toNumber(firstDefined(flags['interval-ms'], enhanceConfig.intervalMs), 5000),
    enhancementBackfillLimit: toNumber(firstDefined(flags['backfill-limit'], enhanceConfig.backfillLimit), 0),
    enhancementCatalystBackfill: firstDefined(flags['catalyst-backfill'], enhanceConfig.catalystBackfill, false) !== false,
    config,
    configBaseDir: baseDir,
    configPath
  };
}

function normalizeServeMcpPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '/mcp';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function buildEnhanceOptions(flags, config) {
  const commandConfig = getSection(config, 'enhance');
  return {
    ...buildLlmOptions(flags, config),
    once: Boolean(firstDefined(flags.once, commandConfig.once, false)),
    intervalMs: toNumber(firstDefined(flags['interval-ms'], commandConfig.intervalMs), 5000),
    backfillLimit: toNumber(firstDefined(flags['backfill-limit'], commandConfig.backfillLimit), 2),
    maxPasses: toNumber(firstDefined(flags['max-passes'], commandConfig.maxPasses), 32),
    catalystBackfill: firstDefined(flags['catalyst-backfill'], commandConfig.catalystBackfill, true) !== false,
    catalystSemanticExtraction: firstDefined(
      flags['semantic-extraction'],
      flags['catalyst-semantic-extraction'],
      commandConfig.semanticExtraction,
      commandConfig.catalystSemanticExtraction,
      getSection(config, 'analyze').semanticExtraction,
      'llm-assisted'
    )
  };
}

function resolveConfiguredCorpus(flags, config, positionalFallback, baseDir = process.cwd()) {
  const globalConfig = getGlobalConfig(config);
  return firstDefined(flags.corpus, positionalFallback, globalConfig.corpus, resolveStorageRoot(config, baseDir));
}

function resolveAnalyzeInput(config, baseDir, positionalInput) {
  const configuredRoot = resolveStorageRoot(config, baseDir);
  if (positionalInput) {
    return {
      input: positionalInput,
      rootPath: configuredRoot
    };
  }

  const configuredInputs = normalizeConfiguredInputs(getSourcesConfig(config).inputs, baseDir);
  if (!configuredInputs.length) {
    return {
      input: undefined,
      rootPath: configuredRoot
    };
  }

  return {
    input: configuredInputs,
    rootPath: configuredRoot || baseDir
  };
}

async function loadRuntimeModules() {
  const [
    ingestion,
    search,
    catalyst,
    render,
    mcpServer,
    httpServer,
    corpusStore,
    registry,
    enhancementWorker,
    enhancementStore,
    backupArchive
  ] = await Promise.all([
    import('../core/ingestion/pipeline.js'),
    import('../core/search/search.js'),
    import('../core/graph/catalyst-adapter.js'),
    import('../lib/render.js'),
    import('../mcp/server.js'),
    import('../server/http.js'),
    import('../storage/corpus-store.js'),
    import('../storage/registry.js'),
    import('../core/enhancements/worker.js'),
    import('../storage/enhancement-store.js'),
    import('../storage/backup-archive.js')
  ]);

  return {
    ...ingestion,
    ...search,
    ...catalyst,
    ...render,
    ...mcpServer,
    ...httpServer,
    ...corpusStore,
    ...registry,
    ...enhancementWorker,
    ...enhancementStore,
    ...backupArchive
  };
}

async function loadAuthModules() {
  const [
    llmRuntime,
    keychain,
    prompt
  ] = await Promise.all([
    import('../core/llm/ollama.js'),
    import('../lib/keychain.js'),
    import('../lib/prompt.js')
  ]);

  return {
    ...llmRuntime,
    ...keychain,
    ...prompt
  };
}

async function loadServiceModules() {
  const launchd = await import('../lib/launchd.js');
  return {
    ...launchd
  };
}

async function handleInitCommand(flags, config, configBaseDir, configPath) {
  const init = await loadAuthModules();
  const prompt = init.createPromptSession();
  const currentSources = Array.isArray(getSourcesConfig(config).inputs) ? getSourcesConfig(config).inputs : [];
  const defaultPaperSourceDir = path.join(getDefaultRuntimeConfigRoot(), 'papers');
  const defaultIndexDir = path.join(getDefaultRuntimeConfigRoot(), 'index-store');
  const currentAnalyze = getSection(config, 'analyze');
  const currentStorage = getStorageConfig(config);
  const currentServe = getSection(config, 'serve');
  const currentLlm = getSection(config, 'llm');
  const currentLegacyOllama = getSection(config, 'ollama');
  const currentGlobal = getGlobalConfig(config);
  let promptClosed = false;

  function printStep(stepNumber, title, description) {
    console.log('');
    console.log(`Step ${stepNumber}: ${title}`);
    console.log(description);
  }

  try {
    const targetConfigPath = configPath || path.join(configBaseDir, 'config.json');
    const existingConfigPath = configPath || targetConfigPath;
    if (configPath && !flags.force) {
      const shouldContinue = await prompt.promptConfirm(`Update existing config at ${existingConfigPath}?`, true);
      if (!shouldContinue) {
        console.log('Cancelled.');
        return;
      }
    }

    printStep(
      1,
      'Paper Sources',
      `Tell PaperNexus where your paper files live. You can enter one directory or multiple comma-separated directories. The default source directory is ${defaultPaperSourceDir}.`
    );
    const sourcesAnswer = await prompt.promptLine(
      'Paper source directory or directories (comma separated)',
      currentSources.length ? currentSources.join(', ') : defaultPaperSourceDir
    );
    const sourcesInputs = splitCommaSeparated(sourcesAnswer);
    if (!sourcesInputs.length) {
      throw new Error('At least one paper source directory is required.');
    }

    printStep(
      2,
      'Corpus Name',
      'This is the friendly name you will use later in commands like status, query, ideas, and brainstorm.'
    );
    const corpusName = (await prompt.promptLine(
      'Corpus name',
      currentAnalyze.name || currentGlobal.corpus || buildSuggestedCorpusName(sourcesInputs)
    )).trim();
    if (!corpusName) {
      throw new Error('Corpus name is required.');
    }

    printStep(
      3,
      'Index Directory',
      `This is where PaperNexus stores its generated index data, including the .papernexus folder, graph files, paper snapshots, and caches. It can be separate from your paper source directory. The default index directory is ${defaultIndexDir}.`
    );
    const indexDir = (await prompt.promptLine(
      'Index directory',
      currentStorage.indexDir || defaultIndexDir
    )).trim();
    if (!indexDir) {
      throw new Error('Index directory is required.');
    }

    printStep(
      4,
      'LLM Configuration',
      'This is optional. Configure it if you want LLM-assisted relation extraction during analyze/watch. You can skip it and keep the default heuristic graph build.'
    );
    const configureLlmNow = await prompt.promptConfirm(
      'Configure an LLM provider now?',
      Boolean(currentLlm.model || currentLegacyOllama.model)
    );

    let nextLlm = Object.keys(currentLlm).length ? { ...currentLlm } : null;
    let llmProvider = '';
    let keychainConfiguredNow = false;
    let keychainService = '';
    let keychainAccount = '';
    let shouldPromptForKeychain = false;

    if (configureLlmNow) {
      console.log('LLM provider: choose a provider from the list below. Use `openai` for OpenAI-compatible cloud APIs, `anthropic` for Claude-compatible APIs, or `ollama` for local models.');
      const requestedProvider = (await prompt.promptChoice(
        'LLM provider',
        ['ollama', 'openai', 'anthropic'],
        currentLlm.provider || (currentLegacyOllama.model ? 'ollama' : 'ollama')
      )).trim().toLowerCase();
      llmProvider = init.resolveLlmConfig({ llmProvider: requestedProvider }).provider;
      if (!['ollama', 'openai', 'anthropic'].includes(llmProvider)) {
        throw new Error(`Unsupported LLM provider: ${requestedProvider}`);
      }

      console.log('LLM model: enter the exact model identifier exposed by your provider.');
      const llmModel = (await prompt.promptLine(
        'LLM model',
        currentLlm.model || currentLegacyOllama.model || getDefaultInitLlmModel(llmProvider)
      )).trim();
      if (!llmModel) {
        throw new Error('LLM model is required.');
      }

      console.log('LLM base URL: this is the API root, usually something like https://.../v1 for cloud providers.');
      const llmBaseUrl = (await prompt.promptLine(
        'LLM base URL',
        currentLlm.baseUrl || currentLlm.url || currentLegacyOllama.url || init.getDefaultLlmBaseUrl(llmProvider)
      )).trim().replace(/\/+$/, '');
      if (!llmBaseUrl) {
        throw new Error('LLM base URL is required.');
      }

      console.log('Relation extraction: enable this if you want the model to help infer graph relations during indexing.');
      const llmRelations = await prompt.promptConfirm(
        'Enable LLM-assisted relation extraction?',
        currentLlm.relations ?? currentLegacyOllama.relations ?? true
      );

      nextLlm = {
        ...(currentLlm || {}),
        provider: llmProvider,
        model: llmModel,
        baseUrl: llmBaseUrl,
        relations: llmRelations
      };
      delete nextLlm.apiKey;

      if (llmProvider === 'openai' || llmProvider === 'anthropic') {
        nextLlm.apiKeyEnv = currentLlm.apiKeyEnv || init.getDefaultLlmApiKeyEnv(llmProvider);
        console.log('API key storage: on macOS you can keep the secret in Keychain so config.json only stores a reference, not the raw key.');
        const storeKeyNow = process.platform === 'darwin'
          ? await prompt.promptConfirm('Store an API key in macOS Keychain now?', currentLlm.apiKeySource === 'keychain')
          : false;

        if (storeKeyNow) {
          keychainConfiguredNow = true;
          shouldPromptForKeychain = true;
          keychainService = String(currentLlm.apiKeyService || init.getDefaultLlmKeychainService()).trim();
          keychainAccount = String(
            currentLlm.apiKeyAccount
            || init.buildDefaultLlmKeychainAccount({ provider: llmProvider, baseUrl: llmBaseUrl })
          ).trim();
          nextLlm.apiKeySource = 'keychain';
          nextLlm.apiKeyService = keychainService;
          nextLlm.apiKeyAccount = keychainAccount;
        } else {
          delete nextLlm.apiKeySource;
          delete nextLlm.apiKeyService;
          delete nextLlm.apiKeyAccount;
        }
      } else {
        delete nextLlm.apiKeyEnv;
        delete nextLlm.apiKeySource;
        delete nextLlm.apiKeyService;
        delete nextLlm.apiKeyAccount;
      }
    }

    if (shouldPromptForKeychain) {
      console.log('Keychain prompt: enter your LLM API key. The macOS prompt may label it as "password data", but this value is your provider API key, not your system login password.');
      prompt.close();
      promptClosed = true;
      await init.promptKeychainSecret({
        service: keychainService,
        account: keychainAccount
      });
    }

    const nextConfig = {
      ...config,
      sources: {
        ...(config.sources || {}),
        inputs: sourcesInputs
      },
      storage: {
        ...(config.storage || {}),
        indexDir
      },
      analyze: {
        ...(config.analyze || {}),
        name: corpusName,
        pdfParser: currentAnalyze.pdfParser || 'docling'
      },
      global: {
        ...(config.global || {}),
        corpus: corpusName
      },
      serve: {
        ...(config.serve || {}),
        host: currentServe.host || '127.0.0.1',
        port: currentServe.port || 4821
      }
    };

    if (nextLlm && Object.keys(nextLlm).length) {
      nextConfig.llm = nextLlm;
    }

    const saved = await saveRuntimeConfig(nextConfig, {
      cwd: configBaseDir,
      path: targetConfigPath
    });

    console.log(`Saved PaperNexus config to ${saved.path}`);
    console.log(`Sources: ${sourcesInputs.join(', ')}`);
    console.log(`Corpus: ${corpusName}`);
    console.log(`Index: ${indexDir}`);
    if (nextLlm?.provider && nextLlm?.model) {
      console.log(`LLM: ${nextLlm.provider} · ${nextLlm.model}`);
    }
    if ((llmProvider === 'openai' || llmProvider === 'anthropic') && !keychainConfiguredNow) {
      console.log('Tip: run `papernexus auth llm set --provider <name> --base-url <url>` later to store your API key in Keychain.');
    }
    console.log('Next: run `papernexus analyze` to build the first index. Add `--force` only when you intentionally want a full rebuild.');
  } finally {
    if (!promptClosed) {
      prompt.close();
    }
  }
}

function renderServiceStatus(statuses) {
  return statuses.map((status) => (
    `${status.service}: ${status.installed ? 'installed' : 'not-installed'}, ${status.loaded ? 'loaded' : 'not-loaded'}\n  ${status.launchAgentPath}`
  )).join('\n');
}

async function handleLogsCommand(positionals, config, configBaseDir) {
  const [target = 'watch'] = positionals;
  if (target !== 'watch') {
    throw new Error('Usage: `papernexus logs watch`.');
  }

  const watchRootPath = resolveStorageRoot(config, configBaseDir) || configBaseDir;
  const logPath = getWatchTmpLogPath(watchRootPath);

  console.log(`Watch log: ${logPath}`);

  if (!(await fileExists(logPath))) {
    console.log('No watch log has been written yet. Start `papernexus watch` or `papernexus service install` first.');
    return;
  }

  const content = await fs.readFile(logPath, 'utf8');
  if (!content.trim()) {
    console.log('(watch log is currently empty)');
    return;
  }

  process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

async function handleServiceCommand(flags, positionals, config, configPath) {
  const [action = 'status'] = positionals;
  if (!['install', 'uninstall', 'status'].includes(action)) {
    throw new Error('Usage: `papernexus service install|uninstall|status [--services watch,serve]`. `install` defaults to both watch and serve.');
  }

  const servicesApi = await loadServiceModules();
  const services = servicesApi.normalizeLaunchdServices(flags.services);
  const effectiveConfigPath = configPath || getDefaultRuntimeConfigPath();
  const cliPath = fileURLToPath(import.meta.url);
  const workingDirectory = path.dirname(effectiveConfigPath);
  const logsRoot = path.join(getDefaultRuntimeConfigRoot(), 'logs');
  const watchRootPath = resolveStorageRoot(config, workingDirectory) || workingDirectory;
  const serveConfig = getSection(config, 'serve');
  const dashboardHost = String(firstDefined(serveConfig.host, '127.0.0.1')).trim() || '127.0.0.1';
  const dashboardPort = Number(firstDefined(serveConfig.port, 4821)) || 4821;

  if (action === 'install') {
    if (!(await fileExists(effectiveConfigPath))) {
      throw new Error(`No config file found at ${effectiveConfigPath}. Run \`papernexus init\` first or pass \`--config <path>\`.`);
    }

    const installed = [];
    for (const service of services) {
      installed.push(await servicesApi.installLaunchdService(service, {
        nodePath: process.execPath,
        cliPath,
        configPath: effectiveConfigPath,
        workingDirectory,
        stdoutPath: path.join(logsRoot, `${service}.out.log`),
        stderrPath: path.join(logsRoot, `${service}.err.log`)
      }));
    }

    for (const service of installed) {
      console.log(`Installed ${service.service} background service: ${service.label}`);
      console.log(`  ${service.launchAgentPath}`);
    }
    if (services.includes('serve')) {
      console.log(`Dashboard: http://${dashboardHost}:${dashboardPort}`);
    }
    if (services.includes('watch')) {
      console.log(`Auto-index log: ${getWatchTmpLogPath(watchRootPath)}`);
    }
    console.log('Use `papernexus service status` to inspect the loaded state.');
    return;
  }

  if (action === 'uninstall') {
    for (const service of services) {
      const removed = await servicesApi.uninstallLaunchdService(service);
      console.log(`Uninstalled ${removed.service} background service: ${removed.label}`);
      console.log(`  ${removed.launchAgentPath}`);
    }
    return;
  }

  const statuses = [];
  for (const service of services) {
    statuses.push(await servicesApi.getLaunchdServiceStatus(service));
  }
  console.log(renderServiceStatus(statuses));
}

function buildPersistedLlmConfig(currentConfig, values = {}) {
  const nextConfig = {
    ...currentConfig,
    llm: {
      ...(currentConfig.llm || {})
    }
  };

  if (values.provider) {
    nextConfig.llm.provider = values.provider;
  }

  if (values.model) {
    nextConfig.llm.model = values.model;
  }

  if (values.baseUrl) {
    nextConfig.llm.baseUrl = values.baseUrl;
  }

  if (values.apiKeyEnv !== undefined) {
    if (values.apiKeyEnv) {
      nextConfig.llm.apiKeyEnv = values.apiKeyEnv;
    } else {
      delete nextConfig.llm.apiKeyEnv;
    }
  }

  if (values.apiKeySource) {
    nextConfig.llm.apiKeySource = values.apiKeySource;
  } else {
    delete nextConfig.llm.apiKeySource;
  }

  if (values.apiKeyService) {
    nextConfig.llm.apiKeyService = values.apiKeyService;
  } else {
    delete nextConfig.llm.apiKeyService;
  }

  if (values.apiKeyAccount) {
    nextConfig.llm.apiKeyAccount = values.apiKeyAccount;
  } else {
    delete nextConfig.llm.apiKeyAccount;
  }

  delete nextConfig.llm.apiKey;
  return nextConfig;
}

async function handleAuthCommand(flags, positionals, config, configBaseDir, configPath) {
  const [scope = '', action = ''] = positionals;
  if (scope !== 'llm' || (action !== 'set' && action !== 'clear' && action !== 'diagnose')) {
    throw new Error('Usage: `papernexus auth llm set|clear [--provider <name>] [--base-url <url>]`.');
  }

  const auth = await loadAuthModules();
  const resolved = auth.resolveLlmConfig(buildLlmOptions(flags, config));

  if (resolved.provider !== 'openai' && resolved.provider !== 'anthropic') {
    throw new Error('`papernexus auth llm` is for API-key providers. Use `--provider openai` for OpenAI-compatible endpoints like DashScope, or `--provider claudecode` / `anthropic` for Claude-compatible endpoints.');
  }

  const service = String(
    flags.service
    || resolved.apiKeyService
    || auth.getDefaultLlmKeychainService()
    || ''
  ).trim();
  const account = String(
    flags.account
    || resolved.apiKeyAccount
    || auth.buildDefaultLlmKeychainAccount({ provider: resolved.provider, baseUrl: resolved.baseUrl })
    || ''
  ).trim();

  if (!service || !account) {
    throw new Error('Keychain service and account are required.');
  }

  if (action === 'diagnose') {
    const auth = await loadAuthModules();
    const backends = await auth.getAvailableBackends();
    
    console.log('\nAvailable Key Storage Backends on this system:');
    backends.forEach((backend, idx) => {
      const marker = idx === 0 && backend.id !== 'encrypted' ? ' ← RECOMMENDED' : '';
      console.log(`  ${backend.name}${marker}`);
    });
    
    console.log('\nCurrent LLM Configuration:');
    const resolved = auth.resolveLlmConfig(buildLlmOptions(flags, config));
    console.log(`  Provider: ${resolved.provider}`);
    console.log(`  Model: ${resolved.model}`);
    console.log(`  Base URL: ${resolved.baseUrl}`);
    
    if (resolved.provider === 'openai' || resolved.provider === 'anthropic') {
      console.log(`  API Key Source: ${resolved.apiKeySource || 'environment variable / not configured'}`);
      if (resolved.apiKeySource === 'keychain') {
        console.log(`  API Key Service: ${resolved.apiKeyService}`);
        console.log(`  API Key Account: ${resolved.apiKeyAccount}`);
        
        // Check if key is stored
        try {
          const key = await auth.getKeychainSecret({ service: resolved.apiKeyService, account: resolved.apiKeyAccount });
          console.log(`  API Key Stored: ${key ? '✓ Yes' : '✗ No'}`);
        } catch {
          console.log('  API Key Stored: ✗ Unable to check');
        }
      }
    }
    
    console.log('\nTo configure your LLM API key, run:');
    console.log('  papernexus auth llm set --provider openai --base-url https://api.openai.com/v1');
    return;
  }

  if (action === 'set') {
    if (flags.stdin) {
      const secret = await auth.readSecretFromStdin();
      if (!secret) {
        throw new Error('API key cannot be empty.');
      }

      await auth.setKeychainSecret({ service, account, secret });
    } else {
      console.log('Keychain prompt: enter your LLM API key. The macOS prompt may label it as "password data", but this value is your provider API key, not your system login password.');
      await auth.promptKeychainSecret({ service, account });
    }

    const nextConfig = buildPersistedLlmConfig(config, {
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKeyEnv: resolved.apiKeyEnv || auth.getDefaultLlmApiKeyEnv(resolved.provider),
      apiKeySource: 'keychain',
      apiKeyService: service,
      apiKeyAccount: account
    });
    const saved = await saveRuntimeConfig(nextConfig, {
      cwd: configBaseDir,
      path: configPath
    });

    console.log(`Stored API key in macOS Keychain for ${resolved.provider} (${account}).`);
    console.log(`Updated ${saved.path} to use llm.apiKeySource="keychain".`);
    return;
  }

  await auth.deleteKeychainSecret({ service, account });
  const nextConfig = buildPersistedLlmConfig(config, {
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    apiKeyEnv: resolved.apiKeyEnv || auth.getDefaultLlmApiKeyEnv(resolved.provider),
    apiKeySource: '',
    apiKeyService: '',
    apiKeyAccount: ''
  });
  const saved = await saveRuntimeConfig(nextConfig, {
    cwd: configBaseDir,
    path: configPath
  });

  console.log(`Removed Keychain-backed API key binding for ${resolved.provider} (${account}).`);
  console.log(`Updated ${saved.path} to stop using llm.apiKeySource="keychain".`);
}

function logErrorAndExit(error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function handleProbeLlmCommand(flags, config) {
  const { loadLlmApiKey } = await import('../core/llm/ollama.js');

  const provider = flags.provider || config.llm?.provider || 'openai';
  const model = flags.model || config.llm?.model;
  const baseUrl = flags['base-url'] || config.llm?.baseUrl;

  const providerConfigs = {
    openai: {
      model: model || 'qwen3.5-plus',
      baseUrl: baseUrl || 'https://coding.dashscope.aliyuncs.com/v1',
      provider: 'openai'
    },
    anthropic: {
      model: model || 'claude-sonnet-4-20250514',
      baseUrl: baseUrl || 'https://api.anthropic.com/v1',
      provider: 'anthropic'
    }
  };

  const selectedConfig = providerConfigs[provider] || providerConfigs.openai;

  console.log(`Probing LLM connection...`);
  console.log(`Provider: ${provider}`);
  console.log(`Model: ${selectedConfig.model}`);
  console.log(`Base URL: ${selectedConfig.baseUrl}`);

  const apiKey = await loadLlmApiKey({
    ...config.llm,
    ...selectedConfig
  });

  if (!apiKey) {
    throw new Error('No API key found. Run `papernexus auth llm set` first.');
  }

  const testPrompt = 'Respond with exactly one word: PAPER_NEXUS_PROBE_OK';

  console.log('\nSending probe request...');

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 30000);

  try {
    let response;

    if (provider === 'openai' || selectedConfig.provider === 'openai') {
      response = await fetch(`${selectedConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedConfig.model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: 50
        })
      });
    } else if (provider === 'anthropic' || selectedConfig.provider === 'anthropic') {
      response = await fetch(`${selectedConfig.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedConfig.model,
          messages: [{ role: 'user', content: testPrompt }],
          max_tokens: 50
        })
      });
    }

    clearTimeout(timeoutHandle);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown');
      throw new Error(`API returned ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    const result = await response.json();

    let reply;
    if (provider === 'openai' || selectedConfig.provider === 'openai') {
      reply = result.choices?.[0]?.message?.content;
    } else {
      reply = result.content?.[0]?.text;
    }

    console.log('\nLLM Response:', reply?.trim());
    console.log('\nProbe PASSED - LLM is reachable and responding');
  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error('\nProbe FAILED:', error.message);
    process.exitCode = 1;
  }
}

function logChangeSummary(result, quiet = false) {
  if (!result?.changes) return;
  if (quiet) {
    console.log(
      `Changes: +${result.changes.added} ~${result.changes.updated} -${result.changes.removed} =${result.changes.reused}`
    );
  } else {
    console.log(
      `Changes: ${result.changes.added} added, ${result.changes.updated} updated, ${result.changes.removed} removed, ${result.changes.reused} reused`
    );
  }
}

function renderEnhancementSummary(summary) {
  if (!summary) return 'No enhancement summary available.';
  return [
    `Queue: ${summary.queue.pending} pending, ${summary.queue.running} running, ${summary.queue.completed} completed, ${summary.queue.failed} failed`,
    `Overlays: ${summary.ready} ready, ${summary.stale} stale, ${summary.failed} failed`
  ].join('\n');
}

async function loadSelectedCorpus(runtime, corpusFlag) {
  const rootPath = await runtime.resolveCorpus(corpusFlag);
  return runtime.loadCorpus(rootPath);
}

async function loadSelectedCorpusLite(runtime, corpusFlag) {
  const rootPath = await runtime.resolveCorpus(corpusFlag);
  return runtime.loadCorpusLite(rootPath);
}

async function handleUpdateCommand(flags) {
  const execFile = promisify(nodeExecFile);
  
  // Get the PaperNexus source directory (src/cli/index.js -> src -> . )
  const cliPath = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(cliPath);
  const papernexusDir = path.dirname(srcDir);
  
  console.log('Updating PaperNexus to latest version from GitHub...');
  
  try {
    // Check if PaperNexus source is a git repository
    await execFile('git', ['rev-parse', '--git-dir'], { cwd: papernexusDir });
  } catch (error) {
    throw new Error(
      'Not a git repository. PaperNexus must be cloned from GitHub to use update.\n'
      + 'Clone with: git clone https://github.com/Iranb/PaperNexus.git'
    );
  }
  
  try {
    // Fetch latest changes
    console.log('Fetching latest changes from origin/main...');
    await execFile('git', ['fetch', 'origin', 'main'], { cwd: papernexusDir });
    
    // Check current branch
    let currentBranch = '';
    try {
      const branchResult = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: papernexusDir });
      currentBranch = String(branchResult.stdout).trim();
    } catch {
      currentBranch = 'unknown';
    }
    
    if (currentBranch !== 'main') {
      console.warn(`Warning: You are on branch "${currentBranch}", not "main".`);
      const { createPromptSession } = await import('../lib/prompt.js');
      const shouldSwitch = await createPromptSession().promptConfirm('Switch to main and update?', true);
      
      if (!shouldSwitch && !flags.force) {
        console.log('Update cancelled.');
        return;
      }
      
      if (shouldSwitch) {
        console.log('Switching to main branch...');
        await execFile('git', ['checkout', 'main'], { cwd: papernexusDir });
      }
    }
    
    // Check for local changes
    try {
      const statusResult = await execFile('git', ['status', '--porcelain'], { cwd: papernexusDir });
      const hasChanges = String(statusResult.stdout).trim().length > 0;
      
      if (hasChanges && !flags.force) {
        throw new Error(
          'You have local changes. Commit or stash them before updating.\n'
          + 'Use --force to discard local changes (not recommended).'
        );
      }
      
      if (hasChanges && flags.force) {
        console.warn('Warning: Discarding local changes...');
        await execFile('git', ['checkout', '.'], { cwd: papernexusDir });
      }
    } catch (error) {
      if (!String(error?.message || '').includes('ENOENT')) {
        throw error;
      }
    }
    
    // Pull latest changes
    console.log('Pulling latest code...');
    const pullResult = await execFile('git', ['pull', 'origin', 'main'], { cwd: papernexusDir });
    const pullOutput = String(pullResult.stdout || pullResult.stderr).trim();
    
    if (pullOutput.includes('Already up to date')) {
      console.log('✓ Already up to date with latest version.');
    } else {
      console.log('✓ Updated successfully!');
      console.log(pullOutput);
    }
    
    // Show what's new
    try {
      const logResult = await execFile('git', ['log', '--oneline', '-5'], { cwd: papernexusDir });
      console.log('\nLatest commits:');
      console.log(String(logResult.stdout).trim());
    } catch {
      // Ignore log errors
    }
    
    console.log('\n💡 Tip: Restart your papernexus processes to use the updated code.');
    
  } catch (error) {
    throw new Error(`Update failed: ${error.message}`);
  }
}


async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseArgv(rest);

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP_TEXT.trim());
    return;
  }

  if (flags.help) {
    console.log(HELP_TEXT.trim());
    return;
  }

  if (flags.config === true) {
    throw new Error('Missing value for `--config <path>`.');
  }

  const { config, path: configPath } = await loadRuntimeConfig({
    cwd: process.cwd(),
    path: flags.config,
    disabled: Boolean(flags['no-config'])
  });
  const configBaseDir = configPath ? path.dirname(configPath) : process.cwd();
  applyProcessConfig(config, configBaseDir);

  if (command === 'init') {
    await handleInitCommand(flags, config, configBaseDir, configPath);
    return;
  }

  if (command === 'service') {
    await handleServiceCommand(flags, positionals, config, configPath);
    return;
  }

  if (command === 'logs') {
    await handleLogsCommand(positionals, config, configBaseDir);
    return;
  }

  if (command === 'update') {
    await handleUpdateCommand(flags);
    return;
  }

  if (command === 'auth') {
    await handleAuthCommand(flags, positionals, config, configBaseDir, configPath);
    return;
  }

  if (command === 'probe') {
    await handleProbeLlmCommand(flags, config);
    return;
  }

  const runtime = await loadRuntimeModules();
  const logEnhanceMessage = (message) => {
    console.log(runtime.formatEnhancementLogMessage(message));
  };

  if (command === 'backup-export') {
    const archiveTarget = positionals[0];
    const candidate = resolveConfiguredCorpus(flags, config, undefined, configBaseDir);
    const archivePath = archiveTarget ? resolvePathWithHome(archiveTarget, process.cwd()) : undefined;
    announceCliStage(flags, 1, 1, 'Exporting backup archive', 'capturing minimal committed graph state, runtime config, and markdown-first source files');
    const progress = createCliProgress(1, {
      quiet: Boolean(flags.quiet),
      prefix: 'Exporting backup'
    });
    progress.start();
    let result;
    try {
      result = await runtime.exportCorpusArchive(candidate, archivePath, {
        onProgress(update) {
          progress.update(update.completed, update.total, update.label);
        }
      });
      progress.done('archive ready');
    } catch (error) {
      progress.stop();
      throw error;
    }
    console.log(`Exported backup archive to ${result.archivePath}`);
    console.log(`Corpus: ${result.manifest.corpusName}`);
    console.log(`Sources captured: ${result.manifest.sources.length}`);
    return;
  }

  if (command === 'backup-unpack' || command === 'backup-load') {
    const archiveTarget = positionals[0];
    const outputTarget = flags.output || positionals[1];
    if (!archiveTarget || !outputTarget) {
      throw new Error('Usage: `papernexus backup-unpack <archive-path> --output <dir>`.');
    }

    announceCliStage(flags, 1, 1, 'Unpacking backup archive', 'restoring an inspectable directory without touching the live graph');
    const progress = createCliProgress(1, {
      quiet: Boolean(flags.quiet),
      prefix: 'Unpacking backup'
    });
    progress.start();
    let result;
    try {
      result = await runtime.unpackCorpusArchive(
        resolvePathWithHome(archiveTarget, process.cwd()),
        resolvePathWithHome(String(outputTarget), process.cwd()),
        {
          onProgress(update) {
            progress.update(update.completed, update.total, update.label);
          }
        }
      );
      progress.done('restore directory ready');
    } catch (error) {
      progress.stop();
      throw error;
    }
    console.log(`Unpacked backup archive to ${result.outputPath}`);
    if (result.manifest?.corpusName) {
      console.log(`Corpus: ${result.manifest.corpusName}`);
    }
    
    // Auto-register the unpacked corpus to make it visible in the web interface
    try {
      const { registerCorpus } = await import('../storage/registry.js');
      const { loadCorpusMeta } = await import('../storage/corpus-store.js');
      const corpusIndexPath = path.join(result.outputPath, 'index');
      
      try {
        const meta = await loadCorpusMeta(corpusIndexPath);
        await registerCorpus({
          name: meta.name,
          rootPath: corpusIndexPath,
          indexedAt: meta.indexedAt,
          paperCount: meta.paperCount
        });
        console.log(`✓ Registered corpus "${meta.name}" and it's now visible in the web interface.`);
      } catch (registrationError) {
        console.log('Note: The unpacked corpus was not automatically registered in the index.');
        console.log('You may inspect it before manually importing it later.');
      }
    } catch (error) {
      // Silently ignore if registration fails, the user can still access via path
    }
    return;
  }

  if ([
    'analyze',
    'materialize',
    'llm-optimize',
    'build-graph',
    'merge-graph',
    'write-index',
    'stage1',
    'stage2',
    'stage3',
    'stage4',
    'optimize'
  ].includes(command)) {
    maybeWarnAboutForceUsage(command, flags);
    maybeWarnAboutDisabledNodeLlmCheck(flags);

    const target = resolveAnalyzeInput(config, configBaseDir, positionals[0]);
    if (!target.input) {
      throw new Error(`Missing ${command} path. Example: \`papernexus ${command} ./papers\` or configure \`sources.inputs\` in config.json.`);
    }

    const isMaterialize = command === 'materialize' || command === 'stage1';
    const isLlmOptimize = command === 'llm-optimize' || command === 'stage2';
    const isBuildGraph = command === 'build-graph' || command === 'stage3';
    const isMergeGraph = command === 'merge-graph';
    const isWriteIndex = command === 'write-index' || command === 'stage4';
    const isOptimize = command === 'optimize';
    const runAsWatch = Boolean(firstDefined(flags.watch, getSection(config, 'analyze').watch));
    const analyzeOptions = {
      ...buildAnalyzeOptions(flags, config, runAsWatch ? 'watch' : 'analyze'),
      rootPath: target.rootPath,
      materializeOnly: isMaterialize,
      llmOnly: isLlmOptimize,
      optimizeOnly: isOptimize
    };
    if (runAsWatch) {
      await runtime.watchCorpus(target.input, analyzeOptions);
      return;
    }

    const result = isMaterialize
      ? await runtime.materializeCorpus(target.input, analyzeOptions)
      : isLlmOptimize
        ? await runtime.llmOptimizeCorpus(target.input, analyzeOptions)
        : isBuildGraph
          ? await runtime.buildGraphCorpus(target.input, analyzeOptions)
          : isMergeGraph
            ? await runtime.mergeGraphCorpus(target.input, analyzeOptions)
          : isWriteIndex
            ? await runtime.writeIndexCorpus(target.input, analyzeOptions)
      : isOptimize
        ? await runtime.optimizeCorpus(target.input, analyzeOptions)
        : await runtime.analyzeCorpus(target.input, analyzeOptions);
    const quiet = Boolean(flags.quiet);

    if (isMaterialize || result.stage === 'materialized') {
      if (quiet) {
        console.log(`Materialized corpus "${result.meta.name}" - ${result.meta.paperCount} papers cached`);
      } else {
        console.log(`Materialized corpus "${result.meta.name}" at ${result.rootPath}`);
        console.log(`Prepared ${result.meta.paperCount} papers into markdown cache + semantic snapshots`);
      }
      logChangeSummary(result, quiet);
      return;
    }

    if (isLlmOptimize || result.stage === 'llm-optimized') {
      if (quiet) {
        console.log(`LLM-optimized corpus "${result.meta.name}" - ${result.meta.paperCount} snapshots refreshed`);
      } else {
        console.log(`LLM-optimized snapshots for "${result.meta.name}" at ${result.rootPath}`);
        console.log(`Refreshed ${result.meta.paperCount} paper snapshots with semantic objects and relations`);
      }
      logChangeSummary(result, quiet);
      return;
    }

    if (isBuildGraph || result.stage === 'graph-built') {
      if (quiet) {
        console.log(`Built staged graph for "${result.meta.name}" - ${result.meta.paperCount} papers, ${result.meta.relationshipCount} relationships`);
      } else {
        console.log(`Built staged graph for "${result.meta.name}" at ${result.rootPath}`);
        console.log(runtime.renderStatus(result.meta));
        console.log('The merge stage is now ready: run `papernexus merge-graph` before `papernexus write-index`.');
      }
      logChangeSummary(result, quiet);
      return;
    }

    if (isMergeGraph || result.stage === 'graph-merged') {
      if (quiet) {
        console.log(`Merged similar evaluation nodes for "${result.meta.name}" - ${result.meta.nodeCount} nodes remain in the staged graph`);
      } else {
        console.log(`Merged similar evaluation nodes for "${result.meta.name}" at ${result.rootPath}`);
        console.log(runtime.renderStatus(result.meta));
        console.log('The staged graph is ready to commit: run `papernexus write-index`.');
      }
      logChangeSummary(result, quiet);
      return;
    }

    if (isWriteIndex || result.stage === 'index-written') {
      if (quiet) {
        console.log(`Committed staged graph for "${result.meta.name}" - ${result.meta.paperCount} papers, ${result.meta.relationshipCount} relationships`);
      } else {
        console.log(`Committed staged graph for "${result.meta.name}" at ${result.rootPath}`);
        console.log(runtime.renderStatus(result.meta));
      }
      logChangeSummary(result, quiet);
      return;
    }

    if (quiet) {
      console.log(`${isOptimize ? 'Optimized' : 'Indexed'} corpus "${result.meta.name}" - ${result.meta.paperCount} papers, ${result.meta.relationshipCount} relationships`);
    } else {
      console.log(`${isOptimize ? 'Optimized' : 'Indexed'} corpus "${result.meta.name}" at ${result.rootPath}`);
      console.log(runtime.renderStatus(result.meta));
    }
    logChangeSummary(result, quiet);
    return;
  }

  if (command === 'watch') {
    const target = resolveAnalyzeInput(config, configBaseDir, positionals[0]);
    if (!target.input) {
      throw new Error('Missing watch path. Example: `papernexus watch ./papers` or configure `sources.inputs` in config.json.');
    }

    await runtime.watchCorpus(target.input, {
      ...buildAnalyzeOptions(flags, config, 'watch'),
      rootPath: target.rootPath
    });
    return;
  }

  if (command === 'enhance') {
    const enhanceOptions = buildEnhanceOptions(flags, config);
    const corpusCandidate = resolveConfiguredCorpus(flags, config, positionals[0], configBaseDir);

    if (enhanceOptions.once) {
      if (corpusCandidate) {
        const rootPath = await runtime.resolveCorpus(corpusCandidate);
        const result = await runtime.runEnhancementQueueUntilIdle(rootPath, enhanceOptions);
        logEnhanceMessage(`Processed enhancement queue for ${rootPath}`);
        console.log(renderEnhancementSummary(result.summary));
        return;
      }

      const registry = await runtime.loadRegistry();
      for (const corpus of registry.corpora) {
        const result = await runtime.runEnhancementQueueUntilIdle(corpus.rootPath, enhanceOptions);
        logEnhanceMessage(`Processed enhancement queue for ${corpus.name}`);
        console.log(renderEnhancementSummary(result.summary));
      }
      return;
    }

    const rootPaths = corpusCandidate ? [await runtime.resolveCorpus(corpusCandidate)] : undefined;
    const worker = runtime.startEnhancementWorker({
      ...enhanceOptions,
      rootPaths,
      logger: console
    });

    logEnhanceMessage(`Enhancement worker running${rootPaths?.length ? ` for ${rootPaths[0]}` : ' for all indexed corpora'}. Press Ctrl+C to stop.`);
    await new Promise((resolve) => {
      const shutdown = () => {
        worker.stop();
        resolve();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return;
  }

  if (command === 'list') {
    const registry = await runtime.loadRegistry();
    console.log(runtime.renderCorpusList(registry.corpora));
    return;
  }

  if (command === 'status') {
    const { meta } = await loadSelectedCorpus(runtime, resolveConfiguredCorpus(flags, config, positionals[0], configBaseDir));
    console.log(runtime.renderStatus(meta));
    return;
  }

  if (command === 'query') {
    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing query text.');
    }

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderQueryResult(runtime.searchGraph(graph, query, buildQueryOptions(flags, config))));
    return;
  }

  if (command === 'catalyst') {
    const catalystOptions = buildCatalystOptions(flags, config);
    const targetDomain = String(catalystOptions.targetDomain || '').trim();
    if (!targetDomain) {
      throw new Error('Missing `--target-domain <domain>`.');
    }

    const abstractChallenge = String(
      catalystOptions.abstractChallenge || positionals.join(' ').trim()
    ).trim();

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderCatalystResult(runtime.buildCatalystQuery(graph, {
      targetDomain,
      abstractChallenge,
      mechanisms: catalystOptions.mechanisms,
      limit: catalystOptions.limit
    })));
    return;
  }

  if (command === 'catalyst-backfill') {
    const target = resolveAnalyzeInput(config, configBaseDir, positionals[0]);
    if (!target.input) {
      throw new Error('Missing catalyst-backfill path. Example: `papernexus catalyst-backfill ./papers --semantic-extraction llm-assisted`.');
    }

    const backfillOptions = {
      ...buildCatalystBackfillOptions(flags, config),
      rootPath: target.rootPath
    };
    const result = await runtime.backfillCatalystMetadataCorpus(target.input, backfillOptions);
    const quiet = Boolean(flags.quiet);

    if (quiet) {
      console.log(`Backfilled catalyst metadata for "${result.meta.name}" - ${result.meta.paperCount} papers, ${result.meta.relationshipCount} relationships`);
    } else {
      console.log(`Backfilled catalyst metadata for "${result.meta.name}" at ${result.rootPath}`);
      console.log(runtime.renderStatus(result.meta));
    }
    logChangeSummary(result, quiet);
    return;
  }

  if (command === 'context') {
    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing context target.');
    }

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderContextResult(runtime.buildContext(graph, query, buildContextOptions(flags, config))));
    return;
  }

  if (command === 'impact') {
    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing impact target.');
    }

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderImpactResult(runtime.buildImpact(graph, query, buildImpactOptions(flags, config))));
    return;
  }

  if (command === 'ideas') {
    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing research topic.');
    }

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderIdeasResult(runtime.buildResearchIdeas(graph, query, buildIdeasOptions(flags, config))));
    return;
  }

  if (command === 'brainstorm') {
    const query = positionals.join(' ').trim();
    if (!query) {
      throw new Error('Missing brainstorm topic.');
    }

    const { graph } = await loadSelectedCorpusLite(runtime, resolveConfiguredCorpus(flags, config, undefined, configBaseDir));
    console.log(runtime.renderBrainstormResult(runtime.buildBrainstorm(graph, query, buildBrainstormOptions(flags, config))));
    return;
  }

  if (command === 'clean') {
    const cleanedRoot = await runtime.cleanCorpus(resolveConfiguredCorpus(flags, config, positionals[0], configBaseDir));
    console.log(`Removed PaperNexus index from ${cleanedRoot}`);
    return;
  }

  if (command === 'setup') {
    const cliPath = fileURLToPath(import.meta.url);
    const projectRoot = path.resolve(path.dirname(cliPath), '../..');
    const absoluteCli = path.join(projectRoot, 'src/cli/index.js');
    const serveConfig = getSection(config, 'serve');
    const serveMcpConfig = serveConfig.mcp && typeof serveConfig.mcp === 'object' && !Array.isArray(serveConfig.mcp)
      ? serveConfig.mcp
      : {};
    const serveHost = String(firstDefined(serveConfig.host, '127.0.0.1')).trim() || '127.0.0.1';
    const servePort = Number(firstDefined(serveConfig.port, 4821)) || 4821;
    const mcpPath = normalizeServeMcpPath(serveMcpConfig.path);
    const remoteHost = serveHost === '0.0.0.0' ? '127.0.0.1' : serveHost;

    console.log('Codex / Claude / Cursor MCP snippets:');
    console.log('');
    console.log('[mcp_servers.papernexus]');
    console.log('command = "node"');
    console.log(`args = ["${absoluteCli}", "mcp"]`);
    console.log('');
    console.log('{');
    console.log('  "mcpServers": {');
    console.log('    "papernexus": {');
    console.log('      "command": "node",');
    console.log(`      "args": ["${absoluteCli}", "mcp"]`);
    console.log('    }');
    console.log('  }');
    console.log('}');

    if (serveMcpConfig.enabled === true) {
      console.log('');
      console.log('Remote HTTP MCP snippet:');
      console.log('');
      console.log('{');
      console.log('  "mcpServers": {');
      console.log('    "papernexus-remote": {');
      console.log(`      "url": "http://${remoteHost}:${servePort}${mcpPath}",`);
      console.log('      "transport": "streamable-http",');
      console.log('      "headers": {');
      console.log('        "Authorization": "Bearer ${PAPERNEXUS_MCP_TOKEN}"');
      console.log('      },');
      console.log('      "connectionTimeoutMs": 30000');
      console.log('    }');
      console.log('  }');
      console.log('}');
    }
    return;
  }

  if (command === 'serve') {
    await runtime.serveCommand(buildServeOptions(flags, config, configBaseDir, configPath));
    return;
  }

  if (command === 'mcp') {
    runtime.startMcpServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(logErrorAndExit);
