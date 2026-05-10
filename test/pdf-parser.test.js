import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __pdfParserTestables, convertPdfToMarkdown } from '../src/core/ingestion/pdf-parser.js';

const __markerTestables = __pdfParserTestables;

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

test('normalizePdfParser defaults to markitdown and accepts other parsers', () => {
  assert.equal(__markerTestables.normalizePdfParser(undefined), 'markitdown');
  assert.equal(__markerTestables.normalizePdfParser('markitdown'), 'markitdown');
  assert.equal(__markerTestables.normalizePdfParser('markpdfdown'), 'markpdfdown');
  assert.equal(__markerTestables.normalizePdfParser('opendataloader'), 'opendataloader');
  assert.equal(__markerTestables.normalizePdfParser('mineru'), 'mineru');
  assert.equal(__markerTestables.normalizePdfParser('docling'), 'docling');
  assert.equal(__markerTestables.normalizePdfParser('marker'), 'marker');
  assert.equal(__markerTestables.normalizePdfParser('paddleocr-vl'), 'paddleocr-vl');
  assert.equal(__markerTestables.normalizePdfParser('unexpected'), 'docling');
});

test('shared pythonCommand is used by python-based parsers unless a parser-specific override is set', () => {
  assert.equal(
    __markerTestables.resolveMarkItDownPython({ pythonCommand: '/usr/local/bin/shared-python' }),
    '/usr/local/bin/shared-python'
  );
  assert.equal(
    __markerTestables.resolveMarkPdfDownPython({ pythonCommand: '/usr/local/bin/shared-python' }),
    '/usr/local/bin/shared-python'
  );
  assert.equal(
    __markerTestables.resolveOpenDataLoaderPdfPython({ pythonCommand: '/usr/local/bin/shared-python' }),
    '/usr/local/bin/shared-python'
  );
  assert.equal(
    __markerTestables.resolveDoclingPython({ pythonCommand: '/usr/local/bin/shared-python' }),
    '/usr/local/bin/shared-python'
  );
  assert.equal(
    __markerTestables.resolvePaddleOcrVlPython({ pythonCommand: '/usr/local/bin/shared-python' }),
    '/usr/local/bin/shared-python'
  );
  assert.equal(
    __markerTestables.resolveMarkPdfDownPython({
      pythonCommand: '/usr/local/bin/shared-python',
      markpdfdownPython: '/usr/local/bin/markpdfdown-python'
    }),
    '/usr/local/bin/markpdfdown-python'
  );
  assert.equal(
    __markerTestables.resolveMarkItDownPython({
      pythonCommand: '/usr/local/bin/shared-python',
      markitdownPython: '/usr/local/bin/markitdown-python'
    }),
    '/usr/local/bin/markitdown-python'
  );
});

test('MarkItDown LLM defaults to on unless explicitly disabled', () => {
  assert.equal(__markerTestables.resolveMarkItDownUseLlm({}), true);
  assert.equal(__markerTestables.resolveMarkItDownUseLlm({ markitdownUseLlm: false }), false);
  assert.equal(__markerTestables.resolveMarkItDownEnablePlugins({}), true);
});

test('getPdfParserProfile centralizes concurrency and lease behavior per parser', () => {
  const markitdownProfile = __markerTestables.getPdfParserProfile('markitdown', {});
  assert.equal(markitdownProfile.recommendedConcurrency, 2);
  assert.equal(markitdownProfile.allowLlmConcurrencyBoost, false);
  assert.equal(markitdownProfile.leaseStrategy, 'none');

  const doclingProfile = __markerTestables.getPdfParserProfile('docling', {});
  assert.equal(doclingProfile.recommendedConcurrency, 4);
  assert.equal(doclingProfile.fallbackParser, '');
  assert.equal(doclingProfile.leaseStrategy, 'docling-gpu');
});

test('resolveMarkerBlockBlacklist normalizes configured marker block names', () => {
  assert.deepEqual(
    __markerTestables.resolveMarkerBlockBlacklist({
      markerBlockBlacklist: ['table', 'images', 'Figure', 'unknown', 'table']
    }),
    ['table', 'image']
  );

  assert.deepEqual(
    __markerTestables.resolveMarkerBlockBlacklist({
      markerBlockBlacklist: 'tables, picture ,ignored'
    }),
    ['table', 'image']
  );
});

