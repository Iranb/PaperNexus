import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PAPERNEXUS_TOOLS } from '../src/mcp/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, 'fixtures', 'mcp-tools-schema.snapshot.json');

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  const normalized = {};
  for (const key of [
    'type',
    'format',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'pattern'
  ]) {
    if (Object.hasOwn(schema, key)) normalized[key] = schema[key];
  }
  if (Object.hasOwn(schema, 'default')) normalized.default = schema.default;
  if (Array.isArray(schema.enum)) normalized.enum = [...schema.enum].sort();
  if (Array.isArray(schema.required)) normalized.required = [...schema.required].sort();
  if (schema.items) normalized.items = normalizeSchema(schema.items);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    normalized.additionalProperties = normalizeSchema(schema.additionalProperties);
  } else if (Object.hasOwn(schema, 'additionalProperties')) {
    normalized.additionalProperties = schema.additionalProperties;
  }
  for (const unionKey of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[unionKey])) {
      normalized[unionKey] = schema[unionKey].map((entry) => normalizeSchema(entry));
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    normalized.properties = {};
    for (const [name, propertySchema] of Object.entries(schema.properties).sort(([a], [b]) => a.localeCompare(b))) {
      normalized.properties[name] = normalizeSchema(propertySchema);
    }
  }
  return normalized;
}

