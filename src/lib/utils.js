import crypto from 'node:crypto';

export const STOPWORDS = new Set([
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'all', 'almost', 'also',
  'am', 'among', 'an', 'and', 'any', 'are', 'around', 'as', 'at', 'be', 'because', 'been',
  'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'done', 'during', 'each', 'either', 'else', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'here', 'how', 'however', 'if', 'in', 'into', 'is', 'it', 'its',
  'itself', 'just', 'may', 'might', 'more', 'most', 'much', 'must', 'nearly', 'no', 'nor',
  'not', 'of', 'off', 'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'our', 'out',
  'over', 'per', 'same', 'should', 'since', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'toward', 'under', 'until', 'up', 'upon', 'use', 'used', 'using', 'very', 'was', 'we',
  'well', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with',
  'within', 'without', 'would', 'yet', 'you', 'your'
]);

export function stableHash(value, length = 12) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, length);
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[-\s]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

export function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

export function unique(values) {
  return [...new Set(values)];
}

export function truncate(value, max = 180) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}...`;
}

export function titleCase(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function tokenizeWithoutStopwords(value) {
  return tokenize(value).filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function scoreTokenOverlap(queryTokens, textTokens) {
  if (!queryTokens.length || !textTokens.length) return 0;
  const textSet = new Set(textTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (textSet.has(token)) matches += 1;
  }
  return matches / queryTokens.length;
}

export function jaccardSimilarity(left, right) {
  const leftSet = new Set(tokenizeWithoutStopwords(left));
  const rightSet = new Set(tokenizeWithoutStopwords(right));
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

export function parseCsvList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
