import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildPaperMaterialView } from '../materials/agent-materials.js';
import { loadSourceManifest } from '../../storage/corpus-store.js';
import { decisionError } from './decision-contracts.js';
import { latestRuns } from './decision-store.js';
import { validateComparisons } from './comparison-assessment.js';

export function evidenceKey(ref) {
  return JSON.stringify([ref.evidence_origin, ref.source_id, ref.source_version, ref.locator]);
}

export async function artifactMetadata(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return { path: filePath, exists: stat.isFile(), size: stat.size, mtime_ms: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: filePath, exists: false };
    throw error;
  }
}

export async function inspectEvidence(rootPath, refs) {
  const unique = [...new Map(refs.map(ref => [evidenceKey(ref), ref])).values()];
  return Promise.all(unique.map(async ref => {
    const base = { key: evidenceKey(ref), ref, admitted: false, origin: ref.evidence_origin, source_version: ref.source_version };
    if (ref.evidence_origin === 'paper_reported') {
      const view = await buildPaperMaterialView({ corpus: rootPath, ...(ref.source_key ? { sourceKey: ref.source_key } : { paperId: ref.paper_id || ref.source_id }), chunkLimit: 1 });
      const manifest = await loadSourceManifest(rootPath);
      const selectedKeys = view.paper.selected_source?.source_keys || [];
      const entries = (manifest.sources || []).filter(entry => selectedKeys.includes(entry.sourceKey || entry.source_key || entry.canonicalSourceKey));
      const sourceMetadata = await Promise.all(entries.map(async entry => {
        const sourcePath = entry.sourcePath || entry.source_path || entry.inputPath || entry.input_path;
        return { source_key: entry.sourceKey || entry.source_key || entry.canonicalSourceKey,
          active: entry.activeInGraph !== false && entry.active_in_graph !== false,
          ...(sourcePath ? { artifact: await artifactMetadata(path.resolve(rootPath, sourcePath)) } : {}) };
      }));
      const sourceVersion = selectedKeys.slice().sort().join(',');
      return { ...base, admitted: view.paper.source_admission.eligible && sourceMetadata.some(s => s.active)
          && (selectedKeys.includes(ref.source_version) || sourceVersion === ref.source_version),
        source_version: sourceVersion, quality_version: view.paper.source_admission.version,
        reasons: view.paper.source_admission.reasons, paper_id: view.paper.paper_id, source_metadata: sourceMetadata,
        graph_readiness: view.paper.graph_readiness,
        mechanism_context: view.mechanism_context || null,
        ...(ref.artifact_path ? { extraction_artifact: await artifactMetadata(path.resolve(rootPath, ref.artifact_path)) } : {}),
        verification: 'source_admission_only' };
    }
    if (ref.artifact_path) {
      const artifact = await artifactMetadata(path.resolve(rootPath, ref.artifact_path));
      if (ref.evidence_origin === 'synthetic_fixture' && artifact.exists) {
        const source = JSON.parse(await fs.readFile(artifact.path, 'utf8'));
        return { ...base, admitted: source.source_id === ref.source_id && source.source_version === ref.source_version && source.admitted === true,
          source_version: source.source_version || null, artifact, verification: 'synthetic_fixture' };
      }
      if (ref.evidence_origin === 'code_inspected') {
        let observation;
        if (artifact.exists) {
          try { observation = JSON.parse(await fs.readFile(artifact.path, 'utf8')); } catch { observation = null; }
        }
        const matches = ['repository', 'code_revision', 'file_path', 'observation'].every(k => observation?.[k] === ref[k]);
        return { ...base, admitted: artifact.exists && matches, artifact,
          verification: artifact.exists && matches ? 'code_artifact_present' : 'code_artifact_mismatch',
          boundary: 'Saved code observation only; not independent execution or causal verification.' };
      }
      return { ...base, admitted: artifact.exists && ref.evidence_origin === 'external_measured', artifact,
        verification: artifact.exists ? 'artifact_present' : 'artifact_missing' };
    }
    return { ...base, verification: 'provided_unverified', reasons: [ref.evidence_origin === 'search_absence' ? 'search_absence_is_not_refutation' : 'source_not_verified'] };
  }));
}

export function referenceField(data, locator) {
  return locator.replace(/^\//, '').split(locator.startsWith('/') ? '/' : '.').filter(Boolean)
    .reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], data);
}

export async function inspectComparisonReferences(rootPath, state, action, run, loadEvidence) {
  const references = [];
  for (const comparison of run.comparisons || []) {
    const ref = comparison.reference;
    if (ref.kind === 'run_record') {
      const source = latestRuns(state.runs).find(r => r.record_id === ref.record_id);
      if (!source || source.status !== 'completed') throw decisionError('invalid_reference', `Reference run ${ref.record_id} is not a current completed run`);
      references.push({ comparison_id: comparison.comparison_id, reference: ref, record_id: source.record_id,
        source_revision: source.source_revision, evidence_keys: source.evidence_keys || [], protocol: source.protocol, measurements: source.measurements || [],
        resolved: true, admitted: ['manifest_verified', 'synthetic_fixture'].includes(source.verification?.status) });
      continue;
    }
    const [snapshot] = await loadEvidence([ref.source_ref]);
    let data;
    if (ref.source_ref.artifact_path) {
      try { data = JSON.parse(await fs.readFile(path.resolve(rootPath, ref.source_ref.artifact_path), 'utf8')); }
      catch (error) { throw decisionError('invalid_reference', `Cannot read comparator artifact: ${error.message}`); }
    }
    const protocol = data && referenceField(data, ref.protocol_locator);
    const measurements = data && referenceField(data, ref.measurements_locator);
    const resolved = Boolean(protocol && !Array.isArray(protocol) && typeof protocol === 'object' && Array.isArray(measurements));
    references.push({ comparison_id: comparison.comparison_id, reference: ref, source_version: snapshot.source_version,
      evidence_snapshot: snapshot, protocol: protocol || null, measurements: Array.isArray(measurements) ? measurements : [], resolved,
      admitted: snapshot.admitted && (ref.kind !== 'paper_report' || ref.source_ref.evidence_origin === 'paper_reported') });
  }
  validateComparisons(run, action, references);
  return references;
}

export function changedEvidence(saved, current) {
  return current.filter(item => !isDeepStrictEqual(item, saved.find(prior => prior.key === item.key))).map(item => item.key);
}

export function mergeEvidenceSnapshots(state, current) {
  state.evidence_snapshots = [...new Map([...state.evidence_snapshots, ...current].map(item => [item.key, item])).values()];
}

export async function verifyRunManifest(rootPath, run) {
  if (!run.manifest_path) return { status: run.evidence_origin === 'synthetic_fixture' ? 'synthetic_fixture' : 'provided_unverified', independently_executed: false };
  const filePath = path.resolve(rootPath, run.manifest_path);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { throw decisionError('manifest_unreadable', error.message); }
  const input = manifest.run || manifest;
  const { manifest_path: ignoredPath, ...expected } = run;
  const { manifest_path: ignoredManifestPath, ...actual } = input;
  if (!isDeepStrictEqual(expected, actual)) throw decisionError('manifest_mismatch', 'Inline run differs from the explicit manifest');
  return { status: run.evidence_origin === 'synthetic_fixture' ? 'synthetic_fixture' : 'manifest_verified',
    manifest_path: filePath, independently_executed: false, boundary: 'Manifest contents checked; measurement and statistical review belong to the external executor.' };
}
