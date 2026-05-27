import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  parseS2orcCitationContexts,
  S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION
} from '../src/core/ingestion/s2orc.js';

const execFileAsync = promisify(execFile);

function sampleS2orcPaper() {
  return {
    paper_id: 's2orc:hybrid-retrieval',
    corpusid: 12345,
    title: 'Hybrid Retrieval With Dense Reranking',
    abstract: [
      {
        text: 'Hybrid retrieval combines sparse ranking with dense retrieval (Karpukhin et al., 2020).',
        section: 'Abstract',
        cite_spans: [
          { start: 61, end: 85, text: 'Karpukhin et al., 2020', ref_id: 'BIBREF1' }
        ]
      }
    ],
    body_text: [
      {
        section: 'Introduction',
        text: 'Neural retrieval builds on earlier ranking functions (Robertson et al., 1995). This motivates hybrid retrieval.',
        cite_spans: [
          { start: 52, end: 75, text: 'Robertson et al., 1995', ref_id: 'BIBREF0' }
        ]
      },
      {
        section: 'Method',
        text: 'Our reranker extends dense passage retrieval (Karpukhin et al., 2020) while retaining BM25 as a component (Robertson et al., 1995).',
        cite_spans: [
          { start: 46, end: 70, text: 'Karpukhin et al., 2020', ref_id: 'BIBREF1' },
          { start: 115, end: 138, text: 'Robertson et al., 1995', ref_id: 'BIBREF0' }
        ]
      }
    ],
    bib_entries: {
      BIBREF0: {
        ref_id: 'BIBREF0',
        title: 'Okapi at TREC',
        authors: [{ first: 'Stephen', last: 'Robertson' }],
        year: 1995,
        ids: { DOI: '10.1145/okapi' },
        raw_text: 'Robertson. Okapi at TREC. 1995.'
      },
      BIBREF1: {
        ref_id: 'BIBREF1',
        title: 'Dense Passage Retrieval for Open-Domain Question Answering',
        authors: [{ first: 'Vladimir', last: 'Karpukhin' }],
        year: 2020,
        ids: { arXiv: '2004.04906' },
        raw_text: 'Karpukhin et al. Dense Passage Retrieval. 2020.'
      }
    }
  };
}

test('S2ORC adapter extracts reference-resolved citation contexts', () => {
  const parsed = parseS2orcCitationContexts(sampleS2orcPaper(), {
    sourcePath: '/tmp/s2orc.json',
    sourceKey: 's2orc-fixture'
  });

  assert.equal(parsed.contractVersion, S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION);
  assert.equal(parsed.citationContextContractVersion, 'papernexus-citation-contexts-v1');
  assert.equal(parsed.papers.length, 1);
  assert.equal(parsed.references.length, 2);
  assert.equal(parsed.contexts.length, 4);
  assert.equal(parsed.diagnostics.paperCount, 1);
  assert.equal(parsed.diagnostics.referenceCount, 2);
  assert.equal(parsed.diagnostics.paragraphCount, 3);
  assert.equal(parsed.diagnostics.mentionCount, 4);
  assert.equal(parsed.diagnostics.unresolvedReferenceCount, 0);
  assert.equal(parsed.contexts.every((entry) => entry.extractionStatus === 'reference-resolved'), true);

  const methodContext = parsed.contexts.find((entry) => entry.sectionRole === 'method' && entry.referenceId === 'BIBREF1');
  assert.ok(methodContext);
  assert.equal(methodContext.sourceProvider, 's2orc');
  assert.equal(methodContext.sourceCorpusId, '12345');
  assert.equal(methodContext.referenceTitleGuess, 'Dense Passage Retrieval for Open-Domain Question Answering');
  assert.equal(methodContext.referenceYear, 2020);
  assert.equal(methodContext.referenceLeadAuthorLastName, 'Karpukhin');
  assert.equal(methodContext.referenceIdentifiers.arxivId, '2004.04906');
  assert.match(methodContext.exactQuote, /extends dense passage retrieval/);
  assert.equal(methodContext.sourceKey, 's2orc-fixture');
});

test('S2ORC adapter reports missing citation references without dropping spans', () => {
  const parsed = parseS2orcCitationContexts({
    paper_id: 'paper:missing-reference',
    title: 'Missing Reference Example',
    body_text: [{
      section: 'Discussion',
      text: 'This claim cites a missing bibliography row (Unknown, 2024).',
      cite_spans: [{ start: 44, end: 57, text: 'Unknown, 2024', ref_id: 'BIBREF99' }]
    }],
    bib_entries: {}
  });

  assert.equal(parsed.references.length, 0);
  assert.equal(parsed.contexts.length, 1);
  assert.equal(parsed.contexts[0].referenceId, 'BIBREF99');
  assert.equal(parsed.contexts[0].extractionStatus, 'reference-missing');
  assert.equal(parsed.diagnostics.unresolvedReferenceCount, 1);
  assert.equal(parsed.diagnostics.warnings.some((entry) => entry.code === 'no_bib_entries'), true);
});

test('S2ORC CLI reads JSONL slices and writes citation-context artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-s2orc-'));
  try {
    const inputPath = path.join(tempRoot, 'slice.jsonl');
    const outputPath = path.join(tempRoot, 'contexts.json');
    const first = sampleS2orcPaper();
    const second = {
      ...sampleS2orcPaper(),
      paper_id: 's2orc:second',
      title: 'Second Paper'
    };
    await fs.writeFile(inputPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-s2orc-citation-contexts.mjs'),
      '--s2orc-path', inputPath,
      '--output-path', outputPath,
      '--source-key', 's2orc-slice',
      '--max-papers', '1'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION);
    assert.equal(summary.paper_count, 1);
    assert.equal(summary.reference_count, 2);
    assert.equal(summary.context_count, 4);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.source.sourcePath, inputPath);
    assert.equal(payload.source.format, 's2orc-jsonl');
    assert.equal(payload.papers.length, 1);
    assert.equal(payload.contexts[0].sourceKey, 's2orc-slice');
    assert.equal(payload.contexts[0].contractVersion, 'papernexus-citation-contexts-v1');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