test('filterMarkerMarkdown removes blacklisted tables and images while preserving body text', () => {
  const markdown = [
    '# Title',
    '',
    'Intro paragraph.',
    '',
    '![Figure 1](figure.png)',
    'Figure 1 caption.',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| Acc | 90 |',
    '',
    'Conclusion paragraph.',
    ''
  ].join('\n');

  const filtered = __markerTestables.filterMarkerMarkdown(markdown, ['table', 'image']);
  assert.match(filtered, /Intro paragraph\./);
  assert.match(filtered, /Conclusion paragraph\./);
  assert.doesNotMatch(filtered, /Figure 1/);
  assert.doesNotMatch(filtered, /\| Metric \| Value \|/);
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
    ocrEngine: 'ocrmac',
    device: 'cuda',
    cudaVisibleDevices: '2',
    artifactsPath: '/home/researcher/.cache/docling/models',
    imageExportMode: 'placeholder',
    enrichPictureClasses: false,
    enrichPictureDescription: false
  });

  assert.match(script, /\/opt\/docling\/bin\/docling/);
  assert.match(script, /export CUDA_VISIBLE_DEVICES='2'/);
  assert.doesNotMatch(script, /\nselect_gpu\n/);
  assert.match(script, /'--device' 'cuda'/);
  assert.match(script, /export OPENBLAS_NUM_THREADS='4'/);
  assert.match(script, /'--artifacts-path' '\/home\/researcher\/\.cache\/docling\/models'/);
  assert.match(script, /'--image-export-mode' 'placeholder'/);
  assert.match(script, /--no-enrich-picture-classes/);
  assert.match(script, /--no-enrich-picture-description/);
  assert.match(script, /'--ocr-engine' 'ocrmac'/);
  assert.match(script, /'--output' '\/tmp\/run\/out'/);
  assert.match(script, /find "\$run_dir" -type f -name '\*\.md'/);
});

test('buildRemoteDoclingScript auto-selects an unlocked GPU when CUDA devices are not pinned', () => {
  const script = __markerTestables.buildRemoteDoclingScript({
    doclingCommand: 'docling',
    remotePdfPath: '/tmp/run/paper.pdf',
    remoteRunDir: '/tmp/run/out',
    device: 'cuda',
    gpuMinFreeMb: 24000,
    gpuWaitTimeoutMs: 120000,
    gpuPollIntervalMs: 2000,
    cpuThreads: 3
  });

  assert.match(script, /gpu_lock_root='\/tmp\/papernexus-gpu-locks'/);
  assert.match(script, /gpu_min_free_mb='24000'/);
  assert.match(script, /gpu_wait_seconds='120'/);
  assert.match(script, /gpu_poll_seconds='2'/);
  assert.match(script, /select_gpu/);
  assert.match(script, /\nselect_gpu\n/);
  assert.match(script, /export CUDA_VISIBLE_DEVICES="\$best_gpu"/);
  assert.match(script, /export OPENBLAS_NUM_THREADS='3'/);
  assert.match(script, /Waiting for an available Docling GPU/);
});

test('Docling GPU helpers parse nvidia-smi output and build conservative execution env', () => {
  const gpus = __markerTestables.parseNvidiaSmiGpuLines([
    '0, NVIDIA A100-SXM4-40GB, 32100',
    '1, NVIDIA RTX 4090, 4096',
    ''
  ].join('\n'));

  assert.deepEqual(gpus, [
    { index: '0', name: 'NVIDIA A100-SXM4-40GB', freeMemoryMb: 32100 },
    { index: '1', name: 'NVIDIA RTX 4090', freeMemoryMb: 4096 }
  ]);

  const env = __markerTestables.buildDoclingExecutionEnv({
    doclingCudaVisibleDevices: '2',
    doclingCpuThreads: 2
  });
  assert.equal(env.CUDA_VISIBLE_DEVICES, '2');
  assert.equal(env.OPENBLAS_NUM_THREADS, '2');
  assert.equal(env.OMP_NUM_THREADS, '2');
  assert.equal(env.MKL_NUM_THREADS, '2');
  assert.equal(env.NUMEXPR_NUM_THREADS, '2');
});

test('resolveMineruRemoteFailureMode defaults to error and accepts docling', () => {
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({}), 'error');
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({ mineruRemoteFailureMode: 'docling' }), 'docling');
  assert.equal(__markerTestables.resolveMineruRemoteFailureMode({ mineruRemoteFailureMode: 'unexpected' }), 'error');
});

