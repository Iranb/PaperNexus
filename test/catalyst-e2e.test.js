import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalFetch = globalThis.fetch;

function extractPromptPapers(prompt) {
  const marker = 'Papers:\n';
  const markerIndex = String(prompt || '').lastIndexOf(marker);
  if (markerIndex === -1) return [];

  try {
    return JSON.parse(String(prompt).slice(markerIndex + marker.length).trim());
  } catch {
    return [];
  }
}

function buildSemanticPaper(title, paperId) {
  if (title === 'Target Tutoring Bias Calibration') {
    return {
      id: paperId,
      fieldOfStudy: 'Education',
      fieldCandidates: ['Education', 'Psychology'],
      domainTags: ['Education', 'Psychology'],
      abstractMechanisms: [
        {
          name: 'metacontrol policy',
          type: 'control-policy',
          category: 'adaptive-control',
          description: 'adaptive trade-off between persistence and flexibility',
          aliases: ['cognitive control trade-off']
        }
      ],
      problems: [
        {
          name: 'confirmation bias in tutoring feedback',
          type: 'Problem',
          evidenceText: 'Tutoring systems often reinforce the tutor perspective during belief calibration.',
          sectionHeading: 'Abstract',
          sectionRole: 'abstract',
          confidence: 0.95
        }
      ],
      researchQuestions: [
        {
          name: 'how can tutoring systems reduce biased belief updates?',
          domainSpecificText: 'How can tutoring systems reduce biased learner belief updates during interactive feedback?',
          domainAgnosticText: 'How can interactive systems reduce biased belief updates during iterative feedback?'
        }
      ],
      openChallenges: [
        {
          name: 'adaptive belief calibration under asymmetric feedback',
          domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
          domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
          challengeType: 'mixed',
          relatedMechanisms: ['metacontrol policy']
        }
      ],
      methods: [
        {
          name: 'calibrated tutoring reflection policy',
          type: 'Method',
          evidenceText: 'We use adaptive reflective prompts to rebalance tutoring feedback.',
          sectionHeading: 'Method',
          sectionRole: 'method',
          confidence: 0.9
        }
      ]
    };
  }

  if (title === 'Reflective Prompt Transfer for Belief Updating') {
    return {
      id: paperId,
      fieldOfStudy: 'Psychology',
      fieldCandidates: ['Psychology', 'Education'],
      domainTags: ['Psychology', 'Education'],
      abstractMechanisms: [
        {
          name: 'metacontrol policy',
          type: 'control-policy',
          category: 'adaptive-control',
          description: 'adaptive trade-off between persistence and flexibility'
        }
      ],
      problems: [
        {
          name: 'belief calibration under uncertainty',
          type: 'Problem',
          evidenceText: 'Reflective prompts improve belief updating under uncertainty.',
          sectionHeading: 'Abstract',
          sectionRole: 'abstract',
          confidence: 0.94
        }
      ],
      openChallenges: [
        {
          name: 'adaptive belief calibration under asymmetric feedback',
          domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
          domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
          challengeType: 'mixed',
          relatedMechanisms: ['metacontrol policy']
        }
      ],
      takeaways: [
        {
          name: 'reflective prompts stabilize belief updating',
          text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
          relatedMechanisms: ['metacontrol policy'],
          relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
          supportingSnippets: [
            {
              text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
              sectionHeading: 'Discussion',
              sectionRole: 'discussion'
            }
          ]
        }
      ],
      ideaFragments: [
        {
          name: 'tutoring feedback prompt scaffold',
          text: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
          targetDomain: 'Education',
          sourceDomains: ['Psychology'],
          relatedMechanisms: ['metacontrol policy'],
          sourceTakeaways: ['reflective prompts stabilize belief updating'],
          addressesChallenges: ['adaptive belief calibration under asymmetric feedback'],
          supportingSnippets: [
            {
              text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
              sectionHeading: 'Discussion',
              sectionRole: 'discussion'
            }
          ]
        }
      ]
    };
  }

  return {
    id: paperId,
    problems: []
  };
}

