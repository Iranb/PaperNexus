import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { ensureDir, fileExists, listFilesRecursive, readText, removePath, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

const PDF_PARSER_DOCLING = 'docling';
const PDF_PARSER_MARKER = 'marker';
const PDF_PARSER_MINERU = 'mineru';
const DEFAULT_PDF_PARSE_TIMEOUT_MS = 100_000;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 0);
    const timeoutLabel = String(options.timeoutLabel || command);
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      options.onStdout?.(chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`));
    });
  });
}

function runCommandWithStdin(command, args, stdinBuffer, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 0);
    const timeoutLabel = String(options.timeoutLabel || command);
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      options.onStdout?.(chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });

    child.on('error', (error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`));
    });

    child.stdin.end(stdinBuffer);
  });
}

function createProgressReporter(label) {
  let trailing = '';

  const report = (chunk) => {
    const normalized = String(chunk).replace(/\r/g, '\n');
    const combined = trailing + normalized;
    const lines = combined.split('\n');
    trailing = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      process.stderr.write(`[${label}] ${trimmed}\n`);
    }
  };

  report.flush = () => {
    const trimmed = trailing.trimEnd();
    if (trimmed) {
      process.stderr.write(`[${label}] ${trimmed}\n`);
    }
    trailing = '';
  };

  return report;
}

