import { stableHash, unique } from '../../lib/utils.js';

export { stableHash, unique };

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export function average(values = [], fallback = 0) {
  const clean = values.map(Number).filter((value) => Number.isFinite(value));
  if (!clean.length) return fallback;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function uniqueBy(values = [], keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

export function resolveLimit(value, fallback, max = 50) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.min(max, numeric));
}

export function normalizeTimeCutoff(value = '') {
  const text = compactText(value);
  if (!text) return null;
  const match = text.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

export function extractYear(value = '') {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function sourceSpanKey(span = {}, index = 0) {
  return compactText(
    span.span_id
    || span.spanId
    || span.snippet_id
    || span.snippetId
    || span.id
    || `span:${stableHash(`${span.paper_key || span.paperKey || span.paper_title || span.paperTitle || ''}:${span.text || span.evidence_text || span.evidenceText || ''}:${index}`, 12)}`
  );
}

export function normalizeSourceSpan(span = {}, index = 0, fallback = {}) {
  const spanId = sourceSpanKey({ ...fallback, ...span }, index);
  const paperKey = compactText(span.paper_key || span.paperKey || span.paper_id || span.paperId || fallback.paper_key || fallback.paperKey);
  const paperTitle = compactText(span.paper_title || span.paperTitle || span.title || fallback.paper_title || fallback.paperTitle);
  const text = compactText(span.text || span.evidence_text || span.evidenceText || span.snippet || fallback.text || fallback.evidence_text);
  return {
    span_id: spanId,
    paper_key: paperKey,
    paper_title: paperTitle,
    source_domain: compactText(span.source_domain || span.sourceDomain || fallback.source_domain || fallback.sourceDomain),
    section: compactText(span.section || span.section_heading || span.sectionHeading || fallback.section),
    text,
    confidence: normalizeScore(span.confidence ?? fallback.confidence, 0)
  };
}

function collectSpansFromAnalyses(sourceDomainAnalyses = []) {
  return asArray(sourceDomainAnalyses).flatMap((analysis) => {
    const sourceDomain = analysis.source_domain || analysis.sourceDomain;
    const directSpans = asArray(analysis.source_spans || analysis.sourceSpans)
      .map((span, index) => normalizeSourceSpan(span, index, { source_domain: sourceDomain }));
    const paperSpans = asArray(analysis.supporting_papers || analysis.supportingPapers)
      .flatMap((paper) => asArray(paper.snippets || paper.source_spans || paper.sourceSpans)
        .map((snippet, index) => normalizeSourceSpan(snippet, index, {
          source_domain: sourceDomain,
          paper_key: paper.paper_key || paper.paperKey,
          paper_title: paper.title || paper.paper_title || paper.paperTitle,
          section: snippet.section || snippet.section_heading || snippet.sectionHeading,
          text: snippet.text || snippet.evidence_text || snippet.evidenceText
        })));
    return [...directSpans, ...paperSpans];
  });
}

export function collectSourceSpans(payload = {}) {
  return uniqueBy([
    ...asArray(payload.source_spans || payload.sourceSpans).map(normalizeSourceSpan),
    ...collectSpansFromAnalyses(payload.source_domain_analyses || payload.sourceDomainAnalyses),
    ...asArray(payload.idea_fragments || payload.ideaFragments).flatMap((fragment) => (
      asArray(fragment.source_spans || fragment.sourceSpans)
        .map((span, index) => normalizeSourceSpan(span, index, { source_domain: fragment.source_domain || fragment.sourceDomain }))
    ))
  ].filter((span) => span.span_id || span.paper_key || span.paper_title || span.text), (span) => span.span_id || `${span.paper_key}:${span.text}`);
}

export function collectSupportingPapers(payload = {}, sourceSpans = []) {
  const fromAnalyses = asArray(payload.source_domain_analyses || payload.sourceDomainAnalyses).flatMap((analysis) => (
    asArray(analysis.supporting_papers || analysis.supportingPapers).map((paper) => (
      typeof paper === 'string'
        ? { title: paper, source_domain: analysis.source_domain || analysis.sourceDomain }
        : {
            paper_key: paper.paper_key || paper.paperKey || paper.paper_id || paper.paperId,
            title: paper.title || paper.paper_title || paper.paperTitle,
            source_domain: paper.source_domain || paper.sourceDomain || analysis.source_domain || analysis.sourceDomain,
            year: paper.year || paper.publication_year || paper.publicationYear
          }
    ))
  ));
  const fromFragments = asArray(payload.idea_fragments || payload.ideaFragments).flatMap((fragment) => [
    ...asArray(fragment.supporting_papers || fragment.supportingPapers).map((paper) => (
      typeof paper === 'string'
        ? { title: paper, source_domain: fragment.source_domain || fragment.sourceDomain }
        : {
            paper_key: paper.paper_key || paper.paperKey || paper.paper_id || paper.paperId,
            title: paper.title || paper.paper_title || paper.paperTitle,
            source_domain: paper.source_domain || paper.sourceDomain || fragment.source_domain || fragment.sourceDomain,
            year: paper.year || paper.publication_year || paper.publicationYear
          }
    )),
    ...asArray(fragment.supporting_paper_keys || fragment.supportingPaperKeys).map((paperKey) => ({
      paper_key: paperKey,
      title: '',
      source_domain: fragment.source_domain || fragment.sourceDomain
    }))
  ]);
  const fromSpans = sourceSpans.map((span) => ({
    paper_key: span.paper_key,
    title: span.paper_title,
    source_domain: span.source_domain
  }));

  return uniqueBy([...fromAnalyses, ...fromFragments, ...fromSpans]
    .map((paper) => ({
      paper_key: compactText(paper.paper_key || paper.paperKey),
      title: compactText(paper.title || paper.paper_title || paper.paperTitle),
      source_domain: compactText(paper.source_domain || paper.sourceDomain),
      year: extractYear(paper.year || paper.publication_year || paper.publicationYear || paper.title)
    }))
    .filter((paper) => paper.paper_key || paper.title), (paper) => paper.paper_key || paper.title);
}

export function evidenceTierScore(value = '') {
  const tier = compactText(value).toLowerCase();
  if (tier === 'strong') return 0.9;
  if (tier === 'moderate') return 0.7;
  if (tier === 'weak') return 0.35;
  return 0.45;
}

export function fragmentText(fragment = {}) {
  return compactText([
    fragment.title,
    fragment.core_insight,
    fragment.integration_rationale,
    fragment.integration_mechanism,
    fragment.challenge_resolution,
    fragment.concrete_realization
  ].filter(Boolean).join(' '));
}

export function spanIdsForFragment(fragment = {}, sourceSpans = []) {
  const direct = asArray(fragment.source_spans || fragment.sourceSpans)
    .map((span, index) => normalizeSourceSpan(span, index, { source_domain: fragment.source_domain || fragment.sourceDomain }).span_id)
    .filter(Boolean);
  if (direct.length) return unique(direct);
  const keys = new Set(asArray(fragment.supporting_paper_keys || fragment.supportingPaperKeys).map(compactText).filter(Boolean));
  if (!keys.size) {
    const sourceDomain = compactText(fragment.source_domain || fragment.sourceDomain);
    return sourceSpans
      .filter((span) => !sourceDomain || span.source_domain === sourceDomain)
      .slice(0, 3)
      .map((span) => span.span_id)
      .filter(Boolean);
  }
  return sourceSpans
    .filter((span) => keys.has(span.paper_key) || keys.has(span.paper_title))
    .map((span) => span.span_id)
    .filter(Boolean);
}
