import { assessSourceContent, invalidPaperTitleReason } from './source-quality.js';
import path from 'node:path';
import {
  normalizeText,
  stableHash,
  STOPWORDS,
  tokenizeWithoutStopwords,
  unique
} from '../../lib/utils.js';

const SECTION_ROLE_PATTERNS = [
  ['abstract', 'abstract'],
  ['introduction', 'introduction'],
  ['background', 'background'],
  ['related work', 'related-work'],
  ['preliminaries', 'preliminaries'],
  ['method', 'method'],
  ['approach', 'method'],
  ['implementation', 'method'],
  ['experiment', 'experiments'],
  ['evaluation', 'experiments'],
  ['result', 'results'],
  ['analysis', 'analysis'],
  ['discussion', 'discussion'],
  ['conclusion', 'conclusion'],
  ['references', 'references'],
  ['bibliography', 'references'],
  ['appendix', 'appendix']
];

const DEGENERATE_TITLE_PATTERNS = [
  [/^abstract$/i, 'section-heading'],
  [/^introduction$/i, 'section-heading'],
  [/^background$/i, 'section-heading'],
  [/^related work$/i, 'section-heading'],
  [/^preliminaries$/i, 'section-heading'],
  [/^(method|methods|approach|implementation)$/i, 'section-heading'],
  [/^(experiment|experiments|evaluation|results|analysis|discussion)$/i, 'section-heading'],
  [/^(conclusion|conclusions)$/i, 'section-heading'],
  [/^(references|bibliography)$/i, 'section-heading'],
  [/^(appendix|appendices)$/i, 'section-heading'],
  [/^(acknowledg?ments?)$/i, 'section-heading'],
  [/^(keywords?|index terms?)$/i, 'metadata-heading'],
  [/^(authors?|affiliations?)$/i, 'metadata-heading'],
  [/^(figure|table)\s+\w+/i, 'caption-like'],
  [/^(overview|summary|contents?)$/i, 'section-heading']
];

function isChartNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Keep named metrics/models, equations, single values and integer data.
  if (/^[+-]?\d+\.\d+(?:\s+[+-]?\d+\.\d+){2,}$/.test(trimmed)) {
    const values = trimmed.split(/\s+/).map(Number);
    const delta = values[1] - values[0];
    if (delta !== 0 && values.every((value, index) => index < 2
      || Math.abs(value - values[index - 1] - delta) < 1e-8)) return true;
  }
  if (/^(?:\[[A-Za-z][\w-]*\]\s*){2,}[+ ]*\d+(?:\.\d+)?(?:\s+\d+(?:\.\d+)?){2,}$/.test(trimmed)) return true;
  if (/^[\[\]?'"]+$/.test(trimmed) && trimmed.includes('?')) return true;

  return false;
}

function cleanText(value) {
  return cleanMarkdownWithReport(value).text;
}

function trimBlankLines(value) {
  return String(value || '').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}

export function cleanMarkdownWithReport(value) {
  const source = String(value || '');
  const kept = [];
  const removed = [];
  let offset = 0;
  let fence = null;
  let math = false;
  const sourceLines = source.split('\n');
  for (let index = 0; index < sourceLines.length; index += 1) {
    const raw = sourceLines[index];
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    const marker = trimmed.match(/^(\x60{3,}|~{3,})/);
    const protectedBefore = Boolean(fence || math);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && (trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]')) math = !math;
    const protectedLine = protectedBefore || marker || math || trimmed.includes('|')
      || /^\$\$|^\\\[|^\\\]/.test(trimmed) || /^(?: {4}|\t)/.test(line);
    if (!protectedLine && isChartNoiseLine(line)) {
      removed.push({ sourceLine: index + 1, startOffset: offset, endOffset: offset + raw.length,
        text: raw, reason: trimmed.includes('?') ? 'punctuation_artifact' : 'chart_tick_or_legend' });
    } else kept.push(line);
    offset += raw.length + 1;
  }
  return {
    text: trimBlankLines(kept.join('\n')),
    report: {
      contractVersion: 'papernexus-text-quality-v1', sourceHash: stableHash(source),
      offsetUnit: 'utf16', sourceLineCount: sourceLines.length,
      removedLineCount: removed.length, removedLines: removed, originalTextModified: false,
      boundary: 'Formatting cleanup only; numeric accuracy and OCR semantics are not verified. Offsets refer to original Markdown.'
    }
  };
}

function normalizeTitleLine(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .find((line) => line.trim()) || '';
}

function normalizeTitleCandidate(value) {
  return normalizeTitleLine(value)
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '')
    .trim();
}

