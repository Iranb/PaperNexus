#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';
import {
  normalizeArxivId,
  normalizeDoi,
  normalizeExactPaperTitle,
  normalizePaperIdentifiers
} from '../src/lib/paper-identifiers.js';

const AUDITED_NODE_TYPES = new Set(['paper', 'method', 'dataset', 'task']);

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = 'true';
    }
  }

  const runId = String(options.runId || `graph-identity-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    runId,
    inputPath: options.input || options.graphArtifact || options.graph,
    outputDir: path.resolve(options.outputDir || path.join('.papernexus', 'graph-identity-diagnostics', runId))
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function nodeType(node = {}) {
  return compactText(node.type || node.nodeType || node.kind || asObject(node.properties).type).toLowerCase();
}

function nodeName(node = {}) {
  const properties = asObject(node.properties);
  return compactText(
    node.name
    || node.title
    || node.label
    || properties.name
    || properties.title
    || properties.canonicalName
    || properties.methodName
    || node.id
  );
}

function nodeId(node = {}, index = 0) {
  return compactText(node.id || node.nodeId || node.key || `${nodeType(node) || 'node'}:${index}`);
}

function canonicalKey(node = {}) {
  const properties = asObject(node.properties);
  return compactText(
    node.canonicalId
    || node.canonical_id
    || node.canonicalKey
    || node.canonical_key
    || properties.canonicalId
    || properties.canonical_id
    || properties.canonicalKey
    || properties.canonical_key
  ).toLowerCase();
}

function titleKey(node = {}) {
  const title = normalizeExactPaperTitle(nodeName(node));
  return title ? `title:${title}` : '';
}

function addAlias(aliases, field, value = '') {
  const normalized = compactText(value).toLowerCase();
  if (!normalized) return;
  aliases.push({ field, value: `${field}:${normalized}` });
}

function collectAliases(node = {}) {
  const properties = asObject(node.properties);
  const aliases = [];
  for (const alias of [
    ...asArray(node.aliases),
    ...asArray(node.identityAliases),
    ...asArray(node.canonicalAliases),
    ...asArray(node.methodAliases),
    ...asArray(properties.aliases),
    ...asArray(properties.identityAliases),
    ...asArray(properties.canonicalAliases),
    ...asArray(properties.methodAliases),
    properties.canonicalName,
    properties.methodName,
    node.name,
    node.title
  ]) {
    addAlias(aliases, nodeType(node) === 'method' ? 'method_alias' : 'alias', alias);
  }

  const identifiers = normalizePaperIdentifiers({
    ...asObject(node.identifiers),
    ...asObject(properties.identifiers),
    ...node,
    ...properties
  });
  for (const [field, value] of Object.entries(identifiers)) {
    addAlias(aliases, field, value);
  }

  for (const value of [
    node.doi,
    properties.doi,
    asObject(node.identifiers).doi,
    asObject(properties.identifiers).doi
  ]) {
    const doi = normalizeDoi(value);
    if (doi) addAlias(aliases, 'doi', doi);
  }

  for (const value of [
    node.arxivId,
    node.arxiv,
    properties.arxivId,
    properties.arxiv,
    asObject(node.identifiers).arxivId,
    asObject(properties.identifiers).arxivId
  ]) {
    const arxivId = normalizeArxivId(value);
    if (arxivId) {
      addAlias(aliases, 'arxiv', arxivId);
      addAlias(aliases, 'arxiv_base', arxivId.replace(/v\d+$/i, ''));
    }
  }

  const seen = new Set();
  return aliases.filter((alias) => {
    if (!alias.value || seen.has(alias.value)) return false;
    seen.add(alias.value);
    return true;
  });
}

function collectNodes(payload = {}) {
  return [
    ...asArray(payload.nodes),
    ...asArray(payload.graph?.nodes),
    ...asArray(payload.records).filter((record) => AUDITED_NODE_TYPES.has(nodeType(record)))
  ];
}

function conflictIdentifierFields(nodes = []) {
  const doiValues = new Set();
  const arxivValues = new Set();
  for (const node of nodes) {
    const aliases = collectAliases(node);
    for (const alias of aliases) {
      if (alias.field === 'doi') doiValues.add(alias.value);
      if (alias.field === 'arxiv' || alias.field === 'arxiv_base') arxivValues.add(alias.value);
    }
  }
  return {
    doi: doiValues.size,
    arxiv: arxivValues.size
  };
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return '';
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function renderMarkdown(report = {}) {
  const metrics = report.metrics || {};
  return [
    `# Graph Identity Diagnostics: ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Nodes audited: ${metrics.nodes_total || 0}`,
    `- Duplicate canonical-key groups: ${metrics.duplicate_canonical_key_count || 0}`,
    `- Unresolved alias count: ${metrics.unresolved_alias_count || 0}`,
    `- Title-only merge count: ${metrics.title_only_merge_count || 0}`,
    `- Conflicting identifier count: ${metrics.conflicting_identifier_count || 0}`,
    `- Method alias collision count: ${metrics.method_alias_collision_count || 0}`,
    '',
    '## By Type',
    '',
    '| Type | Nodes | Duplicate canonical groups | Alias collisions | Identifier conflicts |',
    '|---|---:|---:|---:|---:|',
    ...Object.entries(report.byType || {}).map(([type, row]) => (
      `| ${type} | ${row.nodeCount} | ${row.duplicateCanonicalKeyCount} | ${row.aliasCollisionCount} | ${row.conflictingIdentifierCount} |`
    )),
    '',
    '## Artifacts',
    '',
    `- \`${report.artifacts?.reportPath || ''}\``,
    `- \`${report.artifacts?.failuresPath || ''}\``
  ].join('\n');
}

