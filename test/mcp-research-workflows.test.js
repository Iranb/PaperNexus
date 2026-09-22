import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PAPERNEXUS_TOOLS } from '../src/mcp/tools.js';
import { RESEARCH_TOOLS, RESEARCH_ROUTES, listMcpTools, resolveMcpToolProfile, resolveResearchWorkflowCall, executeResearchWorkflow } from '../src/mcp/research-workflows.js';
import { executeTool, handleMessage } from '../src/mcp/core.js';
import { handleMcpHttpRequest } from '../src/mcp/http.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { createTopicFixture } from './fixtures/topic-analysis-fixture.js';

const CASES = [
  ['literature_review', 'corpora', {}, 'list_corpora', null],
  ['literature_review', 'status', {}, 'corpus_status', null],
  ['literature_review', 'sources', {}, 'corpus_sources', null],
  ['literature_review', 'search', {query:'feedback'}, 'research_lookup', 'query'],
  ['literature_review', 'paper', {paperId:'p1'}, 'agent_materials', 'paper_material_view'],
  ['literature_review', 'survey', {query:'feedback'}, 'agent_materials', 'research_material_pack'],
  ['literature_review', 'discover', {query:'feedback'}, 'literature_discovery', 'submit'],
  ['literature_review', 'discovery_status', {runId:'run-1'}, 'literature_discovery_progress', null],
  ['literature_review', 'discovery_report', {runId:'run-1'}, 'literature_discovery', 'report'],
  ['literature_review', 'import', {serverFilePath:'/tmp/paper.pdf'}, 'import_workflow', 'submit'],
  ['literature_review', 'import_status', {taskId:'task-1'}, 'import_workflow', 'status'],
  ['lineage_analysis', 'overview', {}, 'research_lookup', 'topic_analysis'],
  ['lineage_analysis', 'problem', {query:'feedback'}, 'research_lookup', 'problem_evolution'],
  ['lineage_analysis', 'method', {method:'m2'}, 'research_lookup', 'method_lineage'],
  ['lineage_analysis', 'evidence', {edgeId:'evolution'}, 'research_lookup', 'method_evidence'],
  ['lineage_analysis', 'path', {from:'q1',to:'m1'}, 'research_briefing', 'path_trace'],
  ['lineage_analysis', 'context', {query:'q1'}, 'research_lookup', 'context'],
  ['lineage_analysis', 'impact', {query:'q1'}, 'research_lookup', 'impact'],
  ['idea_generation', 'generate', {query:'feedback'}, 'research_lookup', 'ideas'],
  ['idea_generation', 'diverge', {query:'feedback'}, 'research_lookup', 'brainstorm'],
  ['idea_generation', 'converge', {query:'feedback'}, 'research_lookup', 'brainstorm'],
  ['idea_generation', 'gaps', {query:'feedback'}, 'agent_materials', 'structural_gap_pack'],
  ['idea_generation', 'evaluate', {query:'feedback',candidateMechanism:'calibrated control'}, 'agent_materials', 'innovation_evidence_pack'],
  ['idea_generation', 'experiment_materials', {query:'feedback'}, 'agent_materials', 'experiment_cost_materials']
];

test('default three tools reduce discovery size while legacy schemas remain available', async () => {
  assert.deepEqual(listMcpTools({toolProfile:'research'}).map((tool) => tool.name), ['literature_review','lineage_analysis','idea_generation']);
  assert.equal(listMcpTools({toolProfile:'legacy'}), PAPERNEXUS_TOOLS);
  assert.equal(PAPERNEXUS_TOOLS.length, 23);
  assert.equal(listMcpTools({toolProfile:'all'}).length, 26);
  assert.ok(Buffer.byteLength(JSON.stringify(RESEARCH_TOOLS)) < Buffer.byteLength(JSON.stringify(PAPERNEXUS_TOOLS)) / 2);
  const oldEnv = process.env.PAPERNEXUS_MCP_TOOL_PROFILE;
  try {
    delete process.env.PAPERNEXUS_MCP_TOOL_PROFILE;
    assert.equal(resolveMcpToolProfile(), 'research');
    assert.equal(resolveMcpToolProfile({config:{serve:{mcp:{toolProfile:'legacy'}}}}), 'legacy');
    process.env.PAPERNEXUS_MCP_TOOL_PROFILE = 'all';
    assert.equal(resolveMcpToolProfile({config:{serve:{mcp:{toolProfile:'legacy'}}}}), 'all');
    assert.equal(resolveMcpToolProfile({toolProfile:'research'}), 'research');
    assert.throws(() => resolveMcpToolProfile({toolProfile:'typo'}), /Unknown MCP tool profile/);
  } finally {
    if (oldEnv === undefined) delete process.env.PAPERNEXUS_MCP_TOOL_PROFILE;
    else process.env.PAPERNEXUS_MCP_TOOL_PROFILE = oldEnv;
  }
  const snapshotPath = new URL('./fixtures/mcp-research-tools.snapshot.json', import.meta.url);
  const snapshot = JSON.stringify(RESEARCH_TOOLS, null, 2) + '\n';
  if (process.env.UPDATE_PAPERNEXUS_RESEARCH_SCHEMA === '1') await fs.writeFile(snapshotPath, snapshot);
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), snapshot);
});

