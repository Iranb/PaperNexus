import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { enrichGraphWithDomainAndMechanismNodes } from '../src/core/graph/domain-bridges.js';
import { EDGE_TYPES, NODE_TYPES } from '../src/core/graph/schema.js';
import { saveCorpus } from '../src/storage/corpus-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function createQueryApiFixture() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-query-api-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-query-api-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;

  process.env.PAPERNEXUS_HOME = tempHome;
  await fs.mkdir(inputRoot, { recursive: true });

  for (const fileName of [
    'retrieval-augmented-experiment-planning.md',
    'graph-augmented-literature-mapping.md'
  ]) {
    await fs.copyFile(path.join(examplesRoot, fileName), path.join(inputRoot, fileName));
  }

  const ingestion = await import('../src/core/ingestion/pipeline.js');
  await ingestion.analyzeCorpus(inputRoot, {
    rootPath: indexRoot,
    name: 'query-api-test',
    force: true
  });

  return {
    tempHome,
    workspaceRoot,
    indexRoot,
    previousHome
  };
}

async function cleanupQueryApiFixture(fixture) {
  if (fixture.previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
  else process.env.PAPERNEXUS_HOME = fixture.previousHome;
  await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
}

async function createCatalystApiFixture() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-api-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-catalyst-api-workspace-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  process.env.PAPERNEXUS_HOME = tempHome;

  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'paper:edu-1',
    type: NODE_TYPES.PAPER,
    name: 'Reducing Confirmation Bias in Tutoring',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'paper:psych-1',
    type: NODE_TYPES.PAPER,
    name: 'Belief Updating Under Uncertainty',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy']
    }
  });
  graph.addNode({
    id: 'problem:edu-bias',
    type: NODE_TYPES.PROBLEM,
    name: 'confirmation bias in tutoring feedback',
    properties: {
      paperTitles: ['Reducing Confirmation Bias in Tutoring'],
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractMechanisms: ['metacontrol policy'],
      brainstormEligible: true,
      brainstormScore: 0.94
    }
  });
  graph.addNode({
    id: 'method:psych-metacontrol',
    type: NODE_TYPES.METHOD,
    name: 'metacontrol policy transfer',
    properties: {
      paperTitles: ['Belief Updating Under Uncertainty'],
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractMechanisms: ['metacontrol policy'],
      brainstormEligible: true,
      brainstormScore: 0.89
    }
  });
  graph.addNode({
    id: 'challenge:edu-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
    properties: {
      fieldOfStudy: 'Education',
      domainTags: ['Education'],
      abstractionLevel: 'specific',
      challengeType: 'mixed',
      domainSpecificText: 'Tutoring systems need to calibrate learner beliefs without reinforcing the tutor perspective.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'interactive systems calibrate beliefs tutoring feedback metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      brainstormEligible: true,
      brainstormScore: 0.87
    }
  });
  graph.addNode({
    id: 'challenge:psych-bias',
    type: NODE_TYPES.CHALLENGE,
    name: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      abstractionLevel: 'specific',
      challengeType: 'mixed',
      domainSpecificText: 'Psychology experiments need to calibrate beliefs without reinforcing biased priors.',
      domainAgnosticText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      abstractMechanisms: ['metacontrol policy'],
      retrievalText: 'interactive systems calibrate beliefs biased priors metacontrol policy',
      analogyText: 'Interactive systems need to calibrate beliefs without locking users into asymmetric feedback loops.',
      brainstormEligible: true,
      brainstormScore: 0.84
    }
  });
  graph.addNode({
    id: 'takeaway:psych-reflective',
    type: NODE_TYPES.TAKEAWAY,
    name: 'reflective prompts stabilize belief updating',
    properties: {
      fieldOfStudy: 'Psychology',
      domainTags: ['Psychology'],
      sourceDomains: ['Psychology'],
      text: 'Reflective prompts create a pause that improves uncertainty-aware belief revision.',
      abstractMechanisms: ['metacontrol policy'],
      relatedChallenges: ['adaptive belief calibration under asymmetric feedback'],
      retrievalText: 'reflective prompts improve uncertainty-aware belief revision metacontrol policy',
      analogyText: 'Reflective prompts improve uncertainty-aware belief revision.',
      brainstormEligible: true,
      brainstormScore: 0.86
    }
  });
  graph.addNode({
    id: 'idea:edu-scaffold',
    type: NODE_TYPES.IDEA_FRAGMENT,
    name: 'tutoring feedback prompt scaffold',
    properties: {
      fieldOfStudy: 'Education',
      targetDomain: 'Education',
      domainTags: ['Education', 'Psychology'],
      sourceDomains: ['Psychology'],
      text: 'Adapt reflective prompts into tutoring feedback loops to reduce confirmation bias.',
      abstractMechanisms: ['metacontrol policy'],
      sourceTakeaways: ['reflective prompts stabilize belief updating'],
      addressesChallenges: ['adaptive belief calibration under asymmetric feedback'],
      retrievalText: 'adapt reflective prompts tutoring feedback confirmation bias metacontrol policy',
      analogyText: 'Transfer reflective prompt control into tutoring feedback loops.',
      brainstormEligible: true,
      brainstormScore: 0.9
    }
  });
  graph.addNode({
    id: 'snippet:psych-reflective',
    type: NODE_TYPES.EVIDENCE_SNIPPET,
    name: 'Reflective prompts improve uncertainty-aware belief revision.',
    properties: {
      paperId: 'paper:psych-1',
      paperTitle: 'Belief Updating Under Uncertainty',
      text: 'Reflective prompts improve uncertainty-aware belief revision.',
      evidenceText: 'Reflective prompts improve uncertainty-aware belief revision.',
      sectionHeading: 'Discussion',
      sectionRole: 'discussion'
    }
  });
  graph.addRelationship({
    id: 'rel:paper-problem',
    sourceId: 'paper:edu-1',
    targetId: 'problem:edu-bias',
    type: EDGE_TYPES.SOLVES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:problem-challenge',
    sourceId: 'problem:edu-bias',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.HAS_OPEN_CHALLENGE,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-addresses',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'challenge:psych-bias',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-snippet',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'snippet:psych-reflective',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:takeaway-idea',
    sourceId: 'takeaway:psych-reflective',
    targetId: 'idea:edu-scaffold',
    type: EDGE_TYPES.RECONTEXTUALIZES_TO,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-addresses',
    sourceId: 'idea:edu-scaffold',
    targetId: 'challenge:edu-bias',
    type: EDGE_TYPES.ADDRESSES,
    properties: {}
  });
  graph.addRelationship({
    id: 'rel:idea-snippet',
    sourceId: 'idea:edu-scaffold',
    targetId: 'snippet:psych-reflective',
    type: EDGE_TYPES.SUPPORTED_BY_SNIPPET,
    properties: {}
  });

  enrichGraphWithDomainAndMechanismNodes(graph);
  await saveCorpus(workspaceRoot, graph, {
    name: 'catalyst-api-test',
    rootPath: workspaceRoot,
    indexedAt: new Date().toISOString(),
    paperCount: graph.getNodesByType(NODE_TYPES.PAPER).length,
    nodeCount: graph.nodeCount,
    relationshipCount: graph.relationshipCount,
    sourceMode: 'test-fixture'
  });

  return {
    tempHome,
    workspaceRoot,
    rootPath: workspaceRoot,
    previousHome
  };
}

