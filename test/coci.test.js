import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  COCI_CITATION_GRAPH_CONTRACT_VERSION,
  parseCociCitationGraph
} from '../src/core/ingestion/coci.js';

const execFileAsync = promisify(execFile);

test('COCI adapter parses CSV rows into deduplicated citation graph edges', () => {
  const csv = [
    'oci,citing,cited,creation,timespan,journal_sc,author_sc',
    '02001010806360107050663080702026306630509-02001010806360107050663080303026306630509,https://doi.org/10.1145/1234567,doi:10.5555/7654321,2020-01-02,P2Y,no,yes',
    'duplicate-oci,10.1145/1234567,10.5555/7654321,2020-01-02,P2Y,false,true',
    'second-oci,10.1000/xyz123,10.5555/7654321,2019,P1Y,true,false'
  ].join('\n');

  const parsed = parseCociCitationGraph(csv, {
    sourcePath: '/tmp/coci.csv',
    sourceKey: 'coci-fixture'
  });

  assert.equal(parsed.contractVersion, COCI_CITATION_GRAPH_CONTRACT_VERSION);
  assert.equal(parsed.source.sourceProvider, 'opencitations-coci');
  assert.equal(parsed.diagnostics.inputRecordCount, 3);
  assert.equal(parsed.diagnostics.edgeCount, 2);
  assert.equal(parsed.diagnostics.duplicateEdgeCount, 1);
  assert.equal(parsed.citationEdges.length, 2);

  const edge = parsed.citationEdges.find((entry) => entry.citingDoi === '10.1145/1234567');
  assert.ok(edge);
  assert.equal(edge.citedDoi, '10.5555/7654321');
  assert.equal(edge.journalSelfCitation, false);
  assert.equal(edge.authorSelfCitation, true);
  assert.deepEqual(edge.provenance.sourceRows, [2, 3]);
  assert.equal(edge.provenance.sourceKey, 'coci-fixture');

  assert.equal(parsed.graphProjection.nodes.length, 3);
  assert.equal(parsed.graphProjection.relationships.length, 2);
  assert.equal(parsed.graphProjection.relationships[0].type, 'CITES');
  assert.equal(parsed.graphProjection.relationships.every((relationship) => relationship.properties.licenseScope), true);
});

test('COCI adapter parses TSV and OpenCitations prefixed values', () => {
  const tsv = [
    'oci\tciting_doi\tcited_doi\tjournal_sc',
    'coci => 0101-0202\tcoci => https://doi.org/10.18653/v1/P19-1010\tcoci => doi:10.1145/3366423.3380133\tcoci => yes'
  ].join('\n');

  const parsed = parseCociCitationGraph(tsv, { sourceFormat: 'coci-tsv' });

  assert.equal(parsed.diagnostics.edgeCount, 1);
  assert.equal(parsed.citationEdges[0].oci, '0101-0202');
  assert.equal(parsed.citationEdges[0].citingDoi, '10.18653/v1/p19-1010');
  assert.equal(parsed.citationEdges[0].citedDoi, '10.1145/3366423.3380133');
  assert.equal(parsed.citationEdges[0].journalSelfCitation, true);
});

test('COCI adapter parses JSONL rows and reports missing endpoints', () => {
  const jsonl = [
    JSON.stringify({
      oci: 'valid',
      citing: '10.1000/valid-a',
      cited: '10.1000/valid-b',
      creation: '2021'
    }),
    JSON.stringify({
      oci: 'missing-cited',
      citing: '10.1000/valid-a',
      cited: ''
    })
  ].join('\n');

  const parsed = parseCociCitationGraph(jsonl, { sourceFormat: 'coci-jsonl' });

  assert.equal(parsed.diagnostics.inputRecordCount, 2);
  assert.equal(parsed.diagnostics.edgeCount, 1);
  assert.equal(parsed.diagnostics.missingEndpointCount, 1);
  assert.equal(parsed.diagnostics.warnings.some((entry) => entry.code === 'missing_citation_endpoint'), true);
  assert.equal(parsed.citationEdges[0].creationDate, '2021');
});

test('COCI CLI writes citation graph artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-coci-'));
  try {
    const inputPath = path.join(tempRoot, 'coci.csv');
    const outputPath = path.join(tempRoot, 'citation-graph.json');
    await fs.writeFile(inputPath, [
      'oci,citing,cited,creation',
      'oci-1,10.1000/source-one,10.1000/target-one,2022',
      'oci-2,10.1000/source-two,10.1000/target-one,2023'
    ].join('\n'), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-coci-citation-graph.mjs'),
      '--coci-path', inputPath,
      '--output-path', outputPath,
      '--source-key', 'coci-slice',
      '--max-records', '1'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, COCI_CITATION_GRAPH_CONTRACT_VERSION);
    assert.equal(summary.edge_count, 1);
    assert.equal(summary.graph_relationship_count, 1);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.source.sourcePath, inputPath);
    assert.equal(payload.source.format, 'coci-csv');
    assert.equal(payload.citationEdges[0].provenance.sourceKey, 'coci-slice');
    assert.equal(payload.graphProjection.relationships[0].type, 'CITES');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
