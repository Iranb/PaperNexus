import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChunkSemanticObjectInferenceResult,
  inferPaperSemanticObjects,
  inferPaperSemanticObjectsBatch, inferPaperResearchSemantics, inferPaperResearchSemanticsBatch,
  inferChunkSemanticObjectsBatch, inferChunkResearchSemanticsBatch
} from '../src/core/llm/ollama.js';
import { summarizeSemanticSnapshot } from '../src/core/ingestion/semantic-status.js';
import { normalizeResearchQuestionRecord } from '../src/core/graph/research-questions.js';
import { normalizeChallengeRecord } from '../src/core/graph/challenges.js';
import { normalizeAbstractMechanismRecords } from '../src/core/graph/abstract-mechanisms.js';

const llmOptions = {
  semanticExtraction: 'llm-primary', llmProvider: 'openai', llmModel: 'fixture-model',
  llmBaseUrl: 'https://extraction.test/v1', llmApiKey: 'fixture-key',
  llmBatchFailureSplitRetryCount: 0
};
const parsedPaper = { title: 'Extraction fixture', sections: [
  { heading: 'Method', role: 'method', text: 'We propose a replay classifier.' }
] };

function mockModel(t, output) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] })
  });
  t.after(() => { globalThis.fetch = previous; });
}

test('single-paper extraction does not count taxonomy-only output as research participation', async (t) => {
  mockModel(t, { fieldOfStudy: 'Computer Science', domainTags: ['Computer Science'], methods: [] });
  const result = await inferPaperSemanticObjects(parsedPaper, {}, llmOptions);
  assert.equal(result.attempted, true);
  assert.equal(result.participated, false);
  assert.equal(result.reason, 'empty-semantic-result');
  assert.equal(result.fieldOfStudy, 'Computer Science');
});

test('batch extraction distinguishes an empty paper from a paper with research content', async (t) => {
  mockModel(t, { papers: [
    { id: 'empty', fieldOfStudy: 'Computer Science', abstractMechanisms: ['classification'] },
    { id: 'valid', methods: [{ name: 'Replay classifier', evidenceText: 'We propose a replay classifier.' }] }
  ] });
  const results = await inferPaperSemanticObjectsBatch(['empty', 'valid'].map(id => ({
    id, parsedPaper, semanticPaper: {}
  })), llmOptions);
  assert.equal(results[0].participated, false);
  assert.equal(results[0].reason, 'empty-semantic-result');
  assert.equal(results[1].participated, true);
  assert.equal(results[1].reason, null);
});

test('empty chunk output does not become a successful research result', () => {
  const result = createChunkSemanticObjectInferenceResult({
    provider: 'openai', requestedMode: 'llm-primary', effectiveMode: 'llm-primary',
    attempted: true, participated: true, chunkId: 'chunk-1', fieldOfStudy: 'Computer Science'
  });
  assert.equal(result.participated, false);
  assert.equal(result.reason, 'empty-semantic-result');
});

test('snapshot status ignores stale success flags and metadata counts', () => {
  const result = summarizeSemanticSnapshot({
    llm: { semanticObjectCount: 7, semanticExtractionAttempted: true, semanticExtractionParticipated: true },
    llmSemanticObjects: { participated: true, fieldOfStudy: 'Computer Science', methods: [] },
    llmRelations: []
  });
  assert.equal(result.artifactState, 'empty_result');
  assert.equal(result.semanticObjectCount, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, ['empty-semantic-result']);
});

test('valid zero relations can complete, but partial chunks and provider errors cannot', () => {
  const snapshot = {
    llmSemanticObjects: { attempted: true, participated: true, methods: [{ name: 'Replay classifier' }] },
    llm: { relationConfigSignature: '{"provider":"openai"}' }, llmRelations: []
  };
  assert.equal(summarizeSemanticSnapshot(snapshot, { requireRelations: true }).complete, true);
  const partial = summarizeSemanticSnapshot({ ...snapshot, llm: { ...snapshot.llm,
    chunkPipeline: { enabled: true, selectedChunkCount: 12, processedChunkCount: 8 }
  } });
  assert.equal(partial.participated, true);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.issues, ['semantic-chunks-incomplete']);
  const failed = summarizeSemanticSnapshot({ ...snapshot, llm: { ...snapshot.llm,
    error: '402 Insufficient Balance', relationParticipationReason: 'provider-http-4xx'
  } }, { requireRelations: true });
  assert.equal(failed.artifactState, 'objects_only');
  assert.equal(failed.complete, false);
  assert.deepEqual(failed.issues, ['relations-failed']);
});

