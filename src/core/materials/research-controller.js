import path from 'node:path';

import { ensureDir, readJson, readText, writeJson, writeText, withFileLock } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { searchGraph } from '../search/search.js';
import { projectOverlayPaths } from './project-overlay.js';

export const RESEARCH_CONTROLLER_CONTRACT_VERSION = 'papernexus-research-controller-v0';

const DEFAULT_CONTROLLER_LLM_API_KEY_ENV = 'PAPERNEXUS_CONTROLLER_LLM_API_KEY';
const DEFAULT_CONTROLLER_LLM_TIMEOUT_MS = 45000;
const DEFAULT_CONTROLLER_LLM_MAX_TOKENS = 2048;
const DEFAULT_GCD_PROJECT_ID = 'gcd-research-controller';
const DEFAULT_RESEARCH_CONTROLLER_PROJECT_ID = 'research-controller';

const CONTROLLER_ACTIONS = new Set([
  'status',
  'init_task',
  'run_round',
  'export',
  'generate_decomposition',
  'review_decomposition',
  'generate_candidates',
  'propose_edges',
  'judge_batch',
  'select_batch',
  'expand_evidence',
  'execute_material_requests',
  'record_material_results',
  'compose_solutions',
  'design_review',
  'compose_innovation_briefs',
  'generate_experiment_plan',
  'validate_gcd_mvp'
]);

const FOUNDATION_BLOCKED_ACTIONS = new Set([
]);

const GCD_SUBPROBLEMS = [
  {
    name: 'known-class bias',
    abstract_challenge: 'Prevent known labeled classes from absorbing novel unlabeled structure.',
    failure_modes: ['novel samples collapse into known classes', 'known-class classifier dominates representation learning'],
    metrics: ['known accuracy', 'novel accuracy', 'all accuracy'],
    query_plan: ['known class bias generalized category discovery', 'open world recognition bias correction']
  },
  {
    name: 'class number estimation',
    abstract_challenge: 'Estimate latent discrete structure under partial class observation.',
    failure_modes: ['over-estimated novel class count', 'under-estimated novel class count'],
    metrics: ['class count error', 'NMI', 'ARI'],
    query_plan: ['generalized category discovery class number estimation', 'clustering validity unknown class count']
  },
  {
    name: 'confidence calibration',
    abstract_challenge: 'Estimate whether pseudo labels and assignments are reliable under feedback loops.',
    failure_modes: ['overconfident wrong pseudo labels', 'low-confidence novel samples never learned'],
    metrics: ['calibration error', 'selective accuracy', 'pseudo-label precision'],
    query_plan: ['confidence calibration pseudo labels generalized category discovery', 'selective prediction open world recognition']
  },
  {
    name: 'pseudo-label generation',
    abstract_challenge: 'Create useful training targets for unknown classes without ground-truth unknown labels.',
    failure_modes: ['confirmation bias', 'cluster assignment drift'],
    metrics: ['pseudo-label precision', 'novel accuracy', 'NMI'],
    query_plan: ['pseudo-label generalized category discovery', 'self training noisy label clustering']
  },
  {
    name: 'representation separation',
    abstract_challenge: 'Learn embeddings that keep known classification useful while exposing novel class geometry.',
    failure_modes: ['embedding optimized only for known classes', 'novel clusters are not linearly separable'],
    metrics: ['NMI', 'ARI', 'known accuracy', 'novel accuracy'],
    query_plan: ['representation learning generalized category discovery', 'contrastive learning novel class discovery']
  },
  {
    name: 'domain shift robustness',
    abstract_challenge: 'Keep discovery behavior stable when labeled known data and unlabeled discovery data differ.',
    failure_modes: ['domain-specific features mistaken for class structure', 'source-domain priors dominate target data'],
    metrics: ['cross-domain all accuracy', 'domain-shift robustness gap'],
    query_plan: ['generalized category discovery under domain shift', 'domain adaptation novel class discovery']
  }
];

const TASK_FAMILY_RULES = [
  {
    family: 'domain_adaptation',
    pattern: /(domain adaptation|domain generalization|domain shift|distribution shift|cross[-\s]?domain|source domain|target domain|out[-\s]?of[-\s]?distribution|\bood\b)/
  },
  {
    family: 'retrieval',
    pattern: /(information retrieval|retrieval|ranking|search engine|neural search|recommendation|recommender|\brag\b|retrieval[-\s]?augmented|dense passage|document search)/
  },
  {
    family: 'clustering',
    pattern: /(clustering|cluster|unsupervised|novel class discovery|category discovery|class discovery|pseudo[-\s]?label|self[-\s]?training)/
  },
  {
    family: 'computer_vision',
    pattern: /(computer vision|\bcv\b|image|visual|video|segmentation|object detection|recognition|vision[-\s]?language|medical imaging)/
  },
  {
    family: 'nlp',
    pattern: /(\bnlp\b|natural language|language model|\bllm\b|text|translation|summarization|question answering|information extraction)/
  }
];

const TASK_FAMILY_DEFAULTS = {
  domain_adaptation: {
    design_boundaries: [
      'Do not mix source/target labels or use target-test labels during adaptation.',
      'Keep source/target splits and domains explicit in every candidate and evaluation.',
      'Compare under matched backbone, pretraining, augmentation, and target-data access.',
      'Report robustness across domain shifts rather than one favorable target domain.'
    ],
    subproblems: [
      {
        name: 'domain protocol and split control',
        abstract_challenge: 'Separate source supervision, target access, and evaluation labels so adaptation evidence is comparable.',
        failure_modes: ['target-test leakage', 'unclear source/target split'],
        metrics: ['protocol compliance', 'target accuracy', 'robustness gap'],
        query_plan: ['domain adaptation protocol source target split', 'domain shift benchmark evaluation']
      },
      {
        name: 'invariant mechanism selection',
        abstract_challenge: 'Identify transferable mechanisms that survive source-to-target distribution shift.',
        failure_modes: ['source-specific shortcut transfer', 'target-irrelevant invariance'],
        metrics: ['mechanism fit', 'cross-domain accuracy'],
        query_plan: ['domain invariant representation learning', 'transferable mechanism domain shift']
      },
      {
        name: 'target-risk estimation',
        abstract_challenge: 'Estimate target reliability without using hidden target labels.',
        failure_modes: ['overconfident target pseudo labels', 'unreliable model selection'],
        metrics: ['calibration error', 'target risk proxy quality'],
        query_plan: ['unsupervised target risk estimation', 'domain adaptation confidence calibration']
      },
      {
        name: 'shift-robust evaluation',
        abstract_challenge: 'Make gains comparable across target domains, shifts, and compute settings.',
        failure_modes: ['single-domain overfitting', 'unmatched compute baseline'],
        metrics: ['average target accuracy', 'worst-domain accuracy', 'compute-normalized gain'],
        query_plan: ['domain adaptation robustness evaluation', 'domain generalization benchmark compute']
      }
    ]
  },
  clustering: {
    design_boundaries: [
      'Do not use ground-truth cluster/class labels for training, model selection, or choosing cluster count unless explicitly allowed.',
      'Keep cluster-count assumptions, validation criteria, and label-permutation handling explicit.',
      'Compare under matched representations, augmentations, and clustering budgets.',
      'Report failure cases for collapse, over-fragmentation, and class imbalance.'
    ],
    subproblems: [
      {
        name: 'cluster-count and model selection',
        abstract_challenge: 'Choose or bound latent cluster structure without leaking ground-truth labels.',
        failure_modes: ['over-fragmented clusters', 'under-estimated cluster count'],
        metrics: ['cluster count error', 'NMI', 'ARI'],
        query_plan: ['clustering model selection unknown cluster count', 'unsupervised clustering validity index']
      },
      {
        name: 'representation geometry',
        abstract_challenge: 'Shape embeddings so latent groups are separable before assignment.',
        failure_modes: ['feature collapse', 'class imbalance hidden in embedding space'],
        metrics: ['NMI', 'silhouette score', 'assignment stability'],
        query_plan: ['representation learning clustering stability', 'contrastive clustering representation']
      },
      {
        name: 'assignment confidence',
        abstract_challenge: 'Estimate which cluster assignments can safely drive training or selection.',
        failure_modes: ['overconfident wrong assignments', 'uncertain samples ignored'],
        metrics: ['assignment precision', 'selective clustering accuracy'],
        query_plan: ['cluster assignment confidence calibration', 'selective pseudo label clustering']
      },
      {
        name: 'collapse and imbalance control',
        abstract_challenge: 'Prevent candidates from succeeding only on balanced or easy cluster regimes.',
        failure_modes: ['single-cluster collapse', 'minority cluster loss'],
        metrics: ['imbalance robustness', 'collapse rate'],
        query_plan: ['deep clustering collapse prevention', 'imbalanced clustering evaluation']
      }
    ]
  },
  computer_vision: {
    design_boundaries: [
      'Do not tune on test annotations, identities, frames, or scene metadata.',
      'Keep dataset splits, pretraining sources, augmentations, resolution, and backbone capacity explicit.',
      'Compare against baselines under matched backbone, data, schedule, and compute.',
      'Separate visual evidence supported by artifacts from Agent-inferred mechanism claims.'
    ],
    subproblems: [
      {
        name: 'visual protocol controls',
        abstract_challenge: 'Make image/video split, annotation, and pretraining assumptions explicit.',
        failure_modes: ['test annotation leakage', 'unmatched pretraining source'],
        metrics: ['protocol compliance', 'baseline comparability'],
        query_plan: ['computer vision benchmark protocol leakage', 'vision pretraining fair comparison']
      },
      {
        name: 'visual mechanism localization',
        abstract_challenge: 'Connect candidate mechanisms to visual evidence rather than only aggregate scores.',
        failure_modes: ['spurious visual shortcut', 'uninterpretable feature gain'],
        metrics: ['localization quality', 'error taxonomy coverage'],
        query_plan: ['visual mechanism localization evidence', 'computer vision spurious correlation analysis']
      },
      {
        name: 'robustness and shift',
        abstract_challenge: 'Test whether visual gains survive corruptions, domains, and scene changes.',
        failure_modes: ['dataset-specific shortcut', 'augmentation overfitting'],
        metrics: ['robust accuracy', 'domain robustness gap'],
        query_plan: ['computer vision robustness domain shift', 'image corruption benchmark evaluation']
      },
      {
        name: 'compute and deployment cost',
        abstract_challenge: 'Keep improvements comparable under training and inference budgets.',
        failure_modes: ['hidden extra pretraining', 'inference latency regression'],
        metrics: ['FLOPs', 'latency', 'GPU hours'],
        query_plan: ['vision model compute fair comparison', 'computer vision inference latency evaluation']
      }
    ]
  },
  nlp: {
    design_boundaries: [
      'Do not leak evaluation labels, test documents, or benchmark answers through prompting, retrieval, or tuning.',
      'Keep model checkpoints, prompts, retrieval corpora, decoding settings, and train/dev/test splits explicit.',
      'Compare with matched model size, context budget, data access, and inference cost.',
      'Separate observed text evidence from Agent-inferred task or reasoning claims.'
    ],
    subproblems: [
      {
        name: 'text protocol and leakage control',
        abstract_challenge: 'Bound prompt, retrieval, and tuning access so evaluation evidence is trustworthy.',
        failure_modes: ['benchmark answer leakage', 'prompt overfitting'],
        metrics: ['protocol compliance', 'leakage risk'],
        query_plan: ['NLP benchmark leakage prompt tuning', 'language model evaluation protocol']
      },
      {
        name: 'grounding and evidence use',
        abstract_challenge: 'Connect generated or predicted text to admissible evidence.',
        failure_modes: ['unsupported generation', 'retrieval-grounding mismatch'],
        metrics: ['faithfulness', 'evidence attribution quality'],
        query_plan: ['NLP evidence grounding faithfulness', 'language model attribution evaluation']
      },
      {
        name: 'model adaptation',
        abstract_challenge: 'Choose adaptation mechanisms that fit the task without changing the evaluation budget.',
        failure_modes: ['unmatched model capacity', 'training-data contamination'],
        metrics: ['task score', 'data efficiency', 'inference cost'],
        query_plan: ['language model adaptation fair comparison', 'NLP parameter efficient tuning evaluation']
      },
      {
        name: 'evaluation rubric alignment',
        abstract_challenge: 'Make automatic and human evaluation comparable and rejectable.',
        failure_modes: ['metric gaming', 'judge bias'],
        metrics: ['rubric agreement', 'human preference consistency'],
        query_plan: ['NLP evaluation rubric reliability', 'LLM judge bias self consistency']
      }
    ]
  },
  retrieval: {
    design_boundaries: [
      'Do not index test answers, relevance labels, or evaluation-only documents unless the benchmark permits it.',
      'Keep corpus version, query set, relevance labels, reranker budget, and retrieval depth explicit.',
      'Compare under matched index, embedding model, reranking, and latency/cost constraints.',
      'Track recall, precision, calibration, and answer-grounding errors separately.'
    ],
    subproblems: [
      {
        name: 'corpus and query contract',
        abstract_challenge: 'Define what can be indexed, queried, and used as relevance evidence.',
        failure_modes: ['test-answer indexing', 'corpus version drift'],
        metrics: ['protocol compliance', 'coverage'],
        query_plan: ['retrieval corpus version evaluation protocol', 'RAG benchmark relevance label leakage']
      },
      {
        name: 'first-stage recall',
        abstract_challenge: 'Recover enough relevant evidence before expensive reranking or generation.',
        failure_modes: ['low recall ceiling', 'embedding domain mismatch'],
        metrics: ['Recall@k', 'MRR', 'nDCG'],
        query_plan: ['dense retrieval first stage recall', 'retrieval embedding domain mismatch']
      },
      {
        name: 'reranking and calibration',
        abstract_challenge: 'Rank retrieved evidence and expose confidence without hiding extra compute.',
        failure_modes: ['overfit reranker', 'uncalibrated relevance score'],
        metrics: ['nDCG', 'calibration error', 'latency'],
        query_plan: ['retrieval reranking calibration', 'neural reranker latency evaluation']
      },
      {
        name: 'grounded answer use',
        abstract_challenge: 'Ensure downstream answers or decisions are faithful to retrieved evidence.',
        failure_modes: ['unsupported answer', 'citation mismatch'],
        metrics: ['faithfulness', 'answer support precision'],
        query_plan: ['RAG faithfulness evaluation', 'retrieval augmented generation citation grounding']
      }
    ]
  },
  generic: {
    design_boundaries: [
      'Do not use evaluation-only labels or hidden test information as design input.',
      'Keep baseline comparisons fair in data, compute, and model capacity.',
      'Separate evidence-supported claims from Agent-inferred or speculative claims.'
    ],
    subproblems: [
      {
        name: 'task framing',
        abstract_challenge: 'Clarify the exact problem variant, protocol, and assumptions.',
        failure_modes: ['ambiguous target task', 'hidden protocol mismatch'],
        metrics: ['protocol clarity', 'baseline comparability'],
        query_plan: [null, 'benchmark protocol']
      },
      {
        name: 'evidence gap',
        abstract_challenge: 'Find what is already supported by prior work and what remains speculative.',
        failure_modes: ['closest prior missed', 'unsupported novelty claim'],
        metrics: ['evidence coverage', 'novelty risk'],
        query_plan: ['prior limitation', 'related work']
      },
      {
        name: 'method transfer',
        abstract_challenge: 'Identify mechanisms that could transfer from near-source domains.',
        failure_modes: ['mechanism mismatch', 'non-transferable assumptions'],
        metrics: ['mechanism fit', 'adaptation feasibility'],
        query_plan: ['transfer method', 'mechanism adaptation']
      },
      {
        name: 'evaluation plan',
        abstract_challenge: 'Make each candidate comparable, evaluable, and rejectable.',
        failure_modes: ['no discard condition', 'no fair baseline'],
        metrics: ['baseline clarity', 'discard condition quality'],
        query_plan: ['evaluation metric', 'ablation baseline']
      }
    ]
  }
};

function nowIso() {
  return new Date().toISOString();
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function normalizeStringArray(value) {
  return unique(asArray(value).flatMap((entry) => String(entry || '').split(','))
    .map(compactText)
    .filter(Boolean));
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function taskFamilyFor(args = {}) {
  const text = `${args.corpus || ''} ${args.targetDomain || args.target_domain || ''} ${args.targetProblem || args.target_problem || args.query || args.problem || ''}`.toLowerCase();
  if (text.includes('generalized category discovery') || /\bgcd\b/.test(text)) return 'gcd';
  for (const rule of TASK_FAMILY_RULES) {
    if (rule.pattern.test(text)) return rule.family;
  }
  return 'generic';
}

function researchControllerProject(args = {}) {
  const explicit = compactText(args.project || args.projectId || args.project_id);
  if (explicit) return explicit;
  return taskFamilyFor(args) === 'gcd'
    ? DEFAULT_GCD_PROJECT_ID
    : DEFAULT_RESEARCH_CONTROLLER_PROJECT_ID;
}

function normalizeAction(value) {
  const action = compactText(value || 'status').toLowerCase().replace(/[-\s]+/g, '_');
  if (!CONTROLLER_ACTIONS.has(action)) {
    throw new Error(`Unknown research_controller action: ${value || '<missing>'}`);
  }
  return action;
}

function normalizeMode(value) {
  const mode = compactText(value || 'planning').toLowerCase().replace(/[-\s]+/g, '_');
  return ['quick', 'planning', 'deep'].includes(mode) ? mode : 'planning';
}

function budgetDefaultsFor(args = {}) {
  const mode = normalizeMode(args.mode);
  const taskFamily = taskFamilyFor(args);
  const generic = {
    task_family: taskFamily,
    mode,
    profile: `${taskFamily}_${mode}`,
    max_candidate_nodes: 60,
    max_edge_judgments: 40,
    max_agent_calls: 12,
    max_provider_queries: 0,
    max_imports: 0,
    max_selected_candidates: 3,
    max_solution_sketches: 3,
    max_experiment_plans: 3
  };
  if (taskFamily !== 'gcd') return generic;
  const gcdProfiles = {
    quick: {
      profile: 'gcd_mvp_quick',
      max_candidate_nodes: 36,
      max_edge_judgments: 48,
      max_agent_calls: 8,
      max_selected_candidates: 2,
      max_solution_sketches: 2,
      max_experiment_plans: 1
    },
    planning: {
      profile: 'gcd_mvp_planning',
      max_candidate_nodes: 72,
      max_edge_judgments: 96,
      max_agent_calls: 18,
      max_selected_candidates: 3,
      max_solution_sketches: 3,
      max_experiment_plans: 2
    },
    deep: {
      profile: 'gcd_mvp_deep',
      max_candidate_nodes: 120,
      max_edge_judgments: 160,
      max_agent_calls: 32,
      max_selected_candidates: 5,
      max_solution_sketches: 4,
      max_experiment_plans: 3
    }
  };
  return {
    ...generic,
    ...(gcdProfiles[mode] || gcdProfiles.planning),
    task_family: taskFamily,
    mode,
    max_provider_queries: 0,
    max_imports: 0
  };
}

function boundedInteger(value, fallback, { min = 0, max = 1000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function booleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function controllerPaths(rootPath, projectValue) {
  const base = projectOverlayPaths(rootPath, projectValue);
  return {
    ...base,
    taskSpecVariantsPath: path.join(base.root, 'task-spec-variants.json'),
    subproblemGraphPath: path.join(base.root, 'subproblem-graph.json'),
    decompositionReviewPath: path.join(base.root, 'decomposition-review.json'),
    candidateGraphPath: path.join(base.root, 'candidate-graph.jsonl'),
    searchTracePath: path.join(base.root, 'search-trace.json'),
    judgeDecisionsPath: path.join(base.root, 'judge-decisions.jsonl'),
    controllerStatePath: path.join(base.root, 'controller-state.json'),
    roundReportPath: path.join(base.root, 'round-report.json'),
    roundReportMarkdownPath: path.join(base.root, 'round-report.md'),
    selectedSubgraphsPath: path.join(base.root, 'selected-subgraphs.json'),
    selectionTracePath: path.join(base.root, 'selection-trace.json'),
    banditSimulationPath: path.join(base.root, 'bandit-simulation.json'),
    methodCardPackPath: path.join(base.root, 'method-card-pack.md'),
    materialExpansionResultsPath: path.join(base.root, 'material-expansion-results.jsonl'),
    solutionSketchesPath: path.join(base.root, 'solution-sketches.jsonl'),
    solutionSketchesMarkdownPath: path.join(base.root, 'solution-sketches.md'),
    designReviewPath: path.join(base.root, 'design-review.json'),
    designReviewMarkdownPath: path.join(base.root, 'design-review.md'),
    innovationBriefsPath: path.join(base.root, 'innovation-briefs.json'),
    innovationBriefsMarkdownPath: path.join(base.root, 'innovation-briefs.md'),
    experimentPlanPath: path.join(base.root, 'experiment-plan.json'),
    experimentPlanMarkdownPath: path.join(base.root, 'experiment-plan.md'),
    gcdMvpValidationPath: path.join(base.root, 'gcd-mvp-validation.json'),
    gcdMvpValidationMarkdownPath: path.join(base.root, 'gcd-mvp-validation.md'),
    riskNotesPath: path.join(base.root, 'risk-notes.jsonl'),
    controllerExportJsonPath: path.join(base.root, 'controller-export.json'),
    controllerExportMarkdownPath: path.join(base.root, 'controller-export.md')
  };
}

function publicArtifactPaths(paths) {
  return {
    overlay_root: paths.root,
    task_spec_variants: paths.taskSpecVariantsPath,
    subproblem_graph: paths.subproblemGraphPath,
    decomposition_review: paths.decompositionReviewPath,
    candidate_graph: paths.candidateGraphPath,
    search_trace: paths.searchTracePath,
    judge_decisions: paths.judgeDecisionsPath,
    controller_state: paths.controllerStatePath,
    round_report: paths.roundReportPath,
    round_report_md: paths.roundReportMarkdownPath,
    selected_subgraphs: paths.selectedSubgraphsPath,
    selection_trace: paths.selectionTracePath,
    bandit_simulation: paths.banditSimulationPath,
    method_card_pack: paths.methodCardPackPath,
    material_expansion_results: paths.materialExpansionResultsPath,
    solution_sketches: paths.solutionSketchesPath,
    solution_sketches_md: paths.solutionSketchesMarkdownPath,
    design_review: paths.designReviewPath,
    design_review_md: paths.designReviewMarkdownPath,
    innovation_briefs: paths.innovationBriefsPath,
    innovation_briefs_md: paths.innovationBriefsMarkdownPath,
    experiment_plan: paths.experimentPlanPath,
    experiment_plan_md: paths.experimentPlanMarkdownPath,
    gcd_mvp_validation: paths.gcdMvpValidationPath,
    gcd_mvp_validation_md: paths.gcdMvpValidationMarkdownPath,
    risk_notes: paths.riskNotesPath,
    controller_export_json: paths.controllerExportJsonPath,
    controller_export_md: paths.controllerExportMarkdownPath
  };
}

async function readJsonl(filePath) {
  let raw = '';
  try {
    raw = await readText(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL record in ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

async function writeJsonl(filePath, records = []) {
  await ensureDir(path.dirname(filePath));
  const lines = records.map((record) => JSON.stringify(record));
  await writeText(filePath, lines.length ? `${lines.join('\n')}\n` : '');
}

async function readOptionalText(filePath) {
  try {
    return await readText(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function splitCandidateGraph(records = []) {
  const nodes = records.filter((record) => record.record_type === 'candidate_node');
  const edges = records.filter((record) => record.record_type === 'candidate_edge');
  return { nodes, edges };
}

function candidateRecordKey(record = {}) {
  return record.candidate_id || record.edge_id || stableHash(JSON.stringify(record), 20);
}

function mergeCandidateGraphRecords(existingRecords = [], nextRecords = []) {
  const byKey = new Map();
  for (const record of existingRecords) byKey.set(candidateRecordKey(record), record);
  for (const record of nextRecords) {
    const key = candidateRecordKey(record);
    byKey.set(key, {
      ...(byKey.get(key) || {}),
      ...record
    });
  }
  return [...byKey.values()].sort((left, right) => candidateRecordKey(left).localeCompare(candidateRecordKey(right)));
}

async function loadControllerOverlay(paths) {
  const [
    taskSpecVariants,
    subproblemGraph,
    decompositionReview,
    candidateGraphRecords,
    searchTrace,
    judgeDecisions,
    controllerState,
    roundReport,
    selectedSubgraphs,
    selectionTrace,
    banditSimulation,
    methodCardPackText,
    materialExpansionResults,
    solutionSketches,
    designReview,
    innovationBriefs,
    experimentPlan,
    gcdMvpValidation,
    riskNotes
  ] = await Promise.all([
    readJson(paths.taskSpecVariantsPath, null),
    readJson(paths.subproblemGraphPath, null),
    readJson(paths.decompositionReviewPath, null),
    readJsonl(paths.candidateGraphPath),
    readJson(paths.searchTracePath, null),
    readJsonl(paths.judgeDecisionsPath),
    readJson(paths.controllerStatePath, null),
    readJson(paths.roundReportPath, null),
    readJson(paths.selectedSubgraphsPath, null),
    readJson(paths.selectionTracePath, null),
    readJson(paths.banditSimulationPath, null),
    readOptionalText(paths.methodCardPackPath),
    readJsonl(paths.materialExpansionResultsPath),
    readJsonl(paths.solutionSketchesPath),
    readJson(paths.designReviewPath, null),
    readJson(paths.innovationBriefsPath, null),
    readJson(paths.experimentPlanPath, null),
    readJson(paths.gcdMvpValidationPath, null),
    readJsonl(paths.riskNotesPath)
  ]);
  const candidateGraph = splitCandidateGraph(candidateGraphRecords);
  return {
    taskSpecVariants,
    subproblemGraph,
    decompositionReview,
    candidateGraphRecords,
    candidateGraph,
    searchTrace,
    judgeDecisions,
    controllerState,
    roundReport,
    selectedSubgraphs,
    selectionTrace,
    banditSimulation,
    methodCardPackText,
    materialExpansionResults,
    solutionSketches,
    designReview,
    innovationBriefs,
    experimentPlan,
    gcdMvpValidation,
    riskNotes
  };
}

function normalizeBudget(args = {}) {
  const budget = normalizeObject(args.budget);
  const defaults = budgetDefaultsFor(args);
  return {
    task_family: defaults.task_family,
    mode: defaults.mode,
    profile: compactText(budget.profile || budget.budget_profile || args.budgetProfile || args.budget_profile) || defaults.profile,
    max_candidate_nodes: boundedInteger(budget.max_candidate_nodes ?? budget.maxCandidateNodes ?? args.maxCandidateNodes, defaults.max_candidate_nodes, { min: 1, max: 500 }),
    max_edge_judgments: boundedInteger(budget.max_edge_judgments ?? budget.maxEdgeJudgments ?? args.maxEdgeJudgments, defaults.max_edge_judgments, { max: 500 }),
    max_agent_calls: boundedInteger(budget.max_agent_calls ?? budget.maxAgentCalls ?? args.maxAgentCalls, defaults.max_agent_calls, { max: 200 }),
    max_provider_queries: boundedInteger(budget.max_provider_queries ?? budget.maxProviderQueries ?? args.maxProviderQueries, defaults.max_provider_queries, { max: 100 }),
    max_imports: boundedInteger(budget.max_imports ?? budget.maxImports ?? args.maxImports, defaults.max_imports, { max: 100 }),
    max_selected_candidates: boundedInteger(budget.max_selected_candidates ?? budget.maxSelectedCandidates ?? args.maxSelectedCandidates, defaults.max_selected_candidates, { min: 1, max: 20 }),
    max_solution_sketches: boundedInteger(budget.max_solution_sketches ?? budget.maxSolutionSketches ?? args.maxSolutionSketches, defaults.max_solution_sketches, { min: 1, max: 8 }),
    max_experiment_plans: boundedInteger(budget.max_experiment_plans ?? budget.maxExperimentPlans ?? args.maxExperimentPlans, defaults.max_experiment_plans, { min: 1, max: 8 })
  };
}

function normalizeProviderPolicy(args = {}) {
  const policy = normalizeObject(args.providerPolicy || args.provider_policy);
  const controllerLlm = normalizeControllerLlmConfig(args, policy);
  return {
    include_provider_evidence: booleanFlag(policy.include_provider_evidence ?? policy.includeProviderEvidence ?? args.includeProviderEvidence, false),
    include_live_discovery_evidence: booleanFlag(policy.include_live_discovery_evidence ?? policy.includeLiveDiscoveryEvidence ?? args.includeLiveDiscoveryEvidence, false),
    include_literature_discovery: booleanFlag(policy.include_literature_discovery ?? policy.includeLiteratureDiscovery ?? args.includeLiteratureDiscoveryEvidence, false),
    submit_imports: booleanFlag(policy.submit_imports ?? policy.submitImports ?? args.submitLiteratureDiscoveryImports, false),
    process_literature_imports: booleanFlag(policy.process_literature_imports ?? policy.processLiteratureImports ?? args.processLiteratureDiscoveryImports, false),
    enable_controller_llm: controllerLlm.enabled,
    controller_llm: controllerLlm.public_config
  };
}

function normalizeJudge(args = {}) {
  const judge = normalizeObject(args.judge);
  return {
    enabled: booleanFlag(judge.enabled, true),
    mode: 'single_model',
    model: compactText(judge.model || args.judgeModel || args.judge_model) || null
  };
}

function envText(name = '') {
  return name && typeof process !== 'undefined'
    ? compactText(process.env?.[name])
    : '';
}

function numericSetting(value, fallback, { min = 0, max = 1 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeControllerLlmConfig(args = {}, providerPolicy = normalizeObject(args.providerPolicy || args.provider_policy)) {
  const policy = normalizeObject(providerPolicy);
  const llm = normalizeObject(policy.controller_llm || policy.controllerLlm || args.controllerLlm || args.controller_llm);
  const explicitApiKeyEnv = compactText(
    llm.api_key_env
    || llm.apiKeyEnv
    || policy.controller_llm_api_key_env
    || policy.controllerLlmApiKeyEnv
    || args.controllerLlmApiKeyEnv
    || args.controller_llm_api_key_env
  );
  const fallbackApiKeyEnv = envText(DEFAULT_CONTROLLER_LLM_API_KEY_ENV) ? DEFAULT_CONTROLLER_LLM_API_KEY_ENV : '';
  const apiKeyEnv = explicitApiKeyEnv || fallbackApiKeyEnv;
  const provider = compactText(
    llm.provider
    || policy.controller_llm_provider
    || policy.controllerLlmProvider
    || args.controllerLlmProvider
    || args.controller_llm_provider
    || 'openai_compatible'
  ).toLowerCase().replace(/[-\s]+/g, '_');
  const enabled = booleanFlag(
    llm.enabled
    ?? policy.enable_controller_llm
    ?? policy.enableControllerLlm
    ?? policy.controller_llm_enabled
    ?? policy.controllerLlmEnabled
    ?? args.enableControllerLlm
    ?? args.enable_controller_llm,
    false
  );
  const model = compactText(
    llm.model
    || policy.controller_llm_model
    || policy.controllerLlmModel
    || args.controllerLlmModel
    || args.controller_llm_model
    || envText('PAPERNEXUS_CONTROLLER_LLM_MODEL')
    || normalizeJudge(args).model
  );
  const baseUrl = compactText(
    llm.base_url
    || llm.baseUrl
    || policy.controller_llm_base_url
    || policy.controllerLlmBaseUrl
    || args.controllerLlmBaseUrl
    || args.controller_llm_base_url
    || envText('PAPERNEXUS_CONTROLLER_LLM_BASE_URL')
  );
  const endpoint = compactText(
    llm.endpoint
    || policy.controller_llm_endpoint
    || policy.controllerLlmEndpoint
    || args.controllerLlmEndpoint
    || args.controller_llm_endpoint
  );
  const endpointFormat = compactText(
    llm.endpoint_format
    || llm.endpointFormat
    || policy.controller_llm_endpoint_format
    || policy.controllerLlmEndpointFormat
    || args.controllerLlmEndpointFormat
    || args.controller_llm_endpoint_format
    || 'chat_completions'
  ).toLowerCase().replace(/[-\s]+/g, '_');
  const timeoutMs = boundedInteger(
    llm.timeout_ms
    ?? llm.timeoutMs
    ?? policy.controller_llm_timeout_ms
    ?? policy.controllerLlmTimeoutMs
    ?? args.controllerLlmTimeoutMs
    ?? args.controller_llm_timeout_ms,
    DEFAULT_CONTROLLER_LLM_TIMEOUT_MS,
    { min: 1000, max: 180000 }
  );
  const maxTokens = boundedInteger(
    llm.max_tokens
    ?? llm.maxTokens
    ?? policy.controller_llm_max_tokens
    ?? policy.controllerLlmMaxTokens
    ?? args.controllerLlmMaxTokens
    ?? args.controller_llm_max_tokens,
    DEFAULT_CONTROLLER_LLM_MAX_TOKENS,
    { min: 128, max: 16000 }
  );
  const temperature = numericSetting(
    llm.temperature
    ?? policy.controller_llm_temperature
    ?? policy.controllerLlmTemperature
    ?? args.controllerLlmTemperature
    ?? args.controller_llm_temperature,
    0.2,
    { min: 0, max: 2 }
  );
  const requiresApiKey = booleanFlag(
    llm.requires_api_key
    ?? llm.requiresApiKey
    ?? policy.controller_llm_requires_api_key
    ?? policy.controllerLlmRequiresApiKey
    ?? args.controllerLlmRequiresApiKey
    ?? args.controller_llm_requires_api_key,
    Boolean(apiKeyEnv && provider !== 'ollama')
  );
  const jsonMode = booleanFlag(
    llm.json_mode
    ?? llm.jsonMode
    ?? policy.controller_llm_json_mode
    ?? policy.controllerLlmJsonMode
    ?? args.controllerLlmJsonMode
    ?? args.controller_llm_json_mode,
    true
  );
  return {
    enabled,
    provider,
    model,
    base_url: baseUrl,
    endpoint,
    endpoint_format: endpointFormat,
    api_key_env: apiKeyEnv,
    requires_api_key: requiresApiKey,
    timeout_ms: timeoutMs,
    max_tokens: maxTokens,
    temperature,
    json_mode: jsonMode,
    public_config: {
      enabled,
      provider,
      model: model || null,
      base_url: baseUrl || null,
      endpoint: endpoint || null,
      base_url_configured: Boolean(baseUrl || endpoint),
      endpoint_format: endpointFormat,
      api_key_env: apiKeyEnv || null,
      requires_api_key: requiresApiKey,
      timeout_ms: timeoutMs,
      max_tokens: maxTokens,
      temperature,
      json_mode: jsonMode
    }
  };
}

function argsWithControllerRequestPolicy(args = {}, request = {}) {
  const requestBudget = normalizeObject(request.budget);
  const explicitBudget = normalizeObject(args.budget);
  const requestProviderPolicy = normalizeObject(request.provider_policy || request.providerPolicy);
  const explicitProviderPolicy = normalizeObject(args.providerPolicy || args.provider_policy);
  const requestJudge = normalizeObject(request.judge);
  const explicitJudge = normalizeObject(args.judge);
  return {
    ...args,
    budget: {
      ...requestBudget,
      ...explicitBudget
    },
    providerPolicy: {
      ...requestProviderPolicy,
      ...explicitProviderPolicy
    },
    judge: {
      ...requestJudge,
      ...explicitJudge
    }
  };
}

function controllerLlmEndpoint(config = {}) {
  if (config.endpoint) return config.endpoint;
  const base = compactText(config.base_url).replace(/\/+$/, '');
  if (!base) return '';
  if (/\/(chat\/completions|responses)$/.test(base)) return base;
  if (config.endpoint_format === 'responses') return `${base}/responses`;
  return `${base}/chat/completions`;
}

function controllerLlmHeaders(config = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json'
  };
  const apiKey = envText(config.api_key_env);
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildControllerLlmBody(config = {}, task = '', prompt = '') {
  const system = [
    'You are the single configured model for PaperNexus research_controller.',
    'Return strict JSON only.',
    'Do not mutate controller lifecycle state; the controller will normalize your output as evidence.'
  ].join(' ');
  if (config.endpoint_format === 'responses') {
    return {
      model: config.model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: `${task}\n\n${prompt}` }
      ],
      temperature: config.temperature,
      max_output_tokens: config.max_tokens
    };
  }
  return {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${task}\n\n${prompt}` }
    ],
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    ...(config.json_mode ? { response_format: { type: 'json_object' } } : {})
  };
}

function extractControllerLlmText(payload = {}) {
  if (typeof payload === 'string') return payload;
  const choiceText = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text;
  if (choiceText) return choiceText;
  if (payload.output_text) return payload.output_text;
  for (const item of asArray(payload.output)) {
    for (const part of asArray(item.content)) {
      if (part?.type === 'output_text' && part.text) return part.text;
      if (part?.text) return typeof part.text === 'string' ? part.text : part.text.value;
    }
  }
  return '';
}

async function requestConfiguredControllerLlmJson(task = '', prompt = '', args = {}, context = {}, callIndex = 1) {
  const providerPolicy = normalizeProviderPolicy(args);
  const config = normalizeControllerLlmConfig(args);
  if (!providerPolicy.enable_controller_llm) {
    return { skipped: true, warnings: [], provider_call_count: 0 };
  }
  const budget = normalizeBudget(args);
  if (budget.max_provider_queries < callIndex) {
    return {
      skipped: true,
      warnings: [`Configured controller LLM skipped for ${task}: max_provider_queries=${budget.max_provider_queries} does not allow provider call ${callIndex}.`],
      provider_call_count: 0
    };
  }
  if (!config.model) {
    return {
      skipped: true,
      warnings: [`Configured controller LLM skipped for ${task}: providerPolicy.controller_llm.model or PAPERNEXUS_CONTROLLER_LLM_MODEL is required.`],
      provider_call_count: 0
    };
  }
  const endpoint = controllerLlmEndpoint(config);
  if (!endpoint) {
    return {
      skipped: true,
      warnings: [`Configured controller LLM skipped for ${task}: providerPolicy.controller_llm.base_url/endpoint or PAPERNEXUS_CONTROLLER_LLM_BASE_URL is required.`],
      provider_call_count: 0
    };
  }
  if (config.requires_api_key && !envText(config.api_key_env)) {
    return {
      skipped: true,
      warnings: [`Configured controller LLM skipped for ${task}: API key env ${config.api_key_env || DEFAULT_CONTROLLER_LLM_API_KEY_ENV} is not set.`],
      provider_call_count: 0
    };
  }
  const fetchImpl = context.options?.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      skipped: true,
      warnings: [`Configured controller LLM skipped for ${task}: fetch is not available in this runtime.`],
      provider_call_count: 0
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: controllerLlmHeaders(config),
      body: JSON.stringify(buildControllerLlmBody(config, task, prompt)),
      signal: controller.signal
    });
    const rawText = await response.text();
    let responsePayload = {};
    try {
      responsePayload = rawText ? JSON.parse(rawText) : {};
    } catch {
      responsePayload = { output_text: rawText };
    }
    if (!response.ok) {
      const errorMessage = compactText(responsePayload.error?.message || responsePayload.message || rawText || response.statusText);
      return {
        skipped: true,
        warnings: [`Configured controller LLM failed for ${task}: HTTP ${response.status}${errorMessage ? ` ${truncate(errorMessage, 180)}` : ''}.`],
        provider_call_count: 1
      };
    }
    const contentText = extractControllerLlmText(responsePayload);
    const payload = contentText ? parseJsonText(contentText) : normalizeObject(responsePayload);
    return {
      backend: 'configured_single_model_provider_json',
      source: 'provider_policy_opt_in',
      model: config.model,
      payload,
      warnings: [],
      provider_call_count: 1
    };
  } catch (error) {
    return {
      skipped: true,
      warnings: [`Configured controller LLM failed for ${task}: ${truncate(error?.message || String(error), 180)}.`],
      provider_call_count: 1
    };
  } finally {
    clearTimeout(timeout);
  }
}

function targetDomain(args = {}) {
  return compactText(args.targetDomain || args.target_domain);
}

function targetProblem(args = {}) {
  return compactText(args.targetProblem || args.target_problem || args.query || args.problem);
}

function designBoundariesFor(args = {}) {
  const explicit = normalizeStringArray(args.designBoundaries || args.design_boundaries);
  if (explicit.length) return explicit;
  const text = `${targetDomain(args)} ${targetProblem(args)}`.toLowerCase();
  if (text.includes('generalized category discovery') || /\bgcd\b/.test(text)) {
    return [
      'Do not use unknown-class labels during method design or validation.',
      'Do not tune on the test split.',
      'Preserve standard known/novel data splits.',
      'Compare against baselines under matched backbone, data, and compute when possible.'
    ];
  }
  return TASK_FAMILY_DEFAULTS[taskFamilyFor(args)]?.design_boundaries || TASK_FAMILY_DEFAULTS.generic.design_boundaries;
}

function buildTaskSpecVariants(args = {}, paths = {}) {
  const domain = targetDomain(args) || 'unspecified target domain';
  const problem = targetProblem(args) || 'unspecified research problem';
  const constraints = normalizeStringArray(args.constraints || args.constraint);
  const designBoundaries = designBoundariesFor(args);
  const base = {
    record_type: 'task_spec_variant',
    project: paths.project || compactText(args.project),
    target_domain: domain,
    target_problem: problem,
    constraints,
    design_boundaries: designBoundaries,
    uncertainty_notes: [
      'Foundation implementation creates deterministic task variants; later phases should replace or revise these with LLM/Agent-assisted decomposition evidence.'
    ]
  };
  const variants = [
    {
      variant_key: 'primary',
      task_goal: problem,
      data_assumptions: ['Use only assumptions supplied by the user or recoverable from PaperNexus evidence.'],
      evaluation_metrics: ['task primary metric', 'baseline comparability', 'ablation interpretability'],
      baseline_family: ['target-domain baselines'],
      failure_modes: ['task framing drift', 'missing baseline boundary'],
      status: 'selected'
    },
    {
      variant_key: 'protocol_boundary',
      task_goal: `Stress-test protocol and fair-comparison boundaries for: ${problem}`,
      data_assumptions: ['Evaluation protocol may dominate apparent novelty.'],
      evaluation_metrics: ['protocol compliance', 'baseline fairness', 'leakage risk'],
      baseline_family: ['closest prior work', 'standard benchmark baselines'],
      failure_modes: ['protocol violation', 'unfair comparison'],
      status: 'proposed'
    },
    {
      variant_key: 'mechanism_transfer',
      task_goal: `Find transferable mechanisms for: ${problem}`,
      data_assumptions: ['Near-source methods may require adaptation before they are valid in the target task.'],
      evaluation_metrics: ['mechanism fit', 'adaptation feasibility', 'risk-adjusted novelty'],
      baseline_family: ['near-domain methods', 'mechanism analogues'],
      failure_modes: ['invalid transfer', 'mechanism mismatch'],
      status: 'proposed'
    }
  ];
  return {
    record_type: 'task_spec_variants',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project || compactText(args.project),
    selected_task_spec_id: `task-spec:${stableHash(`${paths.project || args.project}:${domain}:${problem}:primary`, 18)}`,
    variants: variants.map((variant) => ({
      ...base,
      ...variant,
      task_spec_id: `task-spec:${stableHash(`${paths.project || args.project}:${domain}:${problem}:${variant.variant_key}`, 18)}`,
      created_at: nowIso()
    })),
    generatedAt: nowIso()
  };
}

function subproblemHints(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  return normalizeStringArray(args.subproblemHints || args.subproblem_hints || externalInputs.subproblem_hints || externalInputs.subproblemHints);
}

function defaultSubproblemSeeds(args = {}) {
  const hints = subproblemHints(args);
  if (hints.length) {
    return hints.map((name) => ({
      name,
      abstract_challenge: `Analyze ${name} as a task-local research subproblem.`,
      failure_modes: ['missing evidence', 'metric mismatch'],
      metrics: ['task metric', 'ablation signal'],
      query_plan: [name, `${targetProblem(args)} ${name}`].map(compactText).filter(Boolean)
    }));
  }
  const text = `${targetDomain(args)} ${targetProblem(args)}`.toLowerCase();
  if (text.includes('generalized category discovery') || /\bgcd\b/.test(text)) return GCD_SUBPROBLEMS;
  const problem = targetProblem(args);
  const defaults = TASK_FAMILY_DEFAULTS[taskFamilyFor(args)] || TASK_FAMILY_DEFAULTS.generic;
  return defaults.subproblems.map((seed) => ({
    ...seed,
    query_plan: unique((seed.query_plan || [])
      .map((query) => compactText(query ? `${problem} ${query}` : problem))
      .filter(Boolean))
  }));
}

function buildSubproblemGraph(args = {}, taskSpecVariants = {}, paths = {}) {
  const selectedTaskSpecId = taskSpecVariants.selected_task_spec_id || null;
  const seeds = defaultSubproblemSeeds(args);
  const subproblems = seeds.map((seed, index) => ({
    subproblem_id: `subproblem:${stableHash(`${paths.project || args.project}:${selectedTaskSpecId}:${seed.name}`, 16)}`,
    name: seed.name,
    abstract_challenge: seed.abstract_challenge,
    failure_modes: seed.failure_modes || [],
    metrics: seed.metrics || [],
    query_plan: unique((seed.query_plan || []).map(compactText).filter(Boolean)),
    priority: index + 1,
    status: 'proposed'
  }));
  const dependencies = subproblems.slice(1).map((subproblem) => ({
    source: subproblems[0].subproblem_id,
    target: subproblem.subproblem_id,
    relation_type: 'CONTEXT_FOR',
    confidence: 0.4
  }));
  return {
    record_type: 'subproblem_graph',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project || compactText(args.project),
    decomposition_version: `decomp:${stableHash(`${paths.project || args.project}:${selectedTaskSpecId}:${subproblems.map((entry) => entry.name).join('|')}`, 16)}`,
    task_spec_id: selectedTaskSpecId,
    subproblems,
    dependencies,
    failure_modes: unique(subproblems.flatMap((entry) => entry.failure_modes || [])),
    metrics: unique(subproblems.flatMap((entry) => entry.metrics || [])),
    query_plans: subproblems.map((entry) => ({
      subproblem_id: entry.subproblem_id,
      queries: entry.query_plan || []
    })),
    status: 'selected',
    generatedAt: nowIso()
  };
}

function mvpContractFor(args = {}, paths = {}, subproblemGraph = {}) {
  const taskFamily = taskFamilyFor(args);
  const subproblems = subproblemGraph.subproblems?.length
    ? subproblemGraph.subproblems
    : defaultSubproblemSeeds(args);
  const isGcd = taskFamily === 'gcd';
  return {
    record_type: 'research_controller_mvp_contract',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project_id: paths.project || researchControllerProject(args),
    default_project_id: isGcd ? DEFAULT_GCD_PROJECT_ID : DEFAULT_RESEARCH_CONTROLLER_PROJECT_ID,
    corpus: compactText(args.corpus) || (isGcd ? 'GCD' : null),
    task_family: taskFamily,
    mode: normalizeMode(args.mode),
    subproblem_names: subproblems.map((entry) => entry.name).filter(Boolean),
    required_min_candidate_nodes: isGcd ? 30 : null,
    required_min_subproblems: isGcd ? 5 : null,
    design_boundaries: designBoundariesFor(args),
    provider_import_defaults: {
      max_provider_queries: 0,
      max_imports: 0,
      provider_evidence_enabled: false,
      literature_discovery_enabled: false,
      import_submission_enabled: false
    },
    validation_policy: {
      live_validation_required_for_completion: isGcd,
      validation_surface: 'papernexus-remote.agent_materials(operation="research_controller")',
      local_substitute_allowed: false
    }
  };
}

function buildDecompositionReview(args = {}, subproblemGraph = {}, paths = {}) {
  return {
    record_type: 'decomposition_review',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project || compactText(args.project),
    review_id: `decomp-review:${stableHash(`${paths.project || args.project}:${subproblemGraph.decomposition_version}`, 16)}`,
    decomposition_version: subproblemGraph.decomposition_version,
    missing_subproblem_risk: 'unknown_until_graph_retrieval',
    over_decomposition_risk: 'unknown_until_graph_retrieval',
    dependency_error_risk: 'medium',
    metric_mismatch_risk: 'medium',
    alternative_decompositions: [],
    critic_questions: [
      'Does this decomposition preserve the original task protocol?',
      'Which subproblem is most likely to dominate evaluation gains?',
      'Which subproblem needs evidence before candidate generation?'
    ],
    human_decision: null,
    generatedAt: nowIso()
  };
}

function normalizeTaskSpecVariant(entry = {}, args = {}, paths = {}, index = 0) {
  const variantKey = compactText(entry.variant_key || entry.variantKey || entry.key) || `variant_${index + 1}`;
  const domain = compactText(entry.target_domain || entry.targetDomain || targetDomain(args)) || 'unspecified target domain';
  const problem = compactText(entry.target_problem || entry.targetProblem || targetProblem(args)) || 'unspecified research problem';
  return {
    record_type: 'task_spec_variant',
    task_spec_id: compactText(entry.task_spec_id || entry.taskSpecId) || `task-spec:${stableHash(`${paths.project || args.project}:${domain}:${problem}:${variantKey}`, 18)}`,
    variant_key: variantKey,
    project: paths.project || compactText(args.project),
    target_domain: domain,
    target_problem: problem,
    task_goal: compactText(entry.task_goal || entry.taskGoal) || problem,
    data_assumptions: normalizeStringArray(entry.data_assumptions || entry.dataAssumptions),
    evaluation_metrics: normalizeStringArray(entry.evaluation_metrics || entry.evaluationMetrics),
    constraints: normalizeStringArray(entry.constraints || args.constraints || args.constraint),
    baseline_family: normalizeStringArray(entry.baseline_family || entry.baselineFamily),
    failure_modes: normalizeStringArray(entry.failure_modes || entry.failureModes),
    design_boundaries: normalizeStringArray(entry.design_boundaries || entry.designBoundaries || designBoundariesFor(args)),
    uncertainty_notes: normalizeStringArray(entry.uncertainty_notes || entry.uncertaintyNotes || 'Generated task framing requires review before deep retrieval.'),
    provenance: normalizeStringArray(entry.provenance || entry.labels || 'agent_or_controller_inferred'),
    status: compactText(entry.status) || (index === 0 ? 'selected' : 'proposed'),
    created_at: entry.created_at || entry.createdAt || nowIso()
  };
}

function normalizeTaskSpecVariantsPayload(payload = {}, args = {}, paths = {}) {
  const source = normalizeObject(payload.task_spec_variants || payload.taskSpecVariants || payload);
  const variantsInput = asArray(source.variants || payload.variants)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => Object.keys(entry).length);
  if (!variantsInput.length) return buildTaskSpecVariants(args, paths);
  const variants = variantsInput.map((entry, index) => normalizeTaskSpecVariant(entry, args, paths, index));
  const selected = variants.find((variant) => variant.status === 'selected') || variants[0];
  return {
    record_type: 'task_spec_variants',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project || compactText(args.project),
    selected_task_spec_id: compactText(source.selected_task_spec_id || source.selectedTaskSpecId) || selected.task_spec_id,
    variants: variants.map((variant) => ({
      ...variant,
      status: variant.task_spec_id === (compactText(source.selected_task_spec_id || source.selectedTaskSpecId) || selected.task_spec_id)
        ? 'selected'
        : (variant.status === 'selected' ? 'proposed' : variant.status)
    })),
    generation: {
      backend: compactText(payload.backend || source.backend) || 'external_or_llm_payload',
      evidence_labels_required: true
    },
    generatedAt: source.generatedAt || source.generated_at || nowIso()
  };
}

function normalizeSubproblem(entry = {}, taskSpecVariants = {}, args = {}, paths = {}, index = 0) {
  const name = compactText(entry.name || entry.subproblem || entry.title) || `subproblem ${index + 1}`;
  const selectedTaskSpecId = taskSpecVariants.selected_task_spec_id || null;
  return {
    subproblem_id: compactText(entry.subproblem_id || entry.subproblemId) || `subproblem:${stableHash(`${paths.project || args.project}:${selectedTaskSpecId}:${name}`, 16)}`,
    name,
    abstract_challenge: compactText(entry.abstract_challenge || entry.abstractChallenge || entry.challenge) || `Analyze ${name} as a task-local research subproblem.`,
    failure_modes: normalizeStringArray(entry.failure_modes || entry.failureModes),
    metrics: normalizeStringArray(entry.metrics || entry.evaluation_metrics || entry.evaluationMetrics),
    query_plan: unique(normalizeStringArray(entry.query_plan || entry.queryPlan || entry.queries || [name, `${targetProblem(args)} ${name}`])),
    evidence_labels: normalizeObject(entry.evidence_labels || entry.evidenceLabels),
    priority: boundedInteger(entry.priority, index + 1, { min: 1, max: 1000 }),
    status: compactText(entry.status) || 'proposed'
  };
}

function normalizeDependency(entry = {}, idByName = new Map()) {
  const source = compactText(entry.source || entry.from || entry.source_subproblem_id || entry.sourceSubproblemId);
  const target = compactText(entry.target || entry.to || entry.target_subproblem_id || entry.targetSubproblemId);
  const sourceId = idByName.get(source.toLowerCase()) || source;
  const targetId = idByName.get(target.toLowerCase()) || target;
  if (!sourceId || !targetId || sourceId === targetId) return null;
  return {
    source: sourceId,
    target: targetId,
    relation_type: compactText(entry.relation_type || entry.relationType || entry.type) || 'DEPENDS_ON',
    confidence: normalizeScore(entry.confidence, 0.5)
  };
}

function normalizeSubproblemGraphPayload(payload = {}, args = {}, taskSpecVariants = {}, paths = {}) {
  const source = normalizeObject(payload.subproblem_graph || payload.subproblemGraph || payload);
  const subproblemInput = asArray(source.subproblems || payload.subproblems)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => Object.keys(entry).length);
  if (!subproblemInput.length) return buildSubproblemGraph(args, taskSpecVariants, paths);
  const subproblems = subproblemInput.map((entry, index) => normalizeSubproblem(entry, taskSpecVariants, args, paths, index));
  const idByName = new Map(subproblems.flatMap((subproblem) => [
    [subproblem.name.toLowerCase(), subproblem.subproblem_id],
    [subproblem.subproblem_id.toLowerCase(), subproblem.subproblem_id]
  ]));
  const dependencies = asArray(source.dependencies || source.edges || payload.dependencies)
    .map((entry) => normalizeDependency(normalizeObject(entry), idByName))
    .filter(Boolean);
  return {
    record_type: 'subproblem_graph',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project || compactText(args.project),
    decomposition_version: compactText(source.decomposition_version || source.decompositionVersion) || `decomp:${stableHash(`${paths.project || args.project}:${taskSpecVariants.selected_task_spec_id}:${subproblems.map((entry) => entry.name).join('|')}`, 16)}`,
    task_spec_id: compactText(source.task_spec_id || source.taskSpecId) || taskSpecVariants.selected_task_spec_id || null,
    subproblems,
    dependencies,
    failure_modes: unique([
      ...normalizeStringArray(source.failure_modes || source.failureModes),
      ...subproblems.flatMap((entry) => entry.failure_modes || [])
    ]),
    metrics: unique([
      ...normalizeStringArray(source.metrics || source.evaluation_metrics || source.evaluationMetrics),
      ...subproblems.flatMap((entry) => entry.metrics || [])
    ]),
    query_plans: subproblems.map((entry) => ({
      subproblem_id: entry.subproblem_id,
      queries: entry.query_plan || []
    })),
    alternatives: asArray(source.alternatives || source.alternative_decompositions || source.alternativeDecompositions),
    uncertainty_notes: normalizeStringArray(source.uncertainty_notes || source.uncertaintyNotes),
    status: compactText(source.status) || 'selected',
    generatedAt: source.generatedAt || source.generated_at || nowIso()
  };
}

function normalizeDecompositionReviewPayload(payload = {}, args = {}, subproblemGraph = {}, paths = {}) {
  const source = normalizeObject(payload.decomposition_review || payload.decompositionReview || payload);
  const fallback = buildDecompositionReview(args, subproblemGraph, paths);
  return {
    ...fallback,
    review_id: compactText(source.review_id || source.reviewId) || fallback.review_id,
    decomposition_version: compactText(source.decomposition_version || source.decompositionVersion) || subproblemGraph.decomposition_version || fallback.decomposition_version,
    missing_subproblem_risk: source.missing_subproblem_risk ?? source.missingSubproblemRisk ?? fallback.missing_subproblem_risk,
    over_decomposition_risk: source.over_decomposition_risk ?? source.overDecompositionRisk ?? fallback.over_decomposition_risk,
    dependency_error_risk: source.dependency_error_risk ?? source.dependencyErrorRisk ?? fallback.dependency_error_risk,
    metric_mismatch_risk: source.metric_mismatch_risk ?? source.metricMismatchRisk ?? fallback.metric_mismatch_risk,
    alternative_decompositions: asArray(source.alternative_decompositions || source.alternativeDecompositions || fallback.alternative_decompositions),
    critic_questions: normalizeStringArray(source.critic_questions || source.criticQuestions || fallback.critic_questions),
    recommendation: compactText(source.recommendation) || 'accept_with_review',
    confidence: normalizeScore(source.confidence, 0.5),
    human_decision: source.human_decision ?? source.humanDecision ?? null,
    generatedAt: source.generatedAt || source.generated_at || nowIso()
  };
}

function externalDecompositionPayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = externalInputs.decomposition_payload || externalInputs.decompositionPayload || args.decompositionPayload || args.decomposition_payload;
  if (payload) return normalizeObject(payload);
  const taskSpecVariants = externalInputs.task_spec_variants || externalInputs.taskSpecVariants || args.taskSpecVariants || args.task_spec_variants;
  const subproblemGraph = externalInputs.subproblem_graph || externalInputs.subproblemGraph || args.subproblemGraph || args.subproblem_graph;
  if (taskSpecVariants || subproblemGraph) {
    return {
      task_spec_variants: taskSpecVariants,
      subproblem_graph: subproblemGraph
    };
  }
  return null;
}

function externalDecompositionReviewPayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  return normalizeObject(
    externalInputs.decomposition_review_payload
    || externalInputs.decompositionReviewPayload
    || externalInputs.decomposition_review
    || externalInputs.decompositionReview
    || args.decompositionReviewPayload
    || args.decomposition_review_payload
    || args.decompositionReview
    || args.decomposition_review
  );
}

function buildDecompositionRequest(overlay = {}, state = {}, args = {}) {
  return {
    task: 'research_controller.generate_decomposition',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    task_id: state.task_id || null,
    target_domain: state.target_domain || targetDomain(args) || null,
    target_problem: state.target_problem || targetProblem(args) || null,
    constraints: normalizeStringArray(args.constraints || args.constraint),
    design_boundaries: state.constraints?.design_boundaries || designBoundariesFor(args),
    budget: state.budget || normalizeBudget(args),
    provider_policy: state.provider_policy || normalizeProviderPolicy(args),
    judge: state.judge || normalizeJudge(args),
    existing_task_spec: overlay.taskSpecVariants || null,
    existing_subproblem_graph: overlay.subproblemGraph || null,
    output_schema: {
      task_spec_variants: {
        variants: ['2-3 task spec variants with uncertainty_notes and status'],
        selected_task_spec_id: 'string'
      },
      subproblem_graph: {
        subproblems: ['5-7 subproblems with failure_modes, metrics, query_plan, evidence_labels'],
        dependencies: ['bounded dependency edges'],
        uncertainty_notes: ['string']
      }
    }
  };
}

function buildDecompositionPrompt(request = {}) {
  return [
    'You are generating PaperNexus research-controller task framing and decomposition artifacts.',
    'Return strict JSON only.',
    'Generate 2-3 task spec variants and one selected subproblem graph.',
    'Every assumption must be labelable as evidence-supported, domain-common, agent-inferred, or uncertain.',
    'Do not claim paper facts without supplied evidence.',
    '',
    `Decomposition request: ${JSON.stringify(request)}`
  ].join('\n');
}

function buildReviewDecompositionRequest(overlay = {}, state = {}, args = {}) {
  return {
    task: 'research_controller.review_decomposition',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    task_id: state.task_id || null,
    target_domain: state.target_domain || null,
    target_problem: state.target_problem || null,
    budget: state.budget || normalizeBudget(args),
    provider_policy: state.provider_policy || normalizeProviderPolicy(args),
    judge: state.judge || normalizeJudge(args),
    task_spec_variants: overlay.taskSpecVariants || null,
    subproblem_graph: overlay.subproblemGraph || null,
    output_schema: {
      missing_subproblem_risk: 'low|medium|high or numeric',
      over_decomposition_risk: 'low|medium|high or numeric',
      dependency_error_risk: 'low|medium|high or numeric',
      metric_mismatch_risk: 'low|medium|high or numeric',
      alternative_decompositions: ['string or object'],
      critic_questions: ['string'],
      recommendation: 'accept|revise|ask_human',
      confidence: '0..1'
    }
  };
}

function buildReviewDecompositionPrompt(request = {}) {
  return [
    'You are reviewing a PaperNexus research-controller task decomposition.',
    'Return strict JSON only.',
    'Focus on missing subproblems, over-decomposition, dependency errors, metric mismatch, design-boundary risk, and user-facing critic questions.',
    '',
    `Review request: ${JSON.stringify(request)}`
  ].join('\n');
}

async function runDecompositionGeneration(request = {}, args = {}, context = {}) {
  const externalPayload = externalDecompositionPayload(args);
  if (externalPayload) {
    return {
      backend: 'external_agent_inputs',
      source: 'external_inputs',
      payload: externalPayload,
      warnings: []
    };
  }
  const hook = typeof context.options?.llmJson === 'function'
    ? context.options.llmJson
    : (typeof args.llmJson === 'function' ? args.llmJson : null);
  if (hook) {
    const payload = await hook({
      task: 'research_controller.generate_decomposition',
      prompt: buildDecompositionPrompt(request),
      args,
      decompositionRequest: request
    });
    return {
      backend: 'single_model_llm_json',
      source: 'llm_json_hook',
      payload: typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload),
      warnings: []
    };
  }
  const providerRun = await requestConfiguredControllerLlmJson(
    'research_controller.generate_decomposition',
    buildDecompositionPrompt(request),
    argsWithControllerRequestPolicy(args, request),
    context
  );
  if (providerRun.payload) return providerRun;
  return {
    backend: 'controller_deterministic_fallback',
    source: 'controller_deterministic_fallback',
    payload: {},
    warnings: [
      ...(providerRun.warnings || []),
      'No external decomposition payload, llmJson hook, or configured controller LLM payload was available; refreshed deterministic task/decomposition scaffolds.'
    ]
  };
}

async function runDecompositionReview(request = {}, args = {}, context = {}) {
  const externalPayload = externalDecompositionReviewPayload(args);
  if (Object.keys(externalPayload).length) {
    return {
      backend: 'external_agent_inputs',
      source: 'external_inputs',
      payload: externalPayload,
      warnings: []
    };
  }
  const hook = typeof context.options?.llmJson === 'function'
    ? context.options.llmJson
    : (typeof args.llmJson === 'function' ? args.llmJson : null);
  if (hook) {
    const payload = await hook({
      task: 'research_controller.review_decomposition',
      prompt: buildReviewDecompositionPrompt(request),
      args,
      decompositionReviewRequest: request
    });
    return {
      backend: 'single_model_llm_json',
      source: 'llm_json_hook',
      payload: typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload),
      warnings: []
    };
  }
  const providerRun = await requestConfiguredControllerLlmJson(
    'research_controller.review_decomposition',
    buildReviewDecompositionPrompt(request),
    argsWithControllerRequestPolicy(args, request),
    context
  );
  if (providerRun.payload) return providerRun;
  return {
    backend: 'controller_review_fallback',
    source: 'controller_review_fallback',
    payload: buildDecompositionReview(args, request.subproblem_graph || {}, {}),
    warnings: [
      ...(providerRun.warnings || []),
      'No external decomposition review payload, llmJson hook, or configured controller LLM payload was available; wrote controller fallback review.'
    ]
  };
}

function buildControllerState(args = {}, taskSpecVariants = {}, subproblemGraph = {}, paths = {}) {
  const mode = normalizeMode(args.mode);
  const budget = normalizeBudget(args);
  const currentRound = 0;
  const nextActions = [
    'generate_decomposition',
    'review_decomposition',
    'generate_candidates',
    'propose_edges',
    'judge_batch',
    'select_batch',
    'compose_solutions',
    'design_review',
    'compose_innovation_briefs',
    'export'
  ];
  if (budget.task_family === 'gcd') nextActions.push('validate_gcd_mvp');
  return {
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project,
    task_id: `task:${stableHash(`${paths.project}:${targetDomain(args)}:${targetProblem(args)}`, 16)}`,
    target_domain: targetDomain(args) || null,
    target_problem: targetProblem(args) || null,
    mode,
    current_round: currentRound,
    lifecycle: 'initialized',
    budget,
    llm_assistance: {
      task_spec_generation: 'pending',
      decomposition_generation: 'pending',
      decomposition_review: 'pending',
      judge_mode: 'single_model',
      judge_model: normalizeJudge(args).model
    },
    constraints: {
      require_baseline: true,
      require_metric: true,
      max_estimated_cost: null,
      allow_far_source: true,
      design_boundaries: designBoundariesFor(args)
    },
    mvp_contract: mvpContractFor(args, paths, subproblemGraph),
    provider_policy: normalizeProviderPolicy(args),
    judge: normalizeJudge(args),
    selected_task_spec_id: taskSpecVariants.selected_task_spec_id || null,
    selected_decomposition_version: subproblemGraph.decomposition_version || null,
    posterior: {
      mechanism_values: {},
      source_domain_values: {},
      judge_self_consistency: null
    },
    selected_batch: [],
    next_actions: nextActions,
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

function updateStateAfterDecompositionGeneration(state = {}, taskSpecVariants = {}, subproblemGraph = {}, run = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'generate_decomposition');
  for (const action of ['review_decomposition', 'generate_candidates', 'propose_edges', 'judge_batch', 'select_batch', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: subproblemGraph.subproblems?.length ? 'decomposition_generated' : 'needs_decomposition',
    selected_task_spec_id: taskSpecVariants.selected_task_spec_id || state.selected_task_spec_id || null,
    selected_decomposition_version: subproblemGraph.decomposition_version || state.selected_decomposition_version || null,
    llm_assistance: {
      ...(state.llm_assistance || {}),
      task_spec_generation: run.backend || 'unknown',
      decomposition_generation: run.backend || 'unknown'
    },
    decomposition_generation: {
      backend: run.backend || 'unknown',
      source: run.source || null,
      model: run.model || null,
      provider_call_count: run.provider_call_count || 0,
      task_spec_variant_count: taskSpecVariants.variants?.length || 0,
      subproblem_count: subproblemGraph.subproblems?.length || 0,
      dependency_count: subproblemGraph.dependencies?.length || 0,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterDecompositionReview(state = {}, review = {}, run = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'review_decomposition');
  for (const action of ['generate_candidates', 'propose_edges', 'judge_batch', 'select_batch', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: review.review_id ? 'decomposition_reviewed' : 'needs_decomposition_review',
    selected_decomposition_version: review.decomposition_version || state.selected_decomposition_version || null,
    llm_assistance: {
      ...(state.llm_assistance || {}),
      decomposition_review: run.backend || 'unknown'
    },
    decomposition_review: {
      backend: run.backend || 'unknown',
      source: run.source || null,
      model: run.model || null,
      provider_call_count: run.provider_call_count || 0,
      recommendation: review.recommendation || null,
      confidence: review.confidence ?? null,
      critic_question_count: review.critic_questions?.length || 0,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterCandidateGeneration(state = {}, generated = [], warnings = [], searchTrace = null) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'generate_candidates');
  for (const action of ['propose_edges', 'judge_batch', 'select_batch', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: generated.length ? 'candidates_generated' : 'needs_candidate_evidence',
    candidate_generation: {
      backend: searchTrace?.policy || 'committed_graph_search',
      generated_count: generated.length,
      search_trace_id: searchTrace?.trace_id || null,
      finalized_state_count: searchTrace?.finalized_state_ids?.length || 0,
      requisition_state_count: searchTrace?.requisition_state_ids?.length || 0,
      distinct_challenge_aspect_count: searchTrace?.distinct_challenge_aspect_count || 0,
      distinct_mechanism_count: searchTrace?.distinct_mechanism_count || 0,
      requisition_rate: searchTrace?.requisition_rate ?? null,
      warnings
    },
    search_trace_summary: searchTrace ? {
      trace_id: searchTrace.trace_id,
      policy: searchTrace.policy,
      candidate_count: searchTrace.candidate_count,
      finalized_state_count: searchTrace.finalized_state_ids?.length || 0,
      requisition_state_count: searchTrace.requisition_state_ids?.length || 0,
      distinct_challenge_aspect_count: searchTrace.distinct_challenge_aspect_count,
      distinct_mechanism_count: searchTrace.distinct_mechanism_count,
      requisition_rate: searchTrace.requisition_rate
    } : state.search_trace_summary || null,
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterEdgeProposal(state = {}, proposed = [], warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'propose_edges');
  for (const action of ['judge_batch', 'select_batch', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: proposed.length ? 'candidate_edges_proposed' : 'needs_candidate_edges',
    candidate_edge_generation: {
      backend: 'heuristic_blocked_candidate_graph',
      generated_count: proposed.length,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterJudgeBatch(state = {}, decisions = [], judgeRun = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'judge_batch');
  for (const action of ['select_batch', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  const selfConsistency = judgeRun.self_consistency || 'not_measured_single_pass';
  return {
    ...state,
    lifecycle: decisions.length ? 'judged' : 'needs_judgment',
    judge_batch: {
      backend: judgeRun.backend || 'unknown',
      model: judgeRun.model || null,
      generated_count: decisions.length,
      node_decision_count: decisions.filter((decision) => decision.decision_scope === 'candidate_node').length,
      edge_decision_count: decisions.filter((decision) => decision.decision_scope === 'candidate_edge').length,
      pairwise_preference_count: decisions.filter((decision) => decision.decision_scope === 'candidate_pairwise_preference').length,
      consistency_probe_decision_count: judgeRun.consistency_probe_decision_count || 0,
      self_consistency: selfConsistency,
      provider_call_count: judgeRun.provider_call_count || 0,
      warnings
    },
    posterior: {
      ...(state.posterior || {}),
      judge_self_consistency: selfConsistency
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterSelection(state = {}, selectionPayload = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'select_batch');
  for (const action of ['expand_evidence', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  const selectedBatch = (selectionPayload.subgraphs || []).flatMap((subgraph) => subgraph.candidate_ids || []);
  const posterior = selectionPayload.posterior
    ? {
        ...(state.posterior || {}),
        ...selectionPayload.posterior,
        judge_self_consistency: state.posterior?.judge_self_consistency ?? selectionPayload.posterior.judge_self_consistency ?? null
      }
    : state.posterior;
  return {
    ...state,
    lifecycle: selectedBatch.length ? 'batch_selected' : 'needs_selection',
    selected_batch: selectedBatch,
    posterior,
    bandit_state_summary: selectionPayload.bandit_state_summary || state.bandit_state_summary || null,
    selection_trace_summary: selectionPayload.selection_trace ? {
      trace_id: selectionPayload.selection_trace.trace_id,
      selector: selectionPayload.selection_trace.selector,
      selectors: (selectionPayload.selection_trace.selectors || []).map((selector) => selector.selector),
      topk_selected_candidate_ids: selectionPayload.selection_trace.ablation_summary?.topk_selected_candidate_ids || [],
      mmr_selected_candidate_ids: selectionPayload.selection_trace.ablation_summary?.mmr_selected_candidate_ids || [],
      greedy_submodular_selected_candidate_ids: selectionPayload.selection_trace.ablation_summary?.greedy_submodular_selected_candidate_ids || []
    } : state.selection_trace_summary || null,
    selection_batch: {
      backend: selectionPayload.selection_policy?.backend || 'controller_greedy_selection',
      selected_count: selectedBatch.length,
      subgraph_count: selectionPayload.subgraphs?.length || 0,
      parked_count: selectionPayload.parked?.length || 0,
      rejected_count: selectionPayload.rejected?.length || 0,
      posterior_backend: selectionPayload.posterior?.backend || null,
      posterior_candidate_count: Object.keys(selectionPayload.posterior?.candidate_values || {}).length,
      selection_trace_id: selectionPayload.selection_trace?.trace_id || null,
      bandit_policy: selectionPayload.bandit_state_summary?.policy || null,
      bandit_arm_count: selectionPayload.bandit_state_summary?.arms?.length || 0,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterEvidenceExpansion(state = {}, methodCardPack = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'expand_evidence');
  for (const action of ['execute_material_requests', 'record_material_results', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: methodCardPack.method_cards?.length ? 'evidence_expanded' : 'needs_evidence',
    method_card_pack: {
      backend: methodCardPack.expansion_policy?.backend || 'selected_graph_materials',
      method_card_count: methodCardPack.method_cards?.length || 0,
      selected_subgraph_count: methodCardPack.selected_subgraph_count || 0,
      missing_evidence_count: methodCardPack.missing_evidence?.length || 0,
      provider_evidence_enabled: methodCardPack.expansion_policy?.provider_evidence_enabled || false,
      live_discovery_enabled: methodCardPack.expansion_policy?.live_discovery_enabled || false,
      literature_discovery_enabled: methodCardPack.expansion_policy?.literature_discovery_enabled || false,
      import_submission_enabled: methodCardPack.expansion_policy?.import_submission_enabled || false,
      material_expansion_request_count: methodCardPack.material_expansion_requests?.length || 0,
      provider_evidence_requested: methodCardPack.expansion_policy?.provider_evidence_requested || false,
      live_discovery_requested: methodCardPack.expansion_policy?.live_discovery_requested || false,
      literature_discovery_requested: methodCardPack.expansion_policy?.literature_discovery_requested || false,
      import_submission_requested: methodCardPack.expansion_policy?.import_submission_requested || false,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterMaterialRequestExecution(state = {}, resultRecords = [], methodCardPack = {}, warnings = [], designReview = null, decompositionDriftReview = null) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'execute_material_requests');
  for (const action of ['record_material_results', 'compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  if (designReview?.reviews?.length && !nextActions.includes('generate_experiment_plan')) {
    nextActions.push('generate_experiment_plan');
  }
  if (decompositionDriftReview?.requires_revisit && !nextActions.includes('review_decomposition')) {
    nextActions.unshift('review_decomposition');
  }
  return {
    ...state,
    lifecycle: resultRecords.length ? 'material_requests_executed' : (state.lifecycle || 'evidence_expanded'),
    material_results: {
      backend: 'controller_executed_material_requests',
      executed_count: resultRecords.length,
      total_recorded_count: methodCardPack.material_result_count || resultRecords.length,
      request_count: methodCardPack.material_expansion_requests?.length || 0,
      fulfilled_request_count: methodCardPack.fulfilled_material_expansion_request_count || 0,
      closest_prior_request_count: designReview?.closest_prior_expansion_requests?.length || 0,
      fulfilled_closest_prior_request_count: designReview?.fulfilled_closest_prior_expansion_request_count || 0,
      warnings
    },
    decomposition_drift: decompositionDriftStateSummary(decompositionDriftReview),
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterMaterialResults(state = {}, resultRecords = [], methodCardPack = {}, warnings = [], designReview = null, decompositionDriftReview = null) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'record_material_results');
  for (const action of ['compose_solutions', 'design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  if (designReview?.reviews?.length && !nextActions.includes('generate_experiment_plan')) {
    nextActions.push('generate_experiment_plan');
  }
  if (decompositionDriftReview?.requires_revisit && !nextActions.includes('review_decomposition')) {
    nextActions.unshift('review_decomposition');
  }
  return {
    ...state,
    lifecycle: resultRecords.length ? 'material_results_recorded' : (state.lifecycle || 'evidence_expanded'),
    material_results: {
      backend: 'external_agent_material_results',
      recorded_count: resultRecords.length,
      total_recorded_count: methodCardPack.material_result_count || resultRecords.length,
      request_count: methodCardPack.material_expansion_requests?.length || 0,
      fulfilled_request_count: methodCardPack.fulfilled_material_expansion_request_count || 0,
      closest_prior_request_count: designReview?.closest_prior_expansion_requests?.length || 0,
      fulfilled_closest_prior_request_count: designReview?.fulfilled_closest_prior_expansion_request_count || 0,
      warnings
    },
    decomposition_drift: decompositionDriftStateSummary(decompositionDriftReview),
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterSolutionComposition(state = {}, solutionSketches = [], warnings = [], runMeta = {}) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'compose_solutions');
  for (const action of ['design_review', 'compose_innovation_briefs', 'export']) {
    if (!nextActions.includes(action)) nextActions.push(action);
  }
  return {
    ...state,
    lifecycle: solutionSketches.length ? 'solutions_composed' : 'needs_solution_composition',
    solution_composition: {
      backend: runMeta.backend || 'selected_subgraph_solution_composer',
      source: runMeta.source || 'controller_deterministic_fallback',
      model: runMeta.model || null,
      provider_call_count: runMeta.provider_call_count || 0,
      solution_count: solutionSketches.length,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterDesignReview(state = {}, designReview = {}, warnings = [], decompositionDriftReview = null) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'design_review');
  if (!nextActions.includes('compose_innovation_briefs')) nextActions.push('compose_innovation_briefs');
  if (!nextActions.includes('generate_experiment_plan')) nextActions.push('generate_experiment_plan');
  if (!nextActions.includes('export')) nextActions.push('export');
  if (decompositionDriftReview?.requires_revisit && !nextActions.includes('review_decomposition')) {
    nextActions.unshift('review_decomposition');
  }
  const reviews = designReview.reviews || [];
  return {
    ...state,
    lifecycle: reviews.length ? 'design_reviewed' : 'needs_design_review',
    design_review: {
      backend: designReview.review_policy?.backend || 'controller_structured_review',
      source: designReview.review_policy?.source || null,
      model: designReview.review_policy?.model || null,
      provider_call_count: designReview.review_policy?.provider_call_count || 0,
      review_count: reviews.length,
      recommend_count: reviews.filter((review) => review.decision === 'recommend').length,
      revise_count: reviews.filter((review) => review.decision === 'revise').length,
      reject_count: reviews.filter((review) => review.decision === 'reject').length,
      warnings
    },
    decomposition_drift: decompositionDriftStateSummary(decompositionDriftReview),
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterInnovationBriefs(state = {}, innovationBriefs = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'compose_innovation_briefs');
  if (!nextActions.includes('generate_experiment_plan')) nextActions.push('generate_experiment_plan');
  if (!nextActions.includes('export')) nextActions.push('export');
  const briefs = innovationBriefs.briefs || [];
  return {
    ...state,
    lifecycle: briefs.length ? 'innovation_briefs_composed' : 'needs_innovation_briefs',
    innovation_briefs: {
      backend: innovationBriefs.brief_policy?.backend || 'controller_export_bound_brief',
      brief_count: briefs.length,
      warning_count: warnings.length,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterExperimentPlan(state = {}, experimentPlan = {}, warnings = []) {
  const nextActions = (state.next_actions || []).filter((action) => action !== 'generate_experiment_plan');
  if (!nextActions.includes('export')) nextActions.push('export');
  const plans = experimentPlan.plans || [];
  return {
    ...state,
    lifecycle: plans.length ? 'experiment_plan_generated' : 'needs_experiment_plan',
    experiment_plan: {
      backend: experimentPlan.plan_policy?.backend || 'controller_static_experiment_planner',
      plan_count: plans.length,
      execution_status: experimentPlan.execution_status || 'not_executed',
      approval_source: experimentPlan.approval?.source || null,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function updateStateAfterGcdMvpValidation(state = {}, validationReport = {}, warnings = []) {
  const recommended = (validationReport.recommended_next_actions || [])
    .filter((action) => CONTROLLER_ACTIONS.has(action));
  const nextActions = unique([
    ...recommended.filter((action) => action !== 'validate_gcd_mvp'),
    ...(['ok', 'not_applicable'].includes(validationReport.overall_status) ? [] : ['validate_gcd_mvp']),
    'export'
  ]);
  const summary = validationReport.summary || {};
  return {
    ...state,
    lifecycle: validationReport.overall_status === 'ok'
      ? 'gcd_mvp_validated'
      : (validationReport.overall_status === 'not_applicable'
        ? state.lifecycle || 'initialized'
        : (validationReport.overall_status === 'blocked'
          ? 'gcd_mvp_validation_blocked'
          : 'needs_gcd_mvp_validation_artifacts')),
    gcd_mvp_validation: {
      validation_id: validationReport.validation_id || null,
      overall_status: validationReport.overall_status || 'unknown',
      local_artifact_status: validationReport.local_artifact_status || 'unknown',
      remote_validation_status: validationReport.remote_validation_status?.status || null,
      passed_criteria_count: summary.passed_criteria_count || 0,
      failed_criteria_count: summary.failed_criteria_count || 0,
      blocked_criteria_count: summary.blocked_criteria_count || 0,
      warning_count: warnings.length,
      warnings
    },
    next_actions: nextActions,
    updated_at: nowIso()
  };
}

function summarizeState(state = null, overlay = {}) {
  const candidateCounts = overlay.candidateGraph || { nodes: [], edges: [] };
  return {
    empty: !state,
    lifecycle: state?.lifecycle || 'empty',
    current_round: state?.current_round ?? null,
    mode: state?.mode || null,
    task_family: state?.budget?.task_family || null,
    budget_profile: state?.budget?.profile || null,
    budget: state?.budget || null,
    mvp_contract: state?.mvp_contract || null,
    target_domain: state?.target_domain || null,
    target_problem: state?.target_problem || null,
    controller_llm_enabled: Boolean(state?.provider_policy?.enable_controller_llm),
    controller_llm_model: state?.provider_policy?.controller_llm?.model || null,
    selected_task_spec_id: state?.selected_task_spec_id || null,
    selected_decomposition_version: state?.selected_decomposition_version || null,
    candidate_node_count: candidateCounts.nodes.length,
    candidate_edge_count: candidateCounts.edges.length,
    search_trace_id: overlay.searchTrace?.trace_id || state?.search_trace_summary?.trace_id || null,
    selection_trace_id: overlay.selectionTrace?.trace_id || state?.selection_trace_summary?.trace_id || null,
    bandit_policy: overlay.banditSimulation?.policy || state?.bandit_state_summary?.policy || null,
    bandit_arm_count: overlay.banditSimulation?.arms?.length || state?.bandit_state_summary?.arms?.length || 0,
    judge_decision_count: overlay.judgeDecisions?.length || 0,
    method_card_pack_available: Boolean(overlay.methodCardPackText),
    material_expansion_result_count: overlay.materialExpansionResults?.length || 0,
    solution_sketch_count: overlay.solutionSketches?.length || 0,
    design_review_count: overlay.designReview?.reviews?.length || 0,
    decomposition_drift_status: overlay.decompositionReview?.post_evidence_drift_review?.status || state?.decomposition_drift?.status || 'none',
    decomposition_drift_signal_count: overlay.decompositionReview?.post_evidence_drift_review?.signal_count || state?.decomposition_drift?.signal_count || 0,
    posterior_backend: state?.posterior?.backend || null,
    posterior_candidate_count: Object.keys(state?.posterior?.candidate_values || {}).length,
    innovation_brief_count: overlay.innovationBriefs?.briefs?.length || 0,
    experiment_plan_count: overlay.experimentPlan?.plans?.length || 0,
    gcd_mvp_validation_status: overlay.gcdMvpValidation?.overall_status || state?.gcd_mvp_validation?.overall_status || null,
    gcd_mvp_validation_passed_criteria_count: overlay.gcdMvpValidation?.summary?.passed_criteria_count || state?.gcd_mvp_validation?.passed_criteria_count || 0,
    gcd_mvp_validation_failed_criteria_count: overlay.gcdMvpValidation?.summary?.failed_criteria_count || state?.gcd_mvp_validation?.failed_criteria_count || 0,
    remote_validation_status: overlay.gcdMvpValidation?.remote_validation_status?.status || state?.gcd_mvp_validation?.remote_validation_status || null,
    risk_note_count: overlay.riskNotes?.length || 0,
    next_actions: state?.next_actions || []
  };
}

function baseResponse(action, paths, overlay, state, extra = {}) {
  return {
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    operation: 'research_controller',
    action,
    status: extra.status || 'ok',
    project: paths.project,
    project_slug: paths.projectSlug,
    round_id: state ? `round:${state.current_round ?? 0}` : null,
    action_completed: extra.action_completed || action,
    controller_state_summary: summarizeState(state, overlay),
    artifact_paths: publicArtifactPaths(paths),
    summary: extra.summary || {
      selected_subgraphs: [],
      top_risks: [],
      missing_evidence: [],
      next_actions: state?.next_actions || []
    },
    user_decision_needed: extra.user_decision_needed || [],
    warnings: extra.warnings || [],
    generatedAt: nowIso()
  };
}

function renderRoundReportMarkdown(state = {}, subproblemGraph = {}, decompositionReview = {}) {
  const lines = [
    '# PaperNexus Research Controller Round Report',
    '',
    `- Project: ${state.project || ''}`,
    `- Target domain: ${state.target_domain || ''}`,
    `- Target problem: ${state.target_problem || ''}`,
    `- Mode: ${state.mode || ''}`,
    `- Lifecycle: ${state.lifecycle || ''}`,
    '',
    '## Selected Decomposition',
    ''
  ];
  for (const subproblem of subproblemGraph.subproblems || []) {
    lines.push(`- ${subproblem.name}: ${subproblem.abstract_challenge}`);
  }
  lines.push('', '## Critic Questions', '');
  for (const question of decompositionReview.critic_questions || []) {
    lines.push(`- ${question}`);
  }
  lines.push('', '## Next Actions', '');
  for (const action of state.next_actions || []) {
    lines.push(`- ${action}`);
  }
  if (state.decomposition_generation) {
    lines.push('', '## Decomposition Generation', '');
    lines.push(`- Backend: ${state.decomposition_generation.backend || ''}`);
    lines.push(`- Task spec variants: ${state.decomposition_generation.task_spec_variant_count ?? 0}`);
    lines.push(`- Subproblems: ${state.decomposition_generation.subproblem_count ?? 0}`);
    lines.push(`- Dependencies: ${state.decomposition_generation.dependency_count ?? 0}`);
    for (const warning of state.decomposition_generation.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.decomposition_review) {
    lines.push('', '## Decomposition Review', '');
    lines.push(`- Backend: ${state.decomposition_review.backend || ''}`);
    lines.push(`- Recommendation: ${state.decomposition_review.recommendation || ''}`);
    lines.push(`- Confidence: ${state.decomposition_review.confidence ?? ''}`);
    lines.push(`- Critic questions: ${state.decomposition_review.critic_question_count ?? 0}`);
    for (const warning of state.decomposition_review.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.decomposition_drift) {
    lines.push('', '## Post-Evidence Decomposition Drift', '');
    lines.push(`- Status: ${state.decomposition_drift.status || 'none'}`);
    lines.push(`- Signals: ${state.decomposition_drift.signal_count ?? 0}`);
    lines.push(`- Requires revisit: ${state.decomposition_drift.requires_revisit ? 'yes' : 'no'}`);
    if (state.decomposition_drift.recommendation) {
      lines.push(`- Recommendation: ${state.decomposition_drift.recommendation}`);
    }
    for (const subproblem of state.decomposition_drift.affected_subproblems || []) {
      lines.push(`- Affected subproblem: ${subproblem}`);
    }
  }
  if (state.candidate_generation) {
    lines.push('', '## Candidate Generation', '');
    lines.push(`- Backend: ${state.candidate_generation.backend || ''}`);
    lines.push(`- Generated candidates: ${state.candidate_generation.generated_count ?? 0}`);
    for (const warning of state.candidate_generation.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.candidate_edge_generation) {
    lines.push('', '## Candidate Edge Proposal', '');
    lines.push(`- Backend: ${state.candidate_edge_generation.backend || ''}`);
    lines.push(`- Generated edges: ${state.candidate_edge_generation.generated_count ?? 0}`);
    for (const warning of state.candidate_edge_generation.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.judge_batch) {
    lines.push('', '## Judge Batch', '');
    lines.push(`- Backend: ${state.judge_batch.backend || ''}`);
    lines.push(`- Decisions: ${state.judge_batch.generated_count ?? 0}`);
    lines.push(`- Node decisions: ${state.judge_batch.node_decision_count ?? 0}`);
    lines.push(`- Edge decisions: ${state.judge_batch.edge_decision_count ?? 0}`);
    lines.push(`- Consistency probe decisions: ${state.judge_batch.consistency_probe_decision_count ?? 0}`);
    if (state.judge_batch.self_consistency) {
      const consistency = typeof state.judge_batch.self_consistency === 'string'
        ? state.judge_batch.self_consistency
        : `${state.judge_batch.self_consistency.status || 'measured'} (${state.judge_batch.self_consistency.consistency_score ?? ''})`;
      lines.push(`- Self consistency: ${consistency}`);
    }
    for (const warning of state.judge_batch.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.selection_batch) {
    lines.push('', '## Batch Selection', '');
    lines.push(`- Backend: ${state.selection_batch.backend || ''}`);
    lines.push(`- Selected candidates: ${state.selection_batch.selected_count ?? 0}`);
    lines.push(`- Selected subgraphs: ${state.selection_batch.subgraph_count ?? 0}`);
    lines.push(`- Parked candidates: ${state.selection_batch.parked_count ?? 0}`);
    lines.push(`- Rejected candidates: ${state.selection_batch.rejected_count ?? 0}`);
    if (state.selection_batch.posterior_backend) {
      lines.push(`- Posterior backend: ${state.selection_batch.posterior_backend}`);
      lines.push(`- Posterior candidates: ${state.selection_batch.posterior_candidate_count ?? 0}`);
    }
    for (const warning of state.selection_batch.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.posterior?.backend) {
    lines.push('', '## Dueling Posterior', '');
    lines.push(`- Backend: ${state.posterior.backend}`);
    lines.push(`- Candidate values: ${Object.keys(state.posterior.candidate_values || {}).length}`);
    lines.push(`- Pairwise decisions: ${state.posterior.total_pairwise_decisions ?? 0}`);
    for (const candidate of state.posterior.top_candidates || []) {
      lines.push(`- ${candidate.candidate_id}: mean=${candidate.posterior_mean ?? ''}, uncertainty=${candidate.uncertainty ?? ''}, index=${candidate.selection_index ?? ''}`);
    }
  }
  if (state.method_card_pack) {
    lines.push('', '## Evidence Expansion', '');
    lines.push(`- Backend: ${state.method_card_pack.backend || ''}`);
    lines.push(`- Method cards: ${state.method_card_pack.method_card_count ?? 0}`);
    lines.push(`- Missing evidence items: ${state.method_card_pack.missing_evidence_count ?? 0}`);
    lines.push(`- Provider evidence enabled: ${state.method_card_pack.provider_evidence_enabled ? 'yes' : 'no'}`);
    lines.push(`- Literature discovery enabled: ${state.method_card_pack.literature_discovery_enabled ? 'yes' : 'no'}`);
    lines.push(`- Import submission enabled: ${state.method_card_pack.import_submission_enabled ? 'yes' : 'no'}`);
    for (const warning of state.method_card_pack.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.solution_composition) {
    lines.push('', '## Solution Composition', '');
    lines.push(`- Backend: ${state.solution_composition.backend || ''}`);
    lines.push(`- Solution sketches: ${state.solution_composition.solution_count ?? 0}`);
    for (const warning of state.solution_composition.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.design_review) {
    lines.push('', '## Design Review', '');
    lines.push(`- Backend: ${state.design_review.backend || ''}`);
    lines.push(`- Reviews: ${state.design_review.review_count ?? 0}`);
    lines.push(`- Recommend: ${state.design_review.recommend_count ?? 0}`);
    lines.push(`- Revise: ${state.design_review.revise_count ?? 0}`);
    lines.push(`- Reject: ${state.design_review.reject_count ?? 0}`);
    for (const warning of state.design_review.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  if (state.gcd_mvp_validation) {
    lines.push('', '## GCD MVP Validation', '');
    lines.push(`- Status: ${state.gcd_mvp_validation.overall_status || ''}`);
    lines.push(`- Local artifacts: ${state.gcd_mvp_validation.local_artifact_status || ''}`);
    lines.push(`- Remote validation: ${state.gcd_mvp_validation.remote_validation_status || ''}`);
    lines.push(`- Passed criteria: ${state.gcd_mvp_validation.passed_criteria_count ?? 0}`);
    lines.push(`- Failed criteria: ${state.gcd_mvp_validation.failed_criteria_count ?? 0}`);
    lines.push(`- Blocked criteria: ${state.gcd_mvp_validation.blocked_criteria_count ?? 0}`);
    for (const warning of state.gcd_mvp_validation.warnings || []) {
      lines.push(`- Warning: ${warning}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildRoundReport(state = {}, taskSpecVariants = {}, subproblemGraph = {}, decompositionReview = {}) {
  return {
    record_type: 'round_report',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project,
    round_id: `round:${state.current_round ?? 0}`,
    status: 'initialized',
    mvp_contract: state.mvp_contract || null,
    task_spec_summary: {
      selected_task_spec_id: taskSpecVariants.selected_task_spec_id || null,
      variants: (taskSpecVariants.variants || []).map((variant) => ({
        task_spec_id: variant.task_spec_id,
        variant_key: variant.variant_key,
        status: variant.status,
        task_goal: variant.task_goal
      }))
    },
    subproblem_summary: (subproblemGraph.subproblems || []).map((subproblem) => ({
      subproblem_id: subproblem.subproblem_id,
      name: subproblem.name,
      metrics: subproblem.metrics || []
    })),
    kept: [],
    pruned: [],
    selected: [],
    needs_evidence: [],
    candidate_generation: state.candidate_generation || null,
    search_trace_summary: state.search_trace_summary || null,
    candidate_edge_generation: state.candidate_edge_generation || null,
    decomposition_generation: state.decomposition_generation || null,
    decomposition_review: state.decomposition_review || null,
    post_evidence_decomposition_drift: state.decomposition_drift || decompositionReview.post_evidence_drift_review || null,
    judge_batch: state.judge_batch || null,
    selection_batch: state.selection_batch || null,
    selection_trace_summary: state.selection_trace_summary || null,
    bandit_state_summary: state.bandit_state_summary || null,
    posterior: state.posterior || null,
    evidence_expansion: state.method_card_pack || null,
    solution_composition: state.solution_composition || null,
    design_review: state.design_review || null,
    gcd_mvp_validation: state.gcd_mvp_validation || null,
    warnings: [
      state.design_review
        ? 'Solution sketches and structured design reviews are available; none are final research directions without user approval.'
        : state.solution_composition
        ? 'Solution sketches are available; design review is still needed before user-facing recommendation.'
        : state.method_card_pack
        ? 'Selected-candidate evidence expansion produced a graph/material method-card pack; solution composition and design review remain pending.'
        : state.selection_batch
        ? 'Graph-only candidates, heuristic edges, judge evidence, and selected subgraphs are available; evidence expansion and solution composition are pending later phases.'
        : state.judge_batch
        ? 'Graph-only candidates, heuristic edges, and judge evidence are available; selection and solution composition are pending later phases.'
        : state.candidate_edge_generation
        ? 'Graph-only candidate generation and heuristic edge proposal completed; judging, selection, and solution composition are pending later phases.'
        : state.candidate_generation
          ? 'Graph-only candidate generation completed; judging, selection, and solution composition are pending later phases.'
          : state.decomposition_review
          ? 'Task decomposition has a structured review; candidate generation and judging are pending later phases.'
          : state.decomposition_generation
            ? 'Task spec variants and subproblem graph were generated; decomposition review and candidate generation are pending.'
          : 'Foundation slice initialized controller overlay only; candidate generation, judging, and solution composition are pending later phases.'
    ],
    next_actions: state.next_actions || [],
    generatedAt: nowIso()
  };
}

function scoreEvidenceTier(score = 0) {
  const value = Number(score || 0);
  if (value >= 7) return 'strong';
  if (value >= 3) return 'moderate';
  if (value > 0) return 'weak';
  return 'none';
}

function sourcePathForPaper(manifest = {}, paperId = '', title = '') {
  const normalizedTitle = compactText(title).toLowerCase();
  const entry = (manifest.sources || []).find((source) => {
    if (paperId && compactText(source.paperId || source.paper_id) === paperId) return true;
    return normalizedTitle && compactText(source.paperTitle || source.paper_title || source.title).toLowerCase() === normalizedTitle;
  });
  return entry ? {
    source_key: entry.sourceKey || entry.source_key || null,
    source_path: entry.sourcePath || entry.source_path || entry.inputPath || entry.input_path || null,
    source_provider: entry.sourceProvider || entry.source_provider || null
  } : null;
}

function methodSummaryFromMatches(matches = [], fallback = '') {
  const snippets = matches
    .map((match) => compactText(match.excerpt || match.nodeName || match.nodeId))
    .filter(Boolean);
  return truncate(snippets.join(' '), 420) || fallback;
}

function mechanismFromMatches(matches = [], subproblem = {}) {
  const methodLike = matches.find((match) => /method|mechanism|claim|finding|challenge/i.test(match.nodeType || ''));
  return compactText(methodLike?.nodeName || matches[0]?.nodeName || subproblem.name || 'unknown mechanism');
}

function candidateIdForSearchGroup(group = {}, subproblem = {}, state = {}, mechanism = '') {
  return `cand:${stableHash([
    state.project || '',
    state.task_id || '',
    subproblem.subproblem_id || subproblem.name || '',
    group.id || group.title || '',
    mechanism
  ].join(':'), 20)}`;
}

function candidateFromSearchGroup(group = {}, query = '', subproblem = {}, state = {}, manifest = {}) {
  const mechanism = mechanismFromMatches(group.matches || [], subproblem);
  const candidateId = candidateIdForSearchGroup(group, subproblem, state, mechanism);
  const searchStateId = `search-state:${stableHash(`${candidateId}:${query}`, 18)}`;
  const source = sourcePathForPaper(manifest, group.id, group.title);
  const score = Number(group.score || 0);
  return {
    record_type: 'candidate_node',
    candidate_id: candidateId,
    search_state_id: searchStateId,
    project: state.project || null,
    task_id: state.task_id || null,
    round_id: `round:${state.current_round ?? 0}`,
    subproblem: {
      subproblem_id: subproblem.subproblem_id || null,
      name: subproblem.name || null
    },
    abstract_challenge: subproblem.abstract_challenge || null,
    source_domain: state.target_domain || null,
    source_layer: 'target_domain',
    mechanism,
    method_summary: methodSummaryFromMatches(group.matches || [], `Graph match for ${subproblem.name || 'subproblem'} from ${group.title || group.id}.`),
    method_card: {
      input_signal: null,
      output_signal: null,
      training_objective: null,
      inference_behavior: null,
      assumptions: [
        'Method-card fields are graph-search scaffolds and require later extraction from paper materials.'
      ],
      failure_modes: subproblem.failure_modes || [],
      adaptable_components: [],
      non_transferable_components: []
    },
    adaptation_plan: {
      transfer_reason: `Matched query "${query}" for subproblem "${subproblem.name || ''}".`,
      required_changes: [],
      risks: ['Needs paper-material extraction before execution-ready use.'],
      unsupported_hypotheses: []
    },
    evaluation_plan: {
      dataset: null,
      metrics: subproblem.metrics || [],
      baseline: null,
      ablations: [],
      expected_observable: null
    },
    evidence: {
      search_state_id: searchStateId,
      graph_refs: (group.matches || []).map((match) => ({
        node_id: match.nodeId,
        node_type: match.nodeType,
        node_name: match.nodeName,
        excerpt: match.excerpt || null
      })),
      source_spans: [],
      paper_ids: [group.id].filter(Boolean),
      source,
      evidence_tier: scoreEvidenceTier(score)
    },
    labels: {
      evidence_supported: ['paper_id', 'title', 'graph_refs', 'query_match'],
      agent_inferred: ['mechanism', 'method_summary', 'adaptation_plan'],
      speculative: ['method_card_details', 'evaluation_plan_details']
    },
    scores: {
      graph_evidence_strength: Number(Math.min(1, score / 10).toFixed(3)),
      mechanism_fit: Number(Math.min(1, score / 8).toFixed(3)),
      novelty_potential: 0,
      uncertainty: 0.6,
      feasibility: 0.4,
      cost: 0.5,
      risk: 0.5,
      controller_utility: Number(Math.min(1, score / 10).toFixed(3))
    },
    source_papers: [{
      paper_id: group.id || null,
      title: group.title || null,
      query,
      score,
      status: 'in_graph'
    }],
    bridge_path_refs: (group.matches || []).slice(0, 5).map((match) => ({
      node_id: match.nodeId,
      node_type: match.nodeType,
      node_name: match.nodeName
    })),
    source_span_refs: [],
    status: 'proposed',
    generated_by: 'research_controller.generate_candidates.graph_search',
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

function challengeAspectKey(candidate = {}, subproblem = {}) {
  return normalizeComparable(
    candidate.abstract_challenge
    || candidate.subproblem?.abstract_challenge
    || subproblem.abstract_challenge
    || candidate.subproblem?.name
    || subproblem.name
    || ''
  );
}

function evidenceClusterKey(candidate = {}) {
  const paperIds = candidatePaperIds(candidate);
  if (paperIds.length) return `paper:${paperIds[0]}`;
  const graphRef = (candidate.evidence?.graph_refs || [])[0];
  if (graphRef?.node_type) return `node-type:${normalizeComparable(graphRef.node_type)}`;
  const sourceDomain = normalizeComparable(candidate.source_domain || candidate.evidence?.source_domain || '');
  return sourceDomain ? `source:${sourceDomain}` : '';
}

function candidateEvidenceSpanRefs(candidate = {}) {
  return (candidate.evidence?.graph_refs || []).slice(0, 8).map((ref) => ({
    node_id: ref.node_id,
    node_type: ref.node_type,
    node_name: ref.node_name,
    excerpt: ref.excerpt || null
  }));
}

function ideaSearchScoreTrace(candidate = {}, subproblem = {}) {
  const grounding = normalizeScore(candidate.scores?.graph_evidence_strength, 0);
  const challengeAlignment = normalizeScore(candidate.scores?.mechanism_fit, 0.35);
  const bridgeCompleteness = candidateHasBridgeEvidence(candidate) || candidate.source_layer === 'target_domain'
    ? 0.65
    : 0.25;
  const noveltyProxy = normalizeScore(candidate.scores?.novelty_potential, 0.25);
  const feasibility = normalizeScore(candidate.scores?.feasibility, 0.35);
  const diversityGain = challengeAspectKey(candidate, subproblem) ? 0.35 : 0.15;
  const riskPenalty = normalizeScore(candidate.scores?.risk, 0.5);
  const unsupportedClaimPenalty = candidate.evidence?.evidence_tier === 'none' ? 0.35 : 0.1;
  const total = Math.max(0, Math.min(1,
    (0.25 * grounding)
    + (0.2 * challengeAlignment)
    + (0.15 * bridgeCompleteness)
    + (0.15 * noveltyProxy)
    + (0.1 * feasibility)
    + (0.1 * diversityGain)
    - (0.05 * riskPenalty)
    - (0.05 * unsupportedClaimPenalty)
  ));
  return {
    grounding: Number(grounding.toFixed(3)),
    challenge_alignment: Number(challengeAlignment.toFixed(3)),
    bridge_completeness: Number(bridgeCompleteness.toFixed(3)),
    novelty_proxy: Number(noveltyProxy.toFixed(3)),
    feasibility: Number(feasibility.toFixed(3)),
    diversity_gain: Number(diversityGain.toFixed(3)),
    risk_penalty: Number(riskPenalty.toFixed(3)),
    unsupported_claim_penalty: Number(unsupportedClaimPenalty.toFixed(3)),
    total: Number(total.toFixed(3))
  };
}

function ideaSearchStateFromCandidate(candidate = {}, query = '', subproblem = {}, state = {}) {
  const evidenceTier = candidate.evidence?.evidence_tier || 'none';
  const finalized = ['moderate', 'strong'].includes(evidenceTier);
  const unresolved = [];
  if (!candidate.mechanism || candidate.mechanism === 'unknown mechanism') unresolved.push('missing_mechanism');
  if (!candidate.evaluation_plan?.baseline) unresolved.push('missing_baseline');
  if (!candidate.evaluation_plan?.metrics?.length) unresolved.push('missing_metric');
  if (!finalized) unresolved.push('weak_evidence_requires_material_expansion');
  return {
    record_type: 'idea_search_state',
    search_state_id: candidate.search_state_id,
    round_id: candidate.round_id,
    project: state.project || null,
    target_challenge: subproblem.abstract_challenge || subproblem.name || null,
    target_domain: state.target_domain || null,
    source_domain_path: unique([state.target_domain, candidate.source_domain].map(compactText).filter(Boolean)),
    mechanism_path: candidateMechanismTokens(candidate),
    bridge_path_refs: candidate.bridge_path_refs || [],
    evidence_span_refs: candidateEvidenceSpanRefs(candidate),
    partial_idea: candidate.method_summary || null,
    candidate_id: candidate.candidate_id,
    query,
    source_papers: candidate.source_papers || [],
    unresolved_requirements: unresolved,
    score_trace: ideaSearchScoreTrace(candidate, subproblem),
    status: finalized ? 'finalized' : 'requisitioned',
    limitations: [
      'Graph-search state is an auditable generation trace, not a novelty or feasibility proof.',
      'Weak or missing evidence states require selected-candidate material expansion before execution-ready use.'
    ],
    created_at: nowIso()
  };
}

function collectCandidatesForSubproblem(graph, subproblem = {}, state = {}, manifest = {}, perSubproblemLimit = 4) {
  if (!graph || typeof graph !== 'object') return [];
  const queries = unique([
    ...(subproblem.query_plan || []),
    `${state.target_problem || ''} ${subproblem.name || ''}`,
    `${state.target_domain || ''} ${subproblem.name || ''}`
  ].map(compactText).filter(Boolean));
  const candidates = [];
  const seenPapers = new Set();
  for (const query of queries) {
    if (candidates.length >= perSubproblemLimit) break;
    const result = searchGraph(graph, query, { limit: Math.max(perSubproblemLimit, 8) });
    for (const group of result.groups || []) {
      if (candidates.length >= perSubproblemLimit) break;
      if (group.scope !== 'paper') continue;
      if (seenPapers.has(group.id)) continue;
      seenPapers.add(group.id);
      candidates.push(candidateFromSearchGroup(group, query, subproblem, state, manifest));
    }
  }
  return candidates;
}

function collectCandidateSearchForSubproblem(graph, subproblem = {}, state = {}, manifest = {}, perSubproblemLimit = 4) {
  const queries = unique([
    ...(subproblem.query_plan || []),
    `${state.target_problem || ''} ${subproblem.name || ''}`,
    `${state.target_domain || ''} ${subproblem.name || ''}`
  ].map(compactText).filter(Boolean));
  const counters = {
    query_count: queries.length,
    expanded_groups: 0,
    paper_groups: 0,
    non_paper_groups: 0,
    duplicate_papers: 0,
    beam_pruned: 0,
    finalized: 0,
    requisitioned: 0
  };
  const candidates = [];
  const searchStates = [];
  const seenPapers = new Set();
  const pruneReasons = {};
  const addPrune = (reason) => {
    pruneReasons[reason] = (pruneReasons[reason] || 0) + 1;
  };

  if (!graph || typeof graph !== 'object') {
    addPrune('no_committed_graph_available');
  } else {
    for (const query of queries) {
      const result = searchGraph(graph, query, { limit: Math.max(perSubproblemLimit * 2, 8) });
      for (const group of result.groups || []) {
        counters.expanded_groups += 1;
        if (group.scope !== 'paper') {
          counters.non_paper_groups += 1;
          addPrune('non_paper_scope');
          continue;
        }
        counters.paper_groups += 1;
        if (seenPapers.has(group.id)) {
          counters.duplicate_papers += 1;
          addPrune('duplicate_paper');
          continue;
        }
        if (candidates.length >= perSubproblemLimit) {
          counters.beam_pruned += 1;
          addPrune('beam_width_limit');
          continue;
        }
        seenPapers.add(group.id);
        const candidate = candidateFromSearchGroup(group, query, subproblem, state, manifest);
        const searchState = ideaSearchStateFromCandidate(candidate, query, subproblem, state);
        if (searchState.status === 'finalized') counters.finalized += 1;
        if (searchState.status === 'requisitioned') counters.requisitioned += 1;
        candidates.push(candidate);
        searchStates.push(searchState);
      }
    }
  }

  const finalizedStateIds = searchStates
    .filter((entry) => entry.status === 'finalized')
    .map((entry) => entry.search_state_id);
  const requisitionStateIds = searchStates
    .filter((entry) => entry.status === 'requisitioned')
    .map((entry) => entry.search_state_id);
  return {
    candidates,
    search_states: searchStates,
    subproblem_trace: {
      subproblem_id: subproblem.subproblem_id || null,
      subproblem_name: subproblem.name || null,
      query_count: counters.query_count,
      candidate_count: candidates.length,
      finalized_state_ids: finalizedStateIds,
      requisition_state_ids: requisitionStateIds,
      prune_reasons: pruneReasons,
      depths: [
        {
          depth: 'source_domain',
          expanded_count: counters.query_count,
          kept_count: counters.query_count,
          pruned_count: 0,
          prune_reasons: {}
        },
        {
          depth: 'mechanism',
          expanded_count: counters.expanded_groups,
          kept_count: counters.paper_groups,
          pruned_count: counters.non_paper_groups,
          prune_reasons: counters.non_paper_groups ? { non_paper_scope: counters.non_paper_groups } : {}
        },
        {
          depth: 'bridge',
          expanded_count: counters.paper_groups,
          kept_count: candidates.length,
          pruned_count: counters.duplicate_papers + counters.beam_pruned,
          prune_reasons: {
            ...(counters.duplicate_papers ? { duplicate_paper: counters.duplicate_papers } : {}),
            ...(counters.beam_pruned ? { beam_width_limit: counters.beam_pruned } : {})
          }
        },
        {
          depth: 'evidence',
          expanded_count: candidates.length,
          kept_count: counters.finalized,
          pruned_count: 0,
          requisitioned_count: counters.requisitioned,
          prune_reasons: {}
        },
        {
          depth: 'idea',
          expanded_count: candidates.length,
          kept_count: candidates.length,
          pruned_count: 0,
          finalized_count: counters.finalized,
          requisitioned_count: counters.requisitioned,
          prune_reasons: {}
        }
      ]
    }
  };
}

function mergeIdeaSearchTraces(subproblemRuns = [], state = {}, args = {}) {
  const depths = new Map();
  const addDepth = (depthEntry = {}) => {
    const key = depthEntry.depth || 'unknown';
    const current = depths.get(key) || {
      depth: key,
      expanded_count: 0,
      kept_count: 0,
      pruned_count: 0,
      requisitioned_count: 0,
      finalized_count: 0,
      prune_reasons: {}
    };
    current.expanded_count += depthEntry.expanded_count || 0;
    current.kept_count += depthEntry.kept_count || 0;
    current.pruned_count += depthEntry.pruned_count || 0;
    current.requisitioned_count += depthEntry.requisitioned_count || 0;
    current.finalized_count += depthEntry.finalized_count || 0;
    for (const [reason, count] of Object.entries(depthEntry.prune_reasons || {})) {
      current.prune_reasons[reason] = (current.prune_reasons[reason] || 0) + count;
    }
    depths.set(key, current);
  };
  for (const run of subproblemRuns) {
    for (const depth of run.subproblem_trace?.depths || []) addDepth(depth);
  }
  const searchStates = subproblemRuns.flatMap((run) => run.search_states || []);
  return {
    record_type: 'search_trace',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    trace_id: `search-trace:${stableHash(`${state.project || ''}:${state.task_id || ''}:${state.current_round ?? 0}:${searchStates.length}`, 16)}`,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    policy: 'beam_graph_search_mvp',
    beam_width: boundedInteger(args.beamWidth ?? args.beam_width ?? args.candidatesPerSubproblem ?? args.candidates_per_subproblem, 0, { min: 0, max: 100 }) || null,
    depths: [...depths.values()],
    subproblem_traces: subproblemRuns.map((run) => run.subproblem_trace),
    search_states: searchStates,
    finalized_state_ids: searchStates
      .filter((entry) => entry.status === 'finalized')
      .map((entry) => entry.search_state_id),
    requisition_state_ids: searchStates
      .filter((entry) => entry.status === 'requisitioned')
      .map((entry) => entry.search_state_id),
    candidate_count: subproblemRuns.reduce((sum, run) => sum + (run.candidates?.length || 0), 0),
    distinct_challenge_aspect_count: new Set(searchStates.map((entry) => normalizeComparable(entry.target_challenge || '')).filter(Boolean)).size,
    distinct_mechanism_count: new Set(searchStates.flatMap((entry) => entry.mechanism_path || [])).size,
    requisition_rate: searchStates.length
      ? Number((searchStates.filter((entry) => entry.status === 'requisitioned').length / searchStates.length).toFixed(3))
      : 0,
    limitations: [
      'MVP beam graph search is bounded over graph-search paper groups and search traces; it is not MCTS and does not call providers.',
      'Search states preserve provenance and pruning reasons so external Agents can audit candidate generation without mutating lifecycle state.'
    ],
    generatedAt: nowIso()
  };
}

function candidateGenerationLimits(args = {}, state = {}, subproblemCount = 1) {
  const maxCandidates = boundedInteger(
    args.maxCandidateNodes ?? args.max_candidate_nodes ?? state.budget?.max_candidate_nodes,
    state.budget?.max_candidate_nodes || 60,
    { min: 1, max: 500 }
  );
  const explicitPerSubproblem = args.candidatesPerSubproblem ?? args.candidates_per_subproblem;
  const perSubproblem = boundedInteger(
    explicitPerSubproblem,
    Math.max(1, Math.ceil(maxCandidates / Math.max(1, subproblemCount))),
    { min: 1, max: 50 }
  );
  return { maxCandidates, perSubproblem };
}

function edgeProposalLimit(args = {}, state = {}) {
  return boundedInteger(
    args.maxEdgeJudgments ?? args.max_edge_judgments ?? state.budget?.max_edge_judgments,
    state.budget?.max_edge_judgments || 40,
    { min: 1, max: 500 }
  );
}

function normalizeComparable(value = '') {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeComparableList(values = []) {
  return unique(asArray(values).map(normalizeComparable).filter(Boolean));
}

const TOKEN_STOPWORDS = new Set([
  'method',
  'model',
  'paper',
  'graph',
  'match',
  'task',
  'domain',
  'using',
  'under',
  'with',
  'from',
  'that',
  'this',
  'classes',
  'class'
]);

function comparableTokens(value = '', limit = 12) {
  return normalizeComparable(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token))
    .slice(0, limit);
}

function intersection(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

function flattenStrings(value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => flattenStrings(entry, depth + 1));
  if (typeof value === 'object') return Object.values(value).flatMap((entry) => flattenStrings(entry, depth + 1));
  return [];
}

function candidateSubproblemKey(candidate = {}) {
  return compactText(candidate.subproblem?.subproblem_id || candidate.subproblem?.name);
}

function candidateFailureModes(candidate = {}) {
  return normalizeComparableList(candidate.method_card?.failure_modes || []);
}

function candidateMetrics(candidate = {}) {
  return normalizeComparableList(candidate.evaluation_plan?.metrics || []);
}

function candidatePaperIds(candidate = {}) {
  return normalizeComparableList([
    ...(candidate.evidence?.paper_ids || []),
    ...(candidate.source_papers || []).map((paper) => paper.paper_id)
  ]);
}

function candidateMechanismTokens(candidate = {}) {
  return comparableTokens(`${candidate.mechanism || ''} ${candidate.method_summary || ''}`, 10);
}

const SIGNAL_TOKEN_ALLOWLIST = new Set([
  'assignment',
  'assignments',
  'calibrated',
  'calibration',
  'cluster',
  'clusters',
  'confidence',
  'count',
  'embedding',
  'embeddings',
  'estimate',
  'features',
  'label',
  'labels',
  'logit',
  'logits',
  'prior',
  'probability',
  'prototype',
  'pseudo',
  'representation',
  'score',
  'scores',
  'uncertainty'
]);

const COST_TOKEN_ALLOWLIST = new Set([
  'a100',
  'ablation',
  'backbone',
  'batch',
  'budget',
  'code',
  'compute',
  'dataset',
  'epoch',
  'epochs',
  'finetune',
  'gpu',
  'h100',
  'implementation',
  'memory',
  'optimizer',
  'pretrain',
  'runtime',
  'training',
  'v100'
]);

const CONFLICT_PHRASE_PAIRS = [
  [['requires known class count', 'fixed class count', 'known number of classes'], ['unknown class count', 'estimate class count', 'class number estimation']],
  [['uses unknown labels', 'requires unknown labels', 'needs unknown labels'], ['no unknown labels', 'without unknown labels', 'do not use unknown labels']],
  [['test labels', 'test-set tuning', 'evaluation-only labels'], ['no test labels', 'without test labels', 'no evaluation-only labels']],
  [['closed set', 'closed-set'], ['open set', 'open-set', 'open world', 'open-world']],
  [['high compute', 'large compute', 'expensive training'], ['low compute', 'cheap training', 'low-cost']]
];

function allowlistedTokens(value = '', allowlist = new Set(), limit = 24) {
  return unique(comparableTokens(value, 80).filter((token) => allowlist.has(token))).slice(0, limit);
}

function candidateInputTokens(candidate = {}) {
  return allowlistedTokens(flattenStrings([
    candidate.method_card?.input_signal,
    candidate.method_card?.assumptions,
    candidate.adaptation_plan?.required_changes
  ]).join(' '), SIGNAL_TOKEN_ALLOWLIST);
}

function candidateOutputTokens(candidate = {}) {
  return allowlistedTokens(flattenStrings([
    candidate.method_card?.output_signal,
    candidate.method_card?.inference_behavior,
    candidate.method_card?.training_objective
  ]).join(' '), SIGNAL_TOKEN_ALLOWLIST);
}

function candidateAssumptionText(candidate = {}) {
  return normalizeComparable(flattenStrings([
    candidate.method_card?.assumptions,
    candidate.method_card?.non_transferable_components,
    candidate.method_card?.training_objective,
    candidate.adaptation_plan?.risks,
    candidate.adaptation_plan?.unsupported_hypotheses,
    candidate.method_summary
  ]).join(' '));
}

function candidateCostTokens(candidate = {}) {
  return allowlistedTokens(flattenStrings([
    candidate.method_card,
    candidate.adaptation_plan,
    candidate.evaluation_plan,
    candidate.method_summary,
    candidate.source_papers
  ]).join(' '), COST_TOKEN_ALLOWLIST);
}

function detectPrerequisiteDirection(left = {}, right = {}) {
  const leftToRight = intersection(candidateOutputTokens(left), candidateInputTokens(right));
  const rightToLeft = intersection(candidateOutputTokens(right), candidateInputTokens(left));
  if (!leftToRight.length && !rightToLeft.length) return null;
  if (leftToRight.length >= rightToLeft.length) {
    return {
      source: left,
      target: right,
      shared_signals: leftToRight,
      direction: 'source_output_to_target_input'
    };
  }
  return {
    source: right,
    target: left,
    shared_signals: rightToLeft,
    direction: 'source_output_to_target_input'
  };
}

function matchingConflictPhrases(leftText = '', rightText = '') {
  const matches = [];
  for (const [leftPhrases, rightPhrases] of CONFLICT_PHRASE_PAIRS) {
    const leftMatch = leftPhrases.find((phrase) => leftText.includes(normalizeComparable(phrase)));
    const rightMatch = rightPhrases.find((phrase) => rightText.includes(normalizeComparable(phrase)));
    if (leftMatch && rightMatch) {
      matches.push(`${leftMatch} vs ${rightMatch}`);
      continue;
    }
    const reverseLeftMatch = rightPhrases.find((phrase) => leftText.includes(normalizeComparable(phrase)));
    const reverseRightMatch = leftPhrases.find((phrase) => rightText.includes(normalizeComparable(phrase)));
    if (reverseLeftMatch && reverseRightMatch) matches.push(`${reverseLeftMatch} vs ${reverseRightMatch}`);
  }
  return unique(matches);
}

function relationTypeOrder(types = []) {
  const priority = [
    'CONFLICTS_WITH',
    'PREREQUISITE',
    'COST_COUPLED',
    'COMPLEMENTS',
    'SUBSTITUTES',
    'SHARES_MECHANISM',
    'SHARES_FAILURE_MODE',
    'NOVELTY_COLLISION',
    'EVALUATION_COMPATIBLE'
  ];
  const uniqueTypes = unique(types);
  return [
    ...priority.filter((type) => uniqueTypes.includes(type)),
    ...uniqueTypes.filter((type) => !priority.includes(type)).sort()
  ];
}

function candidateBlockKeys(candidate = {}) {
  const keys = [];
  const subproblemKey = candidateSubproblemKey(candidate);
  if (subproblemKey) keys.push(`subproblem:${subproblemKey}`);
  for (const paperId of candidatePaperIds(candidate)) keys.push(`paper:${paperId}`);
  for (const token of comparableTokens(candidate.mechanism || '', 6)) keys.push(`mechanism:${token}`);
  for (const failureMode of candidateFailureModes(candidate)) keys.push(`failure:${failureMode}`);
  for (const metric of candidateMetrics(candidate)) keys.push(`metric:${metric}`);
  for (const token of unique([...candidateInputTokens(candidate), ...candidateOutputTokens(candidate)])) keys.push(`signal:${token}`);
  for (const token of candidateCostTokens(candidate)) keys.push(`cost:${token}`);
  return unique(keys);
}

function orderedCandidatePair(left = {}, right = {}) {
  const pair = [left, right].sort((a, b) => String(a.candidate_id || '').localeCompare(String(b.candidate_id || '')));
  return {
    source: pair[0],
    target: pair[1],
    pairKey: `${pair[0].candidate_id || ''}::${pair[1].candidate_id || ''}`
  };
}

function collectBlockedCandidatePairs(candidates = [], maxEdges = 40) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate?.candidate_id) continue;
    for (const key of candidateBlockKeys(candidate)) {
      const group = groups.get(key) || [];
      group.push(candidate);
      groups.set(key, group);
    }
  }

  const pairs = new Map();
  const maxPairs = Math.max(maxEdges * 4, maxEdges);
  const maxPairsPerBlock = Math.max(4, Math.min(24, maxEdges));
  for (const [blockKey, group] of groups.entries()) {
    const sorted = unique(group).sort((a, b) => String(a.candidate_id).localeCompare(String(b.candidate_id)));
    let blockPairCount = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const pair = orderedCandidatePair(sorted[i], sorted[j]);
        const existing = pairs.get(pair.pairKey) || {
          source: pair.source,
          target: pair.target,
          block_keys: []
        };
        existing.block_keys.push(blockKey);
        pairs.set(pair.pairKey, existing);
        blockPairCount += 1;
        if (pairs.size >= maxPairs || blockPairCount >= maxPairsPerBlock) break;
      }
      if (pairs.size >= maxPairs || blockPairCount >= maxPairsPerBlock) break;
    }
    if (pairs.size >= maxPairs) break;
  }
  return [...pairs.values()];
}

function candidateEdgeFromPair(pair = {}, state = {}) {
  const originalLeft = pair.source || {};
  const originalRight = pair.target || {};
  if (!originalLeft.candidate_id || !originalRight.candidate_id || originalLeft.candidate_id === originalRight.candidate_id) return null;
  const prerequisite = detectPrerequisiteDirection(originalLeft, originalRight);
  const left = prerequisite?.source || originalLeft;
  const right = prerequisite?.target || originalRight;

  const sameSubproblem = candidateSubproblemKey(left) && candidateSubproblemKey(left) === candidateSubproblemKey(right);
  const sharedFailures = intersection(candidateFailureModes(left), candidateFailureModes(right));
  const sharedMetrics = intersection(candidateMetrics(left), candidateMetrics(right));
  const sharedPapers = intersection(candidatePaperIds(left), candidatePaperIds(right));
  const sharedCostTerms = intersection(candidateCostTokens(left), candidateCostTokens(right));
  const conflictPhrases = matchingConflictPhrases(candidateAssumptionText(left), candidateAssumptionText(right));
  const leftMechanism = normalizeComparable(left.mechanism || '');
  const rightMechanism = normalizeComparable(right.mechanism || '');
  const sameMechanism = leftMechanism && leftMechanism === rightMechanism;
  const sharedMechanismTerms = intersection(candidateMechanismTokens(left), candidateMechanismTokens(right));

  const relationTypes = [];
  if (conflictPhrases.length) relationTypes.push('CONFLICTS_WITH');
  if (prerequisite?.shared_signals?.length) relationTypes.push('PREREQUISITE');
  if (sharedCostTerms.length) relationTypes.push('COST_COUPLED');
  if (sameSubproblem) relationTypes.push('SUBSTITUTES');
  if (!sameSubproblem && (sameMechanism || sharedMechanismTerms.length || sharedPapers.length || sharedFailures.length || sharedMetrics.length)) {
    relationTypes.push('COMPLEMENTS');
  }
  if (sameMechanism || sharedMechanismTerms.length || sharedPapers.length) relationTypes.push('SHARES_MECHANISM');
  if (sameSubproblem && (sameMechanism || sharedPapers.length || sharedMechanismTerms.length >= 2)) relationTypes.push('NOVELTY_COLLISION');
  if (sharedFailures.length) relationTypes.push('SHARES_FAILURE_MODE');
  if (sharedMetrics.length) relationTypes.push('EVALUATION_COMPATIBLE');
  const uniqueRelations = relationTypeOrder(relationTypes);
  if (!uniqueRelations.length) return null;

  const confidence = Math.min(
    0.95,
    0.35
      + (conflictPhrases.length ? 0.14 : 0)
      + (prerequisite?.shared_signals?.length ? 0.14 : 0)
      + (sharedCostTerms.length ? 0.08 : 0)
      + (sameSubproblem ? 0.12 : 0)
      + (sameMechanism ? 0.18 : 0)
      + (sharedPapers.length ? 0.12 : 0)
      + (sharedMechanismTerms.length ? 0.1 : 0)
      + (sharedFailures.length ? 0.08 : 0)
      + (sharedMetrics.length ? 0.08 : 0)
  );

  return {
    record_type: 'candidate_edge',
    edge_id: `cedge:${stableHash(`${state.project || ''}:${state.task_id || ''}:${left.candidate_id}:${right.candidate_id}`, 20)}`,
    project: state.project || null,
    task_id: state.task_id || null,
    round_id: `round:${state.current_round ?? 0}`,
    source_candidate_id: left.candidate_id,
    target_candidate_id: right.candidate_id,
    relation_types: uniqueRelations,
    primary_relation: uniqueRelations[0],
    confidence: Number(confidence.toFixed(3)),
    rationale: truncate([
      sameSubproblem ? 'same subproblem' : 'different subproblems',
      sameMechanism ? 'same normalized mechanism' : '',
      prerequisite?.shared_signals?.length ? `prerequisite signal overlap: ${prerequisite.shared_signals.slice(0, 4).join(', ')}` : '',
      conflictPhrases.length ? `conflicting assumptions/objectives: ${conflictPhrases.slice(0, 3).join(', ')}` : '',
      sharedCostTerms.length ? `shared cost terms: ${sharedCostTerms.slice(0, 4).join(', ')}` : '',
      sharedMechanismTerms.length ? `shared mechanism terms: ${sharedMechanismTerms.slice(0, 4).join(', ')}` : '',
      sharedFailures.length ? `shared failure modes: ${sharedFailures.slice(0, 3).join(', ')}` : '',
      sharedMetrics.length ? `shared metrics: ${sharedMetrics.slice(0, 3).join(', ')}` : '',
      sharedPapers.length ? `shared source papers: ${sharedPapers.slice(0, 3).join(', ')}` : ''
    ].filter(Boolean).join('; '), 500),
    evidence: {
      source_subproblem: left.subproblem || null,
      target_subproblem: right.subproblem || null,
      shared_mechanism_terms: sharedMechanismTerms,
      shared_failure_modes: sharedFailures,
      shared_metrics: sharedMetrics,
      shared_paper_ids: sharedPapers,
      prerequisite_signals: prerequisite?.shared_signals || [],
      conflict_phrases: conflictPhrases,
      shared_cost_terms: sharedCostTerms,
      block_keys: unique(pair.block_keys || [])
    },
    labels: {
      evidence_supported: ['candidate_ids', 'shared_fields', 'blocking_keys'],
      agent_inferred: ['relation_types', 'confidence', 'rationale'],
      speculative: []
    },
    status: 'proposed',
    generated_by: 'research_controller.propose_edges.heuristic_blocking',
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

function proposeCandidateEdges(candidates = [], state = {}, maxEdges = 40) {
  const edges = [];
  const seen = new Set();
  for (const pair of collectBlockedCandidatePairs(candidates, maxEdges)) {
    if (edges.length >= maxEdges) break;
    const edge = candidateEdgeFromPair(pair, state);
    if (!edge || seen.has(edge.edge_id)) continue;
    seen.add(edge.edge_id);
    edges.push(edge);
  }
  return edges.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return left.edge_id.localeCompare(right.edge_id);
  });
}

function parseJsonText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Model response was empty.');
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error('Model response was not valid JSON.');
}

function normalizeScore(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeVerdict(value = '', fallback = 'needs_evidence') {
  const verdict = compactText(value).toLowerCase().replace(/[-\s]+/g, '_');
  return ['keep', 'needs_evidence', 'reject', 'revise'].includes(verdict) ? verdict : fallback;
}

function judgeBatchLimit(args = {}, state = {}) {
  return boundedInteger(
    args.maxJudgeItems ?? args.max_judge_items ?? args.maxAgentCalls ?? args.max_agent_calls ?? state.budget?.max_agent_calls,
    Math.min(12, state.budget?.max_agent_calls || 12),
    { min: 1, max: 100 }
  );
}

function judgeConsistencyProbeLimit(args = {}) {
  const judge = normalizeObject(args.judge);
  const explicit = args.judgeConsistencyChecks
    ?? args.judge_consistency_checks
    ?? judge.consistencyChecks
    ?? judge.consistency_checks;
  if (explicit === undefined || explicit === null || explicit === '') return 0;
  if (typeof explicit === 'boolean') return explicit ? 2 : 0;
  return boundedInteger(explicit, 0, { min: 0, max: 20 });
}

function compactCandidateForJudge(candidate = {}) {
  return {
    candidate_id: candidate.candidate_id,
    subproblem: candidate.subproblem || null,
    mechanism: candidate.mechanism || null,
    method_summary: candidate.method_summary || null,
    adaptation_plan: candidate.adaptation_plan || null,
    evaluation_plan: candidate.evaluation_plan || null,
    evidence_tier: candidate.evidence?.evidence_tier || 'none',
    scores: candidate.scores || {},
    labels: candidate.labels || {}
  };
}

function compactEdgeForJudge(edge = {}) {
  return {
    edge_id: edge.edge_id,
    source_candidate_id: edge.source_candidate_id,
    target_candidate_id: edge.target_candidate_id,
    relation_types: edge.relation_types || [],
    confidence: edge.confidence ?? null,
    rationale: edge.rationale || null,
    evidence: edge.evidence || null,
    labels: edge.labels || {}
  };
}

function candidatePairId(leftId = '', rightId = '') {
  const sorted = [leftId, rightId].map(compactText).filter(Boolean).sort();
  return `cpair:${stableHash(sorted.join(':'), 18)}`;
}

function compactCandidatePairForJudge(left = {}, right = {}, edges = []) {
  const leftId = left.candidate_id;
  const rightId = right.candidate_id;
  const relatedEdges = edges.filter((edge) => {
    const source = edge.source_candidate_id;
    const target = edge.target_candidate_id;
    return (source === leftId && target === rightId) || (source === rightId && target === leftId);
  });
  return {
    pair_id: candidatePairId(leftId, rightId),
    candidate_a_id: leftId,
    candidate_b_id: rightId,
    candidate_a: {
      subproblem: left.subproblem || null,
      mechanism: left.mechanism || null,
      method_summary: left.method_summary || null
    },
    candidate_b: {
      subproblem: right.subproblem || null,
      mechanism: right.mechanism || null,
      method_summary: right.method_summary || null
    },
    shared_edge_ids: relatedEdges.map((edge) => edge.edge_id),
    relation_hints: unique(relatedEdges.flatMap((edge) => edge.relation_types || []))
  };
}

function candidatePairsForJudge(candidates = [], edges = [], limit = 3) {
  if (candidates.length < 2 || limit <= 0) return [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const byPair = new Map();
  for (const edge of edges) {
    const left = candidateById.get(edge.source_candidate_id);
    const right = candidateById.get(edge.target_candidate_id);
    if (!left || !right) continue;
    const pair = compactCandidatePairForJudge(left, right, edges);
    byPair.set(pair.pair_id, pair);
    if (byPair.size >= limit) break;
  }
  for (let index = 0; index < candidates.length && byPair.size < limit; index += 1) {
    for (let offset = index + 1; offset < candidates.length && byPair.size < limit; offset += 1) {
      const pair = compactCandidatePairForJudge(candidates[index], candidates[offset], edges);
      byPair.set(pair.pair_id, pair);
    }
  }
  return [...byPair.values()];
}

function buildJudgeRequest(overlay = {}, state = {}, args = {}) {
  const limit = judgeBatchLimit(args, state);
  const nodeLimit = Math.max(1, Math.ceil(limit * 0.7));
  const edgeLimit = Math.max(1, limit - nodeLimit);
  const candidates = (overlay.candidateGraph?.nodes || [])
    .filter((candidate) => ['proposed', 'needs_evidence'].includes(candidate.status))
    .slice(0, nodeLimit)
    .map(compactCandidateForJudge);
  const edges = (overlay.candidateGraph?.edges || [])
    .filter((edge) => ['proposed', 'needs_evidence'].includes(edge.status))
    .slice(0, edgeLimit)
    .map(compactEdgeForJudge);
  const pairLimit = boundedInteger(args.maxPairwisePreferences ?? args.max_pairwise_preferences, Math.min(3, Math.max(1, Math.floor(limit / 3))), { min: 0, max: 20 });
  const candidatePairs = candidatePairsForJudge(candidates, edges, pairLimit);
  return {
    task: 'research_controller.judge_batch',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    task_id: state.task_id || null,
    round_id: `round:${state.current_round ?? 0}`,
    target_domain: state.target_domain || null,
    target_problem: state.target_problem || null,
    judge_method: {
      mode: 'single_model',
      instructions: [
        'Use only the supplied candidate and edge records.',
        'Judge evidence support, mechanism fit, feasibility, novelty risk, and evaluation readiness.',
        'Return evidence as judgments only; do not directly mutate candidate status.',
        'Prefer needs_evidence when a candidate is plausible but lacks method-card details or evaluation plan.'
      ],
      output_schema: {
        node_judgments: [{
          candidate_id: 'string',
          verdict: 'keep|needs_evidence|reject|revise',
          scores: {
            evidence_support: '0..1',
            mechanism_fit: '0..1',
            feasibility: '0..1',
            novelty_potential: '0..1',
            risk: '0..1',
            evaluation_readiness: '0..1'
          },
          rationale: 'short string',
          missing_evidence: ['string']
        }],
        edge_judgments: [{
          edge_id: 'string',
          verdict: 'keep|needs_evidence|reject|revise',
          valid_relation_types: ['string'],
          confidence: '0..1',
          rationale: 'short string'
        }],
        pairwise_preferences: [{
          pair_id: 'string',
          candidate_a_id: 'string',
          candidate_b_id: 'string',
          winner: 'A|B|tie|unsure',
          confidence: '0..1',
          decision_basis: {
            novelty: 'short string',
            feasibility: 'short string',
            evidence: 'short string',
            expected_gain: 'short string',
            risk: 'short string'
          },
          missing_evidence: ['string']
        }]
      }
    },
    task_spec: {
      selected_task_spec_id: state.selected_task_spec_id || null,
      design_boundaries: state.constraints?.design_boundaries || []
    },
    subproblems: overlay.subproblemGraph?.subproblems || [],
    candidates,
    edges,
    candidate_pairs: candidatePairs,
    provider_policy: state.provider_policy || normalizeProviderPolicy(args),
    judge: state.judge || normalizeJudge(args),
    budget: {
      ...(state.budget || {}),
      max_judge_items: limit,
      requested_candidate_count: candidates.length,
      requested_edge_count: edges.length,
      requested_pairwise_count: candidatePairs.length
    }
  };
}

function buildJudgeConsistencyProbeRequest(judgeRequest = {}, args = {}) {
  const limit = judgeConsistencyProbeLimit(args);
  if (!limit) return null;
  const nodeLimit = Math.min(judgeRequest.candidates?.length || 0, Math.max(0, Math.ceil(limit * 0.7)));
  let edgeLimit = Math.min(judgeRequest.edges?.length || 0, Math.max(0, limit - nodeLimit));
  let adjustedNodeLimit = nodeLimit;
  if (!edgeLimit && judgeRequest.edges?.length && adjustedNodeLimit < limit) {
    edgeLimit = Math.min(judgeRequest.edges.length, limit - adjustedNodeLimit);
  }
  if (!adjustedNodeLimit && judgeRequest.candidates?.length && edgeLimit < limit) {
    adjustedNodeLimit = Math.min(judgeRequest.candidates.length, limit - edgeLimit);
  }
  const candidates = (judgeRequest.candidates || []).slice(0, adjustedNodeLimit).reverse();
  const edges = (judgeRequest.edges || []).slice(0, edgeLimit).reverse();
  const pairLimit = Math.min(judgeRequest.candidate_pairs?.length || 0, Math.max(0, Math.ceil(limit / 3)));
  const candidatePairs = (judgeRequest.candidate_pairs || []).slice(0, pairLimit).reverse().map((pair) => ({
    ...pair,
    candidate_a_id: pair.candidate_b_id,
    candidate_b_id: pair.candidate_a_id,
    candidate_a: pair.candidate_b || null,
    candidate_b: pair.candidate_a || null,
    swapped_order: true
  }));
  if (!candidates.length && !edges.length && !candidatePairs.length) return null;
  return {
    ...judgeRequest,
    task: 'research_controller.judge_batch_consistency_probe',
    candidates,
    edges,
    candidate_pairs: candidatePairs,
    consistency_probe: {
      probe_type: 'order_swap',
      source_task: judgeRequest.task || 'research_controller.judge_batch',
      sampled_candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      sampled_edge_ids: edges.map((edge) => edge.edge_id),
      sampled_pair_ids: candidatePairs.map((pair) => pair.pair_id),
      instruction: 'Judge the same sampled records in reversed order. Use the same rubric; the controller will compare consistency only.'
    },
    budget: {
      ...(judgeRequest.budget || {}),
      consistency_probe_items: candidates.length + edges.length + candidatePairs.length,
      requested_candidate_count: candidates.length,
      requested_edge_count: edges.length,
      requested_pairwise_count: candidatePairs.length
    }
  };
}

function buildJudgePrompt(judgeRequest = {}) {
  return [
    'You are a single-model research-design judge for PaperNexus.',
    'Return strict JSON only. Do not use outside knowledge.',
    'Judge whether the supplied graph-backed candidate methods and candidate relations are useful enough for later selection.',
    'The controller will treat your output as evidence, not as direct authority.',
    '',
    `Judge request: ${JSON.stringify(judgeRequest)}`
  ].join('\n');
}

function heuristicNodeJudgment(candidate = {}) {
  const scores = candidate.scores || {};
  const evidenceSupport = normalizeScore(scores.graph_evidence_strength, candidate.evidence_tier === 'strong' ? 0.8 : 0.55);
  const mechanismFit = normalizeScore(scores.mechanism_fit, 0.5);
  const feasibility = normalizeScore(scores.feasibility, 0.4);
  const noveltyPotential = normalizeScore(scores.novelty_potential, 0.35);
  const risk = normalizeScore(scores.risk, 0.55);
  const evaluationReadiness = candidate.evaluation_plan?.metrics?.length ? 0.55 : 0.25;
  const verdict = evidenceSupport >= 0.45 && mechanismFit >= 0.45
    ? (evaluationReadiness >= 0.5 ? 'keep' : 'needs_evidence')
    : 'needs_evidence';
  return {
    candidate_id: candidate.candidate_id,
    verdict,
    scores: {
      evidence_support: evidenceSupport,
      mechanism_fit: mechanismFit,
      feasibility,
      novelty_potential: noveltyPotential,
      risk,
      evaluation_readiness: evaluationReadiness
    },
    rationale: 'Rubric fallback based on graph evidence strength, mechanism fit, feasibility placeholder, and metric availability.',
    missing_evidence: ['method-card details', 'baseline plan', 'ablation plan'].filter((entry) => {
      if (entry === 'baseline plan') return !candidate.evaluation_plan?.baseline;
      return true;
    })
  };
}

function heuristicEdgeJudgment(edge = {}) {
  return {
    edge_id: edge.edge_id,
    verdict: edge.relation_types?.length ? 'keep' : 'needs_evidence',
    valid_relation_types: edge.relation_types || [],
    confidence: normalizeScore(edge.confidence, 0.45),
    rationale: edge.rationale || 'Rubric fallback accepted relation proposal because it has bounded blocking evidence.'
  };
}

function heuristicPairwisePreference(pair = {}, candidateById = new Map()) {
  const left = candidateById.get(pair.candidate_a_id) || {};
  const right = candidateById.get(pair.candidate_b_id) || {};
  const leftEvidence = normalizeScore(left.scores?.graph_evidence_strength, 0.5);
  const rightEvidence = normalizeScore(right.scores?.graph_evidence_strength, 0.5);
  const leftFit = normalizeScore(left.scores?.mechanism_fit, 0.5);
  const rightFit = normalizeScore(right.scores?.mechanism_fit, 0.5);
  const leftScore = (0.55 * leftEvidence) + (0.45 * leftFit);
  const rightScore = (0.55 * rightEvidence) + (0.45 * rightFit);
  const delta = leftScore - rightScore;
  const winner = Math.abs(delta) < 0.05 ? 'tie' : (delta > 0 ? 'A' : 'B');
  return {
    pair_id: pair.pair_id,
    candidate_a_id: pair.candidate_a_id,
    candidate_b_id: pair.candidate_b_id,
    winner,
    confidence: Math.min(0.8, 0.5 + Math.abs(delta)),
    decision_basis: {
      evidence: 'Rubric fallback compares graph evidence strength.',
      feasibility: 'No external feasibility preference was supplied.',
      novelty: 'No external novelty preference was supplied.',
      expected_gain: 'Expected gain remains speculative until deeper evidence expansion.',
      risk: 'No pair-specific risk preference was supplied.'
    },
    missing_evidence: ['pairwise preference judge rationale']
  };
}

function heuristicJudgePayload(judgeRequest = {}) {
  const candidateById = new Map((judgeRequest.candidates || []).map((candidate) => [candidate.candidate_id, candidate]));
  return {
    summary: 'Controller rubric fallback produced bounded judge evidence without an external model.',
    node_judgments: (judgeRequest.candidates || []).map(heuristicNodeJudgment),
    edge_judgments: (judgeRequest.edges || []).map(heuristicEdgeJudgment),
    pairwise_preferences: (judgeRequest.candidate_pairs || []).map((pair) => heuristicPairwisePreference(pair, candidateById))
  };
}

function normalizeJudgePayload(payload = {}) {
  const normalized = normalizeObject(payload);
  const nodeJudgments = asArray(normalized.node_judgments || normalized.nodeJudgments)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => compactText(entry.candidate_id || entry.candidateId || entry.target_id || entry.targetId));
  const edgeJudgments = asArray(normalized.edge_judgments || normalized.edgeJudgments)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => compactText(entry.edge_id || entry.edgeId || entry.target_id || entry.targetId));
  return {
    summary: compactText(normalized.summary),
    node_judgments: nodeJudgments,
    edge_judgments: edgeJudgments,
    pairwise_preferences: asArray(normalized.pairwise_preferences || normalized.pairwisePreferences)
      .map((entry) => normalizeObject(entry))
      .filter((entry) => compactText(entry.pair_id || entry.pairId || entry.candidate_a_id || entry.candidateAId || entry.candidate_a || entry.candidateA))
  };
}

function normalizePairwiseWinner(value = '') {
  const winner = compactText(value).toLowerCase();
  if (['a', 'candidate_a', 'left'].includes(winner)) return 'A';
  if (['b', 'candidate_b', 'right'].includes(winner)) return 'B';
  if (['tie', 'draw', 'equal'].includes(winner)) return 'tie';
  return 'unsure';
}

function pairwiseCandidateId(preference = {}, side = 'a') {
  if (side === 'a') {
    return compactText(preference.candidate_a_id || preference.candidateAId || preference.candidate_a || preference.candidateA);
  }
  return compactText(preference.candidate_b_id || preference.candidateBId || preference.candidate_b || preference.candidateB);
}

function normalizedPairwisePreference(preference = {}) {
  const candidateA = pairwiseCandidateId(preference, 'a');
  const candidateB = pairwiseCandidateId(preference, 'b');
  const pairId = compactText(preference.pair_id || preference.pairId) || candidatePairId(candidateA, candidateB);
  return {
    pair_id: pairId,
    candidate_a_id: candidateA,
    candidate_b_id: candidateB,
    winner: normalizePairwiseWinner(preference.winner || preference.preference || preference.preferred),
    confidence: normalizeScore(preference.confidence, 0.5),
    decision_basis: normalizeObject(preference.decision_basis || preference.decisionBasis),
    missing_evidence: normalizeStringArray(preference.missing_evidence || preference.missingEvidence),
    rationale: truncate(preference.rationale || preference.reason || '', 800)
  };
}

function normalizedJudgmentMaps(payload = {}) {
  const normalized = normalizeJudgePayload(payload);
  const nodeMap = new Map();
  for (const judgment of normalized.node_judgments) {
    const candidateId = compactText(judgment.candidate_id || judgment.candidateId || judgment.target_id || judgment.targetId);
    if (!candidateId) continue;
    nodeMap.set(candidateId, {
      verdict: normalizeVerdict(judgment.verdict),
      scores: normalizeObject(judgment.scores)
    });
  }
  const edgeMap = new Map();
  for (const judgment of normalized.edge_judgments) {
    const edgeId = compactText(judgment.edge_id || judgment.edgeId || judgment.target_id || judgment.targetId);
    if (!edgeId) continue;
    edgeMap.set(edgeId, {
      verdict: normalizeVerdict(judgment.verdict),
      relation_types: normalizeStringArray(judgment.valid_relation_types || judgment.validRelationTypes || judgment.relation_types || judgment.relationTypes),
      confidence: normalizeScore(judgment.confidence, 0.5)
    });
  }
  const pairwiseMap = new Map();
  for (const preference of normalized.pairwise_preferences) {
    const normalizedPreference = normalizedPairwisePreference(preference);
    if (!normalizedPreference.candidate_a_id || !normalizedPreference.candidate_b_id) continue;
    pairwiseMap.set(normalizedPreference.pair_id, normalizedPreference);
  }
  return { nodeMap, edgeMap, pairwiseMap };
}

function relationSetsCompatible(left = [], right = []) {
  if (!left.length || !right.length) return true;
  return intersection(left, right).length > 0;
}

function invertPairwiseWinner(winner = 'unsure') {
  if (winner === 'A') return 'B';
  if (winner === 'B') return 'A';
  return winner;
}

function pairwiseWinnersCompatible(mainPreference = {}, probePreference = {}) {
  const swapped = mainPreference.candidate_a_id === probePreference.candidate_b_id
    && mainPreference.candidate_b_id === probePreference.candidate_a_id;
  const probeWinner = swapped ? invertPairwiseWinner(probePreference.winner) : probePreference.winner;
  if (mainPreference.winner === 'unsure' || probeWinner === 'unsure') return true;
  return mainPreference.winner === probeWinner;
}

function compareJudgeConsistency(mainPayload = {}, probePayload = {}, probeRequest = {}) {
  if (!probeRequest) return 'not_measured_single_pass';
  const main = normalizedJudgmentMaps(mainPayload);
  const probe = normalizedJudgmentMaps(probePayload);
  const mismatches = [];
  let checked = 0;
  let matched = 0;
  let nodeChecked = 0;
  let nodeMatched = 0;
  let edgeChecked = 0;
  let edgeMatched = 0;
  let pairwiseChecked = 0;
  let pairwiseMatched = 0;

  for (const candidate of probeRequest.candidates || []) {
    const targetId = candidate.candidate_id;
    const mainJudgment = main.nodeMap.get(targetId);
    const probeJudgment = probe.nodeMap.get(targetId);
    if (!mainJudgment || !probeJudgment) continue;
    checked += 1;
    nodeChecked += 1;
    if (mainJudgment.verdict === probeJudgment.verdict) {
      matched += 1;
      nodeMatched += 1;
    } else {
      mismatches.push({
        decision_scope: 'candidate_node',
        target_id: targetId,
        main_verdict: mainJudgment.verdict,
        probe_verdict: probeJudgment.verdict
      });
    }
  }

  for (const edge of probeRequest.edges || []) {
    const targetId = edge.edge_id;
    const mainJudgment = main.edgeMap.get(targetId);
    const probeJudgment = probe.edgeMap.get(targetId);
    if (!mainJudgment || !probeJudgment) continue;
    checked += 1;
    edgeChecked += 1;
    const verdictMatch = mainJudgment.verdict === probeJudgment.verdict;
    const relationMatch = relationSetsCompatible(mainJudgment.relation_types, probeJudgment.relation_types);
    if (verdictMatch && relationMatch) {
      matched += 1;
      edgeMatched += 1;
    } else {
      mismatches.push({
        decision_scope: 'candidate_edge',
        target_id: targetId,
        main_verdict: mainJudgment.verdict,
        probe_verdict: probeJudgment.verdict,
        main_relation_types: mainJudgment.relation_types,
        probe_relation_types: probeJudgment.relation_types
      });
    }
  }

  for (const pair of probeRequest.candidate_pairs || []) {
    const targetId = pair.pair_id || candidatePairId(pair.candidate_a_id, pair.candidate_b_id);
    const mainPreference = main.pairwiseMap.get(targetId);
    const probePreference = probe.pairwiseMap.get(targetId);
    if (!mainPreference || !probePreference) continue;
    checked += 1;
    pairwiseChecked += 1;
    if (pairwiseWinnersCompatible(mainPreference, probePreference)) {
      matched += 1;
      pairwiseMatched += 1;
    } else {
      mismatches.push({
        decision_scope: 'candidate_pairwise_preference',
        target_id: targetId,
        main_winner: mainPreference.winner,
        probe_winner: probePreference.winner,
        probe_swapped_order: Boolean(pair.swapped_order)
      });
    }
  }

  if (!checked) {
    return {
      status: 'not_measured_no_overlap',
      probe_type: 'order_swap',
      checked_count: 0,
      consistency_score: null,
      mismatches: []
    };
  }
  const score = Number((matched / checked).toFixed(3));
  return {
    status: score >= 0.8 ? 'consistent' : (score >= 0.5 ? 'mixed' : 'inconsistent'),
    probe_type: 'order_swap',
    checked_count: checked,
    matched_count: matched,
    node_checked_count: nodeChecked,
    node_matched_count: nodeMatched,
    edge_checked_count: edgeChecked,
    edge_matched_count: edgeMatched,
    pairwise_checked_count: pairwiseChecked,
    pairwise_matched_count: pairwiseMatched,
    consistency_score: score,
    mismatches: mismatches.slice(0, 20),
    generatedAt: nowIso()
  };
}

function externalJudgeConsistencyPayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  return normalizeObject(
    externalInputs.judge_consistency_payload
    || externalInputs.judgeConsistencyPayload
    || externalInputs.judge_order_swap_payload
    || externalInputs.judgeOrderSwapPayload
    || args.judgeConsistencyPayload
    || args.judge_consistency_payload
  );
}

function normalizeJudgeDecisions(payload = {}, judgeRun = {}, state = {}) {
  const normalized = normalizeJudgePayload(payload);
  const decisions = [];
  for (const judgment of normalized.node_judgments) {
    const candidateId = compactText(judgment.candidate_id || judgment.candidateId || judgment.target_id || judgment.targetId);
    const scores = normalizeObject(judgment.scores);
    decisions.push({
      record_type: 'judge_decision',
      decision_id: `jdec:${stableHash(`${state.project || ''}:${state.task_id || ''}:${judgeRun.run_id}:node:${candidateId}`, 20)}`,
      project: state.project || null,
      task_id: state.task_id || null,
      round_id: `round:${state.current_round ?? 0}`,
      judge_run_id: judgeRun.run_id,
      decision_scope: 'candidate_node',
      target_id: candidateId,
      verdict: normalizeVerdict(judgment.verdict),
      scores: {
        evidence_support: normalizeScore(scores.evidence_support ?? scores.evidenceSupport, 0.5),
        mechanism_fit: normalizeScore(scores.mechanism_fit ?? scores.mechanismFit, 0.5),
        feasibility: normalizeScore(scores.feasibility, 0.5),
        novelty_potential: normalizeScore(scores.novelty_potential ?? scores.noveltyPotential, 0.5),
        risk: normalizeScore(scores.risk, 0.5),
        evaluation_readiness: normalizeScore(scores.evaluation_readiness ?? scores.evaluationReadiness, 0.5)
      },
      rationale: truncate(judgment.rationale || judgment.reason || '', 800),
      missing_evidence: normalizeStringArray(judgment.missing_evidence || judgment.missingEvidence),
      judge: {
        mode: 'single_model',
        backend: judgeRun.backend,
        model: judgeRun.model || null,
        source: judgeRun.source
      },
      labels: {
        evidence_supported: ['target_id'],
        agent_inferred: ['verdict', 'scores', 'rationale', 'missing_evidence'],
        speculative: []
      },
      created_at: nowIso()
    });
  }
  for (const judgment of normalized.edge_judgments) {
    const edgeId = compactText(judgment.edge_id || judgment.edgeId || judgment.target_id || judgment.targetId);
    decisions.push({
      record_type: 'judge_decision',
      decision_id: `jdec:${stableHash(`${state.project || ''}:${state.task_id || ''}:${judgeRun.run_id}:edge:${edgeId}`, 20)}`,
      project: state.project || null,
      task_id: state.task_id || null,
      round_id: `round:${state.current_round ?? 0}`,
      judge_run_id: judgeRun.run_id,
      decision_scope: 'candidate_edge',
      target_id: edgeId,
      verdict: normalizeVerdict(judgment.verdict),
      valid_relation_types: normalizeStringArray(judgment.valid_relation_types || judgment.validRelationTypes || judgment.relation_types || judgment.relationTypes),
      confidence: normalizeScore(judgment.confidence, 0.5),
      rationale: truncate(judgment.rationale || judgment.reason || '', 800),
      judge: {
        mode: 'single_model',
        backend: judgeRun.backend,
        model: judgeRun.model || null,
        source: judgeRun.source
      },
      labels: {
        evidence_supported: ['target_id'],
        agent_inferred: ['verdict', 'valid_relation_types', 'confidence', 'rationale'],
        speculative: []
      },
      created_at: nowIso()
    });
  }
  for (const preference of normalized.pairwise_preferences) {
    const normalizedPreference = normalizedPairwisePreference(preference);
    if (!normalizedPreference.candidate_a_id || !normalizedPreference.candidate_b_id) continue;
    decisions.push({
      record_type: 'judge_decision',
      decision_id: `jdec:${stableHash(`${state.project || ''}:${state.task_id || ''}:${judgeRun.run_id}:pairwise:${normalizedPreference.pair_id}`, 20)}`,
      project: state.project || null,
      task_id: state.task_id || null,
      round_id: `round:${state.current_round ?? 0}`,
      judge_run_id: judgeRun.run_id,
      decision_scope: 'candidate_pairwise_preference',
      target_id: normalizedPreference.pair_id,
      candidate_a_id: normalizedPreference.candidate_a_id,
      candidate_b_id: normalizedPreference.candidate_b_id,
      winner: normalizedPreference.winner,
      confidence: normalizedPreference.confidence,
      decision_basis: normalizedPreference.decision_basis,
      rationale: normalizedPreference.rationale,
      missing_evidence: normalizedPreference.missing_evidence,
      judge: {
        mode: 'single_model',
        backend: judgeRun.backend,
        model: judgeRun.model || null,
        source: judgeRun.source
      },
      labels: {
        evidence_supported: ['candidate_a_id', 'candidate_b_id'],
        agent_inferred: ['winner', 'confidence', 'decision_basis', 'rationale', 'missing_evidence'],
        speculative: []
      },
      created_at: nowIso()
    });
  }
  return {
    summary: normalized.summary,
    decisions,
    pairwise_preferences: normalized.pairwise_preferences
  };
}

function externalJudgePayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = externalInputs.judge_payload || externalInputs.judgePayload || args.judgePayload || args.judge_payload;
  if (payload) return normalizeObject(payload);
  const decisions = externalInputs.judge_decisions || externalInputs.judgeDecisions || args.judgeDecisions || args.judge_decisions;
  if (!decisions) return null;
  const decisionEntries = asArray(decisions).map((entry) => normalizeObject(entry));
  return {
    summary: compactText(externalInputs.summary || args.summary),
    node_judgments: decisionEntries.filter((entry) => !['candidate_edge', 'candidate_pairwise_preference'].includes(entry.decision_scope)),
    edge_judgments: decisionEntries.filter((entry) => entry.decision_scope === 'candidate_edge'),
    pairwise_preferences: decisionEntries.filter((entry) => entry.decision_scope === 'candidate_pairwise_preference')
  };
}

async function runJudgeBatch(judgeRequest = {}, args = {}, context = {}) {
  const externalPayload = externalJudgePayload(args);
  if (externalPayload) {
    const probeRequest = buildJudgeConsistencyProbeRequest(judgeRequest, args);
    const probePayload = externalJudgeConsistencyPayload(args);
    const hasProbePayload = Object.keys(probePayload).length > 0;
    return {
      backend: 'external_agent_inputs',
      source: 'external_inputs',
      model: compactText(normalizeJudge(args).model) || null,
      payload: externalPayload,
      consistency_probe_payload: hasProbePayload ? probePayload : null,
      self_consistency: hasProbePayload
        ? compareJudgeConsistency(externalPayload, probePayload, probeRequest)
        : (externalPayload.self_consistency || externalPayload.selfConsistency || 'not_measured_external_payload'),
      warnings: probeRequest && !hasProbePayload
        ? ['Judge consistency checks were requested, but no external consistency probe payload was supplied.']
        : []
    };
  }

  const hook = typeof context.options?.llmJson === 'function'
    ? context.options.llmJson
    : (typeof args.llmJson === 'function' ? args.llmJson : null);
  if (hook) {
    const prompt = buildJudgePrompt(judgeRequest);
    const payload = await hook({
      task: 'research_controller.judge_batch',
      prompt,
      args,
      judgeRequest,
      candidates: judgeRequest.candidates,
      edges: judgeRequest.edges,
      candidatePairs: judgeRequest.candidate_pairs
    });
    const parsedPayload = typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload);
    const probeRequest = buildJudgeConsistencyProbeRequest(judgeRequest, args);
    let probePayload = null;
    let selfConsistency = 'not_measured_single_pass';
    if (probeRequest) {
      const probeRaw = await hook({
        task: 'research_controller.judge_batch_consistency_probe',
        prompt: buildJudgePrompt(probeRequest),
        args,
        judgeRequest: probeRequest,
        consistencyProbe: probeRequest.consistency_probe,
        candidates: probeRequest.candidates,
        edges: probeRequest.edges,
        candidatePairs: probeRequest.candidate_pairs
      });
      probePayload = typeof probeRaw === 'string' ? parseJsonText(probeRaw) : normalizeObject(probeRaw);
      selfConsistency = compareJudgeConsistency(parsedPayload, probePayload, probeRequest);
    }
    return {
      backend: 'single_model_llm_json',
      source: 'llm_json_hook',
      model: compactText(normalizeJudge(args).model) || null,
      payload: parsedPayload,
      consistency_probe_payload: probePayload,
      self_consistency: selfConsistency,
      warnings: []
    };
  }

  const providerRun = await requestConfiguredControllerLlmJson(
    'research_controller.judge_batch',
    buildJudgePrompt(judgeRequest),
    argsWithControllerRequestPolicy(args, judgeRequest),
    context,
    1
  );
  if (providerRun.payload) {
    const probeRequest = buildJudgeConsistencyProbeRequest(judgeRequest, args);
    let probePayload = null;
    let selfConsistency = 'not_measured_single_pass';
    const warnings = [...(providerRun.warnings || [])];
    let providerCallCount = providerRun.provider_call_count || 0;
    if (probeRequest) {
      const probeRun = await requestConfiguredControllerLlmJson(
        'research_controller.judge_batch_consistency_probe',
        buildJudgePrompt(probeRequest),
        argsWithControllerRequestPolicy(args, probeRequest),
        context,
        2
      );
      providerCallCount += probeRun.provider_call_count || 0;
      warnings.push(...(probeRun.warnings || []));
      if (probeRun.payload) {
        probePayload = probeRun.payload;
        selfConsistency = compareJudgeConsistency(providerRun.payload, probePayload, probeRequest);
      } else {
        warnings.push('Judge consistency checks were requested, but the configured controller LLM did not return a usable consistency probe payload.');
      }
    }
    return {
      backend: providerRun.backend,
      source: providerRun.source,
      model: providerRun.model,
      payload: providerRun.payload,
      consistency_probe_payload: probePayload,
      self_consistency: selfConsistency,
      provider_call_count: providerCallCount,
      warnings
    };
  }

  const fallbackPayload = heuristicJudgePayload(judgeRequest);
  const probeRequest = buildJudgeConsistencyProbeRequest(judgeRequest, args);
  const probePayload = probeRequest ? heuristicJudgePayload(probeRequest) : null;
  return {
    backend: 'controller_rubric_fallback',
    source: 'controller_rubric_fallback',
    model: null,
    payload: fallbackPayload,
    consistency_probe_payload: probePayload,
    self_consistency: probePayload
      ? compareJudgeConsistency(fallbackPayload, probePayload, probeRequest)
      : 'not_measured_single_pass',
    warnings: [
      ...(providerRun.warnings || []),
      'No external judge model, submitted judge payload, llmJson hook, or configured controller LLM payload was available; wrote controller rubric fallback decisions.'
    ]
  };
}

function consistencyProbeDecisionScope(scope = '') {
  if (scope === 'candidate_edge') return 'consistency_probe_candidate_edge';
  if (scope === 'candidate_pairwise_preference') return 'consistency_probe_candidate_pairwise_preference';
  return 'consistency_probe_candidate_node';
}

function normalizeConsistencyProbeDecisions(payload = {}, judgeRun = {}, state = {}) {
  if (!payload) return [];
  const normalized = normalizeJudgeDecisions(payload, judgeRun, state);
  return normalized.decisions.map((decision) => ({
    ...decision,
    decision_id: `jdec:${stableHash(`${decision.decision_id}:consistency-probe`, 20)}`,
    decision_scope: consistencyProbeDecisionScope(decision.decision_scope),
    consistency_probe: true,
    main_judge_run_id: judgeRun.main_judge_run_id || null,
    labels: {
      ...(decision.labels || {}),
      agent_inferred: unique([
        ...(decision.labels?.agent_inferred || []),
        'order_swap_consistency_probe'
      ])
    }
  }));
}

function mergeJudgeDecisions(existingRecords = [], nextRecords = []) {
  const byKey = new Map();
  for (const record of existingRecords) byKey.set(record.decision_id || stableHash(JSON.stringify(record), 20), record);
  for (const record of nextRecords) byKey.set(record.decision_id || stableHash(JSON.stringify(record), 20), record);
  return [...byKey.values()].sort((left, right) => String(left.decision_id || '').localeCompare(String(right.decision_id || '')));
}

function selectionBatchLimit(args = {}, state = {}) {
  const budget = normalizeObject(args.budget);
  return boundedInteger(
    args.maxSelectedCandidates ?? args.max_selected_candidates ?? budget.max_selected_candidates ?? budget.maxSelectedCandidates,
    Math.min(3, Math.max(1, state.budget?.max_selected_candidates || 3)),
    { min: 1, max: 20 }
  );
}

function latestDecisionByTarget(decisions = [], scope = 'candidate_node') {
  const byTarget = new Map();
  for (const decision of decisions) {
    if (decision.decision_scope !== scope || !decision.target_id) continue;
    byTarget.set(decision.target_id, decision);
  }
  return byTarget;
}

function pairwisePreferenceSummary(decisions = []) {
  const rawScores = new Map();
  const stats = new Map();
  const weightedWins = new Map();
  const pairWeights = new Map();
  const ensure = (candidateId) => {
    if (!rawScores.has(candidateId)) rawScores.set(candidateId, 0);
    if (!stats.has(candidateId)) stats.set(candidateId, { wins: 0, losses: 0, ties: 0, comparisons: 0 });
    if (!weightedWins.has(candidateId)) weightedWins.set(candidateId, 0);
  };
  const addPairWeight = (left, right, weight) => {
    const key = [left, right].sort().join('\u0000');
    const current = pairWeights.get(key) || { left, right, weight: 0 };
    current.weight += weight;
    pairWeights.set(key, current);
  };
  for (const decision of decisions) {
    if (decision.decision_scope !== 'candidate_pairwise_preference') continue;
    const left = compactText(decision.candidate_a_id);
    const right = compactText(decision.candidate_b_id);
    if (!left || !right) continue;
    const winner = normalizePairwiseWinner(decision.winner);
    const confidence = normalizeScore(decision.confidence, 0.5);
    ensure(left);
    ensure(right);
    stats.get(left).comparisons += 1;
    stats.get(right).comparisons += 1;
    addPairWeight(left, right, confidence);
    if (winner === 'A') {
      rawScores.set(left, rawScores.get(left) + confidence);
      rawScores.set(right, rawScores.get(right) - confidence);
      weightedWins.set(left, weightedWins.get(left) + confidence);
      stats.get(left).wins += 1;
      stats.get(right).losses += 1;
    } else if (winner === 'B') {
      rawScores.set(right, rawScores.get(right) + confidence);
      rawScores.set(left, rawScores.get(left) - confidence);
      weightedWins.set(right, weightedWins.get(right) + confidence);
      stats.get(right).wins += 1;
      stats.get(left).losses += 1;
    } else if (winner === 'tie') {
      rawScores.set(left, rawScores.get(left) + (0.1 * confidence));
      rawScores.set(right, rawScores.get(right) + (0.1 * confidence));
      weightedWins.set(left, weightedWins.get(left) + (0.5 * confidence));
      weightedWins.set(right, weightedWins.get(right) + (0.5 * confidence));
      stats.get(left).ties += 1;
      stats.get(right).ties += 1;
    }
  }
  const candidateIds = [...stats.keys()].sort();
  const abilities = bradleyTerryAbilities(candidateIds, weightedWins, pairWeights);
  const abilityValues = [...abilities.values()];
  const minAbility = abilityValues.length ? Math.min(...abilityValues) : 1;
  const maxAbility = abilityValues.length ? Math.max(...abilityValues) : 1;
  const summary = new Map();
  for (const [candidateId, rawScore] of rawScores.entries()) {
    const candidateStats = stats.get(candidateId) || { wins: 0, losses: 0, ties: 0, comparisons: 0 };
    const winLossNormalized = candidateStats.comparisons
      ? Math.max(0, Math.min(1, 0.5 + (rawScore / (2 * candidateStats.comparisons))))
      : 0.5;
    const ability = abilities.get(candidateId) || 1;
    const normalized = maxAbility > minAbility
      ? Math.max(0, Math.min(1, 0.25 + (0.5 * ((ability - minAbility) / (maxAbility - minAbility)))))
      : 0.5;
    summary.set(candidateId, {
      ...candidateStats,
      raw_score: Number(rawScore.toFixed(3)),
      win_loss_score: Number(winLossNormalized.toFixed(3)),
      bt_ability: Number(ability.toFixed(4)),
      normalized_score: Number(normalized.toFixed(3)),
      aggregation: 'bradley_terry_mm'
    });
  }
  return summary;
}

function bradleyTerryAbilities(candidateIds = [], weightedWins = new Map(), pairWeights = new Map()) {
  const abilities = new Map(candidateIds.map((candidateId) => [candidateId, 1]));
  if (candidateIds.length < 2 || !pairWeights.size) return abilities;
  const prior = 0.5;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const next = new Map();
    for (const candidateId of candidateIds) {
      let denominator = prior;
      for (const pair of pairWeights.values()) {
        if (pair.left !== candidateId && pair.right !== candidateId) continue;
        const otherId = pair.left === candidateId ? pair.right : pair.left;
        denominator += pair.weight / ((abilities.get(candidateId) || 1) + (abilities.get(otherId) || 1));
      }
      const numerator = prior + (weightedWins.get(candidateId) || 0);
      next.set(candidateId, denominator > 0 ? numerator / denominator : 1);
    }
    const mean = [...next.values()].reduce((sum, value) => sum + value, 0) / Math.max(1, next.size);
    for (const candidateId of candidateIds) {
      abilities.set(candidateId, (next.get(candidateId) || 1) / (mean || 1));
    }
  }
  return abilities;
}

function posteriorSeedForCandidate(candidate = {}) {
  const mechanismTokens = candidateMechanismTokens(candidate);
  return {
    candidate_id: candidate.candidate_id,
    alpha: 1,
    beta: 1,
    wins: 0,
    losses: 0,
    ties: 0,
    unsure: 0,
    comparisons: 0,
    weighted_wins: 0,
    weighted_losses: 0,
    weighted_ties: 0,
    mechanism_key: mechanismTokens.length
      ? mechanismTokens.slice(0, 4).join(' ')
      : normalizeComparable(candidate.mechanism || ''),
    source_domain_key: normalizeComparable(candidate.source_domain || candidate.sourceDomain || candidate.evidence?.source_domain || candidate.evidence?.sourceDomain || '')
  };
}

function finalizePosteriorRecord(record = {}, totalComparisons = 0, pairwisePreference = null) {
  const total = (record.alpha || 0) + (record.beta || 0);
  const posteriorMean = total > 0 ? (record.alpha || 0) / total : 0.5;
  const variance = total > 0
    ? ((record.alpha || 0) * (record.beta || 0)) / ((total ** 2) * (total + 1))
    : 0;
  const uncertainty = Math.sqrt(Math.max(0, variance));
  const explorationBonus = Math.min(0.25, Math.sqrt(Math.log(2 + totalComparisons) / (2 * ((record.comparisons || 0) + 1))));
  const selectionIndex = Math.max(0, Math.min(1, posteriorMean + explorationBonus));
  return {
    ...record,
    alpha: Number((record.alpha || 0).toFixed(3)),
    beta: Number((record.beta || 0).toFixed(3)),
    weighted_wins: Number((record.weighted_wins || 0).toFixed(3)),
    weighted_losses: Number((record.weighted_losses || 0).toFixed(3)),
    weighted_ties: Number((record.weighted_ties || 0).toFixed(3)),
    posterior_mean: Number(posteriorMean.toFixed(3)),
    posterior_variance: Number(variance.toFixed(5)),
    uncertainty: Number(uncertainty.toFixed(3)),
    exploration_bonus: Number(explorationBonus.toFixed(3)),
    selection_index: Number(selectionIndex.toFixed(3)),
    bt_ability: pairwisePreference?.bt_ability ?? null,
    bt_normalized_score: pairwisePreference?.normalized_score ?? null
  };
}

function summarizePosteriorGroups(candidateValues = {}, groupKey = '') {
  const groups = new Map();
  for (const value of Object.values(candidateValues)) {
    const key = compactText(value[groupKey]);
    if (!key) continue;
    const group = groups.get(key) || {
      key,
      candidate_count: 0,
      posterior_mean_sum: 0,
      uncertainty_sum: 0,
      exploration_bonus_sum: 0,
      candidates: []
    };
    group.candidate_count += 1;
    group.posterior_mean_sum += normalizeScore(value.posterior_mean, 0.5);
    group.uncertainty_sum += Number(value.uncertainty || 0);
    group.exploration_bonus_sum += Number(value.exploration_bonus || 0);
    group.candidates.push({
      candidate_id: value.candidate_id,
      posterior_mean: value.posterior_mean,
      uncertainty: value.uncertainty,
      selection_index: value.selection_index
    });
    groups.set(key, group);
  }
  const output = {};
  for (const [key, group] of groups.entries()) {
    output[key] = {
      candidate_count: group.candidate_count,
      posterior_mean: Number((group.posterior_mean_sum / Math.max(1, group.candidate_count)).toFixed(3)),
      uncertainty: Number((group.uncertainty_sum / Math.max(1, group.candidate_count)).toFixed(3)),
      exploration_bonus: Number((group.exploration_bonus_sum / Math.max(1, group.candidate_count)).toFixed(3)),
      top_candidate_ids: group.candidates
        .sort((left, right) => {
          if (right.selection_index !== left.selection_index) return right.selection_index - left.selection_index;
          return String(left.candidate_id).localeCompare(String(right.candidate_id));
        })
        .slice(0, 5)
        .map((candidate) => candidate.candidate_id)
    };
  }
  return output;
}

function duelingPosteriorSummary(candidates = [], decisions = [], pairwiseByCandidateId = new Map()) {
  const records = new Map();
  const ensure = (candidateId, candidate = {}) => {
    if (!candidateId) return null;
    if (!records.has(candidateId)) {
      records.set(candidateId, posteriorSeedForCandidate({ ...candidate, candidate_id: candidateId }));
    }
    return records.get(candidateId);
  };
  for (const candidate of candidates) ensure(candidate.candidate_id, candidate);

  let totalPairwiseDecisions = 0;
  let totalPairwiseWeight = 0;
  for (const decision of decisions) {
    if (decision.decision_scope !== 'candidate_pairwise_preference') continue;
    const leftId = compactText(decision.candidate_a_id);
    const rightId = compactText(decision.candidate_b_id);
    if (!leftId || !rightId) continue;
    const left = ensure(leftId);
    const right = ensure(rightId);
    if (!left || !right) continue;
    const winner = normalizePairwiseWinner(decision.winner);
    const weight = Math.max(0.05, normalizeScore(decision.confidence, 0.5));
    totalPairwiseDecisions += 1;
    totalPairwiseWeight += weight;
    left.comparisons += 1;
    right.comparisons += 1;
    if (winner === 'A') {
      left.alpha += weight;
      right.beta += weight;
      left.wins += 1;
      right.losses += 1;
      left.weighted_wins += weight;
      right.weighted_losses += weight;
    } else if (winner === 'B') {
      right.alpha += weight;
      left.beta += weight;
      right.wins += 1;
      left.losses += 1;
      right.weighted_wins += weight;
      left.weighted_losses += weight;
    } else if (winner === 'tie') {
      left.alpha += 0.5 * weight;
      left.beta += 0.5 * weight;
      right.alpha += 0.5 * weight;
      right.beta += 0.5 * weight;
      left.ties += 1;
      right.ties += 1;
      left.weighted_ties += weight;
      right.weighted_ties += weight;
    } else {
      left.unsure += 1;
      right.unsure += 1;
    }
  }

  const candidateValues = {};
  for (const [candidateId, record] of records.entries()) {
    candidateValues[candidateId] = finalizePosteriorRecord(record, totalPairwiseDecisions, pairwiseByCandidateId.get(candidateId));
  }
  const topCandidates = Object.values(candidateValues)
    .sort((left, right) => {
      if (right.selection_index !== left.selection_index) return right.selection_index - left.selection_index;
      if (right.posterior_mean !== left.posterior_mean) return right.posterior_mean - left.posterior_mean;
      return String(left.candidate_id).localeCompare(String(right.candidate_id));
    })
    .slice(0, 20);

  return {
    backend: 'beta_bernoulli_dueling_mvp',
    update_status: totalPairwiseDecisions ? 'updated_from_pairwise_preferences' : 'prior_only_no_pairwise_preferences',
    preference_source: 'candidate_pairwise_preference judge decisions',
    prior: {
      alpha: 1,
      beta: 1
    },
    total_pairwise_decisions: totalPairwiseDecisions,
    total_pairwise_weight: Number(totalPairwiseWeight.toFixed(3)),
    candidate_values: candidateValues,
    mechanism_values: summarizePosteriorGroups(candidateValues, 'mechanism_key'),
    source_domain_values: summarizePosteriorGroups(candidateValues, 'source_domain_key'),
    top_candidates: topCandidates,
    selection_index: 'posterior_mean_plus_capped_exploration_bonus',
    limitations: [
      'MVP posterior treats single-model pairwise preferences as noisy Bernoulli duels, not verified experimental outcomes.',
      'Use posterior values for controller exploration and auditability; do not treat them as proof of novelty or task performance.'
    ],
    updated_at: nowIso()
  };
}

function candidateSourceLayer(candidate = {}) {
  return compactText(candidate.source_layer || candidate.sourceLayer || candidate.evidence?.source_layer || candidate.evidence?.sourceLayer).toLowerCase();
}

function candidateHasBridgeEvidence(candidate = {}) {
  const evidence = normalizeObject(candidate.evidence);
  const adaptation = normalizeObject(candidate.adaptation_plan || candidate.adaptationPlan);
  const bridgeRefs = [
    ...asArray(evidence.bridge_refs || evidence.bridgeRefs),
    ...asArray(evidence.bridge_evidence || evidence.bridgeEvidence),
    ...asArray(evidence.cross_domain_evidence || evidence.crossDomainEvidence),
    ...asArray(adaptation.bridge_evidence || adaptation.bridgeEvidence)
  ];
  if (bridgeRefs.length) return true;
  const bridgeText = [
    evidence.bridge_reason,
    evidence.bridgeReason,
    adaptation.bridge_reason,
    adaptation.bridgeReason,
    adaptation.transfer_reason,
    adaptation.transferReason
  ].map(compactText).join(' ').toLowerCase();
  return /\b(bridge|mechanism fit|mechanism transfer|cross[-\s]?domain evidence|source-domain evidence)\b/.test(bridgeText);
}

function farSourceGate(candidate = {}, state = {}, mechanismFit = 0.5) {
  if (candidateSourceLayer(candidate) !== 'far_source') {
    return {
      applies: false,
      blocked: false,
      reason: null,
      has_bridge_evidence: false,
      mechanism_fit: mechanismFit
    };
  }
  const allowFarSource = state.constraints?.allow_far_source !== false;
  const hasBridgeEvidence = candidateHasBridgeEvidence(candidate);
  const fitPasses = mechanismFit >= 0.6;
  const blocked = !allowFarSource || (!fitPasses && !hasBridgeEvidence);
  return {
    applies: true,
    blocked,
    reason: !allowFarSource
      ? 'far_source_disallowed'
      : (blocked ? 'far_source_requires_mechanism_fit_or_bridge_evidence' : null),
    has_bridge_evidence: hasBridgeEvidence,
    mechanism_fit: mechanismFit,
    mechanism_fit_threshold: 0.6
  };
}

function scoreCandidateForSelection(candidate = {}, decision = null, pairwisePreference = null, state = {}, posteriorValue = null) {
  const judgeScores = decision?.scores || {};
  const candidateScores = candidate.scores || {};
  const evidenceSupport = normalizeScore(judgeScores.evidence_support, normalizeScore(candidateScores.graph_evidence_strength, 0.45));
  const mechanismFit = normalizeScore(judgeScores.mechanism_fit, normalizeScore(candidateScores.mechanism_fit, 0.45));
  const feasibility = normalizeScore(judgeScores.feasibility, normalizeScore(candidateScores.feasibility, 0.4));
  const noveltyPotential = normalizeScore(judgeScores.novelty_potential, normalizeScore(candidateScores.novelty_potential, 0.35));
  const risk = normalizeScore(judgeScores.risk, normalizeScore(candidateScores.risk, 0.5));
  const pairwiseAgentPreference = normalizeScore(pairwisePreference?.normalized_score, 0.5);
  const posteriorAgentPreference = normalizeScore(posteriorValue?.selection_index, pairwiseAgentPreference);
  const agentPreference = Number(((0.6 * pairwiseAgentPreference) + (0.4 * posteriorAgentPreference)).toFixed(3));
  const evaluationReadiness = normalizeScore(
    judgeScores.evaluation_readiness,
    candidate.evaluation_plan?.metrics?.length ? 0.5 : 0.25
  );
  const verdict = normalizeVerdict(decision?.verdict, 'needs_evidence');
  const farSource = farSourceGate(candidate, state, mechanismFit);
  const hardGate = verdict === 'reject' || (risk >= 0.85 && feasibility < 0.35) || farSource.blocked;
  const needsEvidence = verdict === 'needs_evidence'
    || evidenceSupport < 0.35
    || evaluationReadiness < 0.35
    || !candidate.evaluation_plan?.metrics?.length
    || farSource.blocked;
  const utility = Math.max(0, Math.min(1,
    (0.28 * evidenceSupport)
    + (0.24 * mechanismFit)
    + (0.18 * feasibility)
    + (0.14 * noveltyPotential)
    + (0.1 * agentPreference)
    + (0.12 * evaluationReadiness)
    - (0.16 * risk)
    + 0.07
  ));
  return {
    candidate_id: candidate.candidate_id,
    subproblem_id: candidate.subproblem?.subproblem_id || null,
    subproblem_name: candidate.subproblem?.name || null,
    verdict,
    hard_gate: hardGate,
    needs_evidence: needsEvidence,
    utility: Number(utility.toFixed(3)),
    scores: {
      evidence_support: evidenceSupport,
      mechanism_fit: mechanismFit,
      feasibility,
      novelty_potential: noveltyPotential,
      risk,
      evaluation_readiness: evaluationReadiness,
      agent_preference: agentPreference,
      posterior_mean: posteriorValue?.posterior_mean ?? null,
      posterior_uncertainty: posteriorValue?.uncertainty ?? null,
      posterior_exploration_bonus: posteriorValue?.exploration_bonus ?? null
    },
    pairwise_preference: pairwisePreference || {
      wins: 0,
      losses: 0,
      ties: 0,
      comparisons: 0,
      raw_score: 0,
      normalized_score: 0.5
    },
    posterior: posteriorValue || null,
    far_source_gate: farSource,
    missing_evidence: normalizeStringArray(decision?.missing_evidence || decision?.missingEvidence),
    rationale: decision?.rationale || 'Selection score derived from candidate graph scores without judge rationale.'
  };
}

function candidateEdgesForSelection(edges = [], selectedIds = new Set(), edgeDecisionById = new Map()) {
  return edges
    .filter((edge) => selectedIds.has(edge.source_candidate_id) && selectedIds.has(edge.target_candidate_id))
    .filter((edge) => normalizeVerdict(edgeDecisionById.get(edge.edge_id)?.verdict, 'keep') !== 'reject')
    .map((edge) => ({
      edge_id: edge.edge_id,
      source_candidate_id: edge.source_candidate_id,
      target_candidate_id: edge.target_candidate_id,
      relation_types: edgeDecisionById.get(edge.edge_id)?.valid_relation_types || edge.relation_types || [],
      confidence: edgeDecisionById.get(edge.edge_id)?.confidence ?? edge.confidence ?? null,
      rationale: edgeDecisionById.get(edge.edge_id)?.rationale || edge.rationale || null
    }));
}

const SUBMODULAR_BATCH_OBJECTIVE = {
  base_utility_weight: 0.62,
  coverage_bonus: {
    subproblem: 0.16,
    mechanism: 0.08,
    source_domain: 0.06,
    challenge_aspect: 0.05,
    evidence_cluster: 0.05
  },
  positive_relation_weights: {
    COMPLEMENTS: 0.08,
    PREREQUISITE: 0.05,
    EVALUATION_COMPATIBLE: 0.05,
    SHARES_MECHANISM: 0.03,
    SHARES_FAILURE_MODE: 0.02
  },
  negative_relation_weights: {
    CONFLICTS_WITH: 0.18,
    NOVELTY_COLLISION: 0.12,
    SUBSTITUTES: 0.08,
    COST_COUPLED: 0.05
  },
  relation_bonus_cap: 0.16,
  relation_penalty_cap: 0.24
};

function candidateCoverageKeys(scoredCandidate = {}, candidate = {}) {
  const mechanismTokens = candidateMechanismTokens(candidate);
  return {
    subproblem: compactText(scoredCandidate.subproblem_id || scoredCandidate.subproblem_name || candidateSubproblemKey(candidate)),
    mechanism: mechanismTokens.length ? mechanismTokens.slice(0, 4).join(' ') : normalizeComparable(candidate.mechanism || ''),
    source_domain: normalizeComparable(candidate.source_domain || candidate.sourceDomain || candidate.evidence?.source_domain || candidate.evidence?.sourceDomain || ''),
    challenge_aspect: challengeAspectKey(candidate),
    evidence_cluster: evidenceClusterKey(candidate)
  };
}

function activeSelectionEdge(edge = {}, edgeDecisionById = new Map()) {
  const decision = edgeDecisionById.get(edge.edge_id) || {};
  if (normalizeVerdict(decision.verdict, 'keep') === 'reject') return null;
  const relationTypes = unique(normalizeStringArray(decision.valid_relation_types || edge.relation_types || [])
    .map((relationType) => relationType.toUpperCase()));
  if (!edge.source_candidate_id || !edge.target_candidate_id || !relationTypes.length) return null;
  return {
    edge_id: edge.edge_id,
    source_candidate_id: edge.source_candidate_id,
    target_candidate_id: edge.target_candidate_id,
    relation_types: relationTypes,
    confidence: normalizeScore(decision.confidence ?? edge.confidence, 0.5)
  };
}

function selectionEdgeIndex(edges = [], edgeDecisionById = new Map()) {
  const index = new Map();
  const add = (sourceId, targetId, edge) => {
    const key = `${sourceId}\u0000${targetId}`;
    const list = index.get(key) || [];
    list.push(edge);
    index.set(key, list);
  };
  for (const edge of edges) {
    const activeEdge = activeSelectionEdge(edge, edgeDecisionById);
    if (!activeEdge) continue;
    add(activeEdge.source_candidate_id, activeEdge.target_candidate_id, activeEdge);
    add(activeEdge.target_candidate_id, activeEdge.source_candidate_id, activeEdge);
  }
  return index;
}

function selectionRelationEffect(candidateId, selectedIds = new Set(), edgeIndex = new Map()) {
  let positive = 0;
  let negative = 0;
  const relationTypes = new Set();
  const edgeIds = new Set();
  for (const selectedId of selectedIds) {
    for (const edge of edgeIndex.get(`${candidateId}\u0000${selectedId}`) || []) {
      edgeIds.add(edge.edge_id);
      for (const relationType of edge.relation_types || []) {
        relationTypes.add(relationType);
        const confidence = normalizeScore(edge.confidence, 0.5);
        if (SUBMODULAR_BATCH_OBJECTIVE.positive_relation_weights[relationType]) {
          positive += SUBMODULAR_BATCH_OBJECTIVE.positive_relation_weights[relationType] * confidence;
        }
        if (SUBMODULAR_BATCH_OBJECTIVE.negative_relation_weights[relationType]) {
          negative += SUBMODULAR_BATCH_OBJECTIVE.negative_relation_weights[relationType] * confidence;
        }
      }
    }
  }
  return {
    positive: Math.min(SUBMODULAR_BATCH_OBJECTIVE.relation_bonus_cap, positive),
    negative: Math.min(SUBMODULAR_BATCH_OBJECTIVE.relation_penalty_cap, negative),
    relation_types: [...relationTypes].sort(),
    edge_ids: [...edgeIds].sort()
  };
}

function candidateMarginalGain(entry = {}, selectedIds = new Set(), coverage = {}, candidateById = new Map(), edgeIndex = new Map()) {
  const candidate = candidateById.get(entry.candidate_id) || {};
  const keys = candidateCoverageKeys(entry, candidate);
  const base = SUBMODULAR_BATCH_OBJECTIVE.base_utility_weight * normalizeScore(entry.utility, 0);
  const coverageReasons = [];
  let coverageBonus = 0;
  if (keys.subproblem && !coverage.subproblems.has(keys.subproblem)) {
    coverageBonus += SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus.subproblem;
    coverageReasons.push('new_subproblem');
  }
  if (keys.mechanism && !coverage.mechanisms.has(keys.mechanism)) {
    coverageBonus += SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus.mechanism;
    coverageReasons.push('new_mechanism');
  }
  if (keys.source_domain && !coverage.sourceDomains.has(keys.source_domain)) {
    coverageBonus += SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus.source_domain;
    coverageReasons.push('new_source_domain');
  }
  if (keys.challenge_aspect && !coverage.challengeAspects.has(keys.challenge_aspect)) {
    coverageBonus += SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus.challenge_aspect;
    coverageReasons.push('new_challenge_aspect');
  }
  if (keys.evidence_cluster && !coverage.evidenceClusters.has(keys.evidence_cluster)) {
    coverageBonus += SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus.evidence_cluster;
    coverageReasons.push('new_evidence_cluster');
  }
  const relationEffect = selectionRelationEffect(entry.candidate_id, selectedIds, edgeIndex);
  const marginalGain = base + coverageBonus + relationEffect.positive - relationEffect.negative;
  return {
    marginal_gain: Number(marginalGain.toFixed(3)),
    selection_score: Number((normalizeScore(entry.utility, 0) + coverageBonus + relationEffect.positive - relationEffect.negative).toFixed(3)),
    coverage_keys: keys,
    coverage_bonus: Number(coverageBonus.toFixed(3)),
    relation_bonus: Number(relationEffect.positive.toFixed(3)),
    relation_penalty: Number(relationEffect.negative.toFixed(3)),
    relation_edge_ids: relationEffect.edge_ids,
    relation_types: relationEffect.relation_types,
    selection_reasons: [
      `base_utility=${Number(base.toFixed(3))}`,
      ...coverageReasons,
      ...(relationEffect.positive ? [`positive_relations=${Number(relationEffect.positive.toFixed(3))}`] : []),
      ...(relationEffect.negative ? [`negative_relations=${Number(relationEffect.negative.toFixed(3))}`] : [])
    ]
  };
}

function updateSelectionCoverage(coverage = {}, marginal = {}) {
  const keys = marginal.coverage_keys || {};
  if (keys.subproblem) coverage.subproblems.add(keys.subproblem);
  if (keys.mechanism) coverage.mechanisms.add(keys.mechanism);
  if (keys.source_domain) coverage.sourceDomains.add(keys.source_domain);
  if (keys.challenge_aspect) coverage.challengeAspects.add(keys.challenge_aspect);
  if (keys.evidence_cluster) coverage.evidenceClusters.add(keys.evidence_cluster);
}

function greedySelectCandidates(scoredCandidates = [], maxSelected = 3, options = {}) {
  const eligible = scoredCandidates
    .filter((entry) => !entry.hard_gate)
    .sort((left, right) => {
      if (right.utility !== left.utility) return right.utility - left.utility;
      return String(left.candidate_id).localeCompare(String(right.candidate_id));
    });
  const selected = [];
  const selectedIds = new Set();
  const coverage = {
    subproblems: new Set(),
    mechanisms: new Set(),
    sourceDomains: new Set(),
    challengeAspects: new Set(),
    evidenceClusters: new Set()
  };
  const edgeIndex = selectionEdgeIndex(options.edges || [], options.edgeDecisionById || new Map());
  const candidateById = options.candidateById || new Map();
  const trace = [];

  while (selected.length < maxSelected && selected.length < eligible.length) {
    const ranked = eligible
      .filter((entry) => !selectedIds.has(entry.candidate_id))
      .map((entry) => ({
        entry,
        marginal: candidateMarginalGain(entry, selectedIds, coverage, candidateById, edgeIndex)
      }))
      .sort((left, right) => {
        if (right.marginal.marginal_gain !== left.marginal.marginal_gain) {
          return right.marginal.marginal_gain - left.marginal.marginal_gain;
        }
        if (right.entry.utility !== left.entry.utility) return right.entry.utility - left.entry.utility;
        return String(left.entry.candidate_id).localeCompare(String(right.entry.candidate_id));
      });
    const best = ranked[0];
    if (!best) break;
    const selectedEntry = {
      ...best.entry,
      ...best.marginal
    };
    selected.push(selectedEntry);
    selectedIds.add(selectedEntry.candidate_id);
    updateSelectionCoverage(coverage, best.marginal);
    trace.push({
      rank: selected.length,
      candidate_id: selectedEntry.candidate_id,
      marginal_gain: selectedEntry.marginal_gain,
      utility: selectedEntry.utility,
      coverage_keys: selectedEntry.coverage_keys,
      coverage_bonus: selectedEntry.coverage_bonus,
      relation_bonus: selectedEntry.relation_bonus,
      relation_penalty: selectedEntry.relation_penalty,
      relation_types: selectedEntry.relation_types,
      reasons: selectedEntry.selection_reasons
    });
  }
  return {
    selected,
    trace,
    coverage: {
      subproblem_count: coverage.subproblems.size,
      mechanism_count: coverage.mechanisms.size,
      source_domain_count: coverage.sourceDomains.size,
      challenge_aspect_count: coverage.challengeAspects.size,
      evidence_cluster_count: coverage.evidenceClusters.size
    }
  };
}

function selectionEligible(scoredCandidates = []) {
  return scoredCandidates
    .filter((entry) => !entry.hard_gate)
    .sort((left, right) => {
      if (right.utility !== left.utility) return right.utility - left.utility;
      return String(left.candidate_id).localeCompare(String(right.candidate_id));
    });
}

function tokenJaccard(left = [], right = []) {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (!leftSet.size && !rightSet.size) return 0;
  const shared = [...leftSet].filter((token) => rightSet.has(token)).length;
  return shared / Math.max(1, new Set([...leftSet, ...rightSet]).size);
}

function candidateBridgeTokens(candidate = {}) {
  return normalizeComparableList([
    ...(candidate.bridge_path_refs || []).flatMap((ref) => [ref.node_id, ref.node_type, ref.node_name]),
    ...(candidate.evidence?.graph_refs || []).flatMap((ref) => [ref.node_id, ref.node_type, ref.node_name])
  ]);
}

function candidateSimilarity(left = {}, right = {}) {
  const leftText = comparableTokens(`${left.mechanism || ''} ${left.method_summary || ''}`, 20);
  const rightText = comparableTokens(`${right.mechanism || ''} ${right.method_summary || ''}`, 20);
  const embeddingProxy = tokenJaccard(leftText, rightText);
  const sameSourceDomain = normalizeComparable(left.source_domain || left.evidence?.source_domain || '') &&
    normalizeComparable(left.source_domain || left.evidence?.source_domain || '') === normalizeComparable(right.source_domain || right.evidence?.source_domain || '')
    ? 1
    : 0;
  const mechanismOverlap = tokenJaccard(candidateMechanismTokens(left), candidateMechanismTokens(right));
  const bridgeOverlap = tokenJaccard(candidateBridgeTokens(left), candidateBridgeTokens(right));
  const targetAspectOverlap = tokenJaccard(
    comparableTokens(challengeAspectKey(left), 12),
    comparableTokens(challengeAspectKey(right), 12)
  );
  return Number((
    (0.35 * embeddingProxy)
    + (0.2 * sameSourceDomain)
    + (0.2 * mechanismOverlap)
    + (0.15 * bridgeOverlap)
    + (0.1 * targetAspectOverlap)
  ).toFixed(3));
}

function topKSelectorTrace(scoredCandidates = [], maxSelected = 3, candidateById = new Map()) {
  const eligible = selectionEligible(scoredCandidates);
  const selected = eligible.slice(0, maxSelected);
  return {
    selector: 'topk',
    k: maxSelected,
    selected: selected.map((entry, index) => ({
      candidate_id: entry.candidate_id,
      rank: index + 1,
      marginal_gain: null,
      relevance_score: entry.utility,
      redundancy_penalty: 0,
      coverage_gain: candidateCoverageKeys(entry, candidateById.get(entry.candidate_id) || {}),
      selection_reason: 'highest_controller_utility_without_diversity_ablation'
    })),
    parked_or_rejected: scoredCandidates
      .filter((entry) => !selected.some((item) => item.candidate_id === entry.candidate_id))
      .map((entry) => ({
        candidate_id: entry.candidate_id,
        reason: entry.hard_gate ? 'hard_gate' : 'not_in_topk',
        nearest_selected_candidate_id: null
      }))
  };
}

function mmrLambda(args = {}) {
  return numericSetting(
    args.mmrLambda
    ?? args.mmr_lambda
    ?? args.selector?.mmr_lambda
    ?? args.selector?.mmrLambda,
    0.68,
    { min: 0, max: 1 }
  );
}

function mmrSelectCandidates(scoredCandidates = [], maxSelected = 3, options = {}) {
  const lambda = mmrLambda(options.args || {});
  const eligible = selectionEligible(scoredCandidates);
  const candidateById = options.candidateById || new Map();
  const selected = [];
  const selectedIds = new Set();
  const trace = [];
  while (selected.length < maxSelected && selected.length < eligible.length) {
    const ranked = eligible
      .filter((entry) => !selectedIds.has(entry.candidate_id))
      .map((entry) => {
        const candidate = candidateById.get(entry.candidate_id) || {};
        let nearestSelectedCandidateId = null;
        let maxSimilarity = 0;
        for (const selectedEntry of selected) {
          const similarity = candidateSimilarity(candidate, candidateById.get(selectedEntry.candidate_id) || {});
          if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
            nearestSelectedCandidateId = selectedEntry.candidate_id;
          }
        }
        const relevance = normalizeScore(entry.utility, 0);
        const redundancyPenalty = (1 - lambda) * maxSimilarity;
        return {
          entry,
          nearestSelectedCandidateId,
          relevance,
          redundancy_penalty: Number(redundancyPenalty.toFixed(3)),
          mmr_score: Number(((lambda * relevance) - redundancyPenalty).toFixed(3)),
          coverage_gain: candidateCoverageKeys(entry, candidate)
        };
      })
      .sort((left, right) => {
        if (right.mmr_score !== left.mmr_score) return right.mmr_score - left.mmr_score;
        if (right.relevance !== left.relevance) return right.relevance - left.relevance;
        return String(left.entry.candidate_id).localeCompare(String(right.entry.candidate_id));
      });
    const best = ranked[0];
    if (!best) break;
    selected.push(best.entry);
    selectedIds.add(best.entry.candidate_id);
    trace.push({
      candidate_id: best.entry.candidate_id,
      rank: selected.length,
      marginal_gain: best.mmr_score,
      relevance_score: Number(best.relevance.toFixed(3)),
      redundancy_penalty: best.redundancy_penalty,
      coverage_gain: best.coverage_gain,
      nearest_selected_candidate_id: best.nearestSelectedCandidateId,
      selection_reason: selected.length === 1
        ? 'highest_relevance_seed'
        : 'maximal_marginal_relevance_against_selected_set'
    });
  }
  return {
    selected,
    trace,
    lambda
  };
}

function selectionFeatureUniverse(scoredCandidates = [], candidateById = new Map()) {
  const featureSets = {
    subproblems: new Set(),
    mechanisms: new Set(),
    source_domains: new Set(),
    challenge_aspects: new Set(),
    evidence_clusters: new Set()
  };
  for (const entry of scoredCandidates) {
    const keys = candidateCoverageKeys(entry, candidateById.get(entry.candidate_id) || {});
    if (keys.subproblem) featureSets.subproblems.add(keys.subproblem);
    if (keys.mechanism) featureSets.mechanisms.add(keys.mechanism);
    if (keys.source_domain) featureSets.source_domains.add(keys.source_domain);
    if (keys.challenge_aspect) featureSets.challenge_aspects.add(keys.challenge_aspect);
    if (keys.evidence_cluster) featureSets.evidence_clusters.add(keys.evidence_cluster);
  }
  return Object.fromEntries(Object.entries(featureSets).map(([key, value]) => [key, [...value].sort()]));
}

function selectorAblationTrace(scoredCandidates = [], maxSelected = 3, options = {}) {
  const candidateById = options.candidateById || new Map();
  const topk = topKSelectorTrace(scoredCandidates, maxSelected, candidateById);
  const mmr = mmrSelectCandidates(scoredCandidates, maxSelected, options);
  const greedy = options.greedyResult || { selected: [], trace: [], coverage: {} };
  return {
    record_type: 'selection_trace',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    trace_id: `selection-trace:${stableHash(`${options.state?.project || ''}:${options.state?.task_id || ''}:${nowIso()}`, 16)}`,
    project: options.state?.project || null,
    round_id: `round:${options.state?.current_round ?? 0}`,
    selector: 'greedy_submodular',
    k: maxSelected,
    hard_gates: ['judge_reject', 'risk>=0.85_and_feasibility<0.35', 'far_source_requires_mechanism_fit_or_bridge_evidence'],
    feature_universe: selectionFeatureUniverse(scoredCandidates, candidateById),
    selectors: [
      topk,
      {
        selector: 'mmr',
        k: maxSelected,
        lambda: mmr.lambda,
        selected: mmr.trace,
        parked_or_rejected: scoredCandidates
          .filter((entry) => !mmr.selected.some((item) => item.candidate_id === entry.candidate_id))
          .map((entry) => ({
            candidate_id: entry.candidate_id,
            reason: entry.hard_gate ? 'hard_gate' : 'not_selected_by_mmr',
            nearest_selected_candidate_id: nearestSelectedCandidateId(entry, mmr.selected, candidateById)
          }))
      },
      {
        selector: 'greedy_submodular',
        k: maxSelected,
        selected: (greedy.trace || []).map((entry) => ({
          candidate_id: entry.candidate_id,
          rank: entry.rank,
          marginal_gain: entry.marginal_gain,
          relevance_score: entry.utility,
          redundancy_penalty: entry.relation_penalty,
          coverage_gain: entry.coverage_keys || null,
          selection_reason: (entry.reasons || []).join('; ')
        })),
        parked_or_rejected: scoredCandidates
          .filter((entry) => !greedy.selected.some((item) => item.candidate_id === entry.candidate_id))
          .map((entry) => ({
            candidate_id: entry.candidate_id,
            reason: entry.hard_gate ? 'hard_gate' : 'not_selected_by_greedy_submodular',
            nearest_selected_candidate_id: nearestSelectedCandidateId(entry, greedy.selected, candidateById)
          }))
      }
    ],
    ablation_summary: {
      topk_selected_candidate_ids: topk.selected.map((entry) => entry.candidate_id),
      mmr_selected_candidate_ids: mmr.selected.map((entry) => entry.candidate_id),
      greedy_submodular_selected_candidate_ids: (greedy.selected || []).map((entry) => entry.candidate_id)
    },
    limitations: [
      'MMR uses deterministic token-overlap similarity because no embedding service is invoked in the MVP controller path.',
      'Selector ablations are audit traces for comparison, not independent evidence that a candidate is novel or effective.'
    ],
    generatedAt: nowIso()
  };
}

function nearestSelectedCandidateId(entry = {}, selected = [], candidateById = new Map()) {
  const candidate = candidateById.get(entry.candidate_id) || {};
  let nearest = null;
  let bestSimilarity = 0;
  for (const selectedEntry of selected || []) {
    const similarity = candidateSimilarity(candidate, candidateById.get(selectedEntry.candidate_id) || {});
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      nearest = selectedEntry.candidate_id;
    }
  }
  return nearest;
}

function candidateProxyReward(entry = {}, candidate = {}) {
  const evidenceContractPass = normalizeScore(entry.scores?.evidence_support, 0) >= 0.45 ? 1 : 0;
  const humanOrJudgeUsefulness = normalizeScore(entry.utility, 0);
  const challengeAlignment = normalizeScore(entry.scores?.mechanism_fit, 0.35);
  const diversityGain = challengeAspectKey(candidate) || evidenceClusterKey(candidate) ? 0.5 : 0.2;
  const noveltyProxy = normalizeScore(entry.scores?.novelty_potential, 0.25);
  const feasibility = normalizeScore(entry.scores?.feasibility, 0.35);
  const unsupportedBridgeClaim = entry.far_source_gate?.blocked ? 1 : 0;
  const evidenceMismatch = entry.needs_evidence ? 0.4 : 0;
  const ocrNoise = candidate.evidence?.source?.source_provider === 'ocr' ? 0.2 : 0;
  const reward = Math.max(0, Math.min(1,
    (0.35 * evidenceContractPass)
    + (0.2 * humanOrJudgeUsefulness)
    + (0.15 * challengeAlignment)
    + (0.1 * diversityGain)
    + (0.1 * noveltyProxy)
    + (0.1 * feasibility)
    - (0.3 * unsupportedBridgeClaim)
    - (0.2 * evidenceMismatch)
    - (0.1 * ocrNoise)
  ));
  return Number(reward.toFixed(3));
}

function addBanditArm(arms = new Map(), armType = '', key = '', entry = {}, candidate = {}, selectedIds = new Set()) {
  const normalizedKey = normalizeComparable(key);
  if (!normalizedKey) return;
  const armId = `${armType}:${normalizedKey}`;
  const arm = arms.get(armId) || {
    arm_id: armId,
    arm_type: armType,
    key: normalizedKey,
    pulls: 0,
    successes: 0,
    failures: 0,
    reward_sum: 0,
    selected_count: 0,
    candidate_ids: []
  };
  const reward = candidateProxyReward(entry, candidate);
  arm.pulls += 1;
  arm.successes += reward >= 0.55 ? 1 : 0;
  arm.failures += reward < 0.55 ? 1 : 0;
  arm.reward_sum += reward;
  arm.selected_count += selectedIds.has(entry.candidate_id) ? 1 : 0;
  arm.candidate_ids.push(entry.candidate_id);
  arms.set(armId, arm);
}

function offlineBanditSimulation(scoredCandidates = [], candidateById = new Map(), selectedIds = new Set(), state = {}) {
  const arms = new Map();
  for (const entry of scoredCandidates) {
    const candidate = candidateById.get(entry.candidate_id) || {};
    addBanditArm(arms, 'source_domain', candidate.source_domain || candidate.evidence?.source_domain || state.target_domain || '', entry, candidate, selectedIds);
    const mechanismKey = candidateMechanismTokens(candidate).slice(0, 4).join(' ') || candidate.mechanism || '';
    addBanditArm(arms, 'mechanism', mechanismKey, entry, candidate, selectedIds);
  }
  const totalPulls = [...arms.values()].reduce((sum, arm) => sum + arm.pulls, 0);
  const finalizedArms = [...arms.values()].map((arm) => {
    const meanReward = arm.reward_sum / Math.max(1, arm.pulls);
    const uncertainty = Math.sqrt(Math.max(0, meanReward * (1 - meanReward)) / Math.max(1, arm.pulls));
    const ucbIndex = meanReward + Math.sqrt((2 * Math.log(Math.max(2, totalPulls))) / Math.max(1, arm.pulls));
    const thompsonMean = (arm.successes + 1) / (arm.pulls + 2);
    return {
      ...arm,
      reward_sum: Number(arm.reward_sum.toFixed(3)),
      mean_reward: Number(meanReward.toFixed(3)),
      uncertainty: Number(uncertainty.toFixed(3)),
      ucb_index: Number(ucbIndex.toFixed(3)),
      thompson_mean_proxy: Number(thompsonMean.toFixed(3)),
      last_selected_round: arm.selected_count ? `round:${state.current_round ?? 0}` : null,
      candidate_ids: unique(arm.candidate_ids).slice(0, 20)
    };
  }).sort((left, right) => {
    if (right.ucb_index !== left.ucb_index) return right.ucb_index - left.ucb_index;
    return left.arm_id.localeCompare(right.arm_id);
  });
  return {
    record_type: 'bandit_state_summary',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    policy: 'offline_proxy_ucb_thompson_mvp',
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    reward_definition: {
      evidence_contract_pass: 0.35,
      human_or_judge_usefulness: 0.2,
      challenge_alignment: 0.15,
      diversity_gain: 0.1,
      novelty_proxy: 0.1,
      feasibility: 0.1,
      unsupported_claim_penalty: -0.3,
      evidence_mismatch_penalty: -0.2,
      ocr_noise_penalty: -0.1
    },
    arms: finalizedArms,
    top_ucb_arms: finalizedArms.slice(0, 10).map((arm) => ({
      arm_id: arm.arm_id,
      ucb_index: arm.ucb_index,
      mean_reward: arm.mean_reward,
      uncertainty: arm.uncertainty
    })),
    top_thompson_arms: [...finalizedArms]
      .sort((left, right) => {
        if (right.thompson_mean_proxy !== left.thompson_mean_proxy) return right.thompson_mean_proxy - left.thompson_mean_proxy;
        return left.arm_id.localeCompare(right.arm_id);
      })
      .slice(0, 10)
      .map((arm) => ({
        arm_id: arm.arm_id,
        thompson_mean_proxy: arm.thompson_mean_proxy,
        pulls: arm.pulls,
        successes: arm.successes
      })),
    limitations: [
      'Offline rewards are proxy controller diagnostics derived from graph/judge artifacts, not human novelty ratings or experiment outcomes.',
      'Use this summary to choose future exploration budgets only after live traces are validated.'
    ],
    generatedAt: nowIso()
  };
}

function buildSelectedSubgraphs(overlay = {}, state = {}, args = {}) {
  const candidates = overlay.candidateGraph?.nodes || [];
  const edges = overlay.candidateGraph?.edges || [];
  const nodeDecisionById = latestDecisionByTarget(overlay.judgeDecisions || [], 'candidate_node');
  const edgeDecisionById = latestDecisionByTarget(overlay.judgeDecisions || [], 'candidate_edge');
  const pairwiseByCandidateId = pairwisePreferenceSummary(overlay.judgeDecisions || []);
  const posterior = duelingPosteriorSummary(candidates, overlay.judgeDecisions || [], pairwiseByCandidateId);
  const scoredCandidates = candidates.map((candidate) => (
      scoreCandidateForSelection(
        candidate,
        nodeDecisionById.get(candidate.candidate_id),
        pairwiseByCandidateId.get(candidate.candidate_id),
        state,
        posterior.candidate_values?.[candidate.candidate_id] || null
      )
  ));
  const maxSelected = selectionBatchLimit(args, state);
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const selectionResult = greedySelectCandidates(scoredCandidates, maxSelected, {
    candidateById,
    edges,
    edgeDecisionById
  });
  const selected = selectionResult.selected;
  const selectedIds = new Set(selected.map((entry) => entry.candidate_id));
  const selectionTrace = selectorAblationTrace(scoredCandidates, maxSelected, {
    args,
    candidateById,
    greedyResult: selectionResult,
    state
  });
  const banditStateSummary = offlineBanditSimulation(scoredCandidates, candidateById, selectedIds, state);
  const selectedEdges = candidateEdgesForSelection(edges, selectedIds, edgeDecisionById);
  const selectedEdgeByCandidate = new Map();
  for (const edge of selectedEdges) {
    for (const candidateId of [edge.source_candidate_id, edge.target_candidate_id]) {
      const list = selectedEdgeByCandidate.get(candidateId) || [];
      list.push(edge);
      selectedEdgeByCandidate.set(candidateId, list);
    }
  }
  const subgraphs = selected.map((entry, index) => {
    const candidate = candidateById.get(entry.candidate_id) || {};
    const connectedEdges = selectedEdgeByCandidate.get(entry.candidate_id) || [];
    return {
      subgraph_id: `selected-subgraph:${stableHash(`${state.project || ''}:${state.task_id || ''}:${entry.candidate_id}`, 18)}`,
      rank: index + 1,
      primary_candidate_id: entry.candidate_id,
      candidate_ids: [entry.candidate_id],
      edge_ids: connectedEdges.map((edge) => edge.edge_id),
      subproblems: [candidate.subproblem].filter(Boolean),
      utility: entry.utility,
      marginal_gain: entry.marginal_gain,
      selection_score: entry.selection_score,
      verdict: entry.verdict,
      selected_for: entry.needs_evidence ? 'evidence_expansion' : 'solution_composition',
      selection_rationale: truncate(entry.rationale || 'Selected by controller utility and subproblem coverage.', 500),
      selection_reasons: entry.selection_reasons || [],
      missing_evidence: entry.missing_evidence,
      pairwise_preference: entry.pairwise_preference,
      posterior: entry.posterior,
      evidence_refs: {
        judge_decision_id: nodeDecisionById.get(entry.candidate_id)?.decision_id || null,
        graph_refs: candidate.evidence?.graph_refs || [],
        connected_edges: connectedEdges
      },
      candidate_summary: {
        search_state_id: candidate.search_state_id || candidate.evidence?.search_state_id || null,
        mechanism: candidate.mechanism || null,
        method_summary: candidate.method_summary || null,
        evaluation_plan: candidate.evaluation_plan || null
      }
    };
  });
  const rejected = scoredCandidates
    .filter((entry) => (entry.hard_gate && !entry.far_source_gate?.blocked) || entry.verdict === 'reject')
    .map((entry) => ({
      candidate_id: entry.candidate_id,
      verdict: entry.verdict,
      utility: entry.utility,
      reason: entry.hard_gate ? 'hard_gate' : 'judge_reject',
      pairwise_preference: entry.pairwise_preference,
      posterior: entry.posterior
    }));
  const parked = scoredCandidates
    .filter((entry) => !selectedIds.has(entry.candidate_id) && !rejected.some((item) => item.candidate_id === entry.candidate_id))
    .map((entry) => ({
      candidate_id: entry.candidate_id,
      verdict: entry.verdict,
      utility: entry.utility,
      reason: entry.far_source_gate?.blocked
        ? entry.far_source_gate.reason
        : (entry.needs_evidence ? 'needs_evidence_or_lower_priority' : 'lower_priority'),
      pairwise_preference: entry.pairwise_preference,
      posterior: entry.posterior,
      far_source_gate: entry.far_source_gate?.applies ? entry.far_source_gate : undefined
    }));
  return {
    record_type: 'selected_subgraphs',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    selection_id: `selection:${stableHash(`${state.project || ''}:${state.task_id || ''}:${nowIso()}`, 16)}`,
    selection_policy: {
      backend: 'controller_greedy_submodular_with_mmr_topk_ablation',
      max_selected_candidates: maxSelected,
      hard_gates: ['judge_reject', 'risk>=0.85_and_feasibility<0.35', 'far_source_requires_mechanism_fit_or_bridge_evidence'],
      utility_terms: ['evidence_support', 'mechanism_fit', 'feasibility', 'novelty_potential', 'agent_preference', 'evaluation_readiness', 'risk_penalty'],
      preference_aggregation: {
        backend: 'bradley_terry_mm',
        prior: 0.5,
        source: 'candidate_pairwise_preference judge decisions'
      },
      posterior_update: {
        backend: posterior.backend,
        prior: posterior.prior,
        update_status: posterior.update_status,
        selection_index: posterior.selection_index,
        candidate_count: Object.keys(posterior.candidate_values || {}).length,
        pairwise_decision_count: posterior.total_pairwise_decisions
      },
      batch_objective: {
        backend: 'greedy_submodular_marginal_gain',
        base_utility_weight: SUBMODULAR_BATCH_OBJECTIVE.base_utility_weight,
        coverage_terms: Object.keys(SUBMODULAR_BATCH_OBJECTIVE.coverage_bonus),
        positive_relation_terms: Object.keys(SUBMODULAR_BATCH_OBJECTIVE.positive_relation_weights),
        negative_relation_terms: Object.keys(SUBMODULAR_BATCH_OBJECTIVE.negative_relation_weights),
        relation_bonus_cap: SUBMODULAR_BATCH_OBJECTIVE.relation_bonus_cap,
        relation_penalty_cap: SUBMODULAR_BATCH_OBJECTIVE.relation_penalty_cap
      },
      ablation_selectors: ['topk', 'mmr', 'greedy_submodular'],
      mmr_lambda: mmrLambda(args),
      diversity_policy: 'greedy_marginal_gain_over_subproblem_mechanism_source_domain_challenge_aspect_evidence_cluster_coverage_and_candidate_relations'
    },
    subgraphs,
    parked,
    rejected,
    posterior,
    diagnostics: {
      candidate_count: candidates.length,
      judged_candidate_count: nodeDecisionById.size,
      judged_edge_count: edgeDecisionById.size,
      pairwise_preference_count: (overlay.judgeDecisions || []).filter((decision) => decision.decision_scope === 'candidate_pairwise_preference').length,
      pairwise_candidate_count: pairwiseByCandidateId.size,
      posterior_candidate_count: Object.keys(posterior.candidate_values || {}).length,
      posterior_top_candidates: (posterior.top_candidates || []).slice(0, 5),
      far_source_gated_count: scoredCandidates.filter((entry) => entry.far_source_gate?.blocked).length,
      selected_subproblem_count: selectionResult.coverage.subproblem_count,
      selected_mechanism_count: selectionResult.coverage.mechanism_count,
      selected_source_domain_count: selectionResult.coverage.source_domain_count,
      selected_challenge_aspect_count: selectionResult.coverage.challenge_aspect_count,
      selected_evidence_cluster_count: selectionResult.coverage.evidence_cluster_count,
      batch_objective_score: Number(selected.reduce((sum, entry) => sum + (entry.marginal_gain || 0), 0).toFixed(3)),
      selection_trace: selectionResult.trace
    },
    selection_trace: selectionTrace,
    bandit_state_summary: banditStateSummary,
    generatedAt: nowIso()
  };
}

function applySelectionStatuses(records = [], selectionPayload = {}) {
  const selectedIds = new Set((selectionPayload.subgraphs || []).flatMap((subgraph) => subgraph.candidate_ids || []));
  const rejectedIds = new Set((selectionPayload.rejected || []).map((entry) => entry.candidate_id));
  const parkedReasons = new Map((selectionPayload.parked || []).map((entry) => [entry.candidate_id, entry.reason]));
  return records.map((record) => {
    if (record.record_type === 'candidate_node') {
      if (selectedIds.has(record.candidate_id)) return { ...record, status: 'selected', updated_at: nowIso() };
      if (rejectedIds.has(record.candidate_id)) return { ...record, status: 'rejected', updated_at: nowIso() };
      if (parkedReasons.has(record.candidate_id)) {
        const reason = parkedReasons.get(record.candidate_id) || '';
        const status = reason.includes('needs_evidence') || reason.includes('far_source_requires')
          ? 'needs_evidence'
          : 'parked';
        return { ...record, status, updated_at: nowIso() };
      }
    }
    if (record.record_type === 'candidate_edge') {
      const bothSelected = selectedIds.has(record.source_candidate_id) && selectedIds.has(record.target_candidate_id);
      return bothSelected ? { ...record, status: 'selected', updated_at: nowIso() } : record;
    }
    return record;
  });
}

function selectedCandidateIdsFromSubgraphs(selectedSubgraphs = {}) {
  return unique((selectedSubgraphs.subgraphs || []).flatMap((subgraph) => subgraph.candidate_ids || []));
}

function candidateTitle(candidate = {}) {
  return compactText(candidate.source_papers?.[0]?.title || candidate.evidence?.source?.paper_title || candidate.evidence?.graph_refs?.[0]?.node_name);
}

function sourceMaterialRequestForCandidate(candidate = {}) {
  const source = candidate.evidence?.source || {};
  const paperId = candidate.evidence?.paper_ids?.[0] || candidate.source_papers?.[0]?.paper_id || null;
  const title = candidateTitle(candidate) || candidate.source_papers?.[0]?.title || null;
  return {
    operation: 'paper_material_view',
    candidate_id: candidate.candidate_id,
    paperId,
    sourceKey: source.source_key || null,
    paperTitle: title,
    reason: 'Extract method-card details, baseline comparability, ablations, and evidence spans for this selected candidate.'
  };
}

function seedPapersForMethodCard(card = {}) {
  const seeds = [];
  const addSeed = (seed = {}) => {
    const title = compactText(seed.title || seed.paperTitle || seed.paper_title);
    const paperId = compactText(seed.paper_id || seed.paperId || seed.canonicalId || seed.canonical_id);
    const doi = compactText(seed.doi || seed.DOI);
    const arxivId = compactText(seed.arxivId || seed.arxiv_id);
    const pmid = compactText(seed.pmid || seed.PMID);
    const sourceKey = compactText(seed.sourceKey || seed.source_key);
    if (!title && !paperId && !doi && !arxivId && !pmid && !sourceKey) return;
    seeds.push({
      ...(title ? { title } : {}),
      ...(paperId ? { canonicalId: paperId } : {}),
      ...(doi ? { doi } : {}),
      ...(arxivId ? { arxivId } : {}),
      ...(pmid ? { pmid } : {}),
      ...(sourceKey ? { sourceKey } : {})
    });
  };

  for (const paper of card.source_papers || []) addSeed(paper);
  addSeed({
    title: card.evidence?.source?.paper_title,
    paper_id: card.evidence?.paper_ids?.[0],
    source_key: card.evidence?.source?.source_key
  });

  const seen = new Set();
  return seeds.filter((seed) => {
    const key = compactText(seed.canonicalId || seed.doi || seed.arxivId || seed.pmid || seed.sourceKey || seed.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function selectedCandidateProblemText(card = {}, state = {}) {
  return compactText([
    state.target_problem,
    card.subproblem?.name ? `Subproblem: ${card.subproblem.name}` : '',
    card.subproblem?.abstract_challenge ? `Abstract challenge: ${card.subproblem.abstract_challenge}` : '',
    card.mechanism ? `Candidate mechanism: ${card.mechanism}` : '',
    card.method_summary ? `Method summary: ${card.method_summary}` : ''
  ].filter(Boolean).join('\n'));
}

function requestedMaterialOptIn(policy = {}) {
  return Boolean(
    policy.include_provider_evidence
    || policy.include_live_discovery_evidence
    || policy.include_literature_discovery
    || policy.submit_imports
    || policy.process_literature_imports
  );
}

function materialExpansionCallArgs(operation, card = {}, state = {}, policy = {}) {
  const seedPapers = seedPapersForMethodCard(card);
  const common = {
    operation,
    project: state.project || null,
    targetDomain: state.target_domain || card.evidence?.source?.domain || null,
    targetProblem: selectedCandidateProblemText(card, state),
    constraints: compactText((card.missing_evidence || []).join(', ')) || undefined
  };
  const safeDiscoveryFlags = {
    includeProviderEvidence: false,
    includeLiveDiscoveryEvidence: false,
    includeLiteratureDiscoveryEvidence: false,
    submitLiteratureDiscoveryImports: false,
    processLiteratureDiscoveryImports: false
  };

  if (operation === 'research_material_pack') {
    return {
      ...common,
      roles: 'target_prior,near_source_method,baseline_candidate,novelty_risk',
      seedPapers,
      autoDiscoverSources: false,
      ...safeDiscoveryFlags
    };
  }
  if (operation === 'negative_evidence_pack') {
    return {
      ...common,
      query: common.targetProblem,
      timeWindow: `round:${state.current_round ?? 0}`,
      seedPapers,
      ...safeDiscoveryFlags
    };
  }
  return {
    ...common,
    seedPapers,
    autoDiscoverSources: false,
    literatureDiscoveryFallbackIfSparse: false,
    runLiveIdeaCatalystIfNeeded: false,
    runLiteratureDiscoveryIfSparse: false,
    ...safeDiscoveryFlags,
    requestedOptIns: {
      includeProviderEvidence: Boolean(policy.include_provider_evidence),
      includeLiveDiscoveryEvidence: Boolean(policy.include_live_discovery_evidence),
      includeLiteratureDiscoveryEvidence: Boolean(policy.include_literature_discovery),
      submitLiteratureDiscoveryImports: Boolean(policy.submit_imports),
      processLiteratureDiscoveryImports: Boolean(policy.process_literature_imports)
    }
  };
}

function materialExpansionRequestForCard(operation, card = {}, state = {}, policy = {}) {
  const optInRequested = requestedMaterialOptIn(policy);
  const approvalRequired = operation === 'import_requisition_pack' || optInRequested;
  return {
    request_id: `mreq:${stableHash(`${state.project || ''}:${state.current_round ?? 0}:${card.candidate_id}:${operation}`, 18)}`,
    request_type: 'agent_materials_operation',
    operation,
    candidate_id: card.candidate_id,
    subgraph_id: card.subgraph_id || null,
    status: optInRequested ? 'opt_in_requested_not_executed' : (approvalRequired ? 'approval_required' : 'planned'),
    execution_status: 'not_run',
    approval_required: approvalRequired,
    safety: {
      mutates_raw_corpus_graph: false,
      provider_or_live_discovery_enabled: false,
      import_submission_enabled: false,
      human_approval_required_before_execution: approvalRequired
    },
    requested_opt_ins: {
      include_provider_evidence: Boolean(policy.include_provider_evidence),
      include_live_discovery_evidence: Boolean(policy.include_live_discovery_evidence),
      include_literature_discovery: Boolean(policy.include_literature_discovery),
      submit_imports: Boolean(policy.submit_imports),
      process_literature_imports: Boolean(policy.process_literature_imports)
    },
    arguments: materialExpansionCallArgs(operation, card, state, policy),
    reason: operation === 'research_material_pack'
      ? 'Collect a selected-candidate material pack before solution finalization.'
      : operation === 'negative_evidence_pack'
        ? 'Search for missing or contradicting evidence around the selected candidate.'
        : 'Prepare an import/source requisition plan without submitting imports by default.',
    generatedAt: nowIso()
  };
}

function materialExpansionRequestsForMethodCards(methodCards = [], state = {}, args = {}) {
  const policy = normalizeProviderPolicy(args);
  const operations = ['research_material_pack', 'negative_evidence_pack', 'import_requisition_pack'];
  return methodCards.flatMap((card) => operations.map((operation) => (
    materialExpansionRequestForCard(operation, card, state, policy)
  )));
}

function materialRequestExecutionApproval(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const approval = normalizeObject(
    args.materialRequestExecutionApproval
    || args.material_request_execution_approval
    || externalInputs.materialRequestExecutionApproval
    || externalInputs.material_request_execution_approval
  );
  const approved = booleanFlag(
    args.approveMaterialRequestExecution
    ?? args.approve_material_request_execution
    ?? externalInputs.approveMaterialRequestExecution
    ?? externalInputs.approve_material_request_execution
    ?? approval.approved,
    false
  );
  const approvalFlag = (...keys) => {
    for (const key of keys) {
      if (args[key] !== undefined) return booleanFlag(args[key], false);
      if (externalInputs[key] !== undefined) return booleanFlag(externalInputs[key], false);
      if (approval[key] !== undefined) return booleanFlag(approval[key], false);
    }
    return false;
  };
  const allowProviderMaterialOptIns = approvalFlag('allowProviderMaterialOptIns', 'allow_provider_material_opt_ins');
  return {
    approved,
    approver: compactText(approval.approver || approval.actor || args.actor) || null,
    source: approved ? (compactText(approval.source || args.actor) || 'explicit_controller_argument') : null,
    note: compactText(approval.note || args.note) || null,
    approved_at: approved ? nowIso() : null,
    allow_provider_evidence: allowProviderMaterialOptIns || approvalFlag('allowProviderEvidence', 'allow_provider_evidence'),
    allow_live_discovery_evidence: allowProviderMaterialOptIns || approvalFlag('allowLiveDiscoveryEvidence', 'allow_live_discovery_evidence'),
    allow_literature_discovery: allowProviderMaterialOptIns || approvalFlag('allowLiteratureDiscoveryEvidence', 'allow_literature_discovery_evidence', 'allowLiteratureDiscovery', 'allow_literature_discovery'),
    allow_import_submission: approvalFlag('allowImportSubmission', 'allow_import_submission'),
    allow_import_processing: approvalFlag('allowImportProcessing', 'allow_import_processing')
  };
}

function approvedMaterialRequestIds(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  return new Set(normalizeStringArray(
    args.approvedMaterialRequestIds
    || args.approved_material_request_ids
    || externalInputs.approvedMaterialRequestIds
    || externalInputs.approved_material_request_ids
    || args.materialRequestIds
    || args.material_request_ids
  ));
}

function maxMaterialRequestsToExecute(args = {}, state = {}) {
  const budget = normalizeObject(args.budget);
  return boundedInteger(
    args.maxMaterialRequests
    ?? args.max_material_requests
    ?? budget.max_material_requests
    ?? budget.maxMaterialRequests,
    Math.min(3, Math.max(1, state.budget?.max_selected_candidates || 3)),
    { min: 1, max: 20 }
  );
}

function materialRequestOptIns(request = {}) {
  const args = normalizeObject(request.arguments);
  const requested = normalizeObject(request.requested_opt_ins || request.requestedOptIns);
  const nestedRequested = normalizeObject(args.requestedOptIns || args.requested_opt_ins);
  return {
    include_provider_evidence: Boolean(
      requested.include_provider_evidence
      || requested.includeProviderEvidence
      || nestedRequested.includeProviderEvidence
      || nestedRequested.include_provider_evidence
      || booleanFlag(args.includeProviderEvidence, false)
    ),
    include_live_discovery_evidence: Boolean(
      requested.include_live_discovery_evidence
      || requested.includeLiveDiscoveryEvidence
      || nestedRequested.includeLiveDiscoveryEvidence
      || nestedRequested.include_live_discovery_evidence
      || booleanFlag(args.includeLiveDiscoveryEvidence, false)
    ),
    include_literature_discovery: Boolean(
      requested.include_literature_discovery
      || requested.includeLiteratureDiscoveryEvidence
      || requested.include_literature_discovery_evidence
      || nestedRequested.includeLiteratureDiscoveryEvidence
      || nestedRequested.include_literature_discovery
      || booleanFlag(args.includeLiteratureDiscoveryEvidence, false)
    ),
    submit_imports: Boolean(
      requested.submit_imports
      || requested.submitLiteratureDiscoveryImports
      || nestedRequested.submitLiteratureDiscoveryImports
      || nestedRequested.submit_imports
      || booleanFlag(args.submitLiteratureDiscoveryImports, false)
    ),
    process_literature_imports: Boolean(
      requested.process_literature_imports
      || requested.processLiteratureDiscoveryImports
      || nestedRequested.processLiteratureDiscoveryImports
      || nestedRequested.process_literature_imports
      || booleanFlag(args.processLiteratureDiscoveryImports, false)
    )
  };
}

function materialRequestHasOptIns(request = {}) {
  return Object.values(materialRequestOptIns(request)).some(Boolean);
}

function materialRequestExecutionCapability(request = {}, approval = {}) {
  const optIns = materialRequestOptIns(request);
  const missingApprovals = [];
  if (optIns.include_provider_evidence && !approval.allow_provider_evidence) missingApprovals.push('provider_evidence');
  if (optIns.include_live_discovery_evidence && !approval.allow_live_discovery_evidence) missingApprovals.push('live_discovery_evidence');
  if (optIns.include_literature_discovery && !approval.allow_literature_discovery) missingApprovals.push('literature_discovery_evidence');
  if (optIns.submit_imports && !approval.allow_import_submission) missingApprovals.push('import_submission');
  if (optIns.process_literature_imports && !approval.allow_import_processing) missingApprovals.push('import_processing');
  if (missingApprovals.length) {
    return {
      ok: false,
      reason: `requested_opt_ins_require_explicit_approval:${missingApprovals.join(',')}`,
      opt_ins: optIns
    };
  }
  return { ok: true, reason: 'approved', opt_ins: optIns };
}

function requestHasSafeMaterialArguments(request = {}) {
  const args = normalizeObject(request.arguments);
  return !(
    booleanFlag(args.includeProviderEvidence, false)
    || booleanFlag(args.includeLiveDiscoveryEvidence, false)
    || booleanFlag(args.includeLiteratureDiscoveryEvidence, false)
    || booleanFlag(args.submitLiteratureDiscoveryImports, false)
    || booleanFlag(args.processLiteratureDiscoveryImports, false)
  );
}

function executableMaterialRequests(requests = [], args = {}, state = {}, approval = materialRequestExecutionApproval(args)) {
  const approvedIds = approvedMaterialRequestIds(args);
  const explicitIds = approvedIds.size > 0;
  const limit = maxMaterialRequestsToExecute(args, state);
  const allowedOperations = new Set(['research_material_pack', 'negative_evidence_pack', 'import_requisition_pack']);
  const selected = [];
  const skipped = [];
  for (const request of requests) {
    const requestId = compactText(request.request_id || request.requestId);
    const operation = compactText(request.operation);
    if (!requestId) {
      skipped.push({ request_id: null, operation, reason: 'missing_request_id' });
      continue;
    }
    if (explicitIds && !approvedIds.has(requestId)) continue;
    if (request.execution_status && !['not_run', 'planned'].includes(request.execution_status)) {
      skipped.push({ request_id: requestId, operation, reason: `already_${request.execution_status}` });
      continue;
    }
    if (!allowedOperations.has(operation)) {
      skipped.push({ request_id: requestId, operation, reason: 'unsupported_operation' });
      continue;
    }
    const capability = materialRequestExecutionCapability(request, approval);
    if (!capability.ok) {
      skipped.push({ request_id: requestId, operation, reason: capability.reason, requested_opt_ins: capability.opt_ins });
      continue;
    }
    if (!requestHasSafeMaterialArguments(request) && !materialRequestHasOptIns(request)) {
      skipped.push({ request_id: requestId, operation, reason: 'unsafe_provider_or_import_flags_without_request_metadata' });
      continue;
    }
    if (selected.length >= limit) {
      skipped.push({ request_id: requestId, operation, reason: 'execution_limit_reached' });
      continue;
    }
    selected.push(request);
  }
  return { selected, skipped, limit };
}

function safeMaterialOperationArgs(request = {}, state = {}, approval = {}) {
  const optIns = materialRequestOptIns(request);
  return {
    ...normalizeObject(request.arguments),
    operation: request.operation,
    project: normalizeObject(request.arguments).project || state.project || null,
    includeProviderEvidence: Boolean(optIns.include_provider_evidence && approval.allow_provider_evidence),
    includeLiveDiscoveryEvidence: Boolean(optIns.include_live_discovery_evidence && approval.allow_live_discovery_evidence),
    includeLiteratureDiscoveryEvidence: Boolean(optIns.include_literature_discovery && approval.allow_literature_discovery),
    submitLiteratureDiscoveryImports: Boolean(optIns.submit_imports && approval.allow_import_submission),
    processLiteratureDiscoveryImports: Boolean(optIns.process_literature_imports && approval.allow_import_processing),
    requestedOptIns: optIns,
    executionApproval: {
      source: approval.source || null,
      approver: approval.approver || null,
      allowProviderEvidence: Boolean(approval.allow_provider_evidence),
      allowLiveDiscoveryEvidence: Boolean(approval.allow_live_discovery_evidence),
      allowLiteratureDiscoveryEvidence: Boolean(approval.allow_literature_discovery),
      allowImportSubmission: Boolean(approval.allow_import_submission),
      allowImportProcessing: Boolean(approval.allow_import_processing)
    }
  };
}

function materialExecutionSummary(operation, payload = {}) {
  if (operation === 'research_material_pack') {
    return {
      group_count: payload.groups?.length || 0,
      missing_material_count: payload.missing_materials?.length || 0,
      negative_evidence_count: payload.negative_evidence?.items?.length || payload.negative_evidence?.length || 0,
      import_requisition_count: payload.import_requisitions?.length || 0
    };
  }
  if (operation === 'negative_evidence_pack') {
    return {
      negative_evidence_count: payload.negative_evidence?.items?.length || payload.negative_evidence?.length || 0,
      query_count: payload.queries?.length || payload.generated_queries?.length || 0
    };
  }
  if (operation === 'import_requisition_pack') {
    return {
      import_requisition_count: payload.import_requisitions?.length || 0,
      candidate_count: payload.candidates?.length || 0,
      submitted_import_count: 0
    };
  }
  return { operation };
}

function materialResultFromExecution(request = {}, payload = {}, approval = {}) {
  return {
    request_id: request.request_id,
    request_type: request.request_type || 'agent_materials_operation',
    operation: request.operation,
    candidate_id: request.candidate_id || null,
    status: 'ok',
    source: 'research_controller.execute_material_requests',
    summary: {
      ...materialExecutionSummary(request.operation, payload),
      approval_source: approval.source || null,
      approval_approver: approval.approver || null,
      executed_opt_ins: materialRequestOptIns(request)
    },
    artifact_paths: payload.exports || payload.artifact_paths || {},
    payload,
    result_payload: payload
  };
}

function materialResultFromExecutionFailure(request = {}, error) {
  return {
    request_id: request.request_id,
    request_type: request.request_type || 'agent_materials_operation',
    operation: request.operation,
    candidate_id: request.candidate_id || null,
    status: 'failed',
    source: 'research_controller.execute_material_requests',
    summary: {
      error: error?.message || String(error || 'unknown material request execution error')
    },
    artifact_paths: {},
    payload: {},
    result_payload: {}
  };
}

function externalMaterialExpansionResults(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = externalInputs.material_expansion_results
    || externalInputs.materialExpansionResults
    || externalInputs.material_results
    || externalInputs.materialResults
    || args.materialExpansionResults
    || args.material_expansion_results
    || args.materialResults
    || args.material_results;
  if (!payload) return [];
  const objectPayload = normalizeObject(payload);
  return asArray(objectPayload.results || objectPayload.material_expansion_results || payload);
}

function materialResultStatus(value = '') {
  const status = compactText(value || 'ok').toLowerCase().replace(/[-\s]+/g, '_');
  if (['ok', 'success', 'completed', 'recorded'].includes(status)) return 'ok';
  if (['failed', 'failure', 'error'].includes(status)) return 'failed';
  if (['skipped', 'not_found', 'unavailable'].includes(status)) return 'skipped';
  return status || 'ok';
}

function normalizeMaterialExpansionResult(raw = {}, state = {}) {
  const payload = normalizeObject(raw);
  const nested = normalizeObject(payload.result || payload.payload || payload.material_pack || payload.pack);
  const requestId = compactText(payload.request_id || payload.requestId || nested.request_id || nested.requestId);
  const requestType = compactText(payload.request_type || payload.requestType || nested.request_type || nested.requestType);
  const operation = compactText(payload.operation || payload.material_operation || payload.materialOperation || nested.operation);
  const candidateId = compactText(payload.candidate_id || payload.candidateId || nested.candidate_id || nested.candidateId);
  const solutionId = compactText(payload.solution_id || payload.solutionId || nested.solution_id || nested.solutionId);
  const reviewId = compactText(payload.review_id || payload.reviewId || nested.review_id || nested.reviewId);
  const status = materialResultStatus(payload.status || nested.status || 'ok');
  const summary = normalizeObject(payload.summary || nested.summary);
  const artifactPaths = normalizeObject(payload.artifact_paths || payload.artifactPaths || nested.artifact_paths || nested.artifactPaths);
  const resultId = compactText(payload.result_id || payload.resultId) || `mres:${stableHash(`${state.project || ''}:${requestId}:${candidateId}:${solutionId}:${reviewId}:${operation}:${status}:${JSON.stringify(summary)}`, 20)}`;
  return {
    record_type: 'material_expansion_result',
    result_id: resultId,
    request_id: requestId || null,
    request_type: requestType || null,
    candidate_id: candidateId || null,
    solution_id: solutionId || null,
    review_id: reviewId || null,
    operation: operation || null,
    status,
    source: compactText(payload.source || payload.generated_by || payload.generatedBy) || 'external_agent_result',
    model: compactText(payload.model || payload.judge_model || payload.judgeModel) || null,
    summary,
    artifact_paths: artifactPaths,
    evidence_refs: normalizeObject(payload.evidence_refs || payload.evidenceRefs || nested.evidence_refs || nested.evidenceRefs),
    missing_evidence_resolved: normalizeStringArray(payload.missing_evidence_resolved || payload.missingEvidenceResolved || nested.missing_evidence_resolved),
    remaining_missing_evidence: normalizeStringArray(payload.remaining_missing_evidence || payload.remainingMissingEvidence || nested.remaining_missing_evidence),
    result_payload: nested,
    recorded_at: nowIso()
  };
}

function materialResultKey(record = {}) {
  return record.result_id
    || record.request_id
    || `${record.candidate_id || ''}:${record.operation || ''}:${stableHash(JSON.stringify(record.summary || {}), 12)}`;
}

function mergeMaterialExpansionResults(existingRecords = [], nextRecords = []) {
  const byKey = new Map();
  for (const record of existingRecords) byKey.set(materialResultKey(record), record);
  for (const record of nextRecords) byKey.set(materialResultKey(record), record);
  return [...byKey.values()].sort((left, right) => materialResultKey(left).localeCompare(materialResultKey(right)));
}

function materialRequestLookupKey(record = {}) {
  return compactText(record.request_id || record.requestId)
    || `${compactText(record.candidate_id || record.candidateId)}:${compactText(record.operation)}`;
}

function materialRequestStatusFromResult(result = {}) {
  if (result.status === 'failed') return 'result_failed';
  if (result.status === 'skipped') return 'result_skipped';
  return 'result_recorded';
}

function materialResultsByRequest(resultRecords = []) {
  const resultByRequest = new Map();
  for (const result of resultRecords) {
    const key = materialRequestLookupKey(result);
    if (key) resultByRequest.set(key, result);
  }
  return resultByRequest;
}

function applyMaterialResultsToRequests(requests = [], resultRecords = []) {
  const resultByRequest = materialResultsByRequest(resultRecords);
  const updatedRequests = requests.map((request) => {
    const result = resultByRequest.get(materialRequestLookupKey(request));
    if (!result) return request;
    return {
      ...request,
      status: materialRequestStatusFromResult(result),
      execution_status: result.source === 'research_controller.execute_material_requests' ? 'executed' : 'recorded',
      result_id: result.result_id,
      result_status: result.status,
      result_summary: result.summary,
      result_artifact_paths: result.artifact_paths,
      updated_at: nowIso()
    };
  });
  const fulfilled = updatedRequests.filter((request) => request.result_id).length;
  return {
    requests: updatedRequests,
    fulfilled,
    resultByRequest
  };
}

function applyMaterialResultsToMethodCardPack(methodCardPack = {}, resultRecords = []) {
  const applied = applyMaterialResultsToRequests(methodCardPack.material_expansion_requests || [], resultRecords);
  return {
    ...methodCardPack,
    material_expansion_requests: applied.requests,
    material_result_count: resultRecords.length,
    fulfilled_material_expansion_request_count: applied.fulfilled,
    updatedAt: nowIso()
  };
}

function applyMaterialResultsToDesignReview(designReview = null, resultRecords = []) {
  if (!designReview) return null;
  const applied = applyMaterialResultsToRequests(designReview.closest_prior_expansion_requests || [], resultRecords);
  const requestById = new Map(applied.requests.map((request) => [request.request_id, request]));
  const reviews = (designReview.reviews || []).map((review) => {
    const requestIds = normalizeStringArray(review.closest_prior_request_ids || []);
    const linkedResults = requestIds
      .map((requestId) => applied.resultByRequest.get(requestId))
      .filter(Boolean);
    const linkedRequests = requestIds
      .map((requestId) => requestById.get(requestId))
      .filter(Boolean);
    return {
      ...review,
      closest_prior_result_ids: linkedResults.map((result) => result.result_id),
      closest_prior_material_result_count: linkedResults.length,
      closest_prior_expansion_status: linkedResults.length
        ? 'external_results_recorded'
        : (linkedRequests.length ? 'planned_not_executed' : (review.closest_prior_expansion_status || 'no_request'))
    };
  });
  return {
    ...designReview,
    reviews,
    closest_prior_expansion_requests: applied.requests,
    closest_prior_result_count: applied.fulfilled,
    fulfilled_closest_prior_expansion_request_count: applied.fulfilled,
    updatedAt: nowIso()
  };
}

function selectedSubgraphsWithMaterialResults(selectedSubgraphs = {}, methodCardPack = {}, resultRecords = []) {
  const resultCountsByCandidate = new Map();
  for (const result of resultRecords) {
    if (!result.candidate_id) continue;
    resultCountsByCandidate.set(result.candidate_id, (resultCountsByCandidate.get(result.candidate_id) || 0) + 1);
  }
  return {
    ...selectedSubgraphs,
    method_card_pack: methodCardPack,
    subgraphs: (selectedSubgraphs.subgraphs || []).map((subgraph) => {
      const materialResultCount = (subgraph.candidate_ids || []).reduce((sum, candidateId) => (
        sum + (resultCountsByCandidate.get(candidateId) || 0)
      ), 0);
      return {
        ...subgraph,
        evidence_expansion: {
          ...(subgraph.evidence_expansion || {}),
          material_result_count: materialResultCount,
          material_results_status: materialResultCount ? 'external_results_recorded' : (subgraph.evidence_expansion?.status || 'no_external_results')
        }
      };
    })
  };
}

function textSourcePath(candidate = {}) {
  const sourcePath = compactText(candidate.evidence?.source?.source_path);
  if (!sourcePath || /\.(pdf|png|jpg|jpeg|webp)$/i.test(sourcePath)) return '';
  return sourcePath;
}

function paragraphMatchesCandidate(paragraph = '', candidate = {}) {
  const normalized = normalizeComparable(paragraph);
  if (!normalized) return false;
  const tokens = unique([
    ...candidateMechanismTokens(candidate),
    ...comparableTokens(candidate.subproblem?.name || '', 4),
    ...comparableTokens(candidate.method_summary || '', 6)
  ]);
  return tokens.some((token) => normalized.includes(token));
}

async function sourceSpansForCandidate(candidate = {}, limit = 3) {
  const sourcePath = textSourcePath(candidate);
  if (!sourcePath) return [];
  let text = '';
  try {
    text = await readText(sourcePath);
  } catch {
    return [];
  }
  const paragraphs = text.split(/\n{2,}/)
    .map(compactText)
    .filter((paragraph) => paragraph.length >= 40);
  const matches = paragraphs.filter((paragraph) => paragraphMatchesCandidate(paragraph, candidate));
  const costMatches = paragraphs.filter((paragraph) => allowlistedTokens(paragraph, COST_TOKEN_ALLOWLIST).length);
  const selected = unique([
    ...(matches.length ? matches : paragraphs),
    ...costMatches
  ]).slice(0, limit);
  return selected.map((paragraph, index) => ({
    source_path: sourcePath,
    source_key: candidate.evidence?.source?.source_key || null,
    span_id: `source-span:${stableHash(`${candidate.candidate_id || ''}:${sourcePath}:${index}:${paragraph}`, 16)}`,
    text: truncate(paragraph, 700),
    match_type: matches.length ? 'candidate_token_match' : 'source_preview'
  }));
}

function extractionSentences(value = '') {
  return compactText(value)
    .split(/(?:[.!?]\s+|\n+|;\s+)/)
    .map(compactText)
    .filter((sentence) => sentence.length >= 24);
}

function firstSentenceMatching(sentences = [], patterns = []) {
  return sentences.find((sentence) => patterns.some((pattern) => pattern.test(sentence))) || '';
}

function phraseFromAllowedTokens(value = '', allowlist = SIGNAL_TOKEN_ALLOWLIST, limit = 6) {
  const tokens = allowlistedTokens(value, allowlist, limit);
  return tokens.length ? tokens.join(' ') : '';
}

function localMethodCardExtraction(candidate = {}, sourceSpans = []) {
  const text = compactText([
    candidate.mechanism,
    candidate.method_summary,
    ...sourceSpans.map((span) => span.text)
  ].filter(Boolean).join('\n'));
  if (!text) return { fields: {}, extracted_fields: [] };
  const sentences = extractionSentences(text);
  const signalPhrase = phraseFromAllowedTokens(text, SIGNAL_TOKEN_ALLOWLIST, 8);
  const objectiveSentence = firstSentenceMatching(sentences, [
    /\b(objective|loss|optimi[sz]|train|learn)\b/i,
    /\buses?\b.*\b(to|for)\b/i,
    /\b(calibration|adaptation)\b.*\b(separate|assign|discover|estimate)\b/i
  ]);
  const inferenceSentence = firstSentenceMatching(sentences, [
    /\b(inference|predict|assign|separate|classif|discover|estimate)\b/i,
    /\b(calibrat|confidence|uncertainty|pseudo[-\s]?label)\b/i
  ]);
  const fields = {
    input_signal: signalPhrase ? `${signalPhrase} evidence from local paper spans` : '',
    output_signal: /known|novel|class|cluster/i.test(text)
      ? 'known/novel class assignment or separation signal'
      : (signalPhrase ? `${signalPhrase} score or representation update` : ''),
    training_objective: objectiveSentence ? truncate(objectiveSentence, 220) : '',
    inference_behavior: inferenceSentence ? truncate(inferenceSentence, 220) : '',
    assumptions: unique([
      /domain shift/i.test(text) ? 'domain shift is part of the target setting' : '',
      /prior shift|known\/novel|known and novel/i.test(text) ? 'known/novel prior structure affects the method behavior' : '',
      /class count|number of classes/i.test(text) ? 'class-count assumptions may affect evaluation' : ''
    ].map(compactText).filter(Boolean)),
    adaptable_components: unique([
      /calibration/i.test(text) ? 'confidence calibration' : '',
      /domain adaptation|adaptation/i.test(text) ? 'domain adaptation' : '',
      /pseudo[-\s]?label/i.test(text) ? 'pseudo-label filtering' : ''
    ].map(compactText).filter(Boolean)),
    cost_terms: allowlistedTokens(text, COST_TOKEN_ALLOWLIST, 12)
  };
  const extractedFields = Object.entries(fields)
    .filter(([, value]) => Array.isArray(value) ? value.length : Boolean(compactText(value)))
    .map(([key]) => key);
  return { fields, extracted_fields: extractedFields };
}

function methodCardWithLocalExtraction(candidate = {}, sourceSpans = []) {
  const methodCard = candidate.method_card || {};
  const extraction = localMethodCardExtraction(candidate, sourceSpans);
  const sourceSpanIds = sourceSpans.map((span) => span.span_id).filter(Boolean);
  const extracted = extraction.fields || {};
  const enriched = {
    ...methodCard,
    input_signal: methodCard.input_signal || extracted.input_signal || null,
    output_signal: methodCard.output_signal || extracted.output_signal || null,
    training_objective: methodCard.training_objective || extracted.training_objective || null,
    inference_behavior: methodCard.inference_behavior || extracted.inference_behavior || null,
    assumptions: unique([
      ...normalizeStringArray(methodCard.assumptions || []),
      ...(extracted.assumptions || [])
    ]),
    adaptable_components: unique([
      ...normalizeStringArray(methodCard.adaptable_components || []),
      ...(extracted.adaptable_components || [])
    ]),
    cost_terms: unique([
      ...normalizeStringArray(methodCard.cost_terms || []),
      ...(extracted.cost_terms || [])
    ])
  };
  if (extraction.extracted_fields?.length) {
    enriched.paper_material_extraction = {
      backend: 'local_source_span_heuristic',
      source_span_ids: sourceSpanIds,
      extracted_fields: extraction.extracted_fields,
      confidence: sourceSpanIds.length ? 'low_to_medium' : 'low',
      note: 'Heuristic extraction from local paper spans; treat as material evidence for review, not as verified implementation detail.'
    };
  }
  return enriched;
}

function baselineComparabilityForCandidate(candidate = {}) {
  const evaluation = candidate.evaluation_plan || {};
  const metrics = normalizeStringArray(evaluation.metrics || []);
  const hasBaseline = Boolean(compactText(evaluation.baseline));
  const hasDataset = Boolean(compactText(evaluation.dataset));
  const hasAblations = asArray(evaluation.ablations).length > 0;
  const missing = [];
  if (!metrics.length) missing.push('metric');
  if (!hasBaseline) missing.push('baseline');
  if (!hasDataset) missing.push('dataset');
  if (!hasAblations) missing.push('ablation');
  return {
    status: missing.length === 0 ? 'ready' : (metrics.length ? 'partial' : 'needs_evidence'),
    metrics,
    baseline: evaluation.baseline || null,
    dataset: evaluation.dataset || null,
    ablations: evaluation.ablations || [],
    missing
  };
}

function missingEvidenceForMethodCard(candidate = {}, subgraph = {}, sourceSpans = []) {
  const methodCard = candidate.method_card || {};
  const evaluation = baselineComparabilityForCandidate(candidate);
  return unique([
    ...(subgraph.missing_evidence || []),
    ...(evaluation.missing || []).map((item) => `${item} plan`),
    !methodCard.input_signal ? 'method input signal' : '',
    !methodCard.output_signal ? 'method output signal' : '',
    !methodCard.training_objective ? 'training objective' : '',
    !methodCard.inference_behavior ? 'inference behavior' : '',
    !sourceSpans.length ? 'paper material span' : ''
  ].map(compactText).filter(Boolean));
}

function edgeSummariesForCandidate(candidateId = '', edges = []) {
  return edges
    .filter((edge) => edge.source_candidate_id === candidateId || edge.target_candidate_id === candidateId)
    .map((edge) => ({
      edge_id: edge.edge_id,
      source_candidate_id: edge.source_candidate_id,
      target_candidate_id: edge.target_candidate_id,
      relation_types: edge.relation_types || [],
      confidence: edge.confidence ?? null,
      rationale: edge.rationale || null
    }));
}

async function methodCardEntryForCandidate(candidate = {}, subgraph = {}, edges = []) {
  const sourceSpans = unique([
    ...(candidate.evidence?.source_spans || []),
    ...(await sourceSpansForCandidate(candidate, 5))
  ]);
  const methodCard = methodCardWithLocalExtraction(candidate, sourceSpans);
  const materialCandidate = { ...candidate, method_card: methodCard };
  const baselineComparability = baselineComparabilityForCandidate(materialCandidate);
  const missingEvidence = missingEvidenceForMethodCard(materialCandidate, subgraph, sourceSpans);
  return {
    record_type: 'expanded_method_card',
    candidate_id: candidate.candidate_id,
    subgraph_id: subgraph.subgraph_id || null,
    subproblem: candidate.subproblem || null,
    mechanism: candidate.mechanism || null,
    method_summary: candidate.method_summary || null,
    source_papers: candidate.source_papers || [],
    method_card: methodCard,
    adaptation_plan: candidate.adaptation_plan || {},
    evaluation_plan: candidate.evaluation_plan || {},
    baseline_comparability: baselineComparability,
    candidate_relations: edgeSummariesForCandidate(candidate.candidate_id, edges),
    evidence: {
      graph_refs: candidate.evidence?.graph_refs || [],
      source_spans: sourceSpans,
      paper_ids: candidate.evidence?.paper_ids || [],
      source: candidate.evidence?.source || null,
      evidence_tier: candidate.evidence?.evidence_tier || 'none'
    },
    evidence_boundaries: candidate.labels || {
      evidence_supported: [],
      agent_inferred: [],
      speculative: []
    },
    paper_material_request: sourceMaterialRequestForCandidate(candidate),
    missing_evidence: missingEvidence,
    status: missingEvidence.length ? 'needs_evidence' : 'expanded',
    generated_by: 'research_controller.expand_evidence.selected_graph_materials',
    generatedAt: nowIso()
  };
}

function riskNotesFromMethodCards(methodCards = [], state = {}) {
  return methodCards
    .filter((card) => card.missing_evidence?.length)
    .map((card) => ({
      record_type: 'risk_note',
      risk_id: `risk:${stableHash(`${state.project || ''}:${state.task_id || ''}:${card.candidate_id}:${card.missing_evidence.join('|')}`, 18)}`,
      project: state.project || null,
      round_id: `round:${state.current_round ?? 0}`,
      source_artifact: 'method-card-pack',
      candidate_id: card.candidate_id,
      risk_type: 'missing_evidence',
      severity: card.baseline_comparability?.status === 'needs_evidence' ? 'high' : 'medium',
      evidence_refs: {
        graph_refs: card.evidence?.graph_refs || [],
        paper_ids: card.evidence?.paper_ids || []
      },
      missing_evidence: card.missing_evidence,
      recommended_action: 'Use paper_material_view or research_material_pack for selected candidates before treating the method as execution-ready.',
      status: 'open',
      created_at: nowIso()
    }));
}

function mergeRiskNotes(existingRecords = [], nextRecords = []) {
  const byKey = new Map();
  for (const record of existingRecords) byKey.set(record.risk_id || stableHash(JSON.stringify(record), 20), record);
  for (const record of nextRecords) byKey.set(record.risk_id || stableHash(JSON.stringify(record), 20), record);
  return [...byKey.values()].sort((left, right) => String(left.risk_id || '').localeCompare(String(right.risk_id || '')));
}

async function buildMethodCardPack(overlay = {}, state = {}, args = {}) {
  const providerPolicy = normalizeProviderPolicy(args);
  const selectedSubgraphs = overlay.selectedSubgraphs?.subgraphs || [];
  const selectedIds = new Set(selectedCandidateIdsFromSubgraphs(overlay.selectedSubgraphs || {}));
  const candidateById = new Map((overlay.candidateGraph?.nodes || []).map((candidate) => [candidate.candidate_id, candidate]));
  const selectedEdges = (overlay.candidateGraph?.edges || []).filter((edge) => (
    selectedIds.has(edge.source_candidate_id) || selectedIds.has(edge.target_candidate_id)
  ));
  const methodCards = [];
  for (const subgraph of selectedSubgraphs) {
    for (const candidateId of subgraph.candidate_ids || []) {
      const candidate = candidateById.get(candidateId);
      if (!candidate) continue;
      methodCards.push(await methodCardEntryForCandidate(candidate, subgraph, selectedEdges));
    }
  }
  const missingEvidence = unique(methodCards.flatMap((card) => card.missing_evidence || []));
  const materialExpansionRequests = materialExpansionRequestsForMethodCards(methodCards, state, args);
  return {
    record_type: 'method_card_pack',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    selected_subgraph_count: selectedSubgraphs.length,
    method_cards: methodCards,
    missing_evidence: missingEvidence,
    expansion_policy: {
      backend: 'selected_graph_materials',
      scope: 'selected_subgraphs_only',
      provider_evidence_enabled: false,
      literature_discovery_enabled: false,
      live_discovery_enabled: false,
      import_submission_enabled: false,
      provider_evidence_requested: providerPolicy.include_provider_evidence,
      live_discovery_requested: providerPolicy.include_live_discovery_evidence,
      literature_discovery_requested: providerPolicy.include_literature_discovery,
      import_submission_requested: providerPolicy.submit_imports,
      process_literature_imports_requested: providerPolicy.process_literature_imports,
      material_pack_requests_enabled: true,
      note: 'This phase uses selected candidate graph/material refs only. Deeper material operations are emitted as planned requests and are not executed by default.'
    },
    next_material_requests: methodCards.map((card) => card.paper_material_request),
    material_expansion_requests: materialExpansionRequests,
    generatedAt: nowIso()
  };
}

function selectedSubgraphsWithMethodCards(selectedSubgraphs = {}, methodCardPack = {}) {
  const cardsBySubgraph = new Map();
  for (const card of methodCardPack.method_cards || []) {
    const list = cardsBySubgraph.get(card.subgraph_id) || [];
    list.push(card);
    cardsBySubgraph.set(card.subgraph_id, list);
  }
  return {
    ...selectedSubgraphs,
    method_card_pack: methodCardPack,
    subgraphs: (selectedSubgraphs.subgraphs || []).map((subgraph) => {
      const cards = cardsBySubgraph.get(subgraph.subgraph_id) || [];
      return {
        ...subgraph,
        evidence_expansion: {
          status: cards.length ? 'expanded_graph_materials' : 'missing_selected_candidate',
          method_card_candidate_ids: cards.map((card) => card.candidate_id),
          missing_evidence: unique(cards.flatMap((card) => card.missing_evidence || []))
        }
      };
    })
  };
}

function renderMethodCardPackMarkdown(methodCardPack = {}) {
  const lines = [
    '# PaperNexus Selected Method Card Pack',
    '',
    `- Project: ${methodCardPack.project || ''}`,
    `- Round: ${methodCardPack.round_id || ''}`,
    `- Selected subgraphs: ${methodCardPack.selected_subgraph_count ?? 0}`,
    `- Method cards: ${methodCardPack.method_cards?.length ?? 0}`,
    `- Material expansion results: ${methodCardPack.material_result_count ?? 0}`,
    `- Provider evidence enabled: ${methodCardPack.expansion_policy?.provider_evidence_enabled ? 'yes' : 'no'}`,
    `- Live discovery enabled: ${methodCardPack.expansion_policy?.live_discovery_enabled ? 'yes' : 'no'}`,
    `- Literature discovery enabled: ${methodCardPack.expansion_policy?.literature_discovery_enabled ? 'yes' : 'no'}`,
    `- Import submission enabled: ${methodCardPack.expansion_policy?.import_submission_enabled ? 'yes' : 'no'}`,
    '',
    '## Selected Method Cards',
    ''
  ];
  for (const card of methodCardPack.method_cards || []) {
    lines.push(`### ${card.candidate_id}`);
    lines.push('');
    lines.push(`- Subproblem: ${card.subproblem?.name || ''}`);
    lines.push(`- Mechanism: ${card.mechanism || ''}`);
    lines.push(`- Evidence tier: ${card.evidence?.evidence_tier || 'none'}`);
    lines.push(`- Baseline comparability: ${card.baseline_comparability?.status || 'unknown'}`);
    if (card.method_summary) {
      lines.push('');
      lines.push(card.method_summary);
    }
    if (card.method_card?.paper_material_extraction) {
      lines.push('', 'Local material extraction:');
      lines.push(`- Backend: ${card.method_card.paper_material_extraction.backend}`);
      lines.push(`- Extracted fields: ${(card.method_card.paper_material_extraction.extracted_fields || []).join(', ')}`);
      if (card.method_card.input_signal) lines.push(`- Input signal: ${card.method_card.input_signal}`);
      if (card.method_card.output_signal) lines.push(`- Output signal: ${card.method_card.output_signal}`);
      if (card.method_card.training_objective) lines.push(`- Training objective: ${card.method_card.training_objective}`);
      if (card.method_card.inference_behavior) lines.push(`- Inference behavior: ${card.method_card.inference_behavior}`);
      if (card.method_card.cost_terms?.length) lines.push(`- Cost terms: ${card.method_card.cost_terms.join(', ')}`);
    }
    if (card.candidate_relations?.length) {
      lines.push('', 'Relations:');
      for (const relation of card.candidate_relations) {
        lines.push(`- ${relation.edge_id}: ${(relation.relation_types || []).join(', ')}`);
      }
    }
    if (card.evidence?.source_spans?.length) {
      lines.push('', 'Evidence spans:');
      for (const span of card.evidence.source_spans.slice(0, 3)) {
        lines.push(`- ${span.text}`);
      }
    }
    if (card.missing_evidence?.length) {
      lines.push('', 'Missing evidence:');
      for (const item of card.missing_evidence) {
        lines.push(`- ${item}`);
      }
    }
    lines.push('');
  }
  if (methodCardPack.next_material_requests?.length) {
    lines.push('## Next Material Requests', '');
    for (const request of methodCardPack.next_material_requests) {
      lines.push(`- ${request.operation}: ${request.candidate_id} ${request.paperId || request.paperTitle || ''}`.trim());
    }
  }
  if (methodCardPack.material_expansion_requests?.length) {
    lines.push('', '## Planned Material Expansion Requests', '');
    for (const request of methodCardPack.material_expansion_requests) {
      lines.push(`- ${request.operation}: ${request.candidate_id} status=${request.status} execution=${request.execution_status} approval_required=${request.approval_required ? 'yes' : 'no'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function solutionSketchLimit(args = {}, state = {}) {
  const budget = normalizeObject(args.budget);
  return boundedInteger(
    args.maxSolutionSketches ?? args.max_solution_sketches ?? budget.max_solution_sketches ?? budget.maxSolutionSketches ?? state.budget?.max_solution_sketches,
    Math.min(3, state.budget?.max_solution_sketches || 3),
    { min: 1, max: 8 }
  );
}

function methodCardsForComposition(overlay = {}) {
  const packCards = overlay.selectedSubgraphs?.method_card_pack?.method_cards || [];
  if (packCards.length) return packCards;
  const candidateById = new Map((overlay.candidateGraph?.nodes || []).map((candidate) => [candidate.candidate_id, candidate]));
  return (overlay.selectedSubgraphs?.subgraphs || []).flatMap((subgraph) => (
    (subgraph.candidate_ids || []).map((candidateId) => {
      const candidate = candidateById.get(candidateId) || {};
      return {
        record_type: 'expanded_method_card',
        candidate_id: candidateId,
        subgraph_id: subgraph.subgraph_id,
        subproblem: candidate.subproblem || subgraph.subproblems?.[0] || null,
        mechanism: candidate.mechanism || subgraph.candidate_summary?.mechanism || null,
        method_summary: candidate.method_summary || subgraph.candidate_summary?.method_summary || null,
        source_papers: candidate.source_papers || [],
        method_card: candidate.method_card || {},
        adaptation_plan: candidate.adaptation_plan || {},
        evaluation_plan: candidate.evaluation_plan || subgraph.candidate_summary?.evaluation_plan || {},
        baseline_comparability: baselineComparabilityForCandidate(candidate),
        candidate_relations: subgraph.evidence_refs?.connected_edges || [],
        evidence: candidate.evidence || { graph_refs: subgraph.evidence_refs?.graph_refs || [] },
        evidence_boundaries: candidate.labels || {},
        missing_evidence: subgraph.missing_evidence || ['method-card pack'],
        status: 'needs_evidence'
      };
    })
  ));
}

function relationEdgesForCandidates(candidateIds = [], overlay = {}) {
  const selected = new Set(candidateIds);
  return (overlay.candidateGraph?.edges || []).filter((edge) => (
    selected.has(edge.source_candidate_id) || selected.has(edge.target_candidate_id)
  ));
}

function solutionProblemClaim(state = {}, cards = []) {
  const subproblems = unique(cards.map((card) => compactText(card.subproblem?.name)).filter(Boolean));
  const targetProblemText = compactText(state.target_problem) || 'the target research task';
  return subproblems.length
    ? `Address ${subproblems.join(', ')} for ${targetProblemText}.`
    : `Address ${targetProblemText}.`;
}

function solutionCoreIdea(cards = [], relationEdges = []) {
  const mechanisms = unique(cards.map((card) => compactText(card.mechanism)).filter(Boolean));
  const relationTypes = unique(relationEdges.flatMap((edge) => edge.relation_types || edge.valid_relation_types || []));
  const mechanismText = mechanisms.length ? mechanisms.join(' + ') : 'selected graph-backed mechanisms';
  const relationText = relationTypes.length ? ` using ${relationTypes.join(', ')} relations` : '';
  return `Compose ${mechanismText}${relationText} into a bounded method variant.`;
}

function solutionModuleInterfaces(cards = []) {
  return cards.map((card, index) => ({
    module_id: `module:${index + 1}`,
    candidate_id: card.candidate_id,
    subproblem: card.subproblem?.name || null,
    input_signal: card.method_card?.input_signal || 'task data or representation features',
    output_signal: card.method_card?.output_signal || 'candidate assignment, score, or representation update',
    role: card.mechanism || card.subproblem?.name || 'selected candidate mechanism'
  }));
}

function solutionTrainingObjective(cards = []) {
  const objectives = unique(cards.map((card) => compactText(card.method_card?.training_objective)).filter(Boolean));
  return objectives.length
    ? objectives.join(' + ')
    : 'Define a training objective that preserves selected candidate mechanisms while respecting target-task design boundaries.';
}

function solutionInferenceBehavior(cards = []) {
  const behaviors = unique(cards.map((card) => compactText(card.method_card?.inference_behavior)).filter(Boolean));
  return behaviors.length
    ? behaviors.join(' + ')
    : 'Apply the composed modules to produce target-task predictions or discovery assignments without using evaluation-only labels.';
}

function solutionExpectedObservations(cards = []) {
  return unique(cards.flatMap((card) => [
    ...(card.evaluation_plan?.metrics || []),
    ...(card.baseline_comparability?.metrics || [])
  ].map(compactText).filter(Boolean))).map((metric) => `Improvement or failure signal should be visible in ${metric}.`);
}

function solutionAblations(cards = []) {
  const ablations = unique(cards.flatMap((card) => asArray(card.evaluation_plan?.ablations).map(compactText)).filter(Boolean));
  const moduleAblations = cards.map((card) => `Remove or freeze ${card.mechanism || card.candidate_id} and compare against the same baseline.`);
  return unique([...ablations, ...moduleAblations]).slice(0, 8);
}

function solutionDiscardConditions(cards = []) {
  const missing = unique(cards.flatMap((card) => card.missing_evidence || []));
  return unique([
    'Reject if it cannot be evaluated under the declared target-task metrics and fair baseline settings.',
    'Reject if it requires evaluation-only labels, test-set tuning, or hidden protocol information.',
    missing.length ? `Reject or revise if missing evidence remains unresolved: ${missing.slice(0, 5).join(', ')}.` : '',
    'Reject if the composed modules do not improve over the closest single-candidate baseline in ablation.'
  ].map(compactText).filter(Boolean));
}

function solutionEvidenceBoundaries(cards = []) {
  return {
    evidence_supported: unique(cards.flatMap((card) => card.evidence_boundaries?.evidence_supported || [])),
    agent_inferred: unique([
      ...cards.flatMap((card) => card.evidence_boundaries?.agent_inferred || []),
      'solution composition',
      'module interface synthesis',
      'expected observations'
    ]),
    speculative: unique([
      ...cards.flatMap((card) => card.evidence_boundaries?.speculative || []),
      'training objective until verified against paper materials',
      'expected gains until experimentally evaluated'
    ])
  };
}

function buildSolutionSketch(cards = [], relationEdges = [], state = {}, variantKey = 'single') {
  const sourceCandidateIds = unique(cards.map((card) => card.candidate_id).filter(Boolean));
  const sourceEdgeIds = unique(relationEdges.map((edge) => edge.edge_id).filter(Boolean));
  const missingEvidence = unique(cards.flatMap((card) => card.missing_evidence || []));
  const solutionId = `solution:${stableHash(`${state.project || ''}:${state.task_id || ''}:${variantKey}:${sourceCandidateIds.join('|')}`, 18)}`;
  return {
    record_type: 'solution_sketch',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    solution_id: solutionId,
    variant_id: `variant:${stableHash(`${solutionId}:${variantKey}`, 12)}`,
    variant_key: variantKey,
    source_candidate_ids: sourceCandidateIds,
    source_edge_ids: sourceEdgeIds,
    problem_claim: solutionProblemClaim(state, cards),
    core_idea: solutionCoreIdea(cards, relationEdges),
    algorithm_flow: [
      'Start from the selected subproblem-specific candidate mechanisms.',
      'Use candidate relations to decide whether mechanisms should be composed, compared, or kept separate.',
      'Instantiate module interfaces and preserve design-boundary checks before any experiment.',
      'Evaluate against declared metrics, baselines, ablations, and discard conditions.'
    ],
    module_interfaces: solutionModuleInterfaces(cards),
    training_objective: solutionTrainingObjective(cards),
    inference_behavior: solutionInferenceBehavior(cards),
    expected_observations: solutionExpectedObservations(cards),
    ablation_suggestions: solutionAblations(cards),
    discard_conditions: solutionDiscardConditions(cards),
    design_boundaries_checked: state.constraints?.design_boundaries || [],
    evidence_boundaries: solutionEvidenceBoundaries(cards),
    missing_evidence: missingEvidence,
    status: 'proposed',
    generated_by: 'research_controller.compose_solutions.selected_subgraphs',
    generatedAt: nowIso()
  };
}

function buildSolutionSketches(overlay = {}, state = {}, args = {}) {
  const maxSketches = solutionSketchLimit(args, state);
  const cards = methodCardsForComposition(overlay);
  const sketches = [];
  for (const card of cards) {
    if (sketches.length >= maxSketches) break;
    const edges = relationEdgesForCandidates([card.candidate_id], overlay);
    sketches.push(buildSolutionSketch([card], edges, state, `single:${card.candidate_id}`));
  }
  if (cards.length > 1 && sketches.length < maxSketches) {
    const comboCards = cards.slice(0, Math.min(cards.length, maxSketches));
    sketches.push(buildSolutionSketch(
      comboCards,
      relationEdgesForCandidates(comboCards.map((card) => card.candidate_id), overlay),
      state,
      'composed:selected_batch'
    ));
  }
  return sketches;
}

function externalSolutionPayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = externalInputs.solution_payload
    || externalInputs.solutionPayload
    || externalInputs.solution_sketch_payload
    || externalInputs.solutionSketchPayload
    || args.solutionPayload
    || args.solution_payload;
  if (Array.isArray(payload)) return { solution_sketches: payload };
  if (payload) return normalizeObject(payload);
  const sketches = externalInputs.solution_sketches
    || externalInputs.solutionSketches
    || args.solutionSketches
    || args.solution_sketches;
  return sketches ? { solution_sketches: asArray(sketches) } : null;
}

function buildSolutionCompositionRequest(overlay = {}, state = {}, fallbackSketches = []) {
  const methodCards = methodCardsForComposition(overlay);
  const candidateIds = unique(methodCards.map((card) => card.candidate_id).filter(Boolean));
  return {
    task: 'research_controller.compose_solutions',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    task_id: state.task_id || null,
    target_domain: state.target_domain || null,
    target_problem: state.target_problem || null,
    design_boundaries: state.constraints?.design_boundaries || [],
    budget: state.budget || null,
    mvp_contract: state.mvp_contract || null,
    provider_policy: state.provider_policy || null,
    judge: state.judge || null,
    selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
    method_cards: methodCards,
    candidate_relations: relationEdgesForCandidates(candidateIds, overlay),
    controller_fallback_sketches: fallbackSketches,
    output_schema: {
      solution_sketches: [{
        source_candidate_ids: ['candidate id'],
        source_edge_ids: ['edge id'],
        problem_claim: 'bounded problem statement',
        core_idea: 'method idea grounded in selected candidates',
        algorithm_flow: ['steps'],
        module_interfaces: ['module interface objects'],
        training_objective: 'string',
        inference_behavior: 'string',
        expected_observations: ['string'],
        ablation_suggestions: ['string'],
        discard_conditions: ['string'],
        evidence_boundaries: {
          evidence_supported: ['string'],
          agent_inferred: ['string'],
          speculative: ['string']
        },
        missing_evidence: ['string'],
        status: 'proposed|needs_evidence'
      }]
    }
  };
}

function buildSolutionCompositionPrompt(request = {}) {
  return [
    'You are revising PaperNexus solution sketches from selected candidate subgraphs.',
    'Return strict JSON only.',
    'Do not present a sketch as final, novel, or execution-ready.',
    'Preserve evidence-supported / agent-inferred / speculative boundaries.',
    'Every sketch must include discard conditions and ablation suggestions.',
    '',
    `Solution composition request: ${JSON.stringify(request)}`
  ].join('\n');
}

function normalizeModuleInterfaces(value) {
  return asArray(value).map((entry) => normalizeObject(entry)).filter((entry) => Object.keys(entry).length);
}

function normalizeEvidenceBoundaries(value = {}, fallback = {}) {
  const boundary = normalizeObject(value);
  const fallbackBoundary = normalizeObject(fallback);
  return {
    evidence_supported: normalizeStringArray(boundary.evidence_supported || boundary.evidenceSupported || fallbackBoundary.evidence_supported || []),
    agent_inferred: normalizeStringArray(boundary.agent_inferred || boundary.agentInferred || fallbackBoundary.agent_inferred || []),
    speculative: normalizeStringArray(boundary.speculative || fallbackBoundary.speculative || [])
  };
}

function normalizeSolutionSketchPayload(payload = {}, fallbackSketches = [], state = {}, generatedBy = 'research_controller.compose_solutions.agent_revision') {
  const normalized = normalizeObject(payload);
  const entries = asArray(normalized.solution_sketches || normalized.solutionSketches || normalized.solutions)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => Object.keys(entry).length);
  if (!entries.length) return fallbackSketches;
  return entries.map((entry, index) => {
    const fallback = fallbackSketches[index] || {};
    const sourceCandidateIds = normalizeStringArray(
      entry.source_candidate_ids
      || entry.sourceCandidateIds
      || entry.candidate_ids
      || entry.candidateIds
      || fallback.source_candidate_ids
    );
    const solutionId = compactText(entry.solution_id || entry.solutionId)
      || fallback.solution_id
      || `solution:${stableHash(`${state.project || ''}:${state.task_id || ''}:agent:${index}:${sourceCandidateIds.join('|')}`, 18)}`;
    const variantKey = compactText(entry.variant_key || entry.variantKey) || fallback.variant_key || `agent_revision:${index + 1}`;
    return {
      ...fallback,
      record_type: 'solution_sketch',
      version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
      project: state.project || fallback.project || null,
      round_id: `round:${state.current_round ?? 0}`,
      solution_id: solutionId,
      variant_id: compactText(entry.variant_id || entry.variantId) || fallback.variant_id || `variant:${stableHash(`${solutionId}:${variantKey}`, 12)}`,
      variant_key: variantKey,
      source_candidate_ids: sourceCandidateIds,
      source_edge_ids: normalizeStringArray(entry.source_edge_ids || entry.sourceEdgeIds || fallback.source_edge_ids),
      problem_claim: compactText(entry.problem_claim || entry.problemClaim) || fallback.problem_claim || solutionProblemClaim(state, []),
      core_idea: compactText(entry.core_idea || entry.coreIdea) || fallback.core_idea || 'Agent revised a bounded method sketch from selected PaperNexus candidates.',
      algorithm_flow: normalizeStringArray(entry.algorithm_flow || entry.algorithmFlow || fallback.algorithm_flow),
      module_interfaces: normalizeModuleInterfaces(entry.module_interfaces || entry.moduleInterfaces).length
        ? normalizeModuleInterfaces(entry.module_interfaces || entry.moduleInterfaces)
        : (fallback.module_interfaces || []),
      training_objective: compactText(entry.training_objective || entry.trainingObjective) || fallback.training_objective || '',
      inference_behavior: compactText(entry.inference_behavior || entry.inferenceBehavior) || fallback.inference_behavior || '',
      expected_observations: normalizeStringArray(entry.expected_observations || entry.expectedObservations || fallback.expected_observations),
      ablation_suggestions: normalizeStringArray(entry.ablation_suggestions || entry.ablationSuggestions || fallback.ablation_suggestions),
      discard_conditions: normalizeStringArray(entry.discard_conditions || entry.discardConditions || fallback.discard_conditions),
      design_boundaries_checked: normalizeStringArray(entry.design_boundaries_checked || entry.designBoundariesChecked || fallback.design_boundaries_checked),
      evidence_boundaries: normalizeEvidenceBoundaries(entry.evidence_boundaries || entry.evidenceBoundaries, fallback.evidence_boundaries),
      missing_evidence: normalizeStringArray(entry.missing_evidence || entry.missingEvidence || fallback.missing_evidence),
      status: compactText(entry.status || fallback.status || 'proposed').toLowerCase().replace(/[-\s]+/g, '_'),
      generated_by: generatedBy,
      generatedAt: nowIso()
    };
  }).filter((sketch) => sketch.source_candidate_ids.length || sketch.core_idea);
}

async function runSolutionComposition(overlay = {}, state = {}, args = {}, context = {}, fallbackSketches = []) {
  const externalPayload = externalSolutionPayload(args);
  if (externalPayload) {
    return {
      backend: 'external_agent_inputs',
      source: 'external_inputs',
      model: null,
      payload: externalPayload,
      solution_sketches: normalizeSolutionSketchPayload(externalPayload, fallbackSketches, state, 'research_controller.compose_solutions.external_agent_inputs'),
      warnings: []
    };
  }
  const hook = typeof context.options?.llmJson === 'function'
    ? context.options.llmJson
    : (typeof args.llmJson === 'function' ? args.llmJson : null);
  if (hook) {
    const request = buildSolutionCompositionRequest(overlay, state, fallbackSketches);
    const payload = await hook({
      task: 'research_controller.compose_solutions',
      prompt: buildSolutionCompositionPrompt(request),
      args,
      solutionCompositionRequest: request,
      selectedSubgraphs: request.selected_subgraphs,
      methodCards: request.method_cards,
      candidateRelations: request.candidate_relations
    });
    const parsedPayload = typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload);
    return {
      backend: 'single_model_llm_json',
      source: 'llm_json_hook',
      model: compactText(normalizeJudge(args).model) || null,
      payload: parsedPayload,
      solution_sketches: normalizeSolutionSketchPayload(parsedPayload, fallbackSketches, state, 'research_controller.compose_solutions.single_model_revision'),
      warnings: []
    };
  }
  const request = buildSolutionCompositionRequest(overlay, state, fallbackSketches);
  const providerRun = await requestConfiguredControllerLlmJson(
    'research_controller.compose_solutions',
    buildSolutionCompositionPrompt(request),
    argsWithControllerRequestPolicy(args, request),
    context
  );
  if (providerRun.payload) {
    return {
      ...providerRun,
      solution_sketches: normalizeSolutionSketchPayload(
        providerRun.payload,
        fallbackSketches,
        state,
        'research_controller.compose_solutions.configured_provider_revision'
      )
    };
  }
  return {
    backend: 'selected_subgraph_solution_composer',
    source: 'controller_deterministic_fallback',
    model: null,
    payload: { solution_sketches: fallbackSketches },
    solution_sketches: fallbackSketches,
    warnings: providerRun.warnings || []
  };
}

function renderSolutionSketchesMarkdown(solutionSketches = []) {
  const lines = [
    '# PaperNexus Solution Sketches',
    '',
    `- Solution sketches: ${solutionSketches.length}`,
    '',
    '## Variants',
    ''
  ];
  for (const sketch of solutionSketches) {
    lines.push(`### ${sketch.solution_id}`);
    lines.push('');
    lines.push(`- Variant: ${sketch.variant_key || ''}`);
    lines.push(`- Candidates: ${(sketch.source_candidate_ids || []).join(', ')}`);
    lines.push(`- Status: ${sketch.status || ''}`);
    lines.push('');
    lines.push(sketch.core_idea || '');
    lines.push('', 'Ablations:');
    for (const item of sketch.ablation_suggestions || []) lines.push(`- ${item}`);
    lines.push('', 'Discard conditions:');
    for (const item of sketch.discard_conditions || []) lines.push(`- ${item}`);
    if (sketch.missing_evidence?.length) {
      lines.push('', 'Missing evidence:');
      for (const item of sketch.missing_evidence) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function designBoundaryViolations(solution = {}) {
  const text = normalizeComparable([
    solution.core_idea,
    solution.training_objective,
    solution.inference_behavior,
    ...(solution.algorithm_flow || [])
  ].join(' '));
  const violations = [];
  if (/\btest labels?\b|\btest set tuning\b|\bevaluation only labels?\b/.test(text)) {
    violations.push('Possible use of evaluation-only labels or test-set tuning.');
  }
  if (/\bunknown class labels?\b|\bnovel class labels?\b/.test(text)) {
    violations.push('Possible use of unknown/novel-class labels.');
  }
  return violations;
}

function reviewScoreLabel(value = 0) {
  const numeric = Number(value || 0);
  if (numeric >= 4) return 'high';
  if (numeric >= 2) return 'medium';
  return 'low';
}

function candidateByIdForOverlay(overlay = {}) {
  const byId = new Map();
  for (const candidate of overlay.candidateGraph?.nodes || []) {
    if (candidate.candidate_id) byId.set(candidate.candidate_id, candidate);
  }
  for (const card of overlay.selectedSubgraphs?.method_card_pack?.method_cards || []) {
    if (card.candidate_id && !byId.has(card.candidate_id)) byId.set(card.candidate_id, card);
  }
  return byId;
}

function closestPriorRelationTypes(edge = {}) {
  const types = edge.relation_types || [];
  return types.filter((type) => [
    'NOVELTY_COLLISION',
    'SUBSTITUTES',
    'SHARES_MECHANISM',
    'SHARES_FAILURE_MODE',
    'EVALUATION_COMPATIBLE'
  ].includes(type));
}

function closestPriorEvidenceRecord(solution = {}, candidate = {}, prior = {}, source = {}) {
  const relationTypes = source.relation_types || [];
  const evidenceType = source.evidence_type || (
    relationTypes.includes('NOVELTY_COLLISION')
      ? 'novelty_collision_relation'
      : relationTypes.includes('SUBSTITUTES')
        ? 'same_subproblem_relation'
        : relationTypes.includes('SHARES_MECHANISM')
          ? 'shared_mechanism_relation'
          : 'candidate_overlap'
  );
  return {
    check_id: `closest-prior:${stableHash(`${solution.solution_id || ''}:${candidate.candidate_id || ''}:${prior.candidate_id || ''}:${evidenceType}:${source.edge_id || ''}`, 18)}`,
    evidence_type: evidenceType,
    status: 'graph_prior_found',
    candidate_id: candidate.candidate_id || null,
    prior_candidate_id: prior.candidate_id || null,
    prior_title: candidateTitle(prior) || prior.source_papers?.[0]?.title || null,
    prior_paper_ids: prior.evidence?.paper_ids || [],
    prior_mechanism: prior.mechanism || null,
    relation_types: relationTypes,
    confidence: source.confidence ?? null,
    overlap_signals: unique([
      ...(source.shared_mechanism_terms || []),
      ...(source.shared_paper_ids || []),
      ...(source.shared_failure_modes || []),
      ...(source.shared_metrics || [])
    ]),
    rationale: truncate(source.rationale || 'Graph candidate overlap suggests a closest-prior or novelty-risk check.', 500),
    evidence_refs: {
      edge_id: source.edge_id || null,
      candidate_id: candidate.candidate_id || null,
      prior_candidate_id: prior.candidate_id || null,
      graph_refs: prior.evidence?.graph_refs || []
    }
  };
}

function closestPriorEvidenceFromEdges(solution = {}, overlay = {}, candidateById = new Map()) {
  const sourceIds = new Set(solution.source_candidate_ids || []);
  const evidence = [];
  for (const edge of overlay.candidateGraph?.edges || []) {
    const relationTypes = closestPriorRelationTypes(edge);
    if (!relationTypes.length) continue;
    const sourceInSolution = sourceIds.has(edge.source_candidate_id);
    const targetInSolution = sourceIds.has(edge.target_candidate_id);
    if (sourceInSolution === targetInSolution) continue;
    const candidate = candidateById.get(sourceInSolution ? edge.source_candidate_id : edge.target_candidate_id);
    const prior = candidateById.get(sourceInSolution ? edge.target_candidate_id : edge.source_candidate_id);
    if (!candidate || !prior) continue;
    evidence.push(closestPriorEvidenceRecord(solution, candidate, prior, {
      edge_id: edge.edge_id,
      evidence_type: relationTypes.includes('NOVELTY_COLLISION') ? 'novelty_collision_relation' : undefined,
      relation_types: relationTypes,
      confidence: edge.confidence,
      rationale: edge.rationale,
      shared_mechanism_terms: edge.evidence?.shared_mechanism_terms || [],
      shared_paper_ids: edge.evidence?.shared_paper_ids || [],
      shared_failure_modes: edge.evidence?.shared_failure_modes || [],
      shared_metrics: edge.evidence?.shared_metrics || []
    }));
  }
  return evidence;
}

function closestPriorEvidenceFromCandidates(solution = {}, overlay = {}, candidateById = new Map()) {
  const sourceIds = new Set(solution.source_candidate_ids || []);
  const evidence = [];
  for (const candidateId of sourceIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) continue;
    const candidatePapers = candidatePaperIds(candidate);
    const candidateMechanism = candidateMechanismTokens(candidate);
    const candidateSubproblem = candidateSubproblemKey(candidate);
    for (const prior of overlay.candidateGraph?.nodes || []) {
      if (!prior?.candidate_id || prior.candidate_id === candidateId || sourceIds.has(prior.candidate_id)) continue;
      const sharedPaperIds = intersection(candidatePapers, candidatePaperIds(prior));
      const sharedMechanismTerms = intersection(candidateMechanism, candidateMechanismTokens(prior));
      const sameSubproblem = candidateSubproblem && candidateSubproblem === candidateSubproblemKey(prior);
      if (!sharedPaperIds.length && sharedMechanismTerms.length < 2) continue;
      evidence.push(closestPriorEvidenceRecord(solution, candidate, prior, {
        evidence_type: sameSubproblem ? 'same_subproblem_candidate_overlap' : 'candidate_overlap',
        relation_types: sameSubproblem ? ['NOVELTY_COLLISION'] : ['SHARES_MECHANISM'],
        confidence: Number(Math.min(0.9, 0.45 + (sharedPaperIds.length ? 0.18 : 0) + (sharedMechanismTerms.length * 0.06)).toFixed(3)),
        rationale: [
          sameSubproblem ? 'same subproblem' : 'cross-subproblem candidate',
          sharedPaperIds.length ? `shared paper ids: ${sharedPaperIds.slice(0, 3).join(', ')}` : '',
          sharedMechanismTerms.length ? `shared mechanism terms: ${sharedMechanismTerms.slice(0, 4).join(', ')}` : ''
        ].filter(Boolean).join('; '),
        shared_mechanism_terms: sharedMechanismTerms,
        shared_paper_ids: sharedPaperIds
      }));
    }
  }
  return evidence;
}

function closestPriorEvidenceForSolution(solution = {}, overlay = {}) {
  const candidateById = candidateByIdForOverlay(overlay);
  const byKey = new Map();
  for (const record of [
    ...closestPriorEvidenceFromEdges(solution, overlay, candidateById),
    ...closestPriorEvidenceFromCandidates(solution, overlay, candidateById)
  ]) {
    byKey.set(record.check_id, record);
  }
  return [...byKey.values()]
    .sort((left, right) => {
      const leftRank = left.relation_types.includes('NOVELTY_COLLISION') ? 1 : 0;
      const rightRank = right.relation_types.includes('NOVELTY_COLLISION') ? 1 : 0;
      if (rightRank !== leftRank) return rightRank - leftRank;
      return (right.confidence || 0) - (left.confidence || 0);
    })
    .slice(0, 6);
}

function closestPriorSeedPapers(review = {}, solution = {}, overlay = {}) {
  const candidateById = candidateByIdForOverlay(overlay);
  const seeds = [];
  const addCandidateSeeds = (candidateId = '') => {
    const candidate = candidateById.get(candidateId);
    if (!candidate) return;
    seeds.push(...seedPapersForMethodCard(candidate));
  };
  for (const candidateId of solution.source_candidate_ids || []) addCandidateSeeds(candidateId);
  for (const evidence of review.closest_prior_evidence || []) {
    addCandidateSeeds(evidence.candidate_id);
    addCandidateSeeds(evidence.prior_candidate_id);
  }
  const seen = new Set();
  return seeds.filter((seed) => {
    const key = compactText(seed.canonicalId || seed.doi || seed.arxivId || seed.pmid || seed.sourceKey || seed.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function closestPriorRequestProblemText(review = {}, solution = {}, state = {}) {
  return compactText([
    `Closest-prior novelty-risk check for solution ${solution.solution_id || review.solution_id || ''}.`,
    state.target_problem ? `Target problem: ${state.target_problem}` : '',
    solution.core_idea ? `Core idea: ${solution.core_idea}` : '',
    review.closest_prior_checks?.length ? `Graph closest-prior checks: ${review.closest_prior_checks.join('; ')}` : '',
    review.missing_evidence?.length ? `Missing evidence: ${review.missing_evidence.join('; ')}` : ''
  ].filter(Boolean).join('\n'));
}

function closestPriorExpansionRequestForReview(review = {}, solution = {}, state = {}, overlay = {}) {
  const seedPapers = closestPriorSeedPapers(review, solution, overlay);
  return {
    request_id: `cpreq:${stableHash(`${state.project || ''}:${state.current_round ?? 0}:${review.review_id || ''}:${review.solution_id || ''}`, 18)}`,
    request_type: 'agent_materials_operation',
    operation: 'research_material_pack',
    solution_id: review.solution_id || null,
    review_id: review.review_id || null,
    status: 'opt_in_requested_not_executed',
    execution_status: 'not_run',
    approval_required: true,
    safety: {
      mutates_raw_corpus_graph: false,
      provider_or_live_discovery_enabled: false,
      literature_discovery_enabled: false,
      import_submission_enabled: false,
      human_approval_required_before_execution: true
    },
    requested_opt_ins: {
      include_provider_evidence: true,
      include_live_discovery_evidence: false,
      include_literature_discovery: true,
      submit_imports: false,
      process_literature_imports: false
    },
    arguments: {
      operation: 'research_material_pack',
      project: state.project || null,
      targetDomain: state.target_domain || null,
      targetProblem: closestPriorRequestProblemText(review, solution, state),
      roles: 'novelty_risk,baseline_candidate,target_prior',
      seedPapers,
      autoDiscoverSources: false,
      includeProviderEvidence: false,
      includeLiveDiscoveryEvidence: false,
      includeLiteratureDiscoveryEvidence: false,
      submitLiteratureDiscoveryImports: false,
      processLiteratureDiscoveryImports: false
    },
    reason: 'Plan a deeper closest-prior material check for this reviewed solution without executing provider, literature discovery, import, or graph mutation by default.',
    generatedAt: nowIso()
  };
}

function closestPriorExpansionRequestsForReviews(reviews = [], overlay = {}, state = {}) {
  const solutionByIdMap = solutionById(overlay);
  return reviews
    .map((review) => closestPriorExpansionRequestForReview(review, solutionByIdMap.get(review.solution_id) || {}, state, overlay))
    .filter((request) => request.solution_id);
}

function closestPriorCheckNotes(evidence = []) {
  if (!evidence.length) {
    return ['closest prior graph evidence is missing; run selected-candidate material expansion or external closest-prior review before claiming novelty.'];
  }
  return evidence.map((record) => compactText([
    record.evidence_type,
    record.prior_title ? `prior=${record.prior_title}` : '',
    record.relation_types?.length ? `relations=${record.relation_types.join(',')}` : '',
    record.overlap_signals?.length ? `overlap=${record.overlap_signals.slice(0, 4).join(',')}` : ''
  ].filter(Boolean).join('; ')));
}

function noveltyRiskScoreFromClosestPrior(evidence = [], fallback = 3) {
  if (!evidence.length) return Math.max(fallback, 3);
  if (evidence.some((record) => record.relation_types?.includes('NOVELTY_COLLISION'))) return 4;
  if (evidence.some((record) => record.relation_types?.includes('SUBSTITUTES'))) return 4;
  return Math.max(fallback, 3);
}

function reviewSolutionSketch(solution = {}, state = {}, overlay = {}) {
  const missingEvidence = normalizeStringArray(solution.missing_evidence || []);
  const boundaryViolations = designBoundaryViolations(solution);
  const hasAblation = (solution.ablation_suggestions || []).length > 0;
  const hasDiscard = (solution.discard_conditions || []).length > 0;
  const evidenceCoverageScore = Math.max(0, 5 - Math.min(5, Math.ceil(missingEvidence.length / 2)));
  const feasibilityScore = boundaryViolations.length ? 1 : (hasAblation && hasDiscard ? 3 : 2);
  const evaluationScore = hasAblation && hasDiscard ? 4 : 2;
  const closestPriorEvidence = closestPriorEvidenceForSolution(solution, overlay);
  const closestPriorChecks = closestPriorCheckNotes(closestPriorEvidence);
  const closestPriorMissingEvidence = closestPriorEvidence.length ? [] : ['closest prior graph evidence'];
  const noveltyRiskScore = noveltyRiskScoreFromClosestPrior(
    closestPriorEvidence,
    (solution.source_candidate_ids || []).length > 1 ? 2 : 3
  );
  const decompositionDrift = (solution.source_candidate_ids || []).some((candidateId) => (
    !(overlay.selectedSubgraphs?.subgraphs || []).some((subgraph) => (subgraph.candidate_ids || []).includes(candidateId))
  )) ? 'possible' : 'none';
  const decision = boundaryViolations.length
    ? 'reject'
    : (missingEvidence.length || closestPriorMissingEvidence.length || decompositionDrift !== 'none' ? 'revise' : 'recommend');
  return {
    review_id: `design-review:${stableHash(`${state.project || ''}:${state.task_id || ''}:${solution.solution_id}`, 18)}`,
    solution_id: solution.solution_id,
    decision,
    novelty_risk: reviewScoreLabel(noveltyRiskScore),
    novelty_risk_score: noveltyRiskScore,
    novelty_claim_status: closestPriorEvidence.length ? 'not_claimed_graph_prior_checked' : 'not_claimed_prior_missing',
    evidence_coverage: reviewScoreLabel(evidenceCoverageScore),
    evidence_coverage_score: evidenceCoverageScore,
    feasibility: reviewScoreLabel(feasibilityScore),
    feasibility_score: feasibilityScore,
    evaluation_suggestion_quality: reviewScoreLabel(evaluationScore),
    evaluation_suggestion_quality_score: evaluationScore,
    decomposition_drift: decompositionDrift,
    design_boundary_review: {
      checked_boundaries: state.constraints?.design_boundaries || [],
      violations: boundaryViolations,
      status: boundaryViolations.length ? 'failed' : 'passed_static_check'
    },
    closest_prior_checks: closestPriorChecks,
    closest_prior_evidence: closestPriorEvidence,
    main_reason: decision === 'recommend'
      ? 'The sketch has selected-candidate support, graph closest-prior checks, ablations, discard conditions, and no static design-boundary violation.'
      : 'The sketch remains a user decision artifact because evidence, boundary, or decomposition checks are incomplete.',
    missing_evidence: unique([...missingEvidence, ...closestPriorMissingEvidence]),
    highest_risk_assumption: missingEvidence[0] || closestPriorMissingEvidence[0] || boundaryViolations[0] || 'Expected gain is not experimentally verified.',
    suggested_revision: missingEvidence.length || closestPriorMissingEvidence.length
      ? `Resolve missing evidence before treating this as execution-ready: ${unique([...missingEvidence, ...closestPriorMissingEvidence]).slice(0, 5).join(', ')}.`
      : 'Keep as a reviewed solution sketch and request user approval before experiment planning.',
    user_decision_needed: [
      'Choose whether to refine, park, or experimentally plan this solution sketch.',
      'Approve any provider evidence, literature discovery, import, or real experiment before execution.'
    ],
    generated_by: 'research_controller.design_review.structured_static_review',
    generatedAt: nowIso()
  };
}

function buildDesignReviewPayload(overlay = {}, state = {}) {
  const baseReviews = (overlay.solutionSketches || []).map((solution) => reviewSolutionSketch(solution, state, overlay));
  const closestPriorExpansionRequests = closestPriorExpansionRequestsForReviews(baseReviews, overlay, state);
  const requestIdsBySolution = new Map();
  for (const request of closestPriorExpansionRequests) {
    const ids = requestIdsBySolution.get(request.solution_id) || [];
    ids.push(request.request_id);
    requestIdsBySolution.set(request.solution_id, ids);
  }
  const reviews = baseReviews.map((review) => ({
    ...review,
    closest_prior_request_ids: requestIdsBySolution.get(review.solution_id) || []
  }));
  return {
    record_type: 'design_review',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    review_id: `design-review-pack:${stableHash(`${state.project || ''}:${state.task_id || ''}:${reviews.map((review) => review.solution_id).join('|')}`, 18)}`,
    review_policy: {
      backend: 'controller_structured_review',
      authority: 'review_evidence_only',
      note: 'Design reviews are not final research directions; user approval is required before experiments or claims.'
    },
    reviews,
    closest_prior_expansion_requests: closestPriorExpansionRequests,
    user_decision_needed: unique(reviews.flatMap((review) => review.user_decision_needed || [])),
    generatedAt: nowIso()
  };
}

function externalDesignReviewPayload(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = externalInputs.design_review_payload
    || externalInputs.designReviewPayload
    || externalInputs.design_review
    || externalInputs.designReview
    || args.designReviewPayload
    || args.design_review_payload
    || args.designReview
    || args.design_review;
  return payload ? normalizeObject(payload) : null;
}

function buildDesignReviewRequest(overlay = {}, state = {}, fallbackDesignReview = {}) {
  return {
    task: 'research_controller.design_review',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    task_id: state.task_id || null,
    target_domain: state.target_domain || null,
    target_problem: state.target_problem || null,
    design_boundaries: state.constraints?.design_boundaries || [],
    budget: state.budget || null,
    provider_policy: state.provider_policy || null,
    judge: state.judge || null,
    selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
    solution_sketches: overlay.solutionSketches || [],
    controller_fallback_review: fallbackDesignReview,
    output_schema: {
      reviews: [{
        solution_id: 'solution id',
        decision: 'recommend|revise|reject',
        novelty_risk: 'low|medium|high',
        evidence_coverage: 'low|medium|high',
        feasibility: 'low|medium|high',
        evaluation_suggestion_quality: 'low|medium|high',
        decomposition_drift: 'none|possible|likely',
        design_boundary_review: {
          status: 'passed_static_check|failed|needs_human_review',
          violations: ['string']
        },
        closest_prior_checks: ['closest-prior or novelty-collision notes'],
        closest_prior_evidence: [{
          evidence_type: 'novelty_collision_relation|same_subproblem_candidate_overlap|shared_mechanism_relation|candidate_overlap',
          prior_candidate_id: 'candidate id',
          prior_title: 'paper or candidate title',
          relation_types: ['NOVELTY_COLLISION|SHARES_MECHANISM|SUBSTITUTES'],
          evidence_refs: {
            edge_id: 'candidate edge id when available'
          }
        }],
        main_reason: 'string',
        missing_evidence: ['string'],
        suggested_revision: 'string',
        user_decision_needed: ['string']
      }]
    }
  };
}

function buildDesignReviewPrompt(request = {}) {
  return [
    'You are reviewing PaperNexus solution sketches.',
    'Return strict JSON only.',
    'Do not claim novelty or execution readiness.',
    'Check novelty risk, evidence coverage, feasibility, evaluation quality, decomposition drift, and design boundaries.',
    'If closest-prior evidence is missing, mark it as missing evidence rather than inventing it.',
    '',
    `Design review request: ${JSON.stringify(request)}`
  ].join('\n');
}

function normalizeDesignDecision(value = '', fallback = 'revise') {
  const decision = compactText(value).toLowerCase().replace(/[-\s]+/g, '_');
  return ['recommend', 'revise', 'reject'].includes(decision) ? decision : fallback;
}

function normalizeDesignBoundaryReview(value = {}, fallback = {}) {
  const review = normalizeObject(value);
  const fallbackReview = normalizeObject(fallback);
  return {
    checked_boundaries: normalizeStringArray(review.checked_boundaries || review.checkedBoundaries || fallbackReview.checked_boundaries),
    violations: normalizeStringArray(review.violations || fallbackReview.violations),
    status: compactText(review.status || fallbackReview.status || 'needs_human_review')
  };
}

function normalizeDesignReviewPayload(payload = {}, fallbackDesignReview = {}, state = {}, runMeta = {}) {
  const normalized = normalizeObject(payload);
  const entries = asArray(normalized.reviews || normalized.design_reviews || normalized.designReviews)
    .map((entry) => normalizeObject(entry))
    .filter((entry) => Object.keys(entry).length);
  if (!entries.length) return fallbackDesignReview;
  const fallbackReviews = fallbackDesignReview.reviews || [];
  const reviews = entries.map((entry, index) => {
    const fallback = fallbackReviews[index] || {};
    const solutionId = compactText(entry.solution_id || entry.solutionId) || fallback.solution_id || '';
    const decision = normalizeDesignDecision(entry.decision || entry.verdict, fallback.decision || 'revise');
    const missingEvidence = normalizeStringArray(entry.missing_evidence || entry.missingEvidence || fallback.missing_evidence);
    const closestPriorEvidence = asArray(entry.closest_prior_evidence || entry.closestPriorEvidence || fallback.closest_prior_evidence)
      .map((record) => normalizeObject(record))
      .filter((record) => Object.keys(record).length);
    const closestPriorChecks = unique([
      ...normalizeStringArray(fallback.closest_prior_checks),
      ...normalizeStringArray(entry.closest_prior_checks || entry.closestPriorChecks)
    ]);
    const closestPriorRequestIds = unique([
      ...normalizeStringArray(fallback.closest_prior_request_ids),
      ...normalizeStringArray(entry.closest_prior_request_ids || entry.closestPriorRequestIds)
    ]);
    const designBoundaryReview = normalizeDesignBoundaryReview(
      entry.design_boundary_review || entry.designBoundaryReview,
      fallback.design_boundary_review
    );
    return {
      ...fallback,
      review_id: compactText(entry.review_id || entry.reviewId)
        || fallback.review_id
        || `design-review:${stableHash(`${state.project || ''}:${state.task_id || ''}:${runMeta.backend || 'agent'}:${solutionId || index}`, 18)}`,
      solution_id: solutionId,
      decision,
      novelty_risk: compactText(entry.novelty_risk || entry.noveltyRisk) || fallback.novelty_risk || 'medium',
      novelty_risk_score: Number(entry.novelty_risk_score ?? entry.noveltyRiskScore ?? fallback.novelty_risk_score ?? 3),
      novelty_claim_status: compactText(entry.novelty_claim_status || entry.noveltyClaimStatus || fallback.novelty_claim_status || 'not_claimed'),
      evidence_coverage: compactText(entry.evidence_coverage || entry.evidenceCoverage) || fallback.evidence_coverage || 'low',
      evidence_coverage_score: Number(entry.evidence_coverage_score ?? entry.evidenceCoverageScore ?? fallback.evidence_coverage_score ?? 2),
      feasibility: compactText(entry.feasibility) || fallback.feasibility || 'medium',
      feasibility_score: Number(entry.feasibility_score ?? entry.feasibilityScore ?? fallback.feasibility_score ?? 3),
      evaluation_suggestion_quality: compactText(entry.evaluation_suggestion_quality || entry.evaluationSuggestionQuality) || fallback.evaluation_suggestion_quality || 'medium',
      evaluation_suggestion_quality_score: Number(entry.evaluation_suggestion_quality_score ?? entry.evaluationSuggestionQualityScore ?? fallback.evaluation_suggestion_quality_score ?? 3),
      decomposition_drift: compactText(entry.decomposition_drift || entry.decompositionDrift) || fallback.decomposition_drift || 'none',
      design_boundary_review: designBoundaryReview,
      closest_prior_checks: closestPriorChecks,
      closest_prior_evidence: closestPriorEvidence,
      closest_prior_request_ids: closestPriorRequestIds,
      main_reason: truncate(entry.main_reason || entry.mainReason || entry.rationale || fallback.main_reason || '', 800),
      missing_evidence: missingEvidence,
      highest_risk_assumption: compactText(entry.highest_risk_assumption || entry.highestRiskAssumption || fallback.highest_risk_assumption) || missingEvidence[0] || 'Closest-prior novelty evidence is not yet complete.',
      suggested_revision: truncate(entry.suggested_revision || entry.suggestedRevision || fallback.suggested_revision || '', 800),
      user_decision_needed: normalizeStringArray(entry.user_decision_needed || entry.userDecisionNeeded || fallback.user_decision_needed),
      generated_by: runMeta.backend === 'single_model_llm_json'
        ? 'research_controller.design_review.single_model_review'
        : runMeta.backend === 'configured_single_model_provider_json'
          ? 'research_controller.design_review.configured_provider_review'
          : 'research_controller.design_review.external_agent_inputs',
      generatedAt: nowIso()
    };
  }).filter((review) => review.solution_id);
  return {
    ...fallbackDesignReview,
    record_type: 'design_review',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    review_id: compactText(normalized.review_id || normalized.reviewId)
      || fallbackDesignReview.review_id
      || `design-review-pack:${stableHash(`${state.project || ''}:${state.task_id || ''}:${reviews.map((review) => review.solution_id).join('|')}`, 18)}`,
    review_policy: {
      backend: runMeta.backend || fallbackDesignReview.review_policy?.backend || 'controller_structured_review',
      source: runMeta.source || fallbackDesignReview.review_policy?.source || 'controller_deterministic_fallback',
      model: runMeta.model || fallbackDesignReview.review_policy?.model || null,
      provider_call_count: runMeta.provider_call_count || fallbackDesignReview.review_policy?.provider_call_count || 0,
      authority: 'review_evidence_only',
      note: 'Design reviews are not final research directions; user approval is required before experiments or claims.'
    },
    summary: compactText(normalized.summary || fallbackDesignReview.summary),
    reviews,
    closest_prior_expansion_requests: asArray(
      normalized.closest_prior_expansion_requests
      || normalized.closestPriorExpansionRequests
      || fallbackDesignReview.closest_prior_expansion_requests
    ).map((request) => normalizeObject(request)).filter((request) => Object.keys(request).length),
    user_decision_needed: normalizeStringArray(normalized.user_decision_needed || normalized.userDecisionNeeded || reviews.flatMap((review) => review.user_decision_needed || [])),
    generatedAt: nowIso()
  };
}

async function runDesignReview(overlay = {}, state = {}, args = {}, context = {}, fallbackDesignReview = {}) {
  const externalPayload = externalDesignReviewPayload(args);
  if (externalPayload) {
    const runMeta = {
      backend: 'external_agent_inputs',
      source: 'external_inputs',
      model: null
    };
    return {
      ...runMeta,
      payload: externalPayload,
      design_review: normalizeDesignReviewPayload(externalPayload, fallbackDesignReview, state, runMeta),
      warnings: []
    };
  }
  const hook = typeof context.options?.llmJson === 'function'
    ? context.options.llmJson
    : (typeof args.llmJson === 'function' ? args.llmJson : null);
  if (hook) {
    const request = buildDesignReviewRequest(overlay, state, fallbackDesignReview);
    const payload = await hook({
      task: 'research_controller.design_review',
      prompt: buildDesignReviewPrompt(request),
      args,
      designReviewRequest: request,
      solutionSketches: request.solution_sketches,
      selectedSubgraphs: request.selected_subgraphs
    });
    const parsedPayload = typeof payload === 'string' ? parseJsonText(payload) : normalizeObject(payload);
    const runMeta = {
      backend: 'single_model_llm_json',
      source: 'llm_json_hook',
      model: compactText(normalizeJudge(args).model) || null
    };
    return {
      ...runMeta,
      payload: parsedPayload,
      design_review: normalizeDesignReviewPayload(parsedPayload, fallbackDesignReview, state, runMeta),
      warnings: []
    };
  }
  const request = buildDesignReviewRequest(overlay, state, fallbackDesignReview);
  const providerRun = await requestConfiguredControllerLlmJson(
    'research_controller.design_review',
    buildDesignReviewPrompt(request),
    argsWithControllerRequestPolicy(args, request),
    context
  );
  if (providerRun.payload) {
    const runMeta = {
      backend: providerRun.backend,
      source: providerRun.source,
      model: providerRun.model,
      provider_call_count: providerRun.provider_call_count || 0
    };
    return {
      ...runMeta,
      payload: providerRun.payload,
      design_review: normalizeDesignReviewPayload(providerRun.payload, fallbackDesignReview, state, runMeta),
      warnings: providerRun.warnings || []
    };
  }
  return {
    backend: 'controller_structured_review',
    source: 'controller_deterministic_fallback',
    model: null,
    payload: fallbackDesignReview,
    design_review: fallbackDesignReview,
    warnings: providerRun.warnings || []
  };
}

function riskNotesFromDesignReview(designReview = {}, state = {}) {
  return (designReview.reviews || [])
    .filter((review) => review.decision !== 'recommend' || review.missing_evidence?.length)
    .map((review) => ({
      record_type: 'risk_note',
      risk_id: `risk:${stableHash(`${state.project || ''}:${state.task_id || ''}:${review.solution_id}:${review.decision}:${review.highest_risk_assumption}`, 18)}`,
      project: state.project || null,
      round_id: `round:${state.current_round ?? 0}`,
      source_artifact: 'design-review',
      solution_id: review.solution_id,
      risk_type: review.design_boundary_review?.violations?.length ? 'design_boundary' : 'solution_evidence',
      severity: review.decision === 'reject' ? 'high' : 'medium',
      evidence_refs: {
        review_id: review.review_id
      },
      missing_evidence: review.missing_evidence || [],
      recommended_action: review.suggested_revision || 'Revise the solution sketch before experiment planning.',
      status: 'open',
      created_at: nowIso()
    }));
}

function renderDesignReviewMarkdown(designReview = {}) {
  const lines = [
    '# PaperNexus Design Review',
    '',
    `- Project: ${designReview.project || ''}`,
    `- Round: ${designReview.round_id || ''}`,
    `- Reviews: ${designReview.reviews?.length ?? 0}`,
    '',
    '## Reviews',
    ''
  ];
  for (const review of designReview.reviews || []) {
    lines.push(`### ${review.solution_id}`);
    lines.push('');
    lines.push(`- Decision: ${review.decision}`);
    lines.push(`- Novelty risk: ${review.novelty_risk}`);
    lines.push(`- Evidence coverage: ${review.evidence_coverage}`);
    lines.push(`- Feasibility: ${review.feasibility}`);
    lines.push(`- Evaluation quality: ${review.evaluation_suggestion_quality}`);
    lines.push(`- Decomposition drift: ${review.decomposition_drift}`);
    lines.push('');
    lines.push(review.main_reason || '');
    if (review.missing_evidence?.length) {
      lines.push('', 'Missing evidence:');
      for (const item of review.missing_evidence) lines.push(`- ${item}`);
    }
    if (review.closest_prior_evidence?.length) {
      lines.push('', 'Closest prior evidence:');
      for (const item of review.closest_prior_evidence.slice(0, 5)) {
        lines.push(`- ${item.evidence_type || 'closest_prior'}: ${item.prior_title || item.prior_candidate_id || ''}`);
      }
    }
    if (review.closest_prior_request_ids?.length) {
      lines.push('', 'Closest prior expansion requests:');
      for (const requestId of review.closest_prior_request_ids) lines.push(`- ${requestId}`);
    }
    if (review.closest_prior_result_ids?.length) {
      lines.push('', 'Closest prior material results:');
      for (const resultId of review.closest_prior_result_ids) lines.push(`- ${resultId}`);
    }
    if (review.design_boundary_review?.violations?.length) {
      lines.push('', 'Design boundary violations:');
      for (const item of review.design_boundary_review.violations) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  if (designReview.decomposition_drift_review) {
    const drift = designReview.decomposition_drift_review;
    lines.push('## Decomposition Drift Review', '');
    lines.push(`- Status: ${drift.status || 'none'}`);
    lines.push(`- Signals: ${drift.signal_count ?? 0}`);
    lines.push(`- Recommendation: ${drift.recommendation || ''}`);
    if (drift.affected_subproblems?.length) {
      lines.push(`- Affected subproblems: ${drift.affected_subproblems.join(', ')}`);
    }
    for (const signal of drift.signals || []) {
      lines.push(`- ${signal.severity || 'medium'}: ${signal.reason || signal.signal_type || ''}`);
    }
    lines.push('');
  }
  if (designReview.closest_prior_expansion_requests?.length) {
    lines.push('## Closest Prior Expansion Requests', '');
    for (const request of designReview.closest_prior_expansion_requests) {
      lines.push(`- ${request.request_id}: ${request.status}`);
      lines.push(`  - Operation: ${request.operation}`);
      lines.push(`  - Approval required: ${request.approval_required ? 'yes' : 'no'}`);
      if (request.result_id) lines.push(`  - Result: ${request.result_id} (${request.result_status || 'ok'})`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const DECOMPOSITION_DRIFT_PATTERN = /\b(decomposition drift|missing subproblem|new subproblem|subproblem mismatch|task framing|framing mismatch|metric mismatch|protocol mismatch|outside selected decomposition|does not fit selected decomposition|invalid transfer|wrong problem|wrong task|boundary mismatch)\b/i;

function textForDriftScan(value = {}) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textForDriftScan).join(' ');
  if (typeof value === 'object') {
    const safe = {
      summary: value.summary,
      finding: value.finding,
      rationale: value.rationale,
      main_reason: value.main_reason,
      suggested_revision: value.suggested_revision,
      highest_risk_assumption: value.highest_risk_assumption,
      missing_evidence: value.missing_evidence,
      remaining_missing_evidence: value.remaining_missing_evidence,
      unresolved: value.unresolved,
      decomposition_drift: value.decomposition_drift
    };
    return JSON.stringify(safe);
  }
  return String(value);
}

function decompositionDriftSeverity(value = 'possible') {
  const normalized = compactText(value).toLowerCase();
  if (['likely', 'high', 'critical', 'severe'].includes(normalized)) return 'high';
  if (['possible', 'medium', 'moderate'].includes(normalized)) return 'medium';
  return 'low';
}

function subproblemNamesFromDriftText(text = '', subproblemGraph = {}) {
  const comparable = normalizeComparable(text);
  return unique((subproblemGraph.subproblems || [])
    .filter((subproblem) => comparable.includes(normalizeComparable(subproblem.name)))
    .map((subproblem) => subproblem.name));
}

function decompositionDriftStatus(signals = []) {
  if (!signals.length) return 'none';
  if (signals.some((signal) => signal.severity === 'high') || signals.length >= 3) return 'likely';
  return 'possible';
}

function driftRecommendation(status = 'none') {
  if (status === 'likely') return 'regenerate_or_human_review_decomposition_before_experiment_planning';
  if (status === 'possible') return 'review_decomposition_before_promoting_solution';
  return 'continue_with_current_decomposition';
}

function buildDecompositionDriftReview(overlay = {}, state = {}) {
  const signals = [];
  const subproblemGraph = overlay.subproblemGraph || {};
  for (const review of overlay.designReview?.reviews || []) {
    const drift = compactText(review.decomposition_drift || 'none').toLowerCase();
    if (drift && drift !== 'none') {
      signals.push({
        signal_type: 'design_review_decomposition_drift',
        severity: decompositionDriftSeverity(drift),
        source_artifact: 'design-review',
        review_id: review.review_id || null,
        solution_id: review.solution_id || null,
        affected_subproblems: subproblemNamesFromDriftText(textForDriftScan(review), subproblemGraph),
        reason: `Design review marked decomposition drift as ${drift}.`,
        evidence_refs: {
          review_id: review.review_id || null,
          solution_id: review.solution_id || null
        }
      });
    }
    const reviewText = textForDriftScan(review);
    if (DECOMPOSITION_DRIFT_PATTERN.test(reviewText)) {
      signals.push({
        signal_type: 'design_review_framing_signal',
        severity: 'medium',
        source_artifact: 'design-review',
        review_id: review.review_id || null,
        solution_id: review.solution_id || null,
        affected_subproblems: subproblemNamesFromDriftText(reviewText, subproblemGraph),
        reason: truncate(compactText(review.main_reason || review.highest_risk_assumption || 'Design review contains task-framing or metric-mismatch language.'), 300),
        evidence_refs: {
          review_id: review.review_id || null,
          solution_id: review.solution_id || null
        }
      });
    }
  }
  for (const result of overlay.materialExpansionResults || []) {
    const resultText = textForDriftScan(result);
    if (!DECOMPOSITION_DRIFT_PATTERN.test(resultText)) continue;
    signals.push({
      signal_type: 'material_result_framing_signal',
      severity: result.status === 'failed' ? 'high' : 'medium',
      source_artifact: 'material-expansion-results',
      result_id: result.result_id || null,
      request_id: result.request_id || null,
      candidate_id: result.candidate_id || null,
      solution_id: result.solution_id || null,
      affected_subproblems: subproblemNamesFromDriftText(resultText, subproblemGraph),
      reason: truncate(compactText(result.summary?.finding || result.summary?.error || 'Material result contains task-framing, subproblem, protocol, or metric-mismatch language.'), 300),
      evidence_refs: {
        result_id: result.result_id || null,
        request_id: result.request_id || null
      }
    });
  }
  const status = decompositionDriftStatus(signals);
  const affectedSubproblems = unique(signals.flatMap((signal) => signal.affected_subproblems || []));
  return {
    record_type: 'decomposition_drift_review',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || overlay.decompositionReview?.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    review_id: `decomp-drift:${stableHash(`${state.project || ''}:${state.task_id || ''}:${status}:${signals.map((signal) => `${signal.signal_type}:${signal.review_id || signal.result_id || signal.request_id || ''}`).join('|')}`, 18)}`,
    decomposition_version: overlay.subproblemGraph?.decomposition_version || state.selected_decomposition_version || null,
    status,
    requires_revisit: status !== 'none',
    signal_count: signals.length,
    signals,
    affected_subproblems: affectedSubproblems,
    alternative_decompositions: status === 'none'
      ? []
      : [
          'Re-run review_decomposition with the post-evidence drift signals as context.',
          'If the same signal recurs after review, regenerate TaskSpec/SubProblemGraph before experiment planning.'
        ],
    critic_questions: status === 'none'
      ? []
      : [
          'Do the selected candidates still correspond to the selected subproblems?',
          'Did material expansion reveal a missing subproblem, protocol boundary, or metric mismatch?',
          'Should solution composition be paused until decomposition review is refreshed?'
        ],
    recommendation: driftRecommendation(status),
    generated_by: 'research_controller.review_curator.static_drift_scan',
    generatedAt: nowIso()
  };
}

function decompositionDriftStateSummary(review = null) {
  if (!review) return { status: 'none', signal_count: 0, requires_revisit: false };
  return {
    status: review.status || 'none',
    signal_count: review.signal_count || 0,
    requires_revisit: Boolean(review.requires_revisit),
    recommendation: review.recommendation || null,
    affected_subproblems: review.affected_subproblems || []
  };
}

function applyDecompositionDriftReview(decompositionReview = {}, driftReview = null) {
  if (!driftReview) return decompositionReview;
  return {
    ...(decompositionReview || {}),
    post_evidence_drift_review: driftReview,
    post_evidence_recommendation: driftReview.recommendation,
    requires_post_evidence_decomposition_review: Boolean(driftReview.requires_revisit),
    critic_questions: unique([
      ...(decompositionReview?.critic_questions || []),
      ...(driftReview.critic_questions || [])
    ]),
    updatedAt: nowIso()
  };
}

function applyDecompositionDriftToDesignReview(designReview = null, driftReview = null) {
  if (!designReview || !driftReview) return designReview;
  return {
    ...designReview,
    decomposition_drift_review: driftReview,
    user_decision_needed: unique([
      ...(designReview.user_decision_needed || []),
      ...(driftReview.requires_revisit ? ['Review or regenerate the task decomposition before promoting these solution sketches.'] : [])
    ]),
    updatedAt: nowIso()
  };
}

function riskNotesFromDecompositionDriftReview(driftReview = null, state = {}) {
  if (!driftReview?.requires_revisit) return [];
  return [{
    record_type: 'risk_note',
    risk_id: `risk:${stableHash(`${state.project || ''}:${state.task_id || ''}:decomposition-drift:${driftReview.review_id}`, 18)}`,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    source_artifact: 'decomposition-review',
    risk_type: 'decomposition_drift',
    severity: driftReview.status === 'likely' ? 'high' : 'medium',
    evidence_refs: {
      decomposition_drift_review_id: driftReview.review_id
    },
    missing_evidence: driftReview.critic_questions || [],
    recommended_action: driftReview.recommendation || 'Review decomposition before promoting solution sketches.',
    status: 'open',
    created_at: nowIso()
  }];
}

function experimentPlanningApproval(args = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const approval = normalizeObject(
    args.experimentPlanApproval
    || args.experiment_plan_approval
    || externalInputs.experiment_plan_approval
    || externalInputs.experimentPlanApproval
  );
  const approved = booleanFlag(
    args.approveExperimentPlanning
    ?? args.approve_experiment_planning
    ?? externalInputs.approveExperimentPlanning
    ?? externalInputs.approve_experiment_planning
    ?? approval.approved,
    false
  );
  return {
    approved,
    source: approved ? (compactText(approval.source || args.actor) || 'explicit_controller_argument') : null,
    approver: compactText(approval.approver || approval.actor || args.actor) || null,
    note: compactText(approval.note || approval.reason || args.experimentPlanApprovalNote || args.experiment_plan_approval_note) || null,
    approved_at: approved ? nowIso() : null
  };
}

function experimentPlanLimit(args = {}, state = {}) {
  const budget = normalizeObject(args.budget);
  return boundedInteger(
    args.maxExperimentPlans ?? args.max_experiment_plans ?? budget.max_experiment_plans ?? budget.maxExperimentPlans ?? state.budget?.max_experiment_plans,
    Math.min(3, state.budget?.max_experiment_plans || 3),
    { min: 1, max: 8 }
  );
}

function solutionById(overlay = {}) {
  return new Map((overlay.solutionSketches || []).map((solution) => [solution.solution_id, solution]));
}

function methodCardsByCandidateId(overlay = {}) {
  return new Map((overlay.selectedSubgraphs?.method_card_pack?.method_cards || []).map((card) => [card.candidate_id, card]));
}

function experimentMetricsForSolution(solution = {}, cards = []) {
  const cardMetrics = cards.flatMap((card) => [
    ...(card.evaluation_plan?.metrics || []),
    ...(card.baseline_comparability?.metrics || [])
  ]);
  const observationMetrics = (solution.expected_observations || [])
    .map((entry) => compactText(entry).match(/\b(accuracy|nmi|ari|ece|calibration|precision|recall|f1|error|auc)\b/i)?.[0])
    .filter(Boolean);
  return unique([
    ...cardMetrics,
    ...observationMetrics,
    'known accuracy',
    'novel accuracy',
    'NMI'
  ].map(compactText).filter(Boolean)).slice(0, 8);
}

function experimentBaselinesForSolution(solution = {}, cards = []) {
  return unique([
    ...cards.map((card) => compactText(card.evaluation_plan?.baseline)).filter(Boolean),
    'best single selected-candidate baseline',
    'matched backbone and training budget baseline'
  ]).slice(0, 6);
}

function experimentDatasetsForSolution(cards = [], state = {}) {
  const datasets = unique(cards.map((card) => compactText(card.evaluation_plan?.dataset)).filter(Boolean));
  if (datasets.length) return datasets.slice(0, 6);
  if (normalizeComparable(state.target_domain || '').includes('generalized category discovery')) {
    return ['CIFAR-100 GCD protocol', 'ImageNet-100 GCD protocol'];
  }
  return ['target-task validation protocol declared by the user'];
}

function experimentAblationsForSolution(solution = {}, cards = []) {
  return unique([
    ...(solution.ablation_suggestions || []),
    ...cards.map((card) => `Remove ${card.mechanism || card.candidate_id} and keep all other settings fixed.`)
  ].map(compactText).filter(Boolean)).slice(0, 10);
}

function experimentRequiredMaterials(solution = {}, review = {}, cards = []) {
  return unique([
    ...(solution.missing_evidence || []),
    ...(review.missing_evidence || []),
    ...cards.flatMap((card) => card.missing_evidence || []),
    ...(review.closest_prior_checks || []).some((entry) => normalizeComparable(entry).includes('missing'))
      ? 'closest prior novelty evidence'
      : ''
  ].map(compactText).filter(Boolean));
}

function buildExperimentPlanForReview(review = {}, solution = {}, overlay = {}, state = {}, args = {}) {
  const cardsById = methodCardsByCandidateId(overlay);
  const cards = (solution.source_candidate_ids || []).map((candidateId) => cardsById.get(candidateId)).filter(Boolean);
  const requiredMaterials = experimentRequiredMaterials(solution, review, cards);
  const planId = `experiment-plan:${stableHash(`${state.project || ''}:${state.task_id || ''}:${solution.solution_id}:${review.review_id || ''}`, 18)}`;
  return {
    experiment_plan_id: planId,
    solution_id: solution.solution_id,
    review_id: review.review_id || null,
    source_candidate_ids: solution.source_candidate_ids || [],
    status: 'planned_not_executed',
    execution_policy: {
      authority: 'plan_only',
      execution_status: 'not_executed',
      requires_separate_human_approval_before_running: true,
      allowed_actions: ['write_plan', 'compare_designs'],
      forbidden_actions: ['train_model', 'submit_job', 'mutate_raw_graph', 'claim_final_result']
    },
    design_review_decision: review.decision || 'revise',
    objective: solution.problem_claim || state.target_problem || 'Evaluate the reviewed solution sketch under target-task metrics.',
    hypothesis: solution.core_idea || 'The selected candidate mechanism improves the target subproblem under fair baselines.',
    datasets: experimentDatasetsForSolution(cards, state),
    metrics: experimentMetricsForSolution(solution, cards),
    baselines: experimentBaselinesForSolution(solution, cards),
    ablations: experimentAblationsForSolution(solution, cards),
    closest_prior_checks: review.closest_prior_checks || [],
    required_materials_before_run: requiredMaterials,
    discard_conditions: unique([...(solution.discard_conditions || []), ...(requiredMaterials.length ? ['Do not run until required materials are resolved or explicitly waived.'] : [])]),
    budget: {
      max_gpu_hours: Number(args.maxGpuHours ?? args.max_gpu_hours ?? 0) || null,
      max_imports: state.budget?.max_imports ?? 0,
      max_provider_queries: state.budget?.max_provider_queries ?? 0,
      note: 'Budget fields are planning constraints only; no compute or import is launched.'
    },
    evidence_boundaries: {
      evidence_supported: solution.evidence_boundaries?.evidence_supported || [],
      agent_inferred: unique([...(solution.evidence_boundaries?.agent_inferred || []), 'experiment plan design']),
      speculative: unique([...(solution.evidence_boundaries?.speculative || []), 'expected experimental outcome'])
    },
    generatedAt: nowIso()
  };
}

function buildExperimentPlanPack(overlay = {}, state = {}, args = {}) {
  const approval = experimentPlanningApproval(args);
  const solutions = solutionById(overlay);
  const eligibleReviews = (overlay.designReview?.reviews || [])
    .filter((review) => review.decision !== 'reject')
    .slice(0, experimentPlanLimit(args, state));
  const plans = eligibleReviews
    .map((review) => buildExperimentPlanForReview(review, solutions.get(review.solution_id) || {}, overlay, state, args))
    .filter((plan) => plan.solution_id);
  return {
    record_type: 'experiment_plan_pack',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    approval,
    execution_status: 'not_executed',
    plan_policy: {
      backend: 'controller_static_experiment_planner',
      authority: 'plan_only_after_explicit_approval',
      note: 'Experiment plans are planning artifacts only. They do not run training, submit jobs, import papers, or claim final results.'
    },
    plans,
    user_decision_needed: [
      'Review this plan before launching any real experiment.',
      'Resolve required materials or explicitly waive them before execution.',
      'Use a separate human-approved execution workflow for training or import actions.'
    ],
    generatedAt: nowIso()
  };
}

function renderExperimentPlanMarkdown(experimentPlan = {}) {
  const lines = [
    '# PaperNexus Experiment Plan',
    '',
    `- Project: ${experimentPlan.project || ''}`,
    `- Round: ${experimentPlan.round_id || ''}`,
    `- Plans: ${experimentPlan.plans?.length ?? 0}`,
    `- Execution status: ${experimentPlan.execution_status || 'not_executed'}`,
    '',
    '## Plans',
    ''
  ];
  for (const plan of experimentPlan.plans || []) {
    lines.push(`### ${plan.experiment_plan_id}`);
    lines.push('');
    lines.push(`- Solution: ${plan.solution_id || ''}`);
    lines.push(`- Review decision: ${plan.design_review_decision || ''}`);
    lines.push(`- Status: ${plan.status || ''}`);
    lines.push('');
    lines.push(plan.objective || '');
    lines.push('', 'Metrics:');
    for (const metric of plan.metrics || []) lines.push(`- ${metric}`);
    lines.push('', 'Baselines:');
    for (const baseline of plan.baselines || []) lines.push(`- ${baseline}`);
    lines.push('', 'Ablations:');
    for (const ablation of plan.ablations || []) lines.push(`- ${ablation}`);
    if (plan.required_materials_before_run?.length) {
      lines.push('', 'Required materials before run:');
      for (const item of plan.required_materials_before_run) lines.push(`- ${item}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function innovationBriefLimit(args = {}, state = {}) {
  const budget = normalizeObject(args.budget);
  return boundedInteger(
    args.maxInnovationBriefs ?? args.max_innovation_briefs ?? budget.max_innovation_briefs ?? budget.maxInnovationBriefs,
    Math.min(3, state.budget?.max_solution_sketches || 3),
    { min: 1, max: 8 }
  );
}

function reviewBySolutionId(overlay = {}) {
  return new Map((overlay.designReview?.reviews || []).map((review) => [review.solution_id, review]));
}

function subproblemName(value) {
  if (typeof value === 'string') return compactText(value);
  return compactText(value?.name || value?.subproblem || value?.title);
}

function methodCardsForSolution(solution = {}, overlay = {}) {
  const cardsById = methodCardsByCandidateId(overlay);
  return (solution.source_candidate_ids || []).map((candidateId) => cardsById.get(candidateId)).filter(Boolean);
}

function candidateRelationsForSolution(solution = {}, overlay = {}) {
  const candidateIds = solution.source_candidate_ids || [];
  const edgeIds = new Set(solution.source_edge_ids || []);
  return relationEdgesForCandidates(candidateIds, overlay)
    .filter((edge) => !edgeIds.size || edgeIds.has(edge.edge_id) || candidateIds.includes(edge.source_candidate_id) || candidateIds.includes(edge.target_candidate_id));
}

function innovationBriefTitle(solution = {}, cards = []) {
  const subproblems = unique(cards.map((card) => subproblemName(card.subproblem)).filter(Boolean));
  const mechanisms = unique(cards.map((card) => compactText(card.mechanism)).filter(Boolean));
  if (subproblems.length && mechanisms.length) return `${subproblems[0]} via ${mechanisms[0]}`;
  if (subproblems.length) return `Innovation brief for ${subproblems[0]}`;
  if (mechanisms.length) return `Innovation brief for ${mechanisms[0]}`;
  return `Innovation brief for ${solution.solution_id || 'selected solution'}`;
}

function briefEvidenceSupported(solution = {}, cards = [], relations = [], review = {}) {
  return unique([
    ...cards.flatMap((card) => [
      card.candidate_id ? `Selected candidate ${card.candidate_id}` : '',
      card.evidence?.evidence_tier ? `Candidate evidence tier: ${card.evidence.evidence_tier}` : '',
      ...(card.evidence?.graph_refs || []).map((ref) => `Graph ref: ${ref}`),
      ...(card.source_papers || []).map((paper) => `Source paper: ${paper.title || paper.paperTitle || paper.paper_id || paper.paperId || paper}`)
    ]),
    ...relations.map((edge) => `Candidate relation ${edge.edge_id}: ${(edge.relation_types || []).join(', ')}`),
    ...(review.closest_prior_evidence || []).map((item) => `Closest-prior comparison evidence: ${item.prior_title || item.prior_candidate_id || item.evidence_type || 'overlap signal'}`),
    ...(solution.evidence_boundaries?.evidence_supported || [])
  ].map(compactText).filter(Boolean));
}

function briefAgentInferred(solution = {}) {
  return unique([
    ...(solution.evidence_boundaries?.agent_inferred || []),
    'innovation brief synthesis from selected subgraphs',
    'proposed method wording',
    'expected gain framing'
  ].map(compactText).filter(Boolean));
}

function briefSpeculative(solution = {}) {
  return unique([
    ...(solution.evidence_boundaries?.speculative || []),
    'actual novelty until closest-prior checks are complete',
    'actual metric gain until experiments are run'
  ].map(compactText).filter(Boolean));
}

function buildInnovationBrief(solution = {}, overlay = {}, state = {}) {
  const cards = methodCardsForSolution(solution, overlay);
  const relations = candidateRelationsForSolution(solution, overlay);
  const reviews = reviewBySolutionId(overlay);
  const review = reviews.get(solution.solution_id) || {};
  const sourceCandidateIds = unique([...(solution.source_candidate_ids || []), ...cards.map((card) => card.candidate_id)].filter(Boolean));
  const sourceEdgeIds = unique([...(solution.source_edge_ids || []), ...relations.map((edge) => edge.edge_id)].filter(Boolean));
  const targetSubproblems = unique(cards.map((card) => subproblemName(card.subproblem)).filter(Boolean));
  const metrics = experimentMetricsForSolution(solution, cards);
  const baselines = experimentBaselinesForSolution(solution, cards);
  const datasets = experimentDatasetsForSolution(cards, state);
  const missingMaterials = unique([
    ...(solution.missing_evidence || []),
    ...(review.missing_evidence || []),
    ...cards.flatMap((card) => card.missing_evidence || [])
  ].map(compactText).filter(Boolean));
  const relationTypes = unique(relations.flatMap((edge) => edge.relation_types || []));
  const whyNotTrivial = relationTypes.length
    ? `The brief depends on candidate relations (${relationTypes.join(', ')}) and must preserve design-boundary checks, so it is not a free-form method mashup.`
    : 'The brief is constrained by selected subgraph evidence, design boundaries, baselines, ablations, and discard conditions.';
  return {
    record_type: 'innovation_brief',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    idea_id: `idea:${stableHash(`${state.project || ''}:${state.task_id || ''}:${solution.solution_id || ''}:${sourceCandidateIds.join('|')}`, 18)}`,
    solution_id: solution.solution_id || null,
    review_id: review.review_id || null,
    title: innovationBriefTitle(solution, cards),
    target_subproblems: targetSubproblems,
    source_candidate_ids: sourceCandidateIds,
    source_edge_ids: sourceEdgeIds,
    core_mechanism: solution.core_idea || solutionCoreIdea(cards, relations),
    proposed_method: {
      problem_claim: solution.problem_claim || solutionProblemClaim(state, cards),
      algorithm_flow: solution.algorithm_flow || [],
      module_interfaces: solution.module_interfaces || [],
      training_objective: solution.training_objective || solutionTrainingObjective(cards),
      inference_behavior: solution.inference_behavior || solutionInferenceBehavior(cards)
    },
    why_not_trivial: whyNotTrivial,
    what_is_evidence_supported: briefEvidenceSupported(solution, cards, relations, review),
    what_is_agent_inferred: briefAgentInferred(solution),
    what_is_speculative: briefSpeculative(solution),
    expected_gain: unique([
      ...(solution.expected_observations || []),
      review.evaluation_suggestion_quality ? `Design review evaluation quality: ${review.evaluation_suggestion_quality}` : ''
    ].map(compactText).filter(Boolean)),
    evaluation_plan: {
      datasets,
      metrics,
      baselines,
      closest_prior_checks: review.closest_prior_checks || []
    },
    ablation_plan: experimentAblationsForSolution(solution, cards),
    discard_conditions: unique(solution.discard_conditions || solutionDiscardConditions(cards)),
    main_risks: unique([
      review.highest_risk_assumption,
      review.novelty_risk ? `Novelty risk: ${review.novelty_risk}` : '',
      review.feasibility ? `Feasibility: ${review.feasibility}` : '',
      ...(review.design_boundary_review?.violations || [])
    ].map(compactText).filter(Boolean)),
    missing_materials: missingMaterials,
    next_action: missingMaterials.length
      ? 'Resolve missing materials or explicitly mark them waived before experiment planning or final direction selection.'
      : 'Ask a human to compare this brief against closest-prior evidence before any experiment execution.',
    status: review.decision === 'reject' ? 'rejected_by_design_review' : 'candidate_brief_for_human_review',
    generated_by: 'research_controller.compose_innovation_briefs.export_bound_synthesis',
    generatedAt: nowIso()
  };
}

function buildInnovationBriefPack(overlay = {}, state = {}, args = {}) {
  const limit = innovationBriefLimit(args, state);
  const sourceSolutions = (overlay.solutionSketches || [])
    .filter((solution) => solution.status !== 'rejected')
    .slice(0, limit);
  const briefs = sourceSolutions.map((solution) => buildInnovationBrief(solution, overlay, state));
  return {
    record_type: 'innovation_brief_pack',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: state.project || null,
    round_id: `round:${state.current_round ?? 0}`,
    brief_policy: {
      backend: 'controller_export_bound_brief',
      source: 'selected_subgraphs_solution_reviews',
      authority: 'downstream_ideation_seed_only',
      note: 'Innovation briefs are bounded ideation artifacts. They preserve evidence boundaries and are not final research directions.'
    },
    consumption_loop: [
      'Read selected subgraphs and method cards.',
      'Identify complement, prerequisite, conflict, and cost-coupled edges.',
      'Preserve design boundaries and reject variants that violate hard gates.',
      'Compare against baseline, metrics, ablations, closest-prior risk, and discard conditions.',
      'Return only candidate briefs for human review.'
    ],
    briefs,
    user_decision_needed: [
      'Review each innovation brief before treating it as a research direction.',
      'Resolve missing materials and closest-prior checks before experiment planning or execution.'
    ],
    generatedAt: nowIso()
  };
}

function renderInnovationBriefsMarkdown(briefPack = {}) {
  const lines = [
    '# PaperNexus Innovation Briefs',
    '',
    `- Project: ${briefPack.project || ''}`,
    `- Round: ${briefPack.round_id || ''}`,
    `- Briefs: ${briefPack.briefs?.length ?? 0}`,
    `- Authority: ${briefPack.brief_policy?.authority || 'downstream_ideation_seed_only'}`,
    '',
    '## Consumption Loop',
    ''
  ];
  for (const step of briefPack.consumption_loop || []) lines.push(`- ${step}`);
  lines.push('', '## Briefs', '');
  for (const brief of briefPack.briefs || []) {
    lines.push(`### ${brief.title || brief.idea_id}`);
    lines.push('');
    lines.push(`- Idea ID: ${brief.idea_id}`);
    lines.push(`- Status: ${brief.status}`);
    lines.push(`- Solution: ${brief.solution_id || ''}`);
    lines.push(`- Candidates: ${(brief.source_candidate_ids || []).join(', ')}`);
    lines.push(`- Edges: ${(brief.source_edge_ids || []).join(', ')}`);
    lines.push('');
    lines.push(`Core mechanism: ${brief.core_mechanism || ''}`);
    lines.push('');
    lines.push(`Why not trivial: ${brief.why_not_trivial || ''}`);
    if (brief.what_is_evidence_supported?.length) {
      lines.push('', 'Evidence-supported:');
      for (const item of brief.what_is_evidence_supported.slice(0, 12)) lines.push(`- ${item}`);
    }
    if (brief.what_is_agent_inferred?.length) {
      lines.push('', 'Agent-inferred:');
      for (const item of brief.what_is_agent_inferred.slice(0, 12)) lines.push(`- ${item}`);
    }
    if (brief.what_is_speculative?.length) {
      lines.push('', 'Speculative:');
      for (const item of brief.what_is_speculative.slice(0, 12)) lines.push(`- ${item}`);
    }
    if (brief.missing_materials?.length) {
      lines.push('', 'Missing materials:');
      for (const item of brief.missing_materials) lines.push(`- ${item}`);
    }
    lines.push('', `Next action: ${brief.next_action || ''}`, '');
  }
  return `${lines.join('\n')}\n`;
}

function isGcdMvpState(state = {}, validationContract = {}) {
  return state.budget?.task_family === 'gcd'
    || validationContract.task_family === 'gcd'
    || validationContract.corpus === 'GCD'
    || state.project === DEFAULT_GCD_PROJECT_ID;
}

function validationCriterion(criterionId, label, status, details = {}) {
  return {
    criterion_id: criterionId,
    label,
    status,
    ...details
  };
}

function passFailCriterion(criterionId, label, observed, required, pass, details = {}) {
  return validationCriterion(criterionId, label, pass ? 'pass' : 'fail', {
    observed,
    required,
    ...details
  });
}

function candidateSubproblemKeys(candidates = []) {
  return unique(candidates.map((candidate) => (
    compactText(candidate.subproblem?.name || candidate.subproblem?.subproblem_id || candidate.subproblem)
  )).filter(Boolean));
}

function selectedCandidateCount(selectedSubgraphs = {}) {
  return unique((selectedSubgraphs.subgraphs || []).flatMap((subgraph) => subgraph.candidate_ids || [])).length;
}

function externalRemoteValidationStatus(args = {}, validationContract = {}) {
  const externalInputs = normalizeObject(args.externalInputs || args.external_inputs);
  const payload = normalizeObject(
    externalInputs.gcd_mvp_remote_validation
    || externalInputs.gcdMvpRemoteValidation
    || externalInputs.remote_validation
    || externalInputs.remoteValidation
    || args.remoteValidation
    || args.remote_validation
  );
  if (!Object.keys(payload).length) {
    return {
      status: validationContract.validation_policy?.live_validation_required_for_completion
        ? 'blocked_unless_remote_mcp_callable'
        : 'not_required',
      source: 'controller_default',
      validation_surface: validationContract.validation_policy?.validation_surface || 'papernexus-remote.agent_materials(operation="research_controller")',
      local_substitute_allowed: false,
      note: 'This report does not substitute for a successful papernexus-remote MCP call.'
    };
  }
  const rawStatus = compactText(payload.status || payload.remote_validation_status || (payload.callable ? 'pass' : '')).toLowerCase();
  const status = ['pass', 'passed', 'ok', 'callable', 'success', 'succeeded'].includes(rawStatus)
    ? 'pass'
    : (['blocked', 'failed', 'fail', 'error'].includes(rawStatus) ? rawStatus.replace('failed', 'fail') : 'unknown');
  return {
    status,
    source: compactText(payload.source) || 'caller_supplied',
    validation_surface: compactText(payload.validation_surface || payload.surface) || validationContract.validation_policy?.validation_surface || 'papernexus-remote.agent_materials(operation="research_controller")',
    local_substitute_allowed: false,
    checked_at: payload.checked_at || payload.checkedAt || null,
    note: compactText(payload.note) || 'Caller-supplied remote validation metadata; keep evidence separate from local artifact checks.'
  };
}

function validationRecommendedActions(criteria = []) {
  const actionMap = {
    task_decomposition_coverage: ['generate_decomposition', 'review_decomposition'],
    candidate_node_minimum: ['generate_candidates'],
    candidate_subproblem_coverage: ['generate_candidates'],
    search_trace_available: ['generate_candidates'],
    candidate_edges_available: ['propose_edges'],
    judge_evidence_available: ['judge_batch'],
    selected_subgraphs_available: ['select_batch'],
    selection_trace_available: ['select_batch'],
    bandit_summary_available: ['select_batch'],
    method_card_pack_available: ['expand_evidence'],
    solution_sketches_available: ['compose_solutions'],
    design_reviews_available: ['design_review'],
    innovation_briefs_available: ['compose_innovation_briefs'],
    controller_export_available: ['export'],
    remote_mcp_smoke: ['validate_gcd_mvp']
  };
  return unique(criteria
    .filter((criterion) => ['fail', 'blocked', 'error', 'unknown'].includes(criterion.status))
    .flatMap((criterion) => actionMap[criterion.criterion_id] || []));
}

async function buildGcdMvpValidationReport(paths, overlay = {}, args = {}) {
  const state = overlay.controllerState || {};
  const validationContract = state.mvp_contract || mvpContractFor(args, paths, overlay.subproblemGraph || {});
  const isGcd = isGcdMvpState(state, validationContract);
  const candidates = overlay.candidateGraph?.nodes || [];
  const edges = overlay.candidateGraph?.edges || [];
  const subproblemKeys = candidateSubproblemKeys(candidates);
  const selectedSubgraphs = overlay.selectedSubgraphs || {};
  const selectedCount = selectedCandidateCount(selectedSubgraphs);
  const methodCardPack = selectedSubgraphs.method_card_pack || {};
  const controllerExport = await readJson(paths.controllerExportJsonPath, null);
  const requiredCandidateNodes = validationContract.required_min_candidate_nodes || 30;
  const requiredSubproblems = validationContract.required_min_subproblems || 5;
  const remoteValidationStatus = externalRemoteValidationStatus(args, validationContract);
  const artifactCounts = {
    task_spec_variant_count: overlay.taskSpecVariants?.variants?.length || 0,
    subproblem_count: overlay.subproblemGraph?.subproblems?.length || 0,
    candidate_node_count: candidates.length,
    candidate_edge_count: edges.length,
    distinct_candidate_subproblem_count: subproblemKeys.length,
    judge_decision_count: overlay.judgeDecisions?.length || 0,
    selected_subgraph_count: selectedSubgraphs.subgraphs?.length || 0,
    selected_candidate_count: selectedCount,
    solution_sketch_count: overlay.solutionSketches?.length || 0,
    design_review_count: overlay.designReview?.reviews?.length || 0,
    innovation_brief_count: overlay.innovationBriefs?.briefs?.length || 0,
    material_result_count: overlay.materialExpansionResults?.length || 0,
    method_card_count: methodCardPack.method_cards?.length || 0,
    risk_note_count: overlay.riskNotes?.length || 0
  };
  if (!isGcd) {
    const criteria = [
      validationCriterion('gcd_task_family', 'Controller state is a GCD MVP task', 'not_applicable', {
        observed: state.budget?.task_family || validationContract.task_family || null,
        required: 'gcd'
      })
    ];
    return {
      record_type: 'gcd_mvp_validation',
      version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
      project: paths.project,
      round_id: state.current_round !== undefined ? `round:${state.current_round}` : null,
      validation_id: `gcd-mvp-validation:${stableHash(`${paths.project}:not-applicable:${nowIso()}`, 16)}`,
      overall_status: 'not_applicable',
      local_artifact_status: 'not_applicable',
      validation_policy: validationContract.validation_policy || {},
      artifact_counts: artifactCounts,
      criteria,
      remote_validation_status: remoteValidationStatus,
      recommended_next_actions: [],
      user_decision_needed: ['Run this action on the GCD MVP project only.'],
      warnings: ['validate_gcd_mvp was called for a non-GCD controller state.'],
      generatedAt: nowIso()
    };
  }

  const criteria = [
    passFailCriterion(
      'task_decomposition_coverage',
      'Selected decomposition has at least the required GCD subproblems',
      artifactCounts.subproblem_count,
      requiredSubproblems,
      artifactCounts.subproblem_count >= requiredSubproblems,
      { artifact_path: paths.subproblemGraphPath }
    ),
    passFailCriterion(
      'candidate_node_minimum',
      'CandidateGraph has the GCD MVP minimum candidate nodes',
      artifactCounts.candidate_node_count,
      requiredCandidateNodes,
      artifactCounts.candidate_node_count >= requiredCandidateNodes,
      { artifact_path: paths.candidateGraphPath }
    ),
    passFailCriterion(
      'candidate_subproblem_coverage',
      'CandidateGraph covers the required number of distinct subproblems',
      artifactCounts.distinct_candidate_subproblem_count,
      requiredSubproblems,
      artifactCounts.distinct_candidate_subproblem_count >= requiredSubproblems,
      { observed_subproblems: subproblemKeys, artifact_path: paths.candidateGraphPath }
    ),
    validationCriterion('search_trace_available', 'search-trace.json exists and records candidate provenance', overlay.searchTrace?.trace_id ? 'pass' : 'fail', {
      observed: overlay.searchTrace?.trace_id || null,
      required: 'trace_id',
      artifact_path: paths.searchTracePath
    }),
    passFailCriterion('candidate_edges_available', 'Lazy candidate edges are available', artifactCounts.candidate_edge_count, 1, artifactCounts.candidate_edge_count >= 1, {
      artifact_path: paths.candidateGraphPath
    }),
    passFailCriterion('judge_evidence_available', 'Judge decisions are stored as evidence', artifactCounts.judge_decision_count, 1, artifactCounts.judge_decision_count >= 1, {
      artifact_path: paths.judgeDecisionsPath
    }),
    passFailCriterion('selected_subgraphs_available', 'Selected subgraphs are available for deeper analysis', artifactCounts.selected_subgraph_count, 2, artifactCounts.selected_subgraph_count >= 2, {
      selected_candidate_count: selectedCount,
      artifact_path: paths.selectedSubgraphsPath
    }),
    validationCriterion('selection_trace_available', 'selection-trace.json records top-k/MMR/greedy-submodular traces', overlay.selectionTrace?.trace_id ? 'pass' : 'fail', {
      observed: overlay.selectionTrace?.trace_id || null,
      required: 'trace_id',
      artifact_path: paths.selectionTracePath
    }),
    validationCriterion('bandit_summary_available', 'bandit-simulation.json records offline source-domain/mechanism proxy simulation', overlay.banditSimulation?.record_type ? 'pass' : 'fail', {
      observed: overlay.banditSimulation?.policy || null,
      required: 'offline proxy simulation',
      artifact_path: paths.banditSimulationPath
    }),
    validationCriterion('method_card_pack_available', 'Selected-candidate method-card pack exists', overlay.methodCardPackText || artifactCounts.method_card_count ? 'pass' : 'fail', {
      observed: artifactCounts.method_card_count || (overlay.methodCardPackText ? 'markdown_available' : 0),
      required: 'method-card-pack.md',
      artifact_path: paths.methodCardPackPath
    }),
    passFailCriterion('solution_sketches_available', 'GCD MVP produces at least two solution sketches', artifactCounts.solution_sketch_count, 2, artifactCounts.solution_sketch_count >= 2, {
      artifact_path: paths.solutionSketchesPath
    }),
    passFailCriterion('design_reviews_available', 'Design reviews are available for solution sketches', artifactCounts.design_review_count, Math.min(Math.max(artifactCounts.solution_sketch_count, 1), 3), artifactCounts.design_review_count >= Math.min(Math.max(artifactCounts.solution_sketch_count, 1), 3), {
      artifact_path: paths.designReviewPath
    }),
    passFailCriterion('innovation_briefs_available', 'Bounded innovation briefs are available for downstream Agents', artifactCounts.innovation_brief_count, 1, artifactCounts.innovation_brief_count >= 1, {
      artifact_path: paths.innovationBriefsPath
    }),
    validationCriterion('controller_export_available', 'controller-export.json exists for external Agent consumption', controllerExport?.record_type === 'controller_export' ? 'pass' : 'fail', {
      observed: controllerExport?.export_id || null,
      required: 'controller_export',
      artifact_path: paths.controllerExportJsonPath
    }),
    validationCriterion('remote_mcp_smoke', 'GCD MVP smoke is validated through papernexus-remote MCP', remoteValidationStatus.status === 'pass' ? 'pass' : 'blocked', {
      observed: remoteValidationStatus.status,
      required: 'successful papernexus-remote MCP call',
      validation_surface: remoteValidationStatus.validation_surface,
      local_substitute_allowed: false,
      note: remoteValidationStatus.note
    })
  ];
  const passed = criteria.filter((criterion) => criterion.status === 'pass');
  const failed = criteria.filter((criterion) => criterion.status === 'fail');
  const blocked = criteria.filter((criterion) => criterion.status === 'blocked');
  const localFailed = failed.filter((criterion) => criterion.criterion_id !== 'remote_mcp_smoke');
  const localArtifactStatus = localFailed.length ? 'needs_input' : 'ok';
  const overallStatus = localFailed.length
    ? 'needs_input'
    : (blocked.length ? 'blocked' : 'ok');
  const warnings = [];
  if (paths.project !== DEFAULT_GCD_PROJECT_ID) {
    warnings.push(`GCD MVP validation is running on project "${paths.project}", not the default "${DEFAULT_GCD_PROJECT_ID}".`);
  }
  if (localFailed.length) {
    warnings.push('One or more local overlay artifacts are missing or below the GCD MVP threshold.');
  }
  if (blocked.length) {
    warnings.push('Remote GCD smoke validation is blocked until papernexus-remote is callable and this action is run through MCP.');
  }
  const recommendedNextActions = validationRecommendedActions(criteria);
  return {
    record_type: 'gcd_mvp_validation',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project,
    round_id: state.current_round !== undefined ? `round:${state.current_round}` : null,
    validation_id: `gcd-mvp-validation:${stableHash(`${paths.project}:${state.current_round ?? 0}:${criteria.map((criterion) => `${criterion.criterion_id}:${criterion.status}:${criterion.observed}`).join('|')}`, 16)}`,
    overall_status: overallStatus,
    local_artifact_status: localArtifactStatus,
    validation_policy: {
      ...(validationContract.validation_policy || {}),
      controller_action: 'validate_gcd_mvp',
      local_report_is_not_remote_smoke: true
    },
    mvp_contract: validationContract,
    artifact_counts: artifactCounts,
    criteria,
    summary: {
      passed_criteria_count: passed.length,
      failed_criteria_count: failed.length,
      blocked_criteria_count: blocked.length,
      local_failed_criteria: localFailed.map((criterion) => criterion.criterion_id),
      blocked_criteria: blocked.map((criterion) => criterion.criterion_id)
    },
    remote_validation_status: remoteValidationStatus,
    recommended_next_actions: recommendedNextActions,
    user_decision_needed: unique([
      ...(localFailed.length ? ['Run the recommended controller actions, then rerun validate_gcd_mvp.'] : []),
      ...(blocked.length ? ['Fix or reload papernexus-remote MCP, then rerun validate_gcd_mvp through agent_materials(operation="research_controller").'] : []),
      ...(overallStatus === 'ok' ? ['Review the validation report and controller export before treating the GCD MVP as covered.'] : [])
    ]),
    warnings,
    generatedAt: nowIso()
  };
}

function renderGcdMvpValidationMarkdown(validationReport = {}) {
  const lines = [
    '# PaperNexus GCD MVP Validation',
    '',
    `- Project: ${validationReport.project || ''}`,
    `- Round: ${validationReport.round_id || ''}`,
    `- Status: ${validationReport.overall_status || ''}`,
    `- Local artifacts: ${validationReport.local_artifact_status || ''}`,
    `- Remote validation: ${validationReport.remote_validation_status?.status || ''}`,
    '',
    '## Artifact Counts',
    ''
  ];
  for (const [key, value] of Object.entries(validationReport.artifact_counts || {})) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('', '## Criteria', '');
  for (const criterion of validationReport.criteria || []) {
    lines.push(`- ${criterion.status}: ${criterion.criterion_id} - ${criterion.label}`);
    if (criterion.observed !== undefined) lines.push(`  - Observed: ${Array.isArray(criterion.observed) ? criterion.observed.join(', ') : criterion.observed}`);
    if (criterion.required !== undefined) lines.push(`  - Required: ${criterion.required}`);
    if (criterion.artifact_path) lines.push(`  - Artifact: ${criterion.artifact_path}`);
    if (criterion.note) lines.push(`  - Note: ${criterion.note}`);
  }
  lines.push('', '## Recommended Next Actions', '');
  for (const action of validationReport.recommended_next_actions || []) {
    lines.push(`- ${action}`);
  }
  lines.push('', '## User Decision Needed', '');
  for (const item of validationReport.user_decision_needed || []) {
    lines.push(`- ${item}`);
  }
  lines.push('', '## Warnings', '');
  for (const warning of validationReport.warnings || []) {
    lines.push(`- ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeInitialArtifacts(paths, args = {}) {
  const taskSpecVariants = buildTaskSpecVariants(args, paths);
  const subproblemGraph = buildSubproblemGraph(args, taskSpecVariants, paths);
  const decompositionReview = buildDecompositionReview(args, subproblemGraph, paths);
  const controllerState = buildControllerState(args, taskSpecVariants, subproblemGraph, paths);
  const roundReport = buildRoundReport(controllerState, taskSpecVariants, subproblemGraph, decompositionReview);
  await ensureDir(paths.root);
  await writeJson(paths.taskSpecVariantsPath, taskSpecVariants);
  await writeJson(paths.subproblemGraphPath, subproblemGraph);
  await writeJson(paths.decompositionReviewPath, decompositionReview);
  await writeJson(paths.controllerStatePath, controllerState);
  await writeJson(paths.roundReportPath, roundReport);
  await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(controllerState, subproblemGraph, decompositionReview));
  await writeJson(paths.selectedSubgraphsPath, {
    record_type: 'selected_subgraphs',
    version: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    project: paths.project,
    round_id: `round:${controllerState.current_round}`,
    subgraphs: [],
    generatedAt: nowIso()
  });
  return {
    taskSpecVariants,
    subproblemGraph,
    decompositionReview,
    controllerState,
    roundReport
  };
}

function controllerExportFromOverlay(paths, overlay = {}) {
  const state = overlay.controllerState || {};
  const variants = overlay.taskSpecVariants?.variants || [];
  const selectedVariant = variants.find((variant) => variant.task_spec_id === overlay.taskSpecVariants?.selected_task_spec_id) || variants[0] || null;
  const selectedSubgraphs = overlay.selectedSubgraphs?.subgraphs || [];
  const candidateNodes = overlay.candidateGraph?.nodes || [];
  const methodCardPack = overlay.selectedSubgraphs?.method_card_pack || null;
  const decompositionBackend = state.decomposition_generation?.backend
    || state.llm_assistance?.decomposition_generation
    || 'deterministic_or_unrecorded';
  const decompositionReviewBackend = state.decomposition_review?.backend
    || state.llm_assistance?.decomposition_review
    || 'pending_or_unrecorded';
  return {
    record_type: 'controller_export',
    contractVersion: RESEARCH_CONTROLLER_CONTRACT_VERSION,
    export_id: `controller-export:${stableHash(`${paths.project}:${state.current_round ?? 'empty'}:${state.updated_at || ''}`, 16)}`,
    project: paths.project,
    round_id: state.current_round !== undefined ? `round:${state.current_round}` : null,
    created_at: nowIso(),
    budget: state.budget || null,
    provider_policy: state.provider_policy || null,
    posterior: state.posterior || overlay.selectedSubgraphs?.posterior || null,
    task_spec: {
      selected_task_spec_id: overlay.taskSpecVariants?.selected_task_spec_id || null,
      summary: selectedVariant ? {
        target_domain: selectedVariant.target_domain,
        target_problem: selectedVariant.target_problem,
        task_goal: selectedVariant.task_goal,
        constraints: selectedVariant.constraints || [],
        design_boundaries: selectedVariant.design_boundaries || []
      } : null,
      uncertainty_notes: selectedVariant?.uncertainty_notes || []
    },
    subproblem_graph: {
      decomposition_version: overlay.subproblemGraph?.decomposition_version || null,
      subproblem_summaries: (overlay.subproblemGraph?.subproblems || []).map((subproblem) => ({
        subproblem_id: subproblem.subproblem_id,
        name: subproblem.name,
        abstract_challenge: subproblem.abstract_challenge,
        failure_modes: subproblem.failure_modes || [],
        metrics: subproblem.metrics || [],
        query_plan: subproblem.query_plan || []
      })),
      dependency_summary: overlay.subproblemGraph?.dependencies || [],
      critic_questions: overlay.decompositionReview?.critic_questions || [],
      post_evidence_drift_review: overlay.decompositionReview?.post_evidence_drift_review || null
    },
    search_trace_summary: overlay.searchTrace ? {
      trace_id: overlay.searchTrace.trace_id,
      policy: overlay.searchTrace.policy,
      candidate_count: overlay.searchTrace.candidate_count,
      finalized_state_count: overlay.searchTrace.finalized_state_ids?.length || 0,
      requisition_state_count: overlay.searchTrace.requisition_state_ids?.length || 0,
      distinct_challenge_aspect_count: overlay.searchTrace.distinct_challenge_aspect_count,
      distinct_mechanism_count: overlay.searchTrace.distinct_mechanism_count,
      requisition_rate: overlay.searchTrace.requisition_rate,
      depths: overlay.searchTrace.depths || []
    } : (state.search_trace_summary || null),
    selection_trace_summary: overlay.selectionTrace ? {
      trace_id: overlay.selectionTrace.trace_id,
      selector: overlay.selectionTrace.selector,
      feature_universe: overlay.selectionTrace.feature_universe,
      ablation_summary: overlay.selectionTrace.ablation_summary,
      selectors: (overlay.selectionTrace.selectors || []).map((selector) => ({
        selector: selector.selector,
        k: selector.k,
        lambda: selector.lambda ?? null,
        selected_candidate_ids: (selector.selected || []).map((entry) => entry.candidate_id)
      }))
    } : (state.selection_trace_summary || null),
    bandit_state_summary: overlay.banditSimulation || state.bandit_state_summary || null,
    candidate_subgraphs: {
      selected: selectedSubgraphs,
      parked: (overlay.selectedSubgraphs?.parked || candidateNodes.filter((candidate) => ['proposed', 'needs_evidence', 'parked'].includes(candidate.status))).slice(0, 50),
      rejected_summary: overlay.selectedSubgraphs?.rejected || []
    },
    method_cards: candidateNodes.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      search_state_id: candidate.search_state_id || candidate.evidence?.search_state_id || null,
      subproblem: candidate.subproblem,
      mechanism: candidate.mechanism,
      method_summary: candidate.method_summary,
      method_card: candidate.method_card,
      adaptation_plan: candidate.adaptation_plan,
      evaluation_plan: candidate.evaluation_plan,
      evidence: candidate.evidence,
      labels: candidate.labels,
      status: candidate.status
    })),
    selected_method_cards: methodCardPack?.method_cards || [],
    method_card_pack: methodCardPack ? {
      available: true,
      path: paths.methodCardPackPath,
      selected_subgraph_count: methodCardPack.selected_subgraph_count || 0,
      method_card_count: methodCardPack.method_cards?.length || 0,
      material_result_count: methodCardPack.material_result_count || overlay.materialExpansionResults?.length || 0,
      fulfilled_material_expansion_request_count: methodCardPack.fulfilled_material_expansion_request_count || 0,
      missing_evidence: methodCardPack.missing_evidence || [],
      expansion_policy: methodCardPack.expansion_policy || null,
      next_material_requests: methodCardPack.next_material_requests || [],
      material_expansion_requests: methodCardPack.material_expansion_requests || []
    } : {
      available: Boolean(overlay.methodCardPackText),
      path: paths.methodCardPackPath,
      selected_subgraph_count: selectedSubgraphs.length,
      method_card_count: 0,
      material_result_count: overlay.materialExpansionResults?.length || 0,
      fulfilled_material_expansion_request_count: 0,
      missing_evidence: [],
      expansion_policy: null,
      next_material_requests: [],
      material_expansion_requests: []
    },
    candidate_relations: overlay.candidateGraph?.edges || [],
    material_expansion_results: overlay.materialExpansionResults || [],
    solution_sketches: overlay.solutionSketches || [],
    design_review_pack: overlay.designReview || null,
    design_reviews: overlay.designReview?.reviews || [],
    decomposition_drift_review: overlay.decompositionReview?.post_evidence_drift_review
      || overlay.designReview?.decomposition_drift_review
      || null,
    closest_prior_expansion_requests: overlay.designReview?.closest_prior_expansion_requests || [],
    closest_prior_result_count: overlay.designReview?.closest_prior_result_count || 0,
    fulfilled_closest_prior_expansion_request_count: overlay.designReview?.fulfilled_closest_prior_expansion_request_count || 0,
    innovation_brief_pack: overlay.innovationBriefs || null,
    innovation_briefs: overlay.innovationBriefs?.briefs || [],
    experiment_plan_pack: overlay.experimentPlan || null,
    experiment_plans: overlay.experimentPlan?.plans || [],
    gcd_mvp_validation: overlay.gcdMvpValidation || null,
    judge_trace_summary: {
      decision_count: overlay.judgeDecisions?.length || 0,
      latest_decisions: (overlay.judgeDecisions || []).slice(-20).map((decision) => ({
        decision_id: decision.decision_id,
        judge_run_id: decision.judge_run_id,
        decision_scope: decision.decision_scope,
        target_id: decision.target_id,
        verdict: decision.verdict,
        scores: decision.scores || null,
        valid_relation_types: decision.valid_relation_types || null,
        confidence: decision.confidence ?? null,
        rationale: decision.rationale || null,
        missing_evidence: decision.missing_evidence || [],
        judge: decision.judge || null
      }))
    },
    evidence_boundaries: {
      evidence_supported: [],
      agent_inferred: [
        `Task variants and decomposition are controller overlay artifacts generated via ${decompositionBackend}; they are task framing evidence, not paper facts.`,
        `Decomposition review source: ${decompositionReviewBackend}. Treat critic questions as gates before deep retrieval or experiment planning.`,
      'Selected method-card packs are graph/material expansions and still separate evidence-supported fields from Agent-inferred or speculative fields.'
      ],
      speculative: []
    },
    risks: overlay.riskNotes || [],
    user_decision_needed: [
      'Review task framing and decomposition before enabling graph-grounded candidate generation.',
      ...(overlay.decompositionReview?.post_evidence_drift_review?.requires_revisit ? ['Post-evidence drift signals require decomposition review before promotion or experiment planning.'] : []),
      ...(overlay.designReview?.user_decision_needed || []),
      'Approve provider evidence, literature discovery imports, or real experiments before they are enabled.'
    ],
    next_material_requests: [
      ...(state.next_actions || []),
      ...(methodCardPack?.next_material_requests || []),
      ...(methodCardPack?.material_expansion_requests || []),
      ...(overlay.designReview?.closest_prior_expansion_requests || [])
    ],
    artifact_paths: publicArtifactPaths(paths)
  };
}

function renderControllerExportMarkdown(exportPayload = {}) {
  const lines = [
    '# PaperNexus Research Controller Export',
    '',
    `- Project: ${exportPayload.project || ''}`,
    `- Round: ${exportPayload.round_id || ''}`,
    `- Target domain: ${exportPayload.task_spec?.summary?.target_domain || ''}`,
    `- Target problem: ${exportPayload.task_spec?.summary?.target_problem || ''}`,
    `- Budget profile: ${exportPayload.budget?.profile || ''}`,
    '',
    '## Subproblems',
    ''
  ];
  for (const subproblem of exportPayload.subproblem_graph?.subproblem_summaries || []) {
    lines.push(`- ${subproblem.name}: ${subproblem.abstract_challenge}`);
  }
  if (exportPayload.search_trace_summary) {
    const trace = exportPayload.search_trace_summary;
    lines.push('', '## Search Trace', '');
    lines.push(`- Policy: ${trace.policy || ''}`);
    lines.push(`- Candidates: ${trace.candidate_count ?? 0}`);
    lines.push(`- Finalized states: ${trace.finalized_state_count ?? 0}`);
    lines.push(`- Requisitioned states: ${trace.requisition_state_count ?? 0}`);
    lines.push(`- Requisition rate: ${trace.requisition_rate ?? 0}`);
  }
  if (exportPayload.selection_trace_summary) {
    const trace = exportPayload.selection_trace_summary;
    lines.push('', '## Selection Trace', '');
    lines.push(`- Selector: ${trace.selector || ''}`);
    for (const selector of trace.selectors || []) {
      lines.push(`- ${selector.selector}: ${(selector.selected_candidate_ids || []).join(', ')}`);
    }
  }
  if (exportPayload.bandit_state_summary?.arms?.length) {
    lines.push('', '## Offline Bandit Summary', '');
    lines.push(`- Policy: ${exportPayload.bandit_state_summary.policy || ''}`);
    for (const arm of (exportPayload.bandit_state_summary.top_ucb_arms || []).slice(0, 8)) {
      lines.push(`- ${arm.arm_id}: ucb=${arm.ucb_index}, mean=${arm.mean_reward}, uncertainty=${arm.uncertainty}`);
    }
  }
  if (exportPayload.decomposition_drift_review) {
    const drift = exportPayload.decomposition_drift_review;
    lines.push('', '## Post-Evidence Decomposition Drift', '');
    lines.push(`- Status: ${drift.status || 'none'}`);
    lines.push(`- Signals: ${drift.signal_count ?? 0}`);
    lines.push(`- Requires revisit: ${drift.requires_revisit ? 'yes' : 'no'}`);
    if (drift.recommendation) lines.push(`- Recommendation: ${drift.recommendation}`);
    for (const signal of drift.signals || []) {
      lines.push(`- ${signal.severity || 'medium'}: ${signal.reason || signal.signal_type || ''}`);
    }
  }
  if (exportPayload.candidate_subgraphs?.selected?.length) {
    lines.push('', '## Selected Subgraphs', '');
    for (const subgraph of exportPayload.candidate_subgraphs.selected.slice(0, 20)) {
      lines.push(`- ${subgraph.primary_candidate_id}: utility ${subgraph.utility ?? ''}`);
      if (subgraph.selection_rationale) lines.push(`  - ${subgraph.selection_rationale}`);
    }
  }
  if (exportPayload.method_cards?.length) {
    lines.push('', '## Candidate Method Cards', '');
    for (const card of exportPayload.method_cards.slice(0, 20)) {
      lines.push(`- ${card.candidate_id}: ${card.mechanism || 'unknown mechanism'}`);
      if (card.method_summary) lines.push(`  - ${card.method_summary}`);
    }
  }
  if (exportPayload.method_card_pack?.available) {
    lines.push('', '## Selected Method Card Pack', '');
    lines.push(`- Path: ${exportPayload.method_card_pack.path || ''}`);
    lines.push(`- Method cards: ${exportPayload.method_card_pack.method_card_count ?? 0}`);
    lines.push(`- Material expansion results: ${exportPayload.method_card_pack.material_result_count ?? 0}`);
    for (const item of exportPayload.method_card_pack.missing_evidence || []) {
      lines.push(`- Missing evidence: ${item}`);
    }
  }
  if (exportPayload.posterior?.backend) {
    lines.push('', '## Dueling Posterior', '');
    lines.push(`- Backend: ${exportPayload.posterior.backend}`);
    lines.push(`- Status: ${exportPayload.posterior.update_status || ''}`);
    lines.push(`- Pairwise decisions: ${exportPayload.posterior.total_pairwise_decisions ?? 0}`);
    for (const candidate of exportPayload.posterior.top_candidates || []) {
      lines.push(`- ${candidate.candidate_id}: mean=${candidate.posterior_mean ?? ''}, uncertainty=${candidate.uncertainty ?? ''}, index=${candidate.selection_index ?? ''}`);
    }
  }
  if (exportPayload.material_expansion_results?.length) {
    lines.push('', '## Material Expansion Results', '');
    for (const result of exportPayload.material_expansion_results.slice(0, 20)) {
      lines.push(`- ${result.operation || 'material_result'}: ${result.candidate_id || ''} status=${result.status || ''}`);
      if (result.request_id) lines.push(`  - Request: ${result.request_id}`);
    }
  }
  if (exportPayload.selected_method_cards?.length) {
    lines.push('', '## Selected Method Cards', '');
    for (const card of exportPayload.selected_method_cards.slice(0, 20)) {
      lines.push(`- ${card.candidate_id}: ${card.baseline_comparability?.status || 'unknown'} baseline comparability`);
      if (card.missing_evidence?.length) lines.push(`  - Missing: ${card.missing_evidence.join(', ')}`);
    }
  }
  if (exportPayload.candidate_relations?.length) {
    lines.push('', '## Candidate Relations', '');
    for (const relation of exportPayload.candidate_relations.slice(0, 30)) {
      lines.push(`- ${relation.source_candidate_id} -> ${relation.target_candidate_id}: ${(relation.relation_types || []).join(', ')}`);
      if (relation.rationale) lines.push(`  - ${relation.rationale}`);
    }
  }
  if (exportPayload.solution_sketches?.length) {
    lines.push('', '## Solution Sketches', '');
    for (const sketch of exportPayload.solution_sketches.slice(0, 10)) {
      lines.push(`- ${sketch.solution_id}: ${sketch.status || ''}`);
      if (sketch.core_idea) lines.push(`  - ${sketch.core_idea}`);
    }
  }
  if (exportPayload.design_reviews?.length) {
    lines.push('', '## Design Reviews', '');
    for (const review of exportPayload.design_reviews.slice(0, 10)) {
      lines.push(`- ${review.solution_id}: ${review.decision}`);
      if (review.main_reason) lines.push(`  - ${review.main_reason}`);
      if (review.closest_prior_evidence?.length) {
        lines.push(`  - Closest prior evidence: ${review.closest_prior_evidence.length}`);
      }
    }
  }
  if (exportPayload.innovation_briefs?.length) {
    lines.push('', '## Innovation Briefs', '');
    for (const brief of exportPayload.innovation_briefs.slice(0, 10)) {
      lines.push(`- ${brief.idea_id}: ${brief.title || ''}`);
      lines.push(`  - Status: ${brief.status || ''}`);
      if (brief.core_mechanism) lines.push(`  - Core mechanism: ${brief.core_mechanism}`);
      if (brief.missing_materials?.length) lines.push(`  - Missing: ${brief.missing_materials.join(', ')}`);
    }
  }
  if (exportPayload.closest_prior_expansion_requests?.length) {
    lines.push('', '## Closest Prior Expansion Requests', '');
    lines.push(`- Fulfilled requests: ${exportPayload.fulfilled_closest_prior_expansion_request_count ?? 0}`);
    for (const request of exportPayload.closest_prior_expansion_requests.slice(0, 20)) {
      lines.push(`- ${request.request_id}: ${request.status}`);
      lines.push(`  - Operation: ${request.operation}`);
      lines.push(`  - Approval required: ${request.approval_required ? 'yes' : 'no'}`);
      if (request.result_id) lines.push(`  - Result: ${request.result_id} (${request.result_status || 'ok'})`);
    }
  }
  if (exportPayload.experiment_plans?.length) {
    lines.push('', '## Experiment Plans', '');
    for (const plan of exportPayload.experiment_plans.slice(0, 10)) {
      lines.push(`- ${plan.solution_id}: ${plan.status || 'planned_not_executed'}`);
      lines.push(`  - Execution: ${plan.execution_policy?.execution_status || 'not_executed'}`);
    }
  }
  if (exportPayload.gcd_mvp_validation) {
    const validation = exportPayload.gcd_mvp_validation;
    lines.push('', '## GCD MVP Validation', '');
    lines.push(`- Status: ${validation.overall_status || ''}`);
    lines.push(`- Local artifacts: ${validation.local_artifact_status || ''}`);
    lines.push(`- Remote validation: ${validation.remote_validation_status?.status || ''}`);
    lines.push(`- Passed criteria: ${validation.summary?.passed_criteria_count ?? 0}`);
    lines.push(`- Failed criteria: ${validation.summary?.failed_criteria_count ?? 0}`);
    lines.push(`- Blocked criteria: ${validation.summary?.blocked_criteria_count ?? 0}`);
  }
  if (exportPayload.judge_trace_summary?.latest_decisions?.length) {
    lines.push('', '## Judge Decisions', '');
    for (const decision of exportPayload.judge_trace_summary.latest_decisions.slice(0, 20)) {
      lines.push(`- ${decision.target_id}: ${decision.verdict}`);
      if (decision.rationale) lines.push(`  - ${decision.rationale}`);
    }
  }
  lines.push('', '## Evidence Boundaries', '');
  for (const note of exportPayload.evidence_boundaries?.agent_inferred || []) {
    lines.push(`- Agent-inferred: ${note}`);
  }
  lines.push('', '## User Decision Needed', '');
  for (const decision of exportPayload.user_decision_needed || []) {
    lines.push(`- ${decision}`);
  }
  lines.push('', '## Next Material Requests', '');
  for (const action of exportPayload.next_material_requests || []) {
    if (typeof action === 'string') {
      lines.push(`- ${action}`);
    } else {
      lines.push(`- ${action.operation || 'material_request'}: ${action.candidate_id || ''} ${action.paperId || action.paperTitle || ''}`.trim());
    }
  }
  return `${lines.join('\n')}\n`;
}

async function writeControllerExport(paths, overlay = {}) {
  const exportPayload = controllerExportFromOverlay(paths, overlay);
  await writeJson(paths.controllerExportJsonPath, exportPayload);
  await writeText(paths.controllerExportMarkdownPath, renderControllerExportMarkdown(exportPayload));
  return exportPayload;
}

async function executeStatus(paths) {
  const overlay = await loadControllerOverlay(paths);
  return baseResponse('status', paths, overlay, overlay.controllerState, {
    status: overlay.controllerState ? 'ok' : 'needs_input',
    summary: {
      selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
      top_risks: overlay.riskNotes || [],
      missing_evidence: [],
      next_actions: overlay.controllerState?.next_actions || ['init_task']
    },
    user_decision_needed: overlay.controllerState ? [] : ['Initialize the research controller with init_task or run_round.'],
    warnings: overlay.controllerState ? [] : ['No controller-state.json exists for this project yet.']
  });
}

async function executeInitTask(paths, args = {}) {
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overwrite = booleanFlag(args.overwrite, false);
  const existing = await readJson(paths.controllerStatePath, null);
  if (existing && !overwrite) {
    const overlay = await loadControllerOverlay(paths);
    return baseResponse('init_task', paths, overlay, existing, {
      status: 'ok',
      action_completed: 'init_task_existing',
      warnings: ['Controller already initialized; pass overwrite=true to regenerate foundation artifacts.']
    });
  }

  let created;
  if (dryRun) {
    const taskSpecVariants = buildTaskSpecVariants(args, paths);
    const subproblemGraph = buildSubproblemGraph(args, taskSpecVariants, paths);
    const decompositionReview = buildDecompositionReview(args, subproblemGraph, paths);
    const controllerState = buildControllerState(args, taskSpecVariants, subproblemGraph, paths);
    created = {
      taskSpecVariants,
      subproblemGraph,
      decompositionReview,
      controllerState,
      roundReport: buildRoundReport(controllerState, taskSpecVariants, subproblemGraph, decompositionReview)
    };
  } else {
    await withFileLock(paths.lockPath, async () => {
      created = await writeInitialArtifacts(paths, args);
    });
  }

  const overlay = dryRun
    ? {
        taskSpecVariants: created.taskSpecVariants,
        subproblemGraph: created.subproblemGraph,
        decompositionReview: created.decompositionReview,
        candidateGraph: { nodes: [], edges: [] },
        judgeDecisions: [],
        controllerState: created.controllerState,
        roundReport: created.roundReport,
        selectedSubgraphs: { subgraphs: [] },
        solutionSketches: [],
        designReview: null,
        riskNotes: []
      }
    : await loadControllerOverlay(paths);

  return baseResponse('init_task', paths, overlay, created.controllerState, {
    status: 'ok',
    warnings: dryRun ? ['Dry run: foundation artifacts were not written.'] : [
      'Foundation slice initialized controller overlay only; candidate generation and judging are pending later phases.'
    ],
    summary: {
      selected_subgraphs: [],
      top_risks: [],
      missing_evidence: [],
      next_actions: created.controllerState.next_actions || []
    },
    user_decision_needed: [
      'Review task spec variants and subproblem graph before deeper candidate generation.'
    ]
  });
}

async function executeGenerateDecomposition(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('generate_decomposition', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot generate decomposition before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }

  const decompositionRequest = buildDecompositionRequest(overlay, state, args);
  let generationRun;
  let taskSpecVariants;
  let subproblemGraph;
  let decompositionReview;
  const warnings = [];
  try {
    generationRun = await runDecompositionGeneration(decompositionRequest, args, context);
    warnings.push(...(generationRun.warnings || []));
    taskSpecVariants = normalizeTaskSpecVariantsPayload(generationRun.payload, args, paths);
    subproblemGraph = normalizeSubproblemGraphPayload(generationRun.payload, args, taskSpecVariants, paths);
    const reviewPayload = normalizeObject(generationRun.payload?.decomposition_review || generationRun.payload?.decompositionReview);
    decompositionReview = Object.keys(reviewPayload).length
      ? normalizeDecompositionReviewPayload(reviewPayload, args, subproblemGraph, paths)
      : buildDecompositionReview(args, subproblemGraph, paths);
  } catch (error) {
    return {
      ...baseResponse('generate_decomposition', paths, overlay, state, {
        status: 'error',
        warnings: [`generate_decomposition failed: ${truncate(error?.message || String(error), 320)}`],
        user_decision_needed: ['Fix decomposition JSON or submit externalInputs.decomposition_payload with the documented schema.']
      }),
      decomposition_request: decompositionRequest
    };
  }

  const runMeta = {
    run_id: `decomp-run:${stableHash(`${state.project || ''}:${state.task_id || ''}:${nowIso()}:${generationRun.backend}`, 16)}`,
    backend: generationRun.backend,
    source: generationRun.source,
    model: generationRun.model || null,
    provider_call_count: generationRun.provider_call_count || 0
  };
  const nextState = updateStateAfterDecompositionGeneration(state, taskSpecVariants, subproblemGraph, runMeta, warnings);
  const nextRoundReport = buildRoundReport(nextState, taskSpecVariants, subproblemGraph, decompositionReview);

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.taskSpecVariantsPath, taskSpecVariants);
      await writeJson(paths.subproblemGraphPath, subproblemGraph);
      await writeJson(paths.decompositionReviewPath, decompositionReview);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, subproblemGraph, decompositionReview));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        taskSpecVariants,
        subproblemGraph,
        decompositionReview,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('generate_decomposition', paths, nextOverlay, nextState, {
      status: subproblemGraph.subproblems?.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'generate_decomposition_dry_run' : 'generate_decomposition',
      warnings: dryRun ? [...warnings, 'Dry run: task spec, subproblem graph, decomposition review, and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: nextOverlay.selectedSubgraphs?.subgraphs || [],
        top_risks: nextOverlay.riskNotes || [],
        missing_evidence: subproblemGraph.subproblems?.length ? [] : ['No usable subproblems were generated.'],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: [
        'Review task spec variants and subproblem graph before candidate generation.',
        'Run review_decomposition or submit an external decomposition review before deep evidence expansion.'
      ]
    }),
    decomposition_request: decompositionRequest,
    decomposition_run: runMeta,
    task_spec_variants: taskSpecVariants,
    subproblem_graph: subproblemGraph,
    decomposition_review: decompositionReview
  };
}

async function executeReviewDecomposition(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('review_decomposition', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot review decomposition before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.taskSpecVariants || !overlay.subproblemGraph) {
    return baseResponse('review_decomposition', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['Task spec variants and subproblem graph are required before review_decomposition.'],
      user_decision_needed: ['Run generate_decomposition before review_decomposition.']
    });
  }

  const reviewRequest = buildReviewDecompositionRequest(overlay, state, args);
  let reviewRun;
  let decompositionReview;
  const warnings = [];
  try {
    reviewRun = await runDecompositionReview(reviewRequest, args, context);
    warnings.push(...(reviewRun.warnings || []));
    decompositionReview = normalizeDecompositionReviewPayload(reviewRun.payload, args, overlay.subproblemGraph, paths);
  } catch (error) {
    return {
      ...baseResponse('review_decomposition', paths, overlay, state, {
        status: 'error',
        warnings: [`review_decomposition failed: ${truncate(error?.message || String(error), 320)}`],
        user_decision_needed: ['Fix decomposition review JSON or submit externalInputs.decomposition_review_payload with the documented schema.']
      }),
      decomposition_review_request: reviewRequest
    };
  }

  const runMeta = {
    run_id: `decomp-review-run:${stableHash(`${state.project || ''}:${state.task_id || ''}:${nowIso()}:${reviewRun.backend}`, 16)}`,
    backend: reviewRun.backend,
    source: reviewRun.source,
    model: reviewRun.model || null,
    provider_call_count: reviewRun.provider_call_count || 0
  };
  const nextState = updateStateAfterDecompositionReview(state, decompositionReview, runMeta, warnings);
  const nextRoundReport = buildRoundReport(
    nextState,
    overlay.taskSpecVariants || { variants: [] },
    overlay.subproblemGraph || { subproblems: [] },
    decompositionReview
  );

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.decompositionReviewPath, decompositionReview);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, decompositionReview));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        decompositionReview,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('review_decomposition', paths, nextOverlay, nextState, {
      status: decompositionReview.review_id ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'review_decomposition_dry_run' : 'review_decomposition',
      warnings: dryRun ? [...warnings, 'Dry run: decomposition review and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: nextOverlay.selectedSubgraphs?.subgraphs || [],
        top_risks: nextOverlay.riskNotes || [],
        missing_evidence: [],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: decompositionReview.recommendation === 'ask_human'
        ? decompositionReview.critic_questions || []
        : ['Use critic questions as gates before candidate generation and selection.']
    }),
    decomposition_review_request: reviewRequest,
    decomposition_review_run: runMeta,
    decomposition_review: decompositionReview
  };
}

async function executeExport(paths) {
  const overlay = await loadControllerOverlay(paths);
  if (!overlay.controllerState) {
    return baseResponse('export', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot export before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task or run_round first.']
    });
  }
  const exportPayload = await writeControllerExport(paths, overlay);
  return {
    ...baseResponse('export', paths, overlay, overlay.controllerState, {
      status: 'ok',
      summary: {
        selected_subgraphs: exportPayload.candidate_subgraphs.selected,
        top_risks: exportPayload.risks,
        missing_evidence: [],
        next_actions: exportPayload.next_material_requests
      },
      user_decision_needed: exportPayload.user_decision_needed
    }),
    export: exportPayload
  };
}

async function ensureInitialized(paths, args = {}) {
  const existing = await readJson(paths.controllerStatePath, null);
  if (existing) return existing;
  await executeInitTask(paths, args);
  return readJson(paths.controllerStatePath, null);
}

async function executeGenerateCandidates(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('generate_candidates', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot generate candidates before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }

  const subproblems = overlay.subproblemGraph?.subproblems || [];
  const { maxCandidates, perSubproblem } = candidateGenerationLimits(args, state, subproblems.length);
  const warnings = [];
  if (!context.graph) warnings.push('No committed graph is available; generated zero candidates.');

  const generated = [];
  const subproblemSearchRuns = [];
  for (const subproblem of subproblems) {
    if (generated.length >= maxCandidates) break;
    const remaining = maxCandidates - generated.length;
    const next = collectCandidateSearchForSubproblem(
      context.graph,
      subproblem,
      state,
      context.manifest || {},
      Math.min(perSubproblem, remaining)
    );
    subproblemSearchRuns.push(next);
    generated.push(...next.candidates);
  }

  if (!generated.length && context.graph) {
    warnings.push('Committed graph search returned no paper-scoped candidates for the selected subproblems.');
  }

  const searchTrace = mergeIdeaSearchTraces(subproblemSearchRuns, state, { ...args, beamWidth: perSubproblem });
  const nextState = updateStateAfterCandidateGeneration(state, generated, warnings, searchTrace);
  const nextRecords = mergeCandidateGraphRecords(overlay.candidateGraphRecords || [], generated);
  const nextCandidateGraph = splitCandidateGraph(nextRecords);
  const nextRoundReport = buildRoundReport(
    nextState,
    overlay.taskSpecVariants || { variants: [] },
    overlay.subproblemGraph || { subproblems: [] },
    overlay.decompositionReview || {}
  );

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJsonl(paths.candidateGraphPath, nextRecords);
      await writeJson(paths.searchTracePath, searchTrace);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        candidateGraphRecords: nextRecords,
        candidateGraph: nextCandidateGraph,
        searchTrace,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return baseResponse('generate_candidates', paths, nextOverlay, nextState, {
    status: generated.length ? 'ok' : 'needs_input',
    action_completed: dryRun ? 'generate_candidates_dry_run' : 'generate_candidates',
    warnings: dryRun ? [...warnings, 'Dry run: candidate graph and controller state were not written.'] : warnings,
    summary: {
      selected_subgraphs: nextOverlay.selectedSubgraphs?.subgraphs || [],
      top_risks: nextOverlay.riskNotes || [],
      missing_evidence: generated.length ? [] : ['No graph-backed candidate nodes were generated.'],
      next_actions: nextState.next_actions || []
    },
    search_trace: {
      trace_id: searchTrace.trace_id,
      policy: searchTrace.policy,
      candidate_count: searchTrace.candidate_count,
      finalized_state_count: searchTrace.finalized_state_ids?.length || 0,
      requisition_state_count: searchTrace.requisition_state_ids?.length || 0,
      depths: searchTrace.depths
    },
    user_decision_needed: generated.length
      ? ['Review graph-generated candidates before edge proposal and judging.']
      : ['Broaden subproblem queries or import/source more graph material before continuing.']
  });
}

async function executeProposeEdges(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('propose_edges', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot propose candidate edges before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }

  const candidateNodes = overlay.candidateGraph?.nodes || [];
  if (candidateNodes.length < 2) {
    return baseResponse('propose_edges', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['Need at least two candidate nodes before proposing candidate edges.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Generate more candidate nodes before edge proposal.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run generate_candidates with broader queries or import more graph material.']
    });
  }

  const maxEdges = edgeProposalLimit(args, state);
  const proposed = proposeCandidateEdges(candidateNodes, state, maxEdges);
  const warnings = [];
  if (!proposed.length) {
    warnings.push('Heuristic blocking found no candidate pairs with shared subproblem, mechanism, failure mode, metric, or source paper.');
  }

  const nextState = updateStateAfterEdgeProposal(state, proposed, warnings);
  const nextRecords = mergeCandidateGraphRecords(overlay.candidateGraphRecords || [], proposed);
  const nextCandidateGraph = splitCandidateGraph(nextRecords);
  const nextRoundReport = buildRoundReport(
    nextState,
    overlay.taskSpecVariants || { variants: [] },
    overlay.subproblemGraph || { subproblems: [] },
    overlay.decompositionReview || {}
  );

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJsonl(paths.candidateGraphPath, nextRecords);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        candidateGraphRecords: nextRecords,
        candidateGraph: nextCandidateGraph,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return baseResponse('propose_edges', paths, nextOverlay, nextState, {
    status: proposed.length ? 'ok' : 'needs_input',
    action_completed: dryRun ? 'propose_edges_dry_run' : 'propose_edges',
    warnings: dryRun ? [...warnings, 'Dry run: candidate edges and controller state were not written.'] : warnings,
    summary: {
      selected_subgraphs: nextOverlay.selectedSubgraphs?.subgraphs || [],
      top_risks: nextOverlay.riskNotes || [],
      missing_evidence: proposed.length ? [] : ['No bounded candidate relations were generated.'],
      next_actions: nextState.next_actions || []
    },
    user_decision_needed: proposed.length
      ? ['Review candidate relations before judge_batch and selection.']
      : ['Broaden candidate generation or add evidence so candidate relation blocking has useful overlaps.']
  });
}

async function executeJudgeBatch(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('judge_batch', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot judge candidates before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }

  const judgeRequest = buildJudgeRequest(overlay, state, args);
  if (!judgeRequest.candidates.length && !judgeRequest.edges.length) {
    return {
      ...baseResponse('judge_batch', paths, overlay, state, {
        status: 'needs_input',
        warnings: ['No candidate nodes or candidate edges are available for judge_batch.'],
        summary: {
          selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
          top_risks: overlay.riskNotes || [],
          missing_evidence: ['Generate candidates and candidate edges before judgment.'],
          next_actions: state.next_actions || []
        },
        user_decision_needed: ['Run generate_candidates and propose_edges before judge_batch.']
      }),
      judge_request: judgeRequest
    };
  }

  let judgeRun;
  let normalized;
  let consistencyProbeDecisions = [];
  const warnings = [];
  try {
    judgeRun = await runJudgeBatch(judgeRequest, args, context);
    warnings.push(...(judgeRun.warnings || []));
    const runId = `judge-run:${stableHash(`${state.project || ''}:${state.task_id || ''}:${nowIso()}:${judgeRun.backend}`, 16)}`;
    const runMeta = {
      run_id: runId,
      backend: judgeRun.backend,
      source: judgeRun.source,
      model: judgeRun.model || state.judge?.model || null,
      self_consistency: judgeRun.self_consistency || 'not_measured_single_pass',
      consistency_probe_decision_count: 0,
      provider_call_count: judgeRun.provider_call_count || 0
    };
    normalized = normalizeJudgeDecisions(judgeRun.payload, runMeta, state);
    if (judgeRun.consistency_probe_payload) {
      const probeRunMeta = {
        ...runMeta,
        run_id: `${runId}:consistency-probe`,
        source: `${runMeta.source || 'unknown'}:consistency_probe`,
        main_judge_run_id: runId
      };
      consistencyProbeDecisions = normalizeConsistencyProbeDecisions(judgeRun.consistency_probe_payload, probeRunMeta, state);
      runMeta.consistency_probe_decision_count = consistencyProbeDecisions.length;
    }
    judgeRun = runMeta;
  } catch (error) {
    return {
      ...baseResponse('judge_batch', paths, overlay, state, {
        status: 'error',
        warnings: [`judge_batch failed: ${truncate(error?.message || String(error), 320)}`],
        user_decision_needed: ['Fix judge output JSON or submit externalInputs.judge_payload with the documented schema.']
      }),
      judge_request: judgeRequest
    };
  }

  if (!normalized.decisions.length) {
    warnings.push('Judge returned no usable node_judgments, edge_judgments, or pairwise_preferences.');
  }

  const nextDecisions = mergeJudgeDecisions(overlay.judgeDecisions || [], [
    ...normalized.decisions,
    ...consistencyProbeDecisions
  ]);
  const nextState = updateStateAfterJudgeBatch(state, normalized.decisions, judgeRun, warnings);
  const nextRoundReport = buildRoundReport(
    nextState,
    overlay.taskSpecVariants || { variants: [] },
    overlay.subproblemGraph || { subproblems: [] },
    overlay.decompositionReview || {}
  );

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJsonl(paths.judgeDecisionsPath, nextDecisions);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        judgeDecisions: nextDecisions,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('judge_batch', paths, nextOverlay, nextState, {
      status: normalized.decisions.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'judge_batch_dry_run' : 'judge_batch',
      warnings: dryRun ? [...warnings, 'Dry run: judge decisions and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: nextOverlay.selectedSubgraphs?.subgraphs || [],
        top_risks: nextOverlay.riskNotes || [],
        missing_evidence: normalized.decisions.length ? [] : ['No judge decisions were produced.'],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: normalized.decisions.length
        ? ['Review judge decisions before select_batch.']
        : ['Submit external judge decisions or configure a single-model judge hook.']
    }),
    judge_request: judgeRequest,
    judge_run: judgeRun,
    decisions: normalized.decisions,
    consistency_probe_decisions: consistencyProbeDecisions,
    pairwise_preferences: normalized.pairwise_preferences
  };
}

async function executeSelectBatch(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('select_batch', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot select candidates before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.candidateGraph?.nodes?.length) {
    return baseResponse('select_batch', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No candidate nodes are available for select_batch.'],
      user_decision_needed: ['Run generate_candidates before select_batch.']
    });
  }
  if (!overlay.judgeDecisions?.length) {
    return baseResponse('select_batch', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No judge decisions are available for select_batch.'],
      summary: {
        selected_subgraphs: [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run judge_batch before selecting a batch.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run judge_batch or submit external judge decisions before select_batch.']
    });
  }

  const selectionPayload = buildSelectedSubgraphs(overlay, state, args);
  const warnings = [];
  if (!selectionPayload.subgraphs.length) {
    warnings.push('Selection produced no eligible candidates; all candidates were gated or unavailable.');
  }
  const nextRecords = applySelectionStatuses(overlay.candidateGraphRecords || [], selectionPayload);
  const nextCandidateGraph = splitCandidateGraph(nextRecords);
  const nextState = updateStateAfterSelection(state, selectionPayload, warnings);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    selected: selectionPayload.subgraphs,
    pruned: selectionPayload.rejected,
    needs_evidence: selectionPayload.parked.filter((entry) => entry.reason?.includes('needs_evidence'))
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.selectedSubgraphsPath, selectionPayload);
      await writeJson(paths.selectionTracePath, selectionPayload.selection_trace);
      await writeJson(paths.banditSimulationPath, selectionPayload.bandit_state_summary);
      await writeJsonl(paths.candidateGraphPath, nextRecords);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        selectedSubgraphs: selectionPayload,
        selectionTrace: selectionPayload.selection_trace,
        banditSimulation: selectionPayload.bandit_state_summary,
        candidateGraphRecords: nextRecords,
        candidateGraph: nextCandidateGraph,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('select_batch', paths, nextOverlay, nextState, {
      status: selectionPayload.subgraphs.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'select_batch_dry_run' : 'select_batch',
      warnings: dryRun ? [...warnings, 'Dry run: selected subgraphs, candidate statuses, and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: selectionPayload.subgraphs,
        top_risks: nextOverlay.riskNotes || [],
        missing_evidence: selectionPayload.subgraphs.flatMap((subgraph) => subgraph.missing_evidence || []),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: selectionPayload.subgraphs.length
        ? ['Review selected subgraphs before evidence expansion or solution composition.']
        : ['Revise candidates, rerun judge_batch, or broaden candidate generation.']
    }),
    selection: selectionPayload,
    selection_trace: selectionPayload.selection_trace,
    bandit_state_summary: selectionPayload.bandit_state_summary
  };
}

async function executeExpandEvidence(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('expand_evidence', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot expand evidence before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.selectedSubgraphs?.subgraphs?.length) {
    return baseResponse('expand_evidence', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No selected subgraphs are available for expand_evidence.'],
      summary: {
        selected_subgraphs: [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run select_batch before selected-candidate evidence expansion.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run judge_batch and select_batch before expand_evidence.']
    });
  }

  const methodCardPack = await buildMethodCardPack(overlay, state, args);
  const providerPolicy = normalizeProviderPolicy(args);
  const warnings = [];
  if (!methodCardPack.method_cards.length) {
    warnings.push('No method cards were produced because selected subgraphs did not reference available candidate nodes.');
  }
  if (requestedMaterialOptIn(providerPolicy)) {
    warnings.push('Provider evidence, live discovery, literature discovery, and import submission are not invoked during expand_evidence; requested opt-ins are recorded as approval-gated material expansion requests.');
  }
  const nextSelectedSubgraphs = selectedSubgraphsWithMethodCards(overlay.selectedSubgraphs || {}, methodCardPack);
  const nextRiskNotes = mergeRiskNotes(overlay.riskNotes || [], riskNotesFromMethodCards(methodCardPack.method_cards, state));
  const nextState = updateStateAfterEvidenceExpansion(state, methodCardPack, warnings);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    selected: nextSelectedSubgraphs.subgraphs || [],
    needs_evidence: methodCardPack.method_cards
      .filter((card) => card.missing_evidence?.length)
      .map((card) => ({
        candidate_id: card.candidate_id,
        missing_evidence: card.missing_evidence
      }))
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeText(paths.methodCardPackPath, renderMethodCardPackMarkdown(methodCardPack));
      await writeJson(paths.selectedSubgraphsPath, nextSelectedSubgraphs);
      await writeJsonl(paths.riskNotesPath, nextRiskNotes);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        selectedSubgraphs: nextSelectedSubgraphs,
        methodCardPackText: renderMethodCardPackMarkdown(methodCardPack),
        riskNotes: nextRiskNotes,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('expand_evidence', paths, nextOverlay, nextState, {
      status: methodCardPack.method_cards.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'expand_evidence_dry_run' : 'expand_evidence',
      warnings: dryRun ? [...warnings, 'Dry run: method-card pack, selected subgraphs, risk notes, and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: nextSelectedSubgraphs.subgraphs || [],
        top_risks: nextRiskNotes,
        missing_evidence: methodCardPack.missing_evidence || [],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: methodCardPack.method_cards.length
        ? ['Review selected method-card pack before solution composition or design review.']
        : ['Repair selected subgraphs or rerun select_batch before evidence expansion.']
    }),
    method_card_pack: methodCardPack
  };
}

async function executeMaterialRequests(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('execute_material_requests', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot execute material requests before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  const methodCardPack = overlay.selectedSubgraphs?.method_card_pack || null;
  const methodCardRequests = methodCardPack?.material_expansion_requests || [];
  const closestPriorRequests = overlay.designReview?.closest_prior_expansion_requests || [];
  const allRequests = [...methodCardRequests, ...closestPriorRequests];
  if (!allRequests.length) {
    return baseResponse('execute_material_requests', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No planned material requests are available for execution.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run expand_evidence or design_review before execute_material_requests.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run expand_evidence or design_review before execute_material_requests.']
    });
  }

  const approval = materialRequestExecutionApproval(args);
  if (!approval.approved) {
    return baseResponse('execute_material_requests', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['Material request execution requires explicit approval.'],
      user_decision_needed: ['Call execute_material_requests with approveMaterialRequestExecution=true and approvedMaterialRequestIds after reviewing planned requests.']
    });
  }

  const execution = executableMaterialRequests(allRequests, args, state, approval);
  const warnings = execution.skipped.length
    ? [`${execution.skipped.length} material request(s) were skipped: ${execution.skipped.map((item) => `${item.request_id || item.operation}:${item.reason}`).join(', ')}`]
    : [];
  const optInExecutionCount = execution.selected.filter((request) => materialRequestHasOptIns(request)).length;
  if (optInExecutionCount) {
    warnings.push(`${optInExecutionCount} approved material request(s) include provider/live/literature/import opt-ins; execution depends on the nested material executor and remains approval-scoped.`);
  }
  if (!execution.selected.length) {
    return baseResponse('execute_material_requests', paths, overlay, state, {
      status: 'needs_input',
      warnings: warnings.length ? warnings : ['No material requests matched the approved execution filter.'],
      user_decision_needed: ['Provide approvedMaterialRequestIds for not-run safe material requests, or rerun expand_evidence/design_review to create requests.']
    });
  }

  if (dryRun) {
    return {
      ...baseResponse('execute_material_requests', paths, overlay, state, {
        status: 'ok',
        action_completed: 'execute_material_requests_dry_run',
        warnings: [...warnings, 'Dry run: approved material requests were not executed and no overlay files were written.'],
        summary: {
          selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
          top_risks: overlay.riskNotes || [],
          missing_evidence: methodCardPack?.missing_evidence || [],
          next_actions: state.next_actions || []
        },
        user_decision_needed: ['Review dry-run request list before executing material requests.']
      }),
      execution_plan: {
        approved_request_count: execution.selected.length,
        approved_opt_in_request_count: optInExecutionCount,
        limit: execution.limit,
        request_ids: execution.selected.map((request) => request.request_id),
        approval,
        skipped: execution.skipped
      }
    };
  }

  if (typeof context.materialOperationExecutor !== 'function') {
    return baseResponse('execute_material_requests', paths, overlay, state, {
      status: 'blocked',
      warnings: ['No materialOperationExecutor is available in the controller context.'],
      user_decision_needed: ['Run through agent_materials(operation="research_controller") so safe nested material operations are available.']
    });
  }

  const rawResults = [];
  for (const request of execution.selected) {
    try {
      const payload = await context.materialOperationExecutor(safeMaterialOperationArgs(request, state, approval));
      rawResults.push(materialResultFromExecution(request, payload, approval));
    } catch (error) {
      rawResults.push(materialResultFromExecutionFailure(request, error));
    }
  }

  const nextResultRecords = rawResults.map((result) => normalizeMaterialExpansionResult(result, state));
  const mergedResults = mergeMaterialExpansionResults(overlay.materialExpansionResults || [], nextResultRecords);
  const updatedMethodCardPack = methodCardPack
    ? applyMaterialResultsToMethodCardPack(methodCardPack, mergedResults)
    : null;
  let updatedDesignReview = applyMaterialResultsToDesignReview(overlay.designReview, mergedResults);
  const decompositionDriftReview = buildDecompositionDriftReview({
    ...overlay,
    materialExpansionResults: mergedResults,
    designReview: updatedDesignReview || overlay.designReview
  }, state);
  updatedDesignReview = applyDecompositionDriftToDesignReview(updatedDesignReview, decompositionDriftReview);
  const updatedDecompositionReview = applyDecompositionDriftReview(overlay.decompositionReview || {}, decompositionDriftReview);
  const nextRiskNotes = mergeRiskNotes(overlay.riskNotes || [], riskNotesFromDecompositionDriftReview(decompositionDriftReview, state));
  const nextSelectedSubgraphs = selectedSubgraphsWithMaterialResults(overlay.selectedSubgraphs || {}, updatedMethodCardPack, mergedResults);
  const nextState = updateStateAfterMaterialRequestExecution(state, nextResultRecords, updatedMethodCardPack || {}, warnings, updatedDesignReview, decompositionDriftReview);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      updatedDecompositionReview
    ),
    selected: nextSelectedSubgraphs.subgraphs || [],
    material_results: {
      executed_count: nextResultRecords.length,
      total_recorded_count: mergedResults.length,
      fulfilled_request_count: updatedMethodCardPack?.fulfilled_material_expansion_request_count || 0,
      fulfilled_closest_prior_request_count: updatedDesignReview?.fulfilled_closest_prior_expansion_request_count || 0
    }
  };

  await withFileLock(paths.lockPath, async () => {
    await writeJsonl(paths.materialExpansionResultsPath, mergedResults);
    await writeJson(paths.selectedSubgraphsPath, nextSelectedSubgraphs);
    if (updatedMethodCardPack) await writeText(paths.methodCardPackPath, renderMethodCardPackMarkdown(updatedMethodCardPack));
    await writeJson(paths.decompositionReviewPath, updatedDecompositionReview);
    await writeJsonl(paths.riskNotesPath, nextRiskNotes);
    if (updatedDesignReview) {
      await writeJson(paths.designReviewPath, updatedDesignReview);
      await writeText(paths.designReviewMarkdownPath, renderDesignReviewMarkdown(updatedDesignReview));
    }
    await writeJson(paths.controllerStatePath, nextState);
    await writeJson(paths.roundReportPath, nextRoundReport);
    await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, updatedDecompositionReview));
  });

  const nextOverlay = await loadControllerOverlay(paths);
  return {
    ...baseResponse('execute_material_requests', paths, nextOverlay, nextState, {
      status: nextResultRecords.some((record) => record.status === 'ok') ? 'ok' : 'blocked',
      action_completed: 'execute_material_requests',
      warnings,
      summary: {
        selected_subgraphs: nextSelectedSubgraphs.subgraphs || [],
        top_risks: nextRiskNotes,
        missing_evidence: updatedMethodCardPack?.missing_evidence || [],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: ['Review executed material results before solution composition, design review, or import execution.']
    }),
    executed_material_requests: execution.selected.map((request) => request.request_id),
    skipped_material_requests: execution.skipped,
    material_results: nextResultRecords,
    material_result_count: mergedResults.length,
    method_card_pack: updatedMethodCardPack,
    design_review: updatedDesignReview,
    decomposition_drift_review: decompositionDriftReview
  };
}

async function executeRecordMaterialResults(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('record_material_results', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot record material results before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  const methodCardPack = overlay.selectedSubgraphs?.method_card_pack || null;
  const methodCardRequests = methodCardPack?.material_expansion_requests || [];
  const closestPriorRequests = overlay.designReview?.closest_prior_expansion_requests || [];
  if (!methodCardRequests.length && !closestPriorRequests.length) {
    return baseResponse('record_material_results', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No material expansion requests are available to match results against.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run expand_evidence or design_review before recording material expansion results.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run expand_evidence or design_review before record_material_results.']
    });
  }
  const rawResults = externalMaterialExpansionResults(args);
  if (!rawResults.length) {
    return baseResponse('record_material_results', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No external material expansion results were supplied.'],
      user_decision_needed: ['Submit externalInputs.material_expansion_results from an external Agent or Skill.']
    });
  }

  const nextResultRecords = rawResults.map((result) => normalizeMaterialExpansionResult(result, state));
  const mergedResults = mergeMaterialExpansionResults(overlay.materialExpansionResults || [], nextResultRecords);
  const updatedMethodCardPack = methodCardPack
    ? applyMaterialResultsToMethodCardPack(methodCardPack, mergedResults)
    : null;
  let updatedDesignReview = applyMaterialResultsToDesignReview(overlay.designReview, mergedResults);
  const decompositionDriftReview = buildDecompositionDriftReview({
    ...overlay,
    materialExpansionResults: mergedResults,
    designReview: updatedDesignReview || overlay.designReview
  }, state);
  updatedDesignReview = applyDecompositionDriftToDesignReview(updatedDesignReview, decompositionDriftReview);
  const updatedDecompositionReview = applyDecompositionDriftReview(overlay.decompositionReview || {}, decompositionDriftReview);
  const nextSelectedSubgraphs = selectedSubgraphsWithMaterialResults(overlay.selectedSubgraphs || {}, updatedMethodCardPack, mergedResults);
  const warnings = [];
  const allRequests = [...methodCardRequests, ...closestPriorRequests];
  const unmatched = nextResultRecords.filter((record) => {
    const key = materialRequestLookupKey(record);
    return !allRequests.some((request) => materialRequestLookupKey(request) === key);
  });
  if (unmatched.length) {
    warnings.push(`${unmatched.length} material result(s) did not match a planned material request; they were recorded but did not update request status.`);
  }
  const nextRiskNotes = mergeRiskNotes(overlay.riskNotes || [], riskNotesFromDecompositionDriftReview(decompositionDriftReview, state));
  const nextState = updateStateAfterMaterialResults(state, nextResultRecords, updatedMethodCardPack || {}, warnings, updatedDesignReview, decompositionDriftReview);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      updatedDecompositionReview
    ),
    selected: nextSelectedSubgraphs.subgraphs || [],
    material_results: {
      recorded_count: nextResultRecords.length,
      total_recorded_count: mergedResults.length,
      fulfilled_request_count: updatedMethodCardPack?.fulfilled_material_expansion_request_count || 0,
      fulfilled_closest_prior_request_count: updatedDesignReview?.fulfilled_closest_prior_expansion_request_count || 0
    }
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJsonl(paths.materialExpansionResultsPath, mergedResults);
      await writeJson(paths.selectedSubgraphsPath, nextSelectedSubgraphs);
      if (updatedMethodCardPack) await writeText(paths.methodCardPackPath, renderMethodCardPackMarkdown(updatedMethodCardPack));
      await writeJson(paths.decompositionReviewPath, updatedDecompositionReview);
      await writeJsonl(paths.riskNotesPath, nextRiskNotes);
      if (updatedDesignReview) {
        await writeJson(paths.designReviewPath, updatedDesignReview);
        await writeText(paths.designReviewMarkdownPath, renderDesignReviewMarkdown(updatedDesignReview));
      }
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, updatedDecompositionReview));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        selectedSubgraphs: nextSelectedSubgraphs,
        methodCardPackText: updatedMethodCardPack ? renderMethodCardPackMarkdown(updatedMethodCardPack) : overlay.methodCardPackText,
        materialExpansionResults: mergedResults,
        decompositionReview: updatedDecompositionReview,
        designReview: updatedDesignReview,
        riskNotes: nextRiskNotes,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('record_material_results', paths, nextOverlay, nextState, {
      status: nextResultRecords.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'record_material_results_dry_run' : 'record_material_results',
      warnings: dryRun ? [...warnings, 'Dry run: material results, selected subgraphs, method-card pack, and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: nextSelectedSubgraphs.subgraphs || [],
        top_risks: nextRiskNotes,
        missing_evidence: updatedMethodCardPack?.missing_evidence || [],
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: ['Review recorded material results before solution composition, design review, or import execution.']
    }),
    material_results: nextResultRecords,
    material_result_count: mergedResults.length,
    method_card_pack: updatedMethodCardPack,
    design_review: updatedDesignReview,
    decomposition_drift_review: decompositionDriftReview
  };
}

async function executeComposeSolutions(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('compose_solutions', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot compose solutions before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.selectedSubgraphs?.subgraphs?.length) {
    return baseResponse('compose_solutions', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No selected subgraphs are available for compose_solutions.'],
      summary: {
        selected_subgraphs: [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run select_batch before solution composition.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run select_batch before compose_solutions.']
    });
  }

  const warnings = [];
  if (!overlay.selectedSubgraphs?.method_card_pack) {
    warnings.push('No method-card pack is embedded in selected-subgraphs.json; composing from selected candidate graph scaffolds.');
  }
  const fallbackSketches = buildSolutionSketches(overlay, state, args);
  const compositionRun = await runSolutionComposition(overlay, state, args, context, fallbackSketches);
  const solutionSketches = compositionRun.solution_sketches || fallbackSketches;
  warnings.push(...(compositionRun.warnings || []));
  if (!solutionSketches.length) {
    warnings.push('No solution sketches were produced because selected subgraphs did not reference candidate material.');
  }
  const nextState = updateStateAfterSolutionComposition(state, solutionSketches, warnings, compositionRun);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    selected: overlay.selectedSubgraphs?.subgraphs || [],
    solution_sketches: solutionSketches
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJsonl(paths.solutionSketchesPath, solutionSketches);
      await writeText(paths.solutionSketchesMarkdownPath, renderSolutionSketchesMarkdown(solutionSketches));
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        solutionSketches,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('compose_solutions', paths, nextOverlay, nextState, {
      status: solutionSketches.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'compose_solutions_dry_run' : 'compose_solutions',
      warnings: dryRun ? [...warnings, 'Dry run: solution sketches and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: nextOverlay.riskNotes || [],
        missing_evidence: unique(solutionSketches.flatMap((sketch) => sketch.missing_evidence || [])),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: solutionSketches.length
        ? ['Run design_review before presenting solution sketches as recommended directions.']
        : ['Repair selected subgraphs or run expand_evidence before composing solutions.']
    }),
    solution_composition_run: {
      backend: compositionRun.backend,
      source: compositionRun.source,
      model: compositionRun.model,
      provider_call_count: compositionRun.provider_call_count || 0,
      solution_count: solutionSketches.length
    },
    solution_sketches: solutionSketches
  };
}

async function executeDesignReview(paths, args = {}, context = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('design_review', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot review designs before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.solutionSketches?.length) {
    return baseResponse('design_review', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['No solution sketches are available for design_review.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run compose_solutions before design_review.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run compose_solutions before design_review.']
    });
  }

  const fallbackDesignReview = buildDesignReviewPayload(overlay, state, args);
  const designReviewRun = await runDesignReview(overlay, state, args, context, fallbackDesignReview);
  let designReview = designReviewRun.design_review || fallbackDesignReview;
  const warnings = [];
  warnings.push(...(designReviewRun.warnings || []));
  if (!designReview.reviews.length) {
    warnings.push('Design review produced no review records.');
  }
  const decompositionDriftReview = buildDecompositionDriftReview({
    ...overlay,
    designReview
  }, state);
  designReview = applyDecompositionDriftToDesignReview(designReview, decompositionDriftReview);
  const updatedDecompositionReview = applyDecompositionDriftReview(overlay.decompositionReview || {}, decompositionDriftReview);
  const nextRiskNotes = mergeRiskNotes(
    overlay.riskNotes || [],
    [
      ...riskNotesFromDesignReview(designReview, state),
      ...riskNotesFromDecompositionDriftReview(decompositionDriftReview, state)
    ]
  );
  const nextState = updateStateAfterDesignReview(state, designReview, warnings, decompositionDriftReview);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      updatedDecompositionReview
    ),
    selected: overlay.selectedSubgraphs?.subgraphs || [],
    solution_sketches: overlay.solutionSketches || [],
    design_review: designReview
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.decompositionReviewPath, updatedDecompositionReview);
      await writeJson(paths.designReviewPath, designReview);
      await writeText(paths.designReviewMarkdownPath, renderDesignReviewMarkdown(designReview));
      await writeJsonl(paths.riskNotesPath, nextRiskNotes);
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, updatedDecompositionReview));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        decompositionReview: updatedDecompositionReview,
        designReview,
        riskNotes: nextRiskNotes,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('design_review', paths, nextOverlay, nextState, {
      status: designReview.reviews.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'design_review_dry_run' : 'design_review',
      warnings: dryRun ? [...warnings, 'Dry run: design review, risk notes, and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: nextRiskNotes,
        missing_evidence: unique(designReview.reviews.flatMap((review) => review.missing_evidence || [])),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: designReview.user_decision_needed || []
    }),
    design_review_run: {
      backend: designReviewRun.backend,
      source: designReviewRun.source,
      model: designReviewRun.model,
      provider_call_count: designReviewRun.provider_call_count || 0,
      review_count: designReview.reviews.length
    },
    design_review: designReview,
    decomposition_drift_review: decompositionDriftReview
  };
}

async function executeComposeInnovationBriefs(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('compose_innovation_briefs', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot compose innovation briefs before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.solutionSketches?.length) {
    return baseResponse('compose_innovation_briefs', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['Innovation brief composition requires solution sketches.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run compose_solutions before compose_innovation_briefs.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run compose_solutions before compose_innovation_briefs.']
    });
  }

  const innovationBriefs = buildInnovationBriefPack(overlay, state, args);
  const warnings = [];
  if (!overlay.designReview?.reviews?.length) {
    warnings.push('No design review was available; innovation briefs were generated from solution sketches and selected method cards only.');
  }
  if (!innovationBriefs.briefs.length) {
    warnings.push('No innovation briefs were produced from the available solution sketches.');
  }
  const nextState = updateStateAfterInnovationBriefs(state, innovationBriefs, warnings);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    selected: overlay.selectedSubgraphs?.subgraphs || [],
    solution_sketches: overlay.solutionSketches || [],
    design_review: overlay.designReview || null,
    innovation_briefs: innovationBriefs
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.innovationBriefsPath, innovationBriefs);
      await writeText(paths.innovationBriefsMarkdownPath, renderInnovationBriefsMarkdown(innovationBriefs));
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        innovationBriefs,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('compose_innovation_briefs', paths, nextOverlay, nextState, {
      status: innovationBriefs.briefs.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'compose_innovation_briefs_dry_run' : 'compose_innovation_briefs',
      warnings: dryRun ? [...warnings, 'Dry run: innovation briefs and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: unique(innovationBriefs.briefs.flatMap((brief) => brief.missing_materials || [])),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: innovationBriefs.user_decision_needed || []
    }),
    innovation_briefs: innovationBriefs
  };
}

async function executeGenerateExperimentPlan(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('generate_experiment_plan', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot generate experiment plans before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task first.']
    });
  }
  if (!overlay.solutionSketches?.length || !overlay.designReview?.reviews?.length) {
    return baseResponse('generate_experiment_plan', paths, overlay, state, {
      status: 'needs_input',
      warnings: ['Experiment planning requires solution sketches and design reviews.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: ['Run compose_solutions and design_review before generate_experiment_plan.'],
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Run compose_solutions and design_review before generate_experiment_plan.']
    });
  }
  const approval = experimentPlanningApproval(args);
  if (!approval.approved) {
    return baseResponse('generate_experiment_plan', paths, overlay, state, {
      status: 'needs_approval',
      warnings: ['Experiment-plan generation requires explicit approval because it moves beyond design review into experiment planning.'],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: unique((overlay.designReview?.reviews || []).flatMap((review) => review.missing_evidence || [])),
        next_actions: state.next_actions || []
      },
      user_decision_needed: ['Call generate_experiment_plan with approveExperimentPlanning=true after human approval.']
    });
  }

  const experimentPlan = buildExperimentPlanPack(overlay, state, args);
  const warnings = [];
  if (!experimentPlan.plans.length) {
    warnings.push('No experiment plans were produced because design reviews were rejected or no matching solution sketches were found.');
  }
  const nextState = updateStateAfterExperimentPlan(state, experimentPlan, warnings);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    selected: overlay.selectedSubgraphs?.subgraphs || [],
    solution_sketches: overlay.solutionSketches || [],
    design_review: overlay.designReview || null,
    experiment_plan: experimentPlan
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.experimentPlanPath, experimentPlan);
      await writeText(paths.experimentPlanMarkdownPath, renderExperimentPlanMarkdown(experimentPlan));
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        experimentPlan,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('generate_experiment_plan', paths, nextOverlay, nextState, {
      status: experimentPlan.plans.length ? 'ok' : 'needs_input',
      action_completed: dryRun ? 'generate_experiment_plan_dry_run' : 'generate_experiment_plan',
      warnings: dryRun ? [...warnings, 'Dry run: experiment plan and controller state were not written.'] : warnings,
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: unique(experimentPlan.plans.flatMap((plan) => plan.required_materials_before_run || [])),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: experimentPlan.user_decision_needed || []
    }),
    experiment_plan: experimentPlan
  };
}

async function executeValidateGcdMvp(paths, args = {}) {
  await ensureInitialized(paths, args);
  const dryRun = booleanFlag(args.dryRun || args.dry_run, false);
  const overlay = await loadControllerOverlay(paths);
  const state = overlay.controllerState;
  if (!state) {
    return baseResponse('validate_gcd_mvp', paths, overlay, null, {
      status: 'needs_input',
      warnings: ['Cannot validate the GCD MVP before init_task creates controller-state.json.'],
      user_decision_needed: ['Run init_task or run_round first.']
    });
  }

  const validationReport = await buildGcdMvpValidationReport(paths, overlay, args);
  const nextState = updateStateAfterGcdMvpValidation(state, validationReport, validationReport.warnings || []);
  const nextRoundReport = {
    ...buildRoundReport(
      nextState,
      overlay.taskSpecVariants || { variants: [] },
      overlay.subproblemGraph || { subproblems: [] },
      overlay.decompositionReview || {}
    ),
    gcd_mvp_validation: validationReport
  };

  if (!dryRun) {
    await withFileLock(paths.lockPath, async () => {
      await writeJson(paths.gcdMvpValidationPath, validationReport);
      await writeText(paths.gcdMvpValidationMarkdownPath, renderGcdMvpValidationMarkdown(validationReport));
      await writeJson(paths.controllerStatePath, nextState);
      await writeJson(paths.roundReportPath, nextRoundReport);
      await writeText(paths.roundReportMarkdownPath, renderRoundReportMarkdown(nextState, overlay.subproblemGraph || {}, overlay.decompositionReview || {}));
    });
  }

  const nextOverlay = dryRun
    ? {
        ...overlay,
        gcdMvpValidation: validationReport,
        controllerState: nextState,
        roundReport: nextRoundReport
      }
    : await loadControllerOverlay(paths);

  return {
    ...baseResponse('validate_gcd_mvp', paths, nextOverlay, nextState, {
      status: validationReport.overall_status,
      action_completed: dryRun ? 'validate_gcd_mvp_dry_run' : 'validate_gcd_mvp',
      warnings: dryRun ? [...(validationReport.warnings || []), 'Dry run: GCD MVP validation report and controller state were not written.'] : validationReport.warnings || [],
      summary: {
        selected_subgraphs: overlay.selectedSubgraphs?.subgraphs || [],
        top_risks: overlay.riskNotes || [],
        missing_evidence: (validationReport.criteria || [])
          .filter((criterion) => criterion.status === 'fail')
          .map((criterion) => criterion.label),
        next_actions: nextState.next_actions || []
      },
      user_decision_needed: validationReport.user_decision_needed || []
    }),
    gcd_mvp_validation: validationReport
  };
}

async function executeRunRound(paths, args = {}, context = {}) {
  const existing = await readJson(paths.controllerStatePath, null);
  if (!existing) {
    await executeInitTask(paths, args);
  }
  let overlay = await loadControllerOverlay(paths);
  const shouldRegenerateDecomposition = booleanFlag(args.regenerateDecomposition || args.regenerate_decomposition, false);
  const needsDecompositionGeneration = shouldRegenerateDecomposition
    || overlay.controllerState?.llm_assistance?.task_spec_generation === 'pending'
    || overlay.controllerState?.llm_assistance?.decomposition_generation === 'pending'
    || !overlay.taskSpecVariants
    || !overlay.subproblemGraph;
  if (needsDecompositionGeneration) {
    await executeGenerateDecomposition(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  const shouldReviewDecomposition = booleanFlag(args.reviewDecomposition || args.review_decomposition, true);
  const needsDecompositionReview = shouldReviewDecomposition && (
    shouldRegenerateDecomposition
    || overlay.controllerState?.llm_assistance?.decomposition_review === 'pending'
    || !overlay.decompositionReview
  );
  if (needsDecompositionReview) {
    await executeReviewDecomposition(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  if (!overlay.candidateGraph?.nodes?.length) {
    await executeGenerateCandidates(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  if (!overlay.candidateGraph?.edges?.length && (overlay.candidateGraph?.nodes?.length || 0) > 1) {
    await executeProposeEdges(paths, args);
    overlay = await loadControllerOverlay(paths);
  }
  const mode = normalizeMode(args.mode || overlay.controllerState?.mode);
  if (mode !== 'quick' && !overlay.judgeDecisions?.length && (overlay.candidateGraph?.nodes?.length || 0) > 0) {
    await executeJudgeBatch(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  if (mode !== 'quick' && !overlay.selectedSubgraphs?.subgraphs?.length && overlay.judgeDecisions?.length) {
    await executeSelectBatch(paths, args);
    overlay = await loadControllerOverlay(paths);
  }
  if (mode !== 'quick' && overlay.selectedSubgraphs?.subgraphs?.length && !overlay.methodCardPackText) {
    await executeExpandEvidence(paths, args);
    overlay = await loadControllerOverlay(paths);
  }
  if (mode !== 'quick' && !overlay.solutionSketches?.length && overlay.selectedSubgraphs?.subgraphs?.length) {
    await executeComposeSolutions(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  if (mode !== 'quick' && !overlay.designReview?.reviews?.length && overlay.solutionSketches?.length) {
    await executeDesignReview(paths, args, context);
    overlay = await loadControllerOverlay(paths);
  }
  if (mode !== 'quick' && !overlay.innovationBriefs?.briefs?.length && overlay.solutionSketches?.length) {
    await executeComposeInnovationBriefs(paths, args);
  }
  const exportResult = await executeExport(paths);
  return {
    ...exportResult,
    action: 'run_round',
    action_completed: mode === 'quick' ? 'run_round_graph_candidates_and_edges' : 'run_round_planning_full_design_packet',
    warnings: [
      ...exportResult.warnings,
      mode === 'quick'
        ? 'run_round quick mode initializes or refreshes task/decomposition artifacts, reviews decomposition when enabled, generates graph-only candidates, proposes heuristic candidate edges, and exports them.'
        : 'run_round planning mode initializes or refreshes task/decomposition artifacts, reviews decomposition when enabled, generates graph-only candidates, proposes heuristic edges, records judge evidence, selects a batch, expands selected method cards, composes solution sketches, runs design review, composes bounded innovation briefs, and exports them as user decision artifacts.'
    ]
  };
}

async function executeBlockedAction(action, paths) {
  const overlay = await loadControllerOverlay(paths);
  return baseResponse(action, paths, overlay, overlay.controllerState, {
    status: 'blocked',
    warnings: [`Action ${action} is part of the ExecPlan but is not implemented in the foundation slice.`],
    user_decision_needed: ['Implement the next controller phase before calling this action in production.']
  });
}

export async function executeResearchController(args = {}, context = {}) {
  const rootPath = context.rootPath;
  if (!rootPath) throw new Error('research_controller requires a resolved corpus rootPath.');
  const paths = controllerPaths(rootPath, researchControllerProject(args));
  const action = normalizeAction(args.action || 'status');

  if (action === 'status') return executeStatus(paths);
  if (action === 'init_task') return executeInitTask(paths, args);
  if (action === 'generate_decomposition') return executeGenerateDecomposition(paths, args, context);
  if (action === 'review_decomposition') return executeReviewDecomposition(paths, args, context);
  if (action === 'export') return executeExport(paths);
  if (action === 'generate_candidates') return executeGenerateCandidates(paths, args, context);
  if (action === 'propose_edges') return executeProposeEdges(paths, args);
  if (action === 'judge_batch') return executeJudgeBatch(paths, args, context);
  if (action === 'select_batch') return executeSelectBatch(paths, args);
  if (action === 'expand_evidence') return executeExpandEvidence(paths, args, context);
  if (action === 'execute_material_requests') return executeMaterialRequests(paths, args, context);
  if (action === 'record_material_results') return executeRecordMaterialResults(paths, args, context);
  if (action === 'compose_solutions') return executeComposeSolutions(paths, args, context);
  if (action === 'design_review') return executeDesignReview(paths, args, context);
  if (action === 'compose_innovation_briefs') return executeComposeInnovationBriefs(paths, args, context);
  if (action === 'generate_experiment_plan') return executeGenerateExperimentPlan(paths, args, context);
  if (action === 'validate_gcd_mvp') return executeValidateGcdMvp(paths, args, context);
  if (action === 'run_round') return executeRunRound(paths, args, context);
  if (FOUNDATION_BLOCKED_ACTIONS.has(action)) return executeBlockedAction(action, paths);

  throw new Error(`Unhandled research_controller action: ${action}`);
}
