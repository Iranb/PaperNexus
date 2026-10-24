import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperEnhancementOverlay } from '../src/core/enhancements/extract.js';

test('A14 inconclusive paper outcome produces an inferred uncertainty reflection', () => {
  const result = buildPaperEnhancementOverlay({
    semanticPaper: { paperId: 'synthetic:uncertain', paperTitle: 'Uncertain outcome',
      findings: [{ text: 'The available measurements leave the proposed mechanism unresolved.' }] },
    parsedPaper: { sections: [] }
  });
  const reflection = result.overlays.reflection;
  assert.equal(reflection.verdictCounts.inconclusive, 1);
  const card = reflection.cards.find(c => c.kind === 'reflection');
  assert.match(card.text, /inconclusive/);
  assert.doesNotMatch(card.text, /idea is supported/);
  assert.equal(card.explicitOrInferred, 'inferred');
});
