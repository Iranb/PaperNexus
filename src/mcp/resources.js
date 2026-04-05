import { NODE_TYPES } from '../core/graph/schema.js';
import { deriveDomainTaxonomyFromGraph, normalizeFieldOfStudy } from '../core/graph/domain-taxonomy.js';
import { listNodesByType } from '../core/search/search.js';
import { loadCorpusLite, resolveCorpus } from '../storage/corpus-store.js';
import { loadRegistry } from '../storage/registry.js';
import { renderCorpusList, renderNodeList, renderStatus } from '../lib/render.js';

const RESOURCE_NODE_VIEWS = {
  problems: { label: 'Problems', type: NODE_TYPES.PROBLEM },
  claims: { label: 'Claims', type: NODE_TYPES.CLAIM },
  findings: { label: 'Findings', type: NODE_TYPES.FINDING },
  methods: { label: 'Methods', type: NODE_TYPES.METHOD },
  benchmarks: { label: 'Benchmarks', type: NODE_TYPES.BENCHMARK },
  limitations: { label: 'Limitations', type: NODE_TYPES.LIMITATION },
  assumptions: { label: 'Assumptions', type: NODE_TYPES.ASSUMPTION },
  futures: { label: 'Future directions', type: NODE_TYPES.FUTURE_DIRECTION }
};

export async function listResources() {
  const registry = await loadRegistry();
  const resources = [
    {
      uri: 'papernexus://corpora',
      name: 'Indexed corpora',
      mimeType: 'text/markdown'
    }
  ];

  for (const corpus of registry.corpora) {
    resources.push({
      uri: `papernexus://corpus/${encodeURIComponent(corpus.name)}/context`,
      name: `${corpus.name} context`,
      mimeType: 'text/markdown'
    });
    resources.push({
      uri: `papernexus://corpus/${encodeURIComponent(corpus.name)}/domain-taxonomy`,
      name: `${corpus.name} domain taxonomy`,
      mimeType: 'application/json'
    });
    for (const [view, config] of Object.entries(RESOURCE_NODE_VIEWS)) {
      resources.push({
        uri: `papernexus://corpus/${encodeURIComponent(corpus.name)}/${view}`,
        name: `${corpus.name} ${config.label.toLowerCase()}`,
        mimeType: 'text/markdown'
      });
    }
  }

  return resources;
}

export async function readResourcePayload(uri) {
  if (uri === 'papernexus://corpora') {
    const registry = await loadRegistry();
    return {
      mimeType: 'text/markdown',
      text: renderCorpusList(registry.corpora)
    };
  }

  const match = uri.match(/^papernexus:\/\/corpus\/([^/]+)\/(context|domain-taxonomy|problems|claims|findings|methods|benchmarks|limitations|assumptions|futures)$/);
  if (!match) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }

  const corpusName = decodeURIComponent(match[1]);
  const view = match[2];
  const rootPath = await resolveCorpus(corpusName);
  const { meta, graph } = await loadCorpusLite(rootPath);

  if (view === 'context') {
    return {
      mimeType: 'text/markdown',
      text: renderStatus(meta)
    };
  }

  if (view === 'domain-taxonomy') {
    const matrix = deriveDomainTaxonomyFromGraph(graph);
    return {
      mimeType: 'application/json',
      text: JSON.stringify({
        ...matrix,
        corpus: meta.name,
        targetDomain: normalizeFieldOfStudy(meta.topDomains?.[0] || '')
      }, null, 2)
    };
  }

  const config = RESOURCE_NODE_VIEWS[view];
  return {
    mimeType: 'text/markdown',
    text: renderNodeList(config.label, listNodesByType(graph, config.type))
  };
}

export async function readResource(uri) {
  const payload = await readResourcePayload(uri);
  return payload.text;
}
