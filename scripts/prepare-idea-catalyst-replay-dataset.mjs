#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readJson, writeJson } from '../src/lib/fs.js';
import { adaptIdeaCatalystReplayBenchmark, SUPPORTED_REPLAY_ADAPTER_FORMATS } from '../src/core/eval/replay-adapters.js';

function parseArgs(argv = []) {
  const parsed = {
    inputPath: '',
    outputPath: '',
    format: '',
    name: '',
    timeCutoff: null,
    candidatePacketPath: '',
    baselinePacketPath: '',
    candidatePacketsPath: '',
    baselinePacketsPath: '',
    datasetSource: '',
    licenseScope: ''
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input-path') {
      parsed.inputPath = next || '';
      index += 1;
    } else if (arg === '--output-path') {
      parsed.outputPath = next || '';
      index += 1;
    } else if (arg === '--format') {
      parsed.format = next || '';
      index += 1;
    } else if (arg === '--name') {
      parsed.name = next || '';
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
    } else if (arg === '--dataset-source') {
      parsed.datasetSource = next || '';
      index += 1;
    } else if (arg === '--license-scope') {
      parsed.licenseScope = next || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    'Usage: node scripts/prepare-idea-catalyst-replay-dataset.mjs --input-path raw.json --output-path replay.json [options]',
    '',
    'Options:',
    `  --format FORMAT             One of: ${SUPPORTED_REPLAY_ADAPTER_FORMATS.join(', ')}`,
    '  --name NAME                 Override replay dataset name',
    '  --time-cutoff YEAR          Force a replay cutoff year when raw cases do not provide one',
    '  --candidate-packet FILE     Candidate packet used for all cases without case-specific packets',
    '  --baseline-packet FILE      Baseline packet used for all cases without case-specific packets',
    '  --candidate-packets-path FILE  JSON object/array keyed by case id for candidate packets',
    '  --baseline-packets-path FILE   JSON object/array keyed by case id for baseline packets',
    '  --dataset-source TEXT       Released dataset URL, DOI, snapshot id, or internal source label',
    '  --license-scope TEXT        Dataset license or internal-use scope recorded in replay provenance'
  ].join('\n');
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function resolveOptionalPath(filePath = '') {
  const text = compactText(filePath);
  return text ? path.resolve(process.cwd(), text) : '';
}

async function hashFile(absolutePath = '') {
  if (!absolutePath) return null;
  const data = await fs.readFile(absolutePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function fileInputRecord(role, filePath = '') {
  const absolutePath = resolveOptionalPath(filePath);
  if (!absolutePath) return null;
  const [stats, sha256] = await Promise.all([
    fs.stat(absolutePath),
    hashFile(absolutePath)
  ]);
  return {
    role,
    path: absolutePath,
    size_bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    sha256
  };
}

async function buildInputRecords(args = {}) {
  const records = await Promise.all([
    fileInputRecord('raw_dataset', args.inputPath),
    fileInputRecord('candidate_packet', args.candidatePacketPath),
    fileInputRecord('baseline_packet', args.baselinePacketPath),
    fileInputRecord('candidate_packet_map', args.candidatePacketsPath),
    fileInputRecord('baseline_packet_map', args.baselinePacketsPath)
  ]);
  return records.filter(Boolean);
}

function attachReplayProvenance(replay = {}, args = {}, inputs = []) {
  const datasetSource = compactText(args.datasetSource);
  const licenseScope = compactText(args.licenseScope);
  const provenance = {
    dataset_source: datasetSource,
    license_scope: licenseScope,
    inputs
  };
  return {
    ...replay,
    dataset_source: datasetSource,
    license_scope: licenseScope,
    inputs,
    provenance
  };
}

async function readOptionalJson(filePath = '') {
  return filePath ? readJson(filePath, {}) : {};
}

export async function prepareIdeaCatalystReplayDatasetCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage() };
  if (!args.inputPath) throw new Error('--input-path is required.');
  if (!args.outputPath) throw new Error('--output-path is required.');

  const input = await readJson(args.inputPath);
  const replay = adaptIdeaCatalystReplayBenchmark(input, {
    format: args.format || undefined,
    name: args.name || undefined,
    timeCutoff: Number.isFinite(args.timeCutoff) ? args.timeCutoff : undefined,
    candidatePacket: await readOptionalJson(args.candidatePacketPath),
    baselinePacket: await readOptionalJson(args.baselinePacketPath),
    candidatePackets: await readOptionalJson(args.candidatePacketsPath),
    baselinePackets: await readOptionalJson(args.baselinePacketsPath)
  });
  const inputs = await buildInputRecords(args);
  const output = attachReplayProvenance(replay, args, inputs);
  await writeJson(args.outputPath, output);
  return {
    outputPath: args.outputPath,
    format: output.format,
    case_count: output.cases.length,
    input_count: inputs.length,
    input_hash_count: inputs.filter((entry) => entry.sha256).length,
    adapter_diagnostics: output.adapter_diagnostics
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareIdeaCatalystReplayDatasetCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    })
    .catch((error) => {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    });
}
