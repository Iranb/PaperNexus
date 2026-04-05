import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAuthoritativeSyncQueueOnce } from '../src/core/authoritative-sync/worker.js';
import { applyGraphDeltaPayload, buildGraphDeltaPayload } from '../src/core/graph/delta-commit.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { deriveDomainTaxonomyFromGraph } from '../src/core/graph/domain-taxonomy.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { postIngestionRefinement } from '../src/core/ingestion/graph-precompute.js';
import { fastCommitCorpus } from '../src/core/ingestion/pipeline.js';
import { slugify, stableHash } from '../src/lib/utils.js';
import {
  getCorpusPaths,
  loadCorpus,
  saveCorpus,
  saveSemanticPaperSnapshot,
  saveSourceManifest
} from '../src/storage/corpus-store.js';

function buildCorpusId(name, rootPath) {
  return `corpus:${slugify(name)}:${stableHash(rootPath)}`;
}

function createSemanticPaper({
  paperId,
  paperTitle,
  sourceKey,
  sourcePath,
  domain,
  problemName = null,
  methodName = null,
  mechanismName
}) {
  const mechanismRecord = {
    name: mechanismName,
    mechanismType: 'control-policy',
    mechanismCategory: 'adaptive-control',
    description: `${mechanismName} mechanism`
  };

  return {
    paperId,
    paperTitle,
    sourceKey,
    sourcePath,
    sourceMarkdownPath: sourcePath,
    sourcePdfPath: null,
    sourceKind: 'markdown',
    sourceFingerprint: `fp:${paperId}:${mechanismName}`,
    authors: ['Researcher Example'],
    abstract: `${paperTitle} studies ${mechanismName} in ${domain}.`,
    fieldOfStudy: domain,
    fieldCandidates: [domain],
    domainTags: [domain],
    abstractMechanismObjects: [mechanismRecord],
    problems: problemName
      ? [
          {
            name: problemName,
            text: problemName,
            evidenceText: `${paperTitle} studies ${problemName}.`,
            fieldOfStudy: domain,
            fieldCandidates: [domain],
            domainTags: [domain],
            abstractMechanismObjects: [mechanismRecord],
            confidence: 0.81
          }
        ]
      : [],
    methods: methodName
      ? [
          {
            name: methodName,
            text: methodName,
            evidenceText: `${paperTitle} uses ${methodName}.`,
            fieldOfStudy: domain,
            fieldCandidates: [domain],
            domainTags: [domain],
            abstractMechanismObjects: [mechanismRecord],
            confidence: 0.84
          }
        ]
      : [],
    datasets: [],
    benchmarks: [],
    metrics: [],
    claims: [],
    findings: [],
    researchGoals: [],
    limitations: [],
    assumptions: [],
    evidences: [],
    futureDirections: [],
    llmRelations: []
  };
}

