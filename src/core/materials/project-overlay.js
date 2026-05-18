import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, readJson, readText, writeJson, writeText, withFileLock } from '../../lib/fs.js';
import { stableHash, slugify, unique } from '../../lib/utils.js';

const OVERLAY_VERSION = 'papernexus-agent-project-overlay-v1';

function nowIso() {
  return new Date().toISOString();
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function normalizeRoles(value) {
  return unique(asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map((entry) => compactText(entry).toLowerCase().replace(/[-\s]+/g, '_'))
    .filter(Boolean));
}

function normalizeStringArray(value) {
  return asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map(compactText)
    .filter(Boolean);
}

function normalizeProject(value) {
  const project = compactText(value);
  if (!project) throw new Error('agent_materials project overlay operations require project.');
  return project;
}

function normalizeTitle(value = '') {
  return compactText(value).toLowerCase();
}

export function projectOverlayPaths(rootPath, projectValue) {
  const project = normalizeProject(projectValue);
  const projectSlug = `${slugify(project)}-${stableHash(project, 8)}`;
  const root = path.join(rootPath, '.papernexus', 'agent-materials', 'projects', projectSlug);
  return {
    project,
    projectSlug,
    root,
    rolesPath: path.join(root, 'roles.jsonl'),
    evidencePath: path.join(root, 'evidence-cart.jsonl'),
    workflowPath: path.join(root, 'workflow-state.json'),
    lockPath: path.join(root, '.overlay.lock')
  };
}

async function appendJsonl(filePath, record) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function readJsonl(filePath) {
  let raw = '';
  try {
    raw = await readText(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL record in ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function roleRecordKey(record = {}) {
  if (record.role_id) return record.role_id;
  const sourceKey = compactText(record.source_key);
  const paperId = compactText(record.paper_id);
  const title = normalizeTitle(record.title);
  const role = compactText(record.role).toLowerCase();
  return `role:${stableHash(`${record.project || ''}:${paperId}:${title}:${sourceKey}:${role}`, 18)}`;
}

function evidenceRecordKey(record = {}) {
  if (record.evidence_id) return record.evidence_id;
  return `evidence:${stableHash([
    record.project || '',
    record.paper_id || '',
    normalizeTitle(record.title),
    record.source_type || '',
    record.source_id || '',
    record.role || '',
    compactText(record.text).slice(0, 300)
  ].join(':'), 18)}`;
}

function reduceRoleEvents(events = []) {
  const roles = new Map();
  for (const event of events) {
    const roleId = roleRecordKey(event);
    if (event.event === 'remove_role') {
      roles.delete(roleId);
      continue;
    }
    if (event.event === 'upsert_role') {
      roles.set(roleId, {
        role_id: roleId,
        project: event.project,
        paper_id: event.paper_id || null,
        title: event.title || null,
        source_key: event.source_key || null,
        role: event.role,
        layer: event.layer || null,
        judgment_type: event.judgment_type || null,
        confidence: event.confidence || null,
        supporting_evidence_ids: event.supporting_evidence_ids || [],
        notes: event.notes || null,
        created_by: event.created_by || null,
        created_at: event.created_at || event.event_at,
        updated_at: event.event_at
      });
    }
  }
  return [...roles.values()].sort((left, right) => String(left.role_id).localeCompare(String(right.role_id)));
}

function reduceEvidenceEvents(events = []) {
  const items = new Map();
  for (const event of events) {
    const evidenceId = evidenceRecordKey(event);
    if (event.event === 'remove_evidence') {
      items.delete(evidenceId);
      continue;
    }
    if (event.event === 'add_evidence') {
      items.set(evidenceId, {
        evidence_id: evidenceId,
        project: event.project,
        item_type: event.item_type || 'snippet',
        role: event.role || null,
        paper_id: event.paper_id || null,
        title: event.title || null,
        source_type: event.source_type || null,
        source_id: event.source_id || null,
        text: event.text || null,
        provenance: event.provenance || [],
        tags: event.tags || [],
        notes: event.notes || null,
        created_by: event.created_by || null,
        created_at: event.event_at
      });
    }
  }
  return [...items.values()].sort((left, right) => String(left.evidence_id).localeCompare(String(right.evidence_id)));
}

function filterRoles(roles = [], args = {}) {
  const roleFilter = new Set(normalizeRoles(args.roles || args.role));
  const paperId = compactText(args.paperId || args.paper_id);
  const title = normalizeTitle(args.paperTitle || args.paper_title || args.title);
  return roles.filter((record) => {
    if (roleFilter.size && !roleFilter.has(record.role)) return false;
    if (paperId && record.paper_id !== paperId) return false;
    if (title && normalizeTitle(record.title) !== title) return false;
    return true;
  });
}

function filterEvidence(items = [], args = {}) {
  const roleFilter = new Set(normalizeRoles(args.roles || args.role));
  const itemType = compactText(args.itemType || args.item_type).toLowerCase();
  const paperId = compactText(args.paperId || args.paper_id);
  return items.filter((record) => {
    if (roleFilter.size && !roleFilter.has(record.role)) return false;
    if (itemType && record.item_type !== itemType) return false;
    if (paperId && record.paper_id !== paperId) return false;
    return true;
  });
}

async function listRoles(paths, args = {}) {
  return filterRoles(reduceRoleEvents(await readJsonl(paths.rolesPath)), args);
}

async function listEvidence(paths, args = {}) {
  return filterEvidence(reduceEvidenceEvents(await readJsonl(paths.evidencePath)), args);
}

function roleEventsFromArgs(args = {}, paths) {
  const roles = normalizeRoles(args.roles || args.role);
  if (!roles.length) throw new Error('paper_role_overlay add/update requires role or roles.');
  return roles.map((role) => ({
    event: 'upsert_role',
    version: OVERLAY_VERSION,
    event_id: `event:${stableHash(`${paths.project}:${role}:${nowIso()}:${Math.random()}`, 20)}`,
    event_at: nowIso(),
    project: paths.project,
    role_id: args.roleId || args.role_id || null,
    paper_id: compactText(args.paperId || args.paper_id) || null,
    title: compactText(args.paperTitle || args.paper_title || args.title) || null,
    source_key: compactText(args.sourceKey || args.source_key) || null,
    role,
    layer: compactText(args.layer) || null,
    judgment_type: compactText(args.judgmentType || args.judgment_type) || null,
    confidence: compactText(args.confidence) || null,
    supporting_evidence_ids: normalizeStringArray(args.supportingEvidenceIds || args.supporting_evidence_ids || args.evidenceId || args.evidence_id),
    notes: compactText(args.notes || args.note) || null,
    created_by: compactText(args.createdBy || args.created_by || args.actor) || null
  })).map((event) => ({
    ...event,
    role_id: event.role_id || roleRecordKey(event)
  }));
}

function removeRoleEventFromArgs(args = {}, paths) {
  const explicitRoleId = compactText(args.roleId || args.role_id);
  const roles = normalizeRoles(args.roles || args.role);
  const paperId = compactText(args.paperId || args.paper_id);
  const title = compactText(args.paperTitle || args.paper_title || args.title);
  const sourceKey = compactText(args.sourceKey || args.source_key);
  if (!explicitRoleId && (!roles.length || (!paperId && !title && !sourceKey))) {
    throw new Error('paper_role_overlay remove requires roleId or paper/source plus role selector.');
  }
  const roleId = explicitRoleId || roleRecordKey({
    project: paths.project,
    paper_id: paperId,
    title,
    source_key: sourceKey,
    role: roles[0]
  });
  return {
    event: 'remove_role',
    version: OVERLAY_VERSION,
    event_id: `event:${stableHash(`${paths.project}:${roleId}:remove:${nowIso()}:${Math.random()}`, 20)}`,
    event_at: nowIso(),
    project: paths.project,
    role_id: roleId
  };
}

function evidenceEventFromArgs(args = {}, paths) {
  const evidence = args.evidence && typeof args.evidence === 'object' ? args.evidence : {};
  const provenance = args.provenance && Array.isArray(args.provenance)
    ? args.provenance
    : asArray(args.provenance).filter((entry) => entry && typeof entry === 'object');
  const event = {
    event: 'add_evidence',
    version: OVERLAY_VERSION,
    event_id: `event:${stableHash(`${paths.project}:evidence:${nowIso()}:${Math.random()}`, 20)}`,
    event_at: nowIso(),
    project: paths.project,
    evidence_id: args.evidenceId || args.evidence_id || evidence.evidenceId || evidence.evidence_id || null,
    item_type: compactText(args.itemType || args.item_type || evidence.itemType || evidence.item_type) || 'snippet',
    role: normalizeRoles(args.roles || args.role || evidence.role)[0] || null,
    paper_id: compactText(args.paperId || args.paper_id || evidence.paperId || evidence.paper_id) || null,
    title: compactText(args.paperTitle || args.paper_title || args.title || evidence.paperTitle || evidence.title) || null,
    source_type: compactText(args.sourceType || args.source_type || evidence.sourceType || evidence.source_type) || null,
    source_id: compactText(args.sourceId || args.source_id || evidence.sourceId || evidence.source_id) || null,
    text: compactText(args.text || evidence.text) || null,
    provenance,
    tags: normalizeStringArray(args.tags || args.tag || evidence.tags),
    notes: compactText(args.notes || args.note || evidence.notes) || null,
    created_by: compactText(args.createdBy || args.created_by || args.actor || evidence.createdBy) || null
  };
  return {
    ...event,
    evidence_id: event.evidence_id || evidenceRecordKey(event)
  };
}

function removeEvidenceEventFromArgs(args = {}, paths) {
  const evidenceId = args.evidenceId || args.evidence_id;
  if (!evidenceId) throw new Error('evidence_cart remove requires evidenceId.');
  return {
    event: 'remove_evidence',
    version: OVERLAY_VERSION,
    event_id: `event:${stableHash(`${paths.project}:${evidenceId}:remove:${nowIso()}:${Math.random()}`, 20)}`,
    event_at: nowIso(),
    project: paths.project,
    evidence_id: evidenceId
  };
}

function normalizeWorkflowStateUpdate(args = {}) {
  const input = args.workflowState && typeof args.workflowState === 'object' ? args.workflowState : {};
  const update = {
    ...input,
    ...(args.hypothesis !== undefined ? { hypothesis: args.hypothesis } : {}),
    ...(args.currentStage !== undefined || args.current_stage !== undefined ? { current_stage: args.currentStage || args.current_stage } : {}),
    ...(args.acceptedDirections !== undefined || args.accepted_directions !== undefined ? { accepted_directions: args.acceptedDirections || args.accepted_directions } : {}),
    ...(args.rejectedDirections !== undefined || args.rejected_directions !== undefined ? { rejected_directions: args.rejectedDirections || args.rejected_directions } : {}),
    ...(args.openQuestions !== undefined || args.open_questions !== undefined ? { open_questions: args.openQuestions || args.open_questions } : {}),
    ...(args.neededMaterials !== undefined || args.needed_materials !== undefined ? { needed_materials: args.neededMaterials || args.needed_materials } : {}),
    ...(args.notes !== undefined || args.note !== undefined ? { notes: args.notes || args.note } : {})
  };
  for (const key of ['accepted_directions', 'rejected_directions', 'open_questions', 'needed_materials']) {
    if (update[key] !== undefined) update[key] = normalizeStringArray(update[key]);
  }
  for (const key of ['hypothesis', 'current_stage', 'notes']) {
    if (update[key] !== undefined) update[key] = compactText(update[key]);
  }
  return update;
}

async function maybeExportEvidence(payload = {}, args = {}) {
  const outputDir = compactText(args.outputDir || args.output_dir);
  if (!outputDir) return payload;
  const resolvedDir = path.resolve(outputDir);
  await ensureDir(resolvedDir);
  const jsonPath = path.join(resolvedDir, 'evidence_cart.json');
  const markdownPath = path.join(resolvedDir, 'evidence_cart.md');
  const lines = [
    '# PaperNexus Evidence Cart',
    '',
    `- Project: ${payload.project || ''}`,
    ''
  ];
  for (const item of payload.items || []) {
    lines.push(`- ${item.title || item.paper_id || item.evidence_id}: ${item.role || item.item_type}`);
    if (item.text) lines.push(`  - ${item.text}`);
  }
  const exportedPayload = {
    ...payload,
    exports: {
      json_path: jsonPath,
      markdown_path: markdownPath
    }
  };
  await writeJson(jsonPath, exportedPayload);
  await writeText(markdownPath, `${lines.join('\n')}\n`);
  return exportedPayload;
}

export async function executePaperRoleOverlay(args = {}, context = {}) {
  const paths = projectOverlayPaths(context.rootPath, args.project);
  const action = compactText(args.action || 'list').toLowerCase();
  const dryRun = Boolean(args.dryRun || args.dry_run);

  if (action === 'list') {
    return {
      operation: 'paper_role_overlay',
      action,
      project: paths.project,
      roles: await listRoles(paths, args),
      overlay_path: paths.root,
      generatedAt: nowIso()
    };
  }

  const events = action === 'remove'
    ? [removeRoleEventFromArgs(args, paths)]
    : roleEventsFromArgs(args, paths);

  if (!['add', 'update', 'remove'].includes(action)) {
    throw new Error(`Unknown paper_role_overlay action: ${args.action || '<missing>'}`);
  }

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      for (const event of events) await appendJsonl(paths.rolesPath, event);
    });
  }

  return {
    operation: 'paper_role_overlay',
    action,
    dry_run: dryRun,
    project: paths.project,
    events,
    roles: dryRun ? filterRoles(reduceRoleEvents(events), args) : await listRoles(paths, args),
    overlay_path: paths.root,
    generatedAt: nowIso()
  };
}

export async function executeEvidenceCart(args = {}, context = {}) {
  const paths = projectOverlayPaths(context.rootPath, args.project);
  const action = compactText(args.action || 'list').toLowerCase();
  const dryRun = Boolean(args.dryRun || args.dry_run);

  if (action === 'list' || action === 'export') {
    const payload = {
      operation: 'evidence_cart',
      action,
      project: paths.project,
      items: await listEvidence(paths, args),
      overlay_path: paths.root,
      generatedAt: nowIso()
    };
    return action === 'export' ? maybeExportEvidence(payload, args) : payload;
  }

  const event = action === 'remove'
    ? removeEvidenceEventFromArgs(args, paths)
    : evidenceEventFromArgs(args, paths);

  if (!['add', 'remove'].includes(action)) {
    throw new Error(`Unknown evidence_cart action: ${args.action || '<missing>'}`);
  }

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await appendJsonl(paths.evidencePath, event);
    });
  }

  return {
    operation: 'evidence_cart',
    action,
    dry_run: dryRun,
    project: paths.project,
    event,
    items: dryRun ? reduceEvidenceEvents([event]) : await listEvidence(paths, args),
    overlay_path: paths.root,
    generatedAt: nowIso()
  };
}

