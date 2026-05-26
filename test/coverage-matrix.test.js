import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { NODE_TYPES } from '../src/core/graph/schema.js';
import { executeAgentMaterialsTool } from '../src/mcp/tool-agent-materials.js';
import { createChunkRecordsForParsedPaper, writePaperChunks } from '../src/storage/chunk-store.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';

function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    }
  };
}

async function createGcdOnlyCorpus() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-coverage-gcd-'));
  const paths = getCorpusPaths(rootPath);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const sourcePath = path.join(rootPath, 'gcd-domain-shift.md');
  const text = [
    '# Domain-Shift GCD Baseline',
    '',
    'A generalized category discovery baseline studies known/novel trade-off under domain shift.',
    'It reports confidence calibration and standard accuracy evaluation.'
  ].join('\n');
  await fs.writeFile(sourcePath, text, 'utf8');

  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:gcd-domain-shift',
    type: NODE_TYPES.PAPER,
    name: 'Domain-Shift GCD Baseline',
    properties: {
      paperId: 'paper:gcd-domain-shift',
      paperTitle: 'Domain-Shift GCD Baseline',
      abstract: 'A generalized category discovery baseline studies known/novel trade-off under domain shift.',
      fieldOfStudy: 'Generalized Category Discovery'
    }
  });
  graph.addNode({
    id: 'domain:gcd',
    type: NODE_TYPES.DOMAIN,
    name: 'Generalized Category Discovery',
    properties: {}
  });

  await fs.writeFile(paths.metaPath, JSON.stringify({
    name: 'coverage-gcd-only-test',
    indexedAt: new Date().toISOString(),
    paperCount: 1,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount
  }, null, 2));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON(), null, 2));
  await saveSourceManifest(rootPath, {
    version: 1,
    corpusName: 'coverage-gcd-only-test',
    rootPath,
    inputPath: rootPath,
    sources: [{
      sourceKey: 'source:gcd-domain-shift',
      sourcePath,
      inputPath: sourcePath,
      kind: 'markdown',
      sourceProvider: 'fixture',
      paperId: 'paper:gcd-domain-shift',
      paperTitle: 'Domain-Shift GCD Baseline',
      activeInGraph: true
    }]
  });
  await writePaperChunks(rootPath, 'source:gcd-domain-shift', createChunkRecordsForParsedPaper({
    sourceKey: 'source:gcd-domain-shift',
    paperId: 'paper:gcd-domain-shift',
    paperTitle: 'Domain-Shift GCD Baseline',
    sections: [{
      id: 'section:abstract',
      heading: 'Abstract',
      role: 'abstract',
      order: 1,
      text,
      chunks: [{ order: 1, text }]
    }]
  }));
  return rootPath;
}

test('coverage_matrix separates committed graph coverage from provider-only key priors', async () => {
  const rootPath = await createGcdOnlyCorpus();
  const fetch = async () => createJsonResponse({
    data: [{
      score: 0.92,
      paper: {
        paperId: 'provider-certified-selective-gcd',
        title: 'Certified Selective GCD with Conformal Risk',
        year: 2026,
        venue: 'Provider Test',
        url: 'https://example.test/certified-selective-gcd',
        externalIds: { DOI: '10.1234/certified-selective-gcd' },
        fieldsOfStudy: ['Computer Science'],
        isOpenAccess: true,
        openAccessPdf: { url: 'https://example.test/certified-selective-gcd.pdf' }
      },
      snippet: {
        text: 'Certified selective prediction for generalized category discovery uses conformal risk control and abstention under label shift.',
        snippetKind: 'abstract',
        section: 'Abstract'
      }
    }]
  });
  try {
    const payload = await executeAgentMaterialsTool({
      operation: 'innovation_evidence_pack',
      corpus: rootPath,
      project: 'CoverageProviderOnly',
      targetDomain: 'Generalized Category Discovery',
      targetProblem: 'certified selective conformal GCD under label shift',
      includeProviderEvidence: true,
      providerEvidenceQueryLimit: 1,
      providerEvidenceLimit: 1
    }, { fetch });

    const gcdRow = payload.coverage_matrix.find((row) => row.area.includes('generalized category discovery'));
    const conformalRow = payload.coverage_matrix.find((row) => row.area.includes('conformal'));
    const selectiveRow = payload.coverage_matrix.find((row) => row.area.includes('selective prediction'));

    assert.ok(gcdRow.materialized_paper_count > 0);
    assert.notEqual(gcdRow.graph_coverage, 'none');
    assert.equal(conformalRow.graph_coverage, 'none');
    assert.equal(selectiveRow.graph_coverage, 'none');
    assert.ok(conformalRow.provider_only_paper_count > 0);
    assert.ok(selectiveRow.provider_only_paper_count > 0);
    assert.ok(conformalRow.provider_only_papers.every((paper) => paper.materialization_status === 'provider_only'));
    assert.ok(payload.provider_to_import_priority.some((entry) => entry.title === 'Certified Selective GCD with Conformal Risk'));
    assert.ok(payload.evidence_sufficiency.reason_codes.includes('provider_only_key_prior'));
    assert.equal(payload.evidence_sufficiency.novelty_claim_allowed, false);
    assert.ok(payload.required_followup.some((entry) => entry.next_tool === 'import_requisition_pack'));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});
