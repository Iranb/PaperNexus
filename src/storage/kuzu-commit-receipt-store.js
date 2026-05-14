import path from 'node:path';
import { ensureDir, fileExists, readJson, writeJson } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';
import { loadKuzuV2Summary, verifyKuzuV2SourceFragment } from './kuzu-store.js';

export const KUZU_COMMIT_RECEIPT_VERSION = 'papernexus-kuzu-commit-v1';

function nowIso() {
  return new Date().toISOString();
}

function normalizeStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].sort();
}

function normalizeCount(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export function getKuzuCommitReceiptPaths(rootPath, receiptId = '') {
  const receiptsDir = path.join(path.resolve(rootPath), '.papernexus', 'kuzu-receipts');
  const encoded = receiptId ? encodeURIComponent(receiptId) : '';
  return {
    rootPath: path.resolve(rootPath),
    receiptsDir,
    latestPath: path.join(receiptsDir, 'latest.json'),
    receiptId,
    receiptPath: encoded ? path.join(receiptsDir, `${encoded}.json`) : ''
  };
}

function createVerificationQuery(name, status, fields = {}) {
  return {
    name,
    status,
    row_count: normalizeCount(fields.row_count ?? fields.rowCount),
    ...fields
  };
}

async function buildVerificationQueries(payload = {}) {
  const dbPath = payload.kuzu_database_path || payload.kuzuDatabasePath || payload.dbPath || '';
  const targetManifestToken = payload.target_manifest_token || payload.targetManifestToken || '';
  const changedSourceKeys = normalizeStringList(payload.changed_source_keys || payload.changedSourceKeys);
  const queries = [];

  if (!dbPath || !(await fileExists(dbPath))) {
    queries.push(createVerificationQuery('kuzu_database_visible', 'failed', {
      row_count: 0,
      error: dbPath ? 'database path does not exist' : 'database path missing'
    }));
    return queries;
  }

  try {
    const summary = await loadKuzuV2Summary(dbPath);
    queries.push(createVerificationQuery('kuzu_database_visible', summary.exists ? 'passed' : 'failed', {
      row_count: summary.exists ? 1 : 0,
      node_count: summary.nodeCount,
      relationship_count: summary.relationshipCount,
      completed_delta_count: summary.completedDeltaCount
    }));
  } catch (error) {
    queries.push(createVerificationQuery('kuzu_database_visible', 'failed', {
      row_count: 0,
      error: error?.message || String(error)
    }));
  }

  const maxSourceChecks = Math.max(0, Number(payload.max_source_verification_count || payload.maxSourceVerificationCount || 20) || 20);
  for (const sourceKey of changedSourceKeys.slice(0, maxSourceChecks)) {
    try {
      const verification = await verifyKuzuV2SourceFragment(dbPath, sourceKey, {
        manifestToken: targetManifestToken || undefined
      });
      queries.push(createVerificationQuery('source_fragment_visible', verification.ok ? 'passed' : 'failed', {
        row_count: verification.fragment ? 1 : 0,
        source_key: sourceKey,
        missing_node_count: verification.missingNodes?.length || 0,
        missing_relationship_count: verification.missingRelationships?.length || 0,
        warning_count: verification.warnings?.length || 0
      }));
    } catch (error) {
      queries.push(createVerificationQuery('source_fragment_visible', 'failed', {
        row_count: 0,
        source_key: sourceKey,
        error: error?.message || String(error)
      }));
    }
  }

  if (changedSourceKeys.length > maxSourceChecks) {
    queries.push(createVerificationQuery('source_fragment_sample_limit', 'skipped', {
      row_count: 0,
      skipped_source_count: changedSourceKeys.length - maxSourceChecks
    }));
  }

  return queries;
}

function receiptStatusFromQueries(queries = [], requestedStatus = '') {
  const normalized = String(requestedStatus || '').trim().toLowerCase();
  if (normalized === 'failed') return 'failed';
  const decisive = queries.filter((query) => query.status !== 'skipped');
  if (!decisive.length) return normalized || 'needs_repair';
  return decisive.every((query) => query.status === 'passed') ? 'committed' : 'needs_repair';
}

export async function writeKuzuCommitReceipt(rootPath, payload = {}) {
  const createdAt = payload.created_at || payload.createdAt || nowIso();
  const changedSourceKeys = normalizeStringList(payload.changed_source_keys || payload.changedSourceKeys);
  const verificationQueries = Array.isArray(payload.verification_queries || payload.verificationQueries)
    ? (payload.verification_queries || payload.verificationQueries)
    : await buildVerificationQueries({
        ...payload,
        changed_source_keys: changedSourceKeys
      });

  const receipt = {
    receipt_version: KUZU_COMMIT_RECEIPT_VERSION,
    receipt_id: payload.receipt_id || payload.receiptId || null,
    run_id: payload.run_id || payload.runId || null,
    trace_id: payload.trace_id || payload.traceId || null,
    paper_id: payload.paper_id || payload.paperId || null,
    job_id: payload.job_id || payload.jobId || null,
    graph_generation: Number.isFinite(Number(payload.graph_generation ?? payload.graphGeneration))
      ? Number(payload.graph_generation ?? payload.graphGeneration)
      : null,
    base_manifest_token: payload.base_manifest_token || payload.baseManifestToken || null,
    target_manifest_token: payload.target_manifest_token || payload.targetManifestToken || null,
    delta_payload_hash: payload.delta_payload_hash || payload.deltaPayloadHash || payload.deltaHash || null,
    kuzu_database_path: payload.kuzu_database_path || payload.kuzuDatabasePath || payload.dbPath || null,
    nodes_written: normalizeCount(payload.nodes_written ?? payload.nodesWritten ?? payload.upsertedNodeCount),
    edges_written: normalizeCount(payload.edges_written ?? payload.edgesWritten ?? payload.upsertedRelationshipCount),
    source_fragment_count: normalizeCount(payload.source_fragment_count ?? payload.sourceFragmentCount),
    changed_source_keys: changedSourceKeys,
    verification_queries: verificationQueries,
    status: receiptStatusFromQueries(verificationQueries, payload.status),
    repair_actions: payload.repair_actions || payload.repairActions || [],
    created_at: createdAt
  };

  receipt.receipt_id = receipt.receipt_id || `kuzu-receipt:${stableHash(JSON.stringify({
    runId: receipt.run_id,
    traceId: receipt.trace_id,
    jobId: receipt.job_id,
    deltaHash: receipt.delta_payload_hash,
    dbPath: receipt.kuzu_database_path,
    createdAt
  }), 24)}`;
  if (receipt.status !== 'committed' && !receipt.repair_actions.length) {
    receipt.repair_actions = ['rerun authoritative sync for the failed delta job'];
  }

  const paths = getKuzuCommitReceiptPaths(rootPath, receipt.receipt_id);
  await ensureDir(paths.receiptsDir);
  await writeJson(paths.receiptPath, receipt);
  await writeJson(paths.latestPath, {
    receipt_version: KUZU_COMMIT_RECEIPT_VERSION,
    receipt_id: receipt.receipt_id,
    receipt_path: paths.receiptPath,
    run_id: receipt.run_id,
    trace_id: receipt.trace_id,
    job_id: receipt.job_id,
    status: receipt.status,
    graph_generation: receipt.graph_generation,
    created_at: receipt.created_at
  });
  return {
    receiptPath: paths.receiptPath,
    latestPath: paths.latestPath,
    receipt
  };
}

export async function loadLatestKuzuCommitReceipt(rootPath) {
  const paths = getKuzuCommitReceiptPaths(rootPath);
  const latest = await readJson(paths.latestPath, null);
  if (!latest?.receipt_path) return null;
  return readJson(latest.receipt_path, null);
}

export async function verifyKuzuCommitReceipt(rootPath, receiptOrId = 'latest') {
  const receipt = typeof receiptOrId === 'string'
    ? receiptOrId === 'latest'
      ? await loadLatestKuzuCommitReceipt(rootPath)
      : await readJson(getKuzuCommitReceiptPaths(rootPath, receiptOrId).receiptPath, null)
    : receiptOrId;
  if (!receipt) {
    return {
      ok: false,
      status: 'missing',
      verification_queries: [],
      error: 'receipt not found'
    };
  }
  const verification_queries = await buildVerificationQueries(receipt);
  return {
    receipt_id: receipt.receipt_id,
    ok: receiptStatusFromQueries(verification_queries, receipt.status) === 'committed',
    status: receiptStatusFromQueries(verification_queries, receipt.status),
    verification_queries
  };
}
