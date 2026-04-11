import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const scriptPath = path.join(projectRoot, 'scripts', 'test-pdf-to-markdown.js');

test('test-pdf-to-markdown honors marker block blacklist from config.json', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf2md-marker-'));
  const pdfPath = path.join(workspaceRoot, 'paper.pdf');
  const markerScriptPath = path.join(workspaceRoot, 'fake-marker.mjs');
  const configPath = path.join(workspaceRoot, 'config.json');
  const cacheRoot = path.join(workspaceRoot, 'cache');

  try {
    await fs.writeFile(pdfPath, 'fake-pdf', 'utf8');
    await fs.writeFile(
      markerScriptPath,
      `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfArg = args[0];
const outputDir = args[args.indexOf('--output_dir') + 1];
const basename = path.basename(pdfArg, path.extname(pdfArg));
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(
  path.join(outputDir, \`\${basename}.md\`),
  [
    '# Title',
    '',
    'Body text.',
    '',
    '![Figure 1](figure.png)',
    'Figure 1 caption.',
    '',
    '| Col | Val |',
    '| --- | --- |',
    '| A | 1 |',
    '',
    'Tail text.',
    ''
  ].join('\\n'),
  'utf8'
);
`,
      { mode: 0o755 }
    );

    await fs.writeFile(configPath, `${JSON.stringify({
      analyze: {
        pdfParser: 'marker',
        markerCommand: './fake-marker.mjs',
        markerBlockBlacklist: ['table', 'image']
      }
    }, null, 2)}\n`);

    const { stdout } = await execFileAsync('node', [
      scriptPath,
      './paper.pdf',
      '--config',
      './config.json',
      '--cache-root',
      cacheRoot,
      '--force',
      '--json'
    ], {
      cwd: workspaceRoot,
      env: process.env
    });

    const payload = JSON.parse(stdout);
    const markdown = await fs.readFile(payload.result.markdownPath, 'utf8');
    assert.match(markdown, /Body text\./);
    assert.match(markdown, /Tail text\./);
    assert.doesNotMatch(markdown, /Figure 1/);
    assert.doesNotMatch(markdown, /\| Col \| Val \|/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('test-pdf-to-markdown defaults to markitdown and keeps markdown text-only', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf2md-markitdown-'));
  const pdfPath = path.join(workspaceRoot, 'paper.pdf');
  const fakePythonPath = path.join(workspaceRoot, 'fake-python.sh');
  const configPath = path.join(workspaceRoot, 'config.json');
  const cacheRoot = path.join(workspaceRoot, 'cache');

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
        '# Title',
        '',
        'Body text only.',
        '',
        'Tail text.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(configPath, `${JSON.stringify({
      analyze: {
        pythonCommand: './fake-python.sh'
      },
      llm: {
        provider: 'openai',
        model: 'qwen-vl-max',
        baseUrl: 'https://dashscope.example/v1',
        apiKey: 'test-key'
      }
    }, null, 2)}\n`);

    const { stdout } = await execFileAsync('node', [
      scriptPath,
      './paper.pdf',
      '--config',
      './config.json',
      '--cache-root',
      cacheRoot,
      '--force',
      '--json'
    ], {
      cwd: workspaceRoot,
      env: process.env
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.config.parser, 'markitdown');
    const markdown = await fs.readFile(payload.result.markdownPath, 'utf8');
    assert.match(markdown, /Body text only\./);
    assert.match(markdown, /Tail text\./);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('test-pdf-to-markdown can compare configured parser timing with docling fallback timing', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf2md-compare-'));
  const pdfPath = path.join(workspaceRoot, 'paper.pdf');
  const fakePythonPath = path.join(workspaceRoot, 'fake-python.sh');
  const fakeDoclingPath = path.join(workspaceRoot, 'fake-docling.sh');
  const configPath = path.join(workspaceRoot, 'config.json');
  const cacheRoot = path.join(workspaceRoot, 'cache');

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
        '# Configured Title',
        '',
        'Configured parser markdown.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'input="$1"',
        'shift',
        'output=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --output) output="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'mkdir -p "$output"',
        'base=$(basename "$input" .pdf)',
        'cat > "$output/$base.md" <<\'EOF\'',
        '# Docling Recovery Title',
        '',
        'Recovered by docling fallback.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    await fs.writeFile(configPath, `${JSON.stringify({
      analyze: {
        markitdownPython: './fake-python.sh',
        doclingCommand: './fake-docling.sh'
      },
      llm: {
        provider: 'openai',
        model: 'qwen-vl-max',
        baseUrl: 'https://dashscope.example/v1',
        apiKey: 'test-key'
      }
    }, null, 2)}\n`);

    const { stdout } = await execFileAsync('node', [
      scriptPath,
      './paper.pdf',
      '--config',
      './config.json',
      '--cache-root',
      cacheRoot,
      '--force',
      '--verify-docling-fallback',
      '--fallback-primary-parser',
      'marker',
      '--json'
    ], {
      cwd: workspaceRoot,
      env: process.env
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.config.parser, 'markitdown');
    assert.equal(payload.result.parser, 'markitdown');
    assert.equal(payload.fallbackCheck.checked, true);
    assert.equal(payload.fallbackCheck.primaryParser, 'marker');
    assert.equal(payload.fallbackCheck.fallbackTriggered, true);
    assert.equal(payload.fallbackCheck.result.parser, 'docling');
    assert.ok(payload.timings.elapsedMs >= 0);
    assert.ok(payload.fallbackCheck.timings.elapsedMs >= 0);
    assert.ok(payload.comparison.deltaMs >= 0);
    assert.equal(payload.comparison.configuredParser, 'markitdown');
    assert.equal(payload.comparison.doclingFallbackParser, 'docling');

    const fallbackMarkdown = await fs.readFile(payload.fallbackCheck.result.markdownPath, 'utf8');
    assert.match(fallbackMarkdown, /Recovered by docling fallback\./);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
