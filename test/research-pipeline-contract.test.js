import test from 'node:test';
import assert from 'node:assert/strict';
import { executeResearchWorkflow, resolveResearchWorkflowCall } from '../src/mcp/research-workflows.js';
import { summarizeResearchEnvelope, RESEARCH_SUMMARY_MAX_BYTES } from '../src/mcp/research-summary.js';

test('capabilities are discoverable without corpus, network or model calls',async()=>{
 const r=await executeResearchWorkflow('literature_review',{operation:'capabilities'},{},()=>{throw Error('Unexpected backend');});
 assert.ok(r.result.workflows.literature_review.includes('capabilities'));
 assert.equal(r.result.advanced.proposalExecution,'caller_supplied_actions');
 assert.deepEqual(r.result.responseModes,['full','summary']);
});

test('summary is bounded including pretty JSON, retains denial gates and points to full evidence',async()=>{
 const args={operation:'evaluate',corpus:'fixture',query:'GCD',candidateMechanism:'reliability gate',responseMode:'summary'};
 const raw={evidence_sufficiency:{status:'insufficient',novelty_claim_allowed:false,experiment_planning_allowed:false,reason_codes:['source_gap']},groups:Array.from({length:60},(_,i)=>({paper_id:`p:${i}`,title:'测试'.repeat(3000),source_spans:Array(12).fill({text:'abc '.repeat(500)})}))};
 const before=JSON.stringify(raw);
 const r=await executeResearchWorkflow('idea_generation',args,{},async(_,translated)=>{
  assert.equal(translated.responseMode,undefined);
  return raw;
 });
 assert.ok(Buffer.byteLength(JSON.stringify(r,null,2))<=RESEARCH_SUMMARY_MAX_BYTES);
 assert.equal(r.presentation.evidence_gates.evidence_sufficiency.novelty_claim_allowed,false);
 assert.equal(r.presentation.complete,false);
 assert.equal(r.presentation.read_more.arguments.responseMode,'full');
 assert.equal(JSON.stringify(raw),before);
 const full=await executeResearchWorkflow('idea_generation',{...args,responseMode:'full'},{},async()=>raw);
 assert.equal(full.result,raw);
 assert.equal(full.presentation,undefined);
});

test('summary total budget includes maximum caller arguments and adversarially large object keys',()=>{
 const args={operation:'evaluate',query:'q'.repeat(8000),candidateMechanism:'m'.repeat(8000),constraints:Array(30).fill('c'.repeat(8000))};
 const r=summarizeResearchEnvelope({tool:'idea_generation',operation:'evaluate',result:{['key'.repeat(40000)]:true},nextActions:[{arguments:args}]},args);
 assert.ok(Buffer.byteLength(JSON.stringify(r,null,2))<=RESEARCH_SUMMARY_MAX_BYTES);
 assert.equal(r.presentation.complete,false);
 assert.equal(r.result.omitted,true);
});

test('new presentation controls do not enable extra side effects or arbitrary backend options',()=>{
 assert.throws(()=>resolveResearchWorkflowCall('literature_review',{operation:'capabilities',outputDir:'/tmp/escape'}),/does not accept/);
 assert.throws(()=>resolveResearchWorkflowCall('literature_review',{operation:'paper',paperId:'p',responseMode:'hidden'}),/Invalid/);
});

test('submission summaries direct callers to existing job status instead of repeating writes', async()=>{
 for(const [operation,fields,result,status] of [
  ['discover',{query:'GCD'},{runId:'run:1'},'discovery_status'],
  ['import',{serverFilePath:'/staging/paper.pdf'},{jobId:'job:1'},'import_status']
 ]) {
  const r=await executeResearchWorkflow('literature_review',{operation,...fields,responseMode:'summary'},{},async()=>result);
  assert.equal(r.presentation.read_more.arguments.operation,status);
  assert.equal(r.presentation.read_more.arguments.responseMode,'full');
 }
 const unknown=summarizeResearchEnvelope({tool:'literature_review',operation:'discover',result:{status:'unknown'},evidenceBoundary:{basis:'discovery_submit'}},{operation:'discover'});
 assert.equal(unknown.presentation.read_more.arguments,undefined);
 assert.match(unknown.presentation.read_more.instruction,/Do not repeat/);
});

test('canonical skills and compatibility references resolve without nonexistent wrapper paths', async()=>{
 const fs=await import('node:fs/promises'); const path=await import('node:path');
 const root=path.resolve('SKILL');
 const docs=[];
 for(const dir of await fs.readdir(root,{withFileTypes:true})) {
  if(!dir.isDirectory()) continue;
  const skill=path.join(root,dir.name,'SKILL.md');
  try {await fs.access(skill);docs.push(skill);} catch {}
 }
 const refs=path.join(root,'PaperNexus/references');
 for(const name of await fs.readdir(refs)) if(name.endsWith('.md')) docs.push(path.join(refs,name));
 for(const file of docs) {
  const source=await fs.readFile(file,'utf8');
  for(const match of source.matchAll(/\]\(([^)]+)\)/g)) {
   if(!/^(https?:|#)/.test(match[1])) await fs.access(path.resolve(path.dirname(file),match[1]));
  }
  for(const match of source.matchAll(/SKILL\/[\w/.-]+\.py/g)) await fs.access(path.resolve(match[0]));
 }
 const main=await fs.readFile(path.join(root,'PaperNexus/SKILL.md'),'utf8');
 assert.ok(main.split('\n').length<=150);
});