function flushProgressReporter(reporter) {
  reporter.flush?.();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function normalizePdfParser(value) {
  const normalized = String(value || process.env.PAPERNEXUS_PDF_PARSER || PDF_PARSER_MINERU).trim().toLowerCase();
  if (normalized === PDF_PARSER_MARKER) return PDF_PARSER_MARKER;
  if (normalized === PDF_PARSER_MINERU) return PDF_PARSER_MINERU;
  return PDF_PARSER_DOCLING;
}

function resolveRemoteMarkerHost(options = {}) {
  return options.markerSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || process.env.PAPERNEXUS_MARKER_SSH_HOST
    || process.env.PAPERNEXUS_PDF_PARSER_SSH_HOST
    || '';
}

function resolveRemoteDoclingHost(options = {}) {
  return options.doclingSshHost
    || options.pdfParserSshHost
    || options.pdfSshHost
    || process.env.PAPERNEXUS_DOCLING_SSH_HOST
    || process.env.PAPERNEXUS_PDF_PARSER_SSH_HOST
    || '';
}

function resolveMineruHttpUrl(options = {}) {
  return options.mineruHttpUrl
    || options.pdfParserHttpUrl
    || process.env.PAPERNEXUS_MINERU_HTTP_URL
    || '';
}

function resolveMineruRemoteFailureMode(options = {}) {
  const normalized = String(
    options.mineruRemoteFailureMode
    || process.env.PAPERNEXUS_MINERU_REMOTE_FAILURE_MODE
    || 'error'
  ).trim().toLowerCase();
  return normalized === 'docling' ? 'docling' : 'error';
}

function resolvePdfParseTimeoutMs(options = {}) {
  const raw = Number(
    options.pdfParseTimeoutMs
    || process.env.PAPERNEXUS_PDF_PARSE_TIMEOUT_MS
    || DEFAULT_PDF_PARSE_TIMEOUT_MS
  );
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PDF_PARSE_TIMEOUT_MS;
  return Math.max(1, Math.round(raw));
}

async function probeHttpEndpoint(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal
    });
    return {
      reachable: true,
      status: response.status,
      error: null
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error?.name === 'AbortError'
        ? `Connection probe timed out after ${timeoutMs}ms`
        : (error?.message || 'Unknown connectivity error')
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildRemoteMarkerScript({ markerCommand, remotePdfPath, remoteRunDir, pageRange }) {
  const markerArgs = [
    shellQuote(remotePdfPath),
    '--output_format',
    'markdown',
    '--disable_image_extraction',
    '--output_dir',
    shellQuote(remoteRunDir)
  ];

  if (pageRange) {
    markerArgs.push('--page_range', shellQuote(String(pageRange)));
  }

  return [
    'set -e',
    `tmp_root=${shellQuote(path.posix.dirname(remoteRunDir))}`,
    `run_dir=${shellQuote(remoteRunDir)}`,
    'gpu_lock_root=/tmp/papernexus-gpu-locks',
    'gpu_wait_seconds=900',
    'gpu_poll_seconds=5',
    'gpu_min_free_mb=18000',
    'gpu_min_compute_cap=70',
    'GPU_LOCK_DIR=""',
    'select_gpu() {',
    '  command -v nvidia-smi >/dev/null 2>&1 || return 0',
    '  mkdir -p "$gpu_lock_root"',
    '  start_ts=$(date +%s)',
    '  while true; do',
    '    gpu_lines_file="$tmp_root/gpu-lines.txt"',
    '    nvidia-smi --query-gpu=index,name,compute_cap,memory.free --format=csv,noheader,nounits > "$gpu_lines_file" 2>/dev/null || true',
    '    best_gpu=""',
    '    best_free=0',
    '    best_name=""',
    '    while IFS= read -r line; do',
    '      idx=$(printf "%s" "$line" | cut -d"," -f1 | tr -d " ")',
    '      name=$(printf "%s" "$line" | cut -d"," -f2 | sed "s/^ *//;s/ *$//")',
    '      compute_cap=$(printf "%s" "$line" | cut -d"," -f3 | tr -d " ")',
    '      free=$(printf "%s" "$line" | cut -d"," -f4 | tr -d " ")',
    '      compute_cap_num=$(printf "%s" "$compute_cap" | tr -d ".")',
    '      [ -n "$idx" ] || continue',
    '      [ -n "$compute_cap_num" ] || continue',
    '      [ -n "$free" ] || continue',
    '      [ "$compute_cap_num" -ge "$gpu_min_compute_cap" ] || continue',
    '      [ "$free" -ge "$gpu_min_free_mb" ] || continue',
    '      [ -d "$gpu_lock_root/gpu-$idx.lock" ] && continue',
    '      if [ -z "$best_gpu" ] || [ "$free" -gt "$best_free" ]; then',
    '        best_gpu="$idx"',
    '        best_free="$free"',
    '        best_name="$name"',
    '      fi',
    '    done < "$gpu_lines_file"',
    '    if [ -n "$best_gpu" ]; then',
    '      lock_dir="$gpu_lock_root/gpu-$best_gpu.lock"',
    '      if mkdir "$lock_dir" 2>/dev/null; then',
    '        GPU_LOCK_DIR="$lock_dir"',
    '        export CUDA_VISIBLE_DEVICES="$best_gpu"',
    '        export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
    '        echo "Using GPU $best_gpu ($best_name) with ${best_free} MiB free memory" >&2',
    '        return 0',
    '      fi',
    '    fi',
    '    now_ts=$(date +%s)',
    '    elapsed=$((now_ts - start_ts))',
    '    if [ "$elapsed" -ge "$gpu_wait_seconds" ]; then',
    '      echo "Timed out waiting for an available GPU with at least ${gpu_min_free_mb} MiB free memory" >&2',
    '      return 1',
    '    fi',
    '    echo "Waiting for an available GPU..." >&2',
    '    sleep "$gpu_poll_seconds"',
    '  done',
    '}',
    'cleanup() { [ -n "$GPU_LOCK_DIR" ] && rm -rf "$GPU_LOCK_DIR"; rm -rf "$tmp_root"; }',
    'trap cleanup EXIT',
    'select_gpu',
    'mkdir -p "$run_dir"',
    `${markerCommand} ${markerArgs.join(' ')} 1>&2`,
    'markdown_file=$(find "$run_dir" -type f -name \'*.md\' | head -n 1)',
    'if [ -z "$markdown_file" ]; then',
    '  echo "Marker finished but no markdown file was found." >&2',
    '  exit 1',
    'fi',
    'cat "$markdown_file"'
  ].join('\n');
}

function buildRemoteDoclingScript({ doclingCommand, remotePdfPath, remoteRunDir, ocrEngine, pdfBackend }) {
  const command = [
    doclingCommand,
    shellQuote(remotePdfPath),
    '--image-export-mode referenced',
    '--output',
    shellQuote(remoteRunDir),
    ocrEngine ? `--ocr-engine ${shellQuote(ocrEngine)}` : '',
    pdfBackend ? `--pdf-backend ${shellQuote(pdfBackend)}` : ''
  ].filter(Boolean).join(' ');

  return [
    'set -e',
    `tmp_root=${shellQuote(path.posix.dirname(remoteRunDir))}`,
    `run_dir=${shellQuote(remoteRunDir)}`,
    'cleanup() { rm -rf "$tmp_root"; }',
    'trap cleanup EXIT',
    'mkdir -p "$run_dir"',
    `${command} 1>&2`,
    'markdown_file=$(find "$run_dir" -type f -name \'*.md\' | head -n 1)',
    'if [ -z "$markdown_file" ]; then',
    '  echo "Docling finished but no markdown file was found." >&2',
    '  exit 1',
    'fi',
    'cat "$markdown_file"'
  ].join('\n');
}

async function runRemoteCommand(sshHost, script, options = {}) {
  return runCommand('ssh', [sshHost, script], options);
}

async function runRemoteCommandWithStdin(sshHost, script, stdinBuffer, options = {}) {
  return runCommandWithStdin('ssh', [sshHost, script], stdinBuffer, options);
}

async function extractPdfViaRemotePypdf(pdfPath, sshHost) {
  const pdfBuffer = await fs.readFile(pdfPath);
  const remoteTmpPath = `/tmp/papernexus-${stableHash(`${pdfPath}:${Date.now()}`, 16)}.pdf`;
  await runRemoteCommandWithStdin(sshHost, `cat > ${shellQuote(remoteTmpPath)}`, pdfBuffer);

  try {
    const { stdout } = await runRemoteCommand(
      sshHost,
      `pdftotext -layout ${shellQuote(remoteTmpPath)} -; rm -f ${shellQuote(remoteTmpPath)}`
    );
    const text = String(stdout || '').trim();
    if (text) return text;
  } catch {}

  const pythonCode = [
    'import sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'chunks = []',
    'for index, page in enumerate(reader.pages, start=1):',
    '    text = (page.extract_text() or "").strip()',
    '    if not text:',
    '        continue',
    '    chunks.append(f"# Page {index}\\n\\n{text}")',
    'sys.stdout.write("\\n\\n".join(chunks))'
  ].join('; ');

  const { stdout } = await runRemoteCommand(
    sshHost,
    `python3 -c ${shellQuote(pythonCode)} ${shellQuote(remoteTmpPath)}; rm -f ${shellQuote(remoteTmpPath)}`
  );
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote PDF text extraction returned empty text for ${pdfPath}.`);
  }
  return markdown;
}

async function findGeneratedMarkdown(runDir, basename) {
  const files = await listFilesRecursive(runDir);
  const markdownFiles = files.filter((filePath) => path.extname(filePath).toLowerCase() === '.md');
  if (!markdownFiles.length) {
    throw new Error(`Marker finished but no markdown file was found in ${runDir}.`);
  }

  return (
    markdownFiles.find((filePath) => path.basename(filePath, '.md') === basename) ||
    markdownFiles.find((filePath) => filePath.includes(`${path.sep}${basename}${path.sep}`)) ||
    markdownFiles[0]
  );
}

function getParserCachePaths(parser, basename, directories = {}) {
  return {
    cachedMarkdownPath: path.join(directories.markdownDir, parser, `${basename}.md`),
    runDir: path.join(directories.markerDir, parser, basename)
  };
}

export function getPdfMarkdownCachePath(pdfPath, options = {}) {
  const parser = normalizePdfParser(options.pdfParser);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  return getParserCachePaths(parser, basename, {
    markerDir: options.markerDir,
    markdownDir: options.markdownDir
  }).cachedMarkdownPath;
}

export function getMarkdownSourceCachePath(markdownPath, directories = {}) {
  const basename = path.basename(markdownPath, path.extname(markdownPath));
  const suffix = stableHash(path.resolve(markdownPath), 10);
  return path.join(directories.markdownDir, 'source', `${basename}-${suffix}.md`);
}

export async function cacheMarkdownSource(markdownPath, options = {}) {
  const {
    markdownDir,
    force = false
  } = options;

  const cachedMarkdownPath = getMarkdownSourceCachePath(markdownPath, { markdownDir });
  await ensureDir(path.dirname(cachedMarkdownPath));

  if (!force && await fileExists(cachedMarkdownPath)) {
    return {
      markdownPath: cachedMarkdownPath,
      generated: false,
      parser: 'source'
    };
  }

  await writeText(cachedMarkdownPath, await readText(markdownPath));
  return {
    markdownPath: cachedMarkdownPath,
    generated: true,
    parser: 'source'
  };
}

async function convertPdfToMarkdownViaRemoteMarker(pdfPath, options = {}) {
  const { markerCommand, markerSshHost, pageRange } = options;
  const pdfBuffer = await fs.readFile(pdfPath);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const progress = createProgressReporter(`marker:${basename}`);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const remoteRoot = `/tmp/papernexus-marker-${stableHash(`${pdfPath}:${Date.now()}`, 16)}`;
  const remotePdfPath = `${remoteRoot}/${basename}.pdf`;
  const remoteRunDir = `${remoteRoot}/out`;

  process.stderr.write(`[marker:${basename}] Uploading PDF to ${markerSshHost}\n`);
  await runRemoteCommand(markerSshHost, `mkdir -p ${shellQuote(remoteRoot)}`, {
    timeoutMs,
    timeoutLabel: `remote marker setup for ${pdfPath}`
  });
  await runRemoteCommandWithStdin(markerSshHost, `cat > ${shellQuote(remotePdfPath)}`, pdfBuffer, {
    timeoutMs,
    timeoutLabel: `remote marker upload for ${pdfPath}`
  });
  process.stderr.write(`[marker:${basename}] Running remote marker on ${markerSshHost}\n`);

  const script = buildRemoteMarkerScript({
    markerCommand,
    remotePdfPath,
    remoteRunDir,
    pageRange
  });

  const { stdout } = await runRemoteCommand(markerSshHost, script, {
    onStderr: progress,
    timeoutMs,
    timeoutLabel: `remote marker parse for ${pdfPath}`
  });
  flushProgressReporter(progress);
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote Marker returned empty markdown for ${pdfPath}.`);
  }

  return {
    markdown,
    markerCommand: `${markerCommand} (remote@${markerSshHost})`
  };
}

