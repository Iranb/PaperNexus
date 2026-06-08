import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

test('analyzeCorpus dedupes mixed pdf and markdown sources for the same paper and prefers markdown as the active source', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mixed-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-mixed-corpus-'));
  const templateMarkdownPath = path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md');
  const pdfPath = path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.pdf');
  const markdownPath = path.join(tempCorpusRoot, 'retrieval-augmented-experiment-planning.md');
  const markerScriptPath = path.join(tempCorpusRoot, 'fake-marker.mjs');

  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(pdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(markerScriptPath, `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfArg = args[0];
const outputDir = args[args.indexOf('--output_dir') + 1];
const basename = path.basename(pdfArg, path.extname(pdfArg));
await fs.mkdir(outputDir, { recursive: true });
await fs.copyFile(${JSON.stringify(templateMarkdownPath)}, path.join(outputDir, \`\${basename}.md\`));
`, 'utf8');
    await fs.chmod(markerScriptPath, 0o755);

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const firstRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'mixed-paper-test',
      force: true,
      pdfParser: 'marker',
      markerCommand: markerScriptPath
    });

    const firstManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(firstRun.meta.paperCount, 1);
    assert.equal(firstRun.meta.sourceCount, 1);
    assert.equal(firstManifest.sources.length, 1);
    assert.equal(firstManifest.sources[0].kind, 'pdf');
    assert.equal(firstManifest.sources[0].activeInGraph, true);
    const stablePaperId = firstManifest.sources[0].paperId;

    await fs.copyFile(templateMarkdownPath, markdownPath);

    const secondRun = await analyzeCorpus(tempCorpusRoot, {
      name: 'mixed-paper-test',
      force: true,
      pdfParser: 'marker',
      markerCommand: markerScriptPath
    });

    const secondManifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const activeSources = secondManifest.sources.filter((entry) => entry.activeInGraph !== false);
    const duplicateSources = secondManifest.sources.filter((entry) => entry.activeInGraph === false);
    const fullCorpus = await corpusStore.loadCorpus(tempCorpusRoot);
    const paperNodes = fullCorpus.graph.nodes.filter((node) => node.type === 'Paper');

    assert.equal(secondRun.meta.paperCount, 1);
    assert.equal(secondRun.meta.sourceCount, 2);
    assert.equal(secondManifest.sources.length, 2);
    assert.equal(activeSources.length, 1);
    assert.equal(duplicateSources.length, 1);
    assert.equal(activeSources[0].kind, 'markdown');
    assert.equal(duplicateSources[0].kind, 'pdf');
    assert.equal(activeSources[0].paperId, stablePaperId);
    assert.equal(duplicateSources[0].paperId, stablePaperId);
    assert.equal(duplicateSources[0].duplicateOfSourceKey, activeSources[0].sourceKey);
    assert.equal(paperNodes.length, 1);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus ignores cross-platform metadata files during source discovery', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-metadata-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-metadata-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.mkdir(path.join(tempCorpusRoot, '__MACOSX'), { recursive: true });
    await fs.writeFile(path.join(tempCorpusRoot, 'paper.md'), '# Real Paper\n\n## Abstract\n\nKeep me.\n', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, '.DS_Store'), 'ignore me', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, '._paper.md'), 'ignore me too', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'Thumbs.db'), 'ignore windows metadata', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'desktop.ini'), 'ignore windows metadata', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, '__MACOSX', 'ghost.md'), '# Ghost\n', 'utf8');

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'metadata-ignore-test',
      force: true
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(result.meta.paperCount, 1);
    assert.equal(result.meta.sourceCount, 1);
    assert.equal(manifest.sources.length, 1);
    assert.equal(path.basename(manifest.sources[0].sourcePath), 'paper.md');
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus does not collapse different papers when their parsed titles degrade to section headings', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-degenerate-title-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-degenerate-title-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(path.join(tempCorpusRoot, 'paper-a.md'), '## Abstract\n\nKeep this paper distinct.\n', 'utf8');
    await fs.writeFile(path.join(tempCorpusRoot, 'paper-b.md'), '## Abstract\n\nThis should not merge into paper-a.\n', 'utf8');

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'degenerate-title-test',
      force: true
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const activeSources = manifest.sources.filter((entry) => entry.activeInGraph !== false);

    assert.equal(result.meta.paperCount, 2);
    assert.equal(manifest.sources.length, 2);
    assert.equal(activeSources.length, 2);
    assert.deepEqual(
      activeSources.map((entry) => entry.paperTitle).sort(),
      ['paper-a', 'paper-b']
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus refreshes stale cached pdf snapshots when the stored title is already degenerate', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-stale-title-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-stale-title-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const pdfPath = path.join(tempCorpusRoot, 'paper-a.pdf');
  const fakeMarkPdfDownPath = path.join(tempCorpusRoot, 'fake-markpdfdown.sh');
  const fakeDoclingPath = path.join(tempCorpusRoot, 'fake-docling.sh');

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(pdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(
      fakeMarkPdfDownPath,
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
        '## Abstract',
        '',
        'Stale primary parser output.',
        'EOF'
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
        'printf "# Recovered %s\\n\\n## Abstract\\n\\nDocling repaired this title.\\n" "$base" > "$out_dir/$base.md"'
      ].join('\n'),
      { mode: 0o755 }
    );

    const [{ analyzeCorpus }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const stats = await fs.stat(pdfPath);
    const fingerprint = `${Math.round(Number(stats.mtimeMs || 0))}:${Number(stats.size || 0)}`;
    const sourceKey = pdfPath;
    const { markdownDir } = corpusStore.getCorpusPaths(tempCorpusRoot);
    const staleCachePath = path.join(markdownDir, 'markpdfdown', 'paper-a.md');
    await fs.mkdir(path.dirname(staleCachePath), { recursive: true });
    await fs.writeFile(staleCachePath, '## Abstract\n\nPersisted bad cache.\n', 'utf8');

    await corpusStore.saveSemanticPaperSnapshot(tempCorpusRoot, sourceKey, {
      paperId: 'paper:stale',
      paperTitle: 'paper-a',
      titleValidation: {
        isValid: false,
        rawTitle: 'Abstract',
        fallbackTitle: 'paper-a',
        usedFallbackTitle: true,
        needsReparse: true,
        reason: 'section-heading'
      },
      authors: [],
      abstract: 'Persisted bad cache.',
      sourcePath: pdfPath,
      sourceMarkdownPath: staleCachePath,
      sourcePdfPath: pdfPath,
      sourceKind: 'pdf',
      sourceFingerprint: fingerprint,
      sourceKey,
      references: [],
      problems: [],
      methods: [],
      datasets: [],
      benchmarks: [],
      metrics: [],
      claims: [],
      findings: [],
      researchGoals: [],
      researchQuestions: [],
      openChallenges: [],
      takeaways: [],
      ideaFragments: [],
      limitations: [],
      assumptions: [],
      evidences: [],
      futureDirections: [],
      llm: {
        provider: 'disabled',
        error: null,
        relationCount: 0,
        semanticExtractionMode: 'heuristic-only',
        semanticExtractionModeEffective: 'heuristic-only',
        semanticExtractionAttempted: false,
        semanticExtractionParticipated: false,
        semanticExtractionParticipationReason: 'mode-disabled',
        semanticObjectCount: 0
      },
      llmSemanticObjects: {
        provider: 'disabled',
        semanticMetadata: null,
        semanticExtractionParticipated: false
      }
    });
    await corpusStore.saveSourceManifest(tempCorpusRoot, {
      version: 4,
      corpusName: 'stale-title-refresh',
      rootPath: tempCorpusRoot,
      inputPath: tempCorpusRoot,
      inputPaths: [tempCorpusRoot],
      sourceMode: 'directory',
      pdfParser: 'markpdfdown',
      pdfCommand: fakeMarkPdfDownPath,
      semanticExtractionMode: 'heuristic-only',
      indexedAt: new Date().toISOString(),
      lastChangeSummary: { added: 1, updated: 0, removed: 0, reused: 0 },
      sources: [
        {
          sourceKey,
          inputPath: pdfPath,
          kind: 'pdf',
          fingerprint,
          sourceFingerprint: fingerprint,
          sourceMtimeMs: Number(stats.mtimeMs || 0),
          sourceSizeBytes: Number(stats.size || 0),
          paperId: 'paper:stale',
          paperTitle: 'paper-a',
          sourcePath: pdfPath,
          sourceMarkdownPath: staleCachePath,
          sourcePdfPath: pdfPath,
          markdownCachePath: staleCachePath,
          markdownCacheFingerprint: fingerprint,
          markdownCacheExists: true,
          markdownCacheStatus: 'reused',
          materializedFrom: 'markdown-cache',
          markerCommand: fakeMarkPdfDownPath,
          snapshotPath: path.relative(tempCorpusRoot, corpusStore.getSemanticPaperSnapshotPath(tempCorpusRoot, sourceKey)),
          snapshotStateSignature: null,
          activeInGraph: true,
          canonicalSourceKey: sourceKey,
          duplicateOfSourceKey: null,
          duplicateSourceCount: 1,
          availableSourceKinds: ['pdf']
        }
      ],
      llmOptimization: null
    });

    const result = await analyzeCorpus(tempCorpusRoot, {
      name: 'stale-title-refresh',
      pdfParser: 'markpdfdown',
      markpdfdownPython: fakeMarkPdfDownPath,
      doclingCommand: fakeDoclingPath
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(result.meta.paperCount, 1);
    assert.equal(manifest.sources[0].paperTitle, 'Recovered paper-a');
    assert.match(manifest.sources[0].sourceMarkdownPath, /docling/);
    assert.equal(manifest.sources[0].activeInGraph, true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('analyzeCorpus repairs a degenerate PDF title without Docling when primary markdown content is usable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-title-repair-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-title-repair-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const pdfPath = path.join(tempCorpusRoot, 'usable-primary.pdf');
  const fakeMarkerPath = path.join(tempCorpusRoot, 'fake-marker.mjs');
  const fakeDoclingPath = path.join(tempCorpusRoot, 'fake-docling.sh');

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(pdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(
      fakeMarkerPath,
      `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfArg = args[0];
const outputDir = args[args.indexOf('--output_dir') + 1];
const basename = path.basename(pdfArg, path.extname(pdfArg));
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, \`\${basename}.md\`), \`## Abstract

This primary parser lost the title but preserved a long and useful abstract about queue scheduling, import isolation, semantic extraction, graph updates, fallback prevention, and operational monitoring. This paragraph is intentionally verbose so PaperNexus can trust the markdown body even though the first heading is a section label rather than a real paper title.

## Introduction

The body continues with enough scientific text to avoid a Docling fallback. It describes how parser output can be useful even when metadata extraction fails, and why a filename fallback is safer than invoking a GPU parser for every title-only defect. The queue should therefore avoid spending GPU time on documents whose markdown body is already materialized with coherent sections and evidence.

## Method

We evaluate parser quality with body length and section structure before deciding whether a title defect requires a second parser. This keeps import throughput high while preserving a route to Docling when the extracted markdown is genuinely too sparse.
\`);
`,
      'utf8'
    );
    await fs.chmod(fakeMarkerPath, 0o755);
    await fs.writeFile(
      fakeDoclingPath,
      [
        '#!/bin/sh',
        'echo "docling should not be called for usable primary markdown" >&2',
        'exit 42'
      ].join('\n'),
      { mode: 0o755 }
    );

    const [ingestion, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    const result = await ingestion.analyzeCorpus(tempCorpusRoot, {
      name: 'title-repair-test',
      force: true,
      pdfParser: 'marker',
      markerCommand: fakeMarkerPath,
      doclingCommand: fakeDoclingPath
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(result.meta.paperCount, 1);
    assert.equal(manifest.sources[0].paperTitle, 'usable-primary');
    assert.match(manifest.sources[0].sourceMarkdownPath, /marker/);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    assert.equal(snapshot.titleValidation.repairedFromDegenerateTitle, true);
    assert.equal(snapshot.titleValidation.needsReparse, false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('import task metadata title overrides a misleading PDF parser title', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-title-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-import-title-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const fakeMarkerPath = path.join(tempCorpusRoot, 'fake-marker.mjs');
  const trustedTitle = 'Decouple Your Discovery and Memory in Continual Generalized Category Discovery';

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    const [ingestion, corpusStore, importStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/storage/import-store.js')
    ]);
    const taskId = 'imp:metadata-title-override-test';
    const taskPaths = importStore.getImportTaskPaths(tempCorpusRoot, taskId);
    const pdfPath = path.join(taskPaths.sourcesDir, 'dydm-cvpr2026.pdf');

    await fs.mkdir(taskPaths.sourcesDir, { recursive: true });
    await fs.writeFile(pdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(taskPaths.taskPath, JSON.stringify({
      id: taskId,
      files: [
        {
          storedPath: pdfPath,
          kind: 'pdf',
          contentSha256: 'sha256:test-dydm-title',
          paperMetadata: {
            sourceProvider: 'cvf_openaccess',
            title: trustedTitle
          }
        }
      ]
    }), 'utf8');
    await fs.writeFile(
      fakeMarkerPath,
      `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const pdfArg = args[0];
const outputDir = args[args.indexOf('--output_dir') + 1];
const basename = path.basename(pdfArg, path.extname(pdfArg));
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, \`\${basename}.md\`), \`# This CVPR paper is the Open Access version, provided by the Computer Vision Foundation.

## Abstract

The actual paper studies continual generalized category discovery by decoupling discovery and memory. It proposes separate mechanisms for discovering novel categories and preserving memory of seen categories in class-incremental generalized category discovery. The abstract text is intentionally long enough to be treated as a usable parser result even though the first heading is a publisher header rather than the scientific title.

## Introduction

Continual generalized category discovery requires recognizing labeled known categories while discovering unlabeled novel categories across stages. The method balances stability and plasticity by maintaining memory while allowing discovery of new classes under distribution shift. This paragraph provides enough body content for the normal materialization path.

## Method

The method includes decoupled discovery and memory components, prototype updates, and learning objectives that preserve old knowledge while separating novel class structure.
\`);
`,
      'utf8'
    );
    await fs.chmod(fakeMarkerPath, 0o755);

    const result = await ingestion.analyzeCorpus(taskPaths.sourcesDir, {
      name: 'import-title-override-test',
      rootPath: tempCorpusRoot,
      force: true,
      pdfParser: 'marker',
      markerCommand: fakeMarkerPath,
      includeActiveImportSources: false,
      includePersistentImportSources: false,
      enableLlmEnrichment: false
    });

    const manifest = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const snapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, manifest.sources[0].sourceKey);
    const corpus = await corpusStore.loadCorpus(tempCorpusRoot);
    const paperNode = corpus.graph.nodes.find((node) => node.type === 'Paper');

    assert.equal(result.meta.paperCount, 1);
    assert.equal(manifest.sources[0].paperTitle, trustedTitle);
    assert.equal(manifest.sources[0].canonicalId, 'title:decouple your discovery and memory in continual generalized category discovery');
    assert.equal(manifest.sources[0].paperMetadata.title, trustedTitle);
    assert.equal(manifest.sources[0].paperMetadata.metadataTitleTrusted, true);
    assert.equal(snapshot.paperTitle, trustedTitle);
    assert.equal(snapshot.titleValidation.metadataTitleOverride, true);
    assert.equal(snapshot.titleValidation.originalParsedTitle, 'This CVPR paper is the Open Access version, provided by the Computer Vision Foundation.');
    assert.equal(paperNode.name, trustedTitle);
    assert.equal(paperNode.properties.paperTitle, trustedTitle);
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('paper refresh prefers an explicitly selected PDF server path and reruns the PDF input flow', async () => {
  const { __pipelineTestables } = await import('../src/core/ingestion/pipeline.js');
  const entry = {
    sourceKey: '/tmp/papers/paper.md',
    kind: 'markdown',
    inputPath: '/tmp/papers/paper.md',
    sourcePath: '/tmp/papers/paper.md',
    sourceMarkdownPath: '/tmp/papers/paper.md',
    sourcePdfPath: '/tmp/papers/paper.pdf',
    markdownCachePath: '/tmp/cache/paper.md'
  };

  const selected = __pipelineTestables.resolvePaperRefreshInputSpec(entry, {
    source: '/tmp/papers/paper.pdf'
  });
  assert.equal(selected.inputPath, '/tmp/papers/paper.pdf');
  assert.equal(selected.kind, 'pdf');
  assert.equal(selected.selectedBy, 'requested-source');

  const fallback = __pipelineTestables.resolvePaperRefreshInputSpec(entry, {});
  assert.equal(fallback.inputPath, '/tmp/papers/paper.md');
  assert.equal(fallback.kind, 'markdown');
  assert.equal(fallback.selectedBy, 'manifest-input');
});

test('scrubDegeneratePapers removes degenerate-title papers from the graph even when the source file still exists', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scrub-degenerate-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scrub-degenerate-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const badPdfPath = path.join(tempCorpusRoot, 'bad-paper.pdf');
  const goodMarkdownPath = path.join(tempCorpusRoot, 'good-paper.md');
  const fakeDoclingPath = path.join(tempCorpusRoot, 'fake-docling.sh');

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(badPdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(goodMarkdownPath, '# Good Paper\n\n## Abstract\n\nKeep me.\n', 'utf8');
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
        'mkdir -p "$out_dir"',
        'base="$(basename "$pdf_path" .pdf)"',
        'cat > "$out_dir/$base.md" <<\'EOF\'',
        '## Abstract',
        '',
        'Degenerate parser output.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    const [{ analyzeCorpus, scrubDegeneratePapers }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'scrub-degenerate-direct-test',
      force: true,
      pdfParser: 'docling',
      doclingCommand: fakeDoclingPath
    });

    const manifestBefore = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(manifestBefore.sources.length, 2);

    const result = await scrubDegeneratePapers(tempCorpusRoot, {
      rootPath: tempCorpusRoot,
      quiet: true
    });

    assert.equal(result.removedSourceCount, 1);
    assert.equal(result.purgedMissingSourceCount, 0);
    assert.equal(result.meta.paperCount, 1);

    const manifestAfter = await corpusStore.loadSourceManifest(tempCorpusRoot);
    assert.equal(manifestAfter.sources.length, 1);
    assert.equal(path.basename(manifestAfter.sources[0].inputPath), 'good-paper.md');

    const corpus = await corpusStore.loadCorpus(tempCorpusRoot);
    const paperNodes = corpus.graph.nodes.filter((node) => node.type === 'Paper');
    assert.equal(paperNodes.length, 1);
    assert.equal(paperNodes[0].name, 'Good Paper');
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('scrubDegeneratePapers rebuilds missing snapshots for retained papers before pruning degenerate entries', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scrub-recover-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-scrub-recover-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const badPdfPath = path.join(tempCorpusRoot, 'bad-paper.pdf');
  const goodMarkdownPath = path.join(tempCorpusRoot, 'good-paper.md');
  const fakeDoclingPath = path.join(tempCorpusRoot, 'fake-docling.sh');

  try {
    process.env.PAPERNEXUS_HOME = tempHome;

    await fs.writeFile(badPdfPath, 'fake pdf payload\n', 'utf8');
    await fs.writeFile(goodMarkdownPath, '# Good Paper\n\n## Abstract\n\nKeep me.\n', 'utf8');
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
        'mkdir -p "$out_dir"',
        'base="$(basename "$pdf_path" .pdf)"',
        'cat > "$out_dir/$base.md" <<\'EOF\'',
        '## Abstract',
        '',
        'Degenerate parser output.',
        'EOF'
      ].join('\n'),
      { mode: 0o755 }
    );

    const [{ analyzeCorpus, scrubDegeneratePapers }, corpusStore] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/corpus-store.js')
    ]);

    await analyzeCorpus(tempCorpusRoot, {
      name: 'scrub-degenerate-recover-test',
      force: true,
      pdfParser: 'docling',
      doclingCommand: fakeDoclingPath
    });

    const manifestBefore = await corpusStore.loadSourceManifest(tempCorpusRoot);
    const goodEntry = manifestBefore.sources.find((entry) => path.basename(entry.inputPath) === 'good-paper.md');
    assert.ok(goodEntry, 'expected good-paper.md to be tracked');
    await corpusStore.removeSemanticPaperSnapshot(tempCorpusRoot, goodEntry.sourceKey);

    const result = await scrubDegeneratePapers(tempCorpusRoot, {
      rootPath: tempCorpusRoot,
      quiet: true
    });

    assert.equal(result.removedSourceCount, 1);
    const recoveredSnapshot = await corpusStore.loadSemanticPaperSnapshot(tempCorpusRoot, goodEntry.sourceKey);
    assert.ok(recoveredSnapshot, 'expected the retained paper snapshot to be rebuilt');
    assert.equal(recoveredSnapshot.paperTitle, 'Good Paper');
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERNEXUS_HOME;
    } else {
      process.env.PAPERNEXUS_HOME = previousHome;
    }

    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
