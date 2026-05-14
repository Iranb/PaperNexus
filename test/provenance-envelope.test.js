import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createProvenanceEnvelope,
  validateProvenanceRefs,
  writeProvenanceEnvelope
} from '../src/storage/provenance-store.js';

test('provenance envelope records trace/run links and flags dangling local refs', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-provenance-'));

  try {
    await fs.writeFile(path.join(tempRoot, 'source.md'), '# Source\n', 'utf8');
    const envelope = createProvenanceEnvelope({
      generatedByActivity: 'stage2_llm_semantic_extraction',
      responsibleAgent: 'papernexus-import-worker',
      traceId: 'trace:test',
      runId: 'run:test',
      paperId: 'paper:test',
      usedEntities: [{ path: 'source.md' }],
      sourceSpans: [{ artifactPath: 'missing-span.json', text: 'missing' }],
      outputHash: 'hash:output'
    });
    const written = await writeProvenanceEnvelope(tempRoot, envelope);
    const report = await validateProvenanceRefs(tempRoot, envelope);

    assert.equal(envelope.provenance_version, 'papernexus-prov-v1');
    assert.equal(envelope.trace_id, 'trace:test');
    assert.ok(written.provenancePath.endsWith('.json'));
    assert.equal(report.ok, false);
    assert.equal(report.dangling_ref_count, 1);
    assert.equal(report.checks.some((entry) => entry.path === 'source.md' && entry.status === 'passed'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
