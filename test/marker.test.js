import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __markerTestables, convertPdfToMarkdown } from '../src/core/ingestion/marker.js';

test('resolveRemoteMarkerHost prefers explicit marker host then pdf host', () => {
  assert.equal(
    __markerTestables.resolveRemoteMarkerHost({
      markerSshHost: 'marker-box',
      pdfSshHost: 'pdf-box'
    }),
    'marker-box'
  );

  assert.equal(
    __markerTestables.resolveRemoteMarkerHost({
      pdfSshHost: 'pdf-box'
    }),
    'pdf-box'
  );
});

test('normalizePdfParser defaults to mineru and accepts marker', () => {
  assert.equal(__markerTestables.normalizePdfParser(undefined), 'mineru');
  assert.equal(__markerTestables.normalizePdfParser('mineru'), 'mineru');
  assert.equal(__markerTestables.normalizePdfParser('docling'), 'docling');
  assert.equal(__markerTestables.normalizePdfParser('marker'), 'marker');
  assert.equal(__markerTestables.normalizePdfParser('unexpected'), 'docling');
});

test('buildRemoteMarkerScript includes marker command, paths, and optional page range', () => {
  const script = __markerTestables.buildRemoteMarkerScript({
    markerCommand: '/opt/marker/bin/python -m marker_single',
    remotePdfPath: '/tmp/run/paper.pdf',
    remoteRunDir: '/tmp/run/out',
    pageRange: '0-5'
  });

  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /mkdir -p "\$run_dir"/);
  assert.match(script, /\/opt\/marker\/bin\/python -m marker_single/);
  assert.match(script, /'\/tmp\/run\/paper\.pdf'/);
  assert.match(script, /--output_dir '\/tmp\/run\/out'/);
  assert.match(script, /--page_range '0-5'/);
  assert.match(script, /find "\$run_dir" -type f -name '\*\.md'/);
});

test('buildRemoteDoclingScript includes docling command and output directory', () => {
  const script = __markerTestables.buildRemoteDoclingScript({
    doclingCommand: '/opt/docling/bin/docling',
    remotePdfPath: '/tmp/run/paper.pdf',
    remoteRunDir: '/tmp/run/out',
    ocrEngine: 'ocrmac'
  });

  assert.match(script, /\/opt\/docling\/bin\/docling/);
  assert.match(script, /--image-export-mode referenced/);
  assert.match(script, /--ocr-engine 'ocrmac'/);
  assert.match(script, /--output '\/tmp\/run\/out'/);
  assert.match(script, /find "\$run_dir" -type f -name '\*\.md'/);
});

test('resolveMineruRemoteFailureMode defaults to error and accepts docling', () => {
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({}), 'error');
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({ mineruRemoteFailureMode: 'docling' }), 'docling');
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({ mineruRemoteFailureMode: 'unexpected' }), 'error');
});

test('probeHttpEndpoint reports unreachable connections', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:30000');
    };

    const result = await __markerTestables.probeHttpEndpoint('http://127.0.0.1:30000');
    assert.equal(result.reachable, false);
    assert.match(result.error, /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('convertPdfToMarkdown stops early when remote mineru backend is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mineru-unreachable-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    globalThis.fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:30000');
    };

    await assert.rejects(
      () => convertPdfToMarkdown(pdfPath, {
        pdfParser: 'mineru',
        mineruHttpUrl: 'http://127.0.0.1:30000',
        mineruRemoteFailureMode: 'error',
        markerDir: tempDir,
        markdownDir: tempDir
      }),
      /Remote MinerU backend is unreachable/
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
