import path from 'node:path';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import { ensureDir, fileExists, removePath } from '../lib/fs.js';

const KUZU_NODE_TABLE = 'PNNode';
const KUZU_REL_TABLE = 'PNRel';
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