function buildToolSchemaSnapshot(tools = []) {
  return tools
    .map((tool) => ({
      name: tool.name,
      inputSchema: normalizeSchema(tool.inputSchema)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('MCP public tool schemas match the reviewed snapshot', async () => {
  const current = buildToolSchemaSnapshot(PAPERNEXUS_TOOLS);
  const currentText = `${JSON.stringify(current, null, 2)}\n`;

  if (process.env.UPDATE_PAPERNEXUS_MCP_SCHEMA_SNAPSHOT === '1') {
    await fs.writeFile(SNAPSHOT_PATH, currentText, 'utf8');
  }

  const expectedText = await fs.readFile(SNAPSHOT_PATH, 'utf8');
  assert.equal(
    currentText,
    expectedText,
    'MCP tool schema changed. Review docs/interfaces/mcp-skill-contracts.md, then run UPDATE_PAPERNEXUS_MCP_SCHEMA_SNAPSHOT=1 node --test test/mcp-schema-snapshot.test.js if the change is additive/intentional.'
  );
});

test('import_workflow schema exposes fast markdown submit controls', () => {
  const tool = PAPERNEXUS_TOOLS.find((entry) => entry.name === 'import_workflow');
  assert.ok(tool);
  const properties = tool.inputSchema?.properties || {};
  assert.deepEqual(properties.processingProfile?.enum, [
    'full',
    'fast-md-structural',
    'fast-md-background-semantic',
    'long-context-full-md'
  ]);
  assert.deepEqual(properties.completionPolicy?.enum, [
    'full',
    'graph-visible',
    'semantic-complete'
  ]);
  assert.deepEqual(properties.importExecutionMode?.enum, [
    'serial',
    'dag'
  ]);
  assert.equal(properties.llmContextWindowTokens?.type, 'number');
  assert.equal(properties.llmContextWindowTokens?.minimum, 1);
  assert.deepEqual(properties.llmExtractionStrategy?.enum, [
    'long-context-first',
    'chunk-first',
    'auto'
  ]);
  assert.equal(properties.llmLongContextMaxPapersPerCall?.type, 'number');
  assert.equal(properties.llmBatchConcurrency?.type, 'number');
  assert.deepEqual(properties.waitUntil?.enum, [
    'task-completed',
    'graph-visible',
    'semantic-complete',
    'authoritative-sync'
  ]);
  assert.equal(properties.waitForGraphVisibility?.type, 'boolean');
  assert.equal(properties.waitForSemanticCompletion?.type, 'boolean');
});

test('import_workflow schema exposes handler aliases and queue diagnostics', () => {
  const tool = PAPERNEXUS_TOOLS.find((entry) => entry.name === 'import_workflow');
  assert.ok(tool);
  const properties = tool.inputSchema?.properties || {};

  assert.deepEqual(properties.executionMode?.enum, [
    'sync',
    'async',
    'asynchronous',
    'background',
    'queued',
    'queue'
  ]);
  assert.ok(properties.operation?.enum.includes('status_batch'));
  assert.ok(properties.operation?.enum.includes('batch_status'));
  assert.deepEqual(properties.runMode?.enum, properties.executionMode.enum);
  assert.deepEqual(properties.execution_mode?.enum, properties.executionMode.enum);
  assert.equal(properties.asynchronous?.type, 'boolean');

  for (const name of [
    'async_operation',
    'targetOperation',
    'target_operation',
    'job_id',
    'task_id',
    'task_ids',
    'paper_id',
    'server_file_path',
    'arxiv_id',
    'source_provider',
    'processing_profile',
    'importProfile',
    'import_profile',
    'completion_policy',
    'import_execution_mode',
    'importsExecutionMode',
    'imports_execution_mode',
    'llm_context_window_tokens',
    'contextWindowTokens',
    'context_window_tokens',
    'llm_extraction_strategy',
    'llm_long_context_max_papers_per_call',
    'llm_batch_concurrency',
    'batchConcurrency',
    'batch_concurrency',
    'include_semantic_queue',
    'semantic_job_limit',
    'recentSemanticJobLimit',
    'recent_semantic_job_limit',
    'eventTail',
    'event_tail',
    'recentEventLimit',
    'recent_event_limit',
    'dagTail',
    'dag_tail',
    'recentDagEventLimit',
    'recent_dag_event_limit',
    'includeDagComparison',
    'include_dag_comparison',
    'wait_for_authoritative_sync',
    'wait_until',
    'waitTarget',
    'wait_target',
    'wait_for_graph_visibility',
    'wait_for_semantic_completion',
    'wait_timeout_ms',
    'timeout_ms',
    'poll_interval_ms'
  ]) {
    assert.ok(Object.hasOwn(properties, name), `missing import_workflow schema property ${name}`);
  }

  assert.deepEqual(properties.waitTarget?.enum, properties.waitUntil.enum);
  assert.equal(properties.eventTail?.default, 5);
  assert.equal(properties.dagTail?.default, 5);
  assert.equal(properties.includeDagComparison?.type, 'boolean');
  for (const name of ['taskId', 'task_id', 'taskIds', 'task_ids']) {
    const unionTypes = (properties[name]?.oneOf || []).map((entry) => entry.type);
    assert.deepEqual(unionTypes, ['string', 'array']);
    assert.equal(properties[name].oneOf[1].items.type, 'string');
  }
});

test('MCP schemas expose durable async identity and bounded controller controls', () => {
  const importWorkflow = PAPERNEXUS_TOOLS.find((entry) => entry.name === 'import_workflow');
  const agentMaterials = PAPERNEXUS_TOOLS.find((entry) => entry.name === 'agent_materials');
  assert.ok(importWorkflow);
  assert.ok(agentMaterials);

  const importProperties = importWorkflow.inputSchema?.properties || {};
  assert.equal(importProperties.idempotencyKey?.type, 'string');
  assert.equal(importProperties.idempotencyKey?.maxLength, 200);
  for (const name of [
    'idempotency_key',
    'projectId',
    'project_id',
    'workflowRunId',
    'workflow_run_id',
    'selectionRevision',
    'selection_revision'
  ]) {
    assert.ok(Object.hasOwn(importProperties, name), `missing import_workflow schema property ${name}`);
  }

  const materialProperties = agentMaterials.inputSchema?.properties || {};
  assert.equal(materialProperties.maxControllerSteps?.type, 'integer');
  assert.equal(materialProperties.maxControllerSteps?.minimum, 1);
  assert.equal(materialProperties.max_controller_steps?.type, 'integer');
  assert.equal(materialProperties.max_controller_steps?.minimum, 1);
});

test('agent_materials schema exposes ResearchStudio structural innovation controls', () => {
  const tool = PAPERNEXUS_TOOLS.find((entry) => entry.name === 'agent_materials');
  assert.ok(tool);

  const properties = tool.inputSchema?.properties || {};
  assert.ok(properties.operation?.enum.includes('structural_gap_pack'));
  assert.ok(properties.operation?.enum.includes('innovation_pattern_pack'));

  for (const name of [
    'method',
    'methodName',
    'maxDepth',
    'lineageLimit',
    'persistentAssumptionMinPapers',
    'patternLimit',
    'patternCards',
    'candidateMechanism',
    'removedComponents'
  ]) {
    assert.ok(Object.hasOwn(properties, name), `missing agent_materials schema property ${name}`);
  }

  assert.equal(properties.maxDepth.type, 'integer');
  assert.equal(properties.maxDepth.minimum, 1);
  assert.equal(properties.lineageLimit.type, 'integer');
  assert.equal(properties.lineageLimit.minimum, 1);
  assert.equal(properties.persistentAssumptionMinPapers.default, 2);
  assert.equal(properties.patternLimit.default, 2);
  assert.equal(properties.patternCards.items.type, 'object');
  assert.deepEqual(
    properties.removedComponents.oneOf.map((entry) => entry.type),
    ['string', 'array']
  );
});
