import { normalizeArxivId, normalizeDoi } from '../../lib/paper-identifiers.js';
import { assessLimitationRecord, invalidPaperTitleReason } from '../ingestion/source-quality.js';
import { getNodeLayer } from './schema.js';
import { loadKnowledgeGraph } from './graph.js';

export const RESEARCH_QUALITY_VERSION = 'research-quality-v1';
const baseArxiv = (value) => normalizeArxivId(value).replace(/v\d+$/, '');
const array = (value) => Array.isArray(value) ? value : [];

export function assessResearchPaper(node) {
  const p = node.properties || {};
  const reasons = [];
  const titleReason = invalidPaperTitleReason(node.name);
  if (titleReason) reasons.push(titleReason);
  if (['test', 'validation', 'benchmark-fixture'].includes(p.sourcePurpose)) reasons.push('test-source');
  if (/\b(?:controlled PaperNexus import burst|PaperNexus throughput calibration|stress the fast-md|background semantic enrichment with GCD-relevant terminology)\b/i.test(p.abstract || '')) reasons.push('self-declared-test-source');
  const ids = p.identifiers || {};
  const doi = normalizeDoi(ids.doi || p.doi);
  const arxiv = normalizeArxivId(ids.arxivId || p.arxivId);
  if (doi.startsWith('10.48550/papernexus.') && !arxiv && !ids.pmid && !ids.pmcid) reasons.push('internal-identity-needs-source-review');
  return { eligible: reasons.length === 0, reasons, arxiv, doi };
}

