import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLineageCard, LINEAGE_CARD_VERSION } from '../src/core/research/lineage-evidence.js';

const source = { text: 'We extend Parent using a temporal projector. Direct alignment may restrict plasticity. The projector maps current features to old features. Task boundaries are required.' };
const explanation = (text, exactQuote, kind, epistemicStatus = 'asserted') => ({ text, exactQuote,
  kind, epistemicStatus, attribution: kind === 'bottleneck' ? 'Parent alignment' : 'Child', section: 'Method', pdfPage: 4 });
const input = () => ({ paperRole: 'method', setting: 'Unlabelled task sequences', contribution: 'Temporal projection',
  limitations: [], missingEvidence: [], methods: [{ name: 'Child', role: 'method', description: 'Temporal projector',
    exactQuote: 'We extend Parent using a temporal projector.', section: 'Method' }],
  lineageCandidates: [{ childMethod: 'Child', parentMethod: 'Parent', relationType: 'EXTENDS_METHOD',
    mechanism: 'Project current features before alignment', exactQuote: 'We extend Parent using a temporal projector.',
    bottleneck: explanation('Direct alignment may restrict learning', 'Direct alignment may restrict plasticity.', 'bottleneck', 'hypothesis'),
    mechanismEvidence: explanation('Project current features before alignment', 'The projector maps current features to old features.', 'mechanism'),
    tradeoff: explanation('Needs task boundaries', 'Task boundaries are required.', 'tradeoff') }] });

test('lineage explanations preserve separate source passages, ownership and tentative reasoning', () => {
  const edge = validateLineageCard(input(), source).lineageCandidates[0];
  assert.equal(LINEAGE_CARD_VERSION, 'papernexus-lineage-card-v2');
  assert.equal(edge.explanationStatus, 'complete');
  assert.equal(edge.bottleneck.epistemicStatus, 'hypothesis');
  assert.equal(edge.bottleneck.attribution, 'Parent alignment');
  assert.notEqual(edge.bottleneck.exactQuote, edge.mechanismEvidence.exactQuote);
  assert.equal(edge.reviewStatus, 'pending');
});

test('missing motivation remains unknown without suppressing an explicitly cited relation', () => {
  const raw = input(); raw.lineageCandidates[0].bottleneck = null;
  const edge = validateLineageCard(raw, source).lineageCandidates[0];
  assert.equal(edge.bottleneck, null);
  assert.equal(edge.quoteFound, true);
  assert.deepEqual(edge.explanationIssues, ['missing_bottleneck']);
});

test('duplicated explanations and unsupported passages do not pass as complete evidence', () => {
  const raw = input();
  raw.lineageCandidates[0].bottleneck.text = raw.lineageCandidates[0].mechanism;
  raw.lineageCandidates[0].tradeoff.exactQuote = 'No task boundary is required.';
  const edge = validateLineageCard(raw, source).lineageCandidates[0];
  assert.equal(edge.explanationStatus, 'incomplete');
  assert.ok(edge.explanationIssues.includes('bottleneck_repeats_mechanism'));
  assert.ok(edge.explanationIssues.includes('unmatched_tradeoff_quote'));
  assert.equal(edge.tradeoff.quoteFound, false);
  assert.equal(edge.quoteFound, true);
});

test('component adoption can explain a use without claiming that its component is defective', () => {
  const raw = input(); raw.lineageCandidates[0].relationType = 'USES_COMPONENT_METHOD';
  raw.lineageCandidates[0].bottleneck = explanation('Retain old features', 'The projector maps current features to old features.', 'adoption_reason');
  const edge = validateLineageCard(raw, source).lineageCandidates[0];
  assert.equal(edge.bottleneck.kind, 'adoption_reason');
  assert.equal(edge.explanationStatus, 'complete');
});
