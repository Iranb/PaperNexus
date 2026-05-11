import path from 'node:path';
import { ensureDir, fileExists, readJson, readText, writeJson, writeText } from '../lib/fs.js';
import { stableHash } from '../lib/utils.js';

const CHUNK_STORE_VERSION = 1;
const CHUNK_RECORD_CONTRACT_VERSION = 'papernexus-paper-chunks-v1';
const CHUNK_EXTRACTION_CONTRACT_VERSION = 'papernexus-chunk-extraction-v1';
const CHUNK_REDUCER_CONTRACT_VERSION = 'papernexus-paper-reducer-v1';

function nowIso() {
  return new Date().toISOString();
}

function safeSegment(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '_';
  return normalized.replace(/[^A-Za-z0-9._=-]+/g, '_').slice(0, 160) || '_';
}

function sourceKeyHash(sourceKey) {
  return stableHash(String(sourceKey || ''), 20);
}

export function getChunkStorePaths(rootPath, sourceKey = '') {
  const chunkDir = path.join(path.resolve(rootPath), '.papernexus', 'chunks');
  const sourceHash = sourceKey ? sourceKeyHash(sourceKey) : '';
  return {
    rootPath: path.resolve(rootPath),
    chunkDir,
    manifestPath: path.join(chunkDir, 'manifest.json'),
    recordsDir: path.join(chunkDir, 'records'),
    textDir: path.join(chunkDir, 'text'),
    extractionsDir: path.join(chunkDir, 'extractions'),
    reducersDir: path.join(chunkDir, 'reducers'),
    lockPath: path.join(chunkDir, 'chunk-store.lock'),
    sourceHash,
    paperChunksPath: sourceHash ? path.join(chunkDir, 'records', `${sourceHash}.json`) : '',
    reducerPath: sourceHash ? path.join(chunkDir, 'reducers', `${sourceHash}.json`) : ''
  };
}

function textPathForHash(paths, textHash) {
  const hash = String(textHash || '').trim() || stableHash('', 20);
  return path.join(paths.textDir, hash.slice(0, 2), `${hash}.txt`);
}

function extractionPathForTaskKey(paths, taskKey) {
  const hash = stableHash(String(taskKey || ''), 32);
  return path.join(paths.extractionsDir, hash.slice(0, 2), `${hash}.json`);
}

function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function findChunkOffsets(sectionText = '', chunkText = '', searchOffset = 0) {
  if (!chunkText) {
    return {
      charStart: Math.max(0, searchOffset),
      charEnd: Math.max(0, searchOffset)
    };
  }

  const index = String(sectionText || '').indexOf(chunkText, Math.max(0, searchOffset));
  if (index === -1) {
    return {
      charStart: Math.max(0, searchOffset),
      charEnd: Math.max(0, searchOffset) + chunkText.length
    };
  }

  return {
    charStart: index,
    charEnd: index + chunkText.length
  };
}

