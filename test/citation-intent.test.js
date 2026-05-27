import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildCitationIntentArtifact,
  CITATION_INTENTS_CONTRACT_VERSION,
  evaluateCitationIntentPredictions,
  normalizeCitationIntentLabel
} from '../src/core/ingestion/citation-intent.js';

const execFileAsync = promisify(execFile);

function citationContexts() {
  return {
    contractVersion: 'papernexus-citation-contexts-v1',
    paper: {
      paperId: 'paper:citation-intents',
      paperTitle: 'Citation Intent Grounding'
    },
    contexts: [
      {
        id: 'ctx:method',
        paperId: 'paper:citation-intents',
        sectionRole: 'method',
        referenceId: 'ref:dpr',
        referenceTitleGuess: 'Dense Passage Retrieval',
        citationRaw: 'Karpukhin et al., 2020',
        exactQuote: 'Our reranker extends dense passage retrieval while retaining BM25 as a component.',
        extractionStatus: 'reference-resolved'
      },
      {
        id: 'ctx:baseline',
        paperId: 'paper:citation-intents',
        sectionRole: 'evaluation',
        referenceId: 'ref:bm25',
        referenceTitleGuess: 'Okapi BM25',
        citationRaw: 'Robertson et al., 1995',
        exactQuote: 'We compare against BM25 and DPR baselines on the retrieval benchmark.',
        extractionStatus: 'reference-resolved'
      },
      {
        id: 'ctx:contrast',
        paperId: 'paper:citation-intents',
        sectionRole: 'discussion',
        referenceId: 'ref:retro',
        referenceTitleGuess: 'Retrieval-Enhanced Transformers',
        citationRaw: 'Borgeaud et al., 2022',
        exactQuote: 'Unlike prior retrieval systems, RETRO fails to address multilingual retrieval gaps.',
        extractionStatus: 'reference-resolved'
      },
      {
        id: 'ctx:dataset',
        paperId: 'paper:citation-intents',
        sectionRole: 'evaluation',
        referenceId: 'ref:beir',
        referenceTitleGuess: 'BEIR: A Heterogeneous Benchmark',
        citationRaw: 'Thakur et al., 2021',
        exactQuote: 'We evaluate on the BEIR benchmark suite and report nDCG@10.',
        extractionStatus: 'reference-resolved'
      }
    ]
  };
}

test('citation-intent classifier emits graph-ready intents from citation contexts', () => {
  const artifact = buildCitationIntentArtifact(citationContexts());

  assert.equal(artifact.contractVersion, CITATION_INTENTS_CONTRACT_VERSION);
  assert.equal(artifact.sourceContractVersion, 'papernexus-citation-contexts-v1');
  assert.equal(artifact.intents.length, 4);
  assert.equal(artifact.diagnostics.contextCount, 4);
  assert.equal(artifact.diagnostics.intentCount, 4);
  assert.equal(artifact.diagnostics.intentCounts['method-use'], 1);
  assert.equal(artifact.diagnostics.intentCounts['baseline-comparison'], 1);
  assert.equal(artifact.diagnostics.intentCounts['limitation-contrast'], 1);
  assert.equal(artifact.diagnostics.intentCounts.dataset, 1);

  const byContext = new Map(artifact.intents.map((entry) => [entry.citationContextId, entry]));
  assert.equal(byContext.get('ctx:method').intent, 'method-use');
  assert.equal(byContext.get('ctx:baseline').intent, 'baseline-comparison');
  assert.equal(byContext.get('ctx:contrast').intent, 'limitation-contrast');
  assert.equal(byContext.get('ctx:dataset').intent, 'dataset');
  assert.ok(byContext.get('ctx:baseline').confidence > byContext.get('ctx:method').confidence);
  assert.ok(byContext.get('ctx:method').graphEdgeType);
  assert.match(byContext.get('ctx:contrast').matchedPatterns.join(','), /unlike|negative/);
});

test('citation-intent benchmark gate scores flexible gold label formats', () => {
  const artifact = buildCitationIntentArtifact(citationContexts(), {
    gold: {
      'ctx:method': 'method',
      'ctx:baseline': 'baseline',
      'ctx:contrast': 'contrast',
      'ctx:dataset': 'dataset'
    },
    minAccuracy: 1,
    minMacroF1: 1
  });

  assert.equal(artifact.evaluation.status, 'passed');
  assert.equal(artifact.evaluation.evaluated_count, 4);
  assert.equal(artifact.evaluation.accuracy, 1);
  assert.equal(artifact.evaluation.macro_f1, 1);
  assert.equal(normalizeCitationIntentLabel('SciCite-Method'), 'method-use');

  const failed = evaluateCitationIntentPredictions(artifact.intents, [
    { citation_context_id: 'ctx:method', label: 'background' },
    { citation_context_id: 'ctx:baseline', label: 'background' }
  ], {
    minAccuracy: 0.9
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.correct_count, 0);
  assert.ok(failed.threshold_failures.some((entry) => entry.includes('accuracy')));
});

test('citation-intent CLI writes artifacts with benchmark gate metrics', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-citation-intents-'));
  try {
    const contextsPath = path.join(tempRoot, 'contexts.json');
    const goldPath = path.join(tempRoot, 'gold.json');
    const outputPath = path.join(tempRoot, 'citation-intents.json');
    await fs.writeFile(contextsPath, JSON.stringify(citationContexts(), null, 2), 'utf8');
    await fs.writeFile(goldPath, JSON.stringify({
      labels: [
        { citationContextId: 'ctx:method', intent: 'method-use' },
        { citationContextId: 'ctx:baseline', intent: 'baseline-comparison' },
        { citationContextId: 'ctx:contrast', intent: 'limitation-contrast' },
        { citationContextId: 'ctx:dataset', intent: 'dataset' }
      ]
    }, null, 2), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-citation-intents.mjs'),
      '--contexts-path', contextsPath,
      '--output-path', outputPath,
      '--gold-path', goldPath,
      '--min-accuracy', '1',
      '--min-macro-f1', '1'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, CITATION_INTENTS_CONTRACT_VERSION);
    assert.equal(summary.intent_count, 4);
    assert.equal(summary.evaluation_status, 'passed');
    assert.equal(summary.evaluation_accuracy, 1);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.evaluation.status, 'passed');
    assert.equal(payload.intents[0].contractVersion, CITATION_INTENTS_CONTRACT_VERSION);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
