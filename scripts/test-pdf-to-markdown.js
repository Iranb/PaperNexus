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
  return {
    pdfParser: firstDefined(flags['pdf-parser'], materializeConfig.pdfParser, analyzeConfig.pdfParser, 'mineru'),
    pdfCommand: firstDefined(flags['pdf-cmd'], materializeConfig.pdfCommand, analyzeConfig.pdfCommand),
    pdfParserSshHost: firstDefined(flags['pdf-parser-ssh-host'], materializeConfig.pdfParserSshHost, analyzeConfig.pdfParserSshHost),
    doclingCommand: firstDefined(flags['docling-cmd'], materializeConfig.doclingCommand, analyzeConfig.doclingCommand),
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
    force: Boolean(flags.force)
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

function printUsage() {
  console.log(`Usage:
  node ./scripts/test-pdf-to-markdown.js <pdf-path> [--config <path>] [--no-config] [--force] [--json]

Behavior:
  - loads the same config resolution flow as PaperNexus CLI
  - runs convertPdfToMarkdown() with parser settings from config
  - writes parser cache into ~/.papernexus/pdf-bench by default
  - records input file size and total processing time
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
  const startedAt = Date.now();
  const result = await convertPdfToMarkdown(pdfPath, {
    ...options,
    markerDir,
    markdownDir
  });
  const elapsedMs = Date.now() - startedAt;
  const markdownStats = await fs.stat(result.markdownPath);

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
    result: {
      parser: result.parser,
      parserCommand: result.parserCommand,
      markdownPath: result.markdownPath,
      markdownSizeBytes: markdownStats.size,
      markdownSizeHuman: formatBytes(markdownStats.size),
      generated: Boolean(result.generated)
    },
    timings: {
      elapsedMs
    },
    generatedAt: new Date().toISOString()
  };

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
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
