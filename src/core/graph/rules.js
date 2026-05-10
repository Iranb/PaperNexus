import { normalizeText } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES, getNodeLayer } from './schema.js';

export const ALLOWED_NODE_TYPES = new Set(Object.values(NODE_TYPES));
export const ALLOWED_RELATION_TYPES = new Set(Object.values(EDGE_TYPES));

export const RELATION_COMPATIBILITY_RULES = [
  { type: EDGE_TYPES.CONTAINS, sources: [NODE_TYPES.CORPUS], targets: Object.values(NODE_TYPES).filter((type) => type !== NODE_TYPES.CORPUS) },
  { type: EDGE_TYPES.CONTAINS, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.EVIDENCE] },
  { type: EDGE_TYPES.SOLVES, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.PROBLEM] },
  { type: EDGE_TYPES.USES, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.EVALUATES_ON, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.DATASET] },
  { type: EDGE_TYPES.BENCHMARKED_ON, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.BENCHMARK] },
  { type: EDGE_TYPES.BENCHMARKED_ON, sources: [NODE_TYPES.CLAIM, NODE_TYPES.FINDING, NODE_TYPES.EVIDENCE], targets: [NODE_TYPES.BENCHMARK] },
  { type: EDGE_TYPES.REPORTS, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.METRIC] },
  { type: EDGE_TYPES.REPORTS_FINDING, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.FINDING] },
  { type: EDGE_TYPES.CLAIMS, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.CLAIM] },
  { type: EDGE_TYPES.HAS_LIMITATION, sources: [NODE_TYPES.PAPER, NODE_TYPES.PROBLEM], targets: [NODE_TYPES.LIMITATION] },
  { type: EDGE_TYPES.ASSUMES, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.ASSUMPTION] },
  { type: EDGE_TYPES.SUGGESTS_FUTURE, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.FUTURE_DIRECTION] },
  { type: EDGE_TYPES.SUPPORTED_BY, sources: [NODE_TYPES.CLAIM], targets: [NODE_TYPES.EVIDENCE, NODE_TYPES.FINDING] },
  { type: EDGE_TYPES.FALSIFIED_BY, sources: [NODE_TYPES.FINDING, NODE_TYPES.CLAIM], targets: [NODE_TYPES.CLAIM, NODE_TYPES.FINDING] },
  { type: EDGE_TYPES.OBSERVED_ON, sources: [NODE_TYPES.CLAIM, NODE_TYPES.FINDING, NODE_TYPES.EVIDENCE], targets: [NODE_TYPES.DATASET] },
  { type: EDGE_TYPES.MEASURED_BY, sources: [NODE_TYPES.CLAIM, NODE_TYPES.FINDING, NODE_TYPES.EVIDENCE], targets: [NODE_TYPES.METRIC] },
  { type: EDGE_TYPES.APPLIES_TO, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.PROBLEM] },
  {
    type: EDGE_TYPES.TRANSFERABLE_TO,
    sources: [
      NODE_TYPES.PROBLEM,
      NODE_TYPES.RESEARCH_QUESTION,
      NODE_TYPES.CHALLENGE,
      NODE_TYPES.METHOD,
      NODE_TYPES.TAKEAWAY,
      NODE_TYPES.IDEA_FRAGMENT,
      NODE_TYPES.LIMITATION,
      NODE_TYPES.ASSUMPTION
    ],
    targets: [
      NODE_TYPES.PROBLEM,
      NODE_TYPES.RESEARCH_QUESTION,
      NODE_TYPES.CHALLENGE,
      NODE_TYPES.METHOD,
      NODE_TYPES.TAKEAWAY,
      NODE_TYPES.IDEA_FRAGMENT,
      NODE_TYPES.LIMITATION,
      NODE_TYPES.ASSUMPTION
    ]
  },
  { type: EDGE_TYPES.REQUIRES, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.ASSUMPTION] },
  { type: EDGE_TYPES.DEPENDS_ON, sources: [NODE_TYPES.METHOD, NODE_TYPES.CLAIM, NODE_TYPES.FINDING], targets: [NODE_TYPES.ASSUMPTION, NODE_TYPES.DATASET, NODE_TYPES.BENCHMARK, NODE_TYPES.METRIC] },
  { type: EDGE_TYPES.FAILS_UNDER, sources: [NODE_TYPES.METHOD, NODE_TYPES.CLAIM, NODE_TYPES.FINDING], targets: [NODE_TYPES.ASSUMPTION, NODE_TYPES.DATASET, NODE_TYPES.BENCHMARK] },
  { type: EDGE_TYPES.HAS_GAP, sources: [NODE_TYPES.PROBLEM], targets: [NODE_TYPES.LIMITATION] },
  { type: EDGE_TYPES.RELATED_TO, sources: [NODE_TYPES.PROBLEM, NODE_TYPES.FUTURE_DIRECTION, NODE_TYPES.LIMITATION, NODE_TYPES.RESEARCH_GOAL], targets: [NODE_TYPES.PROBLEM, NODE_TYPES.FUTURE_DIRECTION, NODE_TYPES.LIMITATION, NODE_TYPES.RESEARCH_GOAL] },
  { type: EDGE_TYPES.SIMILAR_TO, sources: [NODE_TYPES.METHOD, NODE_TYPES.PROBLEM, NODE_TYPES.BENCHMARK], targets: [NODE_TYPES.METHOD, NODE_TYPES.PROBLEM, NODE_TYPES.BENCHMARK] },
  { type: EDGE_TYPES.COMPATIBLE_WITH, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.COMBINES_WITH, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.EXTENDS_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.IMPROVES_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.REPLACES_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.ADAPTS_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.USES_COMPONENT_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.COMPARES_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.BACKGROUND_METHOD, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.VARIANT_OF, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.SPECIALIZES, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.COMPONENT_OF, sources: [NODE_TYPES.METHOD], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.MAY_BE_ADDRESSED_BY, sources: [NODE_TYPES.LIMITATION], targets: [NODE_TYPES.METHOD] },
  { type: EDGE_TYPES.CONTRADICTS, sources: [NODE_TYPES.CLAIM], targets: [NODE_TYPES.CLAIM] },
  { type: EDGE_TYPES.CITES, sources: [NODE_TYPES.PAPER], targets: [NODE_TYPES.PAPER] },
  { type: EDGE_TYPES.LEADS_TO, sources: [NODE_TYPES.METHOD, NODE_TYPES.FINDING, NODE_TYPES.CLAIM], targets: [NODE_TYPES.RESEARCH_GOAL, NODE_TYPES.PROBLEM] },
  { type: EDGE_TYPES.BLOCKED_BY, sources: [NODE_TYPES.RESEARCH_GOAL, NODE_TYPES.PROBLEM, NODE_TYPES.METHOD], targets: [NODE_TYPES.LIMITATION, NODE_TYPES.ASSUMPTION, NODE_TYPES.PROBLEM] }
];