test('query API payload helpers expose query/context/impact/ideas/brainstorm over the configured corpus', async () => {
  const fixture = await createQueryApiFixture();

  try {
    const api = await import('../src/server/api.js');

    const query = await api.queryGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 5
      }
    });
    assert.equal(query.rootPath, fixture.indexRoot);
    assert.equal(query.result.query, 'experiment planning');
    assert.ok(query.result.groups.length > 0);

    const context = await api.contextGraphPayload(fixture.indexRoot, {
      query: 'experiment planning'
    });
    assert.equal(context.rootPath, fixture.indexRoot);
    assert.equal(context.result.query, 'experiment planning');
    assert.ok(context.result.node || context.result.candidates);

    const impact = await api.impactGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        direction: 'downstream',
        maxDepth: 2,
        layers: 'ProblemLayer,MethodLayer',
        layerMode: 'cross'
      }
    });
    assert.equal(impact.rootPath, fixture.indexRoot);
    assert.equal(impact.result.direction, 'downstream');
    assert.ok(impact.result.node);
    assert.ok(Array.isArray(impact.result.byDepth));

    const ideas = await api.ideasGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        limit: 5
      }
    });
    assert.equal(ideas.rootPath, fixture.indexRoot);
    assert.equal(ideas.result.query, 'experiment planning');
    assert.ok(Array.isArray(ideas.result.ideas));
    assert.ok(ideas.result.ideas.length > 0);

    const brainstorm = await api.brainstormGraphPayload(fixture.indexRoot, {
      query: 'experiment planning',
      options: {
        mode: 'converge',
        limit: 5,
        maxHops: 2
      }
    });
    assert.equal(brainstorm.rootPath, fixture.indexRoot);
    assert.equal(brainstorm.result.mode, 'converge');
    assert.ok(Array.isArray(brainstorm.result.convergedDirections));
    assert.ok(brainstorm.result.convergedDirections.length > 0);

    const paperIndex = await api.paperIndexPayload(fixture.indexRoot, {
      paperTitle: 'Retrieval-Augmented Experiment Planning with Lab Notebooks'
    });
    assert.equal(paperIndex.rootPath, fixture.indexRoot);
    assert.equal(paperIndex.result.contractVersion, 'paper-precise-index-v1');
    assert.equal(paperIndex.result.matchCount, 1);
    assert.equal(paperIndex.result.matches[0].paperTitle, 'Retrieval-Augmented Experiment Planning with Lab Notebooks');
    assert.ok(paperIndex.result.matches[0].canonicalId);
    assert.ok(Array.isArray(paperIndex.result.matches[0].identityAliases));
    const sourceIdLookup = await api.paperIndexPayload(fixture.indexRoot, {
      sourceId: paperIndex.result.matches[0].sources[0].sourceId
    });
    assert.equal(sourceIdLookup.result.matchCount, 1);
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});

