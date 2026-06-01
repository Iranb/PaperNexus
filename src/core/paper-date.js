const DATE_FIELD_NAMES = [
  'publicationDate',
  'publication_date',
  'publicationDateOrYear',
  'publication_date_or_year',
  'published',
  'publishedAt',
  'published_at',
  'publishTime',
  'publish_time',
  'firstPublicationDate',
  'first_publication_date',
  'printPublicationDate',
  'print_publication_date',
  'electronicPublicationDate',
  'electronic_publication_date'
];

const YEAR_FIELD_NAMES = [
  'year',
  'publicationYear',
  'publication_year',
  'publishedYear',
  'published_year',
  'pubYear',
  'pub_year'
];

const NESTED_RECORD_NAMES = [
  'properties',
  'metadata',
  'paper',
  'node',
  'source'
];

const PRECISION_RANK = {
  none: 0,
  year: 1,
  month: 2,
  day: 3
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function validYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null;
}

function validMonth(value) {
  const month = Number(value);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

function validDay(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function buildInfo(year, month = 1, day = 1, precision = 'year', raw = null, field = '') {
  const normalizedDate = precision === 'day'
    ? `${year}-${pad2(month)}-${pad2(day)}`
    : (precision === 'month' ? `${year}-${pad2(month)}` : String(year));
  return {
    year,
    month,
    day,
    precision,
    timestamp: Date.UTC(year, month - 1, day),
    normalizedDate,
    raw,
    field
  };
}

function parseDateParts(parts, raw = null, field = '') {
  const year = validYear(parts?.[0]);
  if (!year) return null;
  const month = validMonth(parts?.[1]);
  const day = validDay(parts?.[2]);
  if (month && day) return buildInfo(year, month, day, 'day', raw, field);
  if (month) return buildInfo(year, month, 1, 'month', raw, field);
  return buildInfo(year, 1, 1, 'year', raw, field);
}

function parsePublicationValue(value, field = '') {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return buildInfo(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      'day',
      value.toISOString(),
      field
    );
  }

  if (Array.isArray(value)) {
    return parseDateParts(Array.isArray(value[0]) ? value[0] : value, value, field);
  }

  if (typeof value === 'number') {
    const year = validYear(value);
    return year ? buildInfo(year, 1, 1, 'year', value, field) : null;
  }

  if (isPlainObject(value)) {
    if (Array.isArray(value['date-parts'])) {
      return parseDateParts(value['date-parts'][0], value, field);
    }
    const year = validYear(value.year || value.publicationYear || value.publication_year || value.publishedYear || value.published_year);
    if (!year) return null;
    const month = validMonth(value.month);
    const day = validDay(value.day);
    if (month && day) return buildInfo(year, month, day, 'day', value, field);
    if (month) return buildInfo(year, month, 1, 'month', value, field);
    return buildInfo(year, 1, 1, 'year', value, field);
  }

  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = text.replace(/\//g, '-');
  const match = normalized.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
  if (!match) return null;
  const year = validYear(match[1]);
  if (!year) return null;
  const month = validMonth(match[2]);
  const day = validDay(match[3]);
  if (month && day) return buildInfo(year, month, day, 'day', text, field);
  if (month) return buildInfo(year, month, 1, 'month', text, field);
  return buildInfo(year, 1, 1, 'year', text, field);
}

function comparePublicationInfoDesc(left, right) {
  if (left && right) {
    if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? -1 : 1;
    const precisionDelta = PRECISION_RANK[right.precision] - PRECISION_RANK[left.precision];
    if (precisionDelta) return precisionDelta;
    return 0;
  }
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function collectDateInfos(record, depth = 0, seen = new Set()) {
  if (!isPlainObject(record) || seen.has(record)) return [];
  seen.add(record);
  const infos = [];

  for (const field of DATE_FIELD_NAMES) {
    const info = parsePublicationValue(record[field], field);
    if (info) infos.push(info);
  }
  for (const field of YEAR_FIELD_NAMES) {
    const info = parsePublicationValue(record[field], field);
    if (info) infos.push(info);
  }

  if (depth < 2) {
    for (const field of NESTED_RECORD_NAMES) {
      infos.push(...collectDateInfos(record[field], depth + 1, seen));
    }
  }

  return infos;
}

export function extractPublicationDateInfo(record = {}) {
  return collectDateInfos(record)
    .sort(comparePublicationInfoDesc)[0] || null;
}

export function comparePaperPublicationDateDesc(left = {}, right = {}, fallbackCompare = () => 0) {
  const publicationCompare = comparePublicationInfoDesc(
    extractPublicationDateInfo(left),
    extractPublicationDateInfo(right)
  );
  return publicationCompare || fallbackCompare(left, right);
}

export function sortPaperRecordsByPublicationDateDesc(records = [], options = {}) {
  const fallbackCompare = typeof options.fallbackCompare === 'function'
    ? options.fallbackCompare
    : () => 0;
  return [...records]
    .map((record, index) => ({ record, index }))
    .sort((left, right) => (
      comparePaperPublicationDateDesc(left.record, right.record, fallbackCompare)
      || left.index - right.index
    ))
    .map((entry) => entry.record);
}

export function pickLatestPublicationDateFields(...records) {
  const info = records
    .map((record) => extractPublicationDateInfo(record))
    .filter(Boolean)
    .sort(comparePublicationInfoDesc)[0] || null;
  if (!info) {
    return {
      year: null,
      publicationDate: null
    };
  }
  return {
    year: info.year,
    publicationDate: info.precision === 'year' ? null : info.normalizedDate
  };
}

export function publicationYearFromRecord(record = {}) {
  return extractPublicationDateInfo(record)?.year || null;
}

export function publicationDateFromRecord(record = {}) {
  const info = extractPublicationDateInfo(record);
  return info && info.precision !== 'year' ? info.normalizedDate : null;
}