export async function runGraphIdentityDiagnostics(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-identity-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'graph-identity-diagnostics', runId));
  const inputPath = inputOptions.inputPath || inputOptions.input || inputOptions.graphArtifact;
  const payload = inputOptions.graph || (inputPath ? await readJson(inputPath) : null);
  if (!payload) throw new Error('A graph artifact input is required for graph identity diagnostics.');

  const reportPath = path.join(outputDir, 'report.json');
  const reportMarkdownPath = path.join(outputDir, 'report.md');
  const failuresPath = path.join(outputDir, 'failures.jsonl');
  await ensureDir(outputDir);

  const nodes = collectNodes(payload)
    .map((node, index) => ({
      ...node,
      __diagnosticId: nodeId(node, index),
      __diagnosticType: nodeType(node),
      __diagnosticName: nodeName(node),
      __canonicalKey: canonicalKey(node),
      __titleKey: titleKey(node),
      __aliases: collectAliases(node)
    }))
    .filter((node) => AUDITED_NODE_TYPES.has(node.__diagnosticType));

  const canonicalGroups = new Map();
  const titleGroups = new Map();
  const aliasGroups = new Map();
  for (const node of nodes) {
    if (node.__canonicalKey) {
      const group = canonicalGroups.get(node.__canonicalKey) || [];
      group.push(node);
      canonicalGroups.set(node.__canonicalKey, group);
    }
    if (node.__titleKey) {
      const group = titleGroups.get(`${node.__diagnosticType}:${node.__titleKey}`) || [];
      group.push(node);
      titleGroups.set(`${node.__diagnosticType}:${node.__titleKey}`, group);
    }
    for (const alias of node.__aliases) {
      const group = aliasGroups.get(`${node.__diagnosticType}:${alias.value}`) || [];
      group.push({ node, alias });
      aliasGroups.set(`${node.__diagnosticType}:${alias.value}`, group);
    }
  }

  const failures = [];
  const duplicateCanonicalGroups = [...canonicalGroups.entries()].filter(([, group]) => group.length > 1);
  for (const [key, group] of duplicateCanonicalGroups) {
    failures.push({
      failureClass: 'DUPLICATE_CANONICAL_KEY',
      canonicalKey: key,
      nodeIds: group.map((node) => node.__diagnosticId),
      nodeNames: group.map((node) => node.__diagnosticName)
    });
  }

  for (const node of nodes.filter((entry) => !entry.__canonicalKey && entry.__aliases.length === 0)) {
    failures.push({
      failureClass: 'UNRESOLVED_ALIAS',
      nodeId: node.__diagnosticId,
      nodeType: node.__diagnosticType,
      nodeName: node.__diagnosticName
    });
  }

  const titleOnlyGroups = [...titleGroups.entries()].filter(([, group]) => (
    group.length > 1
    && new Set(group.map((node) => node.__canonicalKey).filter(Boolean)).size === 0
  ));
  for (const [title, group] of titleOnlyGroups) {
    failures.push({
      failureClass: 'TITLE_ONLY_MERGE',
      titleKey: title,
      nodeIds: group.map((node) => node.__diagnosticId)
    });
  }

  const aliasCollisionGroups = [...aliasGroups.entries()].filter(([, group]) => (
    new Set(group.map((entry) => entry.node.__canonicalKey || entry.node.__diagnosticId)).size > 1
  ));
  for (const [aliasKey, group] of aliasCollisionGroups) {
    const [type, alias] = aliasKey.split(':', 2);
    failures.push({
      failureClass: type === 'method' ? 'METHOD_ALIAS_COLLISION' : 'ALIAS_COLLISION',
      alias,
      nodeType: type,
      nodeIds: group.map((entry) => entry.node.__diagnosticId),
      canonicalKeys: group.map((entry) => entry.node.__canonicalKey || null)
    });
  }

  const conflictingCanonicalGroups = duplicateCanonicalGroups.filter(([, group]) => {
    const fields = conflictIdentifierFields(group);
    return fields.doi > 1 || fields.arxiv > 1;
  });
  for (const [canonicalKey, group] of conflictingCanonicalGroups) {
    failures.push({
      failureClass: 'CONFLICTING_IDENTIFIER',
      canonicalKey,
      nodeIds: group.map((node) => node.__diagnosticId),
      identifierFieldCounts: conflictIdentifierFields(group)
    });
  }

  const byType = {};
  for (const type of AUDITED_NODE_TYPES) {
    const typeNodes = nodes.filter((node) => node.__diagnosticType === type);
    if (!typeNodes.length) continue;
    const typeCanonicalGroups = duplicateCanonicalGroups.filter(([, group]) => group.some((node) => node.__diagnosticType === type));
    const typeAliasCollisions = aliasCollisionGroups.filter(([key]) => key.startsWith(`${type}:`));
    const typeConflicts = conflictingCanonicalGroups.filter(([, group]) => group.some((node) => node.__diagnosticType === type));
    byType[type] = {
      nodeCount: typeNodes.length,
      duplicateCanonicalKeyCount: typeCanonicalGroups.length,
      aliasCollisionCount: typeAliasCollisions.length,
      conflictingIdentifierCount: typeConflicts.length
    };
  }

  await writeText(failuresPath, failures.map((failure) => JSON.stringify(failure)).join('\n') + (failures.length ? '\n' : ''));

  const metrics = {
    nodes_total: nodes.length,
    duplicate_canonical_key_count: duplicateCanonicalGroups.length,
    duplicate_canonical_node_count: duplicateCanonicalGroups.reduce((sum, [, group]) => sum + group.length, 0),
    unresolved_alias_count: failures.filter((failure) => failure.failureClass === 'UNRESOLVED_ALIAS').length,
    title_only_merge_count: titleOnlyGroups.length,
    conflicting_identifier_count: conflictingCanonicalGroups.length,
    method_alias_collision_count: failures.filter((failure) => failure.failureClass === 'METHOD_ALIAS_COLLISION').length,
    alias_collision_count: aliasCollisionGroups.length,
    high_risk_failure_count: failures.filter((failure) => (
      failure.failureClass === 'DUPLICATE_CANONICAL_KEY'
      || failure.failureClass === 'TITLE_ONLY_MERGE'
      || failure.failureClass === 'CONFLICTING_IDENTIFIER'
      || failure.failureClass === 'METHOD_ALIAS_COLLISION'
    )).length
  };

  const report = {
    runId,
    kind: 'graph-identity-diagnostics',
    status: failures.length ? 'completed_with_findings' : 'completed',
    inputPath: inputPath ? path.resolve(inputPath) : null,
    outputDir,
    metrics,
    byType,
    examples: failures.slice(0, 20),
    artifacts: {
      reportPath,
      reportMarkdownPath,
      failuresPath
    }
  };

  await writeJson(reportPath, report);
  await writeText(reportMarkdownPath, renderMarkdown(report));
  return report;
}

async function main() {
  const report = await runGraphIdentityDiagnostics(parseArgs());
  console.log(JSON.stringify({
    runId: report.runId,
    status: report.status,
    outputDir: report.outputDir,
    metrics: report.metrics
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
