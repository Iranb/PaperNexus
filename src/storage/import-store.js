import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCorpusPaths } from './corpus-store.js';
import {
  ensureDir,
  fileExists,
  isMetadataFileName,
  readText,
  readJson,
  withFileLock,
  writeJson
} from '../lib/fs.js';
import { slugify, stableHash } from '../lib/utils.js';

const IMPORT_SCHEMA_VERSION = 1;
const IMPORT_CONTENT_INDEX_SCHEMA_VERSION = 1;
const IMPORT_PROGRESS_CONTRACT_VERSION = 'import-progress-v1';
const IMPORT_QUEUE_PROGRESS_CONTRACT_VERSION = 'import-queue-progress-v1';
const IMPORT_STAGE_TOTAL = 4;
const IMPORT_STAGE_WEIGHTS = {
  queued: { index: 0, startPercent: 0, weight: 0 },
  materialize: { index: 1, startPercent: 0, weight: 50 },
  'llm-optimize': { index: 2, startPercent: 50, weight: 30 },
  'fast-commit': { index: 3, startPercent: 80, weight: 20 },
  completed: { index: 4, startPercent: 100, weight: 0 }
};

function clampPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

function normalizeImportStage(stage, status = '') {
  const normalizedStage = String(stage || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'completed') return 'completed';
  if (IMPORT_STAGE_WEIGHTS[normalizedStage]) return normalizedStage;
  return normalizedStatus === 'running' ? 'materialize' : 'queued';
}

function defaultProgressMessage(stage, status = '') {
  switch (normalizeImportStage(stage, status)) {
    case 'materialize':
      return 'Preparing paper snapshots';
    case 'llm-optimize':
      return 'Running LLM optimization';
    case 'fast-commit':
      return 'Applying graph update';
    case 'completed':
      return 'Import task completed';
    case 'queued':
    default:
      return 'Queued for processing';
  }
}

function computeOverallPercent(stage, stagePercent, status = '') {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedStage = normalizeImportStage(stage, status);
  if (normalizedStatus === 'completed' || normalizedStage === 'completed') return 100;
  const stageMeta = IMPORT_STAGE_WEIGHTS[normalizedStage] || IMPORT_STAGE_WEIGHTS.queued;
  return clampPercent(stageMeta.startPercent + ((clampPercent(stagePercent) / 100) * stageMeta.weight));
}

function createImportProgress(task = {}, overrides = {}) {
  const now = new Date().toISOString();
  const existing = (task.progress && typeof task.progress === 'object' && !Array.isArray(task.progress))
    ? task.progress
    : {};
  const status = String(overrides.status || task.status || existing.status || 'pending').trim().toLowerCase() || 'pending';
  const stage = normalizeImportStage(
    overrides.stage !== undefined ? overrides.stage : (task.stage || existing.stage || 'queued'),
    status
  );
  const stageChanged = stage !== normalizeImportStage(existing.stage, existing.status || status);
  const stagePercent = status === 'completed'
    ? 100
    : clampPercent(
      overrides.stagePercent !== undefined
        ? overrides.stagePercent
        : existing.stagePercent,
      stage === 'queued' ? 0 : 0
    );
  const totalUnits = Math.max(0, Number(
    overrides.totalUnits !== undefined
      ? overrides.totalUnits
      : existing.totalUnits || 0
  ) || 0);
  const processedUnits = Math.max(0, Math.min(
    totalUnits || Number.MAX_SAFE_INTEGER,
    Number(
      overrides.processedUnits !== undefined
        ? overrides.processedUnits
        : existing.processedUnits || 0
    ) || 0
  ));
  const currentStep = String(
    overrides.currentStep !== undefined
      ? overrides.currentStep
      : (existing.currentStep || '')
  ).trim();
  const message = String(
    overrides.message !== undefined
      ? overrides.message
      : (existing.message || defaultProgressMessage(stage, status))
  ).trim() || defaultProgressMessage(stage, status);
  const stageMeta = IMPORT_STAGE_WEIGHTS[stage] || IMPORT_STAGE_WEIGHTS.queued;

  return {
    contractVersion: IMPORT_PROGRESS_CONTRACT_VERSION,
    status,
    stage,
    stageIndex: stageMeta.index,
    stageTotal: IMPORT_STAGE_TOTAL,
    percent: computeOverallPercent(stage, stagePercent, status),
    stagePercent: status === 'completed' ? 100 : stagePercent,
    currentStep,
    processedUnits,
    totalUnits,
    queuePosition: overrides.queuePosition !== undefined ? overrides.queuePosition : (existing.queuePosition ?? null),
    queuedAhead: overrides.queuedAhead !== undefined ? overrides.queuedAhead : (existing.queuedAhead ?? null),
    stageStartedAt: overrides.stageStartedAt || (stageChanged ? now : (existing.stageStartedAt || task.startedAt || now)),
    lastEventAt: overrides.lastEventAt || now,
    message
  };
}

