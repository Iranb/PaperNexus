#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import {
  collectReleaseGateEvidenceInputs,
  collectReleaseEvidenceLineageArtifacts,
  collectReleaseEvidenceSourceSnapshots,
  createReleaseEvidenceBundleSkeleton,
  prepareReleaseEvidenceBundleAudit,
  REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES
} from '../src/core/eval/release-evidence-bundle.js';

function parseArgs(argv = []) {
  const parsed = {
    bundleDir: '',
    bundleManifestPath: '',
    outputDir: '',
    runId: '',
    releaseScope: '',
    initSkeleton: false,
    collectReleaseGateInputs: false,
    evidenceRoot: '',
    releaseGateManifestPath: '',
    overwriteReleaseGateInputs: false,
    collectLineageArtifacts: false,
    artifactRoot: '',
    overwriteLineageArtifacts: false,
    collectSourceSnapshots: false,
    sourceRoot: '',
    overwriteSourceSnapshots: false,
    requirePassed: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--bundle-dir') {
      parsed.bundleDir = next || '';
      index += 1;
    } else if (arg === '--bundle-manifest') {
      parsed.bundleManifestPath = next || '';
      index += 1;
    } else if (arg === '--output-dir') {
      parsed.outputDir = next || '';
      index += 1;
    } else if (arg === '--run-id') {
      parsed.runId = next || '';
      index += 1;
    } else if (arg === '--scope' || arg === '--release-scope') {
      parsed.releaseScope = next || '';
      index += 1;
    } else if (arg === '--init-skeleton' || arg === '--create-skeleton') {
      parsed.initSkeleton = true;
    } else if (arg === '--collect-release-gate-inputs') {
      parsed.collectReleaseGateInputs = true;
    } else if (arg === '--evidence-root') {
      parsed.evidenceRoot = next || '';
      index += 1;
    } else if (arg === '--release-gate-manifest') {
      parsed.releaseGateManifestPath = next || '';
      index += 1;
    } else if (arg === '--overwrite-release-gate-inputs') {
      parsed.overwriteReleaseGateInputs = true;
    } else if (arg === '--collect-lineage-artifacts') {
      parsed.collectLineageArtifacts = true;
    } else if (arg === '--artifact-root') {
      parsed.artifactRoot = next || '';
      index += 1;
    } else if (arg === '--overwrite-lineage-artifacts') {
      parsed.overwriteLineageArtifacts = true;
    } else if (arg === '--collect-source-snapshots') {
      parsed.collectSourceSnapshots = true;
    } else if (arg === '--source-root') {
      parsed.sourceRoot = next || '';
      index += 1;
    } else if (arg === '--overwrite-source-snapshots') {
      parsed.overwriteSourceSnapshots = true;
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
    'Usage: node scripts/prepare-release-evidence-bundle.mjs --bundle-dir DIR [options]',
    '',
    'Audits a final release evidence bundle directory for required artifacts, hashes, logs, and release-gate input coverage.',
    '',
    'Required artifact roles in the bundle manifest:',
    `  ${REQUIRED_RELEASE_EVIDENCE_BUNDLE_ROLES.join(', ')}`,
    '',
    'Options:',
    '  --bundle-manifest FILE      Bundle manifest JSON; default DIR/release-evidence-bundle.json',
    '  --output-dir DIR            Output directory for release-evidence-bundle-audit.json; default bundle dir',
    '  --run-id ID                 Stable run id for the audit report',
    '  --scope full|p0-p1          Expected release gate scope; also accepted from bundle manifest releaseScope',
    '  --init-skeleton             Create a non-passing bundle manifest, directories, and TODO checklist without creating evidence',
    '  --collect-release-gate-inputs Copy the release gate manifest and its hashed evidence_inputs into canonical bundle paths',
    '  --evidence-root DIR         Root for release-gate evidence input collection; default current directory',
    '  --release-gate-manifest FILE Release gate manifest to copy; default manifest artifact or DIR/release-gate-manifest.json',
    '  --overwrite-release-gate-inputs Replace existing release-gate input files when their hash differs',
    '  --collect-lineage-artifacts Copy R1-SIG/R2/R3/AB1 files referenced by bundled reports into canonical bundle paths',
    '  --artifact-root DIR         Root for lineage artifact collection; default current directory',
    '  --overwrite-lineage-artifacts Replace existing lineage artifacts when their hash differs',
    '  --collect-source-snapshots  Copy T1/D1 source files referenced by bundled engineering/docs-sync reports into source/',
    '  --source-root DIR           Repository root for source snapshot collection; default current directory',
    '  --overwrite-source-snapshots Replace existing source snapshots when their hash differs',
    '  --require-passed            Exit non-zero unless the bundle audit status is passed'
  ].join('\n');
}

export async function prepareReleaseEvidenceBundleCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return { help: usage(), requirePassed: false };
  if (!args.bundleDir) throw new Error('--bundle-dir is required.');
  if (args.initSkeleton) {
    return createReleaseEvidenceBundleSkeleton({
      bundleDir: args.bundleDir,
      runId: args.runId || undefined,
      releaseScope: args.releaseScope || undefined
    });
  }
  const collectionResults = [];
  if (args.collectReleaseGateInputs) {
    collectionResults.push(await collectReleaseGateEvidenceInputs({
      bundleDir: args.bundleDir,
      bundleManifestPath: args.bundleManifestPath || undefined,
      evidenceRoot: args.evidenceRoot || undefined,
      releaseGateManifestPath: args.releaseGateManifestPath || undefined,
      overwriteReleaseGateInputs: args.overwriteReleaseGateInputs
    }));
  }
  if (args.collectLineageArtifacts) {
    collectionResults.push(await collectReleaseEvidenceLineageArtifacts({
      bundleDir: args.bundleDir,
      bundleManifestPath: args.bundleManifestPath || undefined,
      artifactRoot: args.artifactRoot || undefined,
      overwriteLineageArtifacts: args.overwriteLineageArtifacts
    }));
  }
  if (args.collectSourceSnapshots) {
    collectionResults.push(await collectReleaseEvidenceSourceSnapshots({
      bundleDir: args.bundleDir,
      bundleManifestPath: args.bundleManifestPath || undefined,
      sourceRoot: args.sourceRoot || undefined,
      overwriteSourceSnapshots: args.overwriteSourceSnapshots
    }));
  }
  if (collectionResults.length === 1) return collectionResults[0];
  if (collectionResults.length > 1) {
    return {
      status: collectionResults.every((entry) => !['incomplete', 'failed'].includes(entry.status))
        ? 'collection_steps_completed'
        : 'incomplete',
      results: collectionResults
    };
  }
  const report = await prepareReleaseEvidenceBundleAudit({
    bundleDir: args.bundleDir,
    bundleManifestPath: args.bundleManifestPath || undefined,
    outputDir: args.outputDir || undefined,
    runId: args.runId || undefined,
    releaseScope: args.releaseScope || undefined
  });
  return {
    ...report,
    requirePassed: args.requirePassed
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareReleaseEvidenceBundleCli()
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