test('fastCommitCorpus incrementally refreshes derived graph layers and persisted domain distance metadata', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-incremental-derived-'));
  const corpusName = 'incremental-derived-test';
  const corpusId = buildCorpusId(corpusName, tempRoot);
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    const eduPath = path.join(tempRoot, 'education.md');
    const psychPath = path.join(tempRoot, 'psychology.md');
    await fs.writeFile(eduPath, '# Education paper\n', 'utf8');
    await fs.writeFile(psychPath, '# Psychology paper\n', 'utf8');

    const eduPaper = createSemanticPaper({
      paperId: 'paper:edu',
      paperTitle: 'Reducing Confirmation Bias in Tutoring',
      sourceKey: 'source:edu',
      sourcePath: eduPath,
      domain: 'Education',
      problemName: 'confirmation bias in tutoring feedback',
      mechanismName: 'reflective evidence gating'
    });
    const psychPaper = createSemanticPaper({
      paperId: 'paper:psych',
      paperTitle: 'Reflective Prompt Transfer for Belief Updating',
      sourceKey: 'source:psych',
      sourcePath: psychPath,
      domain: 'Psychology',
      methodName: 'belief-update prompt controller',
      mechanismName: 'reflective evidence gating'
    });

    const committedGraph = createKnowledgeGraph();
    committedGraph.addNode({
      id: corpusId,
      type: NODE_TYPES.CORPUS,
      name: corpusName,
      properties: {
        layer: 'CorpusLayer',
        rootPath: tempRoot
      }
    });

    const initialDelta = await buildGraphDeltaPayload({
      corpusName,
      rootPath: tempRoot,
      committedGraph,
      semanticPapers: [eduPaper, psychPaper]
    });
    const initialGraph = applyGraphDeltaPayload(committedGraph, initialDelta);
    postIngestionRefinement(initialGraph);

    assert.ok(
      initialGraph.relationships.some((relationship) => (
        relationship.type === EDGE_TYPES.TRANSFERABLE_TO
          && relationship.properties?.relationSource === 'idea-catalyst-transfer-enrichment'
      ))
    );

    const initialMeta = {
      name: corpusName,
      rootPath: tempRoot,
      indexedAt: new Date().toISOString(),
      paperCount: 2,
      sourceCount: 2,
      nodeCount: initialGraph.nodeCount,
      relationshipCount: initialGraph.relationshipCount,
      domainDistanceMatrix: deriveDomainTaxonomyFromGraph(initialGraph)
    };
    const initialManifest = {
      corpusName,
      rootPath: tempRoot,
      inputPath: tempRoot,
      inputPaths: [tempRoot],
      sourceMode: 'markdown',
      indexedAt: initialMeta.indexedAt,
      sources: [
        {
          sourceKey: eduPaper.sourceKey,
          paperId: eduPaper.paperId,
          paperTitle: eduPaper.paperTitle,
          sourcePath: eduPaper.sourcePath,
          sourceMarkdownPath: eduPaper.sourceMarkdownPath,
          kind: 'markdown',
          fingerprint: eduPaper.sourceFingerprint,
          activeInGraph: true
        },
        {
          sourceKey: psychPaper.sourceKey,
          paperId: psychPaper.paperId,
          paperTitle: psychPaper.paperTitle,
          sourcePath: psychPaper.sourcePath,
          sourceMarkdownPath: psychPaper.sourceMarkdownPath,
          kind: 'markdown',
          fingerprint: psychPaper.sourceFingerprint,
          activeInGraph: true
        }
      ]
    };

    await saveCorpus(tempRoot, initialGraph, initialMeta, {
      liteViewMode: 'incremental',
      liteViewSources: initialManifest.sources
    });
    await saveSourceManifest(tempRoot, initialManifest);
    await saveSemanticPaperSnapshot(tempRoot, eduPaper.sourceKey, eduPaper);
    await saveSemanticPaperSnapshot(tempRoot, psychPaper.sourceKey, psychPaper);

    const updatedPsychPaper = createSemanticPaper({
      paperId: psychPaper.paperId,
      paperTitle: psychPaper.paperTitle,
      sourceKey: psychPaper.sourceKey,
      sourcePath: psychPaper.sourcePath,
      domain: 'Psychology',
      methodName: 'belief-update prompt controller',
      mechanismName: 'memory rehearsal routing'
    });
    await saveSemanticPaperSnapshot(tempRoot, updatedPsychPaper.sourceKey, updatedPsychPaper);

    const result = await fastCommitCorpus(tempRoot, {
      changedSourceKeys: [updatedPsychPaper.sourceKey]
    });

    const paths = getCorpusPaths(tempRoot);
    const litePayload = JSON.parse(await fs.readFile(paths.liteGraphPath, 'utf8'));

    assert.ok(result.meta.domainDistanceMatrix?.domains?.includes('Education'));
    assert.ok(result.meta.domainDistanceMatrix?.domains?.includes('Psychology'));
    assert.deepEqual(litePayload.derived?.domainDistanceMatrix, result.meta.domainDistanceMatrix);
    assert.ok(
      litePayload.nodes.some((node) => node.type === NODE_TYPES.ABSTRACT_MECHANISM && node.name === 'memory rehearsal routing')
    );
    assert.ok(
      litePayload.nodes.some((node) => (
        node.type === NODE_TYPES.ABSTRACT_MECHANISM
          && node.name === 'reflective evidence gating'
          && Number(node.properties?.supportingNodeCount || 0) === 1
      ))
    );
    assert.equal(
      litePayload.relationships.filter((relationship) => (
        relationship.type === EDGE_TYPES.TRANSFERABLE_TO
          && relationship.properties?.relationSource === 'idea-catalyst-transfer-enrichment'
      )).length,
      0
    );

    const sync = await runAuthoritativeSyncQueueOnce(tempRoot);
    const syncedCorpus = await loadCorpus(tempRoot);

    assert.equal(sync.failed, false);
    assert.ok(syncedCorpus.meta.domainDistanceMatrix?.domains?.includes('Education'));
    assert.ok(
      syncedCorpus.graph.getNodesByType(NODE_TYPES.ABSTRACT_MECHANISM)
        .some((node) => node.name === 'memory rehearsal routing')
    );
    assert.equal(
      syncedCorpus.graph.relationships.filter((relationship) => (
        relationship.type === EDGE_TYPES.TRANSFERABLE_TO
          && relationship.properties?.relationSource === 'idea-catalyst-transfer-enrichment'
      )).length,
      0
    );
  } finally {
    if (previousBackend === undefined) {
      delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    } else {
      process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