test('research evidence, ownership and experiment conditions survive model output normalization', async (t) => {
  const evidenceText = 'The older prototype baseline assumes isotropic covariance. This assumption does not hold for these features.';
  const ownership = { subject: 'Prototype baseline', role: 'baseline' };
  const experimentContext = { dataset: 'ImageNet-R', taskSplit: '10 tasks', metric: 'accuracy',
    value: 77.9, unit: '%', baseline: 'C-Flat', variant: 'scheduler enabled', sourceLocation: 'Table 1' };
  mockModel(t, {
    assumptions: [{ name: 'Baseline isotropic covariance assumption', evidenceText,
      attribution: ownership, epistemicStatus: 'refuted' }],
    findings: [{ name: 'A possible explanation of the update size',
      evidenceText: 'This is possibly because smaller updates suffice.', epistemicStatus: 'hypothesis' }],
    evidences: [{ name: 'Accuracy under ten tasks', evidenceText: 'The accuracy is 77.9%.', experimentContext }],
    researchQuestions: [{ name: 'How can old classes be preserved?', evidenceText: 'We study old-class preservation.',
      sectionHeading: 'Introduction', sourceChunkIds: ['c1'] }],
    openChallenges: [{ name: 'Quality of frozen features', evidenceText: 'Performance depends on the pre-trained features.',
      sectionHeading: 'Discussion' }],
    abstractMechanismObjects: [{ name: 'random projection', description: 'Map frozen features into a higher-dimensional space.',
      evidenceText: 'We apply random projection to the frozen features.', sectionHeading: 'Method' }]
  });
  const result = await inferPaperSemanticObjects(parsedPaper, {}, llmOptions);
  assert.deepEqual(result.assumptions[0].attribution, ownership);
  assert.equal(result.assumptions[0].epistemicStatus, 'refuted');
  assert.equal(result.findings[0].epistemicStatus, 'hypothesis');
  assert.deepEqual(result.evidences[0].experimentContext, experimentContext);
  assert.equal(normalizeResearchQuestionRecord(result.researchQuestions[0]).evidenceText, 'We study old-class preservation.');
  assert.deepEqual(result.researchQuestions[0].sourceChunkIds, ['c1']);
  assert.equal(normalizeChallengeRecord(result.openChallenges[0]).sectionHeading, 'Discussion');
  assert.equal(normalizeAbstractMechanismRecords(result.abstractMechanismObjects)[0].evidenceText,
    'We apply random projection to the frozen features.');
});

test('normalization does not invent quotes, truncate qualifying context or collapse different experiments', async (t) => {
  const quote = `${'We compare both systems under the same protocol. '.repeat(9)}The difference is only a tentative explanation.`;
  mockModel(t, {
    methods: [{ name: 'Unquoted method' }],
    findings: [{ name: 'Qualified observation', evidenceText: quote }],
    researchQuestions: [{ name: 'Old-class preservation' }, { name: 'Old-class preservation' }],
    openChallenges: [{ name: 'Feature dependence' }, { name: 'Feature dependence' }],
    evidences: [
      { name: 'Reported accuracy', experimentContext: { taskSplit: '10 tasks', value: 77.9 } },
      { name: 'Reported accuracy', experimentContext: { taskSplit: '20 tasks', value: 75.1 } }
    ]
  });
  const result = await inferPaperSemanticObjects(parsedPaper, {}, llmOptions);
  assert.equal(result.methods[0].evidenceText, '');
  assert.equal(result.findings[0].evidenceText, quote);
  assert.equal(result.researchQuestions.length, 1);
  assert.equal(result.openChallenges.length, 1);
  assert.equal(result.evidences.length, 2);
});


test('all six extraction entry points retain the evidence contract and full chunk context', async (t) => {
  const previous = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages.map(message => message.content).join('\n');
    prompts.push(prompt);
    const marker = prompt.includes('Chunks:\n') ? 'Chunks:\n' : 'Papers:\n';
    let entries = [];
    if (prompt.includes(marker)) entries = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
    const record = { methods: [{ name: 'Replay classifier' }], relations: [] };
    const output = entries.length ? { [marker.startsWith('Chunks') ? 'chunks' : 'papers']:
      entries.map(entry => ({ id: entry.id, ...record })) } : record;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  const options = { ...llmOptions, llmRelations: true };
  const entries = [{ id: 'p1', parsedPaper, semanticPaper: {} }];
  await inferPaperSemanticObjects(parsedPaper, {}, options);
  await inferPaperSemanticObjectsBatch(entries, options);
  await inferPaperResearchSemantics(parsedPaper, {}, options);
  await inferPaperResearchSemanticsBatch(entries, options);
  const chunks = [{ id: 'c1', chunkId: 'c1', paperId: 'p1', text: 'Method context. '.repeat(120) + 'LATE_QUALIFIER' }];
  await inferChunkSemanticObjectsBatch(chunks, options);
  await inferChunkResearchSemanticsBatch(chunks, options);
  assert.equal(prompts.length, 6);
  for (const prompt of prompts) {
    assert.ok(prompt.includes('epistemicStatus'));
    assert.ok(prompt.includes('experimentContext'));
    assert.ok(prompt.includes('baseline assumption'));
    assert.ok(prompt.includes('verbatim source passage'));
  }
  assert.ok(prompts.slice(-2).every(prompt => prompt.includes('LATE_QUALIFIER')));
  assert.ok([prompts[2], prompts[3], prompts[5]].every(prompt => prompt.includes('whole method -> adopted component')));
});
