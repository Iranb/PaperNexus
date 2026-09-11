import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/mcp/core.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { getDiscoveryPaths } from '../src/core/discovery/store.js';
import { resetDiscoveryRequestSchedulerForTests } from '../src/core/discovery/request-scheduler.js';

test('real discovery submission, saved-source import and durable file submission preserve phase authority', {timeout:30000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pn-research-async-'));
  const paths=getCorpusPaths(root);
  await fs.mkdir(paths.corpusDir,{recursive:true});
  await fs.writeFile(paths.metaPath,JSON.stringify({name:'async-fixture',rootPath:root}));
  await fs.writeFile(paths.liteGraphPath,JSON.stringify({nodes:[],relationships:[]}));
  const oldFetch=globalThis.fetch;
  let providerCalls=0;
  globalThis.fetch=async(input)=>{
    assert.equal(new URL(String(input)).hostname,'dblp.org');
    providerCalls++;
    return new Response(JSON.stringify({result:{hits:{hit:[]}}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const options={config:{literatureDiscovery:{providerConcurrency:1,discoveryRequestCache:false,providerRequestDelayMs:0,retryCount:0}}};
  const poll=async(args,done)=>{
    for(let n=0;n<120;n++){
      const value=await executeTool('literature_review',{corpus:root,...args},options);
      if(done(value.result)) return value;
      await new Promise((resolve)=>setTimeout(resolve,25));
    }
    throw new Error('Isolated async test timed out');
  };
  try {
    const submitted=await executeTool('literature_review',{operation:'discover',corpus:root,query:'fixture asynchronous research',providers:['dblp'],maxPapers:2},options);
    assert.equal(submitted.result.status,'submitted');
    assert.equal(submitted.nextActions[0].arguments.operation,'discovery_status');
    const done=await poll({operation:'discovery_status',runId:submitted.result.runId},(result)=>result.current.isTerminal);
    assert.equal(done.result.current.status,'completed');
    assert.ok(providerCalls>0);
    const report=await executeTool('literature_review',done.nextActions[0].arguments,options);
    assert.equal(report.result.runId,submitted.result.runId);
    const file=path.join(root,'saved-source.md');
    await fs.writeFile(file,'# Saved Source\n\n## Abstract\n\nFeedback calibration from a synthetic source.');
    const savedPath=getDiscoveryPaths(root,'saved-ready').runJsonPath;
    await fs.mkdir(path.dirname(savedPath),{recursive:true});
    await fs.writeFile(savedPath,JSON.stringify({runId:'saved-ready',candidates:[{
      id:'candidate-1',title:'Saved Source',doi:'10.0000/workflow-fixture',source:{resolutionStatus:'fulltext_ready',sourcePath:file}
    },{id:'metadata-only',title:'Not resolved',source:{resolutionStatus:'metadata_only'}}]}));
    providerCalls=0;
    const imported=await executeTool('literature_review',{operation:'import',corpus:root,runId:'saved-ready'},options);
    assert.equal(providerCalls,0);
    assert.equal(imported.result.submitted,1);
    assert.equal(imported.result.eligibleSources,1);
    assert.equal(imported.backend.component,'submitDiscoveryImports');
    const taskIds=imported.nextActions[0].arguments.taskIds;
    assert.equal(taskIds.length,1);
    const queue=await executeTool('literature_review',imported.nextActions[0].arguments,options);
    assert.equal(queue.backend.operation,'status_batch');
    assert.match(JSON.stringify(queue.result),/queued|pending/);
    const asyncSubmit=await executeTool('literature_review',{operation:'import',corpus:root,serverFilePath:file,doi:'10.0000/workflow-fixture',idempotencyKey:'stable-'+path.basename(root)},options);
    assert.ok(asyncSubmit.result.jobId);
    const completed=await poll({operation:'import_status',jobId:asyncSubmit.result.jobId},(result)=>['completed','failed'].includes(result.status));
    assert.equal(completed.result.status,'completed',JSON.stringify(completed.result.error));
    assert.equal(completed.nextActions[0].arguments.taskId,taskIds[0]);
    assert.equal(Object.hasOwn(completed,'status'),false);
  } finally {
    globalThis.fetch=oldFetch;
    resetDiscoveryRequestSchedulerForTests();
    await fs.rm(root,{recursive:true,force:true});
  }
});
