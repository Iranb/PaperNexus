#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined && value && !String(value).startsWith('--')) index += 1;
    const normalizedValue = value && !String(value).startsWith('--') ? value : 'true';
    if (options[key] === undefined) options[key] = normalizedValue;
    else options[key] = [...asArray(options[key]), normalizedValue];
  }

  const runId = String(options.runId || `graph-provenance-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'graph-provenance-audits', runId)),
    inputPaths: [
      ...asArray(options.input),
      ...asArray(options.graphExport),
      ...asArray(options.benchmarkReport),
      ...asArray(options.ideaPackets),
      ...asArray(options.methodEvidence)
    ].filter((value) => value && value !== 'true'),
    sourceCachePaths: asArray(options.sourceCache).filter((value) => value && value !== 'true')
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function addSourceText(sourceTexts, key, text) {
  const normalizedKey = compactText(key);
  const normalizedText = String(text || '');
  if (normalizedKey && normalizedText && !sourceTexts.has(normalizedKey)) {
    sourceTexts.set(normalizedKey, normalizedText);
  }
}

function collectSourceTexts(payload = {}, sourceTexts = new Map()) {
  for (const [key, value] of Object.entries(payload.sourceTexts || payload.sourceCache || {})) {
    if (typeof value === 'string') addSourceText(sourceTexts, key, value);
  }
  for (const source of asArray(payload.sources)) {
    const text = source.text || source.content || source.markdown || source.snippet || '';
    for (const key of [
      source.id,
      source.sourceId,
      source.sourceKey,
      source.sourcePath,
      source.path,
      source.url
    ]) {
      addSourceText(sourceTexts, key, text);
    }
  }
  return sourceTexts;
}

async function loadSourceTexts(paths = []) {
  const sourceTexts = new Map();
  for (const filePath of paths) {
    const payload = await readJson(filePath);
    if (typeof payload === 'object' && !Array.isArray(payload)) {
      const directTextMap = Object.values(payload).every((value) => typeof value === 'string');
      if (directTextMap) {
        for (const [key, text] of Object.entries(payload)) addSourceText(sourceTexts, key, text);
      }
      collectSourceTexts(payload, sourceTexts);
    }
  }
  return sourceTexts;
}

function collectRecords(payload = {}, label = 'input') {
  if (Array.isArray(payload)) {
    return payload.map((record, index) => ({ record, label, fallbackId: `${label}:record:${index}` }));
  }
  const groups = [
    ['records', payload.records],
    ['evidence', payload.evidence],
    ['evidenceRecords', payload.evidenceRecords],
    ['methodEvidence', payload.methodEvidence],
    ['nodes', payload.nodes],
    ['edges', payload.edges],
    ['relationships', payload.relationships],
    ['packets', payload.packets],
    ['ideaPackets', payload.ideaPackets],
    ['rows', payload.rows]
  ];
  return groups.flatMap(([kind, values]) => asArray(values).map((record, index) => ({
    record,
    label,
    kind,
    fallbackId: `${label}:${kind}:${index}`
  })));
}

function recordId(record = {}, fallbackId = '') {
  return compactText(record.id || record.edgeId || record.nodeId || record.recordId || record.key || fallbackId);
}

function sourceRefs(record = {}) {
  const refs = [
    record.sourceId,
    record.sourceKey,
    record.sourcePath,
    record.sourceRef,
    record.path,
    asObject(record.source).id,
    asObject(record.source).sourceId,
    asObject(record.source).sourceKey,
    asObject(record.source).sourcePath
  ];
  for (const span of [
    record.sourceSpan,
    ...asArray(record.sourceSpans),
    asObject(record.properties).sourceSpan,
    ...asArray(asObject(record.properties).sourceSpans)
  ]) {
    refs.push(span?.sourceId, span?.sourceKey, span?.sourcePath, span?.path);
  }
  return [...new Set(refs.map(compactText).filter(Boolean))];
}

function hasSourceSpan(record = {}) {
  const properties = asObject(record.properties);
  return Boolean(
    record.sourceSpan
    || asArray(record.sourceSpans).length
    || properties.sourceSpan
    || asArray(properties.sourceSpans).length
    || (record.start !== undefined && record.end !== undefined)
  );
}

function exactQuote(record = {}) {
  const properties = asObject(record.properties);
  return compactText(
    record.exactQuote
    || record.evidenceQuote
    || record.quote
    || properties.exactQuote
    || properties.evidenceQuote
    || properties.quote
  );
}

function renderMarkdown(report = {}) {
  const metrics = report.metrics || {};
  return [
    `# Graph Provenance Audit: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Records: ${metrics.records_total || 0}`,
    `- Source-span presence rate: ${metrics.source_span_presence_rate}`,
    `- Exact-quote presence rate: ${metrics.exact_quote_presence_rate}`,
    `- Exact-quote match rate: ${metrics.exact_quote_match_rate}`,
    `- Dangling source-link rate: ${metrics.dangling_source_link_rate}`,
    `- Schema violations: ${metrics.schema_violation_count}`,
    `- Zero query-time LLM invariant: ${metrics.zero_query_time_llm_invariant}`,
    '',
    '## Artifacts',
    '',
    `- \`${report.artifacts?.reportPath || ''}\``,
    `- \`${report.artifacts?.failuresPath || ''}\``
  ].join('\n');
}

