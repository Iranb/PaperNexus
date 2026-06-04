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
