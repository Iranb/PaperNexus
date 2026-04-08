#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { applyProcessConfig, getDefaultRuntimeConfigRoot, loadRuntimeConfig, resolvePathWithHome } from '../src/lib/config.js';
import { convertPdfToMarkdown, normalizePdfParser } from '../src/core/ingestion/marker.js';

function parseArgv(argv) {
  const flags = {};
  const positionals = [];

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
    positionals.push(arg);
  }

  return { flags, positionals };
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getSection(config, sectionName) {
  const value = config?.[sectionName];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback = undefined) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildPdfOptions(flags, config) {
  const analyzeConfig = getSection(config, 'analyze');
  const materializeConfig = getSection(config, 'materialize');
  const llmConfig = getSection(config, 'llm');
  const ollamaConfig = getSection(config, 'ollama');
  return {
    pdfParser: firstDefined(flags['pdf-parser'], materializeConfig.pdfParser, analyzeConfig.pdfParser, 'markpdfdown'),
    pdfCommand: firstDefined(flags['pdf-cmd'], materializeConfig.pdfCommand, analyzeConfig.pdfCommand),
    markpdfdownPython: firstDefined(flags['markpdfdown-python'], materializeConfig.markpdfdownPython, analyzeConfig.markpdfdownPython),
    opendataloaderPdfPython: firstDefined(flags['opendataloader-pdf-python'], materializeConfig.opendataloaderPdfPython, analyzeConfig.opendataloaderPdfPython),
    pdfParserSshHost: firstDefined(flags['pdf-parser-ssh-host'], materializeConfig.pdfParserSshHost, analyzeConfig.pdfParserSshHost),
    doclingPython: firstDefined(flags['docling-python'], materializeConfig.doclingPython, analyzeConfig.doclingPython),
    doclingCommand: firstDefined(flags['docling-cmd'], materializeConfig.doclingCommand, analyzeConfig.doclingCommand),
    doclingUseVlm: toBoolean(firstDefined(flags['docling-vlm'], materializeConfig.doclingUseVlm, analyzeConfig.doclingUseVlm), false),
    doclingVlmPreset: firstDefined(flags['docling-vlm-preset'], materializeConfig.doclingVlmPreset, analyzeConfig.doclingVlmPreset),
    doclingSshHost: firstDefined(flags['docling-ssh-host'], materializeConfig.doclingSshHost, analyzeConfig.doclingSshHost, materializeConfig.pdfParserSshHost, analyzeConfig.pdfParserSshHost),
    doclingOcrEngine: firstDefined(flags['docling-ocr-engine'], materializeConfig.doclingOcrEngine, analyzeConfig.doclingOcrEngine),
    doclingPdfBackend: firstDefined(flags['docling-pdf-backend'], materializeConfig.doclingPdfBackend, analyzeConfig.doclingPdfBackend),
    markerCommand: firstDefined(flags['marker-cmd'], materializeConfig.markerCommand, analyzeConfig.markerCommand),
    markerSshHost: firstDefined(flags['marker-ssh-host'], materializeConfig.markerSshHost, analyzeConfig.markerSshHost, materializeConfig.pdfParserSshHost, analyzeConfig.pdfParserSshHost),
    markerBlockBlacklist: firstDefined(flags['marker-block-blacklist'], materializeConfig.markerBlockBlacklist, analyzeConfig.markerBlockBlacklist),
    mineruCommand: firstDefined(flags['mineru-cmd'], materializeConfig.mineruCommand, analyzeConfig.mineruCommand),
    mineruHttpUrl: firstDefined(flags['mineru-http-url'], materializeConfig.mineruHttpUrl, analyzeConfig.mineruHttpUrl, materializeConfig.pdfCommand, analyzeConfig.pdfCommand),
    mineruRemoteFailureMode: firstDefined(flags['mineru-remote-failure'], materializeConfig.mineruRemoteFailureMode, analyzeConfig.mineruRemoteFailureMode, 'error'),
    paddleocrVlPython: firstDefined(flags['paddleocr-vl-python'], materializeConfig.paddleocrVlPython, analyzeConfig.paddleocrVlPython),
    paddleocrVlServerUrl: firstDefined(flags['paddleocr-vl-server-url'], materializeConfig.paddleocrVlServerUrl, analyzeConfig.paddleocrVlServerUrl, 'http://127.0.0.1:8080/v1'),
    paddleocrVlLayoutModel: firstDefined(flags['paddleocr-vl-layout-model'], materializeConfig.paddleocrVlLayoutModel, analyzeConfig.paddleocrVlLayoutModel, 'PP-DocLayout-S'),
    pdfParseTimeoutMs: toNumber(firstDefined(flags['timeout-ms'], materializeConfig.pdfParseTimeoutMs, analyzeConfig.pdfParseTimeoutMs), undefined),
    pageRange: firstDefined(flags['page-range'], materializeConfig.pageRange, analyzeConfig.pageRange),
    force: Boolean(flags.force),
    llmProvider: firstDefined(flags.provider, llmConfig.provider),
    llmModel: firstDefined(flags.model, flags['ollama-model'], llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(flags['base-url'], flags.url, flags['ollama-url'], llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(flags['api-key'], llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(flags['api-key-env'], llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(flags['api-key-source'], llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(flags.service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(flags.account, llmConfig.apiKeyAccount),
    llmMaxTokens: toNumber(firstDefined(flags['max-tokens'], llmConfig.maxTokens), undefined)
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

async function runPdfProbe(pdfPath, options) {
  const startedAt = Date.now();
  const rawResult = await convertPdfToMarkdown(pdfPath, options);
  const elapsedMs = Date.now() - startedAt;
  const markdownStats = await fs.stat(rawResult.markdownPath);
  return {
    rawResult,
    result: {
      parser: rawResult.parser,
      parserCommand: rawResult.parserCommand,
      markdownPath: rawResult.markdownPath,
      markdownSizeBytes: markdownStats.size,
      markdownSizeHuman: formatBytes(markdownStats.size),
      generated: Boolean(rawResult.generated)
    },
    timings: {
      elapsedMs
    }
  };
}

function buildFailingPrimaryProbeOptions(baseOptions, requestedParser) {
  const primaryParser = normalizePdfParser(requestedParser);
  const missingCommand = `__papernexus_missing_${primaryParser.replace(/[^a-z0-9]+/gi, '_')}__`;
  const options = {
    ...baseOptions,
    pdfParser: primaryParser,
    force: true,
    disableDoclingFallback: false
  };

  if (primaryParser === 'markpdfdown') {
    return {
      primaryParser,
      options: {
        ...options,
        markpdfdownPython: missingCommand
      }
    };
  }

  if (primaryParser === 'opendataloader') {
    return {
      primaryParser,
      options: {
        ...options,
        opendataloaderPdfPython: missingCommand
      }
    };
  }

  if (primaryParser === 'marker') {
    return {
      primaryParser,
      options: {
        ...options,
        markerCommand: missingCommand
      }
    };
  }

  if (primaryParser === 'mineru') {
    return {
      primaryParser,
      options: {
        ...options,
        mineruHttpUrl: 'http://127.0.0.1:9',
        mineruRemoteFailureMode: 'error',
        cacheTtlMs: 0
      }
    };
  }

  if (primaryParser === 'paddleocr-vl') {
    return {
      primaryParser,
      options: {
        ...options,
        paddleocrVlPython: missingCommand
      }
    };
  }

  throw new Error(
    `Cannot run a docling fallback probe with primary parser \`${primaryParser}\`. `
    + 'Use one of: markpdfdown, opendataloader, marker, mineru, paddleocr-vl.'
  );
}

function buildTimingComparison(configuredProbe, fallbackProbe) {
  const configuredElapsedMs = Number(configuredProbe?.timings?.elapsedMs || 0);
  const fallbackElapsedMs = Number(fallbackProbe?.timings?.elapsedMs || 0);
  const signedDeltaMs = fallbackElapsedMs - configuredElapsedMs;
  let fasterProbe = 'tie';
  if (signedDeltaMs < 0) fasterProbe = 'docling-fallback';
  if (signedDeltaMs > 0) fasterProbe = 'configured';
  return {
    configuredParser: configuredProbe?.result?.parser || '',
    configuredElapsedMs,
    doclingFallbackParser: fallbackProbe?.result?.parser || '',
    doclingFallbackElapsedMs: fallbackElapsedMs,
    deltaMs: Math.abs(signedDeltaMs),
    signedDeltaMs,
    fasterProbe
  };
}

function printUsage() {
  console.log(`Usage:
  node ./scripts/test-pdf-to-markdown.js <pdf-path> [--config <path>] [--no-config] [--force] [--json]
  node ./scripts/test-pdf-to-markdown.js <pdf-path> [--verify-docling-fallback] [--fallback-primary-parser <parser>]

Behavior:
  - loads the same config resolution flow as PaperNexus CLI
  - runs convertPdfToMarkdown() with parser settings from config
  - optionally runs a second synthetic probe to verify docling fallback
  - writes parser cache into ~/.papernexus/pdf-bench by default
  - records input file size and total processing time for each probe
`);
}

async function main() {
  const { flags, positionals } = parseArgv(process.argv.slice(2));
  if (flags.help || flags.h) {
    printUsage();
    process.exit(0);
  }

  if (positionals.length === 0) {
    printUsage();
    process.exit(1);
  }

  if (flags.config === true) {
    throw new Error('Missing value for `--config <path>`.');
  }

  const pdfPath = path.resolve(process.cwd(), String(positionals[0]));
  const sourceStats = await fs.stat(pdfPath);
  if (!sourceStats.isFile()) {
    throw new Error(`Not a file: ${pdfPath}`);
  }
  if (path.extname(pdfPath).toLowerCase() !== '.pdf') {
    throw new Error(`Expected a PDF file: ${pdfPath}`);
  }

  const { config, path: configPath } = await loadRuntimeConfig({
    cwd: process.cwd(),
    path: flags.config,
    disabled: Boolean(flags['no-config'])
  });
  const configBaseDir = configPath ? path.dirname(configPath) : process.cwd();
  applyProcessConfig(config, configBaseDir);

  const runtimeRoot = getDefaultRuntimeConfigRoot();
  const benchRoot = resolvePathWithHome(flags['cache-root'] || path.join(runtimeRoot, 'pdf-bench'));
  const markerDir = path.join(benchRoot, 'marker');
  const markdownDir = path.join(benchRoot, 'markdown');
  await fs.mkdir(markerDir, { recursive: true });
  await fs.mkdir(markdownDir, { recursive: true });

  const options = buildPdfOptions(flags, config);
  const parser = normalizePdfParser(options.pdfParser);
  const configuredProbe = await runPdfProbe(pdfPath, {
    ...options,
    markerDir,
    markdownDir
  });

  const payload = {
    input: {
      pdfPath,
      fileSizeBytes: sourceStats.size,
      fileSizeHuman: formatBytes(sourceStats.size)
    },
    config: {
      configPath,
      parser,
      cacheRoot: benchRoot
    },
    result: configuredProbe.result,
    timings: configuredProbe.timings,
    generatedAt: new Date().toISOString()
  };

  if (flags['verify-docling-fallback']) {
    const requestedFallbackPrimaryParser = firstDefined(
      flags['fallback-primary-parser'],
      parser === 'docling' ? 'marker' : parser
    );
    const fallbackProbeConfig = buildFailingPrimaryProbeOptions({
      ...options,
      markerDir,
      markdownDir
    }, requestedFallbackPrimaryParser);
    const fallbackProbe = await runPdfProbe(pdfPath, fallbackProbeConfig.options);
    payload.fallbackCheck = {
      checked: true,
      primaryParser: fallbackProbeConfig.primaryParser,
      fallbackTriggered: Boolean(fallbackProbe.rawResult.fallbackFromParser),
      fallbackFromParser: fallbackProbe.rawResult.fallbackFromParser || null,
      result: fallbackProbe.result,
      timings: fallbackProbe.timings
    };
    payload.comparison = buildTimingComparison(configuredProbe, fallbackProbe);
  }

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`PDF: ${payload.input.pdfPath}`);
  console.log(`Input size: ${payload.input.fileSizeHuman} (${payload.input.fileSizeBytes} bytes)`);
  console.log(`Config: ${payload.config.configPath || 'default search path'}`);
  console.log(`Parser: ${payload.config.parser}`);
  console.log(`Generated: ${payload.result.generated ? 'yes' : 'cache hit'}`);
  console.log(`Markdown: ${payload.result.markdownPath}`);
  console.log(`Markdown size: ${payload.result.markdownSizeHuman} (${payload.result.markdownSizeBytes} bytes)`);
  console.log(`Elapsed: ${payload.timings.elapsedMs} ms`);
  if (payload.result.parserCommand) {
    console.log(`Parser command: ${payload.result.parserCommand}`);
  }
  if (payload.fallbackCheck?.checked) {
    console.log('');
    console.log(`Docling fallback probe primary parser: ${payload.fallbackCheck.primaryParser}`);
    console.log(`Docling fallback triggered: ${payload.fallbackCheck.fallbackTriggered ? 'yes' : 'no'}`);
    console.log(`Docling fallback parser: ${payload.fallbackCheck.result.parser}`);
    console.log(`Docling fallback markdown: ${payload.fallbackCheck.result.markdownPath}`);
    console.log(`Docling fallback elapsed: ${payload.fallbackCheck.timings.elapsedMs} ms`);
  }
  if (payload.comparison) {
    console.log('');
    console.log(`Configured probe elapsed: ${payload.comparison.configuredElapsedMs} ms`);
    console.log(`Docling fallback elapsed: ${payload.comparison.doclingFallbackElapsedMs} ms`);
    console.log(`Elapsed delta: ${payload.comparison.deltaMs} ms`);
    console.log(`Faster probe: ${payload.comparison.fasterProbe}`);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
