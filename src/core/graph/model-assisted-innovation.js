import {
  asArray,
  compactText,
  normalizeScore
} from './innovation-artifact-utils.js';

export const MODEL_ASSISTED_INNOVATION_VERSION = 'model-assisted-innovation-v1';

const SCORE_KEYS = [
  'novelty',
  'significance',
  'feasibility',
  'grounding',
  'must_cite_completeness',
  'temporal_validity'
];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeMode(value = '') {
  const normalized = compactText(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized) return '';
  if (['0', 'false', 'no', 'off', 'disabled', 'none'].includes(normalized)) return 'off';
  if (['1', 'true', 'yes', 'on', 'enabled', 'advisory', 'assist', 'assisted'].includes(normalized)) return 'advisory';
  if (['calibrated', 'benchmark-calibrated', 'release-gated'].includes(normalized)) return 'calibrated';
  return normalized;
}

function normalizeEnabled(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = compactText(value).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'advisory', 'calibrated'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'none'].includes(normalized)) return false;
  return fallback;
}

function resolveConfig(payload = {}, options = {}) {
  const config = asObject(firstDefined(
    options.modelAssisted,
    options.model_assisted,
    options.modelAssistance,
    options.model_assistance,
    payload.modelAssisted,
    payload.model_assisted
  ));
  const rawMode = firstDefined(
    options.modelAssistedMode,
    options.model_assisted_mode,
    config.mode,
    config.profile,
    config.enabled
  );
  const enabled = normalizeEnabled(firstDefined(config.enabled, rawMode), false);
  const mode = normalizeMode(rawMode || (enabled ? 'advisory' : 'off')) || (enabled ? 'advisory' : 'off');
  return {
    ...config,
    enabled: mode !== 'off' && enabled !== false,
    mode
  };
}

function normalizeModel(config = {}) {
  return {
    provider: compactText(config.provider || config.modelProvider || config.model_provider),
    model_id: compactText(config.modelId || config.model_id || config.model || config.modelName || config.model_name),
    prompt_version: compactText(config.promptVersion || config.prompt_version || config.promptId || config.prompt_id),
    inference_run_id: compactText(config.inferenceRunId || config.inference_run_id || config.runId || config.run_id)
  };
}

function normalizeCalibration(config = {}) {
  const labels = asArray(config.labels || config.goldLabels || config.gold_labels);
  const benchmarkMetrics = asObject(config.benchmarkMetrics || config.benchmark_metrics || config.metrics);
  const uncertainty = Number(firstDefined(
    config.uncertainty,
    config.scoreUncertainty,
    config.score_uncertainty,
    config.calibrationUncertainty,
    config.calibration_uncertainty
  ));
  return {
    dataset: compactText(config.calibrationDataset || config.calibration_dataset || config.dataset || config.benchmark),
    run_id: compactText(config.calibrationRunId || config.calibration_run_id || config.evalRunId || config.eval_run_id),
    label_count: labels.length || Number(config.labelCount || config.label_count) || 0,
    uncertainty: Number.isFinite(uncertainty) ? normalizeScore(uncertainty, 1) : null,
    metrics: Object.fromEntries(Object.entries(benchmarkMetrics)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(Number(value).toFixed(4))]))
  };
}

function normalizeScores(scores = {}) {
  const normalized = {};
  for (const key of SCORE_KEYS) {
    const value = firstDefined(scores[key], scores[key.replace(/_/g, '')]);
    if (value === undefined) continue;
    normalized[key] = Number(normalizeScore(value, 0).toFixed(4));
  }
  return normalized;
}

function normalizeReasons(value = []) {
  return asArray(value)
    .map((entry) => compactText(entry))
    .filter(Boolean)
    .slice(0, 12);
}

function completenessStatus(context = {}) {
  const warnings = [];
  if (!context.model.model_id) warnings.push('missing_model_id');
  if (!context.model.prompt_version) warnings.push('missing_prompt_version');
  if (context.mode === 'calibrated') {
    if (!context.calibration.dataset) warnings.push('missing_calibration_dataset');
    if (!context.calibration.run_id) warnings.push('missing_calibration_run_id');
    if (!context.calibration.label_count) warnings.push('missing_calibration_labels');
  }
  const status = warnings.length
    ? 'incomplete'
    : (context.mode === 'calibrated' ? 'calibrated' : 'advisory_ready');
  return { status, warnings };
}

