#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createMechanismFixture } from '../test/fixtures/research-decision/mechanisms.js';
import { readDecisionState } from '../src/core/research/decision-store.js';
import { executeTool } from '../src/mcp/core.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { loadFeedbackSources, historicalRequests } from './evaluate-research-feedback.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output) throw new Error('Use --output DIRECTORY. This local evaluation launches no experiments or providers.');
const output = path.resolve(values.output);
await fs.mkdir(output, { recursive: true });
const save = async (name, value) => {
  const target = path.join(output, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n');
};
try {
  const saved = JSON.parse(await fs.readFile(path.join(output, 'evaluation.json'), 'utf8'));
  console.log(JSON.stringify({ status: 'existing_output', saved_status: saved.status, output }));
  process.exit(saved.status === 'passed' ? 0 : 1);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const start = performance.now(), cpuStart = process.cpuUsage();
const cases = [];
for (const scenario of ['complete-design', 'links-in-text-only', 'missing-basis', 'missing-control', 'changed-source', 'duplicate-design', 'independent-replication', 'changed-protocol', 'changed-comparator', 'retrieval']) {
  const begun = performance.now();
  const f = await createMechanismFixture(null, { retrieval: scenario === 'retrieval' });
  const trace = [];
  const call = async (operation, payload, extra) => {
    const response = await f.call(operation, payload, extra);
    trace.push({ operation, payload, extra, response });
    return response.result;
  };
  try {
    const structuredFacts = structuredClone(f.input.hypotheses);
    if (scenario === 'links-in-text-only') for (const h of f.input.hypotheses) {
      h.assumptions.push(JSON.stringify({ mechanism_links: h.mechanism_evidence.links }));
      h.mechanism_evidence.links = [];
    }
    if (scenario === 'missing-basis') for (const h of f.input.hypotheses) delete h.predictions[0].basis;
    if (scenario === 'missing-control') delete f.input.actions[1].controlled_components;
    await save(`${scenario}/inputs.json`, f.input);
    await save(`${scenario}/source-artifacts.json`, await Promise.all(f.refs.map(async ref => ({ ref, contents: await fs.readFile(ref.artifact_path, 'utf8') }))));
    await f.seed();
    if (scenario === 'changed-source') await fs.writeFile(f.refs[0].artifact_path, JSON.stringify({ source_id: f.refs[0].source_id, source_version: '2', admitted: true, evidence_origin: 'synthetic_fixture' }));
    let actionId = 'E1';
    if (['duplicate-design', 'independent-replication', 'changed-protocol', 'changed-comparator'].includes(scenario)) {
      await call('record_run', { run: f.run() });
      await call('assess_results', { run_record_ids: ['record-1'], hypothesis_versions: f.input.actions[1].hypothesis_versions });
      const action = { ...structuredClone(f.input.actions[1]), action_id: scenario };
      if (scenario === 'independent-replication') action.type = 'replicate';
      if (scenario === 'changed-protocol') action.protocol.steps++;
      if (scenario === 'changed-comparator') {
        const hypotheses = f.input.hypotheses.map(h => ({ ...structuredClone(h), version: 2, predictions: h.predictions.map(p => ({ ...p, comparison_id: 'new-comparator' })) }));
        await call('register_hypotheses', { hypotheses });
        action.hypothesis_versions.forEach(h => { h.version = 2; });
        [...action.intervention_components, ...action.controlled_components].forEach(c => { c.hypothesis_version = 2; });
      }
      await call('register_actions', { actions: [action] }); actionId = scenario;
    }
    const result = await call('recommend_next', { action_ids: [actionId] });
    const expected = scenario === 'duplicate-design' ? 'reuse_evidence'
      : ['links-in-text-only', 'missing-basis', 'missing-control', 'changed-source'].includes(scenario) ? 'needs_input'
      : scenario === 'changed-protocol' ? 'not reuse_evidence'
      : 'execute_action';
    const passed = scenario === 'changed-protocol' ? result.decision.kind !== 'reuse_evidence' : result.decision.kind === expected;
    cases.push({ case: scenario, kind: 'synthetic_behavior', expected, actual: result.decision.kind, passed, elapsed_ms: performance.now() - begun,
      reason_codes: result.blocked_actions.flatMap(a => a.reason_codes), action_id: result.decision.action_id || null });
    await save(`${scenario}/trace.json`, trace);
    await save(`${scenario}/state.json`, await readDecisionState(f.root, 'quality-vs-count'));
    if (scenario === 'complete-design') {
      const facts = { hypotheses: structuredFacts, actions: f.input.actions, prior_observations: [], time_cutoff: 'before-first-result', source_artifacts: await Promise.all(f.refs.map(async r => JSON.parse(await fs.readFile(r.artifact_path, 'utf8')))) };
      await save('ablation/common-facts.json', facts);
      await save('ablation/structured-input.json', facts);
      await fs.writeFile(path.join(output, 'ablation/text-input.txt'), JSON.stringify(facts, null, 2) + '\n');
      await save('ablation/protocol.json', { status: 'prepared_not_executed', same_information: true, conditions: ['text', 'graph', 'graph_with_selection'],
        input: 'common-facts.json', time_cutoff: facts.time_cutoff, model_calls: 0, observed_experimental_outcomes: 0,
        interpretation: 'The deterministic link-removal case tests the explicit input contract; it does not measure whether a model can recover those links from text.' });
    }
  } finally { await f.cleanup(); }
}

const historicalStart = performance.now();
const sourceDir = path.resolve('test/fixtures/research-feedback/measured');
const sources = await loadFeedbackSources(sourceDir);
const corpus = path.join(output, 'historical', 'corpus');
const paths = getCorpusPaths(corpus);
await fs.mkdir(paths.corpusDir, { recursive: true });
await fs.writeFile(paths.metaPath, JSON.stringify({ name: 'mechanism-historical', rootPath: corpus }));
for (const [name, contents] of Object.entries(sources.files)) {
  const target = path.join(corpus, 'sources', name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, contents);
}
const requests = historicalRequests(sources, corpus).filter(r => r.tool === 'research_decision');
const trace = [];
for (const request of requests) {
  const run = request.arguments.payload?.run;
  if (run) await fs.writeFile(run.manifest_path, JSON.stringify({ run }));
  trace.push({ request, response: await executeTool(request.tool, request.arguments) });
}
const view = trace.find(t => t.request.arguments.operation === 'evidence_view').response.result;
const rows = view.open_explanations.flatMap(h => h.rows);
const historical = { case: 'fsgcd-historical', kind: 'measured_historical', passed: rows.length > 0 && rows.every(r => !r.assessment_gate.confirmatory)
  && view.mechanism_analysis.evidence_gaps.some(g => g.kind === 'prediction_basis'),
  primary_result: view.comparison_summary.find(c => c.run_record_id === 'complete-final'),
  evidence_gaps: view.mechanism_analysis.evidence_gaps, historical_budget: view.budget,
  comparison: sources.source_map.comparison_label, paper_report_comparison: sources.source_map.paper_report_comparison,
  proposed_unexecuted_controls: ['Shuffle labels while holding branch populations fixed.', 'Match gradient scale and branch population while changing label information.'],
  control_measurements: [], elapsed_ms: performance.now() - historicalStart,
  limitation: 'The historical pair does not supply a quantitative bound on an optimization mechanism. Unexecuted controls have no outcome or success rate.' };
cases.push(historical);
await save('historical/requests.json', requests); await save('historical/trace.json', trace);
const cpu = process.cpuUsage(cpuStart);
const report = { status: cases.every(c => c.passed) ? 'passed' : 'failed', cases,
  validation_cost: { elapsed_ms: performance.now() - start, cpu_seconds: (cpu.user + cpu.system) / 1e6, new_gpu_hours: 0, provider_calls: 0 },
  limitations: ['Synthetic cases verify software behavior, not scientific benefit or GPU savings.', 'Historical FSGCD evidence remains one paired seed with fixed-model uncertainty.', 'Text/graph/model ablation is prepared, not executed. No remote deployment occurred.'] };
await save('evaluation.json', report);
await fs.writeFile(path.join(output, 'REPORT.md'), [
  '# Mechanism selection evaluation', '', `Status: ${report.status}; ${cases.filter(c => c.passed).length}/${cases.length} cases passed.`, '',
  '| Case | Evidence | Decision/result | Pass |', '| --- | --- | --- | --- |',
  ...cases.map(c => `| ${c.case} | ${c.kind} | ${c.actual || c.primary_result.status} | ${c.passed} |`), '',
  `Local elapsed: ${report.validation_cost.elapsed_ms.toFixed(1)} ms; CPU: ${report.validation_cost.cpu_seconds.toFixed(3)} s; new GPU hours: 0; provider calls: 0.`, '',
  '## Limitations', '', ...report.limitations.map(s => `- ${s}`), ''
].join('\n'));
console.log(JSON.stringify({ status: report.status, cases: cases.length, output, validation_cost: report.validation_cost }, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