function buildQueueOrderedTasks(queue, tasks = []) {
  const taskById = new Map(tasks.filter(Boolean).map((task) => [task.id, task]));
  return (queue.jobs || []).map((job) => taskById.get(job.id)).filter(Boolean);
}

function decorateTaskWithQueueProgress(task, queueOrderedTasks = []) {
  const activeTasks = queueOrderedTasks.filter((entry) => !['completed', 'failed'].includes(String(entry?.status || '').trim().toLowerCase()));
  const queuePosition = activeTasks.findIndex((entry) => entry.id === task.id);
  return {
    ...task,
    progress: createImportProgress(task, {
      queuePosition: queuePosition === -1 ? null : queuePosition + 1,
      queuedAhead: queuePosition === -1 ? 0 : queuePosition
    })
  };
}

function summarizeImportTasks(tasks = []) {
  const summary = {
    contractVersion: IMPORT_QUEUE_PROGRESS_CONTRACT_VERSION,
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    overallPercent: 0,
    activeTaskId: null,
    activeStage: null
  };
  if (!tasks.length) {
    return summary;
  }

  let totalPercent = 0;
  for (const task of tasks) {
    const status = String(task?.status || '').trim().toLowerCase();
    if (status === 'completed') summary.completed += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'running') summary.running += 1;
    else summary.pending += 1;
    totalPercent += clampPercent(task?.progress?.percent, 0);
    if (!summary.activeTaskId && (status === 'running' || status === 'pending')) {
      summary.activeTaskId = task.id;
      summary.activeStage = String(task?.stage || '').trim() || null;
    }
  }
  summary.remaining = summary.pending + summary.running;
  summary.overallPercent = clampPercent(totalPercent / tasks.length, tasks.every((task) => String(task?.status || '').trim().toLowerCase() === 'completed') ? 100 : 0);
  return summary;
}

function createImportValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createEmptyQueue() {
  return {
    version: IMPORT_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function createEmptyContentIndex() {
  return {
    version: IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    entries: {}
  };
}

function getFileKind(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  throw createImportValidationError(`Unsupported import file "${fileName}". Expected .pdf, .md, or .markdown.`);
}

function sanitizeUploadedFileName(fileName, index = 0) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const baseName = path.basename(String(fileName || ''), extension);
  const normalizedBase = slugify(baseName || `upload-${index + 1}`) || `upload-${index + 1}`;
  return `${normalizedBase}${extension || '.md'}`;
}

function createTaskId(inputPaths = [], files = []) {
  return `imp:${stableHash(`${Date.now()}:${process.pid}:${inputPaths.join('|')}:${files.map((file) => file.name).join('|')}:${Math.random()}`, 18)}`;
}

function createContentFingerprint(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resolveImportFileContent(file = {}) {
  if (Buffer.isBuffer(file.content)) {
    return file.content;
  }

  if (file.content instanceof Uint8Array) {
    return Buffer.from(file.content);
  }

  return Buffer.from(String(file.contentBase64 || ''), 'base64');
}

function createImportFingerprint(rootPath, files = []) {
  const normalizedFiles = files
    .map((file) => ({
      contentFingerprint: file.contentFingerprint,
      kind: file.kind,
      sizeBytes: file.sizeBytes
    }))
    .sort((left, right) => {
      const leftKey = `${left.kind}:${left.contentFingerprint}:${left.sizeBytes}`;
      const rightKey = `${right.kind}:${right.contentFingerprint}:${right.sizeBytes}`;
      return leftKey.localeCompare(rightKey);
    });
  return crypto.createHash('sha256').update(JSON.stringify({
    rootPath: path.resolve(rootPath),
    files: normalizedFiles
  })).digest('hex');
}

export function getImportPaths(rootPath) {
  const { corpusDir } = getCorpusPaths(rootPath);
  const importsDir = path.join(corpusDir, 'imports');
  return {
    importsDir,
    contentIndexPath: path.join(importsDir, 'content-index.json'),
    tasksDir: path.join(importsDir, 'tasks'),
    queuePath: path.join(importsDir, 'queue.json'),
    queueLockPath: path.join(rootPath, '.papernexus-imports.lock'),
    workerLockPath: path.join(rootPath, '.papernexus-import-worker.lock')
  };
}

export function getImportTaskPaths(rootPath, taskId) {
  const { tasksDir } = getImportPaths(rootPath);
  const taskDir = path.join(tasksDir, stableHash(taskId, 20));
  return {
    taskDir,
    taskPath: path.join(taskDir, 'task.json'),
    logPath: path.join(taskDir, 'events.log'),
    sourcesDir: path.join(taskDir, 'sources')
  };
}

export async function loadImportQueue(rootPath) {
  const { queuePath } = getImportPaths(rootPath);
  const queue = (await readJson(queuePath, createEmptyQueue())) || createEmptyQueue();
  return {
    version: queue.version || IMPORT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date(0).toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  };
}

async function saveImportQueue(rootPath, queue) {
  const { queuePath } = getImportPaths(rootPath);
  await writeJson(queuePath, {
    version: IMPORT_SCHEMA_VERSION,
    updatedAt: queue.updatedAt || new Date().toISOString(),
    jobs: Array.isArray(queue.jobs) ? queue.jobs : []
  });
}

async function loadImportContentIndex(rootPath) {
  const { contentIndexPath } = getImportPaths(rootPath);
  const index = (await readJson(contentIndexPath, createEmptyContentIndex())) || createEmptyContentIndex();
  return {
    version: index.version || IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date(0).toISOString(),
    entries: (index.entries && typeof index.entries === 'object' && !Array.isArray(index.entries))
      ? index.entries
      : {}
  };
}

async function saveImportContentIndex(rootPath, index) {
  const { contentIndexPath } = getImportPaths(rootPath);
  await writeJson(contentIndexPath, {
    version: IMPORT_CONTENT_INDEX_SCHEMA_VERSION,
    updatedAt: index.updatedAt || new Date().toISOString(),
    entries: (index.entries && typeof index.entries === 'object' && !Array.isArray(index.entries))
      ? index.entries
      : {}
  });
}

export async function loadImportTask(rootPath, taskId) {
  return readJson(getImportTaskPaths(rootPath, taskId).taskPath, null);
}

async function saveImportTask(rootPath, task) {
  const { taskDir, taskPath } = getImportTaskPaths(rootPath, task.id);
  await ensureDir(taskDir);
  await writeJson(taskPath, task);
}

function updateQueuedJob(queue, task) {
  const index = queue.jobs.findIndex((job) => job.id === task.id);
  const nextJob = {
    id: task.id,
    status: task.status,
    stage: task.stage,
    progress: task.progress || null,
    includeInGraph: Boolean(task.includeInGraph),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt || null,
    trigger: task.trigger || 'api',
    fileCount: Array.isArray(task.files) ? task.files.length : 0,
    inputPaths: Array.isArray(task.inputPaths) ? task.inputPaths : []
  };

  if (index === -1) queue.jobs.push(nextJob);
  else queue.jobs[index] = nextJob;
}

export async function appendImportTaskLog(rootPath, taskId, entry = {}) {
  const { taskDir, logPath } = getImportTaskPaths(rootPath, taskId);
  const timestamp = entry.timestamp || new Date().toISOString();
  const level = String(entry.level || 'info').trim().toLowerCase() || 'info';
  const message = String(entry.message || '').trim() || 'event';
  await ensureDir(taskDir);
  await fs.appendFile(logPath, `[${timestamp}] [${level}] ${message}\n`, 'utf8');
}

export async function loadImportTaskLog(rootPath, taskId) {
  const { logPath } = getImportTaskPaths(rootPath, taskId);
  return (await fileExists(logPath)) ? readText(logPath) : '';
}

async function clearImportFingerprintEntry(rootPath, importFingerprint, taskId = null) {
  if (!importFingerprint) return false;
  const { queueLockPath } = getImportPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const index = await loadImportContentIndex(rootPath);
    const entry = index.entries?.[importFingerprint];
    if (!entry) return false;
    if (taskId && entry.taskId && entry.taskId !== taskId) return false;
    delete index.entries[importFingerprint];
    index.updatedAt = new Date().toISOString();
    await saveImportContentIndex(rootPath, index);
    return true;
  });
}

