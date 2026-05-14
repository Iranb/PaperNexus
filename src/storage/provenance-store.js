import path from 'node:path';
import { fileExists, writeJson, readJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

export const PROVENANCE_CONTRACT_VERSION = 'papernexus-prov-v1';

function nowIso() {
  return new Date().toISOString();
}

function normalizeList(values = []) {
  return Array.isArray(values) ? values.filter((entry) => entry !== undefined && entry !== null) : [];
}

function normalizeObject(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolveLocalArtifactPath(rootPath, artifactPath = '') {
  const raw = String(artifactPath || '').trim();
  if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(rootPath, raw);
}

function collectArtifactRefs(envelope = {}) {
  const refs = [];
  const add = (value, reason) => {
    const raw = String(value || '').trim();
    if (raw) refs.push({ path: raw, reason });
  };

  for (const item of normalizeList(envelope.artifact_paths || envelope.artifactPaths)) {
    add(item, 'artifact_paths');
  }
  for (const entity of normalizeList(envelope.used_entities || envelope.usedEntities)) {
    if (typeof entity === 'string') {
      add(entity, 'used_entities');
    } else {
      add(entity.path || entity.artifact_path || entity.artifactPath, 'used_entities');
    }
  }
  for (const span of normalizeList(envelope.source_spans || envelope.sourceSpans)) {
    add(span.path || span.artifact_path || span.artifactPath || span.source_path || span.sourcePath, 'source_spans');
  }
  add(envelope.kuzu_commit_receipt || envelope.kuzuCommitReceipt, 'kuzu_commit_receipt');
  for (const ref of normalizeList(envelope.llm_ledger_refs || envelope.llmLedgerRefs)) {
    if (typeof ref === 'string') {
      add(ref, 'llm_ledger_refs');
    } else {
      add(ref.path || ref.artifact_path || ref.artifactPath || ref.ledger_path || ref.ledgerPath, 'llm_ledger_refs');
    }
  }
  return refs;
}

export function createProvenanceEnvelope(payload = {}) {
  const createdAt = payload.created_at || payload.createdAt || nowIso();
  const generatedByActivity = String(
    payload.generated_by_activity || payload.generatedByActivity || payload.activity || 'unknown_activity'
  ).trim();
  const responsibleAgent = String(
    payload.responsible_agent || payload.responsibleAgent || 'papernexus'
  ).trim();
  const traceId = payload.trace_id || payload.traceId || null;
  const runId = payload.run_id || payload.runId || null;
  const paperId = payload.paper_id || payload.paperId || null;

  const envelope = {
    provenance_version: PROVENANCE_CONTRACT_VERSION,
    provenance_id: payload.provenance_id || payload.provenanceId || null,
    generated_by_activity: generatedByActivity,
    responsible_agent: responsibleAgent,
    trace_id: traceId,
    run_id: runId,
    paper_id: paperId,
    used_entities: normalizeList(payload.used_entities || payload.usedEntities),
    input_hashes: normalizeObject(payload.input_hashes || payload.inputHashes),
    output_hash: payload.output_hash || payload.outputHash || null,
    source_spans: normalizeList(payload.source_spans || payload.sourceSpans),
    graph_generation: Number.isFinite(Number(payload.graph_generation ?? payload.graphGeneration))
      ? Number(payload.graph_generation ?? payload.graphGeneration)
      : null,
    kuzu_commit_receipt: payload.kuzu_commit_receipt || payload.kuzuCommitReceipt || null,
    llm_ledger_refs: normalizeList(payload.llm_ledger_refs || payload.llmLedgerRefs),
    artifact_paths: normalizeList(payload.artifact_paths || payload.artifactPaths),
    evidence_status: payload.evidence_status || payload.evidenceStatus || null,
    created_at: createdAt
  };

  envelope.provenance_id = envelope.provenance_id || `prov:${stableHash(JSON.stringify({
    generatedByActivity,
    responsibleAgent,
    traceId,
    runId,
    paperId,
    outputHash: envelope.output_hash,
    createdAt
  }), 24)}`;
  return envelope;
}

export async function writeProvenanceEnvelope(rootPath, payload = {}, options = {}) {
  const envelope = createProvenanceEnvelope(payload);
  const provenanceDir = path.join(path.resolve(rootPath), '.papernexus', 'provenance');
  const provenancePath = options.path || path.join(provenanceDir, `${encodeURIComponent(envelope.provenance_id)}.json`);
  await writeJson(provenancePath, envelope);
  return {
    provenancePath,
    envelope
  };
}

export async function loadProvenanceEnvelope(provenancePath) {
  return readJson(provenancePath, null);
}

export async function validateProvenanceRefs(rootPath, envelope = {}) {
  const normalized = envelope?.provenance_version ? envelope : createProvenanceEnvelope(envelope);
  const refs = collectArtifactRefs(normalized);
  const checks = [];

  for (const ref of refs) {
    const localPath = resolveLocalArtifactPath(rootPath, ref.path);
    if (!localPath) {
      checks.push({
        ...ref,
        status: 'skipped',
        reason_detail: 'non-local-reference'
      });
      continue;
    }
    checks.push({
      ...ref,
      resolved_path: localPath,
      status: (await fileExists(localPath)) ? 'passed' : 'dangling'
    });
  }

  const dangling = checks.filter((check) => check.status === 'dangling');
  return {
    provenance_version: PROVENANCE_CONTRACT_VERSION,
    provenance_id: normalized.provenance_id,
    ok: dangling.length === 0,
    checked_ref_count: checks.length,
    dangling_ref_count: dangling.length,
    checks
  };
}
