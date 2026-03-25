import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_TYPES } from '../src/core/graph/schema.js';
import { __graphPostprocessTestables, precomputeGraphPostprocess } from '../src/core/ingestion/graph-postprocess.js';

test('buildCitationRelationships resolves exact and partial title matches', () => {
  const relationships = __graphPostprocessTestables.buildCitationRelationships([
    {
      paperId: 'paper:a',
      paperTitle: 'Graph-Augmented Literature Mapping for Biomedical Discovery',
      references: [
        { raw: 'Graph-Augmented Literature Mapping for Biomedical Discovery' },
        { raw: 'Literature Mapping for Biomedical Discovery' }
      ]
    },
    {
      paperId: 'paper:b',
      paperTitle: 'Retrieval-Augmented Experiment Planning',
      references: []
    }
  ]);

  assert.equal(relationships.length, 0);

  const citingRelationships = __graphPostprocessTestables.buildCitationRelationships([
    {
      paperId: 'paper:a',
      paperTitle: 'Retrieval-Augmented Experiment Planning',
      references: [
        { raw: 'Graph-Augmented Literature Mapping for Biomedical Discovery' },
        { raw: 'Literature Mapping for Biomedical Discovery' }
      ]
    },
    {
      paperId: 'paper:b',
      paperTitle: 'Graph-Augmented Literature Mapping for Biomedical Discovery',
      references: []
    }
  ]);

  assert.equal(citingRelationships.length, 2);
  assert.ok(citingRelationships.every((relationship) => relationship.type === EDGE_TYPES.CITES));
  assert.ok(citingRelationships.every((relationship) => relationship.sourceId === 'paper:a'));
  assert.ok(citingRelationships.every((relationship) => relationship.targetId === 'paper:b'));
});

test('precomputeGraphPostprocess produces heuristic relationships for methods and problems', async () => {
  const relationships = await precomputeGraphPostprocess({
    methods: [
      { id: 'method:1', name: 'graph retrieval planner', properties: { paperTitles: ['Paper A'] } }
    ],
    problems: [
      { id: 'problem:1', name: 'retrieval planning', properties: { paperTitles: ['Paper B'] } }
    ],
    limitations: [],
    futureDirections: [],
    benchmarks: [],
    claims: [],
    appliesPairs: [],
    papers: []
  }, {
    graphPostprocessConcurrency: 1
  });

  assert.ok(relationships.some((relationship) => {
    return relationship.type === EDGE_TYPES.TRANSFERABLE_TO
      && relationship.sourceId === 'method:1'
      && relationship.targetId === 'problem:1';
  }));
});
