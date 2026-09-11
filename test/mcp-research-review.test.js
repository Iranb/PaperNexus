import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/mcp/core.js';
import { executeResearchWorkflow, RESEARCH_TOOLS } from '../src/mcp/research-workflows.js';
import { createTopicFixture } from './fixtures/topic-analysis-fixture.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';

test('default lineage workflow preserves structured transfer conditions end to end', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-review-conditions-'));
  const paths = getCorpusPaths(root);
  const original = JSON.stringify(createTopicFixture().toJSON());
  await fs.mkdir(paths.corpusDir, {recursive:true});
  await fs.writeFile(paths.metaPath, JSON.stringify({name:'conditions-fixture', rootPath:root}));
  await fs.writeFile(paths.liteGraphPath, original);
  try {
    const result = await executeTool('lineage_analysis', {
      operation:'overview', corpus:root, query:'feedback', maxDepth:4,
      constraints:{labelsAvailable:false, maxLatencyMs:40}
    });
    const analysis = result.result.result;
    assert.deepEqual(analysis.constraints, {labelsAvailable:false, maxLatencyMs:40});
    assert.ok(analysis.adaptations.some((entry) => entry.excluded.some((method) =>
      method.conditions.conflicts.some((condition) => condition.key === 'labelsAvailable'))));
    assert.ok(analysis.adaptations.every((entry) => entry.candidates.length === 0));
    assert.equal(await fs.readFile(paths.liteGraphPath, 'utf8'), original);
  } finally {
    await fs.rm(root, {recursive:true, force:true});
  }
});

test('structured conditions are bounded primitives and remain distinct from material query text', async () => {
  const schema = RESEARCH_TOOLS.find((tool) => tool.name === 'lineage_analysis').inputSchema;
  assert.ok(schema.properties.constraints.oneOf.some((entry) => entry.type === 'object'));
  let calls = 0;
  const invoke = async () => { calls++; return {}; };
  for (const constraints of [null, {nested:{writeBack:true}}, {labelsAvailable:[]},
    {maxLatencyMs:Infinity}, Object.fromEntries(Array.from({length:31}, (_, n) => ['field' + n, true]))]) {
    await assert.rejects(executeResearchWorkflow('lineage_analysis', {
      operation:'overview', query:'feedback', constraints
    }, {}, invoke), /Invalid constraints/);
  }
  await assert.rejects(executeResearchWorkflow('idea_generation', {
    operation:'gaps', query:'feedback', constraints:{labelsAvailable:false}
  }, {}, invoke), /Invalid constraints/);
  assert.equal(calls, 0);
});
