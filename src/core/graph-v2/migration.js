import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, readJson, removePath, withFileLock, writeJson } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';
import {
  getCorpusPaths,
  loadCorpus,
  loadCorpusLite,
  loadCorpusMeta,
  loadSourceManifest
} from '../../storage/corpus-store.js';
import {
  loadKuzuV2Summary,
  saveGraphDeltaToKuzu
} from '../../storage/kuzu-store.js';
import {
  appendRunEvent,
  continueRun,
  loadRunStatus,
  startRun,
  updateRunStage,
  updateRunState,
  writeRunCheckpoint
} from '../../storage/run-store.js';

const GRAPH_V2_RUN_KIND = 'graph-v2-migration';
const GRAPH_V2_STAGE_WEIGHTS = {
  inventory: 3,
  'build-shadow': 55,
  verify: 15,
  'shadow-sync': 20,
  cutover: 5,
  cleanup: 2
};

function nowIso() {
  return new Date().toISOString();
}

async function pathSizeBytes(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await pathSizeBytes(path.join(targetPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

export function getGraphV2Paths(rootPath) {
  const corpusDir = path.join(path.resolve(rootPath), '.papernexus');
  const migrationDir = path.join(corpusDir, 'graph-v2-migration');
  return {
    corpusDir,
    graphV2Path: path.join(corpusDir, 'graph-v2.kuzu'),
    migrationDir,
    activeRunPath: path.join(migrationDir, 'active-run.json'),
    latestReportPath: path.join(migrationDir, 'latest-report.json'),
    lockPath: path.join(migrationDir, 'migration.lock'),
    backupsDir: path.join(migrationDir, 'backups')
  };
}

function getGraphV2InspectionPath(rootPath, meta = {}) {
  const graphV2Active = String(meta?.graphV2Status || '').trim().toLowerCase() === 'active';
  return graphV2Active
    ? getCorpusPaths(rootPath).kuzuGraphPath
    : getGraphV2Paths(rootPath).graphV2Path;
}

function createManifestToken(manifest = null) {
  if (!manifest) return null;
  return `manifest:${stableHash(JSON.stringify({
    corpusName: manifest.corpusName || '',
    rootPath: manifest.rootPath || '',
    inputPath: manifest.inputPath || '',
    inputPaths: manifest.inputPaths || [],
    sources: (manifest.sources || []).map((source) => ({
      sourceKey: source.sourceKey,
      paperId: source.paperId,
      paperTitle: source.paperTitle,
      fingerprint: source.fingerprint || source.sourceFingerprint || '',
      activeInGraph: source.activeInGraph !== false
    })).sort((left, right) => String(left.sourceKey || '').localeCompare(String(right.sourceKey || '')))
  }), 24)}`;
}

function createConfigSignature(options = {}) {
  return `graph-v2:${stableHash(JSON.stringify({
    schema: 'graph-v2-kuzu-v1',
    resetShadow: Boolean(options.resetShadow || options.reset),
    buildMode: options.buildMode || 'shadow-full'
  }), 20)}`;
}

async function loadCorpusBasics(rootPath) {
  const [meta, manifest] = await Promise.all([
    loadCorpusMeta(rootPath).catch(() => null),
    loadSourceManifest(rootPath).catch(() => null)
  ]);
  const manifestToken = createManifestToken(manifest);
  return {
    meta,
    manifest,
    manifestToken
  };
}

async function getOrStartGraphV2Run(rootPath, command, stage, options = {}) {
  if (options.runId) {
    const resumed = options.resume
      ? await continueRun(rootPath, {
          runId: options.runId,
          manifestToken: options.manifestToken,
          configSignature: options.configSignature,
          acceptManifestDrift: options.acceptManifestDrift,
          acceptConfigDrift: options.acceptConfigDrift
        })
      : await loadRunStatus(rootPath, options.runId);
    return {
      runId: resumed.runId,
      status: await loadRunStatus(rootPath, resumed.runId)
    };
  }

  const started = await startRun(rootPath, {
    kind: GRAPH_V2_RUN_KIND,
    command,
    currentStage: stage,
    manifestToken: options.manifestToken,
    configSignature: options.configSignature,
    stageWeights: GRAPH_V2_STAGE_WEIGHTS,
    metadata: {
      graphV2: true,
      command
    },
    message: `Started graph-v2 ${command}`
  });
  const { runId } = started;
  const { activeRunPath, migrationDir } = getGraphV2Paths(rootPath);
  await ensureDir(migrationDir);
  await writeJson(activeRunPath, {
    version: 1,
    runId,
    command,
    stage,
    updatedAt: nowIso()
  });
  return {
    runId,
    status: started
  };
}

async function writeLatestReport(rootPath, report) {
  const { latestReportPath, migrationDir } = getGraphV2Paths(rootPath);
  await ensureDir(migrationDir);
  await writeJson(latestReportPath, {
    version: 1,
    updatedAt: nowIso(),
    ...report
  });
}

function normalizeLiteSourceEntry(entry = {}) {
  return {
    sourceKey: String(entry.sourceKey || '').trim(),
    paperId: String(entry.paperId || '').trim(),
    paperTitle: String(entry.paperTitle || '').trim(),
    fingerprint: String(entry.fingerprint || entry.sourceFingerprint || '').trim(),
    nodeIds: Array.isArray(entry.nodeIds) ? entry.nodeIds.filter(Boolean).sort() : [],
    relationshipIds: Array.isArray(entry.relationshipIds) ? entry.relationshipIds.filter(Boolean).sort() : []
  };
}

function createSourceEntriesFromLiteState(manifest = {}, liteState = {}) {
  const entries = [];
  const manifestBySourceKey = new Map((manifest?.sources || []).map((source) => [source.sourceKey, source]));
  for (const [sourceKey, entry] of Object.entries(liteState?.sources || {})) {
    if (!sourceKey || sourceKey === '__global__') continue;
    const manifestEntry = manifestBySourceKey.get(sourceKey) || {};
    entries.push(normalizeLiteSourceEntry({
      ...manifestEntry,
      ...entry,
      sourceKey
    }));
  }

  if (entries.length) {
    return entries.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  }

  return (manifest?.sources || [])
    .filter((source) => source?.sourceKey)
    .map((source) => normalizeLiteSourceEntry({
      sourceKey: source.sourceKey,
      paperId: source.paperId,
      paperTitle: source.paperTitle,
      fingerprint: source.fingerprint || source.sourceFingerprint,
      nodeIds: source.paperId ? [source.paperId] : [],
      relationshipIds: []
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

async function buildFullGraphDeltaPayload(rootPath, graph, manifest, targetManifestToken) {
  const { liteStatePath } = getCorpusPaths(rootPath);
  const liteState = await readJson(liteStatePath, null);
  const sourceEntries = createSourceEntriesFromLiteState(manifest, liteState);
  return {
    baseManifestToken: null,
    targetManifestToken,
    changedSourceKeys: sourceEntries.map((entry) => entry.sourceKey).filter(Boolean),
    upsertNodes: graph.nodes,
    upsertRelationships: graph.relationships,
    deleteNodeIds: [],
    deleteRelationshipIds: [],
    sourceEntries
  };
}

export async function inventoryGraphV2(rootPath, options = {}) {
  const { meta, manifest, manifestToken } = await loadCorpusBasics(rootPath);
  const configSignature = createConfigSignature(options);
  const { runId } = await getOrStartGraphV2Run(rootPath, 'inventory', 'inventory', {
    ...options,
    manifestToken,
    configSignature
  });

  await appendRunEvent(rootPath, runId, {
    event: 'stage-started',
    stage: 'inventory',
    message: 'inventory started'
  });
  await updateRunStage(rootPath, runId, 'inventory', {
    status: 'running',
    processedUnits: 0,
    totalUnits: 1,
    percent: 0,
    message: 'Reading corpus and graph-v2 inventory'
  });

  const graphV2Path = getGraphV2InspectionPath(rootPath, meta);
  const graphV2 = await loadKuzuV2Summary(graphV2Path).catch((error) => ({
    dbPath: graphV2Path,
    exists: false,
    error: error.message
  }));
  const report = {
    type: 'inventory',
    rootPath: path.resolve(rootPath),
    corpusName: meta?.name || manifest?.corpusName || null,
    manifestToken,
    sourceCount: manifest?.sources?.length || 0,
    paperCount: meta?.paperCount || 0,
    nodeCount: meta?.nodeCount || 0,
    relationshipCount: meta?.relationshipCount || 0,
    graphV2
  };

  await writeRunCheckpoint(rootPath, runId, 'inventory/report', {
    status: 'completed',
    outputHash: stableHash(JSON.stringify(report), 24),
    report
  });
  await updateRunStage(rootPath, runId, 'inventory', {
    status: 'completed',
    processedUnits: 1,
    totalUnits: 1,
    percent: 100,
    completedAt: nowIso(),
    message: 'Inventory completed'
  });
  await appendRunEvent(rootPath, runId, {
    event: 'stage-completed',
    stage: 'inventory',
    percent: 100,
    message: 'inventory completed'
  });
  await updateRunState(rootPath, runId, {
    status: 'completed',
    currentStage: 'inventory',
    canContinue: false,
    completedAt: nowIso()
  });
  await writeLatestReport(rootPath, report);
  return {
    runId,
    report
  };
}

export async function buildGraphV2Shadow(rootPath, options = {}) {
  const { meta, manifest, manifestToken } = await loadCorpusBasics(rootPath);
  const configSignature = createConfigSignature({
    ...options,
    resetShadow: options.resetShadow !== false
  });
  const { graphV2Path, lockPath } = getGraphV2Paths(rootPath);
  const { runId } = await getOrStartGraphV2Run(rootPath, 'build-shadow', 'build-shadow', {
    ...options,
    manifestToken,
    configSignature
  });

  return withFileLock(lockPath, async () => {
    await appendRunEvent(rootPath, runId, {
      event: 'stage-started',
      stage: 'build-shadow',
      message: 'build-shadow started'
    });
    await updateRunStage(rootPath, runId, 'build-shadow', {
      status: 'running',
      processedUnits: 0,
      totalUnits: 1,
      percent: 0,
      message: 'Loading current authoritative graph'
    });

    const corpus = await loadCorpusLite(rootPath);
    const deltaPayload = await buildFullGraphDeltaPayload(rootPath, corpus.graph, manifest, manifestToken);
    await updateRunStage(rootPath, runId, 'build-shadow', {
      status: 'running',
      processedUnits: 0,
      totalUnits: Math.max(1, deltaPayload.upsertNodes.length + deltaPayload.upsertRelationships.length),
      percent: 5,
      message: 'Applying full graph into graph-v2 shadow DB'
    });

    let lastProgressAt = 0;
    const summary = await saveGraphDeltaToKuzu(graphV2Path, deltaPayload, {
      jobId: `shadow:${stableHash(`${manifestToken}:${deltaPayload.upsertNodes.length}:${deltaPayload.upsertRelationships.length}`, 18)}`,
      targetManifestToken: manifestToken,
      resetShadow: options.resetShadow !== false,
      force: Boolean(options.force),
      onProgress(event = {}) {
        const now = Date.now();
        if (now - lastProgressAt < 1000 && !String(event.label || '').includes('committing')) {
          return;
        }
        lastProgressAt = now;
        void appendRunEvent(rootPath, runId, {
          event: String(event.label || '').includes('transaction')
            ? 'kuzu-transaction-started'
            : 'stage-progress',
          stage: 'build-shadow',
          message: event.label || 'building graph-v2 shadow'
        }).catch(() => {});
      }
    });

    const graphV2 = await loadKuzuV2Summary(graphV2Path);
    const report = {
      type: 'build-shadow',
      rootPath: path.resolve(rootPath),
      corpusName: meta?.name || manifest?.corpusName || null,
      manifestToken,
      graphV2,
      summary
    };
    await writeRunCheckpoint(rootPath, runId, 'build-shadow/kuzu-apply', {
      status: 'completed',
      outputHash: stableHash(JSON.stringify(summary), 24),
      report
    });
    await updateRunStage(rootPath, runId, 'build-shadow', {
      status: 'completed',
      processedUnits: deltaPayload.upsertNodes.length + deltaPayload.upsertRelationships.length,
      totalUnits: Math.max(1, deltaPayload.upsertNodes.length + deltaPayload.upsertRelationships.length),
      percent: 100,
      completedAt: nowIso(),
      message: 'graph-v2 shadow build completed'
    });
    await appendRunEvent(rootPath, runId, {
      event: 'kuzu-transaction-committed',
      stage: 'build-shadow',
      percent: 100,
      message: 'graph-v2 shadow committed'
    });
    await updateRunState(rootPath, runId, {
      status: 'completed',
      currentStage: 'build-shadow',
      canContinue: false,
      completedAt: nowIso()
    });
    await writeLatestReport(rootPath, report);
    return {
      runId,
      report
    };
  });
}

export async function verifyGraphV2(rootPath, options = {}) {
  const { meta, manifest, manifestToken } = await loadCorpusBasics(rootPath);
  const configSignature = createConfigSignature(options);
  const graphV2Path = getGraphV2InspectionPath(rootPath, meta);
  const { runId } = await getOrStartGraphV2Run(rootPath, 'verify', 'verify', {
    ...options,
    manifestToken,
    configSignature
  });

  await appendRunEvent(rootPath, runId, {
    event: 'stage-started',
    stage: 'verify',
    message: 'verify started'
  });
  await updateRunStage(rootPath, runId, 'verify', {
    status: 'running',
    processedUnits: 0,
    totalUnits: 1,
    percent: 0,
    message: 'Comparing current graph and graph-v2 shadow'
  });

  const corpus = await loadCorpusLite(rootPath);
  const summaryStartedAt = Date.now();
  const graphV2 = await loadKuzuV2Summary(graphV2Path);
  const summaryLatencyMs = Date.now() - summaryStartedAt;
  const validation = {
    graphV2Path,
    schemaVersion: graphV2.schemaVersion || null,
    summaryLatencyMs,
    diskBytes: await pathSizeBytes(graphV2Path),
    rssBytes: process.memoryUsage().rss,
    manifestToken,
    checkedAt: nowIso()
  };
  const expected = {
    nodeCount: meta?.nodeCount ?? corpus.graph.nodeCount,
    relationshipCount: meta?.relationshipCount ?? corpus.graph.relationshipCount,
    sourceFragmentCount: manifest?.sources?.length || 0
  };
  const warnings = [];
  if (graphV2.nodeCount !== expected.nodeCount) {
    warnings.push(`node count mismatch: expected ${expected.nodeCount}, graph-v2 has ${graphV2.nodeCount}`);
  }
  if (graphV2.relationshipCount !== expected.relationshipCount) {
    warnings.push(`relationship count mismatch: expected ${expected.relationshipCount}, graph-v2 has ${graphV2.relationshipCount}`);
  }
  if (graphV2.sourceFragmentCount < expected.sourceFragmentCount) {
    warnings.push(`source fragment count is lower than manifest sources: expected at least ${expected.sourceFragmentCount}, graph-v2 has ${graphV2.sourceFragmentCount}`);
  }

  const ok = warnings.length === 0 || Boolean(options.allowWarnings);
  const report = {
    type: 'verify',
    rootPath: path.resolve(rootPath),
    corpusName: meta?.name || manifest?.corpusName || null,
    manifestToken,
    ok,
    expected,
    graphV2,
    validation,
    warnings
  };
  await writeRunCheckpoint(rootPath, runId, 'verify/report', {
    status: ok ? 'completed' : 'failed',
    outputHash: stableHash(JSON.stringify(report), 24),
    report
  });
  await updateRunStage(rootPath, runId, 'verify', {
    status: ok ? 'completed' : 'failed',
    processedUnits: 1,
    totalUnits: 1,
    percent: 100,
    completedAt: ok ? nowIso() : null,
    lastError: ok ? null : { message: warnings.join('; ') },
    message: ok ? 'graph-v2 verification passed' : 'graph-v2 verification failed'
  });
  for (const warning of warnings) {
    await appendRunEvent(rootPath, runId, {
      event: ok ? 'verification-warning' : 'verification-failed',
      level: ok ? 'warn' : 'error',
      stage: 'verify',
      message: warning,
      error: ok ? null : { message: warning }
    });
  }
  await updateRunState(rootPath, runId, {
    status: ok ? 'completed' : 'failed',
    currentStage: 'verify',
    canContinue: !ok,
    completedAt: ok ? nowIso() : null,
    lastError: ok ? null : { message: warnings.join('; ') }
  });
  await writeLatestReport(rootPath, report);
  return {
    runId,
    report
  };
}

async function copyPathIfExists(sourcePath, targetPath) {
  if (!await fileExists(sourcePath)) return false;
  await ensureDir(path.dirname(targetPath));
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true
  });
  return true;
}

export async function cutoverGraphV2(rootPath, options = {}) {
  const { meta, manifest, manifestToken } = await loadCorpusBasics(rootPath);
  const configSignature = createConfigSignature(options);
  const graphV2Paths = getGraphV2Paths(rootPath);
  const corpusPaths = getCorpusPaths(rootPath);
  const { runId } = await getOrStartGraphV2Run(rootPath, 'cutover', 'cutover', {
    ...options,
    manifestToken,
    configSignature
  });

  return withFileLock(graphV2Paths.lockPath, async () => {
    await appendRunEvent(rootPath, runId, {
      event: 'cutover-started',
      stage: 'cutover',
      message: 'graph-v2 cutover started'
    });
    await updateRunStage(rootPath, runId, 'cutover', {
      status: 'running',
      processedUnits: 0,
      totalUnits: 1,
      percent: 0,
      message: 'Preparing graph-v2 cutover'
    });

    if (!await fileExists(graphV2Paths.graphV2Path)) {
      throw new Error(`graph-v2 shadow database does not exist at ${graphV2Paths.graphV2Path}. Run graph-v2 build-shadow first.`);
    }

    if (!options.skipVerify) {
      const verification = await verifyGraphV2(rootPath, {
        runId,
        allowWarnings: Boolean(options.force),
        resume: false
      });
      if (!verification.report.ok && !options.force) {
        throw new Error('graph-v2 verification failed. Use --force only after reviewing the verification report.');
      }
    }

    const backupId = `cutover-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const backupDir = path.join(graphV2Paths.backupsDir, backupId);
    await ensureDir(backupDir);
    await Promise.all([
      copyPathIfExists(corpusPaths.graphPath, path.join(backupDir, 'graph.json')),
      copyPathIfExists(corpusPaths.kuzuGraphPath, path.join(backupDir, 'graph.kuzu')),
      copyPathIfExists(`${corpusPaths.kuzuGraphPath}.wal`, path.join(backupDir, 'graph.kuzu.wal')),
      copyPathIfExists(corpusPaths.metaPath, path.join(backupDir, 'meta.json'))
    ]);

    await removePath(corpusPaths.kuzuGraphPath);
    await removePath(`${corpusPaths.kuzuGraphPath}.wal`);
    await fs.cp(graphV2Paths.graphV2Path, corpusPaths.kuzuGraphPath, {
      recursive: true,
      force: true
    });

    const cutoverAt = nowIso();
    const nextMeta = {
      ...(meta || {}),
      graphV2Status: 'active',
      graphV2CutoverAt: cutoverAt,
      graphV2ManifestToken: manifestToken,
      graphV2BackupId: backupId,
      graphV2BackupDir: backupDir,
      authoritativeSyncFailedAt: null,
      authoritativeSyncError: null
    };
    await writeJson(corpusPaths.metaPath, nextMeta);
    await writeJson(graphV2Paths.activeRunPath, {
      version: 1,
      runId,
      command: 'cutover',
      status: 'active',
      backupId,
      backupDir,
      manifestToken,
      cutoverAt,
      updatedAt: cutoverAt
    });

    const report = {
      type: 'cutover',
      rootPath: path.resolve(rootPath),
      corpusName: meta?.name || manifest?.corpusName || null,
      manifestToken,
      backupId,
      backupDir,
      cutoverAt
    };
    await writeRunCheckpoint(rootPath, runId, 'cutover/active-pointer', {
      status: 'completed',
      outputHash: stableHash(JSON.stringify(report), 24),
      report
    });
    await updateRunStage(rootPath, runId, 'cutover', {
      status: 'completed',
      processedUnits: 1,
      totalUnits: 1,
      percent: 100,
      completedAt: cutoverAt,
      message: 'graph-v2 cutover completed'
    });
    await appendRunEvent(rootPath, runId, {
      event: 'cutover-completed',
      stage: 'cutover',
      percent: 100,
      message: 'graph-v2 cutover completed'
    });
    await updateRunState(rootPath, runId, {
      status: 'completed',
      currentStage: 'cutover',
      canContinue: false,
      completedAt: cutoverAt
    });
    await writeLatestReport(rootPath, report);
    return {
      runId,
      report
    };
  });
}

export async function rollbackGraphV2(rootPath, options = {}) {
  const graphV2Paths = getGraphV2Paths(rootPath);
  const corpusPaths = getCorpusPaths(rootPath);
  const active = await readJson(graphV2Paths.activeRunPath, null);
  const backupDir = options.backupDir || active?.backupDir;
  if (!backupDir) {
    throw new Error('No graph-v2 cutover backup was found. Provide --backup-dir to rollback explicitly.');
  }
  const { meta, manifest, manifestToken } = await loadCorpusBasics(rootPath);
  const { runId } = await getOrStartGraphV2Run(rootPath, 'rollback', 'rollback', {
    ...options,
    manifestToken,
    configSignature: createConfigSignature(options)
  });

  return withFileLock(graphV2Paths.lockPath, async () => {
    await appendRunEvent(rootPath, runId, {
      event: 'rollback-started',
      stage: 'rollback',
      message: 'graph-v2 rollback started'
    });
    await updateRunStage(rootPath, runId, 'rollback', {
      status: 'running',
      processedUnits: 0,
      totalUnits: 1,
      percent: 0,
      message: 'Restoring pre-cutover graph files'
    });

    await removePath(corpusPaths.kuzuGraphPath);
    await removePath(`${corpusPaths.kuzuGraphPath}.wal`);
    await copyPathIfExists(path.join(backupDir, 'graph.kuzu'), corpusPaths.kuzuGraphPath);
    await copyPathIfExists(path.join(backupDir, 'graph.kuzu.wal'), `${corpusPaths.kuzuGraphPath}.wal`);
    await copyPathIfExists(path.join(backupDir, 'graph.json'), corpusPaths.graphPath);
    if (await fileExists(path.join(backupDir, 'meta.json'))) {
      await copyPathIfExists(path.join(backupDir, 'meta.json'), corpusPaths.metaPath);
    } else {
      await writeJson(corpusPaths.metaPath, {
        ...(meta || {}),
        graphV2Status: 'rolled-back',
        graphV2RolledBackAt: nowIso()
      });
    }

    const rolledBackAt = nowIso();
    await writeJson(graphV2Paths.activeRunPath, {
      ...(active || {}),
      version: 1,
      runId,
      command: 'rollback',
      status: 'rolled-back',
      backupDir,
      rolledBackAt,
      updatedAt: rolledBackAt
    });

    const report = {
      type: 'rollback',
      rootPath: path.resolve(rootPath),
      corpusName: meta?.name || manifest?.corpusName || null,
      manifestToken,
      backupDir,
      rolledBackAt
    };
    await writeRunCheckpoint(rootPath, runId, 'rollback/restored-pointer', {
      status: 'completed',
      outputHash: stableHash(JSON.stringify(report), 24),
      report
    });
    await updateRunStage(rootPath, runId, 'rollback', {
      status: 'completed',
      processedUnits: 1,
      totalUnits: 1,
      percent: 100,
      completedAt: rolledBackAt,
      message: 'graph-v2 rollback completed'
    });
    await appendRunEvent(rootPath, runId, {
      event: 'rollback-completed',
      stage: 'rollback',
      percent: 100,
      message: 'graph-v2 rollback completed'
    });
    await updateRunState(rootPath, runId, {
      status: 'completed',
      currentStage: 'rollback',
      canContinue: false,
      completedAt: rolledBackAt
    });
    await writeLatestReport(rootPath, report);
    return {
      runId,
      report
    };
  });
}

export async function continueGraphV2Migration(rootPath, options = {}) {
  const runId = options.runId || 'latest';
  const resumed = await continueRun(rootPath, {
    ...options,
    runId
  });
  const status = await loadRunStatus(rootPath, resumed.runId);
  const command = String(status.run.command || status.run.metadata?.command || '').trim();
  const stage = String(status.state.currentStage || '').trim();

  if (command === 'build-shadow' || stage === 'build-shadow') {
    return buildGraphV2Shadow(rootPath, {
      ...options,
      runId: resumed.runId,
      resume: false,
      resetShadow: options.resetShadow !== false
    });
  }
  if (command === 'verify' || stage === 'verify') {
    return verifyGraphV2(rootPath, {
      ...options,
      runId: resumed.runId,
      resume: false
    });
  }
  if (command === 'cutover' || stage === 'cutover') {
    return cutoverGraphV2(rootPath, {
      ...options,
      runId: resumed.runId,
      resume: false
    });
  }
  if (command === 'rollback' || stage === 'rollback') {
    return rollbackGraphV2(rootPath, {
      ...options,
      runId: resumed.runId,
      resume: false
    });
  }
  return inventoryGraphV2(rootPath, {
    ...options,
    runId: resumed.runId,
    resume: false
  });
}