export function normalizeNodeTypeName(value) {
  const compact = String(value || '').replace(/[_\s-]+/g, '').toLowerCase();
  return Object.values(NODE_TYPES).find((type) => type.toLowerCase() === compact) || null;
}

export function normalizeRelationTypeName(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ALLOWED_RELATION_TYPES.has(normalized) ? normalized : null;
}

export function isValidNodeType(type) {
  return ALLOWED_NODE_TYPES.has(type);
}

export function isValidRelationType(type) {
  return ALLOWED_RELATION_TYPES.has(type);
}

export function getCompatibleRule(sourceType, targetType, relationType) {
  return RELATION_COMPATIBILITY_RULES.find((rule) => {
    return rule.type === relationType
      && rule.sources.includes(sourceType)
      && rule.targets.includes(targetType);
  }) || null;
}

export function resolveCompatibleRelationType(sourceType, targetType, proposedType) {
  if (getCompatibleRule(sourceType, targetType, proposedType)) {
    return proposedType;
  }

  if (sourceType === NODE_TYPES.METHOD && targetType === NODE_TYPES.PROBLEM && proposedType === EDGE_TYPES.HAS_GAP) {
    return EDGE_TYPES.APPLIES_TO;
  }

  if (sourceType === NODE_TYPES.METHOD && targetType === NODE_TYPES.METHOD && proposedType === EDGE_TYPES.RELATED_TO) {
    return EDGE_TYPES.COMBINES_WITH;
  }

  return null;
}

export function ensureNodeProperties(type, name, properties = {}) {
  return {
    ...properties,
    layer: properties.layer || getNodeLayer(type),
    normalized: properties.normalized || normalizeText(name)
  };
}

export function buildLayerPathProperties(sourceNode, targetNode, properties = {}) {
  const sourceLayer = sourceNode?.properties?.layer || getNodeLayer(sourceNode?.type);
  const targetLayer = targetNode?.properties?.layer || getNodeLayer(targetNode?.type);
  return {
    ...properties,
    sourceLayer,
    targetLayer,
    layerScope: sourceLayer === targetLayer ? 'intra-layer' : 'cross-layer',
    layerPath: `${sourceLayer}->${targetLayer}`
  };
}

export function describeCompatibility(sourceType, relationType, targetType) {
  const relation = relationType || 'unknown';
  return `${sourceType || 'Unknown'} -[${relation}]-> ${targetType || 'Unknown'}`;
}
