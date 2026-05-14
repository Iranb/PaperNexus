import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, readText } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

export const TRACE_SPAN_CONTRACT_VERSION = 'papernexus-trace-span-v1';

function nowIso() {
  return new Date().toISOString();
}

function encodeTraceId(traceId) {
  return encodeURIComponent(String(traceId || '').trim());
}

function normalizeStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeTraceStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['started', 'running', 'completed', 'failed', 'needs_repair', 'skipped'].includes(normalized)) {
    return normalized;
  }
  return normalized || 'started';
}

export function createTraceId(kind = 'trace', seed = '') {
  const normalizedKind = String(kind || 'trace').trim().replace(/[^A-Za-z0-9._=-]+/g, '_') || 'trace';
  const hash = stableHash(`${normalizedKind}:${seed}:${process.pid}:${Date.now()}:${Math.random()}`, 20);
  return `trace:${normalizedKind}:${hash}`;
}

export function getTraceStorePaths(rootPath, traceId = '') {
  const root = path.resolve(rootPath);
  const tracesDir = path.join(root, '.papernexus', 'traces');
  const encoded = traceId ? encodeTraceId(traceId) : '';
  return {
    rootPath: root,
    tracesDir,
    traceId,
    tracePath: encoded ? path.join(tracesDir, `${encoded}.jsonl`) : ''
  };
}

export function normalizeTraceSpan(span = {}) {
  const traceId = String(span.trace_id || span.traceId || '').trim();
  if (!traceId) {
    throw new Error('trace_id is required.');
  }
  const createdAt = span.created_at || span.createdAt || nowIso();
  const stage = String(span.stage || span.event || '').trim() || 'event';
  const spanId = String(span.span_id || span.spanId || '').trim()
    || `span:${stableHash(`${traceId}:${stage}:${createdAt}:${Math.random()}`, 16)}`;

  return {
    contract_version: TRACE_SPAN_CONTRACT_VERSION,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: span.parent_span_id || span.parentSpanId || null,
    stage,
    event: span.event || null,
    paper_id: span.paper_id || span.paperId || null,
    run_id: span.run_id || span.runId || null,
    artifact_paths: normalizeStringList(span.artifact_paths || span.artifactPaths),
    status: normalizeTraceStatus(span.status),
    duration_ms: Number.isFinite(Number(span.duration_ms ?? span.durationMs))
      ? Math.max(0, Number(span.duration_ms ?? span.durationMs))
      : 0,
    error_class: span.error_class || span.errorClass || null,
    message: span.message ? String(span.message) : '',
    data: span.data && typeof span.data === 'object' && !Array.isArray(span.data) ? span.data : null,
    created_at: createdAt
  };
}

export async function appendTraceSpan(rootPath, span = {}) {
  const normalized = normalizeTraceSpan(span);
  const { tracesDir, tracePath } = getTraceStorePaths(rootPath, normalized.trace_id);
  await ensureDir(tracesDir);
  await fs.appendFile(tracePath, `${JSON.stringify(normalized)}\n`, 'utf8');
  return {
    tracePath,
    span: normalized
  };
}

export async function tryAppendTraceSpan(rootPath, span = {}) {
  try {
    return {
      ok: true,
      ...(await appendTraceSpan(rootPath, span))
    };
  } catch (error) {
    return {
      ok: false,
      warning: 'trace-write-failed',
      error: error?.message || String(error)
    };
  }
}

export async function loadTraceSpans(rootPath, traceId) {
  const { tracePath } = getTraceStorePaths(rootPath, traceId);
  if (!tracePath || !(await fileExists(tracePath))) {
    return {
      traceId,
      tracePath,
      spans: []
    };
  }
  const text = await readText(tracePath);
  return {
    traceId,
    tracePath,
    spans: text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
  };
}