test('probeHttpEndpoint reports unreachable connections', async () => {
  const originalFetch = globalThis.fetch;
  try {
    __markerTestables.resetMineruProbeCache();
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

test('probeHttpEndpoint reuses cached reachability results within the TTL window', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { status: 204 };
    };

    const first = await __markerTestables.probeHttpEndpoint('http://127.0.0.1:30000', 6000, {
      cacheTtlMs: 15_000
    });
    const second = await __markerTestables.probeHttpEndpoint('http://127.0.0.1:30000', 6000, {
      cacheTtlMs: 15_000
    });

    assert.equal(first.reachable, true);
    assert.equal(second.reachable, true);
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 1);
  } finally {
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = originalFetch;
  }
});

test('probeHttpEndpoint can bypass the cache when the TTL is disabled', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { status: 204 };
    };

    await __markerTestables.probeHttpEndpoint('http://127.0.0.1:30000', 6000, {
      cacheTtlMs: 0
    });
    await __markerTestables.probeHttpEndpoint('http://127.0.0.1:30000', 6000, {
      cacheTtlMs: 0
    });

    assert.equal(fetchCalls, 2);
  } finally {
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = originalFetch;
  }
});

test('convertPdfToMarkdown stops early when remote mineru backend is unreachable', async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mineru-unreachable-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');

  try {
    __markerTestables.resetMineruProbeCache();
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
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown surfaces mineru parser timings when using the remote backend', async () => {
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mineru-timings-'));
  const binDir = path.join(tempDir, 'bin');
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const mineruShimPath = path.join(binDir, 'mineru');

  try {
    __markerTestables.resetMineruProbeCache();
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      mineruShimPath,
      [
        '#!/bin/sh',
        'run_dir=""',
        'pdf_path=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) run_dir="$2"; shift 2 ;;',
        '    -p) pdf_path="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$run_dir"',
        'base=$(basename "$pdf_path" .pdf)',
        'printf "# Parsed\\n" > "$run_dir/$base.md"'
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    globalThis.fetch = async () => ({ status: 204 });

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'mineru',
      mineruHttpUrl: 'http://127.0.0.1:30000',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'mineru');
    assert.equal(typeof result.timings?.probeHttpMs, 'number');
    assert.equal(typeof result.timings?.mineruRequestMs, 'number');
    assert.equal(typeof result.timings?.markdownWriteMs, 'number');
  } finally {
    __markerTestables.resetMineruProbeCache();
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown fails with a clear timeout error when the parser exceeds the deadline', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-timeout-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const sleepyParserPath = path.join(tempDir, 'sleepy-docling.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(sleepyParserPath, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });

    await assert.rejects(
      () => convertPdfToMarkdown(pdfPath, {
        pdfParser: 'docling',
        doclingCommand: sleepyParserPath,
        markerDir: tempDir,
        markdownDir: tempDir,
        pdfParseTimeoutMs: 100
      }),
      /timed out after 100ms/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown with marker can blacklist table and image blocks', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-marker-text-only-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const markerScriptPath = path.join(tempDir, 'fake-marker.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      markerScriptPath,
      [
        '#!/bin/sh',
        'pdf_path="$1"',
        'output_dir=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output_dir) output_dir="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'base=$(basename "$pdf_path" .pdf)',
        'mkdir -p "$output_dir"',
        'cat > "$output_dir/$base.md" <<\'EOF\'',
        '# Marker Parsed',
        '',
        '正文第一段。',
        '',
        '![Figure 1](figure.png)',
        'Figure 1 caption.',
        '',
        '| Method | Score |',
        '| --- | --- |',
        '| Ours | 95 |',
        '',
        '正文第二段。',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'marker',
      markerCommand: markerScriptPath,
      markerBlockBlacklist: ['table', 'image'],
      markerDir: tempDir,
      markdownDir: tempDir
    });

    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /正文第一段。/);
    assert.match(markdown, /正文第二段。/);
    assert.doesNotMatch(markdown, /Figure 1/);
    assert.doesNotMatch(markdown, /\| Method \| Score \|/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown can materialize markdown via the opendataloader wrapper', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-opendataloader-success-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'cat > "$output" <<\'EOF\'',
        '# OpenDataLoader Parsed',
        '',
        '正文第一段。',
        '',
        'Tail text.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'opendataloader',
      opendataloaderPdfPython: fakePythonPath,
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'opendataloader');
    assert.match(result.markdownPath, /opendataloader/);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /正文第一段。/);
    assert.match(markdown, /Tail text\./);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown can materialize markdown via the markitdown wrapper', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-markitdown-success-'));
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-markitdown-state-home-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'cat > "$output" <<\'EOF\'',
        '# MarkItDown',
        '',
        'Structured markdown from markitdown.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'markitdown',
      markitdownPython: fakePythonPath,
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'markitdown');
    assert.match(result.markdownPath, /markitdown/);
    assert.ok(result.pdfParseStatePath);
    assert.ok(result.pdfParseLogPath);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    const parseState = JSON.parse(await fs.readFile(result.pdfParseStatePath, 'utf8'));
    assert.match(markdown, /Structured markdown from markitdown/);
    assert.equal(parseState.status, 'completed');
    assert.equal(parseState.activeParser, 'markitdown');
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown can reuse PaperNexus llm config for MarkItDown LLM mode', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-markitdown-llm-success-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# MarkItDown LLM\\n\\nUSE_LLM=%s\\nPLUGINS=%s\\nMODEL=%s\\nBASE_URL=%s\\nAPI_KEY=%s\\nPROMPT=%s\\n" "$PAPERNEXUS_MARKITDOWN_USE_LLM" "$PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS" "$PAPERNEXUS_MARKITDOWN_LLM_MODEL" "$PAPERNEXUS_MARKITDOWN_LLM_BASE_URL" "$PAPERNEXUS_MARKITDOWN_LLM_API_KEY" "$PAPERNEXUS_MARKITDOWN_LLM_PROMPT" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'markitdown',
      markitdownPython: fakePythonPath,
      markitdownLlmPrompt: 'Describe embedded images faithfully.',
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'markitdown');
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /USE_LLM=1/);
    assert.match(markdown, /PLUGINS=1/);
    assert.match(markdown, /MODEL=gpt-4o/);
    assert.match(markdown, /BASE_URL=https:\/\/api\.openai\.com\/v1/);
    assert.match(markdown, /API_KEY=test-key/);
    assert.match(markdown, /PROMPT=Describe embedded images faithfully\./);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('MarkItDown auto-disables LLM mode when project llm config is unavailable', async () => {
  const previousModel = process.env.PAPERNEXUS_LLM_MODEL;
  const previousBaseUrl = process.env.PAPERNEXUS_LLM_BASE_URL;
  const previousApiKey = process.env.PAPERNEXUS_LLM_API_KEY;
  const previousApiKeyEnv = process.env.PAPERNEXUS_LLM_API_KEY_ENV;

  delete process.env.PAPERNEXUS_LLM_MODEL;
  delete process.env.PAPERNEXUS_LLM_BASE_URL;
  delete process.env.PAPERNEXUS_LLM_API_KEY;
  delete process.env.PAPERNEXUS_LLM_API_KEY_ENV;

  try {
    const runtime = await __markerTestables.buildMarkItDownRuntime({});
    assert.equal(runtime.useLlm, false);
    assert.equal(runtime.enablePlugins, false);
    assert.equal(runtime.env.PAPERNEXUS_MARKITDOWN_ENABLE_PLUGINS, '0');
  } finally {
    if (previousModel === undefined) delete process.env.PAPERNEXUS_LLM_MODEL;
    else process.env.PAPERNEXUS_LLM_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.PAPERNEXUS_LLM_BASE_URL;
    else process.env.PAPERNEXUS_LLM_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.PAPERNEXUS_LLM_API_KEY;
    else process.env.PAPERNEXUS_LLM_API_KEY = previousApiKey;
    if (previousApiKeyEnv === undefined) delete process.env.PAPERNEXUS_LLM_API_KEY_ENV;
    else process.env.PAPERNEXUS_LLM_API_KEY_ENV = previousApiKeyEnv;
  }
});