test('end-to-end catalyst flow turns provided papers into challenge-aware bridge retrieval, structural analogy, and interdisciplinary ranking outputs', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-e2e-home-'));
  const tempCorpusRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-e2e-corpus-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const previousBackend = process.env.PAPERNEXUS_GRAPH_BACKEND;

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    process.env.PAPERNEXUS_GRAPH_BACKEND = 'json';

    await fs.writeFile(path.join(tempCorpusRoot, 'target-paper.md'), `# Target Tutoring Bias Calibration

Alice Example

## Abstract

Tutoring systems often reinforce the tutor perspective during belief calibration.

## Method

We use adaptive reflective prompts to rebalance tutoring feedback.
`, 'utf8');

    await fs.writeFile(path.join(tempCorpusRoot, 'source-paper.md'), `# Reflective Prompt Transfer for Belief Updating

Bob Example

## Abstract

Reflective prompts improve belief updating under uncertainty.

## Discussion

Reflective prompts create a pause that improves uncertainty-aware belief revision.
`, 'utf8');

    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(options.body);
      const prompt = request.messages?.[0]?.content || '';
      const papers = extractPromptPapers(prompt).map((paper) => (
        buildSemanticPaper(paper?.title, paper?.id || `paper:${paper?.title || 'unknown'}`)
      ));

      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({ papers })
                }
              }
            ]
          };
        }
      };
    };

    const [{ analyzeCorpus }, api, corpusStore, render] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/api.js'),
      import('../src/storage/corpus-store.js'),
      import('../src/lib/render.js')
    ]);

    const analysis = await analyzeCorpus(tempCorpusRoot, {
      name: 'catalyst-e2e-test',
      force: true,
      semanticExtraction: 'llm-assisted',
      llmProvider: 'openai',
      llmModel: 'gpt-4o-mini',
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'test-key'
    });

    assert.ok(analysis.graph.nodes.some((node) => node.type === 'ResearchQuestion'));
    assert.ok(analysis.graph.nodes.some((node) => node.type === 'Challenge'));
    assert.ok(analysis.graph.nodes.some((node) => node.type === 'Takeaway'));
    assert.ok(analysis.graph.nodes.some((node) => node.type === 'IdeaFragment'));
    assert.ok(analysis.graph.nodes.some((node) => node.type === 'EvidenceSnippet'));
    assert.ok(analysis.graph.nodes.some((node) => node.type === 'AbstractMechanism' && node.name === 'metacontrol policy'));
    assert.ok(analysis.graph.relationships.some((relationship) => relationship.type === 'DECOMPOSES_TO'));
    assert.ok(analysis.graph.relationships.some((relationship) => relationship.type === 'HAS_OPEN_CHALLENGE'));
    assert.ok(analysis.graph.relationships.some((relationship) => relationship.type === 'RECONTEXTUALIZES_TO'));
    assert.ok(analysis.graph.relationships.some((relationship) => relationship.type === 'SUPPORTED_BY_SNIPPET'));

    const lite = await corpusStore.loadCorpusLite(tempCorpusRoot);
    assert.ok(lite.graph.nodes.some((node) => node.type === 'Challenge'));
    assert.ok(lite.graph.nodes.some((node) => node.type === 'Takeaway'));
    assert.ok(lite.graph.nodes.some((node) => node.type === 'IdeaFragment'));

    const payload = await api.catalystGraphPayload(tempCorpusRoot, {
      targetDomain: 'Education',
      abstractChallenge: 'reduce confirmation bias during tutoring feedback',
      mechanisms: ['metacontrol policy'],
      options: {
        limit: 6
      }
    });

    assert.equal(payload.rootPath, tempCorpusRoot);
    assert.equal(payload.result.targetDomain, 'Education');
    assert.ok(payload.result.candidateDomains.some((entry) => entry.domain === 'Psychology'));
    assert.equal(payload.packetBundle.contractVersion, 'idea-catalyst-packet-bundle-v1');
    assert.ok(payload.packetBundle.decomposition.research_questions.length >= 1);
    assert.ok(payload.packetBundle.cross_domain_queries.length >= 1);
    assert.ok(payload.packetBundle.source_domain_analyses.length >= 1);
    assert.ok(payload.result.mechanismTraversal.matches.some((entry) => (
      entry.mechanism === 'metacontrol policy'
      && entry.provenanceVersion === 'idea-catalyst-mechanism-support-v1'
    )));
    assert.ok(payload.result.bridgeRetrieval.candidateBridgePaths.some((entry) => (
      entry.sourceDomain === 'Psychology'
      && ['Takeaway', 'IdeaFragment'].includes(entry.candidateNodeType)
    )));
    assert.ok(payload.result.structuralAnalogy.alignments.some((entry) => (
      entry.transferableMechanisms.includes('metacontrol policy')
      && entry.matchedMotifs.includes('challenge-takeaway')
    )));
    assert.ok(payload.result.interdisciplinaryPotentialRanking.rankedCandidates.some((entry) => (
      entry.sourceDomain === 'Psychology'
      && entry.interdisciplinaryPotential > 0
    )));

    const rendered = render.renderCatalystResult(payload.result);
    assert.match(rendered, /Bridge retrieval:/);
    assert.match(rendered, /Structural analogies:/);
    assert.match(rendered, /Interdisciplinary potential:/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    if (previousBackend === undefined) delete process.env.PAPERNEXUS_GRAPH_BACKEND;
    else process.env.PAPERNEXUS_GRAPH_BACKEND = previousBackend;
    await fs.rm(tempCorpusRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
