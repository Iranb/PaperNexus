import { readText, writeJson } from '../../lib/fs.js';
import { stableHash, truncate, unique } from '../../lib/utils.js';
import { EDGE_TYPES, NODE_TYPES } from '../graph/schema.js';

export const COCI_CITATION_GRAPH_CONTRACT_VERSION = 'papernexus-coci-citation-graph-v1';

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

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHeader(value = '') {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseDelimitedLine(line = '', delimiter = ',') {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseDelimitedRecords(raw = '', delimiter = ',') {
  const lines = String(raw || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseDelimitedLine(lines[0], delimiter).map(normalizeHeader);
  const records = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = parseDelimitedLine(lines[index], delimiter);
    const record = { sourceRow: index + 1 };
    for (let column = 0; column < headers.length; column += 1) {
      if (!headers[column]) continue;
      record[headers[column]] = values[column] ?? '';
    }
    records.push(record);
  }
  return records;
}

function stripIndexPrefix(value = '', preferredIndex = 'coci') {
  const text = compactText(value, 1000);
  if (!text) return '';
  const parts = text.split(';').map((part) => part.trim()).filter(Boolean);
  const parsed = parts.map((part) => {
    const match = part.match(/^(?:\[?([a-z0-9_-]+)\]?\s*)?=>\s*(.+)$/i);
    return match ? { index: match[1]?.toLowerCase() || '', value: match[2].trim() } : { index: '', value: part };
  });
  const preferred = parsed.find((part) => part.index === preferredIndex);
  return (preferred || parsed[0] || { value: text }).value;
}

function normalizeDoi(value = '') {
  const stripped = stripIndexPrefix(value);
  const candidates = [
    stripped,
    ...String(stripped || '').split(/[;\s]+/).filter(Boolean)
  ];
  for (const candidate of candidates) {
    const withoutPrefix = String(candidate || '')
      .trim()
      .replace(/^doi:/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^https?:\/\/doi\.org\//i, '');
    const match = withoutPrefix.match(/10\.\d{4,9}\/[^\s"<>]+/i);
    const doi = (match ? match[0] : withoutPrefix)
      .replace(/[)\].,;]+$/g, '')
      .toLowerCase();
    if (/^10\.\d{4,9}\//.test(doi)) return doi;
  }
  return '';
}

function normalizeOci(value = '') {
  return stripIndexPrefix(value)
    .replace(/^oci:/i, '')
    .replace(/^https?:\/\/w3id\.org\/oc\/index\/[^/]+\/ci\//i, '')
    .replace(/^https?:\/\/oci\.opencitations\.net\/virtual\/ci\//i, '')
    .replace(/\.html$/i, '')
    .trim();
}

function normalizeSelfCitation(value) {
  const normalized = stripIndexPrefix(value).trim().toLowerCase();
  if (!normalized) return null;
  if (['yes', 'true', '1', 'y'].includes(normalized)) return true;
  if (['no', 'false', '0', 'n'].includes(normalized)) return false;
  return null;
}

function getField(record = {}, names = []) {
  const object = asObject(record);
  for (const name of names) {
    if (object[name] !== undefined && object[name] !== null && object[name] !== '') return object[name];
  }
  for (const [key, value] of Object.entries(object)) {
    if (names.includes(normalizeHeader(key)) && value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function normalizeInputRecords(input, diagnostics, metadata = {}) {
  if (typeof input !== 'string') {
    if (Array.isArray(input)) return input;
    const object = asObject(input);
    return asArray(object.citations || object.references || object.records || object.items || object.data || input);
  }

  const raw = String(input || '').trim();
  if (!raw) return [];

  const sourceFormat = compactText(metadata.sourceFormat || metadata.source_format || metadata.format, 60).toLowerCase();
  if (sourceFormat === 'coci-tsv' || sourceFormat === 'tsv') {
    return parseDelimitedRecords(raw, '\t');
  }
  if (sourceFormat === 'coci-csv' || sourceFormat === 'csv') {
    return parseDelimitedRecords(raw, ',');
  }

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return normalizeInputRecords(JSON.parse(raw), diagnostics, metadata);
    } catch (error) {
      const jsonlRecords = parseJsonlRecords(raw, diagnostics);
      if (jsonlRecords.length) return jsonlRecords;
      diagnostics.errors.push({
        stage: 'coci-json-parse',
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  const jsonlRecords = parseJsonlRecords(raw, diagnostics);
  if (jsonlRecords.length) return jsonlRecords;

  const firstLine = raw.split(/\r?\n/, 1)[0] || '';
  return parseDelimitedRecords(raw, firstLine.includes('\t') ? '\t' : ',');
}

function parseJsonlRecords(raw = '', diagnostics) {
  const records = [];
  const lines = String(raw || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return records;
  let parsedAny = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) return parsedAny ? records : [];
    try {
      records.push(JSON.parse(line));
      parsedAny = true;
    } catch (error) {
      diagnostics.skippedRecordCount += 1;
      diagnostics.errors.push({
        stage: 'coci-jsonl-parse',
        line: index + 1,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return records;
}

function paperNodeId(doi = '') {
  return `paper:doi:${stableHash(doi, 20)}`;
}

function graphNode(id, type, name, properties = {}) {
  return {
    id,
    type,
    name: compactText(name, 180),
    properties
  };
}

function graphRelationship(sourceId, targetId, type, properties = {}) {
  return {
    id: `edge:${stableHash(`${sourceId}:${type}:${targetId}`)}`,
    sourceId,
    targetId,
    type,
    properties
  };
}

function normalizeEdge(record = {}, metadata = {}, diagnostics, index = 0) {
  const citingDoi = normalizeDoi(getField(record, ['citing', 'citing_doi', 'citingdoi', 'source_doi', 'from']));
  const citedDoi = normalizeDoi(getField(record, ['cited', 'cited_doi', 'citeddoi', 'target_doi', 'to']));
  if (!citingDoi || !citedDoi) {
    diagnostics.missingEndpointCount += 1;
    diagnostics.warnings.push({
      code: 'missing_citation_endpoint',
      row: finiteNumber(record.sourceRow) || index + 1,
      citing: compactText(getField(record, ['citing', 'citing_doi', 'citingdoi']), 240),
      cited: compactText(getField(record, ['cited', 'cited_doi', 'citeddoi']), 240),
      message: 'COCI/OpenCitations row is missing a DOI-normalizable citing or cited endpoint.'
    });
    return null;
  }

  const oci = normalizeOci(getField(record, ['oci', 'id', 'citation_id', 'citationid']));
  const row = finiteNumber(record.sourceRow) || index + 1;
  const creationDate = compactText(stripIndexPrefix(getField(record, ['creation', 'creation_date', 'creationdate', 'date'])), 80);
  const timespan = compactText(stripIndexPrefix(getField(record, ['timespan', 'time_span', 'timespan_duration'])), 80);
  const journalSelfCitation = normalizeSelfCitation(getField(record, ['journal_sc', 'journal_self_citation', 'journalsc']));
  const authorSelfCitation = normalizeSelfCitation(getField(record, ['author_sc', 'author_self_citation', 'authorsc']));
  const sourceKey = metadata.sourceKey || metadata.source_key || 'coci-local-dump';
  const licenseScope = metadata.licenseScope || metadata.license_scope || 'opencitations-open-citation-data';
  const id = `coci-citation:${stableHash(`${citingDoi}->${citedDoi}:${oci || row}`)}`;

  return {
    id,
    oci: oci || null,
    ociValues: oci ? [oci] : [],
    citingDoi,
    citedDoi,
    citing: {
      id: paperNodeId(citingDoi),
      identifiers: { doi: citingDoi }
    },
    cited: {
      id: paperNodeId(citedDoi),
      identifiers: { doi: citedDoi }
    },
    creationDate: creationDate || null,
    timespan: timespan || null,
    journalSelfCitation,
    authorSelfCitation,
    provenance: {
      sourceProvider: 'opencitations-coci',
      sourceKey,
      sourcePath: metadata.sourcePath || metadata.source_path || '',
      sourceRow: row,
      sourceRows: [row],
      licenseScope,
      rawOci: compactText(getField(record, ['oci', 'id', 'citation_id', 'citationid']), 240) || null
    },
    graphEdgeHint: {
      sourceId: paperNodeId(citingDoi),
      targetId: paperNodeId(citedDoi),
      type: EDGE_TYPES.CITES
    }
  };
}

function mergeEdges(previous, next) {
  return {
    ...previous,
    oci: previous.oci || next.oci,
    ociValues: unique([...asArray(previous.ociValues), ...asArray(next.ociValues)].filter(Boolean)),
    creationDate: previous.creationDate || next.creationDate,
    timespan: previous.timespan || next.timespan,
    journalSelfCitation: previous.journalSelfCitation ?? next.journalSelfCitation,
    authorSelfCitation: previous.authorSelfCitation ?? next.authorSelfCitation,
    provenance: {
      ...previous.provenance,
      sourceRows: unique([...asArray(previous.provenance?.sourceRows), ...asArray(next.provenance?.sourceRows)].filter(Boolean))
    }
  };
}

function buildGraphProjection(edges = [], metadata = {}) {
  const nodes = [];
  const relationships = [];
  const licenseScope = metadata.licenseScope || metadata.license_scope || 'opencitations-open-citation-data';

  for (const edge of edges) {
    nodes.push(graphNode(edge.citing.id, NODE_TYPES.PAPER, `doi:${edge.citingDoi}`, {
      identifiers: edge.citing.identifiers,
      doi: edge.citingDoi,
      placeholder: true,
      sourceProvider: 'opencitations-coci',
      licenseScope
    }));
    nodes.push(graphNode(edge.cited.id, NODE_TYPES.PAPER, `doi:${edge.citedDoi}`, {
      identifiers: edge.cited.identifiers,
      doi: edge.citedDoi,
      placeholder: true,
      sourceProvider: 'opencitations-coci',
      licenseScope
    }));
    relationships.push(graphRelationship(edge.citing.id, edge.cited.id, EDGE_TYPES.CITES, {
      cociCitationId: edge.id,
      oci: edge.oci,
      ociValues: edge.ociValues,
      citingDoi: edge.citingDoi,
      citedDoi: edge.citedDoi,
      creationDate: edge.creationDate,
      timespan: edge.timespan,
      journalSelfCitation: edge.journalSelfCitation,
      authorSelfCitation: edge.authorSelfCitation,
      sourceProvider: edge.provenance.sourceProvider,
      sourceKey: edge.provenance.sourceKey,
      licenseScope
    }));
  }

  const dedupedRelationships = [...new Map(relationships.map((relationship) => [relationship.id, relationship])).values()];
  return {
    nodes: [...new Map(nodes.map((node) => [node.id, node])).values()],
    relationships: dedupedRelationships,
    edges: dedupedRelationships
  };
}

export function parseCociCitationGraph(input, metadata = {}) {
  const diagnostics = {
    contractVersion: COCI_CITATION_GRAPH_CONTRACT_VERSION,
    errors: [],
    warnings: [],
    inputRecordCount: 0,
    edgeCount: 0,
    duplicateEdgeCount: 0,
    missingEndpointCount: 0,
    skippedRecordCount: 0
  };
  const records = normalizeInputRecords(input, diagnostics, metadata).map(asObject).filter((record) => Object.keys(record).length);
  const maxRecords = finiteNumber(metadata.maxRecords || metadata.max_records);
  const selectedRecords = maxRecords !== null ? records.slice(0, Math.max(0, maxRecords)) : records;
  const edgesByPair = new Map();

  for (let index = 0; index < selectedRecords.length; index += 1) {
    const edge = normalizeEdge(selectedRecords[index], metadata, diagnostics, index);
    if (!edge) continue;
    const key = `${edge.citingDoi}->${edge.citedDoi}`;
    const previous = edgesByPair.get(key);
    if (previous) {
      diagnostics.duplicateEdgeCount += 1;
      edgesByPair.set(key, mergeEdges(previous, edge));
    } else {
      edgesByPair.set(key, edge);
    }
  }

  const citationEdges = [...edgesByPair.values()].sort((left, right) => (
    left.citingDoi.localeCompare(right.citingDoi)
    || left.citedDoi.localeCompare(right.citedDoi)
    || left.id.localeCompare(right.id)
  ));
  diagnostics.inputRecordCount = selectedRecords.length;
  diagnostics.edgeCount = citationEdges.length;
  if (!selectedRecords.length) diagnostics.warnings.push({ code: 'no_coci_records', message: 'No COCI/OpenCitations rows were found.' });
  if (!citationEdges.length) diagnostics.warnings.push({ code: 'no_citation_edges', message: 'No DOI-to-DOI citation edges were produced.' });

  const licenseScope = metadata.licenseScope || metadata.license_scope || 'opencitations-open-citation-data';
  return {
    contractVersion: COCI_CITATION_GRAPH_CONTRACT_VERSION,
    source: {
      sourceProvider: 'opencitations-coci',
      sourceKey: metadata.sourceKey || metadata.source_key || 'coci-local-dump',
      sourcePath: metadata.sourcePath || metadata.source_path || '',
      format: metadata.format || metadata.sourceFormat || metadata.source_format || 'coci-csv-tsv-json-jsonl',
      licenseScope
    },
    citationEdges,
    graphProjection: buildGraphProjection(citationEdges, { ...metadata, licenseScope }),
    diagnostics
  };
}

export async function readCociCitationGraph(cociPath, metadata = {}) {
  const raw = await readText(cociPath);
  const lower = String(cociPath || '').toLowerCase();
  const sourceFormat = metadata.sourceFormat || metadata.source_format
    || (lower.endsWith('.jsonl') ? 'coci-jsonl'
      : lower.endsWith('.json') ? 'coci-json'
        : lower.endsWith('.tsv') ? 'coci-tsv'
          : 'coci-csv');
  return parseCociCitationGraph(raw, {
    ...metadata,
    sourcePath: metadata.sourcePath || metadata.source_path || cociPath,
    sourceFormat
  });
}

export async function writeCociCitationGraph(outputPath, cociPath, metadata = {}) {
  const payload = await readCociCitationGraph(cociPath, metadata);
  await writeJson(outputPath, payload);
  return payload;
}
