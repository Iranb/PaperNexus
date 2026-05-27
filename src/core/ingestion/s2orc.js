import { readText, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';

export const S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-s2orc-citation-contexts-v1';
export const PAPERNEXUS_CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-citation-contexts-v1';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function uniqueBy(values = [], keyFn = (value) => value) {
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

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseYear(value = '') {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function inferSectionRole(value = '') {
  const role = compactText(value, 120).toLowerCase();
  if (!role) return 'body';
  if (/abstract/.test(role)) return 'abstract';
  if (/intro/.test(role)) return 'introduction';
  if (/related|background/.test(role)) return 'background';
  if (/method|approach|model|architecture/.test(role)) return 'method';
  if (/experiment|evaluation|result/.test(role)) return 'evaluation';
  if (/analysis|discussion/.test(role)) return 'discussion';
  if (/conclusion/.test(role)) return 'conclusion';
  return role.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'body';
}

function normalizeIdentifierKey(key = '') {
  const normalized = String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalized === 'doi') return 'doi';
  if (normalized === 'arxiv' || normalized === 'arxivid') return 'arxivId';
  if (normalized === 'pmid') return 'pmid';
  if (normalized === 'pmcid') return 'pmcid';
  if (normalized === 'magid') return 'magId';
  if (normalized === 'acl') return 'aclId';
  if (normalized === 'corpusid' || normalized === 's2corpusid') return 'corpusId';
  return normalized;
}

function normalizeIdentifiers(input = {}) {
  const identifiers = {};
  for (const [key, value] of Object.entries(asObject(input))) {
    const normalizedKey = normalizeIdentifierKey(key);
    const normalizedValue = compactText(value, 240);
    if (!normalizedKey || !normalizedValue) continue;
    identifiers[normalizedKey] = normalizedKey === 'doi'
      ? normalizedValue.replace(/^https?:\/\/doi\.org\//i, '')
      : normalizedValue;
  }
  return identifiers;
}

function authorName(author = {}) {
  if (typeof author === 'string') return compactText(author, 180);
  const parts = [
    author.first,
    ...asArray(author.middle),
    author.last,
    author.suffix
  ].map((part) => compactText(part, 80)).filter(Boolean);
  return parts.join(' ');
}

function authorLastName(author = {}) {
  if (typeof author === 'string') {
    const parts = compactText(author, 180).split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || '';
  }
  return compactText(author.last || author.surname || author.family, 120);
}

function normalizeReference(entry = {}, key = '') {
  const record = asObject(entry);
  const id = compactText(record.ref_id || record.refId || record.id || key, 180);
  const ids = normalizeIdentifiers(record.ids || record.identifiers);
  if (record.doi && !ids.doi) ids.doi = compactText(record.doi, 240).replace(/^https?:\/\/doi\.org\//i, '');
  if (record.arxivId && !ids.arxivId) ids.arxivId = compactText(record.arxivId, 240).replace(/^arxiv:/i, '');
  const authors = asArray(record.authors).map(authorName).filter(Boolean);
  const leadAuthorLastName = authorLastName(asArray(record.authors)[0] || {});
  const raw = compactText(record.raw_text || record.rawText || record.raw || '', 1200);
  const title = compactText(record.title || record.paper_title || record.paperTitle, 360);
  return {
    id,
    rawId: compactText(key || record.ref_id || record.refId || '', 180),
    title,
    titleGuess: title,
    year: finiteNumber(record.year) || parseYear(raw),
    venue: compactText(record.venue || record.journal || record.booktitle || '', 240),
    leadAuthorLastName,
    authors: unique(authors),
    raw,
    identifiers: ids
  };
}

function normalizeReferenceEntries(bibEntries = {}) {
  if (Array.isArray(bibEntries)) {
    return bibEntries.map((entry, index) => normalizeReference(entry, entry?.ref_id || entry?.refId || `BIBREF${index}`))
      .filter((entry) => entry.id || entry.raw || entry.title);
  }
  return Object.entries(asObject(bibEntries)).map(([key, entry]) => normalizeReference(entry, key))
    .filter((entry) => entry.id || entry.raw || entry.title);
}

function normalizeCitationSpans(block = {}) {
  return [
    ...asArray(block.cite_spans),
    ...asArray(block.citeSpans),
    ...asArray(block.citation_spans),
    ...asArray(block.citationSpans)
  ].map((span) => asObject(span)).filter((span) => (
    span.ref_id || span.refId || span.text || Number.isFinite(Number(span.start))
  ));
}

function sentenceWindow(text = '', span = {}) {
  const source = String(text || '');
  if (!source.trim()) return '';
  const start = finiteNumber(span.start);
  const end = finiteNumber(span.end);
  if (start === null || end === null || start < 0 || end < start || start >= source.length) {
    return compactText(source, 720);
  }
  const boundedEnd = Math.min(end, source.length);
  const before = source.slice(0, start);
  const after = source.slice(boundedEnd);
  const previousBreak = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  const nextCandidates = ['.', '!', '?', '\n']
    .map((marker) => {
      const index = after.indexOf(marker);
      return index >= 0 ? boundedEnd + index + 1 : null;
    })
    .filter((index) => index !== null);
  const windowStart = previousBreak >= 0 ? previousBreak + 1 : 0;
  const windowEnd = nextCandidates.length ? Math.min(...nextCandidates) : source.length;
  return compactText(source.slice(windowStart, windowEnd), 720);
}

function normalizeBlocks(paper = {}) {
  const abstractBlocks = typeof paper.abstract === 'string'
    ? [{ text: paper.abstract, section: 'Abstract' }]
    : asArray(paper.abstract);
  return [
    ...abstractBlocks.map((block, index) => ({ ...asObject(block), section: block?.section || 'Abstract', blockKind: 'abstract', blockIndex: index })),
    ...asArray(paper.body_text || paper.bodyText).map((block, index) => ({ ...asObject(block), blockKind: 'body_text', blockIndex: index }))
  ].filter((block) => compactText(block.text));
}

function normalizeInputRecords(input, diagnostics) {
  if (typeof input !== 'string') {
    if (Array.isArray(input)) return input;
    const object = asObject(input);
    return asArray(object.papers || object.records || object.items || object.data || input);
  }

  const raw = String(input || '').trim();
  if (!raw) return [];
  try {
    return normalizeInputRecords(JSON.parse(raw), diagnostics);
  } catch (jsonError) {
    const records = [];
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (let index = 0; index < lines.length; index += 1) {
      try {
        records.push(JSON.parse(lines[index]));
      } catch (lineError) {
        diagnostics.skippedRecordCount += 1;
        diagnostics.errors.push({
          stage: 's2orc-jsonl-parse',
          line: index + 1,
          message: lineError instanceof Error ? lineError.message : String(lineError)
        });
      }
    }
    if (!records.length && !diagnostics.errors.length) {
      diagnostics.errors.push({
        stage: 's2orc-json-parse',
        message: jsonError instanceof Error ? jsonError.message : String(jsonError)
      });
    }
    return records;
  }
}

function paperIdFor(paper = {}, metadata = {}, index = 0, total = 1) {
  const singlePaperOverride = total === 1 ? compactText(metadata.paperId || metadata.paper_id, 240) : '';
  return compactText(
    paper.paper_id
    || paper.paperId
    || paper.s2orc_id
    || paper.s2orcId
    || paper.corpus_id
    || paper.corpusId
    || paper.corpusid
    || singlePaperOverride
    || `s2orc:${stableHash(JSON.stringify({ title: paper.title, index }), 16)}`,
    240
  );
}

function paperTitleFor(paper = {}, metadata = {}, total = 1) {
  const metadataTitle = total === 1 ? compactText(metadata.paperTitle || metadata.paper_title || metadata.title, 360) : '';
  return compactText(paper.title || paper.metadata?.title || metadataTitle, 360);
}

function buildContext({ paper, paperId, paperTitle, reference, span, block, blockIndex, metadata }) {
  const referenceId = compactText(span.ref_id || span.refId || span.reference_id || span.referenceId, 180);
  const citationRaw = compactText(span.text || span.citation || span.raw || '', 180);
  const quote = sentenceWindow(block.text, span);
  const sectionHeading = compactText(block.section || block.sectionHeading || block.section_heading || '', 240);
  const sectionRole = inferSectionRole(sectionHeading || block.blockKind);
  const sectionId = compactText(
    block.section_id
    || block.sectionId
    || block.sec_num
    || block.secNum
    || `${paperId}:section:${stableHash(`${sectionHeading}:${sectionRole}`, 10)}`,
    240
  );
  const idSeed = JSON.stringify({
    paperId,
    blockIndex,
    referenceId,
    citationRaw,
    start: span.start,
    end: span.end,
    quote
  });
  return {
    contractVersion: PAPERNEXUS_CITATION_CONTEXTS_CONTRACT_VERSION,
    adapterContractVersion: S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION,
    id: `citation-context:${stableHash(idSeed)}`,
    paperId: paperId || null,
    paperTitle,
    sourceKey: metadata.sourceKey || metadata.source_key || paper.source_key || paper.sourceKey || null,
    sourcePath: metadata.sourcePath || metadata.source_path || '',
    sourceProvider: 's2orc',
    sourceCorpusId: compactText(paper.corpusid || paper.corpusId || paper.corpus_id || '', 120),
    sectionId,
    sectionHeading,
    sectionRole,
    chunkId: compactText(block.id || block.chunk_id || block.chunkId || `${block.blockKind || 'block'}:${blockIndex}`, 180),
    citationRaw,
    citationStyle: 's2orc-cite-span',
    citationSpanStart: finiteNumber(span.start),
    citationSpanEnd: finiteNumber(span.end),
    referenceId: referenceId || null,
    referenceRaw: reference?.raw || '',
    referenceTitleGuess: reference?.titleGuess || reference?.title || '',
    referenceYear: reference?.year || null,
    referenceLeadAuthorLastName: reference?.leadAuthorLastName || '',
    referenceIdentifiers: reference?.identifiers || {},
    exactQuote: quote,
    citationContext: quote,
    extractionStatus: reference ? 'reference-resolved' : (referenceId ? 'reference-missing' : 'reference-unresolved')
  };
}

export function parseS2orcCitationContexts(input, metadata = {}) {
  const diagnostics = {
    contractVersion: S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION,
    errors: [],
    warnings: [],
    paperCount: 0,
    referenceCount: 0,
    paragraphCount: 0,
    mentionCount: 0,
    contextCount: 0,
    unresolvedReferenceCount: 0,
    skippedRecordCount: 0
  };
  const records = normalizeInputRecords(input, diagnostics).map(asObject).filter((record) => Object.keys(record).length);
  const maxPapers = finiteNumber(metadata.maxPapers || metadata.max_papers);
  const selectedRecords = maxPapers !== null ? records.slice(0, Math.max(0, maxPapers)) : records;
  const papers = [];
  const references = [];
  const contexts = [];

  for (let index = 0; index < selectedRecords.length; index += 1) {
    const paper = selectedRecords[index];
    const paperId = paperIdFor(paper, metadata, index, selectedRecords.length);
    const paperTitle = paperTitleFor(paper, metadata, selectedRecords.length);
    const paperReferences = normalizeReferenceEntries(paper.bib_entries || paper.bibEntries || paper.references);
    const referencesById = new Map(paperReferences.flatMap((reference) => [
      [reference.id, reference],
      [reference.rawId, reference]
    ].filter(([key]) => key)));
    const blocks = normalizeBlocks(paper);

    papers.push({
      paperId: paperId || null,
      paperTitle,
      sourceKey: metadata.sourceKey || metadata.source_key || paper.source_key || paper.sourceKey || null,
      sourcePath: metadata.sourcePath || metadata.source_path || '',
      referenceCount: paperReferences.length,
      paragraphCount: blocks.length
    });
    references.push(...paperReferences.map((reference) => ({ ...reference, paperId: paperId || null })));
    diagnostics.paragraphCount += blocks.length;
    diagnostics.referenceCount += paperReferences.length;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];
      const spans = normalizeCitationSpans(block);
      diagnostics.mentionCount += spans.length;
      for (const span of spans) {
        const referenceId = compactText(span.ref_id || span.refId || span.reference_id || span.referenceId, 180);
        const reference = referenceId ? referencesById.get(referenceId) : null;
        contexts.push(buildContext({
          paper,
          paperId,
          paperTitle,
          reference,
          span,
          block,
          blockIndex,
          metadata
        }));
      }
    }
  }

  const dedupedContexts = uniqueBy(contexts, (entry) => entry.id);
  diagnostics.paperCount = selectedRecords.length;
  diagnostics.contextCount = dedupedContexts.length;
  diagnostics.unresolvedReferenceCount = dedupedContexts.filter((entry) => entry.extractionStatus !== 'reference-resolved').length;
  if (!selectedRecords.length) diagnostics.warnings.push({ code: 'no_s2orc_records', message: 'No S2ORC records were found.' });
  if (!references.length) diagnostics.warnings.push({ code: 'no_bib_entries', message: 'No S2ORC bib_entries were found.' });
  if (!dedupedContexts.length) diagnostics.warnings.push({ code: 'no_cite_spans', message: 'No S2ORC cite_spans were found.' });

  return {
    contractVersion: S2ORC_CITATION_CONTEXTS_CONTRACT_VERSION,
    citationContextContractVersion: PAPERNEXUS_CITATION_CONTEXTS_CONTRACT_VERSION,
    source: {
      sourceProvider: 's2orc',
      sourceKey: metadata.sourceKey || metadata.source_key || null,
      sourcePath: metadata.sourcePath || metadata.source_path || '',
      format: metadata.format || metadata.sourceFormat || metadata.source_format || 's2orc-json-or-jsonl'
    },
    papers,
    references: uniqueBy(references, (entry) => `${entry.paperId}:${entry.id || entry.rawId}`),
    contexts: dedupedContexts,
    diagnostics
  };
}

export async function readS2orcCitationContexts(s2orcPath, metadata = {}) {
  const raw = await readText(s2orcPath);
  const isJsonl = /\.jsonl(?:\.gz)?$/i.test(String(s2orcPath || ''));
  return parseS2orcCitationContexts(raw, {
    ...metadata,
    sourcePath: metadata.sourcePath || metadata.source_path || s2orcPath,
    sourceFormat: metadata.sourceFormat || metadata.source_format || (isJsonl ? 's2orc-jsonl' : 's2orc-json')
  });
}

export async function writeS2orcCitationContexts(outputPath, s2orcPath, metadata = {}) {
  const payload = await readS2orcCitationContexts(s2orcPath, metadata);
  await writeJson(outputPath, payload);
  return payload;
}
