import path from 'node:path';
import { createPaperIdentityAliases, paperIdentifiersConflict } from '../../lib/paper-identifiers.js';
import { extractPublicationDateInfo } from '../paper-date.js';

const array = value => Array.isArray(value) ? value : [];
const identity = paper => paper.type === 'Paper' ? { ...paper.properties, title: paper.name } : paper;
const strongAliases = paper => createPaperIdentityAliases(identity(paper)).filter(alias => !alias.startsWith('title:'));
const candidateId = paper => paper.id || paper.canonicalId || paper.title;
const paperDate = paper => extractPublicationDateInfo(paper)?.year || null;
const ranked = (a, b) => Number(b.selectionScore || 0) - Number(a.selectionScore || 0)
  || Number(b.providerAgreementCount || 0) - Number(a.providerAgreementCount || 0)
  || Number(b.citationCount || 0) - Number(a.citationCount || 0)
  || String(candidateId(a)).localeCompare(String(candidateId(b)));

export function matchFieldResearchPaper(candidate, papers, sourcePaths = []) {
  const aliases = new Set(strongAliases(candidate));
  const matches = papers.filter(paper => {
    const record = identity(paper);
    return [record, ...array(record.paperVersions)].some(version => !paperIdentifiersConflict(candidate, version)
      && strongAliases(version).some(alias => aliases.has(alias)));
  });
  if (matches.length) return matches.length === 1 ? matches[0].id : null;
  const paths = new Set(sourcePaths.filter(Boolean).map(value => path.resolve(value)));
  if (!paths.size) return null;
  const sourceMatches = papers.filter(paper => {
    const record = identity(paper);
    if (paperIdentifiersConflict(candidate, record)) return false;
    return [record, ...array(record.paperVersions)].some(version =>
      [version.sourcePath, version.sourceMarkdownPath, version.originalSourcePath].filter(Boolean)
        .some(value => paths.has(path.resolve(value))));
  });
  return sourceMatches.length === 1 ? sourceMatches[0].id : null;
}

export function selectFieldResearchCandidates(candidates, { papers = [], request, phase }) {
  const reviewed = candidates.map(candidate => {
    const year = paperDate(candidate);
    const existingPaperId = matchFieldResearchPaper(candidate, papers);
    const outsideYears = year && ((request.fromYear && year < request.fromYear) || (request.toYear && year > request.toYear));
    return { candidate, year, existingPaperId, decision: outsideYears ? 'outside_year_range'
      : existingPaperId && phase === 'source_resolution' ? 'already_indexed' : 'budget_omitted' };
  });
  const buckets = new Map();
  for (const entry of reviewed.filter(entry => entry.decision === 'budget_omitted')) {
    const decade = entry.year ? Math.floor(entry.year / 10) * 10 : 'undated';
    if (!buckets.has(decade)) buckets.set(decade, []);
    buckets.get(decade).push(entry);
  }
  const orderedBuckets = [...buckets].sort(([a], [b]) => (a === 'undated' ? Infinity : a) - (b === 'undated' ? Infinity : b));
  for (const [, bucket] of orderedBuckets) bucket.sort((a, b) => ranked(a.candidate, b.candidate));
  const limit = phase === 'citation_seeds' ? Math.min(300, request.maxPapers * 3) : request.maxPapers;
  const selected = [];
  for (let index = 0; selected.length < limit; index++) {
    let added = false;
    for (const [, bucket] of orderedBuckets) if (bucket[index] && selected.length < limit) {
      bucket[index].decision = 'selected_temporal_window'; selected.push(bucket[index].candidate); added = true;
    }
    if (!added) break;
  }
  return { candidates: selected, selection: {
    basis: 'decade_round_robin_existing_relevance_order',
    limit, reviewedCount: reviewed.length, selectedCount: selected.length,
    existing: reviewed.filter(entry => entry.decision === 'already_indexed').map(entry => ({
      candidateId: candidateId(entry.candidate), paperId: entry.existingPaperId,
      title: entry.candidate.title, identifiers: entry.candidate.identifiers || {}
    })),
    counts: Object.fromEntries(['selected_temporal_window', 'already_indexed', 'outside_year_range', 'budget_omitted']
      .map(decision => [decision, reviewed.filter(entry => entry.decision === decision).length])),
    reviewed: reviewed.map(({ candidate, year, decision, existingPaperId }) => ({
      candidateId: candidateId(candidate), title: candidate.title, year, identifiers: candidate.identifiers || {},
      providers: candidate.providers || [candidate.provider].filter(Boolean),
      retrievalEvidence: candidate.retrievalEvidence || [], decision, existingPaperId
    }))
  } };
}

