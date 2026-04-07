import {
  brainstormBriefPayload,
  evidenceChainPayload,
  paperEnhancementPayload,
  pathTraceGraphPayload,
  reflectionChainPayload,
  researchBriefPayload,
  storylineBriefPayload,
  theoryBriefPayload
} from '../server/api.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function asOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function buildQueryBody(args = {}) {
  return {
    name: args.corpus,
    query: args.query,
    options: asOptions(args.options)
  };
}

export async function executeResearchBriefingTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation);
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;

  switch (operation) {
    case 'path_trace':
      return pathTraceGraphPayload(candidate, {
        name: candidate,
        from: args.from || args.fromQuery,
        to: args.to || args.toQuery,
        options: asOptions(args.options)
      }, options);
    case 'evidence_chain':
      return evidenceChainPayload(candidate, buildQueryBody(args), options);
    case 'reflection_chain':
      return reflectionChainPayload(candidate, buildQueryBody(args), options);
    case 'theory_brief':
      return theoryBriefPayload(candidate, buildQueryBody(args), options);
    case 'storyline_brief':
      return storylineBriefPayload(candidate, buildQueryBody(args), options);
    case 'research_brief':
      return researchBriefPayload(candidate, buildQueryBody(args), options);
    case 'brainstorm_brief':
      return brainstormBriefPayload(candidate, buildQueryBody(args), options);
    case 'paper_enhancement':
      return paperEnhancementPayload(candidate, args.paperId || args.paper_id, options);
    default:
      throw new Error(`Unknown research_briefing operation: ${args.operation || '<missing>'}`);
  }
}