// Rebuild a research-only view. Never mutate the authoritative graph, source files or snapshots.
export function buildResearchQualityView(input) {
  const data = typeof input.toJSON === 'function' ? input.toJSON() : input;
  const nodes = data.nodes || [];
  const edges = data.relationships || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const papers = nodes.filter(n => n.type === 'Paper');
  const report = { version: RESEARCH_QUALITY_VERSION, rawPaperCount: papers.length, quarantinedPapers: [], mergedPapers: [], reviewedLimitations: [], identityConflicts: [] };
  const excluded = new Set();
  const assessments = new Map();
  for (const paper of papers) {
    const assessment = assessResearchPaper(paper);
    assessments.set(paper.id, assessment);
    if (!assessment.eligible) {
      excluded.add(paper.id);
      report.quarantinedPapers.push({ id: paper.id, title: paper.name, reasons: assessment.reasons });
    }
  }
  const owners = new Map();
  const own = (id, paperId) => {
    if (!byId.has(id) || byId.get(id).type === 'Paper' || byId.get(id).type === 'Corpus' || byId.get(paperId)?.type !== 'Paper') return;
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(paperId);
  };
  const sourceIds = p => [p?.paperId, p?.sourcePaperId, ...array(p?.paperIds), ...array(p?.sourcePaperIds)].filter(Boolean);
  for (const n of nodes) for (const id of sourceIds(n.properties)) own(n.id, id);
  for (const e of edges) {
    for (const id of sourceIds(e.properties)) { own(e.sourceId, id); own(e.targetId, id); }
    if (byId.get(e.sourceId)?.type === 'Paper') own(e.targetId, e.sourceId);
    if (byId.get(e.targetId)?.type === 'Paper') own(e.sourceId, e.targetId);
  }
  for (const [id, ids] of owners) if ([...ids].every(owner => excluded.has(owner))) excluded.add(id);

  const replacements = new Map();
  const groups = new Map();
  for (const paper of papers.filter(n => !excluded.has(n.id))) {
    const a = assessments.get(paper.id);
    const key = a.arxiv ? `arxiv:${baseArxiv(a.arxiv)}` : a.doi ? `doi:${a.doi}` : '';
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(paper);
  }
  const merged = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const publicDois = new Set(members.map(n => assessments.get(n.id).doi).filter(d => d && !d.startsWith('10.48550/')));
    if (publicDois.size > 1) { report.identityConflicts.push({ key, paperIds: members.map(n => n.id), reason: 'conflicting-public-dois' }); continue; }
    members.sort((a, b) => Number(assessments.get(b.id).arxiv.match(/v(\d+)$/)?.[1] || 0) - Number(assessments.get(a.id).arxiv.match(/v(\d+)$/)?.[1] || 0) || a.id.localeCompare(b.id));
    const representative = members[0];
    for (const member of members) replacements.set(member.id, representative.id);
    merged.set(representative.id, members);
    report.mergedPapers.push({ canonicalId: key, representativeId: representative.id, originalPaperIds: members.map(n => n.id) });
  }
  const retarget = id => replacements.get(id) || id;
  const retyped = new Set();
  const projected = [];
  for (const n of nodes) {
    if (excluded.has(n.id) || retarget(n.id) !== n.id) continue;
    const copy = structuredClone(n);
    const p = copy.properties ||= {};
    if (n.type === 'Limitation') {
      const assessment = assessLimitationRecord({ ...p, name: n.name });
      if (assessment.decision !== 'keep') {
        report.reviewedLimitations.push({ id: n.id, text: assessment.text, decision: assessment.decision, reason: assessment.reason, paperIds: [...(owners.get(n.id) || [])] });
        if (assessment.decision === 'review') { excluded.add(n.id); continue; }
        copy.type = 'Finding'; p.layer = getNodeLayer('Finding'); p.qualityOriginalType = 'Limitation';
        retyped.add(n.id);
      }
    }
    for (const key of ['paperId', 'sourcePaperId']) {
      if (excluded.has(p[key])) {
        p[`qualityExcluded${key[0].toUpperCase()}${key.slice(1)}`] = p[key];
        delete p[key];
        delete p[key === 'paperId' ? 'paperTitle' : 'sourcePaperTitle'];
      }
      if (p[key] && retarget(p[key]) !== p[key]) {
        p[`qualityOriginal${key[0].toUpperCase()}${key.slice(1)}`] = p[key];
        p[key] = retarget(p[key]);
      }
    }
    for (const key of ['paperIds', 'sourcePaperIds']) if (Array.isArray(p[key])) p[key] = [...new Set(p[key].filter(id => !excluded.has(id)).map(retarget))];
    if (merged.has(n.id)) {
      p.canonicalId = report.mergedPapers.find(m => m.representativeId === n.id).canonicalId;
      p.paperVersions = merged.get(n.id).map(member => ({ originalPaperId: member.id, title: member.name, identifiers: member.properties?.identifiers || {}, sourcePath: member.properties?.sourcePath, sourceMarkdownPath: member.properties?.sourceMarkdownPath, sourceId: member.properties?.sourceId }));
      p.identityAliases = [...new Set(merged.get(n.id).flatMap(member => array(member.properties?.identityAliases)))];
    }
    projected.push(copy);
  }
  if (excluded.size || replacements.size || report.reviewedLimitations.length) {
    for (const n of projected.filter(n => n.type === 'Corpus')) {
      for (const key of Object.keys(n.properties || {})) if (/Overlay|Projection|Registry/.test(key)) delete n.properties[key];
    }
  }
  const projectedById = new Map(projected.map(n => [n.id, n]));
  const keptIds = new Set(projectedById.keys());
  const relations = [];
  for (const e of edges) {
    if (!keptIds.has(retarget(e.sourceId)) || !keptIds.has(retarget(e.targetId))) continue;
    const sources = sourceIds(e.properties);
    if (sources.length && sources.every(id => excluded.has(id))) continue;
    const changedType = retyped.has(e.sourceId) || retyped.has(e.targetId);
    if (changedType && !['CONTAINS', 'HAS_LIMITATION', 'SUPPORTED_BY', 'SUPPORTED_BY_SNIPPET', 'MEASURED_BY', 'OBSERVED_ON'].includes(e.type)) continue;
    const copy = structuredClone(e);
    copy.sourceId = retarget(e.sourceId); copy.targetId = retarget(e.targetId);
    copy.properties ||= {};
    if (e.sourceId !== copy.sourceId || e.targetId !== copy.targetId) {
      copy.properties.qualityOriginalEndpoints = { sourceId: e.sourceId, targetId: e.targetId };
    }
    for (const key of ['paperIds', 'sourcePaperIds']) if (Array.isArray(copy.properties[key])) copy.properties[key] = [...new Set(copy.properties[key].filter(id => !excluded.has(id)).map(retarget))];
    for (const key of ['paperId', 'sourcePaperId']) if (copy.properties[key]) {
      if (excluded.has(copy.properties[key])) {
        copy.properties[`qualityExcluded${key[0].toUpperCase()}${key.slice(1)}`] = copy.properties[key];
        delete copy.properties[key];
        delete copy.properties[key === 'paperId' ? 'paperTitle' : 'sourcePaperTitle'];
        continue;
      }
      if (retarget(copy.properties[key]) !== copy.properties[key]) copy.properties[`qualityOriginal${key[0].toUpperCase()}${key.slice(1)}`] = copy.properties[key];
      copy.properties[key] = retarget(copy.properties[key]);
    }
    if (copy.type === 'HAS_LIMITATION' && retyped.has(e.targetId)) copy.type = 'REPORTS_FINDING';
    if (changedType) {
      copy.properties.sourceLayer = getNodeLayer(projectedById.get(copy.sourceId).type);
      copy.properties.targetLayer = getNodeLayer(projectedById.get(copy.targetId).type);
      copy.properties.layerPath = `${copy.properties.sourceLayer}->${copy.properties.targetLayer}`;
      copy.properties.layerScope = copy.properties.sourceLayer === copy.properties.targetLayer ? 'intra-layer' : 'cross-layer';
    }
    relations.push(copy);
  }
  // A detached mechanism from a quarantined source must not remain as a search hit.
  const connected = new Set(relations.flatMap(e => [e.sourceId, e.targetId]));
  const finalNodes = projected.filter(n => n.type === 'Paper' || n.type === 'Corpus' || connected.has(n.id) || !(excluded.size));
  const graph = loadKnowledgeGraph({ nodes: finalNodes, relationships: relations });
  report.paperCount = finalNodes.filter(n => n.type === 'Paper').length;
  report.nodeCount = finalNodes.length;
  report.relationshipCount = relations.length;
  return { graph, report };
}
