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

test('test-pdf-to-markdown defaults to opendataloader and keeps markdown text-only', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-pdf2md-opendataloader-'));
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
        opendataloaderPdfPython: './fake-python.sh'
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
    assert.equal(payload.config.parser, 'opendataloader');
    const markdown = await fs.readFile(payload.result.markdownPath, 'utf8');
    assert.match(markdown, /Body text only\./);
    assert.match(markdown, /Tail text\./);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
