import { stableHash, truncate, unique } from '../../lib/utils.js';

export const STRUCTURAL_GAP_CONTRACT_VERSION = 'papernexus-structural-gap-v1';
export const INNOVATION_PATTERN_CONTRACT_VERSION = 'papernexus-innovation-pattern-v1';

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function normalizeText(value = '') {
  return compactText(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function boundedInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function paperKey(record = {}) {
  return compactText(record.paper_id || record.paperId)
    || normalizeText(record.title || record.paperTitle)
    || compactText(record.material_id);
}

function materialItems(materialPack = {}) {
  const byKey = new Map();
  for (const item of (materialPack.groups || []).flatMap((group) => group.items || [])) {
    const key = paperKey(item);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...item,
        roles: unique([item.role].map(compactText).filter(Boolean)),
        graph_context: [...(item.graph_context || [])],
        provenance: [...(item.provenance || [])]
      });
      continue;
    }
    existing.roles = unique([...existing.roles, item.role].map(compactText).filter(Boolean));
    existing.graph_context = dedupeObjects(
      [...existing.graph_context, ...(item.graph_context || [])],
      (entry) => entry.relationship_id || `${entry.relationship_type}:${entry.node_id}:${entry.node_name}`
    );
    existing.provenance = dedupeObjects(
      [...existing.provenance, ...(item.provenance || [])],
      (entry) => `${entry.source_type}:${entry.source_id}:${entry.query || ''}`
    );
  }
  return [...byKey.values()];
}