export async function createImportTask(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  const inputPaths = Array.isArray(options.inputPaths)
    ? options.inputPaths.map((item) => path.resolve(String(item))).filter(Boolean)
    : [];
  const files = Array.isArray(options.files)
    ? options.files.filter((file) => !isMetadataFileName(path.basename(String(file?.name || ''))))
    : [];

  if (!files.length) {
    throw new Error('At least one non-metadata uploaded file is required to create an import task.');
  }

  const normalizedFiles = files.map((file, index) => {
    const originalName = path.basename(String(file.name || '').trim() || `upload-${index + 1}.md`);
    const kind = getFileKind(originalName);
    const content = resolveImportFileContent(file);
    return {
      originalName,
      kind,
      content,
      sizeBytes: content.length,
      mimeType: String(file.mimeType || '').trim() || (kind === 'pdf' ? 'application/pdf' : 'text/markdown'),
      contentFingerprint: createContentFingerprint(content)
    };
  });
  const importFingerprint = createImportFingerprint(rootPath, normalizedFiles);

  return withFileLock(queueLockPath, async () => {
    const [queue, contentIndex] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportContentIndex(rootPath)
    ]);
    const indexedTaskId = contentIndex.entries?.[importFingerprint]?.taskId || null;
    if (indexedTaskId) {
      const existingTask = await loadImportTask(rootPath, indexedTaskId);
      if (existingTask && ['pending', 'running', 'completed'].includes(existingTask.status)) {
        return {
          ...existingTask,
          deduped: true
        };
      }

      delete contentIndex.entries[importFingerprint];
      contentIndex.updatedAt = new Date().toISOString();
      await saveImportContentIndex(rootPath, contentIndex);
    }

    const taskId = createTaskId(inputPaths, normalizedFiles.map((file) => ({ name: file.originalName })));
    const now = new Date().toISOString();
    const { sourcesDir } = getImportTaskPaths(rootPath, taskId);
    await ensureDir(sourcesDir);

    const storedFiles = [];
    const usedNames = new Set();

    for (let index = 0; index < normalizedFiles.length; index += 1) {
      const file = normalizedFiles[index];
      const { originalName, kind } = file;
      let storedName = sanitizeUploadedFileName(originalName, index);
      let suffix = 2;
      while (usedNames.has(storedName)) {
        const extension = path.extname(storedName);
        const base = path.basename(storedName, extension);
        storedName = `${base}-${suffix}${extension}`;
        suffix += 1;
      }
      usedNames.add(storedName);

      const storedPath = path.join(sourcesDir, storedName);
      await fs.writeFile(storedPath, file.content);
      storedFiles.push({
        originalName,
        storedName,
        storedPath,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        kind,
        contentFingerprint: file.contentFingerprint
      });
    }

    const task = {
      id: taskId,
      importFingerprint,
      status: 'pending',
      stage: 'queued',
      includeInGraph: false,
      trigger: String(options.trigger || 'api'),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      inputPaths,
      sourcesDir,
      files: storedFiles,
      result: null,
      error: null
    };
    task.progress = createImportProgress(task, {
      stage: 'queued',
      status: 'pending',
      stagePercent: 0,
      processedUnits: 0,
      totalUnits: 0,
      message: 'Queued for processing'
    });

    await saveImportTask(rootPath, task);
    updateQueuedJob(queue, task);
    queue.updatedAt = now;
    contentIndex.entries[importFingerprint] = {
      taskId,
      updatedAt: now
    };
    contentIndex.updatedAt = now;
    await Promise.all([
      saveImportQueue(rootPath, queue),
      saveImportContentIndex(rootPath, contentIndex)
    ]);
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message: `created import task with ${storedFiles.length} file(s)`
    });

    return {
      ...task,
      deduped: false
    };
  });
}

export async function listImportTasks(rootPath) {
  const queue = await loadImportQueue(rootPath);
  const tasks = await Promise.all(queue.jobs.map((job) => loadImportTask(rootPath, job.id)));
  const rawQueueOrderedTasks = buildQueueOrderedTasks(queue, tasks);
  const queueOrderedTasks = rawQueueOrderedTasks.map((task) => decorateTaskWithQueueProgress(task, rawQueueOrderedTasks));
  const summary = summarizeImportTasks(queueOrderedTasks);
  return {
    updatedAt: queue.updatedAt,
    summary,
    tasks: queueOrderedTasks.sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return rightTime - leftTime;
    })
  };
}

export async function listActiveImportSourceDirs(rootPath) {
  const { tasks } = await listImportTasks(rootPath);
  return tasks
    .filter((task) => task.includeInGraph && task.status === 'running')
    .map((task) => task.sourcesDir);
}

