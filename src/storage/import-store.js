import fs from 'node:fs/promises';
import path from 'node:path';
import { getCorpusPaths } from './corpus-store.js';
import { ensureDir, fileExists, readText, readJson, withFileLock, writeJson } from '../lib/fs.js';
import { slugify, stableHash } from '../lib/utils.js';

const IMPORT_SCHEMA_VERSION = 1;

function createEmptyQueue() {
  return {
    version: IMPORT_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    jobs: []
  };
}

function getFileKind(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  throw new Error(`Unsupported import file "${fileName}". Expected .pdf, .md, or .markdown.`);
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

export function getImportPaths(rootPath) {
  const { corpusDir } = getCorpusPaths(rootPath);
  const importsDir = path.join(corpusDir, 'imports');
  return {
    importsDir,
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

export async function createImportTask(rootPath, options = {}) {
  const { queueLockPath } = getImportPaths(rootPath);
  const inputPaths = Array.isArray(options.inputPaths)
    ? options.inputPaths.map((item) => path.resolve(String(item))).filter(Boolean)
    : [];
  const files = Array.isArray(options.files) ? options.files : [];

  if (!files.length) {
    throw new Error('At least one uploaded file is required to create an import task.');
  }

  return withFileLock(queueLockPath, async () => {
    const queue = await loadImportQueue(rootPath);
    const taskId = createTaskId(inputPaths, files);
    const now = new Date().toISOString();
    const { sourcesDir } = getImportTaskPaths(rootPath, taskId);
    await ensureDir(sourcesDir);

    const storedFiles = [];
    const usedNames = new Set();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const originalName = path.basename(String(file.name || '').trim() || `upload-${index + 1}.md`);
      const kind = getFileKind(originalName);
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
      const content = Buffer.from(String(file.contentBase64 || ''), 'base64');
      await fs.writeFile(storedPath, content);
      storedFiles.push({
        originalName,
        storedName,
        storedPath,
        sizeBytes: content.length,
        mimeType: String(file.mimeType || '').trim() || (kind === 'pdf' ? 'application/pdf' : 'text/markdown'),
        kind
      });
    }

    const task = {
      id: taskId,
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

    await saveImportTask(rootPath, task);
    updateQueuedJob(queue, task);
    queue.updatedAt = now;
    await saveImportQueue(rootPath, queue);
    await appendImportTaskLog(rootPath, taskId, {
      level: 'info',
      message: `created import task with ${storedFiles.length} file(s)`
    });

    return task;
  });
}

export async function listImportTasks(rootPath) {
  const queue = await loadImportQueue(rootPath);
  const tasks = await Promise.all(queue.jobs.map((job) => loadImportTask(rootPath, job.id)));
  return {
    updatedAt: queue.updatedAt,
    tasks: tasks.filter(Boolean).sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || 0) || 0;
      return rightTime - leftTime;
    })
  };
}

export async function listActiveImportSourceDirs(rootPath) {
  const { tasks } = await listImportTasks(rootPath);
  return tasks
    .filter((task) => task.includeInGraph && (task.status === 'running' || task.status === 'completed'))
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

export async function completeImportTask(rootPath, taskId, result = null) {
  const task = await updateTaskWithQueue(rootPath, taskId, async (nextTask) => {
    nextTask.status = 'completed';
    nextTask.stage = 'completed';
    nextTask.includeInGraph = true;
    nextTask.finishedAt = new Date().toISOString();
    nextTask.result = result;
    nextTask.error = null;
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
  });
  if (!task) return null;
  await appendImportTaskLog(rootPath, taskId, {
    level: 'error',
    message: String(error?.message || error || 'Import task failed')
  });
  return task;
}