export function summarizeFieldResearchImports(importResults, tasks = [], missingTaskIds = []) {
  const issues = (importResults?.results || []).filter(entry => entry.status === 'failed')
    .map(entry => ({ stage: 'import_submission', candidateId: entry.candidateId, message: entry.error || 'Import submission failed.' }));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const expectedIds = [...new Set((importResults?.results || []).map(entry => entry.taskId).filter(Boolean))];
  const missing = [...new Set([...missingTaskIds, ...expectedIds.filter(id => !byId.has(id))])];
  const counts = { total: expectedIds.length, queued: 0, importing: 0, extracting: 0, syncing: 0, ready: 0, failed: 0, unknown: missing.length };
  const readyTaskIds = [];
  const summaries = [];
  for (const id of missing) issues.push({ taskId: id, stage: 'task_lookup', message: 'The submitted import task is missing.' });
  for (const id of expectedIds) {
    const task = byId.get(id);
    if (!task) continue;
    const graph = task.graphVisibilityStatus || task.result?.graphVisibilityStatus || 'unknown';
    const semantic = task.semanticStatus || task.result?.semanticStatus || 'unknown';
    const sync = task.authoritativeSyncStatus || task.result?.authoritativeSync?.status || 'unknown';
    let phase;
    if ([task.status, graph, semantic, sync].some(status => ['failed', 'cancelled', 'blocked', 'superseded'].includes(status))) {
      phase = 'failed'; issues.push({ taskId: id, stage: task.stage || phase, message: task.error?.message || task.error || `Import/evidence state: ${task.status}/${graph}/${semantic}/${sync}` });
    } else if (task.status === 'pending' || task.status === 'queued') phase = 'queued';
    else if (task.status === 'running') phase = task.stage === 'llm-optimize' ? 'extracting' : 'importing';
    else if (task.status !== 'completed' || graph !== 'completed') phase = 'unknown';
    else if (['pending', 'queued', 'running'].includes(semantic)) phase = 'extracting';
    else if (semantic === 'not-required') {
      phase = 'failed'; issues.push({ taskId: id, stage: 'extraction', message: 'This source has only structural processing; relation extraction did not complete.' });
    } else if (semantic !== 'completed') phase = 'unknown';
    else if (['pending', 'queued', 'running', 'not-started'].includes(sync)) phase = 'syncing';
    else if (['completed', 'not-required'].includes(sync)) { phase = 'ready'; readyTaskIds.push(id); }
    else phase = 'unknown';
    counts[phase]++;
    if (phase === 'unknown') issues.push({ taskId: id, stage: task.stage, message: `Unconfirmed import/evidence state: ${task.status}/${graph}/${semantic}/${sync}` });
    summaries.push({ taskId: id, phase, status: task.status, stage: task.stage, graph, semantic, sync,
      message: task.progress?.message || null, percent: task.progress?.percent ?? null });
  }
  const active = counts.queued + counts.importing + counts.extracting + counts.syncing;
  return { counts, readyTaskIds, issues, tasks: summaries,
    terminal: !active && !counts.unknown,
    stage: counts.unknown ? 'needs_attention' : counts.importing || counts.queued ? 'importing'
      : counts.extracting ? 'extracting' : counts.syncing ? 'synchronizing' : 'ready' };
}
