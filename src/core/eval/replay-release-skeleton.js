import path from 'node:path';

import { ensureDir, writeJson, writeText } from '../../lib/fs.js';
import { stableHash } from '../../lib/utils.js';

export const REPLAY_RELEASE_EVIDENCE_SKELETON_VERSION = 'papernexus-replay-release-evidence-skeleton-v1';

export const REQUIRED_REPLAY_RELEASE_FAMILIES = [
  {
    id: 'masterset',
    slug: 'masterset',
    label: 'MasterSet',
    evidence_family: 'must_cite',
    release_requirements: ['E4']
  },
  {
    id: 'novbench',
    slug: 'novbench',
    label: 'NovBench',
    evidence_family: 'novelty',
    release_requirements: ['E2']
  },
  {
    id: 'rinobench',
    slug: 'rinobench',
    label: 'RINoBench',
    evidence_family: 'novelty',
    release_requirements: ['E2']
  },
  {
    id: 'axiomatic_novelty',
    slug: 'axiomatic-novelty',
    label: 'axiomatic novelty benchmark',
    evidence_family: 'novelty',
    release_requirements: ['E2']
  },
  {
    id: 'claim_bench',
    slug: 'claim-bench',
    label: 'CLAIM-BENCH',
    evidence_family: 'claim_grounding',
    release_requirements: ['E3']
  },
  {
    id: 'claimcheck',
    slug: 'claimcheck',
    label: 'CLAIMCHECK',
    evidence_family: 'claim_grounding',
    release_requirements: ['E3']
  },
  {
    id: 'openreview',
    slug: 'openreview',
    label: 'OpenReview',
    evidence_family: 'historical_replay',
    release_requirements: ['E1', 'E6']
  },
  {
    id: 'peerread',
    slug: 'peerread',
    label: 'PeerRead',
    evidence_family: 'historical_replay',
    release_requirements: ['E1', 'E6']
  },
  {
    id: 'moprd',
    slug: 'moprd',
    label: 'MOPRD',
    evidence_family: 'historical_replay',
    release_requirements: ['E1', 'E6']
  },
  {
    id: 're2',
    slug: 're2',
    label: 'Re2 / Re²',
    evidence_family: 'historical_replay',
    release_requirements: ['E1', 'E6']
  }
];

export const REQUIRED_REPLAY_RELEASE_METADATA_FIELDS = [
  'source',
  'license_scope',
  'raw_input_sha256',
  'time_cutoff',
  'adapter_format',
  'holdout_policy',
  'time_slice_policy'
];

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function familyArtifactPaths(family = {}) {
  const slug = family.slug;
  return {
    raw_input: `raw-inputs/${slug}.json`,
    normalized_dataset: `normalized-datasets/${slug}-replay.json`,
    run_config: `run-configs/${slug}-run-config.json`,
    thresholds: `thresholds/${slug}-thresholds.json`,
    statistical_significance: `statistics/${slug}-statistical-significance.json`,
    replay_suite_manifest: `reports/${slug}/replay-suite-manifest.json`
  };
}

function replaySuiteCommand(family = {}) {
  const paths = familyArtifactPaths(family);
  return [
    'npm run eval:idea-catalyst-replay-suite --',
    `--input-path ${paths.raw_input}`,
    `--output-dir reports/${family.slug}`,
    `--name ${family.slug}`,
    `--thresholds-json @${paths.thresholds}`,
    `--statistical-significance-json @${paths.statistical_significance}`,
    '--dataset-source <source-url-or-snapshot-id>',
    '--license-scope <license-or-internal-scope>',
    '--holdout-policy <venue-year-holdout-policy>',
    '--time-slice-policy <openalex-s2orc-reference-cutoff-policy>'
  ].join(' ');
}

function buildReplayReleaseFamilies() {
  return REQUIRED_REPLAY_RELEASE_FAMILIES.map((family) => {
    const artifactPaths = familyArtifactPaths(family);
    return {
      ...family,
      required_metadata_fields: REQUIRED_REPLAY_RELEASE_METADATA_FIELDS,
      artifact_paths: artifactPaths,
      command_template: replaySuiteCommand(family)
    };
  });
}

