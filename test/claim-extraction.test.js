import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildClaimExtractionArtifact,
  CLAIM_EXTRACTION_CONTRACT_VERSION,
  evaluateClaimExtraction
} from '../src/core/ingestion/claim-extraction.js';
import { buildCitationIntentArtifact } from '../src/core/ingestion/citation-intent.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';

const execFileAsync = promisify(execFile);

function paperFixture() {
  return {
    paper: {
      paperId: 'paper:hybrid-claims',
      paperTitle: 'Hybrid Retrieval With Claim Grounding',
      sourcePath: '/tmp/hybrid.md'
    },
    sections: [
      {
        id: 'sec:abstract',
        heading: 'Abstract',
        role: 'abstract',
        text: 'We propose a citation-aware hybrid retriever that combines sparse and dense evidence. The system improves recall by 12% over strong retrieval baselines.'
      },
      {
        id: 'sec:method',
        heading: 'Method',
        role: 'method',
        chunks: [{
          id: 'chunk:method',
          text: 'Our framework uses dense passage retrieval (Karpukhin et al., 2020) and aligns retrieved evidence spans with claims.'
        }]
      },
      {
        id: 'sec:results',
        heading: 'Results',
        role: 'evaluation',
        text: 'Experiments on BEIR show that our method outperforms BM25 baselines by 12 points in nDCG@10. However, the model fails on multilingual queries without translated evidence.'
      }
    ]
  };
}

function citationContexts() {
  return {
    contractVersion: 'papernexus-citation-contexts-v1',
    contexts: [{
      id: 'ctx:dpr',
      paperId: 'paper:hybrid-claims',
      sectionId: 'sec:method',
      chunkId: 'chunk:method',
      referenceId: 'ref:dpr',
      referenceTitleGuess: 'Dense Passage Retrieval',
      citationRaw: 'Karpukhin et al., 2020',
      exactQuote: 'Our framework uses dense passage retrieval (Karpukhin et al., 2020) and aligns retrieved evidence spans with claims.',
      extractionStatus: 'reference-resolved'
    }]
  };
}

function goldClaims() {
  return {
    claims: [
      {
        claim_text: 'We propose a citation-aware hybrid retriever that combines sparse and dense evidence.',
        claim_type: 'contribution'
      },
      {
        claim_text: 'Experiments on BEIR show that our method outperforms BM25 baselines by 12 points in nDCG@10.',
        claim_type: 'performance'
      },
      {
        claim_text: 'However, the model fails on multilingual queries without translated evidence.',
        claim_type: 'boundary'
      }
    ]
  };
}

test('claim extraction emits source-span grounded claims and graph projection', () => {
  const citationIntents = buildCitationIntentArtifact(citationContexts());
  const artifact = buildClaimExtractionArtifact(paperFixture(), {
    citationContextsArtifact: citationContexts(),
    citationIntentsArtifact: citationIntents,
    maxClaims: 10
  });

  assert.equal(artifact.contractVersion, CLAIM_EXTRACTION_CONTRACT_VERSION);
  assert.equal(artifact.paper.paperId, 'paper:hybrid-claims');
  assert.ok(artifact.claims.length >= 4);
  assert.equal(artifact.diagnostics.sourceSpanCount >= artifact.claims.length, true);
  assert.equal(artifact.claims.every((claim) => claim.source_span_ids.length > 0), true);

  const methodClaim = artifact.claims.find((claim) => claim.claim_text.includes('dense passage retrieval'));
  assert.ok(methodClaim);
  assert.equal(methodClaim.claim_type, 'method');
  assert.deepEqual(methodClaim.citation_context_ids, ['ctx:dpr']);
  assert.equal(methodClaim.citation_intents.length, 1);
  assert.equal(methodClaim.citation_intents[0].intent, 'method-use');

  const performanceClaim = artifact.claims.find((claim) => claim.claim_text.includes('outperforms BM25'));
  assert.ok(performanceClaim);
  assert.equal(performanceClaim.claim_type, 'performance');

  const boundaryClaim = artifact.claims.find((claim) => claim.claim_text.includes('fails on multilingual'));
  assert.ok(boundaryClaim);
  assert.equal(boundaryClaim.claim_type, 'boundary');

  assert.ok(artifact.graph.nodes.some((node) => node.type === NODE_TYPES.CLAIM));
  assert.ok(artifact.graph.nodes.some((node) => node.type === NODE_TYPES.EVIDENCE_SNIPPET));
  assert.ok(artifact.graph.edges.some((edge) => edge.type === EDGE_TYPES.CLAIMS));
  assert.ok(artifact.graph.edges.some((edge) => edge.type === EDGE_TYPES.SUPPORTED_BY));
});

test('claim extraction benchmark gate scores recall, source spans, and type accuracy', () => {
  const artifact = buildClaimExtractionArtifact(paperFixture(), {
    gold: goldClaims(),
    minClaimRecall: 1,
    minSourceSpanCompleteness: 1,
    minTypeAccuracy: 1
  });

  assert.equal(artifact.evaluation.status, 'passed');
  assert.equal(artifact.evaluation.gold_count, 3);
  assert.equal(artifact.evaluation.claim_recall, 1);
  assert.equal(artifact.evaluation.source_span_completeness, 1);
  assert.equal(artifact.evaluation.type_accuracy, 1);

  const failed = evaluateClaimExtraction(artifact.claims.slice(0, 1), goldClaims(), {
    minClaimRecall: 1
  });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.threshold_failures.some((entry) => entry.includes('claim_recall')));
});

test('claim extraction CLI writes artifacts with optional citation and gold gates', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-claim-extraction-'));
  try {
    const inputPath = path.join(tempRoot, 'paper.json');
    const contextsPath = path.join(tempRoot, 'contexts.json');
    const intentsPath = path.join(tempRoot, 'intents.json');
    const goldPath = path.join(tempRoot, 'gold.json');
    const outputPath = path.join(tempRoot, 'claims.json');
    await fs.writeFile(inputPath, JSON.stringify(paperFixture(), null, 2), 'utf8');
    await fs.writeFile(contextsPath, JSON.stringify(citationContexts(), null, 2), 'utf8');
    await fs.writeFile(intentsPath, JSON.stringify(buildCitationIntentArtifact(citationContexts()), null, 2), 'utf8');
    await fs.writeFile(goldPath, JSON.stringify(goldClaims(), null, 2), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-claim-extraction.mjs'),
      '--input-path', inputPath,
      '--output-path', outputPath,
      '--citation-contexts-path', contextsPath,
      '--citation-intents-path', intentsPath,
      '--gold-path', goldPath,
      '--min-claim-recall', '1',
      '--min-source-span-completeness', '1',
      '--min-type-accuracy', '1'
    ]);
    const summary = JSON.parse(stdout);
    assert.equal(summary.contractVersion, CLAIM_EXTRACTION_CONTRACT_VERSION);
    assert.equal(summary.evaluation_status, 'passed');
    assert.equal(summary.evaluation_claim_recall, 1);
    assert.ok(summary.graph_node_count > 0);
    assert.ok(summary.graph_edge_count > 0);

    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(payload.evaluation.status, 'passed');
    assert.ok(payload.claims.some((claim) => claim.citation_context_ids.includes('ctx:dpr')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