export function buildModelAssistedInnovationContext(payload = {}, options = {}) {
  const config = resolveConfig(payload, options);
  if (!config.enabled || config.mode === 'off') {
    return {
      contract_version: MODEL_ASSISTED_INNOVATION_VERSION,
      enabled: false,
      mode: 'off',
      status: 'disabled',
      warnings: []
    };
  }

  const model = normalizeModel(config);
  const calibration = normalizeCalibration(config);
  const noveltyScores = normalizeScores(asObject(config.noveltyScores || config.novelty_scores || config.scores));
  const reviewAssessments = asArray(config.reviewerAssessments || config.reviewer_assessments || config.reviewers)
    .map((entry, index) => ({
      reviewer_id: compactText(entry.reviewer_id || entry.reviewerId || entry.id || `model-reviewer:${index + 1}`),
      role: compactText(entry.role || entry.reviewer_role || entry.reviewerRole || 'model_reviewer').toLowerCase().replace(/[\s-]+/g, '_'),
      score: Number(normalizeScore(entry.score, 0.5).toFixed(4)),
      confidence: Number(normalizeScore(entry.confidence, 0.5).toFixed(4)),
      summary: compactText(entry.summary || entry.rationale || entry.comment),
      concerns: asArray(entry.concerns || entry.major_concerns || entry.majorConcerns).map((concern) => compactText(concern)).filter(Boolean).slice(0, 8)
    }));
  const metaReview = asObject(config.metaReview || config.meta_review);
  const storyline = asObject(config.storyline || config.storylineAnnotations || config.storyline_annotations);
  const context = {
    contract_version: MODEL_ASSISTED_INNOVATION_VERSION,
    enabled: true,
    mode: config.mode,
    model,
    calibration,
    novelty_scores: noveltyScores,
    novelty_reasons: normalizeReasons(config.noveltyReasons || config.novelty_reasons || config.reasons),
    reviewer_assessments: reviewAssessments,
    meta_review: Object.keys(metaReview).length ? {
      recommendation: compactText(metaReview.recommendation || metaReview.decision),
      confidence: Number(normalizeScore(metaReview.confidence, 0.5).toFixed(4)),
      summary: compactText(metaReview.summary || metaReview.rationale)
    } : null,
    storyline_annotations: {
      unsupported_beat_ids: asArray(storyline.unsupportedBeatIds || storyline.unsupported_beat_ids).map(compactText).filter(Boolean),
      suggestions: asArray(storyline.suggestions || storyline.revisions).map(compactText).filter(Boolean).slice(0, 8)
    }
  };
  const { status, warnings } = completenessStatus(context);
  return {
    ...context,
    status,
    warnings
  };
}

export function modelAssistedIsEnabled(context = {}) {
  return Boolean(context?.enabled && context.mode !== 'off');
}

export function attachModelAssistedNovelty(certificate = {}, context = {}) {
  if (!modelAssistedIsEnabled(context)) return certificate;
  const deltas = {};
  for (const key of SCORE_KEYS) {
    if (context.novelty_scores[key] === undefined || certificate[key] === undefined) continue;
    deltas[key] = Number((context.novelty_scores[key] - Number(certificate[key])).toFixed(4));
  }
  return {
    ...certificate,
    model_assisted: {
      contract_version: context.contract_version,
      mode: context.mode,
      status: context.status,
      model: context.model,
      calibration: context.calibration,
      advisory_scores: context.novelty_scores,
      score_deltas: deltas,
      reasons: context.novelty_reasons,
      warnings: context.warnings
    }
  };
}

export function attachModelAssistedReview(packet = {}, context = {}) {
  if (!modelAssistedIsEnabled(context)) return packet;
  return {
    ...packet,
    model_assisted: {
      contract_version: context.contract_version,
      mode: context.mode,
      status: context.status,
      model: context.model,
      calibration: context.calibration,
      reviewer_assessments: context.reviewer_assessments,
      meta_review: context.meta_review,
      warnings: context.warnings
    }
  };
}

export function attachModelAssistedStoryline(storyline = {}, context = {}) {
  if (!modelAssistedIsEnabled(context)) return storyline;
  return {
    ...storyline,
    model_assisted: {
      contract_version: context.contract_version,
      mode: context.mode,
      status: context.status,
      model: context.model,
      calibration: context.calibration,
      annotations: context.storyline_annotations,
      warnings: context.warnings
    }
  };
}