function dedupeObjects(records = [], keyFn = (entry) => JSON.stringify(entry)) {
  const seen = new Set();
  return records.filter((record) => {
    const key = keyFn(record);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRefsForItem(item = {}) {
  return dedupeObjects([
    ...(item.graph_context || []).map((entry) => ({
      source_type: 'graph_relationship',
      source_id: entry.relationship_id || null,
      relationship_type: entry.relationship_type || null,
      node_id: entry.node_id || null,
      source_span_id: entry.provenance || null
    })),
    ...(item.provenance || []).map((entry) => ({
      source_type: entry.source_type || null,
      source_id: entry.source_id || null,
      query: entry.query || null,
      provider: entry.provider || null
    }))
  ], (entry) => `${entry.source_type}:${entry.source_id}:${entry.node_id || ''}:${entry.query || ''}`);
}

function methodRef(step = {}) {
  return {
    method_id: step.methodId || step.method_id || null,
    method_name: step.methodName || step.method_name || step.canonicalName || null,
    year: step.year || null,
    paper_id: step.paperId || step.paper_id || null,
    paper_title: step.paperTitle || step.paper_title || null
  };
}

function lineageMethodSteps(methodLineage = {}) {
  return (methodLineage.lineages || []).flatMap((lineage) => (lineage.steps || []).map((step, index) => ({
    ...methodRef(step),
    direction: lineage.direction,
    lineage_score: lineage.score,
    lineage_step: index
  })));
}

function samePaper(left = {}, right = {}) {
  const leftId = compactText(left.paper_id || left.paperId);
  const rightId = compactText(right.paper_id || right.paperId);
  if (leftId && rightId) return leftId === rightId;
  const leftTitle = normalizeText(left.title || left.paper_title || left.paperTitle);
  const rightTitle = normalizeText(right.title || right.paper_title || right.paperTitle);
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

function buildFrontierStatus(methodLineage = {}) {
  const methodRequested = Boolean(compactText(methodLineage.query));
  const matchedMethod = methodLineage.matchedMethod || null;
  if (!methodRequested) {
    return {
      status: 'not_requested',
      candidates: [],
      traversal_boundary: 'Supply method or methodName to audit a validated method lineage.',
      global_leaf_proven: false
    };
  }
  if (!matchedMethod) {
    return {
      status: methodLineage.diagnostics?.ambiguity || 'unresolved',
      candidates: [],
      traversal_boundary: 'Method resolution did not produce one accepted lineage anchor.',
      global_leaf_proven: false
    };
  }

  const forwardLineages = (methodLineage.lineages || []).filter((lineage) => lineage.direction === 'forward');
  const candidates = forwardLineages.length
    ? forwardLineages.map((lineage) => {
        const steps = lineage.steps || [];
        const endpoint = steps[steps.length - 1] || matchedMethod;
        return {
          frontier_candidate_id: `frontier:${stableHash(`${endpoint.methodId || endpoint.methodName}:${steps.length}`, 14)}`,
          ...methodRef(endpoint),
          path_method_ids: steps.map((step) => step.methodId).filter(Boolean),
          path_edge_ids: steps.map((step) => step.edgeToNext?.edgeId).filter(Boolean),
          path_score: lineage.score,
          max_depth_boundary_reached: Math.max(0, steps.length - 1) >= Number(methodLineage.maxDepth || 0)
        };
      })
    : [{
        frontier_candidate_id: `frontier:${stableHash(matchedMethod.methodId || matchedMethod.methodName, 14)}`,
        ...methodRef(matchedMethod),
        path_method_ids: [matchedMethod.methodId].filter(Boolean),
        path_edge_ids: [],
        path_score: matchedMethod.matchScore || 0,
        max_depth_boundary_reached: false
      }];

  return {
    status: forwardLineages.length ? 'bounded_forward_endpoints' : 'no_forward_edge_in_bounded_traversal',
    candidates: dedupeObjects(candidates, (entry) => entry.method_id || entry.method_name),
    traversal_boundary: 'Candidates are endpoints of validated quoted method-evolution traversal within maxDepth/branch limits; they are not corpus-global leaf proof.',
    global_leaf_proven: false
  };
}

function assumptionOccurrences(materialPack = {}, methodLineage = {}) {
  const lineageSteps = lineageMethodSteps(methodLineage);
  const groups = new Map();
  for (const item of materialItems(materialPack)) {
    const itemKey = paperKey(item);
    for (const context of item.graph_context || []) {
      if (String(context.node_type || '').toLowerCase() !== 'assumption') continue;
      const assumption = compactText(context.node_name);
      if (!assumption) continue;
      const key = normalizeText(assumption);
      const group = groups.get(key) || {
        assumption_id: `assumption-persistence:${stableHash(key, 14)}`,
        assumption,
        occurrences: new Map()
      };
      const lineageMatches = lineageSteps.filter((step) => samePaper(item, step));
      const occurrence = group.occurrences.get(itemKey) || {
        paper: {
          paper_id: item.paper_id || null,
          title: item.title || null,
          status: item.status || null
        },
        roles: item.roles || [item.role].filter(Boolean),
        lineage_methods: [],
        evidence_refs: []
      };
      occurrence.roles = unique([...occurrence.roles, ...(item.roles || []), item.role].map(compactText).filter(Boolean));
      occurrence.lineage_methods = dedupeObjects([
        ...occurrence.lineage_methods,
        ...lineageMatches.map(methodRef)
      ], (entry) => entry.method_id || entry.method_name);
      occurrence.evidence_refs = dedupeObjects([
        ...occurrence.evidence_refs,
        {
          source_type: 'graph_relationship',
          source_id: context.relationship_id || null,
          relationship_type: context.relationship_type || null,
          assumption_node_id: context.node_id || null,
          source_span_id: context.provenance || null
        },
        ...sourceRefsForItem(item)
      ], (entry) => `${entry.source_type}:${entry.source_id}:${entry.assumption_node_id || entry.node_id || ''}`);
      group.occurrences.set(itemKey, occurrence);
      groups.set(key, group);
    }
  }

  return [...groups.values()].map((group) => {
    const occurrences = [...group.occurrences.values()];
    const lineageMethods = dedupeObjects(
      occurrences.flatMap((entry) => entry.lineage_methods),
      (entry) => entry.method_id || entry.method_name
    );
    return {
      assumption_id: group.assumption_id,
      assumption: group.assumption,
      distinct_paper_count: occurrences.length,
      lineage_generation_count: lineageMethods.length,
      persistence_scope: lineageMethods.length >= 2 ? 'cross_lineage_generation' : 'cross_material_paper',
      confidence: lineageMethods.length >= 3
        ? 'high'
        : (lineageMethods.length >= 2 || occurrences.length >= 3 ? 'medium' : 'bounded'),
      papers: occurrences.map((entry) => entry.paper),
      lineage_methods: lineageMethods,
      evidence_refs: dedupeObjects(
        occurrences.flatMap((entry) => entry.evidence_refs),
        (entry) => `${entry.source_type}:${entry.source_id}:${entry.assumption_node_id || entry.node_id || ''}`
      ),
      evidence_status: 'graph_context_grounded'
    };
  }).sort((left, right) => right.lineage_generation_count - left.lineage_generation_count
    || right.distinct_paper_count - left.distinct_paper_count
    || left.assumption.localeCompare(right.assumption));
}

function frontierIdsForGap(gap = {}, frontierStatus = {}) {
  return (frontierStatus.candidates || [])
    .filter((candidate) => (gap.supporting_papers || []).some((paper) => samePaper(paper, candidate)))
    .map((candidate) => candidate.frontier_candidate_id);
}

function buildAdditiveGaps(gapMap = [], methodLineage = {}, frontierStatus = {}) {
  const gaps = [];
  for (const gap of gapMap) {
    if (gap.gap_type === 'assumption_risk') continue;
    const frontierIds = frontierIdsForGap(gap, frontierStatus);
    gaps.push({
      structural_gap_id: `structural-add:${stableHash(gap.gap_id || gap.statement, 14)}`,
      gap_kind: 'additive',
      gap_type: gap.gap_type || 'material_limitation',
      statement: gap.statement || '',
      basis: frontierIds.length ? 'frontier_material_gap' : 'material_gap',
      source_gap_ids: [gap.gap_id].filter(Boolean),
      frontier_candidate_ids: frontierIds,
      supporting_papers: gap.supporting_papers || [],
      evidence_refs: gap.source_spans || [],
      confidence: frontierIds.length ? 'medium' : 'bounded',
      evidence_status: 'material_pack_derived',
      boundary: 'A material limitation is an opportunity candidate, not proof that no existing work has solved it.'
    });
  }

  for (const candidate of methodLineage.nextGapCandidates || []) {
    gaps.push({
      structural_gap_id: `structural-lineage:${stableHash(`${candidate.gap}:${(candidate.groundingEdges || []).join('|')}`, 14)}`,
      gap_kind: 'additive',
      gap_type: 'lineage_bottleneck_tradeoff',
      statement: candidate.gap || '',
      basis: 'validated_lineage_trajectory',
      source_gap_ids: [],
      frontier_candidate_ids: [],
      supporting_papers: [],
      evidence_refs: (candidate.groundingEdges || []).map((edgeId, index) => ({
        source_type: 'method_evolution_edge',
        source_id: edgeId,
        quote: candidate.evidenceQuotes?.[index] || null
      })),
      bottleneck_dimension: candidate.bottleneckDimension || null,
      tradeoff_dimension: candidate.tradeoffDimension || null,
      confidence: candidate.confidence || 0,
      evidence_status: 'validated_lineage_derived',
      boundary: 'The candidate combines observed lineage bottleneck/trade-off dimensions; it is not a generated mechanism or novelty proof.'
    });
  }

  return dedupeObjects(gaps, (gap) => `${gap.gap_kind}:${normalizeText(gap.statement)}`).slice(0, 20);
}

function buildSubtractiveGaps(persistentAssumptions = [], gapMap = []) {
  return persistentAssumptions.map((entry) => {
    const matchingGapIds = gapMap
      .filter((gap) => gap.gap_type === 'assumption_risk')
      .filter((gap) => {
        const statement = normalizeText(gap.statement);
        const assumption = normalizeText(entry.assumption);
        return statement.includes(assumption) || assumption.includes(statement);
      })
      .map((gap) => gap.gap_id)
      .filter(Boolean);
    return {
      structural_gap_id: `structural-sub:${stableHash(entry.assumption_id, 14)}`,
      gap_kind: 'subtractive',
      gap_type: 'persistent_assumption',
      statement: `Test whether the persistent assumption "${entry.assumption}" can be removed, replaced, or reinterpreted without losing protected lineage capabilities.`,
      basis: entry.persistence_scope,
      source_gap_ids: matchingGapIds,
      persistent_assumption_id: entry.assumption_id,
      distinct_paper_count: entry.distinct_paper_count,
      lineage_generation_count: entry.lineage_generation_count,
      supporting_papers: entry.papers,
      evidence_refs: entry.evidence_refs,
      confidence: entry.confidence,
      evidence_status: entry.evidence_status,
      boundary: 'Persistence supports a removal/replacement hypothesis only; necessity must be tested with a counterfactual ablation.'
    };
  });
}

function edgeAxisText(edge = {}, key) {
  return compactText([edge[key]?.dimension, edge[key]?.description].filter(Boolean).join(' — '));
}

function buildHistoricalRegressionWatchlist(methodLineage = {}, args = {}) {
  const candidateText = normalizeText([
    args.candidateMechanism,
    args.candidate_mechanism,
    ...asArray(args.removedComponents || args.removed_components),
    ...asArray(args.ideaComponents || args.idea_components)
  ].filter(Boolean).join(' '));
  const watchlist = [];
  for (const lineage of (methodLineage.lineages || []).filter((entry) => entry.direction === 'backward')) {
    const steps = lineage.steps || [];
    for (let index = 0; index < steps.length - 1; index += 1) {
      const step = steps[index];
      const ancestor = steps[index + 1];
      const edge = step.edgeToNext;
      if (!edge) continue;
      const protectedCapability = edgeAxisText(edge, 'bottleneck');
      if (!protectedCapability || normalizeText(protectedCapability) === 'bottleneck') continue;
      const terms = normalizeText(protectedCapability).split(' ').filter((term) => term.length > 2);
      const candidateMentionsCapability = Boolean(candidateText && terms.some((term) => candidateText.includes(term)));
      watchlist.push({
        regression_watch_id: `regression:${stableHash(`${edge.edgeId}:${protectedCapability}`, 14)}`,
        protected_capability: protectedCapability,
        resolved_or_mitigated_by: methodRef(step),
        predecessor: methodRef(ancestor),
        lineage_edge_id: edge.edgeId || null,
        lineage_edge_type: edge.paperEdgeType || edge.edgeType || null,
        introduced_tradeoff: edgeAxisText(edge, 'tradeoff') || null,
        evidence_refs: [{
          source_type: 'method_evolution_edge',
          source_id: edge.edgeId || null,
          quote: edge.evidence?.quote || null,
          paper_id: edge.evidence?.paperId || null,
          source_span_id: edge.evidence?.sourceSpanId || null
        }],
        risk_status: candidateText
          ? (candidateMentionsCapability ? 'candidate_mentions_protected_capability' : 'counterfactual_not_yet_tested')
          : 'requires_candidate_mechanism',
        required_test: `Verify that the candidate does not reintroduce the ${edge.bottleneck?.dimension || 'recorded'} bottleneck under a protocol aligned with the lineage evidence.`,
        boundary: 'This is a regression watch item derived from lineage history, not evidence that the candidate actually regresses.'
      });
    }
  }
  return dedupeObjects(watchlist, (entry) => `${normalizeText(entry.protected_capability)}:${entry.resolved_or_mitigated_by.method_id || entry.resolved_or_mitigated_by.method_name}`)
    .slice(0, 16);
}

export function compileStructuralGapAnalysis({
  materialPack = {},
  gapMap = [],
  methodLineage = {},
  args = {}
} = {}) {
  const persistenceThreshold = boundedInteger(
    args.persistentAssumptionMinPapers ?? args.persistent_assumption_min_papers,
    2,
    { min: 2, max: 10 }
  );
  const frontierLeafStatus = buildFrontierStatus(methodLineage);
  const observedAssumptions = assumptionOccurrences(materialPack, methodLineage);
  const persistentAssumptions = observedAssumptions
    .filter((entry) => entry.distinct_paper_count >= persistenceThreshold);
  const additiveGaps = buildAdditiveGaps(gapMap, methodLineage, frontierLeafStatus);
  const subtractiveGaps = buildSubtractiveGaps(persistentAssumptions, gapMap);
  const historicalRegressionWatchlist = buildHistoricalRegressionWatchlist(methodLineage, args);
  const structuralGapCount = additiveGaps.length + subtractiveGaps.length;
  const methodRequested = Boolean(compactText(methodLineage.query));
  const methodResolved = Boolean(methodLineage.matchedMethod);
  const reasonCodes = unique([
    structuralGapCount ? '' : 'structural_gap_not_established',
    !methodRequested ? 'method_lineage_not_requested' : '',
    methodRequested && !methodResolved ? `method_lineage_${methodLineage.diagnostics?.ambiguity || 'unresolved'}` : '',
    persistentAssumptions.length ? '' : 'persistent_assumption_not_established',
    historicalRegressionWatchlist.length ? '' : 'historical_regression_evidence_unavailable'
  ].filter(Boolean));
  const status = structuralGapCount === 0
    ? 'starved'
    : (methodRequested && methodResolved ? 'ready' : 'partial');

  return {
    contractVersion: STRUCTURAL_GAP_CONTRACT_VERSION,
    status,
    reason_codes: reasonCodes,
    sequence_contract: {
      order: ['source_evidence', 'validated_method_lineage', 'structural_gap', 'research_action', 'candidate_mechanism', 'collision_regression_falsification_audit'],
      current_stage: 'structural_gap',
      pattern_matching_allowed: structuralGapCount > 0,
      direct_topic_to_pattern_allowed: false
    },
    method_lineage: methodLineage,
    frontier_leaf_status: frontierLeafStatus,
    additive_gaps: additiveGaps,
    subtractive_gaps: subtractiveGaps,
    persistent_assumptions: persistentAssumptions,
    observed_nonpersistent_assumptions: observedAssumptions
      .filter((entry) => entry.distinct_paper_count < persistenceThreshold),
    historical_regression_watchlist: historicalRegressionWatchlist,
    evidence_boundaries: {
      graph_grounded: 'Paper, Assumption, and accepted quoted lineage relations originate from the committed corpus graph/material views.',
      derived: 'Gap kind, persistence scope, frontier-candidate status, and regression watch items are deterministic synthesis over graph-backed records.',
      speculative: 'Removing an assumption, choosing a pattern, and expecting a metric change remain hypotheses until proposal review and experiments.',
      unsupported: 'No global leaf, novelty, semantic-equivalence, acceptance-probability, or empirical improvement claim is made.'
    },
    data_starvation: {
      status: structuralGapCount ? (reasonCodes.length ? 'partial' : 'ok') : 'starved',
      missing: reasonCodes,
      persistence_threshold_distinct_papers: persistenceThreshold,
      observed_assumption_count: observedAssumptions.length,
      material_gap_count: gapMap.length
    }
  };
}

const SEED_ORIGIN = Object.freeze({
  source_type: 'seed_taxonomy',
  source: 'ResearchStudio-style research-action vocabulary',
  empirical_outcome_backed: false,
  boundary: 'The card is a heuristic action/audit template. PaperNexus has not mined or validated Oral/high-citation/Reject outcome statistics for it.'
});

function seedPattern({
  id,
  name,
  category,
  action,
  gapKinds,
  gapTypes,
  triggers,
  mechanismRecipe,
  successRecipe,
  failureRecipe,
  requiredEvidence,
  antiPatterns,
  compatiblePatterns = []
}) {
  return Object.freeze({
    pattern_id: id,
    name,
    category,
    research_action: action,
    supported_gap_kinds: gapKinds,
    trigger_gap_types: gapTypes,
    trigger_terms: triggers,
    mechanism_recipe: mechanismRecipe,
    success_recipe: successRecipe,
    failure_recipe: failureRecipe,
    required_evidence: requiredEvidence,
    anti_patterns: antiPatterns,
    compatible_patterns: compatiblePatterns,
    evidence_origin: SEED_ORIGIN
  });
}

export const RESEARCHSTUDIO_SEED_PATTERN_CARDS = Object.freeze([
  seedPattern({
    id: 'rs-audit-flip-assumption', name: 'Audit and flip an implicit assumption', category: 'diagnosis_reframing',
    action: 'Identify an inherited assumption, test necessity, then remove, invert, or condition it.',
    gapKinds: ['subtractive'], gapTypes: ['persistent_assumption', 'assumption_risk'], triggers: ['assumption', 'requires', 'depends', 'fixed', 'available'],
    mechanismRecipe: 'Name the assumed object, define a counterfactual without it, and specify the information or optimization path that changes.',
    successRecipe: 'A necessity test fails, the replacement mechanism is explicit, and protected capabilities remain intact.',
    failureRecipe: 'The assumption is merely renamed, or removal silently changes the task/protocol.',
    requiredEvidence: ['cross-paper assumption evidence', 'necessity ablation', 'historical-regression guard'],
    antiPatterns: ['unsupported contrarian claim', 'task redefinition'], compatiblePatterns: ['rs-replace-operator-representation', 'rs-characterize-limit']
  }),
  seedPattern({
    id: 'rs-isolate-confounder', name: 'Construct a confound-isolating diagnosis', category: 'diagnosis_reframing',
    action: 'Design a slice or intervention that separates the suspected cause from correlated factors.',
    gapKinds: ['additive'], gapTypes: ['benchmark_failure', 'claim_evidence_mismatch', 'mechanism_uncertainty'], triggers: ['confound', 'failure', 'slice', 'mechanism', 'causal'],
    mechanismRecipe: 'Hold competing factors fixed and vary only the suspected cause with an observable response.',
    successRecipe: 'The diagnostic distinguishes rival explanations and predicts a targeted intervention.',
    failureRecipe: 'The diagnostic is another aggregate benchmark or leaks the target label.',
    requiredEvidence: ['rival hypothesis', 'controlled slice', 'observable response'],
    antiPatterns: ['post-hoc story', 'uncontrolled subgroup'], compatiblePatterns: ['rs-characterize-limit']
  }),
  seedPattern({
    id: 'rs-rewrite-solvable-object', name: 'Rewrite the problem as a solvable object', category: 'diagnosis_reframing',
    action: 'Change the formal object or objective so the true bottleneck becomes explicit and tractable.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['mechanism_uncertainty', 'limitation', 'persistent_assumption'], triggers: ['ill posed', 'non identifiable', 'objective', 'formulation', 'constraint'],
    mechanismRecipe: 'Specify the old object, the new object, their mapping, and what information becomes available or unnecessary.',
    successRecipe: 'The reformulation exposes a testable invariant and does not solve an easier unrelated task.',
    failureRecipe: 'Notation changes while the computation and assumptions remain identical.',
    requiredEvidence: ['formal mapping', 'identifiability or tractability argument', 'protocol equivalence check'],
    antiPatterns: ['cosmetic reformulation'], compatiblePatterns: ['rs-relax-discrete-continuous', 'rs-prove-equivalence']
  }),
  seedPattern({
    id: 'rs-characterize-limit', name: 'Characterize the limit before breaking it', category: 'diagnosis_reframing',
    action: 'Establish an empirical or theoretical ceiling, then target the condition that creates it.',
    gapKinds: ['additive'], gapTypes: ['benchmark_failure', 'missing_ablation', 'mechanism_uncertainty', 'limitation'], triggers: ['limit', 'ceiling', 'bound', 'failure', 'saturat'],
    mechanismRecipe: 'Define the limiting regime, derive or measure the ceiling, and change one causal condition.',
    successRecipe: 'The ceiling predicts failures and the intervention improves exactly where the bound is active.',
    failureRecipe: 'A broad weakness is called a limit without a falsifiable boundary.',
    requiredEvidence: ['limit curve or theorem', 'boundary slice', 'matched intervention'],
    antiPatterns: ['generic scaling claim'], compatiblePatterns: ['rs-isolate-confounder']
  }),
  seedPattern({
    id: 'rs-replace-operator-representation', name: 'Replace the operator or representation', category: 'representation_structure',
    action: 'Replace the object that loses or distorts task-relevant information.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['persistent_assumption', 'mechanism_uncertainty', 'lineage_bottleneck_tradeoff', 'limitation'], triggers: ['representation', 'operator', 'information loss', 'bottleneck', 'embedding'],
    mechanismRecipe: 'Name the replaced layer/operator, its replacement, and the altered information path.',
    successRecipe: 'The replacement targets the diagnosed loss and wins under a matched-capacity ablation.',
    failureRecipe: 'A larger backbone or renamed feature is presented as a new representation.',
    requiredEvidence: ['information-loss diagnosis', 'matched-capacity baseline', 'representation ablation'],
    antiPatterns: ['backbone swap', 'capacity confound'], compatiblePatterns: ['rs-audit-flip-assumption', 'rs-encode-task-structure']
  }),
  seedPattern({
    id: 'rs-encode-task-structure', name: 'Encode task structure explicitly', category: 'representation_structure',
    action: 'Inject a known relational, geometric, temporal, or compositional structure into the mechanism.',
    gapKinds: ['additive'], gapTypes: ['limitation', 'benchmark_failure', 'lineage_bottleneck_tradeoff'], triggers: ['structure', 'relation', 'geometry', 'temporal', 'hierarchy', 'composition'],
    mechanismRecipe: 'Define the structure, where it enters the computation, and what invalid solution it excludes.',
    successRecipe: 'Structure-aware gains concentrate on structure-sensitive slices and survive capacity controls.',
    failureRecipe: 'Structure is only an extra feature with no pathway or diagnostic evidence.',
    requiredEvidence: ['structure-sensitive slice', 'capacity control', 'structure removal ablation'],
    antiPatterns: ['feature concatenation only'], compatiblePatterns: ['rs-replace-operator-representation']
  }),
  seedPattern({
    id: 'rs-unify-heterogeneous-inputs', name: 'Unify heterogeneous inputs', category: 'representation_structure',
    action: 'Map heterogeneous modalities, domains, or schemas into a shared operational interface while retaining distinctions that matter.',
    gapKinds: ['additive'], gapTypes: ['limitation', 'lineage_bottleneck_tradeoff'], triggers: ['heterogeneous', 'modality', 'domain', 'schema', 'unify', 'alignment'],
    mechanismRecipe: 'Define the shared interface, retained type information, and cross-source interaction.',
    successRecipe: 'The interface enables transfer without erasing source-specific failure signals.',
    failureRecipe: 'Inputs are concatenated or projected with no invariance or alignment test.',
    requiredEvidence: ['cross-source transfer test', 'source-identity ablation', 'alignment diagnostic'],
    antiPatterns: ['naive concatenation'], compatiblePatterns: ['rs-heterogeneous-decomposition']
  }),
  seedPattern({
    id: 'rs-release-fixed-generator', name: 'Release a fixed generative component', category: 'representation_structure',
    action: 'Turn a historically fixed generator, retriever, simulator, or proposal component into a controlled adaptive variable.',
    gapKinds: ['subtractive', 'additive'], gapTypes: ['persistent_assumption', 'limitation', 'lineage_bottleneck_tradeoff'], triggers: ['fixed', 'generator', 'retriever', 'proposal', 'frozen', 'static'],
    mechanismRecipe: 'Specify what becomes adaptive, its control signal, and stability/identifiability constraints.',
    successRecipe: 'Adaptation addresses the target failure while stability and cost remain bounded.',
    failureRecipe: 'End-to-end retraining adds capacity without testing the fixed-component hypothesis.',
    requiredEvidence: ['fixed-vs-adaptive ablation', 'stability guard', 'cost comparison'],
    antiPatterns: ['unbounded end-to-end tuning'], compatiblePatterns: ['rs-conditionalize-not-retrain']
  }),
  seedPattern({
    id: 'rs-synthesize-supervision', name: 'Manufacture supervision', category: 'supervision_adaptation',
    action: 'Create a task-aligned supervisory signal when direct labels are unavailable.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['persistent_assumption', 'limitation', 'benchmark_failure'], triggers: ['label', 'supervision', 'pseudo', 'self supervised', 'weak signal'],
    mechanismRecipe: 'Define signal generation, noise model, filtering, and how it reaches the target objective.',
    successRecipe: 'The signal predicts target improvement beyond data-volume and teacher-capacity controls.',
    failureRecipe: 'Pseudo-labeling recycles model confidence and amplifies the diagnosed bias.',
    requiredEvidence: ['signal-quality audit', 'noise sensitivity', 'teacher/capacity control'],
    antiPatterns: ['confidence recycling'], compatiblePatterns: ['rs-targeted-pretraining-objective']
  }),
  seedPattern({
    id: 'rs-targeted-pretraining-objective', name: 'Design a targeted pretraining objective', category: 'supervision_adaptation',
    action: 'Pretrain on an objective that isolates the downstream bottleneck instead of using generic scale.',
    gapKinds: ['additive'], gapTypes: ['benchmark_failure', 'mechanism_uncertainty', 'limitation'], triggers: ['pretrain', 'objective', 'signal', 'transfer', 'downstream'],
    mechanismRecipe: 'Link each pretraining signal to the diagnosed downstream failure and define a transfer prediction.',
    successRecipe: 'A matched-data/objective ablation shows the targeted signal drives the downstream slice.',
    failureRecipe: 'More pretraining compute or data is the only effective difference.',
    requiredEvidence: ['matched data/compute baseline', 'transfer slice', 'objective ablation'],
    antiPatterns: ['scale-only improvement'], compatiblePatterns: ['rs-synthesize-supervision']
  }),
  seedPattern({
    id: 'rs-conditionalize-not-retrain', name: 'Condition instead of retraining', category: 'supervision_adaptation',
    action: 'Represent changing conditions explicitly and adapt through conditioning rather than full retraining.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['missing_cost', 'persistent_assumption', 'limitation'], triggers: ['retrain', 'adaptation cost', 'condition', 'context', 'shift'],
    mechanismRecipe: 'Define the condition variable, injection site, and behavior under unseen or misestimated conditions.',
    successRecipe: 'Conditioning matches adaptation quality with lower cost and degrades gracefully under condition error.',
    failureRecipe: 'A hidden retraining loop or oracle condition is required.',
    requiredEvidence: ['cost-matched adaptation baseline', 'condition-error stress test', 'unseen-condition test'],
    antiPatterns: ['oracle metadata', 'hidden fine-tuning'], compatiblePatterns: ['rs-release-fixed-generator']
  }),
  seedPattern({
    id: 'rs-heterogeneous-decomposition', name: 'Use heterogeneous decomposition', category: 'decomposition_optimization_theory',
    action: 'Split coupled factors by type and assign different mechanisms instead of one homogeneous module.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['persistent_assumption', 'lineage_bottleneck_tradeoff', 'mechanism_uncertainty'], triggers: ['heterogeneous', 'coupled', 'factor', 'mixture', 'conflict'],
    mechanismRecipe: 'Define factor types, assignment rule, interactions, and what coupling is removed.',
    successRecipe: 'Type-specific mechanisms outperform a matched homogeneous model and assignment errors are bounded.',
    failureRecipe: 'Several modules are stacked without a factorization argument.',
    requiredEvidence: ['factor diagnosis', 'homogeneous capacity control', 'assignment-error test'],
    antiPatterns: ['module soup'], compatiblePatterns: ['rs-unify-heterogeneous-inputs', 'rs-decompose-delegate']
  }),
  seedPattern({
    id: 'rs-decompose-delegate', name: 'Decompose and delegate subtasks', category: 'decomposition_optimization_theory',
    action: 'Separate subtasks with different information or optimization needs and route each to a suitable solver.',
    gapKinds: ['additive'], gapTypes: ['lineage_bottleneck_tradeoff', 'limitation', 'missing_cost'], triggers: ['subtask', 'route', 'delegate', 'specialist', 'decompose'],
    mechanismRecipe: 'Define subtask boundaries, router evidence, solver contracts, and error propagation.',
    successRecipe: 'Delegation improves the diagnosed bottleneck beyond matched ensemble capacity and routing overhead.',
    failureRecipe: 'A larger ensemble is used with no principled decomposition or routing audit.',
    requiredEvidence: ['subtask separability', 'matched ensemble baseline', 'router/error propagation audit'],
    antiPatterns: ['ensemble relabeling'], compatiblePatterns: ['rs-heterogeneous-decomposition']
  }),
  seedPattern({
    id: 'rs-relax-discrete-continuous', name: 'Relax a discrete problem continuously', category: 'decomposition_optimization_theory',
    action: 'Replace a brittle discrete decision with a differentiable or otherwise tractable relaxation while controlling the relaxation gap.',
    gapKinds: ['additive'], gapTypes: ['lineage_bottleneck_tradeoff', 'limitation', 'mechanism_uncertainty'], triggers: ['discrete', 'combinatorial', 'non differentiable', 'relax', 'optimization'],
    mechanismRecipe: 'Define the discrete object, relaxation, projection/recovery step, and relaxation-gap diagnostic.',
    successRecipe: 'Optimization improves while recovery quality and constraint violations remain controlled.',
    failureRecipe: 'A soft approximation is used without measuring bias or feasibility.',
    requiredEvidence: ['relaxation-gap audit', 'constraint violation', 'discrete solver baseline'],
    antiPatterns: ['temperature trick only'], compatiblePatterns: ['rs-rewrite-solvable-object']
  }),
  seedPattern({
    id: 'rs-prove-equivalence', name: 'Prove equivalence between apparently different methods', category: 'decomposition_optimization_theory',
    action: 'Expose a shared invariant or transformation that unifies methods and reveals the true degrees of freedom.',
    gapKinds: ['additive', 'subtractive'], gapTypes: ['mechanism_uncertainty', 'persistent_assumption', 'claim_evidence_mismatch'], triggers: ['equivalent', 'invariant', 'unify', 'transformation', 'same mechanism'],
    mechanismRecipe: 'State the transformation, assumptions, equivalence scope, and the residual non-equivalent component.',
    successRecipe: 'The equivalence predicts empirical behavior and removes a redundant design choice or suggests a new one.',
    failureRecipe: 'Two equations are made visually similar without matching assumptions or behavior.',
    requiredEvidence: ['formal transformation', 'assumption audit', 'prediction from equivalence'],
    antiPatterns: ['notation-only equivalence'], compatiblePatterns: ['rs-rewrite-solvable-object', 'rs-characterize-limit']
  })
]);

function normalizeCustomPattern(card = {}, index = 0) {
  const evidenceRefs = asArray(card.outcomeEvidenceRefs || card.outcome_evidence_refs || card.evidenceRefs || card.evidence_refs)
    .filter(Boolean);
  const empiricalOutcomeBacked = card.empiricalOutcomeBacked === true
    || card.empirical_outcome_backed === true;
  const id = compactText(card.pattern_id || card.patternId || card.id)
    || `custom-pattern:${stableHash(`${index}:${card.name || card.research_action || JSON.stringify(card)}`, 14)}`;
  return {
    pattern_id: id,
    name: compactText(card.name || card.title || id),
    category: compactText(card.category || 'caller_supplied'),
    research_action: compactText(card.research_action || card.researchAction || card.action),
    supported_gap_kinds: unique(asArray(card.supported_gap_kinds || card.supportedGapKinds || card.gapKinds).map(normalizeText).filter(Boolean)),
    trigger_gap_types: unique(asArray(card.trigger_gap_types || card.triggerGapTypes || card.gapTypes).map(normalizeText).filter(Boolean)),
    trigger_terms: unique(asArray(card.trigger_terms || card.triggerTerms || card.triggers).map(compactText).filter(Boolean)),
    mechanism_recipe: compactText(card.mechanism_recipe || card.mechanismRecipe),
    success_recipe: compactText(card.success_recipe || card.successRecipe),
    failure_recipe: compactText(card.failure_recipe || card.failureRecipe),
    required_evidence: unique(asArray(card.required_evidence || card.requiredEvidence).map(compactText).filter(Boolean)),
    anti_patterns: unique(asArray(card.anti_patterns || card.antiPatterns).map(compactText).filter(Boolean)),
    compatible_patterns: unique(asArray(card.compatible_patterns || card.compatiblePatterns).map(compactText).filter(Boolean)),
    evidence_origin: {
      source_type: evidenceRefs.length ? 'caller_supplied_evidence' : 'caller_supplied_heuristic',
      source: compactText(card.source || card.evidenceSource || card.evidence_source) || null,
      empirical_outcome_backed: Boolean(empiricalOutcomeBacked && evidenceRefs.length),
      evidence_refs: evidenceRefs,
      boundary: empiricalOutcomeBacked && !evidenceRefs.length
        ? 'Caller marked the card outcome-backed but supplied no evidence refs; PaperNexus downgraded it to heuristic.'
        : 'Caller-supplied provenance is preserved but not independently verified by this compiler.'
    }
  };
}

function patternCards(args = {}) {
  const cards = RESEARCHSTUDIO_SEED_PATTERN_CARDS.map((card) => ({
    ...card,
    evidence_origin: { ...card.evidence_origin }
  }));
  const seen = new Set(cards.map((card) => card.pattern_id));
  asArray(args.patternCards || args.pattern_cards).forEach((card, index) => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return;
    const normalized = normalizeCustomPattern(card, index);
    if (seen.has(normalized.pattern_id)) return;
    seen.add(normalized.pattern_id);
    cards.push(normalized);
  });
  return cards;
}

function patternScore(gap = {}, card = {}) {
  const gapKind = normalizeText(gap.gap_kind);
  const gapType = normalizeText(gap.gap_type);
  const text = normalizeText([
    gap.statement,
    gap.bottleneck_dimension,
    gap.tradeoff_dimension
  ].filter(Boolean).join(' '));
  const kindMatch = (card.supported_gap_kinds || []).map(normalizeText).includes(gapKind);
  const typeMatch = (card.trigger_gap_types || []).map(normalizeText).includes(gapType);
  const triggerHits = (card.trigger_terms || []).filter((term) => {
    const normalized = normalizeText(term);
    return normalized && text.includes(normalized);
  });
  const score = (kindMatch ? 0.15 : 0)
    + (typeMatch ? 0.45 : 0)
    + Math.min(0.4, triggerHits.length * 0.14);
  return {
    score: Number(Math.min(1, score).toFixed(4)),
    kind_match: kindMatch,
    type_match: typeMatch,
    trigger_hits: triggerHits
  };
}

function allStructuralGaps(structuralGapAnalysis = {}) {
  return [
    ...(structuralGapAnalysis.additive_gaps || []),
    ...(structuralGapAnalysis.subtractive_gaps || [])
  ];
}

export function compileInnovationPatternAnalysis({ structuralGapAnalysis = {}, args = {} } = {}) {
  const cards = patternCards(args);
  const gaps = allStructuralGaps(structuralGapAnalysis);
  const perGapLimit = boundedInteger(
    args.patternLimit ?? args.pattern_limit,
    2,
    { min: 1, max: 5 }
  );
  const matches = [];
  for (const gap of gaps) {
    const scored = cards.map((card) => ({ card, basis: patternScore(gap, card) }))
      .filter((entry) => entry.basis.score >= 0.25)
      .sort((left, right) => right.basis.score - left.basis.score
        || left.card.pattern_id.localeCompare(right.card.pattern_id))
      .slice(0, perGapLimit);
    for (const entry of scored) {
      matches.push({
        pattern_match_id: `pattern-match:${stableHash(`${gap.structural_gap_id}:${entry.card.pattern_id}`, 14)}`,
        structural_gap_id: gap.structural_gap_id,
        source_gap_ids: gap.source_gap_ids || [],
        gap_kind: gap.gap_kind,
        gap_type: gap.gap_type,
        pattern_id: entry.card.pattern_id,
        pattern_name: entry.card.name,
        research_action: entry.card.research_action,
        score: entry.basis.score,
        match_basis: entry.basis,
        mechanism_prompt: entry.card.mechanism_recipe,
        success_recipe: entry.card.success_recipe,
        failure_recipe: entry.card.failure_recipe,
        required_evidence: entry.card.required_evidence,
        anti_patterns: entry.card.anti_patterns,
        evidence_origin: entry.card.evidence_origin,
        boundary: 'A structural match recommends a research action; it does not validate a concrete mechanism or novelty claim.'
      });
    }
  }
  const matchedGapIds = new Set(matches.map((match) => match.structural_gap_id));
  const outcomeBackedCount = cards.filter((card) => card.evidence_origin?.empirical_outcome_backed === true).length;
  const status = !gaps.length
    ? 'blocked_no_structural_gap'
    : (matches.length ? 'ready_for_mechanism_instantiation' : 'partial_no_pattern_match');

  return {
    contractVersion: INNOVATION_PATTERN_CONTRACT_VERSION,
    status,
    policy: {
      pattern_selection_order: 'after_structural_gap',
      direct_topic_to_pattern_allowed: false,
      final_idea_judge: false,
      novelty_proof: false,
      seed_taxonomy_is_empirical_outcome_evidence: false
    },
    outcome_evidence_status: outcomeBackedCount
      ? 'mixed_seed_and_caller_supplied_outcome_evidence'
      : 'seed_taxonomy_only',
    pattern_cards: cards,
    matches,
    unmatched_gap_ids: gaps
      .filter((gap) => !matchedGapIds.has(gap.structural_gap_id))
      .map((gap) => gap.structural_gap_id),
    counts: {
      structural_gap_count: gaps.length,
      matched_gap_count: matchedGapIds.size,
      pattern_match_count: matches.length,
      seed_card_count: cards.filter((card) => card.evidence_origin?.source_type === 'seed_taxonomy').length,
      empirical_outcome_backed_card_count: outcomeBackedCount
    }
  };
}

export function attachResearchStudioTrace(
  ideaCards = [],
  structuralGapAnalysis = {},
  innovationPatternAnalysis = {}
) {
  const structuralGaps = allStructuralGaps(structuralGapAnalysis);
  return ideaCards.map((card) => {
    const sourceGapId = card.gap?.gap_id;
    const matchingStructural = structuralGaps.filter((gap) => (
      gap.structural_gap_id === sourceGapId
      || (gap.source_gap_ids || []).includes(sourceGapId)
    ));
    const structuralIds = new Set(matchingStructural.map((gap) => gap.structural_gap_id));
    const patternApplications = (innovationPatternAnalysis.matches || [])
      .filter((match) => structuralIds.has(match.structural_gap_id))
      .map((match) => ({
        pattern_match_id: match.pattern_match_id,
        pattern_id: match.pattern_id,
        pattern_name: match.pattern_name,
        research_action: match.research_action,
        score: match.score,
        evidence_origin: match.evidence_origin
      }));
    return {
      ...card,
      researchstudio_trace: {
        sequence: ['evidence', 'structural_gap', 'research_action', 'candidate_mechanism', 'collision_regression_falsification_audit'],
        status: matchingStructural.length ? 'structural_gap_linked' : 'unlinked_material_gap',
        structural_gap_refs: matchingStructural.map((gap) => ({
          structural_gap_id: gap.structural_gap_id,
          gap_kind: gap.gap_kind,
          gap_type: gap.gap_type,
          evidence_status: gap.evidence_status
        })),
        pattern_applications: patternApplications,
        historical_regression_watch_refs: (structuralGapAnalysis.historical_regression_watchlist || [])
          .map((entry) => entry.regression_watch_id),
        evidence_boundary: 'Pattern applications are action hypotheses. Candidate mechanism, collision, regression, and experimental claims remain subject to proposal review.'
      },
      what_is_agent_inferred: unique([
        ...(card.what_is_agent_inferred || []),
        ...patternApplications.map((match) => `Research-action match: ${match.pattern_name} (${match.pattern_id}).`)
      ])
    };
  });
}

const FINGERPRINT_STOPWORDS = new Set([
  'about', 'address', 'against', 'apply', 'candidate', 'could', 'from', 'into', 'mechanism',
  'method', 'problem', 'target', 'that', 'their', 'there', 'these', 'this', 'through', 'under',
  'using', 'with', 'without', 'would'
]);

function fingerprintTerms(value = '') {
  return unique(normalizeText(value).split(' ')
    .filter((term) => term.length > 3 && !FINGERPRINT_STOPWORDS.has(term)))
    .slice(0, 24);
}

function materialCollisionRecords(materialPack = {}) {
  return materialItems(materialPack).map((item) => ({
    paper_id: item.paper_id || null,
    title: item.title || null,
    status: item.status || null,
    text: normalizeText([
      item.title,
      item.match?.query,
      ...(item.materials?.chunks || []).map((chunk) => chunk.text),
      ...(item.materials?.source_spans || []).map((span) => span.text),
      ...(item.materials?.tables || []).map((table) => table.text || table.caption),
      ...(item.materials?.figures || []).map((figure) => figure.text || figure.caption),
      ...(item.graph_context || []).map((entry) => entry.node_name)
    ].filter(Boolean).join(' ')),
    source_refs: sourceRefsForItem(item)
  }));
}

function lexicalCollisionHits(records = [], terms = []) {
  if (!terms.length) return [];
  return records.map((record) => {
    const hits = terms.filter((term) => record.text.includes(term));
    return {
      record,
      hits,
      score: Number((hits.length / Math.max(1, Math.min(terms.length, 10))).toFixed(4))
    };
  }).filter((entry) => entry.hits.length >= Math.min(3, terms.length))
    .sort((left, right) => right.score - left.score || String(left.record.title || '').localeCompare(String(right.record.title || '')))
    .slice(0, 8)
    .map((entry) => ({
      paper_id: entry.record.paper_id,
      title: entry.record.title,
      status: entry.record.status,
      lexical_score: entry.score,
      matched_terms: entry.hits,
      source_refs: entry.record.source_refs
    }));
}

export function compileMechanismCollisionAudit({
  materialPack = {},
  ideaCards = [],
  structuralGapAnalysis = {},
  args = {}
} = {}) {
  const records = materialCollisionRecords(materialPack);
  const explicitMechanism = compactText(args.candidateMechanism || args.candidate_mechanism);
  const audits = ideaCards.map((card) => {
    const pattern = card.researchstudio_trace?.pattern_applications?.[0] || null;
    const intervention = explicitMechanism || compactText(card.intervention);
    const fingerprint = {
      target_failure: compactText(card.failure_signature || card.gap?.statement),
      research_action: compactText(pattern?.research_action),
      candidate_intervention: intervention,
      changed_assumption_or_component: (card.researchstudio_trace?.structural_gap_refs || [])
        .filter((entry) => entry.gap_kind === 'subtractive')
        .map((entry) => entry.structural_gap_id)
    };
    const terms = fingerprintTerms(Object.values(fingerprint).flat().join(' '));
    const queries = unique([
      [fingerprint.candidate_intervention, fingerprint.target_failure].filter(Boolean).join(' '),
      [fingerprint.research_action, fingerprint.target_failure].filter(Boolean).join(' '),
      [fingerprint.candidate_intervention, materialPack.target_domain].filter(Boolean).join(' ')
    ].map(compactText).filter(Boolean)).slice(0, 4);
    const lexicalHits = lexicalCollisionHits(records, terms);
    return {
      mechanism_audit_id: `mechanism-collision:${stableHash(card.idea_id || JSON.stringify(fingerprint), 14)}`,
      idea_id: card.idea_id || null,
      mechanism_fingerprint: fingerprint,
      fingerprint_terms: terms,
      decomposed_search_queries: queries,
      lexical_candidate_hits: lexicalHits,
      status: lexicalHits.length ? 'lexical_collision_candidates_found' : 'external_collision_search_required',
      semantic_equivalence_checked: false,
      novelty_claim_allowed: false,
      required_next_action: queries.length
        ? 'Run source-backed literature discovery with the decomposed queries, import/split-read high-signal candidates, and compare mechanism pathways before a novelty claim.'
        : 'Specify a concrete mechanism before collision search.',
      boundary: 'Lexical hits are screening candidates and lexical absence is not novelty evidence.'
    };
  });
  return {
    contractVersion: 'papernexus-mechanism-collision-audit-v1',
    audit_method: 'deterministic_structural_query_decomposition_plus_lexical_prefilter',
    overall_status: !audits.length
      ? 'no_candidate_mechanism'
      : (audits.some((audit) => audit.lexical_candidate_hits.length) ? 'lexical_candidates_found' : 'external_collision_search_required'),
    semantic_equivalence_checked: false,
    novelty_claim_allowed: false,
    candidate_audits: audits,
    historical_regression_watchlist: structuralGapAnalysis.historical_regression_watchlist || [],
    interpretation_limit: 'This audit improves mechanism-specific search planning but does not establish semantic equivalence, absence, novelty, or empirical validity.'
  };
}

export function buildProposalGraphHandoff({
  structuralGapAnalysis = {},
  innovationPatternAnalysis = {},
  mechanismCollisionAudit = {},
  ideaCards = []
} = {}) {
  return {
    target_operation: 'proposal_graph_session',
    episode_local: true,
    raw_graph_mutation: false,
    evidence_export: {
      evidence_export_version: 'papernexus-researchstudio-proposal-handoff-v1',
      structural_gap_refs: allStructuralGaps(structuralGapAnalysis).map((gap) => ({
        structural_gap_id: gap.structural_gap_id,
        gap_kind: gap.gap_kind,
        gap_type: gap.gap_type,
        source_gap_ids: gap.source_gap_ids || [],
        evidence_refs: (gap.evidence_refs || []).slice(0, 8)
      })),
      pattern_applications: (innovationPatternAnalysis.matches || []).map((match) => ({
        pattern_match_id: match.pattern_match_id,
        structural_gap_id: match.structural_gap_id,
        pattern_id: match.pattern_id,
        research_action: match.research_action,
        evidence_origin: match.evidence_origin
      })),
      historical_regression_watchlist: structuralGapAnalysis.historical_regression_watchlist || [],
      mechanism_collision_audits: (mechanismCollisionAudit.candidate_audits || []).map((audit) => ({
        mechanism_audit_id: audit.mechanism_audit_id,
        idea_id: audit.idea_id,
        status: audit.status,
        semantic_equivalence_checked: audit.semantic_equivalence_checked,
        decomposed_search_queries: audit.decomposed_search_queries
      })),
      idea_trace_refs: ideaCards.map((card) => ({
        idea_id: card.idea_id,
        structural_gap_refs: card.researchstudio_trace?.structural_gap_refs || [],
        pattern_applications: card.researchstudio_trace?.pattern_applications || [],
        falsifier: card.falsifier || null
      }))
    },
    required_action_annotations: [
      'Proposal actions should preserve structural_gap_id and pattern_match_id on candidate mechanism nodes or evidence attachments.',
      'A commit should retain at least one falsifier and one historical-regression guard when lineage evidence exists.',
      'Lexical collision absence must not be converted into a novelty claim; source-backed collision closure remains required.'
    ],
    boundary: 'This handoff prepares provenance for an episode-local proposal graph. It neither creates proposal actions nor mutates the committed corpus graph.'
  };
}
