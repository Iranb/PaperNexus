#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, writeJson, writeText } from '../src/lib/fs.js';

const CONTRACT_VERSION = 'papernexus-graph-ablation-artifact-contract-v1';

function usage() {
  return [
    'Usage:',
    '  node scripts/generate-graph-ablation-artifact-contract.mjs [options]',
    '',
    'Options:',
    '  --run-id <id>',
    '  --output-dir <dir>',
    '',
    'Writes the required JSON contract and a not-for-paper template for frozen',
    'real-corpus graph ablation benchmark artifacts.'
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const equalsIndex = arg.indexOf('=');
    const rawKey = equalsIndex >= 0 ? arg.slice(2, equalsIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
    if (inlineValue !== undefined) {
      raw[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      raw[key] = next;
      index += 1;
    } else {
      raw[key] = 'true';
    }
  }

  const runId = raw.runId || `graph-ablation-artifact-contract-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return {
    help: raw.help,
    runId,
    outputDir: path.resolve(raw.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-artifacts', runId))
  };
}

function buildContract() {
  return {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-artifact-contract',
    requiredTopLevelFields: [
      'name',
      'format',
      'frozen',
      'humanReviewRequired',
      'generationScript',
      'corpus',
      'graph.edges',
      'queries'
    ],
    paperReadyRequirements: [
      'frozen must be true',
      'humanReviewRequired must be false',
      'synthetic and syntheticGraph must be absent or false',
      'generationScript must identify the local script or reproducible process that produced the artifact',
      'corpus must contain stable paper ids',
      'graph.edges must contain real source/target ids that resolve into corpus ids',
      'queries must contain graphSeeds/sourcePaperId values that resolve into corpus ids',
      'queries must contain relevant/qrels/goldPapers labels that resolve into corpus ids',
      'query count must meet the preflight --min-queries threshold, default 30'
    ],
    fieldShape: {
      name: 'string',
      format: 'custom',
      frozen: 'boolean true for paper-ready artifacts',
      humanReviewRequired: 'boolean false for paper-ready artifacts',
      generationScript: 'string path or reproducible command',
      synthetic: 'optional boolean; true forces not_paper_ready',
      corpus: [
        {
          id: 'stable paper id',
          title: 'paper title',
          abstract: 'paper abstract or text',
          identifiers: {
            doi: 'optional DOI',
            arxivId: 'optional arXiv id',
            semanticScholarId: 'optional Semantic Scholar id'
          }
        }
      ],
      graph: {
        edges: [
          {
            source: 'corpus paper id',
            target: 'corpus paper id',
            type: 'cites|uses|extends|improves|compares|related|...',
            evidence: 'optional source or provenance note'
          }
        ]
      },
      queries: [
        {
          id: 'stable query id',
          query: 'query text',
          graphSeeds: ['corpus paper id'],
          relationTypes: ['optional relation filter'],
          relevant: [
            {
              id: 'corpus paper id',
              title: 'optional title'
            }
          ]
        }
      ]
    }
  };
}

function buildTemplate() {
  return {
    name: 'replace-with-frozen-real-corpus-graph-artifact-name',
    format: 'custom',
    frozen: false,
    syntheticGraph: true,
    humanReviewRequired: false,
    generationScript: 'replace-with-script-or-command-that-generated-this-artifact',
    corpus: [
      {
        id: 'paper-1',
        title: 'Source paper title',
        abstract: 'Source paper text.',
        identifiers: {}
      },
      {
        id: 'paper-2',
        title: 'Relevant graph neighbor title',
        abstract: 'Relevant paper text.',
        identifiers: {}
      }
    ],
    graph: {
      edges: [
        {
          source: 'paper-1',
          target: 'paper-2',
          type: 'uses',
          evidence: 'Replace with real graph provenance. This template is synthetic and not paper-ready.'
        }
      ]
    },
    queries: [
      {
        id: 'query-1',
        query: 'replace with fixed evaluation query',
        graphSeeds: ['paper-1'],
        relationTypes: ['uses'],
        relevant: [
          {
            id: 'paper-2',
            title: 'Relevant graph neighbor title'
          }
        ]
      }
    ]
  };
}

function renderMarkdown(contract = {}) {
  return [
    '# Graph Ablation Artifact Contract',
    '',
    `Contract version: \`${contract.contractVersion}\``,
    '',
    '## Required Fields',
    '',
    ...contract.requiredTopLevelFields.map((field) => `- \`${field}\``),
    '',
    '## Paper-Ready Requirements',
    '',
    ...contract.paperReadyRequirements.map((requirement) => `- ${requirement}`),
    '',
    '## Validation Loop',
    '',
    '1. Build a candidate JSON artifact from real local graph-aware data.',
    '2. Run `scripts/prepare-graph-ablation-artifact.mjs` on the candidate.',
    '3. Run `scripts/benchmark-graph-ranking-ablation.mjs` only if preflight returns `paper_ready`.',
    '4. Add graph results to the paper only after appendix integration and PDF compilation.'
  ].join('\n') + '\n';
}

export async function runGraphAblationArtifactContract(inputOptions = {}) {
  const runId = inputOptions.runId || `graph-ablation-artifact-contract-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = path.resolve(inputOptions.outputDir || path.join('.papernexus', 'paper-revision', 'graph-ablation-artifacts', runId));
  const artifacts = {
    contractPath: path.join(outputDir, 'graph-ablation-artifact-contract.json'),
    markdownPath: path.join(outputDir, 'graph-ablation-artifact-contract.md'),
    templatePath: path.join(outputDir, 'graph-ablation-artifact-template.not-paper-ready.json'),
    manifestPath: path.join(outputDir, 'graph-ablation-artifact-contract-manifest.json')
  };
  const contract = buildContract();
  const template = buildTemplate();
  const report = {
    contractVersion: CONTRACT_VERSION,
    kind: 'graph-ablation-artifact-contract-report',
    runId,
    status: 'completed',
    createdAt: new Date().toISOString(),
    artifacts
  };

  await ensureDir(outputDir);
  await writeJson(artifacts.contractPath, contract);
  await writeText(artifacts.markdownPath, renderMarkdown(contract));
  await writeJson(artifacts.templatePath, template);
  await writeJson(artifacts.manifestPath, {
    ...report,
    machine: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    boundary: 'The template is synthetic and intentionally not paper-ready. It documents shape only.'
  });

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    runGraphAblationArtifactContract(options)
      .then((report) => {
        process.stdout.write(`${JSON.stringify({
          runId: report.runId,
          status: report.status,
          outputDir: path.dirname(report.artifacts.contractPath),
          contractPath: report.artifacts.contractPath,
          templatePath: report.artifacts.templatePath
        }, null, 2)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
