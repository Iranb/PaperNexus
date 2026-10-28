import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, fileExists } from '../lib/fs.js';
import { getCorpusPaths, loadSourceManifest } from './corpus-store.js';
import { readLineageSource } from '../core/research/lineage-evidence.js';
import { createLiteNodePayload, createLiteRelationshipPayload } from '../core/graph/lite.js';

export function lineagePublicationPath(rootPath) {
  return path.join(getCorpusPaths(rootPath).corpusDir, 'lineage-publications.json');
}

export async function hasLineagePublications(rootPath) {
  return fileExists(lineagePublicationPath(rootPath));
}

export async function checkLineageBindings(rootPath, bindings, graph, sources, cache = new Map()) {
  const issues = [];
  for (const binding of bindings) {
    const key = JSON.stringify([binding.paperId, binding.sourceKey]);
    if (!cache.has(key)) {
      try { cache.set(key, await readLineageSource(rootPath, binding, { graph, sources })); }
      catch (error) { cache.set(key, { error: error.message }); }
    }
    const current = cache.get(key);
    const identityChanged = !current.error && (current.title !== binding.title || !isDeepStrictEqual(current.identifiers, binding.identifiers));
    if (current.error || current.sourceVersion !== binding.sourceVersion || identityChanged) issues.push({ paperId: binding.paperId,
      sourceKey: binding.sourceKey, reason: current.error || (identityChanged ? 'source_identity_changed' : 'source_version_changed') });
  }
  return issues;
}

function effectCurrent(graph, effect) {
  return effect.entity === 'node' ? graph.getNode(effect.after.id) : graph.getRelationship(effect.after.id);
}

function effectMatches(value, expected, lite = false) {
  if (isDeepStrictEqual(value || null, expected || null)) return true;
  if (!lite || !value || !expected) return false;
  return isDeepStrictEqual(value, expected.sourceId ? createLiteRelationshipPayload(expected) : createLiteNodePayload(expected));
}

function writeEffect(graph, entity, value) {
  if (entity === 'node') graph.updateNode(structuredClone(value));
  else graph.updateRelationship(structuredClone(value));
}

export async function projectLineagePublications(rootPath, graph, ledger = null, options = {}) {
  const publications = ledger || await readJson(lineagePublicationPath(rootPath));
  if (!publications) return { graph, publications: [] };
  const sources = (await loadSourceManifest(rootPath))?.sources || [];
  const cache = new Map(), results = [], cleanup = [];
  const matches = (value, expected) => effectMatches(value, expected, options.lite === true);
  for (const publication of publications.records || []) {
    for (const item of publication.items) {
      const issues = await checkLineageBindings(rootPath, item.bindings, graph, sources, cache);
      const inactive = publication.status === 'revoked' || issues.length > 0;
      if (inactive) {
        let conflict = false;
        for (const effect of [...item.effects].reverse()) {
          const current = effectCurrent(graph, effect);
          if (effect.entity === 'node') { cleanup.push(effect); continue; }
          if (matches(current, effect.after) || (issues.length && effect.before && matches(current, effect.before))) {
            if (!issues.length && effect.before) writeEffect(graph, effect.entity, effect.before);
            else graph.removeRelationship(effect.after.id);
          } else if (current && !matches(current, effect.before)) {
            conflict = true;
            if (current.properties?.lineagePublicationId === publication.publicationId) {
              graph.updateRelationship({ ...current, properties: { ...current.properties, validationStatus: 'candidate',
                lineagePublicationIssue: issues.length ? 'source_requires_review' : 'revoked_with_edit_conflict' } });
            }
          }
        }
        results.push({ publicationId: publication.publicationId, candidateIndex: item.candidateIndex,
          status: issues.length ? 'stale' : conflict ? 'revoke_conflict' : 'revoked', issues });
        continue;
      }
      const conflicts = item.effects.filter(effect => {
        const current = effectCurrent(graph, effect);
        return current && !matches(current, effect.before) && !matches(current, effect.after);
      });
      if (conflicts.length) {
        results.push({ publicationId: publication.publicationId, candidateIndex: item.candidateIndex,
          status: 'conflict', entityIds: conflicts.map(effect => effect.after.id) });
        continue;
      }
      for (const effect of item.effects) writeEffect(graph, effect.entity, effect.after);
      results.push({ publicationId: publication.publicationId, candidateIndex: item.candidateIndex, status: 'active' });
    }
  }
  for (const effect of cleanup) {
    const current = graph.getNode(effect.after.id);
    if (!matches(current, effect.after)) continue;
    if (effect.before) graph.updateNode(structuredClone(effect.before));
    else if (!graph.getOutgoing(current.id).length && !graph.getIncoming(current.id).length) graph.removeNode(current.id);
  }
  return { graph, publications: results };
}
