import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditSnapshot, applyReviewedCase, auditDirectory } from '../scripts/audit-extraction-quality.mjs';
import { qualifyPaperRelation, assessResearchRelation } from '../src/core/graph/relation-admission.js';
import { normalizeAbstractMechanismRecords } from '../src/core/graph/abstract-mechanisms.js';
import { normalizeEvidenceSnippetRecord } from '../src/core/graph/takeaways.js';
import { dedupeResearchRecords } from '../src/core/graph/research-provenance.js';
import { applySemanticAdmissionPolicy } from '../src/core/ingestion/pipeline.js';

const { cases } = JSON.parse(await fs.readFile(new URL('./fixtures/extraction-quality-reviewed-cases.json', import.meta.url), 'utf8'));

function caseSnapshot(review) {
  if (review.action === 'qualify-relation') return { llmSemanticObjects: { findings: [] }, llmRelations:
    Array.from({ length: review.index + 1 }, (_, index) => index === review.index
      ? { sourceName: review.expectedSource, targetName: review.expectedTarget, type: 'USES_COMPONENT_METHOD' } : {}) };
  const records = Array.from({ length: review.index + 1 }, (_, index) => ({ name:
    index === review.index ? review.expectedName : `Unchanged object ${index}` }));
  return { llmSemanticObjects: { [review.field]: records }, [review.field]: structuredClone(records) };
}

test('reviewed scientific corrections preserve meaning and do not mutate the input', () => {
  for (const review of cases.filter(entry => ['replace', 'qualify-relation'].includes(entry.action))) {
    const original = caseSnapshot(review);
    const before = JSON.stringify(original);
    const { snapshot, difference } = applyReviewedCase(original, review);
    assert.equal(JSON.stringify(original), before);
    assert.equal(difference.id, review.id);
    if (review.id === 'Q1') assert.equal(qualifyPaperRelation('ASSUMES', snapshot.assumptions[review.index]).type, 'CONTAINS');
    if (review.id === 'Q2') {
      assert.equal(assessResearchRelation(snapshot.llmRelations[review.index]).admitted, false);
      assert.equal(snapshot.findings[0].experimentContext.value, 65.2);
      assert.match(snapshot.findings[0].experimentContext.baseline, /66\.5/);
    }
    if (review.id === 'Q3') {
      const corrected = snapshot.findings.slice(review.index);
      assert.equal(corrected.length, 2);
      assert.notEqual(corrected[0].experimentContext.baseline, corrected[1].experimentContext.baseline);
    }
    if (review.id === 'Q4') {
      assert.equal(snapshot.findings[review.index].epistemicStatus, 'hypothesis');
      assert.match(snapshot.findings[review.index].name, /may explain/);
    }
    if (review.action === 'replace') {
      original.llmSemanticObjects[review.field][review.index].name = 'Different extraction';
      assert.throws(() => applyReviewedCase(original, review), /does not match/);
    }
  }
});

test('duplicate consolidation keeps quotes and separates incompatible scientific contexts', () => {
  const name = 'Measured accuracy under the evaluation protocol';
  const a = { name, evidenceText: 'The first supporting passage.', sourceChunkIds: ['c1'] };
  const b = { name, evidenceText: 'The second supporting passage.', sourceChunkIds: ['c2'] };
  const [record] = dedupeResearchRecords([a, b]);
  assert.deepEqual(record.sourceChunkIds, ['c1', 'c2']);
  assert.equal(record.supportingSnippets.length, 2);
  const paper = { evidences: [a, b] };
  applySemanticAdmissionPolicy(paper);
  assert.equal(paper.evidences.length, 1);
  assert.equal(paper.evidences[0].supportingSnippets.length, 2);
  assert.equal(dedupeResearchRecords([{ ...a, relationContext: 'method' }, { ...a, relationContext: 'ablation' }]).length, 2);
  const mechanisms = normalizeAbstractMechanismRecords([
    { name: 'random projection', attribution: { subject: 'Model A', role: 'proposed' } },
    { name: 'random projection', attribution: { subject: 'Model B', role: 'baseline' } }
  ]);
  assert.equal(mechanisms.length, 2);
  const quote = 'A supporting passage. '.repeat(30) + 'This remains uncertain.';
  assert.equal(normalizeEvidenceSnippetRecord({ text: quote }).text, quote);
  assert.equal(normalizeEvidenceSnippetRecord({ name: 'A summary, with no source quote' }), null);
});

test('offline audit reports empty and incomplete artifacts and writes only reviewed copies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-quality-replay-'));
  try {
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    await fs.mkdir(input);
    const review = cases.find(entry => entry.id === 'Q1');
    const file = path.join(input, `${review.key}.snapshot.json`);
    const text = JSON.stringify(caseSnapshot(review));
    await fs.writeFile(file, text);
    const report = await auditDirectory(input, output, [review]);
    assert.equal(report.summary.reviewedCorrections, 1);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.ok(await fs.readFile(path.join(output, 'corrected', `${review.key}.snapshot.json`), 'utf8'));
    const empty = auditSnapshot({ llmSemanticObjects: { attempted: true, participated: false, reason: 'empty-semantic-result' } });
    assert.equal(empty.artifactState, 'empty_result');
    assert.ok(empty.issues.includes('empty-semantic-result'));
    const partial = auditSnapshot({ llmSemanticObjects: { attempted: true, participated: true,
      researchQuestions: [{ name: 'Question' }, { name: 'Question' }] },
    llm: { chunkPipeline: { enabled: true, selectedChunkCount: 12, processedChunkCount: 8 } } });
    assert.equal(partial.complete, false);
    assert.equal(partial.provenance.researchQuestions.missingQuote, 2);
    assert.equal(partial.duplicates.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
