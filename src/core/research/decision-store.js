import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFileLock, writeJson } from '../../lib/fs.js';
import { projectOverlayPaths } from '../materials/project-overlay.js';
import { DECISION_VERSION, decisionError } from './decision-contracts.js';

export function decisionPaths(rootPath, project) {
  const paths = projectOverlayPaths(rootPath, project);
  return { ...paths, statePath: path.join(paths.root, 'research-decision-state.json') };
}

export async function readDecisionState(rootPath, project) {
  let state;
  try { state = JSON.parse(await fs.readFile(decisionPaths(rootPath, project).statePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw decisionError('state_corrupt', `Cannot read decision state: ${error.message}`);
  }
  if (state?.contract_version !== DECISION_VERSION) throw decisionError('unsupported_version', 'Unknown decision state version');
  if (state.project !== project || !Number.isInteger(state.revision) || state.revision < 1 || typeof state.objective !== 'string'
    || !['mechanism_validation', 'performance_validation'].includes(state.goal_phase) || !state.budget || typeof state.budget !== 'object'
    || !['hypotheses', 'predictions', 'actions', 'runs', 'assessments', 'opportunities', 'receipts', 'evidence_snapshots', 'history', 'revisit_events'].every(k => Array.isArray(state[k]))) {
    throw decisionError('state_corrupt', 'Decision state has missing or invalid fields');
  }
  return state;
}

export function emptyDecisionState(project) {
  return { contract_version: DECISION_VERSION, project, revision: 0, hypotheses: [], predictions: [], actions: [], runs: [], assessments: [], opportunities: [], receipts: [], evidence_snapshots: [], history: [], revisit_events: [] };
}

export function requestIdentity(args) {
  const { responseMode, dryRun, corpus, ...identity } = args;
  return identity;
}

export function findRequestReceipt(state, args) {
  const receipt = state?.receipts.find(item => item.request_id === args.requestId);
  if (!receipt) return null;
  if (!isDeepStrictEqual(receipt.request, requestIdentity(args))) throw decisionError('request_conflict', 'requestId already used for different input');
  return { ...receipt.response, current_revision: state.revision, replayed: true };
}

export async function mutateDecisionState(rootPath, args, transform, options = {}) {
  const commit = async () => {
    const previous = await readDecisionState(rootPath, args.project);
    const replay = findRequestReceipt(previous, args);
    if (replay) return replay;
    if (args.operation === 'init' && previous) throw decisionError('already_initialized', 'Project already has decision state');
    if (args.operation !== 'init' && !previous) throw decisionError('not_initialized', 'Initialize this project first');
    const state = structuredClone(previous || emptyDecisionState(args.project));
    if (args.expectedRevision !== undefined && args.expectedRevision !== state.revision) throw decisionError('revision_conflict', `Expected ${args.expectedRevision}; current ${state.revision}`);
    const result = await transform(state);
    const revision = state.revision + 1;
    const response = { revision, result, dry_run: args.dryRun === true };
    if (args.dryRun) return { ...response, revision: state.revision, planned_revision: revision };
    state.revision = revision;
    state.receipts.push({ request_id: args.requestId, request: requestIdentity(args), response, committed_at: new Date().toISOString() });
    await (options.writeState || writeJson)(decisionPaths(rootPath, args.project).statePath, state);
    return response;
  };
  if (args.dryRun) return commit();
  return withFileLock(decisionPaths(rootPath, args.project).lockPath, commit);
}

export function latestVersions(records, idField) {
  const latest = new Map();
  for (const record of records) if (!latest.has(record[idField]) || latest.get(record[idField]).version < record.version) latest.set(record[idField], record);
  return [...latest.values()];
}

export function attemptKey(run) {
  return JSON.stringify([run.executor_id, run.run_id, run.attempt_id]);
}

export function latestRuns(runs) {
  const latest = new Map();
  for (const run of runs) if (!latest.has(attemptKey(run)) || latest.get(attemptKey(run)).source_revision < run.source_revision) latest.set(attemptKey(run), run);
  return [...latest.values()];
}
