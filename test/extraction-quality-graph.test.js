import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const experiment = { dataset: 'ImageNet-R', taskSplit: '10 tasks', backbone: 'ViT-B/16',
  pretraining: 'ImageNet-21K', memoryBudget: '0 exemplars', metric: 'accuracy', value: 77.9,
  unit: '%', baseline: 'Prototype classifier', sourceLocation: 'Table 1' };
const objects = {
  methods: ['Proposed method', 'Baseline predictor', 'Random projection'].map(name => ({
    name, evidenceText: `We discuss ${name}.`, attribution: { subject: name,
      role: name === 'Baseline predictor' ? 'baseline' : 'proposed' }
  })),
  assumptions: [{ name: 'Baseline isotropic covariance assumption fails', evidenceText: 'The baseline assumes isotropy, which fails here.',
    attribution: { subject: 'Baseline predictor', role: 'baseline' }, epistemicStatus: 'refuted' }],
  findings: [{ name: 'Possible explanation for small updates', evidenceText: 'This is possibly because small updates suffice.',
    epistemicStatus: 'hypothesis' }, { name: 'Predictor ablation lowers classification accuracy',
    evidenceText: 'Adding a predictor lowered accuracy.', relationContext: 'ablation', epistemicStatus: 'observed' }],
  evidences: [{ name: 'ImageNet-R accuracy under ten tasks', evidenceText: 'ImageNet-R accuracy under ten tasks is 77.9%.', experimentContext: experiment },
    { name: 'ImageNet-R accuracy under twenty tasks', evidenceText: 'ImageNet-R accuracy under twenty tasks is 75.1%.',
      experimentContext: { ...experiment, taskSplit: '20 tasks', value: 75.1 } }],
  researchQuestions: [{ name: 'How can old classes be preserved?', evidenceText: 'We study old-class preservation.',
    sectionHeading: 'Introduction', sourceChunkIds: ['c1'] }],
  openChallenges: [{ name: 'Dependence on frozen features', evidenceText: 'Performance depends on frozen features.',
    sectionHeading: 'Discussion' }],
  abstractMechanismObjects: [{ name: 'random projection', description: 'Project frozen features to a higher dimension.',
    evidenceText: 'We apply random projection to frozen features.', sectionHeading: 'Method' }],
  takeaways: [{ name: 'Preserve uncertainty', text: 'Preserve possible explanations as hypotheses.',
    evidenceText: 'This is possibly because small updates suffice.', epistemicStatus: 'hypothesis' }]
};
const relations = [
  { sourceName: 'Proposed method', targetName: 'Baseline predictor', relationContext: 'ablation', epistemicStatus: 'observed' },
  { sourceName: 'Proposed method', targetName: 'Random projection', relationContext: 'method', epistemicStatus: 'asserted' }
].map(record => ({ sourceType: 'Method', targetType: 'Method', type: 'USES_COMPONENT_METHOD',
  evidenceText: 'We compare the predictor ablation with the adopted random projection.', ...record }));