export function assessPaperTitleCandidate(rawTitle, filePath = '') {
  const fallbackTitle = path.basename(filePath || 'paper', path.extname(filePath || '')) || 'paper';
  const normalizedCandidate = normalizeTitleCandidate(rawTitle);
  const normalizedKey = normalizeText(normalizedCandidate);
  let reason = invalidPaperTitleReason(normalizedCandidate);

  if (!normalizedCandidate) {
    reason = 'empty';
  } else if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(normalizedCandidate)) {
    reason = 'missing-alphanumeric';
  } else if (normalizedCandidate.length > 220) {
    reason = 'too-long';
  } else if (normalizedCandidate.length < 4 && !/^[A-Z]{2,}$/.test(normalizedCandidate)) {
    reason = 'too-short';
  } else {
    for (const [pattern, matchReason] of DEGENERATE_TITLE_PATTERNS) {
      if (pattern.test(normalizedCandidate) || pattern.test(normalizedKey)) {
        reason = matchReason;
        break;
      }
    }
  }

  const isValid = !reason;
  return {
    displayTitle: isValid ? normalizedCandidate : fallbackTitle,
    rawTitle: normalizedCandidate,
    fallbackTitle,
    isValid,
    usedFallbackTitle: !isValid,
    needsReparse: !isValid,
    reason
  };
}

export function isPaperTitleDegenerate(title, filePath = '') {
  return !assessPaperTitleCandidate(title, filePath).isValid;
}

export function inferSectionRole(heading) {
  const normalized = normalizeText(heading);
  for (const [pattern, role] of SECTION_ROLE_PATTERNS) {
    if (normalized.includes(pattern)) return role;
  }
  return 'body';
}

function parseAuthors(lines) {
  if (!lines.length) return [];
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length > 220) return [];

  return unique(
    joined
      .split(/\s*(?:,| and |•|\|)\s*/i)
      .map((value) => value.trim())
      .filter((value) => /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}$/.test(value))
  );
}

function splitMarkdownBlocks(text) {
  const blocks = [];
  let lines = [];
  let fence = null;
  let math = false;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^(\x60{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && (trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]')) math = !math;
    if (!trimmed && !fence && !math) {
      if (lines.length) blocks.push(lines.join('\n'));
      lines = [];
    } else lines.push(line);
  }
  if (lines.length) blocks.push(lines.join('\n'));
  return blocks.filter((block) => block.trim());
}

function buildChunks(text) {
  // The original Markdown was already cleaned with source offsets. Do not
  // reclassify fragments after their code/math context has been removed.
  const paragraphs = splitMarkdownBlocks(text);

  if (!paragraphs.length) return [];

  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    const addition = paragraph.length + (current.length ? 2 : 0);
    if (current.length && currentLength + addition > 1200) {
      chunks.push(current.join('\n\n'));
      current = [paragraph];
      currentLength = paragraph.length;
      continue;
    }

    current.push(paragraph);
    currentLength += addition;
  }

  if (current.length) {
    chunks.push(current.join('\n\n'));
  }

  return chunks.map((chunk, index) => ({
    id: `chunk:${stableHash(`${index}:${chunk}`)}`,
    order: index + 1,
    text: chunk
  }));
}

function splitReferenceEntries(text) {
  const blocks = cleanText(text)
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (blocks.length > 1) {
    return blocks;
  }

  const lines = cleanText(text)
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);

  const entries = [];
  let current = '';

  for (const line of lines) {
    if (/^(?:\[\d+\]|\d+\.\s+|[-*]\s+)/.test(line) && current) {
      entries.push(current.trim());
      current = line.replace(/^(?:\[\d+\]|\d+\.\s+|[-*]\s+)/, '').trim();
      continue;
    }

    if (!current) {
      current = line.replace(/^(?:\[\d+\]|\d+\.\s+|[-*]\s+)/, '').trim();
      continue;
    }

    current = `${current} ${line.replace(/^[-*]\s+/, '')}`.trim();
  }

  if (current) entries.push(current.trim());
  return entries;
}

