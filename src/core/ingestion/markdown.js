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

function isChartNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // 坐标轴刻度模式：0.50 0.45 0.40 0.35
  if (/^[\d\s\.\-]+$/.test(trimmed)) return true;

  // 图例模式：[SSR] [CLIP] + 数字
  if (/^[\[\]\w\s]+\s+[\d\s\.\-]+$/.test(trimmed)) return true;

  // 乱码模式：连续的问号、方括号等
  if (/^[\[\]?'"]+$/.test(trimmed)) return true;

  // 短行且包含大量特殊字符
  if (trimmed.length < 20 && /[^A-Za-z0-9\u4e00-\u9fff\s]{3,}/.test(trimmed)) return true;

  return false;
}

function cleanText(value) {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // 过滤图表噪声行
  const lines = text.split('\n')
    .filter((line) => !isChartNoiseLine(line))
    .join('\n');

  return lines.trim();
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

function buildChunks(text) {
  const paragraphs = cleanText(text)
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);

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
    'dataset', 'datasets', 'discussion', 'energy', 'evidence', 'experiment', 'experiments',
    'finding', 'findings', 'framework', 'graph', 'graphs', 'introduction', 'knowledge',
    'method', 'methods', 'metric', 'metrics', 'model', 'models', 'monitoring', 'paper',
    'planning', 'pressure', 'problem', 'problems', 'process', 'processes', 'product',
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
  const lines = cleanText(markdown).split('\n');
  let title = path.basename(filePath, path.extname(filePath));
  let titleIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    title = line.replace(/^#\s+/, '').trim();
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

  for (let index = titleIndex + 1 + authorLines.length; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
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
      const text = cleanText(section.lines.join('\n'));
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
    authors: parseAuthors(authorLines),
    sourcePath: filePath,
    sections: normalizedSections,
    references,
    conceptCandidates
  };
}
