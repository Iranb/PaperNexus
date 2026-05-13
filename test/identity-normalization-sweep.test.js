import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runIdentityNormalizationSweep } from '../scripts/sweep-identity-normalization.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function identityBenchmark() {
  return {
    name: 'identity-normalization-fixture',
    format: 'custom',
    corpus: [
      {
        id: 'title-doc',
        title: 'Exact Title Match Study'
      },
      {
        id: 's2-doc',
        title: 'Published Graph Contrastive Discovery',
        identifiers: {
          s2PaperId: 'S2ABC123'
        }
      },
      {
        id: 'openalex-doc',
        title: 'Journal Version of Neural Discovery',
        ids: {
          openalex: 'https://openalex.org/W123456789'
        }
      },
      {
        id: 'arxiv-doc',
        title: 'Arxiv Versioned Retrieval',
        identifiers: {
          arxivId: '2401.01234v2'
        }
      }
    ],
    queries: [
      {
        id: 'q-title',
        query: 'title case',
        relevant: [{ title: 'Exact Title Match Study' }]
      },
      {
        id: 'q-s2',
        query: 'semantic scholar id',
        relevant: [{
          title: 'Preprint Graph Contrastive Discovery',
          identifiers: {
            semanticScholarId: 's2abc123'
          }
        }]
      },
      {
        id: 'q-openalex',
        query: 'openalex id',
        relevant: [{
          title: 'Repository Version of Neural Discovery',
          identifiers: {
            openAlexId: 'W123456789'
          }
        }]
      },
      {
        id: 'q-arxiv',
        query: 'arxiv version',
        relevant: [{
          title: 'Arxiv Retrieval Preprint',
          identifiers: {
            arxivId: '2401.01234'
          }
        }]
      }
    ]
  };
}

test('identity normalization sweep reports expanded S2/OpenAlex/arXiv resolution lift', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identity-normalization-sweep-'));

  try {
    const report = await runIdentityNormalizationSweep({
      runId: 'test-identity-normalization-sweep',
      outputDir: tempRoot,
      benchmark: identityBenchmark()
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.rows.length, 16);
    assert.equal(report.summaries.length, 4);

    const summaries = Object.fromEntries(report.summaries.map((summary) => [summary.policy, summary]));
    assert.equal(summaries.baseline.resolvedGoldCount, 1);
    assert.equal(summaries['strong-identifiers'].resolvedGoldCount, 3);
    assert.equal(summaries['expanded-identifiers'].resolvedGoldCount, 3);
    assert.equal(summaries['expanded-with-title'].resolvedGoldCount, 4);
    assert.equal(summaries['expanded-with-title'].newResolutionsVsBaseline, 3);
    assert.equal(summaries['expanded-with-title'].resolvedByField.s2, 1);
    assert.equal(summaries['expanded-with-title'].resolvedByField.openalex, 1);
    assert.equal(summaries['expanded-with-title'].resolvedByField.arxiv_base, 1);
    assert.equal(summaries['expanded-with-title'].resolvedByField.title, 1);

    assert.ok(await fileExists(report.artifacts.manifestPath));
    assert.ok(await fileExists(report.artifacts.rowsPath));
    assert.ok(await fileExists(report.artifacts.unresolvedPath));
    assert.ok(await fileExists(report.artifacts.summaryTsvPath));
    assert.ok(await fileExists(report.artifacts.reportPath));
    assert.ok(await fileExists(report.artifacts.reportMarkdownPath));

    const summaryTsv = await fs.readFile(report.artifacts.summaryTsvPath, 'utf8');
    assert.match(summaryTsv, /policy\tgold_count\tresolved_gold\tresolution_rate/);
    assert.match(summaryTsv, /expanded-with-title\t4\t4\t1/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('identity normalization sweep CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-identity-normalization-sweep-cli-'));

  try {
    const benchmarkPath = path.join(tempRoot, 'benchmark.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(benchmarkPath, `${JSON.stringify(identityBenchmark(), null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/sweep-identity-normalization.mjs'),
      '--dataset-path', benchmarkPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-identity-normalization-sweep'
    ], {
      cwd: process.cwd()
    });

    const cliReport = JSON.parse(stdout);
    assert.equal(cliReport.runId, 'cli-identity-normalization-sweep');
    assert.equal(cliReport.status, 'completed');
    assert.equal(cliReport.outputDir, outputDir);
    assert.ok(await fileExists(path.join(outputDir, 'report.json')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