test('every public operation has one reviewed route and preserves backend evidence', async () => {
  assert.equal(CASES.length + 1, Object.values(RESEARCH_ROUTES).reduce((n, routes) => n + Object.keys(routes).length, 0));
  for (const [tool, operation, fields, backend, backendOperation] of CASES) {
    const args = {operation, corpus:'fixture', ...fields};
    let calls = 0;
    const result = await executeResearchWorkflow(tool, args, {}, async (name, translated) => {
      calls++;
      assert.equal(name, backend, tool + '/' + operation);
      assert.equal(translated.operation || null, backendOperation);
      return {status:'partial', evidence:[{paperId:'p1', quote:'Accuracy 95.2'}]};
    });
    assert.equal(calls, 1);
    assert.equal(result.result.status, 'partial');
    assert.equal(result.result.evidence[0].quote, 'Accuracy 95.2');
    assert.equal(Object.hasOwn(result, 'status'), false);
    assert.equal(result.backend.tool, backend);
    for (const next of result.nextActions) assert.ok(resolveResearchWorkflowCall(next.tool, next.arguments));
  }
});

test('operation-specific validation rejects hidden side effects before any backend call', async () => {
  let calls = 0;
  const invoke = async () => { calls++; };
  const invalid = [
    ['literature_review', {operation:'search',query:'x',options:{importResolved:true}}],
    ['literature_review', {operation:'search',query:'x',serverFilePath:'/tmp/secret'}],
    ['literature_review', {operation:'search',query:' '}],
    ['literature_review', {operation:'discover'}],
    ['literature_review', {operation:'import',serverFilePath:'/tmp/a',runId:'r'}],
    ['literature_review', {operation:'import_status',jobId:'j',taskId:'t'}],
    ['lineage_analysis', {operation:'impact',query:'x',direction:'both'}],
    ['lineage_analysis', {operation:'method',method:'x',maxDepth:999}],
    ['lineage_analysis', {operation:'overview',fromYear:2025,toYear:2020}],
    ['lineage_analysis', {operation:'path',from:'x'}],
    ['lineage_analysis', {operation:'__proto__'}],
    ['idea_generation', {operation:'generate',query:'x',writeBack:true}],
    ['idea_generation', {operation:'generate',query:'x',selectionMode:'mmr'}],
    ['idea_generation', {operation:'evaluate',query:'x'}],
    ['idea_generation', {operation:'gaps',query:'x',includeProviderEvidence:true}],
    ['idea_generation', {operation:'gaps',query:'x',limit:'5'}]
  ];
  for (const [tool, args] of invalid) await assert.rejects(executeResearchWorkflow(tool, args, {}, invoke));
  assert.equal(calls, 0);
});