async function updateTaskWithQueue(rootPath, taskId, mutate) {
  const { queueLockPath } = getImportPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const [queue, existingTask] = await Promise.all([
      loadImportQueue(rootPath),
      loadImportTask(rootPath, taskId)
    ]);

    if (!existingTask) {
      return null;
    }

    const nextTask = {
      ...existingTask
    };
    await mutate(nextTask, queue);
    nextTask.updatedAt = new Date().toISOString();
    await saveImportTask(rootPath, nextTask);
    updateQueuedJob(queue, nextTask);
    queue.updatedAt = nextTask.updatedAt;
    await saveImportQueue(rootPath, queue);
    return nextTask;
  });
}

export async function reserveNextImportTask(rootPath) {
  const { queueLockPath } = getImportPaths(rootPath);
  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportQueue(rootPath);
    const jobs = [...queue.jobs].sort((left, right) => {
      const leftRunning = left.status === 'running' ? 0 : 1;
      const rightRunning = right.status === 'running' ? 0 : 1;
      if (leftRunning !== rightRunning) return leftRunning - rightRunning;
      const leftTime = Date.parse(left.updatedAt || left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.updatedAt || right.createdAt || 0) || 0;
      return leftTime - rightTime;
    });
    const candidate = jobs.find((job) => job.status === 'pending' || job.status === 'running');
    if (!candidate) return null;

    const task = await loadImportTask(rootPath, candidate.id);
    if (!task) return null;

    const now = new Date().toISOString();
    task.status = 'running';
    task.stage = task.stage && task.stage !== 'queued' ? task.stage : 'materialize';
    task.includeInGraph = true;
    task.startedAt = task.startedAt || now;
    task.updatedAt = now;
    task.progress = createImportProgress(task, {
      stage: task.stage,
      status: 'running',
      stagePercent: task.stage === 'materialize' ? 0 : task.progress?.stagePercent,
      processedUnits: 0,
      totalUnits: 0,
      stageStartedAt: task.progress?.stage === task.stage ? task.progress?.stageStartedAt : now,
      message: `Running ${task.stage}`
    });
    await saveImportTask(rootPath, task);
    updateQueuedJob(queue, task);
    queue.updatedAt = now;
    await saveImportQueue(rootPath, queue);
    await appendImportTaskLog(rootPath, task.id, {
      level: 'info',
      message: `reserved import task for stage ${task.stage}`
    });

    return {
      task
    };
  });
}

export async function markImportTaskStage(rootPath, taskId, stage, message = '') {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.stage = stage;
    nextTask.status = 'running';
    nextTask.includeInGraph = true;
    nextTask.progress = createImportProgress(nextTask, {
      stage,
      status: 'running',
      stagePercent: 0,
      processedUnits: 0,
      totalUnits: 0,
      stageStartedAt: new Date().toISOString(),
      message: message || defaultProgressMessage(stage, 'running')
    });
  });
  if (!task) return null;
  if (message) {
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message
    });
  }
  return task;
}

export async function updateImportTaskProgress(rootPath, taskId, progress = {}) {
  return updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.progress = createImportProgress(nextTask, progress);
  });
}

export async function completeImportTask(rootPath, taskId, result = null) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.status = 'completed';
    nextTask.stage = 'completed';
    nextTask.includeInGraph = true;
    nextTask.finishedAt = new Date().toISOString();
    nextTask.result = result;
    nextTask.error = null;
    nextTask.progress = createImportProgress(nextTask, {
      stage: 'completed',
      status: 'completed',
      stagePercent: 100,
      percent: 100,
      message: 'Import task completed'
    });
  });
  if (!task) return null;
  await appendImportTaskLog(rootPath, taskId, {
    level: 'info',
    message: 'completed import task'
  });
  return task;
}

export async function failImportTask(rootPath, taskId, error) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.status = 'failed';
    nextTask.includeInGraph = false;
    nextTask.finishedAt = new Date().toISOString();
    nextTask.error = {
      message: String(error?.message || error || 'Import task failed')
    };
    nextTask.progress = createImportProgress(nextTask, {
      status: 'failed',
      message: String(error?.message || error || 'Import task failed')
    });
  });
  if (!task) return null;
  await appendImportTaskLog(rootPath, taskId, {
    level: 'error',
    message: String(error?.message || error || 'Import task failed')
  });
  await clearImportFingerprintEntry(rootPath, task.importFingerprint, task.id);
  return task;
}
