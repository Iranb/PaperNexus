import { normalizeText, tokenizeWithoutStopwords, stableHash, unique } from '../../lib/utils.js';

const TERMS_TO_IGNORE = new Set(['method', 'methods', 'approach', 'paper', 'study', 'research', 'problem', 'target', 'evidence']);

export function adaptationTerms(text) {
  return unique(tokenizeWithoutStopwords(String(text || '')))
    .filter((term) => !TERMS_TO_IGNORE.has(term)).sort();
}

export function compareTransferConditions(requirements = {}, constraints = {}) {
  const conflicts = [];
  const unknown = [];
  const checked = [];
  if (typeof constraints !== 'object' || Array.isArray(constraints) || constraints === null) {
    return { conflicts, checked, unknown: constraints ? ['Free-text constraints require source review: ' + String(constraints)] : [] };
  }
  for (const [key, target] of Object.entries(constraints)) {
    const source = requirements?.[key];
    if (source === undefined || source === null) {
      unknown.push('Missing method condition: ' + key);
      continue;
    }
    const isLimit = /^(max|min)[A-Z_]/.test(key) && typeof source === 'number' && typeof target === 'number';
    const compatible = isLimit ? (key.startsWith('max') ? source <= target : source >= target)
      : ['string', 'number', 'boolean'].includes(typeof source) && source === target;
    (compatible ? checked : conflicts).push({ key, method: source, target });
  }
  return { conflicts, checked, unknown };
}

// Profiles contain only source observations. The returned interventions are hypotheses.
export function rankMethodAdaptations(problem = {}, profiles = [], options = {}) {
  const terms = adaptationTerms([problem.statement, ...(problem.affectedTasks || [])].join(' '));
  const candidates = [];
  const excluded = [];
  for (const profile of profiles) {
    const sourceTerms = adaptationTerms([profile.name, ...(profile.problems || []),
      ...(profile.mechanisms || [])].join(' '));
    const matchedTerms = terms.filter((term) => sourceTerms.includes(term));
    const sharedMechanisms = (problem.mechanisms || []).filter((mechanism) =>
      (profile.mechanisms || []).some((source) => normalizeText(source) === normalizeText(mechanism)));
    if ((!matchedTerms.length && !sharedMechanisms.length) || !(profile.mechanisms || []).length) continue;
    const conditions = compareTransferConditions(profile.requirements, options.constraints);
    const missing = [...conditions.unknown];
    if (!(profile.evidence || []).some((ref) => ref.quote || ref.source_id || ref.source_key || ref.nodeId)) {
      missing.push('Missing source evidence for mechanism');
    }
    if (!(profile.assumptions || []).length && !Object.keys(profile.requirements || {}).length) {
      missing.push('Method assumptions have not been extracted');
    }
    if (!(profile.problems || []).length) missing.push('Source task applicability has not been extracted');
    const candidate = {
      id: 'adapt:' + stableHash(String(problem.id || problem.statement) + ':' + profile.id, 14),
      methodId: profile.id, methodName: profile.name, sourceDomain: profile.domain || null,
      targetDomain: options.targetDomain || null,
      status: conditions.conflicts.length ? 'incompatible' : (missing.length ? 'needs_evidence' : 'hypothesis'),
      score: Number((matchedTerms.length / Math.max(terms.length, 1) + sharedMechanisms.length).toFixed(4)),
      matchBasis: { kind: sharedMechanisms.length ? 'shared_mechanism' : 'lexical_mechanism_and_task_overlap', matchedTerms, sharedMechanisms },
      mechanisms: profile.mechanisms, assumptions: profile.assumptions || [],
      conditions, missingEvidence: missing, evidence: profile.evidence || [],
      proposedChanges: [
        'Map the source inputs and outputs of ' + profile.mechanisms.join(', ') + ' to the target task: ' + (problem.statement || ''),
        'Verify each source assumption and adapt only conditions supported by target data.',
        'Hold the baseline, data split, evaluator and budget fixed; ablate the transferred mechanism.'
      ],
      falsifier: 'Reject the transfer if the target failure persists, required conditions fail, or gains disappear with a matched ablation.',
      boundary: 'A source-grounded design hypothesis; transfer efficacy and novelty are unverified.'
    };
    (conditions.conflicts.length ? excluded : candidates).push(candidate);
  }
  const sort = (a, b) => b.score - a.score || a.methodId.localeCompare(b.methodId);
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5));
  return { status: candidates.length ? 'candidates' : 'needs_evidence',
    candidates: candidates.sort(sort).slice(0, limit), excluded: excluded.sort(sort).slice(0, limit),
    missingEvidence: candidates.length ? [] : ['No compatible mechanism with task overlap in the supplied evidence.'] };
}

export function classifyGapObservation({ type, statement, evidence = [], truncated = false } = {}) {
  if (truncated) return { category: 'traversal_gap', status: 'bounded_observation',
    verification: 'Expand the traversal budget before inferring absence.' };
  if (type === 'Claim' || type === 'Finding' || type === 'claim_evidence_mismatch') {
    return { category: 'evidence_gap', status: 'needs_verification',
      verification: 'Check the claim against its experiment and protocol; a claim alone is not an evidence mismatch.' };
  }
  if (['Limitation', 'Assumption', 'Challenge', 'FutureDirection', 'limitation', 'assumption_risk'].includes(type)
      && evidence.length) {
    return { category: 'research_opportunity', status: 'source_reported_candidate',
      verification: 'Verify the source limitation, later work and target conditions before calling it unresolved.' };
  }
  return { category: statement ? 'extraction_gap' : 'corpus_gap', status: 'needs_evidence',
    verification: 'Retrieve source passages and expand literature coverage; missing extracted data does not prove a research gap.' };
}