test('convertPdfToMarkdown can materialize markdown via the markpdfdown wrapper and reuse PaperNexus LLM config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-markpdfdown-success-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# MarkPDFDown\\n\\nMODEL_NAME=%s\\nOPENAI_API_KEY=%s\\nOPENAI_BASE_URL=%s\\nOPENAI_API_BASE=%s\\nMAX_TOKENS=%s\\n" "$MODEL_NAME" "$OPENAI_API_KEY" "$OPENAI_BASE_URL" "$OPENAI_API_BASE" "$MAX_TOKENS" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'markpdfdown',
      markpdfdownPython: fakePythonPath,
      llmProvider: 'openai',
      llmModel: 'qwen-vl-max',
      llmBaseUrl: 'https://dashscope.example/v1',
      llmApiKey: 'test-key',
      llmMaxTokens: 4096,
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'markpdfdown');
    assert.match(result.markdownPath, /markpdfdown/);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /MODEL_NAME=openai\/qwen-vl-max/);
    assert.match(markdown, /OPENAI_API_KEY=test-key/);
    assert.match(markdown, /OPENAI_BASE_URL=https:\/\/dashscope\.example\/v1/);
    assert.match(markdown, /OPENAI_API_BASE=https:\/\/dashscope\.example\/v1/);
    assert.match(markdown, /MAX_TOKENS=4096/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown falls back to docling when markitdown fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-markitdown-fallback-docling-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const failingPythonPath = path.join(tempDir, 'fail-markitdown.sh');
  const fakeDoclingPath = path.join(tempDir, 'fake-docling.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      failingPythonPath,
      [
        '#!/bin/sh',
        'echo "markitdown failed" >&2',
        'exit 1'
      ].join('\n'),
      { mode: 0o755 }
    );
    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'pdf_path="$1"',
        'out_dir=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) out_dir="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'base=$(basename "$pdf_path" .pdf)',
        'mkdir -p "$out_dir"',
        'printf "# %s Title\\n\\n## Abstract\\n\\nRecovered from markitdown failure.\\n" "$base" > "$out_dir/$base.md"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'markitdown',
      markitdownPython: failingPythonPath,
      doclingCommand: fakeDoclingPath,
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'docling');
    assert.equal(result.fallbackFromParser, 'markitdown');
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Recovered from markitdown failure/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown falls back to docling when the primary parser fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-parser-fallback-docling-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const failingPythonPath = path.join(tempDir, 'fail-markpdfdown.sh');
  const fakeDoclingPath = path.join(tempDir, 'fake-docling.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      failingPythonPath,
      [
        '#!/bin/sh',
        'echo "markpdfdown failed" >&2',
        'exit 1'
      ].join('\n'),
      { mode: 0o755 }
    );
    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'pdf_path="$1"',
        'out_dir=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) out_dir="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'base=$(basename "$pdf_path" .pdf)',
        'mkdir -p "$out_dir"',
        'printf "# %s Title\\n\\n## Abstract\\n\\nRecovered by docling fallback.\\n" "$base" > "$out_dir/$base.md"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'markpdfdown',
      markpdfdownPython: failingPythonPath,
      doclingCommand: fakeDoclingPath,
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'docling');
    assert.match(result.markdownPath, /docling/);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Recovered by docling fallback/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown can run docling in VLM mode with PaperNexus LLM config', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-docling-vlm-success-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-docling-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'preset=""',
        'model=""',
        'base_url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    --vlm-preset) preset="$2"; shift 2 ;;',
        '    --model-name) model="$2"; shift 2 ;;',
        '    --base-url) base_url="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# Docling VLM\\n\\nPRESET=%s\\nMODEL=%s\\nBASE_URL=%s\\nAPI_KEY=%s\\n" "$preset" "$model" "$base_url" "$PAPERNEXUS_DOCLING_VLM_API_KEY" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'docling',
      doclingUseVlm: true,
      doclingPython: fakePythonPath,
      doclingVlmPreset: 'granite_docling',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'docling');
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /PRESET=granite_docling/);
    assert.match(markdown, /MODEL=gpt-4o-mini/);
    assert.match(markdown, /BASE_URL=https:\/\/api\.openai\.com\/v1\/chat\/completions/);
    assert.match(markdown, /API_KEY=test-key/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown passes Docling GPU and image flags through the local CLI path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-docling-gpu-flags-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakeDoclingPath = path.join(tempDir, 'fake-docling.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'pdf_path="$1"',
        'out_dir=""',
        'args_log="${TMPDIR:-/tmp}/papernexus-docling-args.log"',
        'env_log="${TMPDIR:-/tmp}/papernexus-docling-env.log"',
        'shift',
        'printf "%s\\n" "$CUDA_VISIBLE_DEVICES" > "$env_log"',
        'printf "%s\\n" "$pdf_path" > "$args_log"',
        'while [ "$#" -gt 0 ]; do',
        '  printf "%s\\n" "$1" >> "$args_log"',
        '  case "$1" in',
        '    --output) out_dir="$2"; printf "%s\\n" "$2" >> "$args_log"; shift 2 ;;',
        '    --device|--ocr-engine|--pdf-backend|--artifacts-path|--image-export-mode) printf "%s\\n" "$2" >> "$args_log"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'base=$(basename "$pdf_path" .pdf)',
        'mkdir -p "$out_dir"',
        'printf "# %s Title\\n\\n## Abstract\\n\\nDocling GPU parse.\\n" "$base" > "$out_dir/$base.md"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'docling',
      doclingCommand: fakeDoclingPath,
      doclingPreload: false,
      doclingDevice: 'cuda',
      doclingCudaVisibleDevices: '2',
      doclingArtifactsPath: '/home/researcher/.cache/docling/models',
      doclingImageExportMode: 'placeholder',
      doclingEnrichPictureClasses: false,
      doclingEnrichPictureDescription: false,
      doclingOcrEngine: 'easyocr',
      doclingPdfBackend: 'pypdfium2',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'docling');
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Docling GPU parse/);

    const argsLog = await fs.readFile(path.join(os.tmpdir(), 'papernexus-docling-args.log'), 'utf8');
    const envLog = await fs.readFile(path.join(os.tmpdir(), 'papernexus-docling-env.log'), 'utf8');
    assert.match(envLog, /^2/m);
    assert.match(argsLog, /--device\ncuda/);
    assert.match(argsLog, /--artifacts-path\n\/home\/researcher\/\.cache\/docling\/models/);
    assert.match(argsLog, /--image-export-mode\nplaceholder/);
    assert.match(argsLog, /--no-enrich-picture-classes/);
    assert.match(argsLog, /--no-enrich-picture-description/);
    assert.match(argsLog, /--ocr-engine\neasyocr/);
    assert.match(argsLog, /--pdf-backend\npypdfium2/);
  } finally {
    await fs.rm(path.join(os.tmpdir(), 'papernexus-docling-args.log'), { force: true });
    await fs.rm(path.join(os.tmpdir(), 'papernexus-docling-env.log'), { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown fails fast when opendataloader setup or inference fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-opendataloader-fail-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'echo "ImportError: No module named opendataloader_pdf" >&2',
        'exit 1'
      ].join('\n'),
      { mode: 0o755 }
    );

    await assert.rejects(
      () => convertPdfToMarkdown(pdfPath, {
        pdfParser: 'opendataloader',
        opendataloaderPdfPython: fakePythonPath,
        markerDir: tempDir,
        markdownDir: tempDir
      }),
      /OpenDataLoader PDF failed|opendataloader-pdf/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown can materialize markdown via the remote paddleocr-vl wrapper', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paddleocr-vl-success-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'shift',
        'output=""',
        'server_url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    --server-url) server_url="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$(dirname "$output")"',
        'printf "# PaddleOCR-VL Parsed\\n\\n## Abstract\\n\\nRemote server: %s\\n" "$server_url" > "$output"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const result = await convertPdfToMarkdown(pdfPath, {
      pdfParser: 'paddleocr-vl',
      paddleocrVlPython: fakePythonPath,
      paddleocrVlServerUrl: 'http://127.0.0.1:8080/v1',
      markerDir: tempDir,
      markdownDir: tempDir
    });

    assert.equal(result.parser, 'paddleocr-vl');
    assert.match(result.markdownPath, /paddleocr-vl/);
    const markdown = await fs.readFile(result.markdownPath, 'utf8');
    assert.match(markdown, /Remote server: http:\/\/127\.0\.0\.1:8080\/v1/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convertPdfToMarkdown fails fast when paddleocr-vl setup or inference fails', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-paddleocr-vl-fail-'));
  const pdfPath = path.join(tempDir, 'paper.pdf');
  const fakePythonPath = path.join(tempDir, 'fake-python.sh');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      fakePythonPath,
      [
        '#!/bin/sh',
        'echo "ImportError: No module named paddleocr" >&2',
        'exit 1'
      ].join('\n'),
      { mode: 0o755 }
    );

    await assert.rejects(
      () => convertPdfToMarkdown(pdfPath, {
        pdfParser: 'paddleocr-vl',
        paddleocrVlPython: fakePythonPath,
        paddleocrVlServerUrl: 'http://127.0.0.1:8080/v1',
        markerDir: tempDir,
        markdownDir: tempDir
      }),
      /PaddleOCR-VL failed|PaddleOCR-VL remote server/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
