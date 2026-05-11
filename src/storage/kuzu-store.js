import path from 'node:path';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import { ensureDir, fileExists, removePath } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const KUZU_NODE_TABLE = 'PNNode';
const KUZU_REL_TABLE = 'PNRel';
const KUZU_SOURCE_FRAGMENT_TABLE = 'PNSourceFragment';
const KUZU_NODE_CONTRIBUTION_TABLE = 'PNNodeContribution';
const KUZU_REL_CONTRIBUTION_TABLE = 'PNRelContribution';
const KUZU_DELTA_JOURNAL_TABLE = 'PNDeltaJournal';
const KUZU_MIGRATION_STATE_TABLE = 'PNMigrationState';
const KUZU_V2_SCHEMA_VERSION = 'graph-v2-kuzu-v1';
const BACKEND_JSON = 'json';
const BACKEND_KUZU = 'kuzu';

let kuzuModulePromise = null;

function getRequestedBackend() {
  const raw = String(process.env.PAPERNEXUS_GRAPH_BACKEND || 'auto').trim().toLowerCase();
  if (raw === BACKEND_JSON || raw === BACKEND_KUZU) return raw;
  return 'auto';
}

function serializeProperties(properties = {}) {
  return JSON.stringify(properties || {});
}

function parseProperties(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function closeQueryResult(result) {
  if (!result) return;
  if (Array.isArray(result)) {
    for (const item of result) {
      closeQueryResult(item);
    }
    return;
  }
  if (typeof result.close === 'function') {
    result.close();
  }
}

async function loadKuzuModule() {
  if (!kuzuModulePromise) {
    kuzuModulePromise = import('kuzu')
      .then((module) => module.default || module)
      .catch(() => null);
  }

  return kuzuModulePromise;
}

async function withKuzuConnection(dbPath, fn) {
  const kuzu = await loadKuzuModule();
  if (!kuzu) {
    throw new Error('Kuzu backend requested, but the `kuzu` package is not available.');
  }

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  try {
    return await fn(conn);
  } finally {
    try {
      await conn.close();
    } finally {
      await db.close();
    }
  }
}

async function resetKuzuFiles(dbPath) {
  await removePath(dbPath);
  await removePath(`${dbPath}.wal`);
}

async function queryRows(conn, sql, params = null) {
  const result = params
    ? await conn.execute(await conn.prepare(sql), params)
    : await conn.query(sql);
  try {
    if (typeof result?.getAll === 'function') {
      return await result.getAll();
    }
    return [];
  } finally {
    closeQueryResult(result);
  }
}

async function executeKuzu(conn, sql, params = null) {
  const result = params
    ? await conn.execute(await conn.prepare(sql), params)
    : await conn.query(sql);
  closeQueryResult(result);
}

function normalizeStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function parseStringList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return normalizeStringList(parsed);
  } catch {
    return [];
  }
}

function createDeltaHash(deltaPayload = {}, options = {}) {
  return stableHash(JSON.stringify({
    targetManifestToken: options.targetManifestToken || deltaPayload.targetManifestToken || null,
    changedSourceKeys: normalizeStringList(deltaPayload.changedSourceKeys),
    upsertNodes: deltaPayload.upsertNodes || [],
    upsertRelationships: deltaPayload.upsertRelationships || [],
    deleteNodeIds: normalizeStringList(deltaPayload.deleteNodeIds),
    deleteRelationshipIds: normalizeStringList(deltaPayload.deleteRelationshipIds),
    sourceEntries: deltaPayload.sourceEntries || []
  }), 24);
}

function createDeltaJobId(deltaPayload = {}, options = {}) {
  if (options.jobId) return String(options.jobId);
  const targetManifestToken = options.targetManifestToken || deltaPayload.targetManifestToken || 'manifest';
  return `delta:${stableHash(`${targetManifestToken}:${createDeltaHash(deltaPayload, options)}`, 18)}`;
}

