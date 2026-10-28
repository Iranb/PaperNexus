import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCorpusPaths } from '../../src/storage/corpus-store.js';
import { readLineageRefinement } from '../../src/core/research/lineage-refinement.js';

export async function refinementFixture(domain = 'learning') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-refine-'));
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir, { recursive: true });
  const names = domain === 'learning' ? ['Calibrated learner', 'Base learner'] : ['Adaptive solver', 'Base solver'];
  const quote = `We extend ${names[1]} with ${names[0]} to update the state.`;
  const parentQuote = `We introduce ${names[1]} for ${domain}.`;
  const source = path.join(root, 'child.md'), parentSource = path.join(root, 'parent.md');
  await fs.writeFile(source, `# ${names[0]}\n${quote}\nThe state update requires memory.\n[1] ${names[1]}.`);
  await fs.writeFile(parentSource, `# ${names[1]}\n${parentQuote}`);
  const graph = { nodes: [
    { id: 'child', type: 'Paper', name: names[0], properties: { year: 2024 } },
    { id: 'parent', type: 'Paper', name: names[1], properties: { year: 2020 } }
  ], relationships: [] };
  const sources = [{ paperId: 'child', sourceKey: source, markdownCachePath: source, activeInGraph: true },
    { paperId: 'parent', sourceKey: parentSource, markdownCachePath: parentSource, activeInGraph: true }];
  await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'fixture', rootPath: root }));
  for (const file of [paths.graphPath, paths.liteGraphPath]) await fs.writeFile(file, JSON.stringify(graph));
  await fs.writeFile(paths.manifestPath, JSON.stringify({ sources }));
  const card = { paperRole: 'method', setting: domain, contribution: 'State update', limitations: [], missingEvidence: [],
    methods: [{ name: names[0], role: 'method', description: 'Update', exactQuote: quote }], lineageCandidates: [{
      childMethod: names[0], parentMethod: names[1], parentPaperTitle: names[1], relationType: 'EXTENDS_METHOD',
      mechanism: 'Update the state', exactQuote: quote }] };
  const review = { methods: [{ methodIndex: 0, decision: 'supported', reason: 'Introduced by this paper.',
    exactQuote: quote, attribution: names[0], epistemicStatus: 'asserted' }], relations: [{ candidateIndex: 0,
    decision: 'supported', reason: 'Explicit extension.', exactQuote: quote, parentMethodQuote: parentQuote,
    context: 'extension', attribution: names[0], epistemicStatus: 'asserted', directionConfirmed: true }] };
  const calls = [];
  const response = value => ({ text: JSON.stringify(value), finishReason: 'stop', usage: {} });
  const options = { llmProvider: 'deepseek', llmModel: 'fixture', llmApiKey: 'fixture', workerRootPaths: [root],
    lineageEvidenceDependencies: { generate: async prompt => { calls.push({ stage: 'extract', prompt }); return response(card); } },
    lineageRefinementDependencies: { generate: async prompt => { calls.push({ stage: prompt.startsWith('Review') ? 'review' : 'plan', prompt }); return response(prompt.startsWith('Review') ? review : { queries: [] }); } } };
  return { root, paths, source, parentSource, sources, graph, names, quote, parentQuote, card, review, options, calls, response };
}

export async function finishRefinement(root, runId) {
  for (let i = 0; i < 200; i++) {
    const state = await readLineageRefinement(root, runId);
    if (state.terminal || state.status === 'waiting') return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture refinement did not settle.');
}