async function convertPdfToMarkdownViaRemoteDocling(pdfPath, options = {}) {
  const { doclingCommand, doclingSshHost, pageRange, doclingOcrEngine, doclingPdfBackend } = options;
  if (pageRange) {
    throw new Error('Docling page-range forwarding is not currently supported.');
  }

  const pdfBuffer = await fs.readFile(pdfPath);
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const progress = createProgressReporter(`docling:${basename}`);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const remoteRoot = `/tmp/papernexus-docling-${stableHash(`${pdfPath}:${Date.now()}`, 16)}`;
  const remotePdfPath = `${remoteRoot}/${basename}.pdf`;
  const remoteRunDir = `${remoteRoot}/out`;

  process.stderr.write(`[docling:${basename}] Uploading PDF to ${doclingSshHost}\n`);
  await runRemoteCommand(doclingSshHost, `mkdir -p ${shellQuote(remoteRoot)}`, {
    timeoutMs,
    timeoutLabel: `remote docling setup for ${pdfPath}`
  });
  await runRemoteCommandWithStdin(doclingSshHost, `cat > ${shellQuote(remotePdfPath)}`, pdfBuffer, {
    timeoutMs,
    timeoutLabel: `remote docling upload for ${pdfPath}`
  });
  process.stderr.write(`[docling:${basename}] Running remote docling on ${doclingSshHost}\n`);

  const script = buildRemoteDoclingScript({
    doclingCommand,
    remotePdfPath,
    remoteRunDir,
    ocrEngine: doclingOcrEngine,
    pdfBackend: doclingPdfBackend
  });

  const { stdout } = await runRemoteCommand(doclingSshHost, script, {
    onStderr: progress,
    timeoutMs,
    timeoutLabel: `remote docling parse for ${pdfPath}`
  });
  flushProgressReporter(progress);
  const markdown = String(stdout || '').trim();
  if (!markdown) {
    throw new Error(`Remote Docling returned empty markdown for ${pdfPath}.`);
  }

  return {
    markdown,
    parserCommand: `${doclingCommand} (remote@${doclingSshHost})`
  };
}

