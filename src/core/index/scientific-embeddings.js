import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import { ensureDir, readJson, writeJson } from '../../lib/fs.js';

export const SCIENTIFIC_EMBEDDINGS_VERSION = 'papernexus-scientific-embeddings-v1';
export const SCIENTIFIC_EMBEDDING_INDEX_VERSION = 'papernexus-scientific-embedding-index-v1';
export const SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION = 'papernexus-scientific-embeddings-manifest-v1';
export const FIXED_CORPUS_DENSE_SCORES_VERSION = 'fixed-corpus-dense-scores-v1';
export const DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD = 'deterministic-scientific-token-hash-v1';
export const DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION = 128;
export const DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K = 100;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'our',
  'paper',
  'papers',
  'study',
  'studies',
  'that',
  'the',
  'this',
  'to',
  'using',
  'via',
  'we',
  'with'
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeIdentifier(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:/, '')
    .replace(/^arxiv:/, '');
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDimension(value = DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION) {
  return Math.max(2, normalizePositiveInteger(value, DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION));
}

function normalizeTopK(value = DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K) {
  return Math.max(1, normalizePositiveInteger(value, DEFAULT_SCIENTIFIC_EMBEDDING_TOP_K));
}

function vectorNorm(vector = []) {
  return Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
}

function normalizeVector(vector = [], dimension = null) {
  const values = asArray(vector).map((value) => Number(value));
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const targetDimension = dimension && Number.isFinite(Number(dimension)) ? Number(dimension) : values.length;
  if (values.length !== targetDimension) return null;
  const norm = vectorNorm(values);
  if (!norm) return null;
  return values.map((value) => Number((value / norm).toFixed(10)));
}

function cosineSimilarity(left = [], right = []) {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += left[index] * right[index];
  }
  return Number(score.toFixed(10));
}