function replayReleaseSkeletonArtifacts(families = []) {
  return families.flatMap((family) => Object.entries(family.artifact_paths).map(([role, filePath]) => ({
    role,
    path: filePath,
    family: family.id,
    evidence_family: family.evidence_family
  })));
}

function renderReplayReleaseTodo(skeleton = {}) {
  const lines = [
    `# R1 Replay Release Evidence Skeleton: ${skeleton.runId}`,
    '',
    'This directory is only a scaffold. It is not release evidence until every placeholder path is replaced by real external benchmark input, replay output, statistical evidence, and release-ready suite manifests.',
    '',
    '## Required Metadata',
    '',
    ...REQUIRED_REPLAY_RELEASE_METADATA_FIELDS.map((field) => `- ${field}`),
    '',
    '## Required Families',
    ''
  ];
  for (const family of skeleton.families || []) {
    lines.push(`### ${family.label}`);
    lines.push('');
    lines.push(`- Family id: ${family.id}`);
    lines.push(`- Evidence family: ${family.evidence_family}`);
    lines.push(`- Release requirements: ${family.release_requirements.join(', ')}`);
    for (const [role, filePath] of Object.entries(family.artifact_paths)) {
      lines.push(`- ${role}: ${filePath}`);
    }
    lines.push('- Command template:');
    lines.push('');
    lines.push('```bash');
    lines.push(family.command_template);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Final Checks');
  lines.push('');
  lines.push('- Run each family with real external benchmark inputs, non-fixture provenance, source/license metadata, venue-year holdout, time-slice policy, semantic negatives, and paired statistical evidence.');
  lines.push('- Feed the resulting `reports/*/replay-suite-manifest.json` files into `eval:idea-catalyst-release-gate -- --scope p0-p1`.');
  lines.push('- Package the release-gate-consumed reports and their lineage files with `eval:release-evidence-bundle`.');
  return `${lines.join('\n')}\n`;
}

export async function createReplayReleaseEvidenceSkeleton(options = {}) {
  const cwd = options.cwd || process.cwd();
  const outputDir = compactText(options.outputDir || options.output_dir || options.output);
  if (!outputDir) throw new Error('outputDir is required.');
  const absoluteOutputDir = path.resolve(cwd, outputDir);
  const generatedAt = compactText(options.generatedAt || options.generated_at) || new Date().toISOString();
  const runId = compactText(options.runId || options.run_id)
    || `r1-replay-release-${stableHash(`${generatedAt}:${absoluteOutputDir}`, 10)}`;
  const families = buildReplayReleaseFamilies();
  const artifacts = replayReleaseSkeletonArtifacts(families);
  const directories = [...new Set([
    '',
    ...artifacts.map((entry) => path.dirname(entry.path)).filter((entry) => entry && entry !== '.')
  ])];
  for (const directory of directories) {
    await ensureDir(path.join(absoluteOutputDir, directory));
  }
  const manifestPath = path.join(absoluteOutputDir, 'replay-release-evidence-skeleton.json');
  const todoPath = path.join(absoluteOutputDir, 'R1-REPLAY-EVIDENCE-TODO.md');
  const skeleton = {
    contractVersion: REPLAY_RELEASE_EVIDENCE_SKELETON_VERSION,
    runId,
    generatedAt,
    status: 'skeleton',
    outputDir: absoluteOutputDir,
    required_metadata_fields: REQUIRED_REPLAY_RELEASE_METADATA_FIELDS,
    families,
    artifacts
  };
  await writeJson(manifestPath, skeleton);
  await writeText(todoPath, renderReplayReleaseTodo(skeleton));
  return {
    ...skeleton,
    status: 'skeleton_created',
    outputArtifacts: {
      manifestPath,
      todoPath
    }
  };
}