async function convertPdfToMarkdownViaMineru(pdfPath, options = {}) {
  const { mineruHttpUrl, mineruCommand, runDir, quiet = false } = options;
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const timeoutMs = resolvePdfParseTimeoutMs(options);

  // 如果使用 HTTP API 直接调用
  if (mineruHttpUrl && !runDir) {
    const pdfBuffer = await fs.readFile(pdfPath);
    const formData = new FormData();
    formData.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), `${basename}.pdf`);

    if (!quiet) {
      process.stderr.write(`[mineru:${basename}] Uploading PDF to ${mineruHttpUrl}\n`);
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(mineruHttpUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal
      });

      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new Error(`Mineru API returned ${response.status}`);
      }

      const result = await response.json();
      const markdown = result.markdown || result.content || result.text || '';

      if (!markdown) {
        throw new Error(`Mineru returned empty markdown for ${pdfPath}`);
      }

      return {
        markdown,
        parserCommand: `mineru (http@${mineruHttpUrl})`
      };
    } catch (error) {
      clearTimeout(timeoutHandle);
      if (error.name === 'AbortError') {
        throw new Error(`Mineru request timed out after ${timeoutMs}ms for ${pdfPath}`);
      }
      throw error;
    }
  }

  // 如果使用本地 mineru 命令调用远程服务
  const args = [
    '-p',
    pdfPath,
    '-o',
    runDir,
    '-b',
    'vlm-http-client',
    '-u',
    mineruHttpUrl || mineruCommand
  ];

  if (!quiet) {
    process.stderr.write(`[mineru:${basename}] Running local mineru with remote backend\n`);
  }
  await runCommand('mineru', args, {
    onStdout: quiet ? () => {} : undefined,
    onStderr: quiet ? () => {} : undefined,
    timeoutMs,
    timeoutLabel: `mineru parse for ${pdfPath}`
  });

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  const markdown = await readText(generatedMarkdownPath);

  return {
    markdown,
    parserCommand: `mineru -b vlm-http-client -u ${mineruHttpUrl || mineruCommand}`
  };
}

