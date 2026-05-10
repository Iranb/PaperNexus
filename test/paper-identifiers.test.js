import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPaperIdentity,
  createSourceIdentity,
  mergePaperIdentifiers,
  normalizePaperIdentifierQuery,
  normalizePaperIdentifiers,
  paperIdentifiersConflict,
  paperIdentifiersOverlap,
  paperStrongIdentityOverlap
} from '../src/lib/paper-identifiers.js';

test('paper identifier helpers normalize exact identifiers and detect overlap/conflict', () => {
  const normalized = normalizePaperIdentifiers({
    doi: 'https://doi.org/10.48550/ARXIV.2401.12345',
    arxivId: 'arXiv:2401.12345v2',
    pmid: 'PMID: 12345678',
    pmcid: 'pmc1234567',
    isbn: '978-1-4028-9462-6',
    issn: '2049-3630'
  });

  assert.deepEqual(normalized, {
    doi: '10.48550/arxiv.2401.12345',
    arxivId: '2401.12345v2',
    pmid: '12345678',
    pmcid: 'PMC1234567',
    isbn: '9781402894626',
    issn: '20493630'
  });
  assert.equal(paperIdentifiersOverlap(
    { doi: '10.48550/arxiv.2401.12345' },
    { doi: 'https://doi.org/10.48550/ARXIV.2401.12345' }
  ), true);
  assert.equal(paperIdentifiersConflict(
    { doi: '10.48550/arxiv.2401.12345' },
    { doi: '10.48550/arxiv.2401.99999' }
  ), true);
  assert.equal(paperStrongIdentityOverlap(
    { doi: '10.48550/arxiv.2401.12345', arxivId: '2401.12345' },
    { doi: 'https://doi.org/10.48550/ARXIV.2401.12345' }
  ), true);
});

test('paper identifier helpers merge and infer generic queries', () => {
  const merged = mergePaperIdentifiers(
    { doi: '10.48550/arxiv.2401.12345' },
    { arxivId: '2401.12345' }
  );
  assert.equal(merged.identifiers.doi, '10.48550/arxiv.2401.12345');
  assert.equal(merged.identifiers.arxivId, '2401.12345');

  const query = normalizePaperIdentifierQuery({
    identifier: 'https://doi.org/10.48550/ARXIV.2401.12345'
  });
  assert.deepEqual(query, {
    doi: '10.48550/arxiv.2401.12345',
    arxivId: '2401.12345'
  });

  assert.deepEqual(normalizePaperIdentifierQuery({
    identifier: 'PMID: 12345678'
  }), {
    pmid: '12345678'
  });

  assert.deepEqual(normalizePaperIdentifierQuery({
    identifier: '2049-3630'
  }), {
    issn: '20493630'
  });
});

test('paper identifier helpers reject invalid or DOI-derived arxiv fragments', () => {
  const invalidArxivFragment = normalizePaperIdentifiers({
    doi: '10.1109/example.2023.00732',
    arxivId: '2023.00732'
  });
  assert.deepEqual(invalidArxivFragment, {
    doi: '10.1109/example.2023.00732'
  });

  const suspiciousMerged = mergePaperIdentifiers(
    { doi: '10.1234/example.2010.10127' },
    { arxivId: '2010.10127' }
  );
  assert.deepEqual(suspiciousMerged.identifiers, {
    doi: '10.1234/example.2010.10127'
  });

  const suspiciousPaperIdentity = createPaperIdentity({
    doi: '10.1234/example.2010.10127',
    arxivId: '2010.10127'
  });
  assert.equal(suspiciousPaperIdentity.canonicalId, 'doi:10.1234/example.2010.10127');
  assert.equal(suspiciousPaperIdentity.canonicalIdSource, 'doi');

  const invalidQuery = normalizePaperIdentifierQuery({
    identifier: '2023.00732'
  });
  assert.deepEqual(invalidQuery, {});
});

test('paper identifier helpers preserve legitimate arxiv identifiers alongside doi', () => {
  const explicitPair = normalizePaperIdentifiers({
    doi: '10.1038/s41586-020-2649-2',
    arxivId: '2010.10127'
  });
  assert.deepEqual(explicitPair, {
    doi: '10.1038/s41586-020-2649-2',
    arxivId: '2010.10127'
  });

  const arxivDoiPair = normalizePaperIdentifiers({
    doi: '10.48550/arXiv.2410.11206',
    arxivId: 'arXiv:2410.11206v2'
  });
  assert.deepEqual(arxivDoiPair, {
    doi: '10.48550/arxiv.2410.11206',
    arxivId: '2410.11206v2'
  });

  assert.deepEqual(normalizePaperIdentifiers({
    doi: '10.48550/arXiv.2410.11206'
  }), {
    doi: '10.48550/arxiv.2410.11206',
    arxivId: '2410.11206'
  });
});

test('paper identity helpers derive canonicalId and sourceId separately', () => {
  const paperIdentity = createPaperIdentity({
    title: 'Theoretical Analysis of FixMatch-like Semi-Supervised Learning',
    arxivId: '2410.11206',
    doi: '10.48550/arXiv.2410.11206'
  });
  assert.equal(paperIdentity.canonicalId, 'arxiv:2410.11206');
  assert.equal(paperIdentity.canonicalIdSource, 'arxivId');
  assert.equal(paperIdentity.identityConfidence, 'strong');
  assert.ok(paperIdentity.identityAliases.includes('doi:10.48550/arxiv.2410.11206'));

  const sourceIdentity = createSourceIdentity({
    ...paperIdentity,
    sourceKind: 'markdown',
    sourceProvider: 'arxiv2md-api',
    contentSha256: 'sha256:abcd'
  });
  assert.equal(sourceIdentity.sourceId, 'arxiv:2410.11206#markdown#arxiv2md-api#sha256:abcd');
  assert.equal(sourceIdentity.resolutionStatus, 'fulltext_ready');
});
