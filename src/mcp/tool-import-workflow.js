import path from 'node:path';
import {
  createImportTaskPayload,
  importTaskLogPayload,
  importTaskPayload,
  listImportTasksPayload
} from '../server/api.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePathLeaf(value) {
  return path.basename(String(value || '').trim());
}

function taskMatchesReference(task, args = {}) {
  const paperId = String(args.paperId || args.paper_id || '').trim();
  const sourceLeaf = normalizePathLeaf(args.source);
  const files = Array.isArray(task?.files) ? task.files : [];

  return files.some((fileEntry) => {
    const originalName = normalizePathLeaf(fileEntry?.originalName || fileEntry?.name);
    if (!originalName) return false;
    if (paperId && originalName.includes(paperId)) return true;
    if (sourceLeaf && originalName === sourceLeaf) return true;
    return false;
  });
}

async function resolveTaskId(candidate, args = {}, options = {}) {
  const directTaskId = String(args.taskId || args.task_id || '').trim();
  if (directTaskId) {
    return directTaskId;
  }

  const paperId = String(args.paperId || args.paper_id || '').trim();
  const source = String(args.source || '').trim();
  if (!paperId && !source) {
    return '';
  }

  const listed = await listImportTasksPayload(candidate, options);
  const task = (listed.tasks || []).find((entry) => taskMatchesReference(entry, args));
  return String(task?.id || '').trim();
}

export async function executeImportWorkflowTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation);
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;

  switch (operation) {
    case 'submit':
      return createImportTaskPayload(candidate, {
        trigger: args.trigger || 'mcp',
        serverFilePath: args.serverFilePath || args.server_file_path,
        files: Array.isArray(args.files) ? args.files : undefined
      }, options);
    case 'list': {
      const payload = await listImportTasksPayload(candidate, options);
      const limit = Number(args.limit || 0);
      if (Number.isFinite(limit) && limit > 0) {
        payload.tasks = (payload.tasks || []).slice(0, limit);
      }
      return payload;
    }
    case 'status': {
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow status.');
      }
      return importTaskPayload(candidate, taskId, options);
    }
    case 'log': {
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow log.');
      }
      return importTaskLogPayload(candidate, taskId, options);
    }
    case 'wait': {
      const taskId = await resolveTaskId(candidate, args, options);
      if (!taskId) {
        throw new Error('taskId is required for import_workflow wait.');
      }
      const timeoutSeconds = Number(args.timeout || 1800);
      const intervalSeconds = Number(args.interval || 2);
      const deadline = Date.now() + (Math.max(1, timeoutSeconds) * 1000);

      while (true) {
        const [taskPayload, logPayload] = await Promise.all([
          importTaskPayload(candidate, taskId, options),
          importTaskLogPayload(candidate, taskId, options)
        ]);
        const status = String(taskPayload.task?.status || '').trim().toLowerCase();
        if (status === 'completed' || status === 'failed') {
          return {
            rootPath: taskPayload.rootPath,
            task: taskPayload.task,
            log: logPayload.log || '',
            generatedAt: new Date().toISOString()
          };
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for task ${taskId}. Last status=${taskPayload.task?.status || 'unknown'} stage=${taskPayload.task?.stage || 'unknown'}`
          );
        }
        await sleep(Math.max(0.05, intervalSeconds) * 1000);
      }
    }
    default:
      throw new Error(`Unknown import_workflow operation: ${args.operation || '<missing>'}`);
  }
}