test('serveCommand exposes authenticated POST query APIs for graph reasoning helpers', async () => {
  const fixture = await createQueryApiFixture();
  const port = 52000 + Math.floor(Math.random() * 1000);

  try {
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: fixture.indexRoot
        },
        serve: {
          apiToken: 'test'
        }
      },
      configBaseDir: fixture.workspaceRoot
    });

    try {
      const headers = {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json'
      };

      const query = await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            limit: 5
          }
        })
      }).then((response) => response.json());
      assert.equal(query.rootPath, fixture.indexRoot);
      assert.ok(query.result.groups.length > 0);

      const context = await fetch(`http://127.0.0.1:${port}/api/context`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning'
        })
      }).then((response) => response.json());
      assert.equal(context.rootPath, fixture.indexRoot);
      assert.ok(context.result.node || context.result.candidates);

      const impact = await fetch(`http://127.0.0.1:${port}/api/impact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            direction: 'downstream',
            maxDepth: 2
          }
        })
      }).then((response) => response.json());
      assert.equal(impact.rootPath, fixture.indexRoot);
      assert.equal(impact.result.direction, 'downstream');

      const ideas = await fetch(`http://127.0.0.1:${port}/api/ideas`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            limit: 5
          }
        })
      }).then((response) => response.json());
      assert.equal(ideas.rootPath, fixture.indexRoot);
      assert.ok(ideas.result.ideas.length > 0);

      const brainstorm = await fetch(`http://127.0.0.1:${port}/api/brainstorm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: 'experiment planning',
          options: {
            mode: 'converge',
            limit: 5,
            maxHops: 2
          }
        })
      }).then((response) => response.json());
      assert.equal(brainstorm.rootPath, fixture.indexRoot);
      assert.equal(brainstorm.result.mode, 'converge');
      assert.ok(brainstorm.result.convergedDirections.length > 0);

      const paperIndex = await fetch(`http://127.0.0.1:${port}/api/paper-index`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          paperTitle: 'Retrieval-Augmented Experiment Planning with Lab Notebooks'
        })
      }).then((response) => response.json());
      assert.equal(paperIndex.rootPath, fixture.indexRoot);
      assert.equal(paperIndex.result.contractVersion, 'paper-precise-index-v1');
      assert.equal(paperIndex.result.matchCount, 1);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});