async function convertPdfToMarkdownWithMarker(pdfPath, options = {}) {
  const {
    markerCommand = process.env.PAPERNEXUS_MARKER_CMD || 'marker_single',
    markerSshHost = '',
    pdfParserSshHost = '',
    markerDir,
    markdownDir,
    force = false,
    pageRange,
    pdfSshHost = process.env.PAPERNEXUS_PDF_SSH_HOST || ''
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const progress = createProgressReporter(`marker:${basename}`);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MARKER, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MARKER,
      parserCommand: markerCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const remoteMarkerHost = resolveRemoteMarkerHost({
    markerSshHost,
    pdfParserSshHost,
    pdfSshHost
  });

  if (remoteMarkerHost) {
    try {
      const remoteResult = await convertPdfToMarkdownViaRemoteMarker(pdfPath, {
        markerCommand,
        markerSshHost: remoteMarkerHost,
        pageRange
      });
      await writeText(cachedMarkdownPath, remoteResult.markdown);
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_MARKER,
        parserCommand: remoteResult.markerCommand
      };
    } catch (error) {
      if (!pdfSshHost) {
        throw new Error(
          `Remote Marker failed for ${pdfPath}. ${error.message}\n` +
          'Tip: verify SSH access and the remote Marker command, or provide `--pdf-ssh-host` for remote pypdf fallback.'
        );
      }
    }
  }

  const args = [
    pdfPath,
    '--output_format',
    'markdown',
    '--disable_image_extraction',
    '--output_dir',
    runDir
  ];

  if (pageRange) {
    args.push('--page_range', String(pageRange));
  }

  try {
    process.stderr.write(`[marker:${basename}] Running local marker\n`);
    await runCommand(markerCommand, args, {
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `marker parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    if (!pdfSshHost) {
      throw new Error(
        `Marker failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify the PDF opens correctly, install Marker locally, provide `--marker-ssh-host` or `--pdf-ssh-host`, or ingest Markdown directly instead.'
      );
    }

    const fallbackMarkdown = await extractPdfViaRemotePypdf(pdfPath, pdfSshHost);
    await writeText(cachedMarkdownPath, fallbackMarkdown);
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: true,
      parser: PDF_PARSER_MARKER,
      parserCommand: `${markerCommand} (fallback: remote-pypdf@${pdfSshHost})`
    };
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  await writeText(cachedMarkdownPath, await readText(generatedMarkdownPath));

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MARKER,
    parserCommand: markerCommand
  };
}