function parseReferenceEntry(raw, index, filePath) {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const yearMatch = cleaned.match(/\b(19|20)\d{2}[a-z]?\b/);
  const authorSegment = yearMatch ? cleaned.slice(0, yearMatch.index).replace(/[().,\s]+$/g, '').trim() : '';
  const authorParts = authorSegment
    .split(/\s*(?:,| and |&)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);
  const leadAuthor = authorParts[0] || '';
  const leadAuthorLastName = leadAuthor.split(/\s+/).slice(-1)[0] || '';

  let titleGuess = '';
  if (yearMatch) {
    const afterYear = cleaned.slice(yearMatch.index + yearMatch[0].length).replace(/^[).\s:-]+/, '');
    titleGuess = afterYear.split('. ')[0]?.trim() || afterYear.trim();
  }

  const citationKey = normalizeText(`${leadAuthorLastName} ${yearMatch?.[0] || ''}`);

  return {
    id: `reference:${stableHash(`${filePath}:${index}:${cleaned}`)}`,
    index,
    raw: cleaned,
    year: yearMatch?.[0] || null,
    leadAuthorLastName,
    titleGuess,
    citationKey
  };
}

function buildReferenceLookup(references) {
  const numeric = new Map();
  const authorYear = new Map();

  for (const reference of references) {
    numeric.set(reference.index, reference.id);
    if (reference.citationKey.trim()) {
      authorYear.set(reference.citationKey, reference.id);
    }
  }

  return { numeric, authorYear };
}

function expandNumericPart(part) {
  const trimmed = part.trim();
  if (!trimmed) return [];

  const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (end >= start && end - start <= 10) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }

  const value = Number(trimmed);
  return Number.isFinite(value) ? [value] : [];
}

function extractCitationMentions(text, referenceLookup) {
  const mentions = [];

  for (const match of text.matchAll(/\[(\d+(?:\s*(?:,|-)\s*\d+)*)\]/g)) {
    const parts = match[1].split(',');
    for (const part of parts) {
      for (const number of expandNumericPart(part)) {
        mentions.push({
          raw: `[${number}]`,
          referenceId: referenceLookup.numeric.get(number) || null,
          style: 'numeric'
        });
      }
    }
  }

  for (const match of text.matchAll(/\(([A-Z][^()]*?\d{4}[a-z]?[^()]*)\)/g)) {
    const segments = match[1].split(';');
    for (const segment of segments) {
      const yearMatch = segment.match(/\b(19|20)\d{2}[a-z]?\b/);
      if (!yearMatch) continue;
      const namePart = segment.slice(0, yearMatch.index).trim();
      const lastName = namePart.split(/\s+/).filter(Boolean).slice(-1)[0];
      if (!lastName) continue;
      const key = normalizeText(`${lastName} ${yearMatch[0]}`);
      mentions.push({
        raw: segment.trim(),
        referenceId: referenceLookup.authorYear.get(key) || null,
        style: 'author-year'
      });
    }
  }

  return mentions.filter((mention, index) => {
    return mentions.findIndex((item) => item.raw === mention.raw && item.referenceId === mention.referenceId) === index;
  });
}

export function extractConceptCandidates(texts) {
  const counts = new Map();
  const GENERIC_SURFACE_TOKENS = new Set([
    'approach', 'analysis', 'benchmark', 'benchmarks', 'claim', 'claims', 'conclusion',
    'dataset', 'datasets', 'discussion', 'energy', 'evidence',
    'finding', 'findings', 'framework', 'graph', 'graphs', 'introduction', 'knowledge',
    'method', 'methods', 'metric', 'metrics', 'model', 'models', 'monitoring', 'paper',
    'pressure', 'problem', 'problems', 'process', 'processes', 'product',
    'research', 'result', 'results', 'scale', 'speech', 'study', 'system', 'task', 'tasks',
    'view', 'views', 'workflow'
  ]);

  function bump(phrase, weight) {
    const normalized = normalizeText(phrase);
    if (!normalized || normalized.length < 4) return;
    if (normalized.split(' ').every((token) => STOPWORDS.has(token))) return;
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length < 2) return;
    if (tokens.some((token) => /^\d{4}$/.test(token))) return;
    if (tokens.every((token) => GENERIC_SURFACE_TOKENS.has(token))) return;
    if (GENERIC_SURFACE_TOKENS.has(tokens[0]) || GENERIC_SURFACE_TOKENS.has(tokens[tokens.length - 1])) {
      return;
    }
    const previous = counts.get(normalized) || { phrase: normalized, score: 0, count: 0 };
    previous.score += weight;
    previous.count += 1;
    counts.set(normalized, previous);
  }

  for (const text of texts) {
    const tokens = tokenizeWithoutStopwords(text);
    for (let index = 0; index < tokens.length; index += 1) {
      if (index + 1 < tokens.length) {
        const bigram = `${tokens[index]} ${tokens[index + 1]}`;
        bump(bigram, 1.75);
      }

      if (index + 2 < tokens.length) {
        const trigram = `${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`;
        bump(trigram, 2.25);
      }
    }
  }

  return [...counts.values()]
    .filter((item) => item.score >= 2.25)
    .sort((left, right) => right.score - left.score);
}

