import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { getCorpusPaths, saveSourceManifest } from '../src/storage/corpus-store.js';
import { executeAgentMaterialsOperation as run } from '../src/core/materials/agent-materials.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-material-admission-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const paths = getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir,{recursive:true});
  const graph=createKnowledgeGraph();
  const sources=[];
  for(const [id,title,identifiers] of [
    ['bad','GCD Internal Test',{doi:'10.48550/papernexus.test'}],
    ['old','Reliable GCD',{arxivId:'2401.01234v1'}],
    ['new','Reliable GCD',{arxivId:'2401.01234v2'}]
  ]) {
    const sourcePath=path.join(root,`${id}.md`);
    await fs.writeFile(sourcePath,`# ${title}\n\n## Method\nGCD discovery calibration evidence for ${id}.\n`);
    sources.push({sourceKey:id,paperId:`paper:${id}`,paperTitle:title,identifiers,sourcePath,kind:'markdown'});
    graph.addNode({id:`paper:${id}`,type:'Paper',name:title,properties:{identifiers,sourcePath,abstract:`GCD discovery calibration ${id}`}});
    graph.addNode({id:`method:${id}`,type:'Method',name:`GCD calibration ${id}`,properties:{paperId:`paper:${id}`}});
    graph.addRelationship({id:`edge:${id}`,type:'PROPOSES',sourceId:`paper:${id}`,targetId:`method:${id}`,properties:{paperId:`paper:${id}`}});
  }
  await fs.writeFile(paths.liteGraphPath,JSON.stringify(graph.toJSON()));
  await fs.writeFile(paths.metaPath,JSON.stringify({name:'quality-fixture',rootPath:root}));
  await saveSourceManifest(root,{sources});
  return {root,paths,bytes:await fs.readFile(paths.liteGraphPath,'utf8')};
}

test('material views deny quarantined evidence by ID, identifier and source key without mutating raw storage',async t=>{
 const {root,paths,bytes}=await fixture(t);
 for(const selector of [{paperId:'paper:bad'},{identifier:'10.48550/papernexus.test'},{sourceKey:'bad'}]) {
  const view=await run({operation:'paper_material_view',corpus:root,...selector});
  assert.equal(view.paper.status,'quarantined');
  assert.equal(view.paper.source_admission.eligible,false);
  assert.equal(view.paper.availability.graph_context,false);
  assert.deepEqual(view.graph_context,[]);
  assert.deepEqual(view.materials.source_spans,[]);
 }
 await run({operation:'paper_role_overlay',action:'add',corpus:root,project:'admission-test',paperId:'paper:bad',paperTitle:'GCD Internal Test',role:'target_prior',confidence:'medium'});
 const pack=await run({operation:'research_material_pack',corpus:root,project:'admission-test',targetProblem:'GCD',roles:['target_prior'],autoDiscoverSources:false});
 assert.ok(pack.quarantined_materials.some(item=>item.paper_id==='paper:bad'));
 assert.ok(pack.groups.every(g=>g.items.every(i=>i.paper_id!=='paper:bad')));
 const plan=await run({operation:'source_discovery_plan',corpus:root,targetProblem:'GCD',autoDiscoverSources:false});
 assert.ok(plan.candidate_papers.every(p=>p.paper_id!=='paper:bad'));
 assert.equal(await fs.readFile(paths.liteGraphPath,'utf8'),bytes);
});

test('old version selectors resolve to canonical research paper while preserving source access',async t=>{
 const {root}=await fixture(t);
 for(const selector of [{paperId:'paper:old'},{identifier:'2401.01234v1'}]) {
  const view=await run({operation:'paper_material_view',corpus:root,...selector});
  assert.equal(view.paper.paper_id,'paper:new');
  assert.equal(view.paper.status,'in_graph');
  assert.equal(view.paper.source_admission.eligible,true);
  assert.ok(view.materials.source_spans.length>0);
 }
});

test('proposal MCP reports missing actions without empty iteration',async()=>{
 const result=await run({operation:'proposal_graph_session',problem:'GCD evidence audit',maxRounds:5});
 assert.equal(result.final_status,'diagnosis');
 assert.equal(result.input_status,'needs_actions');
 assert.equal(result.round_count,0);
 assert.ok(result.required_inputs.includes('proposalActions or proposalSlates'));
 assert.equal(result.execution_mode,'caller_supplied_actions');
});
