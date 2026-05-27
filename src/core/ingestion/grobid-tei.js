import { readText, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';

export const GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-grobid-tei-citation-contexts-v1';
export const PAPERNEXUS_CITATION_CONTEXTS_CONTRACT_VERSION = 'papernexus-citation-contexts-v1';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compactText(value = '', max = 2000) {
  return truncate(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function decodeXmlEntities(value = '') {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripTags(value = '') {
  return compactText(decodeXmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function parseAttributes(tagAttributes = '') {
  const attrs = {};
  const pattern = /([\w:-]+)\s*=\s*(['"])([\s\S]*?)\2/g;
  let match;
  while ((match = pattern.exec(String(tagAttributes || ''))) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[3]);
  }
  return attrs;
}

function firstMatch(source = '', pattern) {
  const match = pattern.exec(String(source || ''));
  return match ? match[1] : '';
}

function collectTagValues(source = '', tagName = '') {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const values = [];
  let match;
  while ((match = pattern.exec(String(source || ''))) !== null) {
    const value = stripTags(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function parseYear(value = '') {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function inferSectionRole(heading = '', attrs = {}) {
  const raw = compactText(attrs.type || attrs.subtype || heading, 120).toLowerCase();
  if (!raw) return '';
  if (/abstract/.test(raw)) return 'abstract';
  if (/intro/.test(raw)) return 'introduction';
  if (/method|approach|model|architecture/.test(raw)) return 'method';
  if (/experiment|evaluation|result/.test(raw)) return 'evaluation';
  if (/discussion|analysis/.test(raw)) return 'discussion';
  if (/conclusion/.test(raw)) return 'conclusion';
  if (/reference|bibliography/.test(raw)) return 'references';
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeReferenceId(value = '') {
  return String(value || '').trim().replace(/^#/, '');
}

function citationSentenceWindow(text = '', citationRaw = '') {
  const cleaned = compactText(text, 2400);
  if (!cleaned) return '';
  const sentences = cleaned
    .split(/(?<=[.!?])\s+(?=[A-Z0-9([])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!sentences.length) return compactText(cleaned, 720);

  const raw = compactText(citationRaw, 180);
  const normalizedRaw = raw.replace(/^\(|\)$/g, '');
  const matchIndex = raw
    ? sentences.findIndex((sentence) => sentence.includes(raw) || sentence.includes(normalizedRaw))
    : -1;
  if (matchIndex >= 0) {
    const start = Math.max(0, matchIndex - 1);
    const end = Math.min(sentences.length, matchIndex + 2);
    return compactText(sentences.slice(start, end).join(' '), 720);
  }
  return compactText(sentences[0], 720);
}

function collectBlocks(source = '', tagName = '') {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = pattern.exec(String(source || ''))) !== null) {
    blocks.push({
      attrs: parseAttributes(match[1]),
      innerXml: match[2]
    });
  }
  return blocks;
}

function extractTitle(innerXml = '') {
  const titleXml = firstMatch(innerXml, /<title\b(?=[^>]*(?:level=["']a["']|type=["']main["']))[^>]*>([\s\S]*?)<\/title>/i)
    || firstMatch(innerXml, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return compactText(stripTags(titleXml), 360);
}

function extractIdentifiers(innerXml = '') {
  const identifiers = {};
  const pattern = /<idno\b([^>]*)>([\s\S]*?)<\/idno>/gi;
  let match;
  while ((match = pattern.exec(String(innerXml || ''))) !== null) {
    const attrs = parseAttributes(match[1]);
    const type = String(attrs.type || '').trim().toLowerCase();
    const value = stripTags(match[2]);
    if (!type || !value) continue;
    if (type === 'doi') identifiers.doi = value.replace(/^https?:\/\/doi\.org\//i, '');
    if (type === 'arxiv') identifiers.arxivId = value.replace(/^arxiv:/i, '');
    if (type === 'pmid') identifiers.pmid = value;
    if (type === 'pmcid') identifiers.pmcid = value;
  }
  return identifiers;
}

function parseBiblStructReferences(teiXml = '') {
  return collectBlocks(teiXml, 'biblStruct').map((block, index) => {
    const id = normalizeReferenceId(block.attrs['xml:id'] || block.attrs.id || `b${index}`);
    const authors = collectTagValues(block.innerXml, 'surname');
    const year = parseYear(firstMatch(block.innerXml, /<date\b[^>]*\bwhen=["']([^"']+)["'][^>]*\/?>/i))
      || parseYear(stripTags(block.innerXml));
    const title = extractTitle(block.innerXml);
    const identifiers = extractIdentifiers(block.innerXml);
    return {
      id,
      rawId: block.attrs['xml:id'] || block.attrs.id || '',
      title,
      titleGuess: title,
      year,
      leadAuthorLastName: authors[0] || '',
      authors: unique(authors),
      raw: stripTags(block.innerXml),
      identifiers
    };
  }).filter((reference) => reference.id || reference.raw || reference.title);
}

function extractBodyXml(teiXml = '') {
  return firstMatch(teiXml, /<body\b[^>]*>([\s\S]*?)<\/body>/i) || teiXml;
}

function processParagraph(block = {}, context = {}) {
  const paragraphText = stripTags(block.innerXml);
  if (!paragraphText) return [];
  const refPattern = /<ref\b([^>]*)>([\s\S]*?)<\/ref>/gi;
  const mentions = [];
  let match;
  while ((match = refPattern.exec(String(block.innerXml || ''))) !== null) {
    const attrs = parseAttributes(match[1]);
    if (String(attrs.type || '').toLowerCase() !== 'bibr') continue;
    const citationRaw = stripTags(match[2]);
    const targets = asArray(String(attrs.target || '').split(/\s+/).filter(Boolean));
    const referenceIds = targets.length ? targets.map(normalizeReferenceId).filter(Boolean) : [''];
    for (const referenceId of referenceIds) {
      mentions.push({
        citationRaw,
        referenceId,
        quote: citationSentenceWindow(paragraphText, citationRaw)
      });
    }
  }

  return mentions
    .filter((mention) => mention.quote)
    .map((mention) => {
      const reference = mention.referenceId ? context.referencesById.get(mention.referenceId) : null;
      const idSeed = [
        context.paperId,
        context.sectionId,
        block.attrs['xml:id'] || block.attrs.id || '',
        mention.referenceId,
        mention.citationRaw,
        mention.quote
      ].join(':');
      return {
        contractVersion: PAPERNEXUS_CITATION_CONTEXTS_CONTRACT_VERSION,
        adapterContractVersion: GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION,
        id: `citation-context:${stableHash(idSeed)}`,
        paperId: context.paperId || null,
        paperTitle: context.paperTitle || '',
        sourceKey: context.sourceKey || null,
        sourcePath: context.sourcePath || '',
        sourcePdfPath: context.sourcePdfPath || '',
        sourceTeiPath: context.sourceTeiPath || '',
        sourceProvider: 'grobid-tei',
        sectionId: context.sectionId,
        sectionHeading: context.sectionHeading,
        sectionRole: context.sectionRole,
        chunkId: block.attrs['xml:id'] || block.attrs.id || null,
        citationRaw: mention.citationRaw,
        citationStyle: 'grobid-bibr',
        referenceId: mention.referenceId || null,
        referenceRaw: reference?.raw || '',
        referenceTitleGuess: reference?.titleGuess || reference?.title || '',
        referenceYear: reference?.year || null,
        referenceLeadAuthorLastName: reference?.leadAuthorLastName || '',
        referenceIdentifiers: reference?.identifiers || {},
        exactQuote: mention.quote,
        citationContext: mention.quote,
        extractionStatus: reference ? 'reference-resolved' : (mention.referenceId ? 'reference-missing' : 'reference-unresolved')
      };
    });
}

function extractSectionBlocks(bodyXml = '') {
  const divs = collectBlocks(bodyXml, 'div');
  if (divs.length) return divs;
  return [{
    attrs: { id: 'body' },
    innerXml: bodyXml
  }];
}

export function parseGrobidTeiCitationContexts(teiXml = '', metadata = {}) {
  const diagnostics = {
    contractVersion: GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION,
    errors: [],
    warnings: [],
    referenceCount: 0,
    sectionCount: 0,
    paragraphCount: 0,
    mentionCount: 0,
    contextCount: 0,
    unresolvedReferenceCount: 0
  };
  const references = parseBiblStructReferences(teiXml);
  const referencesById = new Map(references.map((reference) => [reference.id, reference]));
  const contexts = [];
  const paperId = compactText(metadata.paperId || metadata.paper_id || metadata.id || '', 240);
  const paperTitle = compactText(metadata.paperTitle || metadata.paper_title || metadata.title || '', 360);

  try {
    const sections = extractSectionBlocks(extractBodyXml(teiXml));
    diagnostics.referenceCount = references.length;
    diagnostics.sectionCount = sections.length;
    for (let index = 0; index < sections.length; index += 1) {
      const section = sections[index];
      const heading = stripTags(firstMatch(section.innerXml, /<head\b[^>]*>([\s\S]*?)<\/head>/i));
      const sectionRole = inferSectionRole(heading, section.attrs);
      if (sectionRole === 'references') continue;
      const sectionId = section.attrs['xml:id'] || section.attrs.id || `tei-section:${index + 1}`;
      const paragraphs = collectBlocks(section.innerXml, 'p');
      diagnostics.paragraphCount += paragraphs.length;
      for (const paragraph of paragraphs) {
        const paragraphContexts = processParagraph(paragraph, {
          referencesById,
          paperId,
          paperTitle,
          sourceKey: metadata.sourceKey || metadata.source_key || null,
          sourcePath: metadata.sourcePath || metadata.source_path || '',
          sourcePdfPath: metadata.sourcePdfPath || metadata.source_pdf_path || '',
          sourceTeiPath: metadata.sourceTeiPath || metadata.source_tei_path || '',
          sectionId,
          sectionHeading: heading,
          sectionRole
        });
        diagnostics.mentionCount += paragraphContexts.length;
        contexts.push(...paragraphContexts);
      }
    }
  } catch (error) {
    diagnostics.errors.push({
      stage: 'grobid-tei-citation-contexts',
      message: error instanceof Error ? error.message : String(error)
    });
  }

  diagnostics.contextCount = contexts.length;
  diagnostics.unresolvedReferenceCount = contexts.filter((entry) => entry.extractionStatus !== 'reference-resolved').length;
  if (!references.length) diagnostics.warnings.push({ code: 'no_biblstruct_references', message: 'No TEI biblStruct references were found.' });
  if (!contexts.length) diagnostics.warnings.push({ code: 'no_bibr_contexts', message: 'No TEI bibr citation contexts were found.' });

  return {
    contractVersion: GROBID_TEI_CITATION_CONTEXTS_CONTRACT_VERSION,
    paper: {
      paperId: paperId || null,
      paperTitle,
      sourceKey: metadata.sourceKey || metadata.source_key || null,
      sourcePath: metadata.sourcePath || metadata.source_path || '',
      sourcePdfPath: metadata.sourcePdfPath || metadata.source_pdf_path || '',
      sourceTeiPath: metadata.sourceTeiPath || metadata.source_tei_path || ''
    },
    references,
    contexts,
    diagnostics
  };
}

export async function readGrobidTeiCitationContexts(teiPath, metadata = {}) {
  const teiXml = await readText(teiPath);
  return parseGrobidTeiCitationContexts(teiXml, {
    ...metadata,
    sourceTeiPath: metadata.sourceTeiPath || metadata.source_tei_path || teiPath
  });
}

export async function writeGrobidTeiCitationContexts(outputPath, teiPath, metadata = {}) {
  const payload = await readGrobidTeiCitationContexts(teiPath, metadata);
  await writeJson(outputPath, payload);
  return payload;
}