test('parameter mapping keeps ranking, direction, hypothesis and submission boundaries', async () => {
  const search = resolveResearchWorkflowCall('literature_review', {operation:'search',query:'x',sortBy:'date',limit:3});
  assert.equal(search.args.options.sortBy, 'date');
  assert.equal(search.args.options.limit, 3);
  const forward = resolveResearchWorkflowCall('lineage_analysis', {operation:'impact',query:'x',direction:'forward'});
  assert.equal(forward.args.options.direction, 'downstream');
  const brainstorm = resolveResearchWorkflowCall('idea_generation', {operation:'converge',query:'x',maxDepth:4});
  assert.equal(brainstorm.args.options.mode, 'converge');
  assert.equal(brainstorm.args.options.maxHops, 4);
  const catalyst = resolveResearchWorkflowCall('idea_generation', {operation:'generate',query:'x',targetDomain:'Education',selectionMode:'mmr'});
  assert.equal(catalyst.backend, 'idea_catalyst');
  assert.equal(catalyst.args.mode, 'graph');
  assert.equal(catalyst.args.writeBack, false);
  const gaps = resolveResearchWorkflowCall('idea_generation', {operation:'gaps',query:'x'});
  assert.equal(gaps.args.includeLiveDiscoveryEvidence, false);
  assert.equal(gaps.args.outputDir, '');
  const discovery = resolveResearchWorkflowCall('literature_review', {operation:'discover',query:'x'});
  assert.equal(discovery.args.discoveryOperation, 'search');
  assert.equal(discovery.args.importResolved, false);
  assert.equal(discovery.args.processImports, false);
  const imported = await executeResearchWorkflow('literature_review', {operation:'import',serverFilePath:'/tmp/paper.md'}, {}, async () => JSON.stringify({jobId:'pn-job',status:'queued'}));
  assert.deepEqual(imported.nextActions, [{tool:'literature_review',arguments:{operation:'import_status',jobId:'pn-job'}}]);
  assert.equal(imported.result.status, 'queued');
  const completed = await executeResearchWorkflow('literature_review', {operation:'import_status',jobId:'pn-job'}, {}, async () => ({status:'completed',result:{taskId:'task-1'}}));
  assert.deepEqual(completed.nextActions[0].arguments, {operation:'import_status',taskId:'task-1'});
  assert.match(completed.evidenceBoundary.statusAuthority, /graph-sync/);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-three-tools-'));
  const paths = getCorpusPaths(root);
  const graph = createTopicFixture();
  await fs.mkdir(paths.corpusDir, {recursive:true});
  await fs.writeFile(paths.metaPath, JSON.stringify({name:'workflow-fixture',rootPath:root,nodeCount:graph.nodeCount,relationshipCount:graph.relationshipCount}));
  await fs.writeFile(paths.liteGraphPath, JSON.stringify(graph.toJSON()));
  return {root,paths};
}

test('three real graph workflows retain results and leave graph bytes unchanged', async () => {
  const {root,paths} = await fixture();
  const before = await fs.readFile(paths.liteGraphPath, 'utf8');
  try {
    for (const [tool,args] of [
      ['literature_review',{operation:'search',query:'feedback',limit:4}],
      ['lineage_analysis',{operation:'method',method:'m2',maxDepth:3}],
      ['idea_generation',{operation:'generate',query:'feedback',limit:4}]
    ]) {
      const canonical = await executeTool(tool, {corpus:root,...args});
      const call = resolveResearchWorkflowCall(tool, {corpus:root,...args});
      const old = await executeTool(call.backend, call.args);
      assert.deepEqual(canonical.result.result, old.result);
    }
    for (const operation of ['overview','problem']) {
      const result = await executeTool('lineage_analysis', {operation,corpus:root,query:'feedback',maxNodes:5});
      assert.ok(result.result.result.graph.nodes.length <= 5);
      assert.ok(result.result.result.scope.truncated);
    }
    const empty = await executeTool('literature_review', {operation:'search',corpus:root,query:'zzzznohit'});
    assert.deepEqual(empty.result.result.groups, []);
    assert.equal(await fs.readFile(paths.liteGraphPath, 'utf8'), before);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('HTTP exposes three tools, executes each workflow, and still accepts legacy calls', {timeout:30000}, async () => {
  const {root} = await fixture();
  const server = http.createServer((request,response) => {
    void handleMcpHttpRequest(request,response,{toolProfile:'research'}).catch(() => response.destroy());
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port = server.address().port;
  const rpc = async (method,params) => {
    const response = await fetch('http://127.0.0.1:' + port + '/mcp',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)
    });
    return response.json();
  };
  try {
    assert.equal((await rpc('tools/list',{})).result.tools.length,3);
    for (const [name,operation] of [['literature_review','search'],['lineage_analysis','overview'],['idea_generation','generate']]) {
      const response = await rpc('tools/call',{name,arguments:{operation,corpus:root,query:'feedback'}});
      assert.equal(JSON.parse(response.result.content[0].text).tool,name);
    }
    const old = await rpc('tools/call',{name:'research_lookup',arguments:{operation:'query',corpus:root,query:'feedback'}});
    assert.ok(JSON.parse(old.result.content[0].text).result.groups.length);
    const invalid = await rpc('tools/call',{name:'idea_generation',arguments:{operation:'generate',query:'feedback',writeBack:true}});
    assert.match(invalid.error.message,/does not accept/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('stdio uses the same default list and canonical prompts; legacy profile restores old prompts', {timeout:20000}, async () => {
  const child = spawn(process.execPath,['--input-type=module','-e',"import {startMcpServer} from './src/mcp/stdio.js'; startMcpServer();"],{
    env:{...process.env,PAPERNEXUS_MCP_TOOL_PROFILE:'research'},stdio:['pipe','pipe','pipe']
  });
  let buffer=Buffer.alloc(0);
  const response = new Promise((resolve,reject) => {
    child.once('error',reject);
    child.stdout.on('data',(chunk) => {
      buffer=Buffer.concat([buffer,chunk]);
      const split=buffer.indexOf('\r\n\r\n');
      if(split<0) return;
      const size=Number(buffer.subarray(0,split).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
      if(buffer.length>=split+4+size) resolve(JSON.parse(buffer.subarray(split+4,split+4+size).toString()));
    });
  });
  try {
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
    child.stdin.write('Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);
    assert.deepEqual((await response).result.tools.map((tool)=>tool.name),RESEARCH_TOOLS.map((tool)=>tool.name));
    const modern=await handleMessage({method:'prompts/get',params:{name:'brainstorm_topic'}},{toolProfile:'research'});
    assert.match(modern.messages[0].content.text,/idea_generation/);
    const legacy=await handleMessage({method:'prompts/get',params:{name:'brainstorm_topic'}},{toolProfile:'legacy'});
    assert.match(legacy.messages[0].content.text,/Call brainstorm with mode diverge/);
  } finally {
    const closed=once(child,'close');
    child.kill('SIGTERM');
    await closed;
  }
});