async function convertPdfToMarkdownWithDocling(pdfPath, options = {}) {
  const {
    doclingCommand = process.env.PAPERNEXUS_DOCLING_CMD || 'docling',
    doclingOcrEngine = process.env.PAPERNEXUS_DOCLING_OCR_ENGINE || '',
    doclingPdfBackend = process.env.PAPERNEXUS_DOCLING_PDF_BACKEND || '',
    doclingSshHost = '',
    pdfParserSshHost = '',
    markerDir,
    markdownDir,
    force = false,
    pageRange,
    pdfSshHost = process.env.PAPERNEXUS_PDF_SSH_HOST || ''
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const progress = createProgressReporter(`docling:${basename}`);
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_DOCLING, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_DOCLING,
      parserCommand: doclingCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const remoteDoclingHost = resolveRemoteDoclingHost({
    doclingSshHost,
    pdfParserSshHost,
    pdfSshHost
  });
  const fallbackPdfHost = pdfSshHost || remoteDoclingHost;

  if (remoteDoclingHost) {
    try {
      const remoteResult = await convertPdfToMarkdownViaRemoteDocling(pdfPath, {
        doclingCommand,
        doclingSshHost: remoteDoclingHost,
        pageRange,
        doclingOcrEngine,
        doclingPdfBackend
      });
      await writeText(cachedMarkdownPath, remoteResult.markdown);
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_DOCLING,
        parserCommand: remoteResult.parserCommand
      };
    } catch (error) {
      if (!fallbackPdfHost) {
        throw new Error(
          `Remote Docling failed for ${pdfPath}. ${error.message}\n` +
          'Tip: verify SSH access and the remote Docling command, or provide `--pdf-ssh-host` for remote pypdf fallback.'
        );
      }
    }
  }

  if (pageRange) {
    throw new Error('Docling page-range forwarding is not currently supported. Use `--pdf-parser marker` when you need `--page-range`.');
  }

  try {
    process.stderr.write(`[docling:${basename}] Running local docling\n`);
    await runCommand(doclingCommand, [
      pdfPath,
      '--image-export-mode',
      'referenced',
      '--output',
      runDir,
      ...(doclingOcrEngine ? ['--ocr-engine', doclingOcrEngine] : []),
      ...(doclingPdfBackend ? ['--pdf-backend', doclingPdfBackend] : [])
    ], {
      onStdout: progress,
      onStderr: progress,
      timeoutMs,
      timeoutLabel: `docling parse for ${pdfPath}`
    });
    flushProgressReporter(progress);
  } catch (error) {
    if (!fallbackPdfHost) {
      throw new Error(
        `Docling failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify Docling is installed locally, provide `--docling-ssh-host` for remote parsing, or use `--pdf-parser marker`.'
      );
    }

    const fallbackMarkdown = await extractPdfViaRemotePypdf(pdfPath, fallbackPdfHost);
    await writeText(cachedMarkdownPath, fallbackMarkdown);
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: true,
      parser: PDF_PARSER_DOCLING,
      parserCommand: `${doclingCommand} (fallback: remote-pypdf@${fallbackPdfHost})`
    };
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  await writeText(cachedMarkdownPath, await readText(generatedMarkdownPath));

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_DOCLING,
    parserCommand: doclingCommand
  };
}

async function convertPdfToMarkdownWithMineru(pdfPath, options = {}) {
  const {
    mineruCommand = process.env.PAPERNEXUS_MINERU_CMD || 'mineru',
    mineruHttpUrl = '',
    pdfParserHttpUrl = '',
    markerDir,
    markdownDir,
    force = false,
    quiet = false
  } = options;

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const timeoutMs = resolvePdfParseTimeoutMs(options);
  const { cachedMarkdownPath, runDir } = getParserCachePaths(PDF_PARSER_MINERU, basename, {
    markerDir,
    markdownDir
  });

  if (!force && await fileExists(cachedMarkdownPath)) {
    return {
      markdownPath: cachedMarkdownPath,
      sourcePdfPath: pdfPath,
      generated: false,
      parser: PDF_PARSER_MINERU,
      parserCommand: mineruCommand
    };
  }

  if (force) {
    await removePath(runDir);
  }

  await ensureDir(runDir);
  await ensureDir(path.dirname(cachedMarkdownPath));

  const resolvedHttpUrl = resolveMineruHttpUrl({ mineruHttpUrl, pdfParserHttpUrl });
  const remoteFailureMode = resolveMineruRemoteFailureMode(options);

  if (resolvedHttpUrl) {
    const reachability = await probeHttpEndpoint(resolvedHttpUrl);
    if (!reachability.reachable) {
      const warning = `Remote MinerU backend is unreachable at ${resolvedHttpUrl}: ${reachability.error}`;
      process.stderr.write(`[mineru:${basename}] WARNING: ${warning}\n`);

      if (remoteFailureMode === 'docling') {
        process.stderr.write(`[mineru:${basename}] Falling back to docling because --mineru-remote-failure docling is enabled\n`);
        return convertPdfToMarkdownWithDocling(pdfPath, {
          ...options,
          force,
          quiet
        });
      }

      throw new Error(
        `${warning}\n` +
        'Tip: bring the MinerU HTTP backend back online, switch to `--pdf-parser docling`, or set `--mineru-remote-failure docling` to fall back automatically.'
      );
    }

    try {
      const remoteResult = await convertPdfToMarkdownViaMineru(pdfPath, {
        mineruCommand,
        mineruHttpUrl: resolvedHttpUrl,
        runDir,
        quiet
      });
      await writeText(cachedMarkdownPath, remoteResult.markdown);
      return {
        markdownPath: cachedMarkdownPath,
        sourcePdfPath: pdfPath,
        generated: true,
        parser: PDF_PARSER_MINERU,
        parserCommand: remoteResult.parserCommand
      };
    } catch (error) {
      throw new Error(
        `Mineru failed for ${pdfPath}. ${error.message}\n` +
        'Tip: verify the mineru HTTP API endpoint is accessible, switch to `--pdf-parser docling`, or set `--mineru-remote-failure docling`.'
      );
    }
  }

  // Fallback: local mineru without remote backend
  const args = [
    '-p',
    pdfPath,
    '-o',
    runDir
  ];

  try {
    await runCommand('mineru', args, {
      onStdout: quiet ? () => {} : undefined,
      onStderr: quiet ? () => {} : undefined,
      timeoutMs,
      timeoutLabel: `mineru parse for ${pdfPath}`
    });
  } catch (error) {
    throw new Error(
      `Mineru failed for ${pdfPath}. ${error.message}\n` +
      'Tip: verify mineru is installed and the HTTP endpoint is provided via --mineru-http-url or PAPERNEXUS_MINERU_HTTP_URL.'
    );
  }

  const generatedMarkdownPath = await findGeneratedMarkdown(runDir, basename);
  await writeText(cachedMarkdownPath, await readText(generatedMarkdownPath));

  return {
    markdownPath: cachedMarkdownPath,
    sourcePdfPath: pdfPath,
    generated: true,
    parser: PDF_PARSER_MINERU,
    parserCommand: mineruCommand
  };
}

export async function convertPdfToMarkdown(pdfPath, options = {}) {
  const parser = normalizePdfParser(options.pdfParser);
  if (parser === PDF_PARSER_MARKER) {
    return convertPdfToMarkdownWithMarker(pdfPath, {
      ...options,
      markerCommand: options.markerCommand || options.pdfCommand
    });
  }

  if (parser === PDF_PARSER_MINERU) {
    return convertPdfToMarkdownWithMineru(pdfPath, {
      ...options,
      mineruCommand: options.mineruCommand || options.pdfCommand
    });
  }

  return convertPdfToMarkdownWithDocling(pdfPath, {
    ...options,
    doclingCommand: options.doclingCommand || options.pdfCommand
  });
}

export const __markerTestables = {
  shellQuote,
  normalizePdfParser,
  resolveRemoteMarkerHost,
  resolveMineruRemoteFailureMode,
  resolvePdfParseTimeoutMs,
  probeHttpEndpoint,
  buildRemoteMarkerScript,
  buildRemoteDoclingScript
};