export function createChunkRecordsForParsedPaper(parsedPaper = {}, semanticPaper = {}, options = {}) {
  const sourceKey = String(
    semanticPaper.sourceKey
    || parsedPaper.sourceKey
    || options.sourceKey
    || options.sourceState?.sourceKey
    || ''
  ).trim();
  const paperId = String(
    semanticPaper.paperId
    || parsedPaper.paperId
    || (sourceKey ? `paper:${stableHash(sourceKey)}` : '')
  ).trim();
  const paperTitle = String(semanticPaper.paperTitle || parsedPaper.paperTitle || parsedPaper.title || '').trim();
  const sourceFingerprint = String(
    semanticPaper.sourceFingerprint
    || parsedPaper.sourceFingerprint
    || options.sourceState?.fingerprint
    || ''
  ).trim();
  const createdAt = options.createdAt || nowIso();
  const records = [];
  let globalOrder = 0;

  for (const section of parsedPaper.sections || []) {
    let searchOffset = 0;
    const sectionChunks = Array.isArray(section.chunks) && section.chunks.length
      ? section.chunks
      : [{
          text: section.text || '',
          order: 1,
          citations: Array.isArray(section.citations) ? section.citations : []
        }];
    for (const chunk of sectionChunks) {
      const text = String(chunk?.text || '').trim();
      if (!text) continue;

      globalOrder += 1;
      const textHash = stableHash(text, 32);
      const offsets = findChunkOffsets(section.text || '', text, searchOffset);
      searchOffset = offsets.charEnd;
      const sectionId = String(section.id || `section:${stableHash(`${sourceKey}:${section.order}:${section.heading}`)}`);
      const chunkId = `chunk:${stableHash(`${sourceKey}:${sectionId}:${chunk.order || globalOrder}:${textHash}`, 24)}`;

      records.push({
        version: CHUNK_STORE_VERSION,
        chunkId,
        paperId,
        paperTitle,
        sourceKey,
        sectionId,
        sectionHeading: String(section.heading || section.role || 'Section').trim(),
        sectionRole: String(section.role || 'body').trim(),
        sectionOrder: Number(section.order || 0),
        chunkOrder: Number(chunk.order || 0),
        order: globalOrder,
        textHash,
        text,
        textPath: '',
        charStart: offsets.charStart,
        charEnd: offsets.charEnd,
        tokenEstimate: estimateTokens(text),
        citationCount: Array.isArray(chunk.citations) ? chunk.citations.length : 0,
        citations: Array.isArray(chunk.citations) ? chunk.citations : [],
        sourceFingerprint,
        createdAt
      });
    }
  }

  return records;
}

async function updateChunkManifest(rootPath, patch = {}) {
  const paths = getChunkStorePaths(rootPath);
  const previous = await readJson(paths.manifestPath, null);
  const sources = {
    ...(previous?.sources || {}),
    ...(patch.sources || {})
  };
  const manifest = {
    version: CHUNK_STORE_VERSION,
    contractVersion: 'papernexus-chunk-store-manifest-v1',
    createdAt: previous?.createdAt || nowIso(),
    updatedAt: nowIso(),
    sourceCount: Object.keys(sources).length,
    chunkCount: Object.values(sources).reduce((sum, source) => sum + Number(source?.chunkCount || 0), 0),
    ...previous,
    ...patch,
    sources
  };
  await ensureDir(paths.chunkDir);
  await writeJson(paths.manifestPath, manifest);
  return manifest;
}

export async function writePaperChunks(rootPath, sourceKey, chunkRecords = [], options = {}) {
  const normalizedSourceKey = String(sourceKey || '').trim();
  if (!normalizedSourceKey) {
    throw new Error('sourceKey is required to write paper chunks.');
  }

  const paths = getChunkStorePaths(rootPath, normalizedSourceKey);
  const writtenAt = options.updatedAt || nowIso();
  const persistedChunks = [];

  await Promise.all([
    ensureDir(paths.recordsDir),
    ensureDir(paths.textDir)
  ]);

  for (const chunk of chunkRecords || []) {
    if (!chunk?.chunkId || !chunk?.textHash) continue;
    const text = String(chunk.text || '');
    const textPath = textPathForHash(paths, chunk.textHash);
    if (text && (options.force || !await fileExists(textPath))) {
      await writeText(textPath, text);
    }
    const { text: _text, ...metadata } = chunk;
    persistedChunks.push({
      ...metadata,
      sourceKey: normalizedSourceKey,
      textPath,
      updatedAt: writtenAt
    });
  }

  const payload = {
    version: CHUNK_STORE_VERSION,
    contractVersion: CHUNK_RECORD_CONTRACT_VERSION,
    sourceKey: normalizedSourceKey,
    paperId: persistedChunks[0]?.paperId || '',
    paperTitle: persistedChunks[0]?.paperTitle || '',
    sourceFingerprint: persistedChunks[0]?.sourceFingerprint || '',
    chunkCount: persistedChunks.length,
    textBytes: chunkRecords.reduce((sum, chunk) => sum + Buffer.byteLength(String(chunk?.text || ''), 'utf8'), 0),
    updatedAt: writtenAt,
    chunks: persistedChunks
  };

  await writeJson(paths.paperChunksPath, payload);
  await updateChunkManifest(rootPath, {
    sources: {
      [normalizedSourceKey]: {
        sourceKey: normalizedSourceKey,
        sourceHash: paths.sourceHash,
        paperId: payload.paperId,
        paperTitle: payload.paperTitle,
        sourceFingerprint: payload.sourceFingerprint,
        chunkCount: payload.chunkCount,
        textBytes: payload.textBytes,
        recordPath: paths.paperChunksPath,
        updatedAt: writtenAt
      }
    }
  });

  return payload;
}

