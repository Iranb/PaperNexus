#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readJson } from '../src/lib/fs.js';
import { SUPPORTED_REPLAY_ADAPTER_FORMATS } from '../src/core/eval/replay-adapters.js';
import { runIdeaCatalystReplaySuite } from '../src/core/eval/replay-suite.js';

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv = []) {
  const parsed = {
    inputPath: '',
    outputDir: '',
    format: '',
    name: '',
    runId: '',
    timeCutoff: null,
    candidatePacketPath: '',
    baselinePacketPath: '',
    candidatePacketsPath: '',
    baselinePacketsPath: '',
    cutoffs: [],
    primaryCutoff: null,
    thresholdsRaw: '',
    thresholdsPath: '',
    statisticalEvidenceRaw: '',
    statisticalEvidencePath: '',
    datasetSource: '',
    licenseScope: '',
    holdoutPolicy: '',
    timeSlicePolicy: '',
    requirePassed: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input-path') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--format') {
      parsed.format = next || '';
      index += 1;
    } else if (arg === '--name') {
      parsed.name = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--time-cutoff') {
      parsed.timeCutoff = Number(next);
      index += 1;
    } else if (arg === '--candidate-packet') {
      parsed.candidatePacketPath = next || '';
      index += 1;
    } else if (arg === '--baseline-packet') {
      parsed.baselinePacketPath = next || '';
      index += 1;
    } else if (arg === '--candidate-packets-path') {
      parsed.candidatePacketsPath = next || '';
      index += 1;
    } else if (arg === '--baseline-packets-path') {
      parsed.baselinePacketsPath = next || '';
      index += 1;
    } else if (arg === '--cutoffs') {
      parsed.cutoffs = parseList(next).map(Number).filter(Number.isFinite);
      index += 1;
    } else if (arg === '--primary-cutoff') {
      parsed.primaryCutoff = Number(next);
      index += 1;
    } else if (arg === '--thresholds-json') {
      parsed.thresholdsRaw = next || '';
      index += 1;
    } else if (arg === '--statistical-significance-json') {
      parsed.statisticalEvidenceRaw = next || '';
      index += 1;
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--holdout-policy') {
      parsed.holdoutPolicy = next || '';
      index += 1;
    } else if (arg === '--time-slice-policy') {
      parsed.timeSlicePolicy = next || '';
      index += 1;
    } else if (arg === '--require-passed') {
      parsed.requirePassed = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/run-idea-catalyst-replay-suite.mjs --input-path raw.json --output-dir DIR [options]',
    '',
    'Options:',
    `  --format FORMAT                One of: ${SUPPORTED_REPLAY_ADAPTER_FORMATS.join(', ')}`,
    '  --name NAME                    Override replay dataset name',
    '  --run-id ID                    Stable run id for artifacts and manifests',
    '  --time-cutoff YEAR             Force a replay cutoff year when raw cases do not provide one',
    '  --candidate-packet FILE        Candidate packet used for all cases without case-specific packets',
    '  --baseline-packet FILE         Baseline packet used for all cases without case-specific packets',
    '  --candidate-packets-path FILE  JSON object/array keyed by case id for candidate packets',
    '  --baseline-packets-path FILE   JSON object/array keyed by case id for baseline packets',
    '  --cutoffs 5,10,20              Must-cite Recall@K cutoffs',
    '  --primary-cutoff 20            K used by release gate',
    '  --thresholds-json JSON         Inline JSON thresholds or @path/to/thresholds.json',
    '  --statistical-significance-json JSON',
    '                                  Inline JSON or @path/to/statistical-significance.json with paired tests',
    '  --dataset-source TEXT          Released dataset URL, DOI, snapshot id, or internal source label',
    '  --license-scope TEXT           Dataset license or internal-use scope recorded in the suite manifest',
    '  --holdout-policy TEXT          Venue/year holdout policy recorded for release-readiness preflight',
    '  --time-slice-policy TEXT       OpenAlex/S2ORC/reference time-slice policy for release-readiness preflight',
    '  --require-passed               Exit non-zero unless the suite status is passed'
  ].join('\n');
}

async function parseThresholds(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return { thresholds: {}, thresholdsPath: '' };
  if (raw.startsWith('@')) {
    const thresholdsPath = raw.slice(1);
    return {
      thresholds: await readJson(thresholdsPath, {}),
      thresholdsPath
    };
  }
  return {
    thresholds: JSON.parse(raw),
    thresholdsPath: ''
  };
}

async function parseStatisticalEvidence(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return { statisticalSignificance: {}, statisticalEvidencePath: '' };
  if (raw.startsWith('@')) {
    const statisticalEvidencePath = raw.slice(1);
    return {
      statisticalSignificance: await readJson(statisticalEvidencePath, {}),
      statisticalEvidencePath
    };
  }
  return {
    statisticalSignificance: JSON.parse(raw),
    statisticalEvidencePath: ''
  };
}

export async function runIdeaCatalystReplaySuiteCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.inputPath) throw new Error('--input-path is required.');
  if (!args.outputDir) throw new Error('--output-dir is required.');
  const { thresholds, thresholdsPath } = await parseThresholds(args.thresholdsRaw);
  const { statisticalSignificance, statisticalEvidencePath } = await parseStatisticalEvidence(args.statisticalEvidenceRaw);
  const manifest = await runIdeaCatalystReplaySuite({
    inputPath: args.inputPath,
    outputDir: args.outputDir,
    format: args.format || undefined,
    name: args.name || undefined,
    runId: args.runId || undefined,
    timeCutoff: Number.isFinite(args.timeCutoff) ? args.timeCutoff : undefined,
    candidatePacketPath: args.candidatePacketPath,
    baselinePacketPath: args.baselinePacketPath,
    candidatePacketsPath: args.candidatePacketsPath,
    baselinePacketsPath: args.baselinePacketsPath,
    cutoffs: args.cutoffs.length ? args.cutoffs : undefined,
    primaryCutoff: Number.isFinite(args.primaryCutoff) ? args.primaryCutoff : undefined,
    thresholds,
    thresholdsPath,
    statisticalSignificance,
    statisticalEvidencePath,
    datasetSource: args.datasetSource,
    licenseScope: args.licenseScope,
    holdoutPolicy: args.holdoutPolicy,
    timeSlicePolicy: args.timeSlicePolicy
  });
  return {
    ...manifest,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIdeaCatalystReplaySuiteCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        const { requirePassed, ...payload } = result;
        console.log(JSON.stringify(payload, null, 2));
        if (requirePassed && payload.status !== 'passed') {
          process.exitCode = 1;
        }
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