test('model evidence and qualifications survive saved snapshots and graph admission', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-quality-graph-'));
  const root = path.join(workspace, 'corpus');
  const previous = { home: process.env.PAPERNEXUS_HOME, backend: process.env.PAPERNEXUS_GRAPH_BACKEND, fetch: globalThis.fetch };
  try {
    process.env.PAPERNEXUS_HOME = path.join(workspace, 'home');
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'paper.md'), '# Provenance and Research Conditions\n\n## Abstract\n\nWe study old-class preservation.\n\n## Method\n\nWe apply random projection to frozen features.\n\n## Results\n\nAdding a predictor lowered accuracy. This is possibly because small updates suffice.\n');
    globalThis.fetch = async (url, init = {}) => {
      if (!String(url).startsWith('https://extraction.test/')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      const prompt = JSON.parse(init.body).messages.map(message => message.content).join('\n');
      const papers = JSON.parse(prompt.slice(prompt.lastIndexOf('Papers:\n') + 'Papers:\n'.length));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ papers:
        papers.map(paper => ({ id: paper.id, ...objects, relations })) }) } }] }) };
    };
    const [{ analyzeCorpus }, store] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'), import('../src/storage/corpus-store.js')
    ]);
    const result = await analyzeCorpus(root, { name: 'quality-graph', force: true, quiet: true,
      semanticExtraction: 'llm-primary', llmProvider: 'openai', llmModel: 'fixture-model',
      llmBaseUrl: 'https://extraction.test/v1', llmApiKey: 'fixture-key', llmRelations: true,
      llmExtractionStrategy: 'long-context-first', llmContextWindowTokens: 1000000,
      llmBatchFailureSplitRetryCount: 0 });
    const manifest = await store.loadSourceManifest(root);
    const snapshot = await store.loadSemanticPaperSnapshot(root, manifest.sources[0].sourceKey);
    assert.equal(snapshot.llmRelations.length, 2);
    assert.equal(snapshot.llmRelations.find(edge => edge.relationContext === 'ablation').graphAdmission.reason, 'relation-context-ablation');
    assert.deepEqual(snapshot.evidences.find(entry => entry.experimentContext?.taskSplit === '10 tasks').experimentContext, experiment);
    assert.equal(snapshot.researchQuestions[0].evidenceText, objects.researchQuestions[0].evidenceText);
    const nodes = result.graph.nodes;
    const edges = result.graph.relationships;
    const node = (type, name) => nodes.find(entry => entry.type === type && entry.name === name);
    const assumption = node('Assumption', 'Baseline isotropic covariance assumption fails');
    assert.ok(assumption);
    assert.ok(!edges.some(edge => edge.targetId === assumption.id && edge.type === 'ASSUMES'));
    const mention = edges.find(edge => edge.targetId === assumption.id && edge.type === 'CONTAINS' && edge.properties?.sourcePaperId);
    assert.equal(mention.properties.attribution.subject, 'Baseline predictor');
    assert.equal(mention.properties.epistemicStatus, 'refuted');
    assert.ok(!edges.some(edge => edge.targetId === node('Method', 'Baseline predictor').id && edge.type === 'USES'));
    const adoption = edges.filter(edge => edge.type === 'USES_COMPONENT_METHOD');
    assert.equal(adoption.length, 1);
    assert.equal(adoption[0].targetId, node('Method', 'Random projection').id);
    assert.equal(adoption[0].properties.relationContext, 'method');
    assert.equal(node('Finding', 'Possible explanation for small updates').properties.epistemicStatus, 'hypothesis');
    assert.ok(node('Finding', 'Predictor ablation lowers classification accuracy'));
    assert.deepEqual(node('Evidence', 'ImageNet-R accuracy under ten tasks').properties.experimentContext, experiment);
    for (const [type, name, quote] of [
      ['ResearchQuestion', objects.researchQuestions[0].name, objects.researchQuestions[0].evidenceText],
      ['Challenge', objects.openChallenges[0].name, objects.openChallenges[0].evidenceText],
      ['Takeaway', objects.takeaways[0].name, objects.takeaways[0].evidenceText]
    ]) {
      const target = node(type, name);
      assert.ok(target, `${type}: ${name}`);
      assert.ok(edges.some(edge => edge.targetId === target.id && edge.properties?.evidenceText === quote));
    }
    const paper = nodes.find(entry => entry.type === 'Paper');
    assert.equal(paper.properties.abstractMechanismObjects[0].evidenceText, objects.abstractMechanismObjects[0].evidenceText);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.home === undefined) delete process.env.PAPERNEXUS_HOME; else process.env.PAPERNEXUS_HOME = previous.home;
    if (previous.backend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND; else process.env.PAPERNEXUS_GRAPH_BACKEND = previous.backend;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
