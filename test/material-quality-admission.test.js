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

test('manifest denial applies to every selector and material search without rejecting another version',async t=>{
 const {root,paths,bytes}=await fixture(t);
 const fsManifest=JSON.parse(await fs.readFile(paths.sourceManifestPath || paths.manifestPath,'utf8'));
 fsManifest.sources.find(s=>s.paperId==='paper:new').sourcePurpose='test';
 await saveSourceManifest(root,fsManifest);
 for(const selector of [{paperId:'paper:new'},{identifier:'2401.01234v2'},{sourceKey:'new'}]) {
  const view=await run({operation:'paper_material_view',corpus:root,...selector});
  assert.equal(view.paper.status,'quarantined');
  assert.ok(view.paper.source_admission.reasons.includes('test-source'));
  assert.deepEqual(view.graph_context,[]);
 }
 const old=await run({operation:'paper_material_view',corpus:root,paperId:'paper:old'});
 assert.equal(old.paper.status,'in_graph');
 const plan=await run({operation:'source_discovery_plan',corpus:root,targetProblem:'GCD'});
 assert.ok(plan.candidate_papers.every(p=>p.paper_id!=='paper:new'));
 assert.equal(await fs.readFile(paths.liteGraphPath,'utf8'),bytes);
});

test('version views align identifiers, abstract, spans and relationship provenance',async t=>{
 const {root}=await fixture(t);
 for(const version of ['old','new']) {
  const view=await run({operation:'paper_material_view',corpus:root,paperId:`paper:${version}`,paperTitle:'Reliable GCD'});
  assert.equal(view.paper.paper_id,'paper:new');
  assert.equal(view.paper.identifiers.arxivId,'2401.01234v2');
  assert.equal(view.paper.selected_source.paper_id,`paper:${version}`);
  assert.equal(view.paper.selected_source.identifiers.arxivId,version==='old'?'2401.01234v1':'2401.01234v2');
  assert.match(view.materials.abstract,new RegExp(version));
  assert.ok(view.materials.source_spans.every(s=>s.source_key===version));
  assert.ok(view.graph_context.length>0);
  assert.ok(view.graph_context.every(c=>c.source_paper_id===`paper:${version}`));
  assert.ok(view.graph_context.every(c=>c.node_id===`method:${version}`));
 }
});

test('empty proposal variants preserve response shape without rounds or artifact writes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pn-empty-proposal-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const proposalSlates of [undefined,[],[[]],[{role_id:'A',actions:[]}],{'round-000':[{role_id:'A',actions:[]}]}]) {
  const r=await run({operation:'proposal_graph_session',problem:'GCD',proposalSlates,maxRounds:5,outputDir:path.join(root,'output')});
  assert.equal(r.input_status,'needs_actions');assert.equal(r.round_count,0);
  for(const key of ['graph','validation_report','commit_decisions','edit_decisions','patches','role_trace','proposal_bundle','evidence_export','manifest']) assert.ok(Object.hasOwn(r,key),key);
  assert.equal(r.validation_report.graph.valid,true);
 }
 assert.deepEqual(await fs.readdir(root),[]);
 for(const proposalSlates of ['invalid',{'bad-round':[]},[{actions:'invalid'}]]) await assert.rejects(run({operation:'proposal_graph_session',problem:'GCD',proposalSlates}),/slate|actions/i);
});
