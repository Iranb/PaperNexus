import { loadImportTask, loadImportTaskDag } from './import-store.js';

const CONTRACT_VERSION = 'import-dag-comparison-v1';

const GRAPH_VISIBLE_NODES = [
  'task.queued',
  'source.materialize',
  'chunk.normalize',
  'paper.structural_snapshot',
  'paper.delta_build',
  'corpus.merge',
  'lite_state.update',
  'task.completed'
];

const SEMANTIC_NODE_IDS = [
  'paper.long_context_llm',
  'chunk.semantic_llm',
  'chunk.relation_llm'
];

function normalizeDagComparisonStatus(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return fallback;
  return normalized === 'queued' ? 'pending' : normalized;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function taskResultObject(task = {}) {
  return objectOrEmpty(task.result);
}

function getNestedStatus(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function getTaskCurrentStage(task = {}) {
  const progress = objectOrEmpty(task.progress);
  const result = taskResultObject(task);
  return normalizeDagComparisonStatus(getNestedStatus(
    task.stage,
    progress.stage,
    result.stage
  ), '');
}

function isTaskInSemanticLlmStage(task = {}) {
  const stage = getTaskCurrentStage(task);
  return stage === 'llm-optimize' || stage === 'semantic-llm' || stage === 'paper-long-context-llm';
}

function createMismatch(kind, details = {}) {
  return {
    kind,
    ...details
  };
}

function statusMatches(actualStatus, expectedStatuses = []) {
  const actual = normalizeDagComparisonStatus(actualStatus, 'not-started');
  const expected = expectedStatuses.map((status) => normalizeDagComparisonStatus(status, 'not-started'));
  return expected.includes(actual);
}

function expectedSemanticNodeStatuses(task = {}) {
  const result = taskResultObject(task);
  const semanticStatus = normalizeDagComparisonStatus(getNestedStatus(
    task.semanticStatus,
    task.semantic_status,
    result.semanticStatus,
    result.semantic_status
  ), task.status === 'completed' ? 'completed' : 'pending');

  if (semanticStatus === 'not-required') return ['not-required', 'skipped'];
  if (semanticStatus === 'completed') return ['completed'];
  if (semanticStatus === 'failed') return ['failed'];
  if (semanticStatus === 'running' || isTaskInSemanticLlmStage(task)) return ['running', 'completed'];
  return ['pending', 'not-started'];
}

function expectedAuthoritativeSyncStatus(task = {}) {
  const result = taskResultObject(task);
  const authoritativeSync = objectOrEmpty(result.authoritativeSync || result.authoritative_sync);
  return normalizeDagComparisonStatus(getNestedStatus(
    task.authoritativeSyncStatus,
    task.authoritative_sync_status,
    result.authoritativeSyncStatus,
    result.authoritative_sync_status,
    authoritativeSync.status
  ), 'not-started');
}

function summarizeNode(dag = {}, nodeId = '') {
  const node = objectOrEmpty(dag.nodes?.[nodeId]);
  return {
    nodeId,
    status: normalizeDagComparisonStatus(node.status, 'not-started'),
    attempts: Number(node.attempts || 0) || 0,
    retryOwner: node.retryOwner || null,
    idempotencyKey: node.idempotencyKey || null,
    inputArtifactCount: Array.isArray(node.inputArtifacts) ? node.inputArtifacts.length : 0,
    outputArtifactCount: Array.isArray(node.outputArtifacts) ? node.outputArtifacts.length : 0
  };
}

function compareRequiredNodeMetadata(dag = {}, mismatches = []) {
  for (const nodeId of dag.nodeOrder || []) {
    const node = objectOrEmpty(dag.nodes?.[nodeId]);
    if (!node.idempotencyKey) {
      mismatches.push(createMismatch('missing-idempotency-key', { nodeId }));
    }
    if (!node.retryOwner) {
      mismatches.push(createMismatch('missing-retry-owner', { nodeId }));
    }
    if (!objectOrEmpty(node.retryPolicy).owner) {
      mismatches.push(createMismatch('missing-retry-policy-owner', { nodeId }));
    }
    if (!Array.isArray(node.inputArtifacts)) {
      mismatches.push(createMismatch('invalid-input-artifacts', { nodeId }));
    }
    if (!Array.isArray(node.outputArtifacts)) {
      mismatches.push(createMismatch('invalid-output-artifacts', { nodeId }));
    }
    if (!Array.isArray(node.artifacts)) {
      mismatches.push(createMismatch('invalid-artifacts', { nodeId }));
    }
  }
}

function compareGraphVisibleNodes(task = {}, dag = {}, mismatches = []) {
  const graphVisibilityStatus = normalizeDagComparisonStatus(
    task.graphVisibilityStatus || task.graph_visibility_status,
    task.status === 'completed' ? 'completed' : 'pending'
  );
  const nodes = Object.fromEntries(GRAPH_VISIBLE_NODES.map((nodeId) => [nodeId, summarizeNode(dag, nodeId)]));

  if (graphVisibilityStatus === 'completed') {
    for (const nodeId of GRAPH_VISIBLE_NODES) {
      const actualStatus = nodes[nodeId]?.status || 'not-started';
      if (actualStatus !== 'completed') {
        mismatches.push(createMismatch('graph-visible-node-not-completed', {
          nodeId,
          expected: 'completed',
          actual: actualStatus
        }));
      }
    }
  }

  return {
    expectedStatus: graphVisibilityStatus,
    nodes
  };
}

function compareSemanticNodes(task = {}, dag = {}, mismatches = []) {
  const expectedStatuses = expectedSemanticNodeStatuses(task);
  const nodes = Object.fromEntries(SEMANTIC_NODE_IDS.map((nodeId) => [nodeId, summarizeNode(dag, nodeId)]));
  const primaryNode = nodes['paper.long_context_llm'];

  if (!statusMatches(primaryNode.status, expectedStatuses)) {
    mismatches.push(createMismatch('semantic-node-status-mismatch', {
      nodeId: 'paper.long_context_llm',
      expected: expectedStatuses,
      actual: primaryNode.status
    }));
  }

  return {
    expectedStatuses,
    nodes
  };
}

function compareAuthoritativeSyncNodes(task = {}, dag = {}, mismatches = []) {
  const expectedStatus = expectedAuthoritativeSyncStatus(task);
  const enqueueNode = summarizeNode(dag, 'authoritative_sync.enqueue');
  const applyNode = summarizeNode(dag, 'authoritative_sync.apply');

  if (expectedStatus !== 'not-started') {
    if (enqueueNode.status !== 'completed') {
      mismatches.push(createMismatch('authoritative-sync-enqueue-not-completed', {
        nodeId: 'authoritative_sync.enqueue',
        expected: 'completed',
        actual: enqueueNode.status
      }));
    }
    if (!statusMatches(applyNode.status, [expectedStatus])) {
      mismatches.push(createMismatch('authoritative-sync-apply-status-mismatch', {
        nodeId: 'authoritative_sync.apply',
        expected: expectedStatus,
        actual: applyNode.status
      }));
    }
  }

  return {
    expectedStatus,
    nodes: {
      'authoritative_sync.enqueue': enqueueNode,
      'authoritative_sync.apply': applyNode
    }
  };
}

export async function createImportDagComparisonReport(rootPath, taskId) {
  const [task, dag] = await Promise.all([
    loadImportTask(rootPath, taskId),
    loadImportTaskDag(rootPath, taskId)
  ]);
  const mismatches = [];

  if (!task) {
    return {
      contractVersion: CONTRACT_VERSION,
      taskId,
      ok: false,
      mismatches: [createMismatch('missing-task', { taskId })]
    };
  }

  const taskStatus = normalizeDagComparisonStatus(task.status, 'pending');
  const dagStatus = normalizeDagComparisonStatus(dag.status, 'pending');
  if ((taskStatus === 'completed' || taskStatus === 'failed') && taskStatus !== dagStatus) {
    mismatches.push(createMismatch('task-dag-status-mismatch', {
      expected: taskStatus,
      actual: dagStatus
    }));
  }

  compareRequiredNodeMetadata(dag, mismatches);
  const graphVisible = compareGraphVisibleNodes(task, dag, mismatches);
  const semantic = compareSemanticNodes(task, dag, mismatches);
  const authoritativeSync = compareAuthoritativeSyncNodes(task, dag, mismatches);

  return {
    contractVersion: CONTRACT_VERSION,
    taskId: task.id,
    ok: mismatches.length === 0,
    taskStatus,
    dagStatus,
    executionMode: dag.executionMode || 'serial-sidecar',
    processingProfile: task.processingProfile || null,
    completionPolicy: task.completionPolicy || null,
    graphVisible,
    semantic,
    authoritativeSync,
    mismatches
  };
}
