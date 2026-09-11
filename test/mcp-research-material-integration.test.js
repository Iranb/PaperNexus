import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTopicFixture } from './fixtures/topic-analysis-fixture.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { executeTool } from '../src/mcp/core.js';
import { resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';

test('material, catalyst and evidence operations run on actual committed graph without providers or graph writes', {timeout:30000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pn-mcp-materials-'));
  const paths=getCorpusPaths(root);
  const graph=createTopicFixture();
  await fs.mkdir(paths.corpusDir,{recursive:true});
  await fs.writeFile(paths.metaPath,JSON.stringify({name:'workflow-materials',rootPath:root,nodeCount:graph.nodeCount,relationshipCount:graph.relationshipCount}));
  const original=JSON.stringify(graph.toJSON());
  await fs.writeFile(paths.liteGraphPath,original);
  const oldFetch=globalThis.fetch;
  let networkCalls=0;
  globalThis.fetch=async()=>{networkCalls++;throw new Error('Network forbidden in committed graph operations');};
  try {
    for(const [name,operation,fields] of [
      ['literature_review','paper',{paperId:'p1'}],
      ['literature_review','survey',{query:'feedback',targetDomain:'Education'}],
      ['lineage_analysis','evidence',{edgeId:'evolution'}],
      ['lineage_analysis','path',{from:'q1',to:'m1'}],
      ['lineage_analysis','context',{query:'q1'}],
      ['lineage_analysis','impact',{query:'q1',direction:'forward'}],
      ['idea_generation','generate',{query:'feedback',targetDomain:'Education',selectionMode:'mmr'}],
      ['idea_generation','diverge',{query:'feedback'}],
      ['idea_generation','converge',{query:'feedback'}],
      ['idea_generation','gaps',{query:'feedback',targetDomain:'Education'}],
      ['idea_generation','evaluate',{query:'feedback',candidateMechanism:'Confidence-calibrated feedback control'}],
      ['idea_generation','experiment_materials',{query:'feedback'}]
    ]){
      const result=await executeTool(name,{operation,corpus:root,...fields});
      assert.equal(result.tool,name);
      assert.ok(result.result);
    }
    assert.equal(networkCalls,0);
    assert.equal(await fs.readFile(paths.liteGraphPath,'utf8'),original);
  } finally {
    globalThis.fetch=oldFetch;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('discovery paper count is mapped to real backend budget fields', () => {
  const call=resolveResearchWorkflowCall('literature_review',{operation:'discover',query:'topic',maxPapers:7});
  assert.equal(call.args.maxCandidates,7);
  assert.equal(call.args.maxResultsPerQuery,7);
  assert.equal(call.args.maxQueries,6);
  assert.equal(call.args.maxPapers,undefined);
});
