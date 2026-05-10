import { stableHash, truncate, unique } from '../../lib/utils.js';

const ENTITY_LIMIT = 80;
const ENTITY_CONTEXT_PATTERN = /\b(dataset|datasets|benchmark|benchmarks|corpus|corpora|knowledge base|evaluation framework|metric|metrics|task|tasks)\b/i;
const ENTITY_NAME_PATTERN = /[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,5}/g;
const ENTITY_STOP_NAMES = new Set([
  'Dataset',
  'Datasets',
  'Benchmark',
  'Benchmarks',
  'Corpus',
  'Corpora',
  'Table',
  'Figure',
  'Appendix',
  'Evaluation',
  'Metrics',
  'Tasks'
]);

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitContextWindows(text = '') {
  return compactText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 20 && ENTITY_CONTEXT_PATTERN.test(entry));
}

function inferKind(context = '') {
  const lower = context.toLowerCase();
  if (/\bdatasets?\b/.test(lower)) return 'dataset';
  if (/\bbenchmarks?\b/.test(lower)) return 'benchmark';
  if (/\bcorpus|corpora|knowledge base\b/.test(lower)) return 'dataset';
  if (/\bmetrics?\b/.test(lower)) return 'metric';
  if (/\btasks?\b/.test(lower)) return 'task';
  return 'entity';
}

function isEntityName(value = '') {
  const name = compactText(value).replace(/[:;,.)\]]+$/g, '');
  if (!name || ENTITY_STOP_NAMES.has(name)) return false;
  if (name.length < 3 || name.length > 80) return false;
  if (/^(The|This|These|Those|Our|We|They|Systems|Recent|Overall)$/i.test(name)) return false;
  if (/^(dataset|datasets|benchmark|benchmarks|corpus|evaluation|for|of|in|with)\b/i.test(name)) return false;
  return /[A-Za-z]/.test(name);
}

function cleanEntityName(value = '') {
  let name = compactText(value).replace(/[:;,.)\]]+$/g, '');
  name = name.replace(/\b([A-Z][A-Za-z0-9-]*)(dataset|benchmark|corpus)$/i, '$1');
  const gluedArticleMatch = name.match(/\b(?:the|a|an)([A-Z][A-Za-z0-9-]*)$/);
  if (gluedArticleMatch) name = gluedArticleMatch[1];
  const tokens = name.split(/\s+/).filter(Boolean);
  const cueIndex = Math.max(
    tokens.findLastIndex((token) => /^(using|called|named|like|including)$/i.test(token)),
    tokens.findLastIndex((token) => /^(the|a|an)$/i.test(token))
  );
  if (cueIndex >= 0 && cueIndex < tokens.length - 1) {
    name = tokens.slice(cueIndex + 1).join(' ');
  }
  return compactText(name.replace(/^(the|a|an)\s+/i, ''));
}

function collectNamesFromContext(context = '') {
  const names = [];
  const compact = compactText(context);
  const targetedPatterns = [
    /\b(?:dataset|benchmark|corpus|knowledge base|evaluation framework)s?\s+(?:called|named|like|such as|including|using|the)?\s*([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,5})/gi,
    /\b([A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*){0,5})\s*(?:dataset|benchmark|corpus|knowledge base|evaluation framework)\b/gi
  ];

  for (const pattern of targetedPatterns) {
    let match = pattern.exec(compact);
    while (match) {
      const name = cleanEntityName(match[1]);
      if (isEntityName(name)) names.push(name);
      match = pattern.exec(compact);
    }
  }

  let nameMatch = ENTITY_NAME_PATTERN.exec(compact);
  while (nameMatch) {
    const name = cleanEntityName(nameMatch[0]);
    if (isEntityName(name) && /[A-Z]{2,}|[a-z][A-Z]/.test(name)) names.push(name);
    nameMatch = ENTITY_NAME_PATTERN.exec(compact);
  }

  return unique(names);
}

export function extractResearchEntitiesFromText(text = '', options = {}) {
  const sourceTitle = compactText(options.sourceTitle || options.source_title);
  const limit = Math.max(1, Math.floor(Number(options.limit || ENTITY_LIMIT) || ENTITY_LIMIT));
  const seen = new Set();
  const entities = [];

  for (const context of splitContextWindows(text)) {
    const kind = inferKind(context);
    for (const name of collectNamesFromContext(context)) {
      const key = `${kind}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        id: `text_entity:${stableHash(`${key}:${sourceTitle}`, 16)}`,
        name,
        kind,
        context: truncate(context, 500),
        sourceTitle
      });
      if (entities.length >= limit) return entities;
    }
  }

  return entities;
}