export function parsePaperMarkdown(markdown, filePath) {
  const sourceQuality = assessSourceContent(markdown);
  if (!sourceQuality.valid) {
    const error = new Error(`Rejected paper source: ${sourceQuality.reason}`);
    error.code = 'PAPERNEXUS_INVALID_PAPER_SOURCE';
    throw error;
  }
  const cleaned = cleanMarkdownWithReport(markdown);
  const lines = cleaned.text.split('\n');
  let title = path.basename(filePath, path.extname(filePath));
  let titleIndex = -1;
  let titleValidation = assessPaperTitleCandidate('', filePath);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    titleValidation = assessPaperTitleCandidate(line, filePath);
    title = titleValidation.displayTitle;
    titleIndex = index;
    break;
  }

  const authorLines = [];
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      if (authorLines.length) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^(abstract|introduction)$/i.test(line)) break;
    authorLines.push(line);
  }

  const sections = [];
  let currentSection = { heading: 'Front Matter', level: 1, lines: [] };
  let sectionFence = null;
  let sectionMath = false;

  for (let index = titleIndex + 1 + authorLines.length; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const marker = trimmed.match(/^(\x60{3,}|~{3,})/);
    const protectedBefore = Boolean(sectionFence || sectionMath);
    if (marker) {
      if (!sectionFence) sectionFence = marker[1];
      else if (marker[1][0] === sectionFence[0] && marker[1].length >= sectionFence.length) sectionFence = null;
    }
    if (!sectionFence && (trimmed === '$$' || trimmed === '\\[' || trimmed === '\\]')) sectionMath = !sectionMath;
    const headingMatch = !protectedBefore && !sectionFence && !sectionMath && !marker
      ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null;
    if (headingMatch) {
      if (currentSection.lines.length || currentSection.heading !== 'Front Matter') {
        sections.push(currentSection);
      }
      currentSection = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        lines: []
      };
      continue;
    }

    currentSection.lines.push(line);
  }

  if (currentSection.lines.length || currentSection.heading !== 'Front Matter') {
    sections.push(currentSection);
  }

  const normalizedSections = sections
    .map((section, index) => {
      const text = trimBlankLines(section.lines.join('\n'));
      return {
        id: `section:${stableHash(`${filePath}:${index}:${section.heading}`)}`,
        heading: section.heading,
        level: section.level,
        role: inferSectionRole(section.heading),
        order: index + 1,
        text,
        chunks: buildChunks(text)
      };
    })
    .filter((section) => section.text);

  const referenceSection = normalizedSections.find((section) => section.role === 'references');
  const references = referenceSection
    ? splitReferenceEntries(referenceSection.text).map((entry, index) => parseReferenceEntry(entry, index + 1, filePath))
    : [];
  const referenceLookup = buildReferenceLookup(references);

  for (const section of normalizedSections) {
    for (const chunk of section.chunks) {
      chunk.citations = extractCitationMentions(chunk.text, referenceLookup);
    }
  }

  const conceptCandidates = extractConceptCandidates([
    title,
    ...normalizedSections.map((section) => section.heading),
    ...normalizedSections
      .filter((section) => section.role !== 'references')
      .slice(0, 4)
      .map((section) => section.text)
  ]);

  return {
    title,
    titleValidation,
    textQuality: cleaned.report,
    authors: parseAuthors(authorLines),
    sourcePath: filePath,
    sections: normalizedSections,
    references,
    conceptCandidates
  };
}