async function ensureKuzuV2Schema(conn) {
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_NODE_TABLE}(id STRING PRIMARY KEY, nodeType STRING, name STRING, properties STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE REL TABLE IF NOT EXISTS ${KUZU_REL_TABLE}(FROM ${KUZU_NODE_TABLE} TO ${KUZU_NODE_TABLE}, relId STRING, relType STRING, properties STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_SOURCE_FRAGMENT_TABLE}(sourceKey STRING PRIMARY KEY, paperId STRING, manifestToken STRING, contentHash STRING, nodeIds STRING, relationshipIds STRING, updatedAt STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_NODE_CONTRIBUTION_TABLE}(contributionId STRING PRIMARY KEY, nodeId STRING, sourceKey STRING, contributionHash STRING, contributionProperties STRING, updatedAt STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_REL_CONTRIBUTION_TABLE}(contributionId STRING PRIMARY KEY, relId STRING, sourceKey STRING, contributionHash STRING, contributionProperties STRING, updatedAt STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_DELTA_JOURNAL_TABLE}(jobId STRING PRIMARY KEY, baseManifestToken STRING, targetManifestToken STRING, deltaHash STRING, changedSourceKeys STRING, status STRING, startedAt STRING, completedAt STRING, error STRING);`
  ));
  closeQueryResult(await conn.query(
    `CREATE NODE TABLE IF NOT EXISTS ${KUZU_MIGRATION_STATE_TABLE}(version STRING PRIMARY KEY, sourceManifestToken STRING, status STRING, checkpoint STRING, updatedAt STRING, metadata STRING);`
  ));
}

async function hasCompletedKuzuDelta(conn, deltaHash) {
  const rows = await queryRows(conn,
    `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE}) WHERE j.deltaHash = $deltaHash AND j.status = $status RETURN j.jobId AS jobId;`,
    { deltaHash, status: 'completed' }
  );
  return rows[0] || null;
}

async function loadKuzuSourceFragment(conn, sourceKey) {
  const rows = await queryRows(conn,
    `MATCH (f:${KUZU_SOURCE_FRAGMENT_TABLE} {sourceKey: $sourceKey}) RETURN f.sourceKey AS sourceKey, f.paperId AS paperId, f.manifestToken AS manifestToken, f.contentHash AS contentHash, f.nodeIds AS nodeIds, f.relationshipIds AS relationshipIds, f.updatedAt AS updatedAt;`,
    { sourceKey }
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sourceKey: row.sourceKey,
    paperId: row.paperId || '',
    manifestToken: row.manifestToken || '',
    contentHash: row.contentHash || '',
    nodeIds: parseStringList(row.nodeIds),
    relationshipIds: parseStringList(row.relationshipIds),
    updatedAt: row.updatedAt || ''
  };
}

async function kuzuNodeExists(conn, nodeId) {
  const rows = await queryRows(conn,
    `MATCH (n:${KUZU_NODE_TABLE} {id: $id}) RETURN n.id AS id;`,
    { id: nodeId }
  );
  return Boolean(rows.length);
}

async function kuzuRelationshipExists(conn, relationshipId) {
  const rows = await queryRows(conn,
    `MATCH (src:${KUZU_NODE_TABLE})-[r:${KUZU_REL_TABLE}]->(dst:${KUZU_NODE_TABLE}) WHERE r.relId = $relId RETURN r.relId AS relId;`,
    { relId: relationshipId }
  );
  return Boolean(rows.length);
}

async function upsertKuzuNode(conn, node) {
  if (!node?.id) return false;
  const payload = {
    id: node.id,
    nodeType: node.type || node.nodeType || 'Node',
    name: node.name || node.id,
    properties: serializeProperties(node.properties)
  };
  if (await kuzuNodeExists(conn, node.id)) {
    await executeKuzu(conn,
      `MATCH (n:${KUZU_NODE_TABLE} {id: $id}) SET n.nodeType = $nodeType, n.name = $name, n.properties = $properties;`,
      payload
    );
    return false;
  }
  await executeKuzu(conn,
    `CREATE (n:${KUZU_NODE_TABLE} {id: $id, nodeType: $nodeType, name: $name, properties: $properties});`,
    payload
  );
  return true;
}

async function deleteKuzuRelationship(conn, relationshipId) {
  if (!relationshipId) return;
  await executeKuzu(conn,
    `MATCH (src:${KUZU_NODE_TABLE})-[r:${KUZU_REL_TABLE}]->(dst:${KUZU_NODE_TABLE}) WHERE r.relId = $relId DELETE r;`,
    { relId: relationshipId }
  );
}

async function upsertKuzuRelationship(conn, relationship) {
  if (!relationship?.id || !relationship?.sourceId || !relationship?.targetId) return false;
  await deleteKuzuRelationship(conn, relationship.id);
  await executeKuzu(conn,
    `MATCH (src:${KUZU_NODE_TABLE} {id: $sourceId}), (dst:${KUZU_NODE_TABLE} {id: $targetId}) CREATE (src)-[:${KUZU_REL_TABLE} {relId: $relId, relType: $relType, properties: $properties}]->(dst);`,
    {
      sourceId: relationship.sourceId,
      targetId: relationship.targetId,
      relId: relationship.id,
      relType: relationship.type || relationship.relType || 'RELATED_TO',
      properties: serializeProperties(relationship.properties)
    }
  );
  return true;
}

async function deleteKuzuNode(conn, nodeId) {
  if (!nodeId) return;
  await executeKuzu(conn,
    `MATCH (c:${KUZU_NODE_CONTRIBUTION_TABLE}) WHERE c.nodeId = $nodeId DELETE c;`,
    { nodeId }
  );
  await executeKuzu(conn,
    `MATCH (n:${KUZU_NODE_TABLE} {id: $id}) DETACH DELETE n;`,
    { id: nodeId }
  );
}

async function deleteKuzuSourceContributions(conn, sourceKey) {
  await executeKuzu(conn,
    `MATCH (c:${KUZU_NODE_CONTRIBUTION_TABLE}) WHERE c.sourceKey = $sourceKey DELETE c;`,
    { sourceKey }
  );
  await executeKuzu(conn,
    `MATCH (c:${KUZU_REL_CONTRIBUTION_TABLE}) WHERE c.sourceKey = $sourceKey DELETE c;`,
    { sourceKey }
  );
}

async function upsertKuzuSourceFragment(conn, sourceEntry = {}, options = {}) {
  const sourceKey = String(sourceEntry.sourceKey || '').trim();
  if (!sourceKey) return false;
  const nodeIds = normalizeStringList(sourceEntry.nodeIds);
  const relationshipIds = normalizeStringList(sourceEntry.relationshipIds);
  const updatedAt = options.updatedAt || new Date().toISOString();
  const payload = {
    sourceKey,
    paperId: sourceEntry.paperId || '',
    manifestToken: options.targetManifestToken || '',
    contentHash: sourceEntry.fingerprint || stableHash(JSON.stringify({ nodeIds, relationshipIds }), 20),
    nodeIds: JSON.stringify(nodeIds),
    relationshipIds: JSON.stringify(relationshipIds),
    updatedAt
  };

  await executeKuzu(conn,
    `MATCH (f:${KUZU_SOURCE_FRAGMENT_TABLE} {sourceKey: $sourceKey}) DELETE f;`,
    { sourceKey }
  );
  await executeKuzu(conn,
    `CREATE (f:${KUZU_SOURCE_FRAGMENT_TABLE} {sourceKey: $sourceKey, paperId: $paperId, manifestToken: $manifestToken, contentHash: $contentHash, nodeIds: $nodeIds, relationshipIds: $relationshipIds, updatedAt: $updatedAt});`,
    payload
  );
  return true;
}

async function writeKuzuContributions(conn, sourceEntry = {}, deltaPayload = {}, options = {}) {
  const sourceKey = String(sourceEntry.sourceKey || '').trim();
  if (!sourceKey) return {
    nodeContributionCount: 0,
    relationshipContributionCount: 0
  };

  const updatedAt = options.updatedAt || new Date().toISOString();
  const nodesById = new Map((deltaPayload.upsertNodes || []).filter((node) => node?.id).map((node) => [node.id, node]));
  const relationshipsById = new Map((deltaPayload.upsertRelationships || []).filter((rel) => rel?.id).map((rel) => [rel.id, rel]));
  let nodeContributionCount = 0;
  let relationshipContributionCount = 0;

  for (const nodeId of normalizeStringList(sourceEntry.nodeIds)) {
    const node = nodesById.get(nodeId);
    const contributionProperties = node ? serializeProperties(node.properties) : '{}';
    await executeKuzu(conn,
      `CREATE (c:${KUZU_NODE_CONTRIBUTION_TABLE} {contributionId: $contributionId, nodeId: $nodeId, sourceKey: $sourceKey, contributionHash: $contributionHash, contributionProperties: $contributionProperties, updatedAt: $updatedAt});`,
      {
        contributionId: `node-contrib:${stableHash(`${sourceKey}:${nodeId}`, 24)}`,
        nodeId,
        sourceKey,
        contributionHash: stableHash(`${sourceKey}:${nodeId}:${contributionProperties}`, 24),
        contributionProperties,
        updatedAt
      }
    );
    nodeContributionCount += 1;
  }

  for (const relId of normalizeStringList(sourceEntry.relationshipIds)) {
    const relationship = relationshipsById.get(relId);
    const contributionProperties = relationship ? serializeProperties(relationship.properties) : '{}';
    await executeKuzu(conn,
      `CREATE (c:${KUZU_REL_CONTRIBUTION_TABLE} {contributionId: $contributionId, relId: $relId, sourceKey: $sourceKey, contributionHash: $contributionHash, contributionProperties: $contributionProperties, updatedAt: $updatedAt});`,
      {
        contributionId: `rel-contrib:${stableHash(`${sourceKey}:${relId}`, 24)}`,
        relId,
        sourceKey,
        contributionHash: stableHash(`${sourceKey}:${relId}:${contributionProperties}`, 24),
        contributionProperties,
        updatedAt
      }
    );
    relationshipContributionCount += 1;
  }

  return {
    nodeContributionCount,
    relationshipContributionCount
  };
}

async function recordFailedKuzuDeltaJournal(dbPath, payload) {
  try {
    await ensureDir(path.dirname(dbPath));
    await withKuzuConnection(dbPath, async (conn) => {
      await ensureKuzuV2Schema(conn);
      await executeKuzu(conn,
        `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId}) DELETE j;`,
        { jobId: payload.jobId }
      );
      await executeKuzu(conn,
        `CREATE (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId, baseManifestToken: $baseManifestToken, targetManifestToken: $targetManifestToken, deltaHash: $deltaHash, changedSourceKeys: $changedSourceKeys, status: $status, startedAt: $startedAt, completedAt: $completedAt, error: $error});`,
        payload
      );
    });
  } catch {
    // The original error is more useful to callers than best-effort journal failure.
  }
}

async function countKuzuRows(conn, label, pattern) {
  const rows = await queryRows(conn, `MATCH ${pattern} RETURN count(*) AS count;`);
  return Number(rows[0]?.count || 0);
}

export async function isKuzuGraphStoreAvailable() {
  return Boolean(await loadKuzuModule());
}

export async function resolveGraphStorageBackend() {
  const requested = getRequestedBackend();
  const available = await isKuzuGraphStoreAvailable();

  if (requested === BACKEND_JSON) return BACKEND_JSON;
  if (requested === BACKEND_KUZU) {
    if (!available) {
      throw new Error('PAPERNEXUS_GRAPH_BACKEND=kuzu was requested, but the `kuzu` package is not installed.');
    }
    return BACKEND_KUZU;
  }

  return available ? BACKEND_KUZU : BACKEND_JSON;
}

export async function resolveGraphStorageMode() {
  return (await resolveGraphStorageBackend()) === BACKEND_KUZU
    ? 'kuzu+lite-index'
    : 'json+lite-index';
}

export async function hasKuzuGraphStore(dbPath) {
  return fileExists(dbPath);
}

export async function initializeKuzuV2(dbPath, options = {}) {
  const startedAt = new Date().toISOString();
  await ensureDir(path.dirname(dbPath));
  if (options.reset || options.resetShadow) {
    await resetKuzuFiles(dbPath);
  }

  await withKuzuConnection(dbPath, async (conn) => {
    await ensureKuzuV2Schema(conn);
    if (options.sourceManifestToken || options.status || options.checkpoint || options.metadata) {
      await executeKuzu(conn,
        `MATCH (m:${KUZU_MIGRATION_STATE_TABLE} {version: $version}) DELETE m;`,
        { version: KUZU_V2_SCHEMA_VERSION }
      );
      await executeKuzu(conn,
        `CREATE (m:${KUZU_MIGRATION_STATE_TABLE} {version: $version, sourceManifestToken: $sourceManifestToken, status: $status, checkpoint: $checkpoint, updatedAt: $updatedAt, metadata: $metadata});`,
        {
          version: KUZU_V2_SCHEMA_VERSION,
          sourceManifestToken: options.sourceManifestToken || '',
          status: options.status || 'initialized',
          checkpoint: options.checkpoint || '',
          updatedAt: startedAt,
          metadata: serializeProperties(options.metadata || {})
        }
      );
    }
  });

  return loadKuzuV2Summary(dbPath);
}

export async function verifyKuzuV2SourceFragment(dbPath, sourceKey, options = {}) {
  const normalizedSourceKey = String(sourceKey || '').trim();
  if (!normalizedSourceKey) {
    throw new Error('sourceKey is required to verify a Kuzu v2 source fragment.');
  }
  if (!await fileExists(dbPath)) {
    return {
      dbPath,
      sourceKey: normalizedSourceKey,
      ok: false,
      exists: false,
      missingDb: true,
      missingNodeIds: [],
      missingRelationshipIds: [],
      warnings: [`Kuzu v2 database does not exist at ${dbPath}.`]
    };
  }

  return withKuzuConnection(dbPath, async (conn) => {
    await ensureKuzuV2Schema(conn);
    const fragment = await loadKuzuSourceFragment(conn, normalizedSourceKey);
    if (!fragment) {
      return {
        dbPath,
        sourceKey: normalizedSourceKey,
        ok: false,
        exists: false,
        missingDb: false,
        missingNodeIds: [],
        missingRelationshipIds: [],
        warnings: [`No Kuzu v2 source fragment exists for ${normalizedSourceKey}.`]
      };
    }

    const missingNodeIds = [];
    const missingRelationshipIds = [];
    for (const nodeId of fragment.nodeIds) {
      if (!await kuzuNodeExists(conn, nodeId)) {
        missingNodeIds.push(nodeId);
      }
    }
    for (const relationshipId of fragment.relationshipIds) {
      if (!await kuzuRelationshipExists(conn, relationshipId)) {
        missingRelationshipIds.push(relationshipId);
      }
    }

    const warnings = [];
    if (missingNodeIds.length) {
      warnings.push(`Fragment references ${missingNodeIds.length} missing node(s).`);
    }
    if (missingRelationshipIds.length) {
      warnings.push(`Fragment references ${missingRelationshipIds.length} missing relationship(s).`);
    }
    if (options.manifestToken && fragment.manifestToken && fragment.manifestToken !== options.manifestToken) {
      warnings.push(`Fragment manifest token ${fragment.manifestToken} does not match ${options.manifestToken}.`);
    }

    return {
      dbPath,
      sourceKey: normalizedSourceKey,
      ok: warnings.length === 0,
      exists: true,
      missingDb: false,
      fragment,
      nodeCount: fragment.nodeIds.length,
      relationshipCount: fragment.relationshipIds.length,
      missingNodeIds,
      missingRelationshipIds,
      warnings
    };
  });
}

export async function saveKnowledgeGraphToKuzu(dbPath, graph, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const reportProgress = (label) => {
    onProgress?.({
      phase: 'authoritative-graph',
      label
    });
  };
  const progressEvery = Math.max(1, Number(options.progressEvery || 250));

  await ensureDir(path.dirname(dbPath));
  reportProgress('resetting Kuzu graph files');
  await resetKuzuFiles(dbPath);

  return withKuzuConnection(dbPath, async (conn) => {
    closeQueryResult(await conn.query(
      `CREATE NODE TABLE ${KUZU_NODE_TABLE}(id STRING PRIMARY KEY, nodeType STRING, name STRING, properties STRING);`
    ));
    closeQueryResult(await conn.query(
      `CREATE REL TABLE ${KUZU_REL_TABLE}(FROM ${KUZU_NODE_TABLE} TO ${KUZU_NODE_TABLE}, relId STRING, relType STRING, properties STRING);`
    ));

    const insertNode = await conn.prepare(
      `CREATE (n:${KUZU_NODE_TABLE} {id: $id, nodeType: $nodeType, name: $name, properties: $properties});`
    );
    const insertRelationship = await conn.prepare(
      `MATCH (src:${KUZU_NODE_TABLE} {id: $sourceId}), (dst:${KUZU_NODE_TABLE} {id: $targetId}) CREATE (src)-[:${KUZU_REL_TABLE} {relId: $relId, relType: $relType, properties: $properties}]->(dst);`
    );

    let transactionOpen = false;
    try {
      reportProgress(`writing Kuzu nodes 0/${graph.nodes.length}, relationships 0/${graph.relationships.length}`);
      closeQueryResult(await conn.query('BEGIN TRANSACTION;'));
      transactionOpen = true;

      for (let index = 0; index < graph.nodes.length; index += 1) {
        const node = graph.nodes[index];
        closeQueryResult(await conn.execute(insertNode, {
          id: node.id,
          nodeType: node.type,
          name: node.name,
          properties: serializeProperties(node.properties)
        }));

        if ((index + 1) % progressEvery === 0 || index === graph.nodes.length - 1) {
          reportProgress(`writing Kuzu nodes ${index + 1}/${graph.nodes.length}, relationships 0/${graph.relationships.length}`);
        }
      }

      for (let index = 0; index < graph.relationships.length; index += 1) {
        const relationship = graph.relationships[index];
        closeQueryResult(await conn.execute(insertRelationship, {
          sourceId: relationship.sourceId,
          targetId: relationship.targetId,
          relId: relationship.id,
          relType: relationship.type,
          properties: serializeProperties(relationship.properties)
        }));

        if ((index + 1) % progressEvery === 0 || index === graph.relationships.length - 1) {
          reportProgress(`writing Kuzu nodes ${graph.nodes.length}/${graph.nodes.length}, relationships ${index + 1}/${graph.relationships.length}`);
        }
      }

      reportProgress('committing Kuzu transaction');
      closeQueryResult(await conn.query('COMMIT;'));
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          closeQueryResult(await conn.query('ROLLBACK;'));
        } catch {}
      }
      throw error;
    }
  });
}

export async function saveGraphDeltaToKuzu(dbPath, deltaPayload = {}, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const reportProgress = (label, extra = {}) => {
    onProgress?.({
      phase: 'kuzu-v2-delta',
      label,
      ...extra
    });
  };
  const changedSourceKeys = normalizeStringList(deltaPayload.changedSourceKeys);
  const deleteRelationshipIds = normalizeStringList(deltaPayload.deleteRelationshipIds);
  const deleteNodeIds = normalizeStringList(deltaPayload.deleteNodeIds);
  const sourceEntries = Array.isArray(deltaPayload.sourceEntries) ? deltaPayload.sourceEntries : [];
  const upsertNodes = Array.isArray(deltaPayload.upsertNodes) ? deltaPayload.upsertNodes : [];
  const upsertRelationships = Array.isArray(deltaPayload.upsertRelationships) ? deltaPayload.upsertRelationships : [];
  const startedAt = new Date().toISOString();
  const deltaHash = createDeltaHash(deltaPayload, options);
  const jobId = createDeltaJobId(deltaPayload, options);
  const targetManifestToken = options.targetManifestToken || deltaPayload.targetManifestToken || null;
  const baseManifestToken = options.baseManifestToken || deltaPayload.baseManifestToken || null;

  await ensureDir(path.dirname(dbPath));
  if (options.reset || options.resetShadow) {
    reportProgress('resetting Kuzu v2 graph files');
    await resetKuzuFiles(dbPath);
  }

  return withKuzuConnection(dbPath, async (conn) => {
    reportProgress('ensuring Kuzu v2 schema');
    await ensureKuzuV2Schema(conn);

    const completed = await hasCompletedKuzuDelta(conn, deltaHash);
    if (completed && !options.force) {
      return {
        dbPath,
        jobId: completed.jobId,
        deltaHash,
        reused: true,
        upsertedNodeCount: 0,
        upsertedRelationshipCount: 0,
        deletedNodeCount: 0,
        deletedRelationshipCount: 0,
        sourceFragmentCount: 0,
        nodeContributionCount: 0,
        relationshipContributionCount: 0
      };
    }

    let transactionOpen = false;
    let nodeContributionCount = 0;
    let relationshipContributionCount = 0;
    try {
      reportProgress('starting Kuzu v2 transaction');
      closeQueryResult(await conn.query('BEGIN TRANSACTION;'));
      transactionOpen = true;

      await executeKuzu(conn,
        `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId}) DELETE j;`,
        { jobId }
      );
      await executeKuzu(conn,
        `CREATE (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId, baseManifestToken: $baseManifestToken, targetManifestToken: $targetManifestToken, deltaHash: $deltaHash, changedSourceKeys: $changedSourceKeys, status: $status, startedAt: $startedAt, completedAt: $completedAt, error: $error});`,
        {
          jobId,
          baseManifestToken: baseManifestToken || '',
          targetManifestToken: targetManifestToken || '',
          deltaHash,
          changedSourceKeys: JSON.stringify(changedSourceKeys),
          status: 'running',
          startedAt,
          completedAt: '',
          error: ''
        }
      );

      for (const sourceKey of changedSourceKeys) {
        const previousFragment = await loadKuzuSourceFragment(conn, sourceKey);
        await deleteKuzuSourceContributions(conn, sourceKey);
        await executeKuzu(conn,
          `MATCH (f:${KUZU_SOURCE_FRAGMENT_TABLE} {sourceKey: $sourceKey}) DELETE f;`,
          { sourceKey }
        );
        for (const relationshipId of previousFragment?.relationshipIds || []) {
          if (!deleteRelationshipIds.includes(relationshipId)) {
            continue;
          }
          await deleteKuzuRelationship(conn, relationshipId);
        }
      }

      reportProgress(`deleting Kuzu v2 relationships 0/${deleteRelationshipIds.length}`);
      for (let index = 0; index < deleteRelationshipIds.length; index += 1) {
        const relationshipId = deleteRelationshipIds[index];
        await deleteKuzuRelationship(conn, relationshipId);
        await executeKuzu(conn,
          `MATCH (c:${KUZU_REL_CONTRIBUTION_TABLE}) WHERE c.relId = $relId DELETE c;`,
          { relId: relationshipId }
        );
        if ((index + 1) % 250 === 0 || index === deleteRelationshipIds.length - 1) {
          reportProgress(`deleting Kuzu v2 relationships ${index + 1}/${deleteRelationshipIds.length}`);
        }
      }

      reportProgress(`deleting Kuzu v2 nodes 0/${deleteNodeIds.length}`);
      for (let index = 0; index < deleteNodeIds.length; index += 1) {
        await deleteKuzuNode(conn, deleteNodeIds[index]);
        if ((index + 1) % 250 === 0 || index === deleteNodeIds.length - 1) {
          reportProgress(`deleting Kuzu v2 nodes ${index + 1}/${deleteNodeIds.length}`);
        }
      }

      reportProgress(`upserting Kuzu v2 nodes 0/${upsertNodes.length}`);
      for (let index = 0; index < upsertNodes.length; index += 1) {
        await upsertKuzuNode(conn, upsertNodes[index]);
        if ((index + 1) % 250 === 0 || index === upsertNodes.length - 1) {
          reportProgress(`upserting Kuzu v2 nodes ${index + 1}/${upsertNodes.length}`);
        }
      }

      reportProgress(`upserting Kuzu v2 relationships 0/${upsertRelationships.length}`);
      for (let index = 0; index < upsertRelationships.length; index += 1) {
        await upsertKuzuRelationship(conn, upsertRelationships[index]);
        if ((index + 1) % 250 === 0 || index === upsertRelationships.length - 1) {
          reportProgress(`upserting Kuzu v2 relationships ${index + 1}/${upsertRelationships.length}`);
        }
      }

      reportProgress(`writing Kuzu v2 source fragments 0/${sourceEntries.length}`);
      for (let index = 0; index < sourceEntries.length; index += 1) {
        const sourceEntry = sourceEntries[index];
        await deleteKuzuSourceContributions(conn, sourceEntry.sourceKey);
        await upsertKuzuSourceFragment(conn, sourceEntry, {
          targetManifestToken: targetManifestToken || '',
          updatedAt: startedAt
        });
        const contributionSummary = await writeKuzuContributions(conn, sourceEntry, deltaPayload, {
          updatedAt: startedAt
        });
        nodeContributionCount += contributionSummary.nodeContributionCount;
        relationshipContributionCount += contributionSummary.relationshipContributionCount;
        if ((index + 1) % 250 === 0 || index === sourceEntries.length - 1) {
          reportProgress(`writing Kuzu v2 source fragments ${index + 1}/${sourceEntries.length}`);
        }
      }

      const completedAt = new Date().toISOString();
      await executeKuzu(conn,
        `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId}) SET j.status = $status, j.completedAt = $completedAt, j.error = $error;`,
        {
          jobId,
          status: 'completed',
          completedAt,
          error: ''
        }
      );
      await executeKuzu(conn,
        `MATCH (m:${KUZU_MIGRATION_STATE_TABLE} {version: $version}) DELETE m;`,
        { version: KUZU_V2_SCHEMA_VERSION }
      );
      await executeKuzu(conn,
        `CREATE (m:${KUZU_MIGRATION_STATE_TABLE} {version: $version, sourceManifestToken: $sourceManifestToken, status: $status, checkpoint: $checkpoint, updatedAt: $updatedAt, metadata: $metadata});`,
        {
          version: KUZU_V2_SCHEMA_VERSION,
          sourceManifestToken: targetManifestToken || '',
          status: 'synced',
          checkpoint: jobId,
          updatedAt: completedAt,
          metadata: serializeProperties({
            deltaHash,
            changedSourceKeys,
            upsertedNodeCount: upsertNodes.length,
            upsertedRelationshipCount: upsertRelationships.length
          })
        }
      );

      reportProgress('committing Kuzu v2 transaction');
      closeQueryResult(await conn.query('COMMIT;'));
      transactionOpen = false;

      return {
        dbPath,
        jobId,
        deltaHash,
        reused: false,
        upsertedNodeCount: upsertNodes.length,
        upsertedRelationshipCount: upsertRelationships.length,
        deletedNodeCount: deleteNodeIds.length,
        deletedRelationshipCount: deleteRelationshipIds.length,
        sourceFragmentCount: sourceEntries.length,
        nodeContributionCount,
        relationshipContributionCount,
        completedAt
      };
    } catch (error) {
      if (transactionOpen) {
        try {
          closeQueryResult(await conn.query('ROLLBACK;'));
        } catch {}
      }
      try {
        await executeKuzu(conn,
          `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId}) DELETE j;`,
          { jobId }
        );
        await executeKuzu(conn,
          `CREATE (j:${KUZU_DELTA_JOURNAL_TABLE} {jobId: $jobId, baseManifestToken: $baseManifestToken, targetManifestToken: $targetManifestToken, deltaHash: $deltaHash, changedSourceKeys: $changedSourceKeys, status: $status, startedAt: $startedAt, completedAt: $completedAt, error: $error});`,
          {
            jobId,
            baseManifestToken: baseManifestToken || '',
            targetManifestToken: targetManifestToken || '',
            deltaHash,
            changedSourceKeys: JSON.stringify(changedSourceKeys),
            status: 'failed',
            startedAt,
            completedAt: new Date().toISOString(),
            error: error.message || String(error)
          }
        );
      } catch {}
      throw error;
    }
  });
}

export async function loadKuzuV2Summary(dbPath) {
  if (!await fileExists(dbPath)) {
    return {
      dbPath,
      exists: false,
      schemaVersion: KUZU_V2_SCHEMA_VERSION,
      nodeCount: 0,
      relationshipCount: 0,
      sourceFragmentCount: 0,
      nodeContributionCount: 0,
      relationshipContributionCount: 0,
      deltaJournalCount: 0,
      completedDeltaCount: 0,
      migrationState: null
    };
  }

  return withKuzuConnection(dbPath, async (conn) => {
    await ensureKuzuV2Schema(conn);
    const nodeRows = await queryRows(conn, `MATCH (n:${KUZU_NODE_TABLE}) RETURN count(n) AS count;`);
    const relationshipRows = await queryRows(conn, `MATCH (a:${KUZU_NODE_TABLE})-[r:${KUZU_REL_TABLE}]->(b:${KUZU_NODE_TABLE}) RETURN count(r) AS count;`);
    const fragmentRows = await queryRows(conn, `MATCH (f:${KUZU_SOURCE_FRAGMENT_TABLE}) RETURN count(f) AS count;`);
    const nodeContributionRows = await queryRows(conn, `MATCH (c:${KUZU_NODE_CONTRIBUTION_TABLE}) RETURN count(c) AS count;`);
    const relationshipContributionRows = await queryRows(conn, `MATCH (c:${KUZU_REL_CONTRIBUTION_TABLE}) RETURN count(c) AS count;`);
    const journalRows = await queryRows(conn, `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE}) RETURN count(j) AS count;`);
    const completedJournalRows = await queryRows(conn, `MATCH (j:${KUZU_DELTA_JOURNAL_TABLE}) WHERE j.status = $status RETURN count(j) AS count;`, { status: 'completed' });
    const migrationStateRows = await queryRows(conn, `MATCH (m:${KUZU_MIGRATION_STATE_TABLE} {version: $version}) RETURN m.version AS version, m.sourceManifestToken AS sourceManifestToken, m.status AS status, m.checkpoint AS checkpoint, m.updatedAt AS updatedAt, m.metadata AS metadata;`, { version: KUZU_V2_SCHEMA_VERSION });

    return {
      dbPath,
      exists: true,
      schemaVersion: KUZU_V2_SCHEMA_VERSION,
      nodeCount: Number(nodeRows[0]?.count || 0),
      relationshipCount: Number(relationshipRows[0]?.count || 0),
      sourceFragmentCount: Number(fragmentRows[0]?.count || 0),
      nodeContributionCount: Number(nodeContributionRows[0]?.count || 0),
      relationshipContributionCount: Number(relationshipContributionRows[0]?.count || 0),
      deltaJournalCount: Number(journalRows[0]?.count || 0),
      completedDeltaCount: Number(completedJournalRows[0]?.count || 0),
      migrationState: migrationStateRows[0] || null
    };
  });
}

export async function loadKnowledgeGraphFromKuzu(dbPath) {
  return withKuzuConnection(dbPath, async (conn) => {
    const graph = createKnowledgeGraph();
    const nodeResult = await conn.query(
      `MATCH (n:${KUZU_NODE_TABLE}) RETURN n.id AS id, n.nodeType AS nodeType, n.name AS name, n.properties AS properties ORDER BY id;`
    );
    const nodes = await nodeResult.getAll();
    closeQueryResult(nodeResult);

    for (const node of nodes) {
      graph.addNode({
        id: node.id,
        type: node.nodeType,
        name: node.name,
        properties: parseProperties(node.properties)
      });
    }

    const relationshipResult = await conn.query(
      `MATCH (src:${KUZU_NODE_TABLE})-[r:${KUZU_REL_TABLE}]->(dst:${KUZU_NODE_TABLE}) RETURN r.relId AS relId, src.id AS sourceId, dst.id AS targetId, r.relType AS relType, r.properties AS properties ORDER BY relId;`
    );
    const relationships = await relationshipResult.getAll();
    closeQueryResult(relationshipResult);

    for (const relationship of relationships) {
      graph.addRelationship({
        id: relationship.relId,
        sourceId: relationship.sourceId,
        targetId: relationship.targetId,
        type: relationship.relType,
        properties: parseProperties(relationship.properties)
      });
    }

    return graph;
  });
}