export async function executeWorkflowState(args = {}, context = {}) {
  const paths = projectOverlayPaths(context.rootPath, args.project);
  const action = compactText(args.action || 'get').toLowerCase();
  const dryRun = Boolean(args.dryRun || args.dry_run);
  const existing = await readJson(paths.workflowPath, null);

  if (action === 'get') {
    return {
      operation: 'workflow_state',
      action,
      project: paths.project,
      state: existing || {
        version: OVERLAY_VERSION,
        project: paths.project,
        created_at: null,
        updated_at: null
      },
      overlay_path: paths.root,
      generatedAt: nowIso()
    };
  }

  if (action !== 'update') {
    throw new Error(`Unknown workflow_state action: ${args.action || '<missing>'}`);
  }

  const nextState = {
    version: OVERLAY_VERSION,
    project: paths.project,
    ...(existing || {}),
    ...normalizeWorkflowStateUpdate(args),
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
    updated_by: compactText(args.updatedBy || args.updated_by || args.actor) || existing?.updated_by || null
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.workflowPath, nextState);
    });
  }

  return {
    operation: 'workflow_state',
    action,
    dry_run: dryRun,
    project: paths.project,
    state: nextState,
    overlay_path: paths.root,
    generatedAt: nowIso()
  };
}

export async function loadProjectOverlaySummary(rootPath, projectValue) {
  const project = compactText(projectValue);
  if (!project) {
    return {
      enabled: false,
      roles: [],
      evidence_count: 0,
      workflow_state: null
    };
  }
  const paths = projectOverlayPaths(rootPath, project);
  const [roles, evidence, workflowState] = await Promise.all([
    listRoles(paths),
    listEvidence(paths),
    readJson(paths.workflowPath, null)
  ]);
  return {
    enabled: true,
    version: OVERLAY_VERSION,
    project: paths.project,
    overlay_path: paths.root,
    role_count: roles.length,
    evidence_count: evidence.length,
    roles,
    workflow_state: workflowState
  };
}

export function overlayRolesForPaper(roles = [], paper = {}) {
  const paperId = compactText(paper.paper_id || paper.paperId);
  const title = normalizeTitle(paper.title || paper.paperTitle);
  const sourceKeys = new Set(asArray(paper.sources).map((source) => compactText(source?.source_key || source?.sourceKey)).filter(Boolean));
  return roles.filter((role) => {
    if (paperId && role.paper_id && role.paper_id === paperId) return true;
    if (title && role.title && normalizeTitle(role.title) === title) return true;
    if (sourceKeys.size && role.source_key && sourceKeys.has(role.source_key)) return true;
    return false;
  });
}
