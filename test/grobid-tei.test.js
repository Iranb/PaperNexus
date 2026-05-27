import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION,
  parseGrobidTeiCitationContexts
} from '../src/core/ingestion/grobid-tei.js';

const execFileAsync = promisify(execFile);

function sampleTei() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <body>
      <div type="introduction" xml:id="sec-intro">
        <head>Introduction</head>
        <p xml:id="p1">Neural retrieval builds on earlier ranking functions <ref type="bibr" target="#b0">Robertson et al., 1995</ref>. This motivates hybrid retrieval.</p>
      </div>
      <div type="method" xml:id="sec-method">
        <head>Method</head>
        <p xml:id="p2">Our reranker extends dense passage retrieval <ref type="bibr" target="#b1">Karpukhin et al., 2020</ref> while retaining BM25 as a component <ref type="bibr" target="#b0">Robertson et al., 1995</ref>.</p>
      </div>
    </body>
    <back>
      <listBibl>
        <biblStruct xml:id="b0">
          <analytic>
            <title level="a">Okapi at TREC</title>
            <author><persName><surname>Robertson</surname></persName></author>
          </analytic>
          <monogr><imprint><date when="1995"/></imprint></monogr>
          <idno type="DOI">10.1145/okapi</idno>
        </biblStruct>
        <biblStruct xml:id="b1">
          <analytic>
            <title level="a">Dense Passage Retrieval for Open-Domain Question Answering</title>
            <author><persName><surname>Karpukhin</surname></persName></author>
          </analytic>
          <monogr><imprint><date when="2020-01-01"/></imprint></monogr>
          <idno type="arXiv">2004.04906</idno>
        </biblStruct>
      </listBibl>
    </back>
  </text>
</TEI>`;
}

test('GROBID TEI adapter extracts reference-resolved citation contexts', () => {
  const parsed = parseGrobidTeiCitationContexts(sampleTei(), {
    paperId: 'paper:hybrid-retrieval',
    paperTitle: 'Hybrid Retrieval With Dense Reranking',
    sourceTeiPath: '/tmp/hybrid.tei.xml',
    sourcePdfPath: '/tmp/hybrid.pdf'
  });

  assert.equal(parsed.contractVersion, GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION);
  assert.equal(parsed.references.length, 2);
  assert.equal(parsed.references[0].titleGuess, 'Okapi at TREC');
  assert.equal(parsed.references[0].year, 1995);
  assert.equal(parsed.references[0].leadAuthorLastName, 'Robertson');
  assert.equal(parsed.references[0].identifiers.doi, '10.1145/okapi');
  assert.equal(parsed.references[1].identifiers.arxivId, '2004.04906');

  assert.equal(parsed.contexts.length, 3);
  assert.equal(parsed.diagnostics.referenceCount, 2);
  assert.equal(parsed.diagnostics.sectionCount, 2);
  assert.equal(parsed.diagnostics.paragraphCount, 2);
  assert.equal(parsed.diagnostics.contextCount, 3);
  assert.equal(parsed.diagnostics.unresolvedReferenceCount, 0);
  assert.equal(parsed.contexts.every((entry) => entry.extractionStatus === 'reference-resolved'), true);

  const methodContext = parsed.contexts.find((entry) => entry.referenceId === 'b1');
  assert.ok(methodContext);
  assert.equal(methodContext.sectionRole, 'method');
  assert.equal(methodContext.sectionHeading, 'Method');
  assert.match(methodContext.exactQuote, /extends dense passage retrieval/);
  assert.equal(methodContext.referenceTitleGuess, 'Dense Passage Retrieval for Open-Domain Question Answering');
  assert.equal(methodContext.referenceYear, 2020);
  assert.equal(methodContext.sourceProvider, 'grobid-tei');
  assert.equal(methodContext.sourcePdfPath, '/tmp/hybrid.pdf');
});

test('GROBID TEI adapter reports unresolved references without throwing', () => {
  const parsed = parseGrobidTeiCitationContexts(`
<TEI>
  <text><body>
    <div xml:id="sec"><head>Discussion</head>
      <p xml:id="p">The claim depends on missing prior work <ref type="bibr" target="#missing">[99]</ref>.</p>
    </div>
  </body></text>
</TEI>`, {
    paperId: 'paper:missing'
  });

  assert.equal(parsed.references.length, 0);
  assert.equal(parsed.contexts.length, 1);
  assert.equal(parsed.contexts[0].referenceId, 'missing');
  assert.equal(parsed.contexts[0].extractionStatus, 'reference-missing');
  assert.equal(parsed.diagnostics.unresolvedReferenceCount, 1);
  assert.equal(parsed.diagnostics.warnings.some((entry) => entry.code === 'no_biblstruct_references'), true);
});

test('GROBID TEI CLI writes citation-context JSON artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-grobid-tei-'));
  try {
    const teiPath = path.join(tempRoot, 'paper.tei.xml');
    const outputPath = path.join(tempRoot, 'contexts.json');
    await fs.writeFile(teiPath, sampleTei(), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-grobid-tei-citation-contexts.mjs'),
      '--tei-path', teiPath,
      '--output-path', outputPath,
      '--paper-id', 'paper:cli',
      '--paper-title', 'CLI Paper',
      '--source-pdf-path', '/tmp/cli.pdf'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION);
    assert.equal(summary.reference_count, 2);
    assert.equal(summary.context_count, 3);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.paper.paperId, 'paper:cli');
    assert.equal(payload.contexts[0].paperTitle, 'CLI Paper');
    assert.equal(payload.contexts[0].sourceTeiPath, teiPath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