export async function runGraphProvenanceAudit(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-provenance-audit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'graph-provenance-audits', runId));
  const inputPaths = asArray(inputOptions.inputPaths || inputOptions.input || []);
  const sourceCachePaths = asArray(inputOptions.sourceCachePaths || inputOptions.sourceCache || []);
  const reportPath = path.join(outputDir, 'report.json');
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  const failuresPath = path.join(outputDir, 'failures.jsonl');

  await ensureDir(outputDir);
  await fs.rm(failuresPath, { force: true });

  const loadedInputs = [];
  const sourceTexts = await loadSourceTexts(sourceCachePaths);
  for (const inputPath of inputPaths) {
    const payload = await readJson(inputPath);
    loadedInputs.push({ inputPath, payload });
    collectSourceTexts(payload, sourceTexts);
  }

  const records = loadedInputs.flatMap(({ inputPath, payload }) => collectRecords(payload, path.basename(inputPath)));
  const failures = [];
  let sourceSpanCount = 0;
  let quotePresenceCount = 0;
  let quoteCheckedCount = 0;
  let quoteMatchedCount = 0;
  let sourceRefCount = 0;
  let danglingSourceRefCount = 0;
  let schemaViolationCount = 0;

  for (const entry of records) {
    const record = asObject(entry.record);
    const id = recordId(record, entry.fallbackId);
    const refs = sourceRefs(record);
    const quote = exactQuote(record);
    const spanPresent = hasSourceSpan(record);

    if (!recordId(record)) {
      schemaViolationCount += 1;
      failures.push({ failureClass: 'SCHEMA_VIOLATION', id, reason: 'missing stable id' });
    }
    if (spanPresent) sourceSpanCount += 1;
    else failures.push({ failureClass: 'MISSING_SOURCE_SPAN', id, reason: 'record has no source span or equivalent snippet locator' });

    if (quote) quotePresenceCount += 1;
    sourceRefCount += refs.length;
    const resolvedTexts = [];
    for (const ref of refs) {
      const text = sourceTexts.get(ref);
      if (text) resolvedTexts.push(text);
      else {
        danglingSourceRefCount += 1;
        failures.push({ failureClass: 'DANGLING_SOURCE_LINK', id, sourceRef: ref });
      }
    }

    if (quote && resolvedTexts.length) {
      quoteCheckedCount += 1;
      if (resolvedTexts.some((text) => text.includes(quote))) quoteMatchedCount += 1;
      else failures.push({ failureClass: 'QUOTE_MISMATCH', id, quote });
    }
  }

  if (failures.length) {
    await writeText(failuresPath, failures.map((failure) => JSON.stringify(failure)).join('\n') + '\n');
  } else {
    await writeText(failuresPath, '');
  }

  const metrics = {
    records_total: records.length,
    source_span_presence_rate: records.length ? sourceSpanCount / records.length : 0,
    exact_quote_presence_rate: records.length ? quotePresenceCount / records.length : 0,
    exact_quote_match_rate: quoteCheckedCount ? quoteMatchedCount / quoteCheckedCount : null,
    dangling_source_link_rate: sourceRefCount ? danglingSourceRefCount / sourceRefCount : 0,
    schema_violation_count: schemaViolationCount,
    zero_query_time_llm_invariant: true
  };
  const report = {
    runId,
    kind: 'graph-provenance-audit',
    status: schemaViolationCount || danglingSourceRefCount || failures.some((failure) => failure.failureClass === 'QUOTE_MISMATCH')
      ? 'completed_with_findings'
      : 'completed',
    inputPaths: inputPaths.map((inputPath) => path.resolve(inputPath)),
    sourceCachePaths: sourceCachePaths.map((inputPath) => path.resolve(inputPath)),
    outputDir,
    metrics,
    failureCounts: failures.reduce((counts, failure) => {
      counts[failure.failureClass] = (counts[failure.failureClass] || 0) + 1;
      return counts;
    }, {}),
    artifacts: {
      reportPath,
      reportMarkdownPath,
      failuresPath
    }
  };

  await writeJson(reportPath, report);
  await writeText(reportMarkdownPath, renderMarkdown(report));
  return report;
}

async function main() {
  const report = await runGraphProvenanceAudit(parseArgs());
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    metrics: report.metrics
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