export async function loadPaperChunks(rootPath, sourceKey) {
  const paths = getChunkStorePaths(rootPath, sourceKey);
  return readJson(paths.paperChunksPath, null);
}

export async function loadChunkText(chunk = {}) {
  if (typeof chunk.text === 'string' && chunk.text) return chunk.text;
  if (!chunk.textPath) return '';
  return readText(chunk.textPath);
}

export function createChunkLlmTaskKey(chunk = {}, options = {}) {
  return `chunk-task:${stableHash(JSON.stringify({
    version: CHUNK_STORE_VERSION,
    taskType: options.taskType || 'semantic',
    chunkId: chunk.chunkId || '',
    textHash: chunk.textHash || '',
    promptVersion: options.promptVersion || '',
    model: options.model || '',
    provider: options.provider || '',
    baseUrl: options.baseUrl || '',
    extractionMode: options.extractionMode || '',
    configSignature: options.configSignature || ''
  }), 32)}`;
}

export async function loadChunkExtractionResult(rootPath, taskKey) {
  const paths = getChunkStorePaths(rootPath);
  return readJson(extractionPathForTaskKey(paths, taskKey), null);
}

export async function saveChunkExtractionResult(rootPath, taskKey, payload = {}) {
  const paths = getChunkStorePaths(rootPath);
  const extractionPath = extractionPathForTaskKey(paths, taskKey);
  const timestamp = nowIso();
  const normalized = {
    version: CHUNK_STORE_VERSION,
    contractVersion: CHUNK_EXTRACTION_CONTRACT_VERSION,
    taskKey,
    taskKeyHash: stableHash(String(taskKey || ''), 32),
    status: payload.status || 'completed',
    createdAt: payload.createdAt || timestamp,
    updatedAt: timestamp,
    ...payload
  };
  await ensureDir(path.dirname(extractionPath));
  await writeJson(extractionPath, normalized);
  return {
    extractionPath,
    result: normalized
  };
}

export async function writePaperReduceCheckpoint(rootPath, sourceKey, checkpoint = {}) {
  const paths = getChunkStorePaths(rootPath, sourceKey);
  const timestamp = nowIso();
  const payload = {
    version: CHUNK_STORE_VERSION,
    contractVersion: CHUNK_REDUCER_CONTRACT_VERSION,
    sourceKey,
    status: checkpoint.status || 'completed',
    updatedAt: timestamp,
    ...checkpoint
  };
  await ensureDir(paths.reducersDir);
  await writeJson(paths.reducerPath, payload);
  return payload;
}

export async function loadPaperReduceCheckpoint(rootPath, sourceKey) {
  const paths = getChunkStorePaths(rootPath, sourceKey);
  return readJson(paths.reducerPath, null);
}

export function summarizeChunkExtractionResults(results = []) {
  const summary = {
    total: results.length,
    completed: 0,
    failed: 0,
    rateLimited: 0,
    skipped: 0
  };

  for (const result of results || []) {
    const status = String(result?.status || 'unknown').toLowerCase();
    if (status === 'completed') summary.completed += 1;
    else if (status === 'rate-limited') summary.rateLimited += 1;
    else if (status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  }

  return summary;
}
