import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPublicationDateInfo,
  pickLatestPublicationDateFields,
  sortPaperRecordsByPublicationDateDesc
} from '../src/core/paper-date.js';

test('publication date helper sorts exact dates before older years and keeps undated fallback stable', () => {
  const records = [
    { title: 'Undated' },
    { title: 'Older exact', publicationDate: '2025-11-20' },
    { title: 'Latest year only', year: 2026 },
    { title: 'Latest exact', publicationDate: '2026-05-02' },
    { title: 'Same year lower precision', publicationDateOrYear: '2026' }
  ];

  const sorted = sortPaperRecordsByPublicationDateDesc(records, {
    fallbackCompare: (left, right) => String(left.title).localeCompare(String(right.title))
  });

  assert.deepEqual(sorted.map((entry) => entry.title), [
    'Latest exact',
    'Latest year only',
    'Same year lower precision',
    'Older exact',
    'Undated'
  ]);
});

test('publication date helper extracts nested provider metadata and picks latest merged fields', () => {
  const record = {
    properties: {
      publication_date: '2024-12-15'
    },
    paper: {
      publicationDate: '2025-01-10'
    }
  };

  assert.equal(extractPublicationDateInfo(record).normalizedDate, '2025-01-10');
  assert.deepEqual(pickLatestPublicationDateFields(record, { year: 2026 }), {
    year: 2026,
    publicationDate: null
  });
});