function stableHashBytes(value = '') {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function tokenToIndex(token = '', dimension = DEFAULT_SCIENTIFIC_EMBEDDING_DIMENSION) {
  const hash = stableHashBytes(token);
  const bucket = hash.readUInt32BE(0) % dimension;
  const sign = (hash[4] % 2) === 0 ? 1 : -1;
  return { bucket, sign };
}

function stemScientificToken(token = '') {
  let value = String(token || '').toLowerCase();
  if (value.length > 6 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
  if (value.length > 7 && value.endsWith('ization')) value = `${value.slice(0, -7)}ize`;
  if (value.length > 6 && value.endsWith('ation')) value = value.slice(0, -3);
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  if (value.length > 4 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

export function tokenizeScientificText(text = '') {
  const normalized = String(text || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
  const baseTokens = normalized
    .split(/\s+/)
    .map(stemScientificToken)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  const tokens = [...baseTokens];
  for (let index = 0; index < baseTokens.length - 1; index += 1) {
    tokens.push(`${baseTokens[index]}_${baseTokens[index + 1]}`);
  }
  return tokens;
}

export function buildDeterministicScientificEmbedding(text = '', options = {}) {
  const dimension = normalizeDimension(options.dimension);
  const tokens = tokenizeScientificText(text);
  const vector = new Array(dimension).fill(0);
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  for (const [token, count] of counts.entries()) {
    const { bucket, sign } = tokenToIndex(token, dimension);
    vector[bucket] += sign * (1 + Math.log(count));
  }
  return normalizeVector(vector, dimension) || new Array(dimension).fill(0);
}

function recordIdentifiers(record = {}) {
  const identifiers = asObject(record.identifiers);
  return {
    doi: normalizeIdentifier(pickFirst(record.doi, record.DOI, identifiers.doi, identifiers.DOI)),
    arxivId: normalizeIdentifier(pickFirst(record.arxivId, record.arxiv_id, record.arxiv, identifiers.arxivId, identifiers.arxiv_id, identifiers.arxiv)),
    semanticScholarId: String(pickFirst(record.semanticScholarId, record.s2Id, record.s2_id, identifiers.semanticScholarId, identifiers.s2Id, identifiers.s2_id) || '').trim(),
    openAlexId: String(pickFirst(record.openAlexId, record.openalexId, record.openalex_id, identifiers.openAlexId, identifiers.openalexId, identifiers.openalex_id) || '').trim()
  };
}

function documentText(record = {}) {
  return unique([
    record.title,
    record.abstract,
    record.summary,
    record.text,
    record.content,
    record.body,
    record.markdown,
    record.metadata?.abstract,
    record.metadata?.summary
  ]).join('\n\n');
}

function queryText(record = {}) {
  return String(pickFirst(
    record.query,
    record.text,
    record.question,
    record.title,
    record.prompt,
    record.topic,
    record.id
  ) || '').trim();
}

export function normalizeScientificCorpusRecord(record = {}, index = 0) {
  const identifiers = recordIdentifiers(record);
  const documentId = String(pickFirst(
    record.documentId,
    record.document_id,
    record.docId,
    record.doc_id,
    record.paperId,
    record.paper_id,
    record.corpusId,
    record.corpus_id,
    record.id,
    record._id,
    identifiers.doi,
    identifiers.arxivId,
    `doc-${index + 1}`
  )).trim();
  const title = String(pickFirst(record.title, record.name, documentId)).trim();
  const text = documentText(record) || title;
  return {
    index,
    documentId,
    title,
    text,
    identifiers,
    lookupKeys: unique([
      documentId,
      title,
      identifiers.doi,
      identifiers.arxivId,
      identifiers.semanticScholarId,
      identifiers.openAlexId
    ])
  };
}

export function normalizeScientificQueryRecord(record = {}, index = 0) {
  const queryId = String(pickFirst(
    record.queryId,
    record.query_id,
    record.id,
    record._id,
    record.questionId,
    `q${index + 1}`
  )).trim();
  const text = queryText(record) || queryId;
  return {
    index,
    queryId,
    query: text,
    lookupKeys: unique([queryId, text, record.question, record.title])
  };
}

function corpusFromInput(input = {}) {
  const root = asObject(input);
  return [
    root.corpus,
    root.documents,
    root.docs,
    root.papers,
    root.items
  ].find(Array.isArray) || [];
}

function queriesFromInput(input = {}) {
  const root = asObject(input);
  return [
    root.queries,
    root.questions,
    root.tasks
  ].find(Array.isArray) || [];
}

export function normalizeScientificEmbeddingInput(input = {}) {
  const corpus = corpusFromInput(input).map(normalizeScientificCorpusRecord);
  const queries = queriesFromInput(input).map(normalizeScientificQueryRecord);
  return {
    name: String(pickFirst(input.name, input.dataset, input.benchmark, 'scientific-embedding-input')),
    corpus,
    queries,
    diagnostics: {
      corpusCount: corpus.length,
      queryCount: queries.length,
      emptyDocumentTextCount: corpus.filter((entry) => !entry.text).length,
      emptyQueryTextCount: queries.filter((entry) => !entry.query).length
    }
  };
}

function vectorEntriesFromPayload(payload = {}, family = 'documents') {
  const root = asObject(payload);
  const direct = root[family] || root[family.slice(0, -1)] || root.vectors;
  if (Array.isArray(direct)) return direct;
  const map = asObject(direct);
  return Object.entries(map).map(([id, vector]) => ({ id, vector }));
}

function vectorFromEntry(entry = {}) {
  return asArray(pickFirst(entry.embedding, entry.vector, entry.values, entry.denseVector, entry.dense_vector));
}

function vectorKeysFromEntry(entry = {}) {
  return unique([
    entry.documentId,
    entry.document_id,
    entry.docId,
    entry.doc_id,
    entry.paperId,
    entry.paper_id,
    entry.queryId,
    entry.query_id,
    entry.id,
    entry._id,
    entry.title,
    entry.query,
    entry.text,
    entry.question
  ].map((value) => String(value || '').trim()));
}

function buildExternalVectorLookup(payload = {}, family = 'documents', dimension = null) {
  const lookup = new Map();
  let sourceRows = 0;
  let loadedRows = 0;
  let invalidRows = 0;
  for (const entry of vectorEntriesFromPayload(payload, family)) {
    sourceRows += 1;
    const row = asObject(entry);
    const vector = normalizeVector(vectorFromEntry(row), dimension);
    const keys = vectorKeysFromEntry(row);
    if (!vector || !keys.length) {
      invalidRows += 1;
      continue;
    }
    loadedRows += 1;
    for (const key of keys) lookup.set(key.toLowerCase(), vector);
  }
  return {
    lookup,
    sourceRows,
    loadedRows,
    invalidRows
  };
}

function findExternalVector(record = {}, lookup = new Map()) {
  for (const key of record.lookupKeys || []) {
    const vector = lookup.get(String(key).toLowerCase());
    if (vector) return vector;
  }
  return null;
}

async function readJsonMaybe(filePath = '') {
  if (!filePath) return null;
  return readJson(filePath, null);
}

export async function loadScientificEmbeddingInput(filePath = '') {
  const payload = await readJsonMaybe(filePath);
  if (!payload) throw new Error(`Unable to read scientific embedding input: ${filePath}`);
  return payload;
}

export async function loadScientificEmbeddingSource(filePath = '') {
  if (!filePath) return null;
  const absolutePath = path.resolve(process.cwd(), filePath);
  const text = await fs.readFile(absolutePath, 'utf8');
  if (absolutePath.endsWith('.jsonl') || absolutePath.endsWith('.ndjson')) {
    const rows = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    return { contractVersion: 'external-embedding-jsonl-v1', documents: rows };
  }
  return JSON.parse(text);
}

function resolveMethod(options = {}, hasExternalSource = false) {
  if (options.method) return String(options.method);
  if (hasExternalSource) return String(options.model || 'external-scientific-embedding');
  return DETERMINISTIC_SCIENTIFIC_TOKEN_HASH_METHOD;
}

function resolveModel(options = {}, hasExternalSource = false) {
  if (options.model) return String(options.model);
  return hasExternalSource ? 'external-scientific-embedding' : 'deterministic-scientific-token-hash';
}

function releaseGateForScientificEmbeddings(context = {}) {
  if (!context.hasExternalSource) {
    return {
      status: 'incomplete',
      reason: 'deterministic_placeholder_not_release_grade',
      notes: [
        'The deterministic token-hash backend is an offline contract placeholder.',
        'It is useful for artifact plumbing and regression tests, but it is not SPECTER2/SciRepEval release evidence.'
      ]
    };
  }
  const missing = [];
  if (!context.datasetSource) missing.push('dataset_source');
  if (!context.licenseScope) missing.push('license_scope');
  if (!context.model) missing.push('model');
  return {
    status: missing.length ? 'incomplete' : 'ready_for_evaluation',
    reason: missing.length ? `missing_${missing.join('_')}` : 'external_embedding_provenance_present',
    notes: missing.length
      ? [`External embeddings were supplied, but release metadata is incomplete: ${missing.join(', ')}.`]
      : ['External embedding provenance is present. Run SciRepEval/OAG/GraphRAG-style retrieval gates before treating it as release evidence.']
  };
}

function buildVectors(normalized = {}, options = {}) {
  const dimension = normalizeDimension(options.dimension);
  const embeddingSourcePayload = options.embeddingSourcePayload || null;
  const hasExternalSource = Boolean(embeddingSourcePayload);
  const documentLookup = hasExternalSource
    ? buildExternalVectorLookup(embeddingSourcePayload, 'documents', dimension)
    : { lookup: new Map(), sourceRows: 0, loadedRows: 0, invalidRows: 0 };
  const queryLookup = hasExternalSource
    ? buildExternalVectorLookup(embeddingSourcePayload, 'queries', dimension)
    : { lookup: new Map(), sourceRows: 0, loadedRows: 0, invalidRows: 0 };
  const allowDeterministicFallback = options.allowDeterministicFallback !== false;

  const documentVectors = normalized.corpus.map((record) => {
    const external = findExternalVector(record, documentLookup.lookup);
    const vector = external || (allowDeterministicFallback
      ? buildDeterministicScientificEmbedding(record.text, { dimension })
      : null);
    return {
      documentId: record.documentId,
      title: record.title,
      identifiers: record.identifiers,
      embedding: vector,
      vectorSource: external ? 'external' : 'deterministic-token-hash'
    };
  });

  const queryVectors = normalized.queries.map((record) => {
    const external = findExternalVector(record, queryLookup.lookup);
    const vector = external || (allowDeterministicFallback
      ? buildDeterministicScientificEmbedding(record.query, { dimension })
      : null);
    return {
      queryId: record.queryId,
      query: record.query,
      embedding: vector,
      vectorSource: external ? 'external' : 'deterministic-token-hash'
    };
  });

  const missingDocumentVectorCount = documentVectors.filter((entry) => !entry.embedding).length;
  const missingQueryVectorCount = queryVectors.filter((entry) => !entry.embedding).length;
  return {
    dimension,
    hasExternalSource,
    documentVectors,
    queryVectors,
    diagnostics: {
      documentEmbeddingSourceRows: documentLookup.sourceRows,
      documentEmbeddingLoadedRows: documentLookup.loadedRows,
      documentEmbeddingInvalidRows: documentLookup.invalidRows,
      queryEmbeddingSourceRows: queryLookup.sourceRows,
      queryEmbeddingLoadedRows: queryLookup.loadedRows,
      queryEmbeddingInvalidRows: queryLookup.invalidRows,
      missingDocumentVectorCount,
      missingQueryVectorCount,
      deterministicFallbackDocumentCount: documentVectors.filter((entry) => entry.vectorSource === 'deterministic-token-hash').length,
      deterministicFallbackQueryCount: queryVectors.filter((entry) => entry.vectorSource === 'deterministic-token-hash').length
    }
  };
}

function buildDenseRankings(vectorState = {}, options = {}) {
  const topK = normalizeTopK(options.topK);
  const rankingsByQuery = [];
  for (const query of vectorState.queryVectors) {
    const rows = [];
    if (query.embedding) {
      for (const document of vectorState.documentVectors) {
        if (!document.embedding) continue;
        rows.push({
          documentId: document.documentId,
          title: document.title,
          score: cosineSimilarity(query.embedding, document.embedding)
        });
      }
    }
    const rankings = rows
      .sort((left, right) => (
        (right.score - left.score)
        || left.documentId.localeCompare(right.documentId)
      ))
      .slice(0, topK)
      .map((row, index) => ({
        ...row,
        rank: index + 1
      }));
    rankingsByQuery.push({
      queryId: query.queryId,
      query: query.query,
      rankings
    });
  }
  return rankingsByQuery;
}

export function buildScientificEmbeddingArtifacts(options = {}) {
  const input = options.input || options.benchmark || {};
  const normalized = normalizeScientificEmbeddingInput(input);
  const runId = String(options.runId || `scientific-embeddings-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const createdAt = String(options.createdAt || new Date().toISOString());
  const vectorState = buildVectors(normalized, options);
  const hasExternalSource = vectorState.hasExternalSource;
  const method = resolveMethod(options, hasExternalSource);
  const model = resolveModel(options, hasExternalSource);
  const topK = normalizeTopK(options.topK);
  const datasetSource = String(options.datasetSource || options.dataset_source || '').trim();
  const licenseScope = String(options.licenseScope || options.license_scope || '').trim();
  const releaseGate = releaseGateForScientificEmbeddings({
    hasExternalSource,
    datasetSource,
    licenseScope,
    model
  });
  const denseRankings = buildDenseRankings(vectorState, { topK });
  const diagnostics = {
    ...normalized.diagnostics,
    ...vectorState.diagnostics,
    dimension: vectorState.dimension,
    topK,
    normalizedVectors: true,
    denseRankingQueryCount: denseRankings.length,
    denseRankingRowCount: denseRankings.reduce((sum, entry) => sum + entry.rankings.length, 0)
  };

  const denseScores = {
    contractVersion: FIXED_CORPUS_DENSE_SCORES_VERSION,
    generatedBy: SCIENTIFIC_EMBEDDINGS_VERSION,
    runId,
    createdAt,
    method,
    model,
    queries: denseRankings,
    metadata: {
      inputName: normalized.name,
      dimension: vectorState.dimension,
      topK,
      datasetSource: datasetSource || null,
      licenseScope: licenseScope || null,
      releaseGate,
      diagnostics
    }
  };

  const embeddingIndex = {
    contractVersion: SCIENTIFIC_EMBEDDING_INDEX_VERSION,
    generatedBy: SCIENTIFIC_EMBEDDINGS_VERSION,
    runId,
    createdAt,
    method,
    model,
    dimension: vectorState.dimension,
    normalizedVectors: true,
    documents: vectorState.documentVectors,
    queries: vectorState.queryVectors,
    diagnostics
  };

  const manifest = {
    contractVersion: SCIENTIFIC_EMBEDDINGS_MANIFEST_VERSION,
    generatedBy: SCIENTIFIC_EMBEDDINGS_VERSION,
    runId,
    createdAt,
    status: diagnostics.missingDocumentVectorCount || diagnostics.missingQueryVectorCount ? 'incomplete' : 'completed',
    releaseGateStatus: releaseGate.status,
    releaseGate,
    method,
    model,
    dimension: vectorState.dimension,
    topK,
    datasetSource: datasetSource || null,
    licenseScope: licenseScope || null,
    artifacts: {
      denseScoresPath: null,
      embeddingIndexPath: null,
      manifestPath: null
    },
    diagnostics
  };

  return {
    denseScores,
    embeddingIndex,
    manifest
  };
}

export async function prepareScientificEmbeddingArtifacts(options = {}) {
  const inputPath = options.inputPath || options.benchmarkPath || options.datasetPath || '';
  const input = options.input || (inputPath ? await loadScientificEmbeddingInput(inputPath) : {});
  const embeddingSourcePayload = options.embeddingSourcePayload
    || (options.embeddingSourcePath ? await loadScientificEmbeddingSource(options.embeddingSourcePath) : null);
  return buildScientificEmbeddingArtifacts({
    ...options,
    input,
    embeddingSourcePayload
  });
}

export async function writeScientificEmbeddingArtifacts(options = {}) {
  const outputDir = options.outputDir || options.output_path || options.output;
  if (!outputDir) throw new Error('outputDir is required.');
  const artifacts = await prepareScientificEmbeddingArtifacts(options);
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const denseScoresPath = path.join(absoluteOutputDir, 'dense-scores.json');
  const embeddingIndexPath = path.join(absoluteOutputDir, 'embedding-index.json');
  const manifestPath = path.join(absoluteOutputDir, 'manifest.json');
  const inputPath = options.inputPath || options.benchmarkPath || options.datasetPath || '';
  const embeddingSourcePath = options.embeddingSourcePath || '';
  const inputRecords = [];
  if (inputPath) {
    const absoluteInputPath = path.resolve(process.cwd(), inputPath);
    const inputBuffer = await fs.readFile(absoluteInputPath);
    inputRecords.push({
      role: 'scientific_embedding_benchmark',
      path: absoluteInputPath,
      sha256: crypto.createHash('sha256').update(inputBuffer).digest('hex')
    });
  }
  if (embeddingSourcePath) {
    const absoluteEmbeddingSourcePath = path.resolve(process.cwd(), embeddingSourcePath);
    const embeddingSourceBuffer = await fs.readFile(absoluteEmbeddingSourcePath);
    inputRecords.push({
      role: 'scientific_embedding_source',
      path: absoluteEmbeddingSourcePath,
      sha256: crypto.createHash('sha256').update(embeddingSourceBuffer).digest('hex')
    });
  }

  await ensureDir(absoluteOutputDir);
  const manifest = {
    ...artifacts.manifest,
    inputs: inputRecords,
    artifacts: {
      denseScoresPath,
      embeddingIndexPath,
      manifestPath
    }
  };
  await writeJson(denseScoresPath, artifacts.denseScores);
  await writeJson(embeddingIndexPath, artifacts.embeddingIndex);
  await writeJson(manifestPath, manifest);
  return {
    denseScores: artifacts.denseScores,
    embeddingIndex: artifacts.embeddingIndex,
    manifest
  };
}