test('catalyst API payload helper and HTTP route expose a stable scout-oriented contract', async () => {
  const fixture = await createCatalystApiFixture();
  const port = 53000 + Math.floor(Math.random() * 1000);
  const catalystRequest = {
    targetDomain: 'Education',
    abstractChallenge: 'reduce confirmation bias during tutoring feedback',
    mechanisms: ['metacontrol policy'],
    options: {
      limit: 5
    }
  };

  try {
    const api = await import('../src/server/api.js');
    const payload = await api.catalystGraphPayload(fixture.rootPath, catalystRequest);
    assert.equal(payload.rootPath, fixture.rootPath);
    assert.equal(payload.result.contractVersion, 'idea-catalyst-query-v1');
    assert.equal(payload.result.targetDomain, 'Education');
    assert.ok(payload.result.candidateDomains.some((entry) => entry.domain === 'Psychology'));
    assert.ok(payload.result.coverage.targetDomain.paperCount >= 1);
    assert.ok(payload.result.mechanismTraversal.matches.some((entry) => entry.provenanceVersion === 'idea-catalyst-mechanism-support-v1'));
    assert.ok(payload.result.mechanismMatches.some((entry) => entry.supportingPaperCount >= 2));
    assert.equal(payload.result.mechanismBridgeAnalysis.contractVersion, 'idea-catalyst-mechanism-bridges-v1');
    assert.ok(payload.result.mechanismBridgeAnalysis.crossDomainMechanismBridges.some((entry) => entry.sourceDomain === 'Psychology'));
    assert.equal(payload.result.bridgeRetrieval.contractVersion, 'idea-catalyst-bridge-retrieval-v1');
    assert.ok(payload.result.bridgeRetrieval.candidateBridgePaths.some((entry) => entry.candidateNodeType === 'Takeaway'));
    assert.equal(payload.result.structuralAnalogy.contractVersion, 'idea-catalyst-analogy-v1');
    assert.ok(payload.result.structuralAnalogy.alignments.some((entry) => entry.transferableMechanisms.includes('metacontrol policy')));
    assert.equal(payload.result.interdisciplinaryPotentialRanking.contractVersion, 'idea-catalyst-interdisciplinary-ranking-v1');
    assert.ok(payload.result.interdisciplinaryPotentialRanking.rankedCandidates.length > 0);

    const ideaV2 = await api.ideaCatalystV2Payload(fixture.rootPath, catalystRequest);
    assert.equal(ideaV2.result.contractVersion, 'papernexus-idea-catalyst-v2-http-v1');
    assert.ok(ideaV2.result.must_cite_set.length > 0);
    assert.ok(ideaV2.result.contribution_claims.length > 0);
    assert.ok(ideaV2.result.novelty_certificate);
    assert.ok(ideaV2.result.review_packet);
    assert.ok(ideaV2.result.storyline_dag.beats.every((beat) => Array.isArray(beat.trace_refs) && beat.trace_refs.length > 0));
    assert.ok(ideaV2.result.falsification_plans.length > 0);
    assert.deepEqual(ideaV2.falsification_plans, ideaV2.result.falsification_plans);

    const { loadCorpus } = await import('../src/storage/corpus-store.js');
    const beforeWriteback = await loadCorpus(fixture.rootPath);
    const ideaV2Writeback = await api.ideaCatalystV2Payload(fixture.rootPath, {
      ...catalystRequest,
      writeBack: true,
      writeBackActor: 'query-api-test'
    });
    assert.equal(ideaV2Writeback.writeback.requested, true);
    assert.equal(ideaV2Writeback.writeback.dryRun, true);
    assert.equal(ideaV2Writeback.writeback.applyStatus, 'previewed');
    assert.equal(ideaV2Writeback.writeback.graphValidationStatus, 'validated');
    assert.ok(ideaV2Writeback.writeback.mutationResult.summary.nodesCreated > 0);
    const afterDryRun = await loadCorpus(fixture.rootPath);
    assert.equal(afterDryRun.graph.nodeCount, beforeWriteback.graph.nodeCount);

    const ideaV2Apply = await api.ideaCatalystV2Payload(fixture.rootPath, {
      ...catalystRequest,
      writeBack: true,
      writeBackApply: true,
      writeBackActor: 'query-api-test'
    });
    assert.equal(ideaV2Apply.writeback.dryRun, false);
    assert.equal(ideaV2Apply.writeback.applyStatus, 'applied');
    const afterApply = await loadCorpus(fixture.rootPath);
    assert.ok(afterApply.graph.nodes.some((node) => node.type === 'ContributionClaim'));

    const novelty = await api.noveltyEvalPayload(fixture.rootPath, catalystRequest);
    assert.equal(novelty.result.contractVersion, 'papernexus-novelty-eval-http-v1');
    assert.ok(novelty.result.novelty_certificate.reasons.length > 0);

    const storyline = await api.storylinePayload(fixture.rootPath, catalystRequest);
    assert.equal(storyline.result.contractVersion, 'papernexus-storyline-http-v1');
    assert.equal(storyline.result.beat_trace_coverage.traceable_beat_count, storyline.result.beat_trace_coverage.beat_count);

    const reviewer = await api.reviewerSimulatePayload(fixture.rootPath, catalystRequest);
    assert.equal(reviewer.result.contractVersion, 'papernexus-reviewer-simulation-http-v1');
    assert.ok(reviewer.result.review_packet.reviewers.length > 0);

    const { startRun } = await import('../src/storage/run-store.js');
    const started = await startRun(fixture.rootPath, {
      runId: 'eval:test-run',
      kind: 'eval',
      currentStage: 'smoke'
    });
    const run = await api.evalRunPayload(fixture.rootPath, started.runId);
    assert.equal(run.result.contractVersion, 'papernexus-eval-run-http-v1');
    assert.equal(run.result.run_id, started.runId);

    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: fixture.rootPath
        },
        serve: {
          apiToken: 'test'
        }
      },
      configBaseDir: fixture.workspaceRoot
    });

    try {
      const headers = {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json'
      };
      const response = await fetch(`http://127.0.0.1:${port}/api/catalyst`, {
        method: 'POST',
        headers,
        body: JSON.stringify(catalystRequest)
      }).then((result) => result.json());

      assert.equal(response.rootPath, fixture.rootPath);
      assert.equal(response.result.contractVersion, 'idea-catalyst-query-v1');
      assert.ok(response.result.mechanismTraversal.matches.length > 0);
      assert.ok(response.result.mechanismTraversal.matches.some((entry) => entry.provenanceVersion === 'idea-catalyst-mechanism-support-v1'));
      assert.ok(response.result.candidateDomains.some((entry) => entry.domain === 'Psychology'));
      assert.equal(response.result.mechanismBridgeAnalysis.contractVersion, 'idea-catalyst-mechanism-bridges-v1');
      assert.ok(response.result.mechanismBridgeAnalysis.candidateMechanismCommunities.some((entry) => entry.mechanism === 'metacontrol policy'));
      assert.equal(response.result.bridgeRetrieval.contractVersion, 'idea-catalyst-bridge-retrieval-v1');
      assert.ok(response.result.bridgeRetrieval.candidateBridgePaths.some((entry) => entry.candidateNodeType === 'Takeaway'));
      assert.equal(response.result.structuralAnalogy.contractVersion, 'idea-catalyst-analogy-v1');
      assert.equal(response.result.interdisciplinaryPotentialRanking.contractVersion, 'idea-catalyst-interdisciplinary-ranking-v1');

      const routeChecks = [
        ['/api/idea-catalyst-v2', 'papernexus-idea-catalyst-v2-http-v1'],
        ['/api/novelty-eval', 'papernexus-novelty-eval-http-v1'],
        ['/api/storyline', 'papernexus-storyline-http-v1'],
        ['/api/reviewer-simulate', 'papernexus-reviewer-simulation-http-v1']
      ];
      for (const [route, contractVersion] of routeChecks) {
        const routeResponse = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(catalystRequest)
        }).then((result) => result.json());
        assert.equal(routeResponse.rootPath, fixture.rootPath);
        assert.equal(routeResponse.result.contractVersion, contractVersion);
      }

      const writebackRouteResponse = await fetch(`http://127.0.0.1:${port}/api/idea-catalyst-v2`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...catalystRequest,
          writeBack: true,
          writeBackActor: 'query-api-http-test'
        })
      }).then((result) => result.json());
      assert.equal(writebackRouteResponse.writeback.requested, true);
      assert.equal(writebackRouteResponse.writeback.dryRun, true);
      assert.equal(writebackRouteResponse.writeback.applyStatus, 'previewed');

      const evalRun = await fetch(`http://127.0.0.1:${port}/api/eval/runs/${encodeURIComponent(started.runId)}`, {
        headers: {
          Authorization: 'Bearer test'
        }
      }).then((result) => result.json());
      assert.equal(evalRun.rootPath, fixture.rootPath);
      assert.equal(evalRun.result.contractVersion, 'papernexus-eval-run-http-v1');
      assert.equal(evalRun.result.run_id, started.runId);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});

test('brainstorm API payload exposes a domain-aware community profile for diverge mode', async () => {
  const fixture = await createCatalystApiFixture();

  try {
    const api = await import('../src/server/api.js');
    const brainstorm = await api.brainstormGraphPayload(fixture.rootPath, {
      query: 'confirmation bias in tutoring feedback',
      options: {
        mode: 'diverge',
        maxHops: 2,
        limit: 6
      }
    });

    assert.equal(brainstorm.rootPath, fixture.rootPath);
    assert.equal(brainstorm.result.mode, 'diverge');
    assert.equal(brainstorm.result.domainProfile.contractVersion, 'idea-catalyst-domain-community-profile-v1');
    assert.ok(Array.isArray(brainstorm.result.domainProfile.topBridgeDomains));
    assert.ok(brainstorm.result.domainProfile.topBridgeDomains.some((entry) => entry.domain === 'Psychology'));
    assert.ok(Array.isArray(brainstorm.result.communityAnalysis.crossCommunityBridges));
  } finally {
    await cleanupQueryApiFixture(fixture);
  }
});
