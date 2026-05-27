import {
  collectSourceSpans,
  collectSupportingPapers,
  normalizeTimeCutoff,
  resolveLimit,
  stableHash
} from './innovation-artifact-utils.js';

export function buildMustCiteSet(payload = {}, options = {}) {
  const limit = resolveLimit(options.mustCiteK ?? options.must_cite_k ?? payload.mustCiteK ?? payload.must_cite_k, 8, 50);
  const cutoffYear = normalizeTimeCutoff(options.timeCutoff || options.time_cutoff || payload.timeCutoff || payload.time_cutoff);
  const sourceSpans = collectSourceSpans(payload);
  const papers = collectSupportingPapers(payload, sourceSpans);
  return papers.slice(0, limit).map((paper, index) => {
    const matchingSpans = sourceSpans.filter((span) => (
      (paper.paper_key && span.paper_key === paper.paper_key)
      || (paper.title && span.paper_title === paper.title)
    ));
    const futureLeakage = cutoffYear && paper.year && paper.year > cutoffYear;
    return {
      citation_id: `mustcite:${stableHash(`${paper.paper_key || paper.title}:${index}`, 12)}`,
      paper_key: paper.paper_key || null,
      title: paper.title || paper.paper_key || `Supporting paper ${index + 1}`,
      source_domain: paper.source_domain,
      obligation_type: index === 0 ? 'baseline_or_method_anchor' : 'supporting_prior',
      reason: paper.source_domain
        ? `${paper.title || paper.paper_key} anchors the ${paper.source_domain} evidence used by the idea.`
        : `${paper.title || paper.paper_key} is cited by the supporting evidence chain.`,
      evidence_span_ids: matchingSpans.map((span) => span.span_id).filter(Boolean),
      coverage_status: matchingSpans.length ? 'covered' : 'metadata_only',
      temporal_status: futureLeakage ? 'future_leakage' : 'valid',
      confidence: matchingSpans.length ? 0.8 : 0.45
    };
  });
}
