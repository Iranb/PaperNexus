#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { handleMcpHttpRequest } from '../src/mcp/http.js';
import { getCorpusPaths } from '../src/storage/corpus-store.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { MUTATIONS } from '../src/core/research/decision-contracts.js';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(`${file}.tmp`, file);
};

export async function loadFeedbackSources(input) {
  const sourceMap = await readJson(path.join(input, 'source-map.json'));
  if (sourceMap.kind !== 'measured_historical' || sourceMap.units?.accuracy !== 'percent' || sourceMap.units?.contrast !== 'pp') throw new Error('Expected measured historical sources with percent and pp units.');
  const files = {};
  for (const source of sourceMap.files) files[source.path] = await fs.readFile(path.resolve(input, source.path), 'utf8');
  const analysis = JSON.parse(files[sourceMap.primary_source]);
  for (const arm of ['sampled', 'complete']) for (const quantity of ['new', 'old', 'all']) if (!Number.isFinite(analysis.arms?.[arm]?.final?.[quantity])) throw new Error(`Missing ${arm}/${quantity}`);
  for (const quantity of ['new', 'old', 'all']) if (Math.abs(analysis.arms.complete.final[quantity] - analysis.arms.sampled.final[quantity] - analysis.contrasts[quantity].estimate_pp) > 1e-9) throw new Error(`Inconsistent measured contrast ${quantity}`);
  return { source_map: sourceMap, files, analysis };
}

export function historicalRequests(sources, corpus) {
  const data = sources.analysis, project = 'fsgcd-feedback';
  const sourceRef = { evidence_origin: 'external_measured', source_id: 'fsgcd-paired-analysis', source_version: data.analyzed_at,
    locator: 'contrasts', artifact_path: path.join(corpus, 'sources', sources.source_map.primary_source) };
  const protocol = structuredClone(data.protocol), protocolFields = Object.keys(protocol);
  const hypotheses = [
    { hypothesis_id: 'coverage-gain', version: 1, statement: 'Complete candidate coverage yields at least one point of NEW improvement.',
      mechanism: 'Additional candidate coverage changes pseudo-label supervision and triplet population.', expected: { kind: 'lower_bound', value: 1 }, prediction_id: 'gain-NEW', other: 'no-gain' },
    { hypothesis_id: 'no-gain', version: 1, statement: 'Complete candidate coverage does not improve NEW within the fixed-model comparison.',
      mechanism: 'Improved pseudo-label precision need not improve novel-class separation.', expected: { kind: 'upper_bound', value: 0 }, prediction_id: 'no-gain-NEW', other: 'coverage-gain' }
  ].map(({ expected, prediction_id, other, ...h }) => ({ ...h, scope: { dataset: protocol.dataset, primary_checkpoint: protocol.primary_checkpoint },
    intervention: 'complete candidate pool', control: 'sampled candidate pool', candidate_refs: ['candidate-complete-coverage'], evidence_refs: [sourceRef],
    alternative_hypothesis_ids: [other], predictions: [{ prediction_id, quantity: 'NEW', unit: 'pp', comparison_id: 'original', inference_target: 'fixed_model', expected, minimum_meaningful_effect: 1 }],
    falsification_rule: { necessary_prediction_ids: [prediction_id], requires_confirmatory_analysis: true } }));
  const baseAction = { version: 1, protocol, required_protocol_fields: protocolFields, intervention: 'complete candidate pool', held_constant: ['split', 'initialization', 'training ID order', 'optimizer', 'fixed final endpoint'],
    measurements: ['NEW', 'OLD', 'ALL', 'pseudo_label_precision'], validity_checks: ['paired_initialization_and_order'],
    precision: { max_interval_width: 3, inference_target: 'fixed_model' },
    analysis: { analysis_set_id: 'historical-fixed-final', primary_outcome: 'NEW', primary_comparison_id: 'original', look_policy: 'fixed_final', multiplicity: 'single_primary', stopping_rule: 'epoch 200 final' },
    estimated_cost: { upper: { gpu_hours: [{ resource: 'historical-V100', amount: 20 }], provider_calls: 0 } },
    stopping_rule: 'Fixed final checkpoint; historical record only.', evidence_refs: [sourceRef],
    result_branches: [{ when: 'NEW decreases while OLD increases', next: 'Diagnose the tradeoff and competing mechanisms.' }, { when: 'NEW improves', next: 'Check original-baseline guards and independent uncertainty.' }] };
  const actions = [
    { ...baseAction, action_id: 'sampled-baseline', type: 'diagnostic', title: 'Historical sampled reference', hypothesis_versions: [], prediction_ids: [] },
    { ...baseAction, action_id: 'complete-coverage', type: 'controlled_experiment', title: 'Historical complete candidate control',
      hypothesis_versions: hypotheses.map(h => ({ hypothesis_id: h.hypothesis_id, version: 1 })), prediction_ids: hypotheses.flatMap(h => h.predictions.map(p => p.prediction_id)),
      evaluation_plan: { inference_target: 'fixed_model', comparators: [{ comparison_id: 'original', role: 'original', reference: { kind: 'run_record', record_id: 'sampled-final' }, required_protocol_fields: protocolFields }], outcomes: [
        { quantity: 'NEW', unit: 'pp', direction: 'higher', role: 'primary', minimum_effect: 1, comparison_ids: ['original'] },
        { quantity: 'OLD', unit: 'pp', direction: 'higher', role: 'guardrail', max_regression: 2, comparison_ids: ['original'] },
        { quantity: 'ALL', unit: 'pp', direction: 'higher', role: 'guardrail', max_regression: 0.5, comparison_ids: ['original'] },
        { quantity: 'pseudo_label_precision', unit: 'pp', direction: 'higher', role: 'diagnostic', minimum_effect: 5, comparison_ids: ['original'] }
      ] } }
  ];
  const makeRun = arm => ({ record_id: `${arm}-final`, executor_id: 'fsgcd-historical-executor', run_id: data.arms[arm].job_id, attempt_id: 'a1', source_revision: 1,
    status: 'completed', action_id: arm === 'sampled' ? 'sampled-baseline' : 'complete-coverage', action_version: 1,
    registration_receipt: 'feedback-register-actions', started_at: data.arms[arm].started_at, ended_at: data.arms[arm].ended_at,
    protocol, analysis: baseAction.analysis, intervention_checks: [{ check: 'paired_initialization_and_order', passed: true, reference: `${sourceRef.artifact_path}#/paired_checks` }],
    measurements: [...['new', 'old', 'all'].map(key => ({ quantity: key.toUpperCase(), unit: 'percent', value_kind: 'absolute', estimate: data.arms[arm].final[key] })),
      { quantity: 'pseudo_label_precision', unit: 'percent', value_kind: 'absolute', estimate: data.arms[arm].mean_transfer_precision_percent }],
    actual_cost: { gpu_hours: [{ resource: 'historical-V100', amount: data.arms[arm].gpu_hours }], provider_calls: 0 }, cost_final: true,
    evidence_origin: 'external_measured', artifact_refs: [sourceRef], independent_group: 'historical-paired-seed-0' });
  const sampled = makeRun('sampled'), complete = makeRun('complete');
  complete.comparisons = [{ comparison_id: 'original', reference: { kind: 'run_record', record_id: sampled.record_id }, kind: 'matched_reproduced', measurements: [
    ...['new', 'old', 'all'].map(key => ({ quantity: key.toUpperCase(), unit: 'pp', value_unit: 'percent', value_kind: 'difference',
      candidate_estimate: data.arms.complete.final[key], reference_estimate: data.arms.sampled.final[key], estimate: data.contrasts[key].estimate_pp,
      interval: { lower: data.contrasts[key].interval95_pp[0], upper: data.contrasts[key].interval95_pp[1] },
      uncertainty: { method: data.uncertainty.method, level: data.uncertainty.confidence_level, independent_unit: 'image',
        unit_count: key === 'new' ? data.counts.new_unlabelled : key === 'old' ? data.counts.old_unlabelled : data.counts.unlabelled,
        inference_target: 'fixed_model', calculation_ref: `${sourceRef.artifact_path}#/uncertainty`, review: { status: 'unreviewed' } } })),
    { quantity: 'pseudo_label_precision', unit: 'pp', value_unit: 'percent', value_kind: 'difference',
      candidate_estimate: data.arms.complete.mean_transfer_precision_percent, reference_estimate: data.arms.sampled.mean_transfer_precision_percent, estimate: data.transfer_precision_delta_pp }
  ] }];
  let revision = 0;
  const call = (operation, payload, requestId) => {
    const request = { tool: 'research_decision', arguments: { operation, corpus, project, payload,
      requestId, ...(operation === 'init' ? {} : { expectedRevision: revision }) } };
    revision += 1;
    return request;
  };
  const requests = [
    call('init', { objective: 'Read historical FSGCD feedback without replacing its baseline or inference scope.', goal_phase: 'mechanism_validation',
      budget: { gpu_hours: [{ resource: 'historical-V100', limit: 100 }], provider_calls: { limit: 0 } } }, 'feedback-init'),
    call('register_hypotheses', { hypotheses }, 'feedback-register-hypotheses'),
    call('register_actions', { actions }, 'feedback-register-actions')
  ];
  for (const run of [sampled, complete]) {
    run.manifest_path = path.join(corpus, `${run.record_id}.manifest.json`);
    requests.push(call('record_run', { run }, `feedback-${run.record_id}`));
  }
  requests.push(call('assess_results', { run_record_ids: [complete.record_id], hypothesis_versions: hypotheses.map(h => ({ hypothesis_id: h.hypothesis_id, version: 1 })) }, 'feedback-assess'));
  const read = (tool, operation, extra = {}) => ({ tool, arguments: { operation, corpus, project, responseMode: 'full', ...extra } });
  requests.push(read('research_decision', 'evidence_view'), read('idea_generation', 'generate', { query: 'complete candidate coverage NEW' }),
    read('idea_generation', 'evaluate', { purpose: 'mechanism_diagnosis', actionId: 'complete-coverage' }),
    read('research_decision', 'recommend_next'), read('research_decision', 'export'));
  return requests;
}

export async function openFeedbackServer() {
  const server = http.createServer((request, response) => { void handleMcpHttpRequest(request, response, { toolProfile: 'research' }).catch(() => response.destroy()); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let id = 0;
  return { url, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    call: async request => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: request.tool, arguments: request.arguments } }), signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (body.error || body.result?.isError) throw new Error(JSON.stringify(body.error || body.result));
      return JSON.parse(body.result.content[0].text);
    } };
}

export async function prepareFeedbackAblation(sources, output, seed) {
  const phases = [
    { id: 'after-complete-results', files: ['ANALYSIS.json'], question: 'What do the final primary and guard outcomes establish, and what remains unresolved?' },
    { id: 'after-error-decomposition', files: ['ANALYSIS.json', 'MECHANISM_REVIEW.json', 'BEFORE_GRAPH.md', 'ERROR_DECOMPOSITION.json', 'MAPPING_INVARIANT_REVIEW.json'], question: 'Which control could distinguish the remaining explanations, and what does the error decomposition not establish?' },
    { id: 'before-restoration-result', files: Object.keys(sources.files), question: 'Specify original and control comparisons, primary and secondary analyses, and inference limits before observing a restoration result.' }
  ];
  const labels = [];
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index], facts = Object.fromEntries(phase.files.map(name => [name, name.endsWith('.json') ? JSON.parse(sources.files[name]) : sources.files[name]]));
    const edges = ['new', 'old', 'all'].map(quantity => ({ from: `ANALYSIS.json#/arms/sampled/final/${quantity}`, to: `ANALYSIS.json#/arms/complete/final/${quantity}`,
      relation: 'paired_comparison', evidence_refs: [`ANALYSIS.json#/contrasts/${quantity}`, 'ANALYSIS.json#/paired_checks'], status: 'measured_association' }));
    const flatten = (value, locator = '') => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => flatten(item, `${locator}/${key}`)) : [`${locator}: ${JSON.stringify(value)}`];
    const arms = [
      { condition: 'A', material: flatten(facts).join('\n') },
      { condition: 'B', material: facts },
      { condition: 'C', material: { facts, edges } }
    ];
    const offset = (seed + index) % 3;
    for (let n = 0; n < 3; n++) {
      const arm = arms[(n + offset) % 3], packet = `${phase.id}/packet-${n + 1}`;
      await writeJson(path.join(output, 'visible', packet, 'input.json'), { question: phase.question, source_ids: phase.files, material: arm.material });
      labels.push({ packet, condition: arm.condition, source_ids: phase.files });
    }
  }
  await writeJson(path.join(output, 'evaluation-only', 'labels.json'), labels);
  await writeJson(path.join(output, 'evaluation-only', 'review-template.json'), { status: 'pending_review', reviewer: null,
    criteria: ['wrong_baseline', 'unsupported_causality', 'unsupported_training_stability', 'unsupported_novelty', 'unjustified_repeat', 'discriminating_prediction', 'competing_explanations_retained'],
    results: [], model_plan: { model: 'gpt-5.6-luna', reasoning_effort: 'max', generations_per_packet: 3, total_calls: 27, output_token_limit_per_call: 8000,
      status: 'not_executed', money_limit: 'must be set before any paid execution', required_logs: ['model_version', 'raw_request', 'raw_response', 'tool_calls', 'tokens', 'cost', 'elapsed_seconds'] } });
  return { status: 'prepared', mode: 'prepare-ablation', seed, packets: labels.length, calls_executed: 0, review_status: 'pending',
    limitations: ['Equivalent source facts are present in every condition at each decision point.', 'No external model, blind review or graph utility comparison was executed.'] };
}

export async function evaluateResearchFeedback({ input, output, mode = 'engineering', seed = 17, resume = false, onStep } = {}) {
  input = path.resolve(input); output = path.resolve(output);
  if (!['engineering', 'prepare-ablation'].includes(mode) || !Number.isInteger(seed) || seed < 0) throw new Error('Invalid mode or seed.');
  const sources = await loadFeedbackSources(input);
  const config = { input, mode, seed, source_map: sources.source_map, frozen_sources: sources.files };
  let exists = false;
  try { await fs.access(output); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    let report; try { report = await readJson(path.join(output, 'evaluation.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (report || !resume) return { status: 'existing_output', saved_status: report?.status || 'incomplete', output };
    if (!isDeepStrictEqual(await readJson(path.join(output, 'config.json')), config)) throw new Error('Resume input, source versions, mode or seed changed; use a new output directory.');
  } else {
    if (resume) throw new Error('No output exists to resume.');
    await fs.mkdir(output, { recursive: true }); await writeJson(path.join(output, 'config.json'), config);
  }
  if (mode === 'prepare-ablation') {
    const report = await prepareFeedbackAblation(sources, output, seed); await writeJson(path.join(output, 'evaluation.json'), report); return report;
  }
  const corpus = path.join(output, 'corpus'), paths = getCorpusPaths(corpus);
  const requests = historicalRequests(sources, corpus), requestFile = path.join(output, 'requests.json');
  await preserveReplayFile(requestFile, JSON.stringify(requests, null, 2) + '\n');
  await preserveReplayFile(paths.metaPath, JSON.stringify({ name: 'feedback-fixture', rootPath: corpus }, null, 2) + '\n');
  await preserveReplayFile(paths.liteGraphPath, JSON.stringify(createKnowledgeGraph().toJSON(), null, 2) + '\n');
  for (const [name, contents] of Object.entries(sources.files)) await preserveReplayFile(path.join(corpus, 'sources', name), contents);
  for (const request of requests.filter(r => r.arguments.operation === 'record_run')) await preserveReplayFile(request.arguments.payload.run.manifest_path, JSON.stringify({ run: request.arguments.payload.run }, null, 2) + '\n');
  const traceFile = path.join(output, 'trace.json');
  let trace = [];
  if (exists) try { trace = await readJson(traceFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const start = performance.now(), usage = process.cpuUsage();
  let server = await openFeedbackServer();
  try {
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index], mutation = request.tool === 'research_decision' && MUTATIONS.includes(request.arguments.operation);
      if (trace.some(entry => entry.index === index)) continue;
      if (!mutation && index === 6) { await server.close(); server = await openFeedbackServer(); }
      let response;
      if (resume && mutation) {
        const saved = await server.call({ tool: 'research_decision', arguments: { operation: 'status', corpus, project: 'fsgcd-feedback', requestId: request.arguments.requestId } });
        if (saved.result.status === 'committed') response = { ...saved.result.receipt.response, recovered_from_receipt: true };
      }
      if (!response) response = await server.call(request);
      if (onStep) await onStep({ index, request, response });
      trace.push({ index, request, response }); await writeJson(traceFile, trace);
    }
    const resultFor = (tool, operation) => trace.find(t => t.request.tool === tool && t.request.arguments.operation === operation).response.result;
    const view = resultFor('research_decision', 'evidence_view'), generated = resultFor('idea_generation', 'generate'), task = resultFor('idea_generation', 'evaluate');
    const complete = view.comparison_summary.find(c => c.run_record_id === 'complete-final');
    const checks = {
      historical_pair_readable: view.observations.length === 2,
      comparison_retains_tradeoff: complete.status === 'tradeoff',
      primary_value_preserved: complete.comparisons.find(r => r.quantity === 'NEW').measurement.estimate === sources.analysis.contrasts.new.estimate_pp,
      original_baseline_preserved: complete.comparisons.every(r => r.comparison_id === 'original'),
      fixed_model_scope: complete.inference_target === 'fixed_model',
      retrospective_not_confirmatory: complete.comparisons.every(r => !r.confirmatory),
      two_physical_attempts: view.budget.attempts === 2,
      historical_cost_once: Math.abs(view.budget.dimensions['gpu_hours:historical-V100'].spent - sources.analysis.new_gpu_hours_full_pair) < 1e-9,
      feedback_used_in_focus: generated.research_focus.some(h => h.run_record_ids.includes('complete-final')),
      no_novelty_upgrade: task.novelty_claim_allowed === false,
      reads_keep_revision: trace.filter(t => !MUTATIONS.includes(t.request.arguments.operation)).every(t => (t.response.revision ?? t.response.result.project_evidence?.based_on_revision) === 6),
      no_execution_submission: trace.every(t => !(t.request.tool === 'literature_review' && ['discover', 'import'].includes(t.request.arguments.operation)))
    };
    const cpu = process.cpuUsage(usage);
    const report = { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', mode, seed, input, output, checks,
      historical_run_cost: view.budget, validation_cost: { elapsed_seconds: (performance.now() - start) / 1000, cpu_seconds: (cpu.user + cpu.system) / 1e6, gpu_hours: 0, provider_calls: 0, money: 'unknown', scope: resume ? 'this resume invocation' : 'this invocation' },
      primary_result: complete, task_gate: task.task_gate,
      limitations: ['Historical plans are replayed retrospectively; this is not a new prospective scientific assessment.', 'One paired training seed and fixed-model uncertainty only.', 'No graph-versus-text model evaluation or remote deployment was performed.'] };
    await writeJson(path.join(output, 'evaluation.json'), report);
    await fs.writeFile(path.join(output, 'report.md'), resultFor('research_decision', 'export').markdown);
    return report;
  } finally { await server.close(); }
}

async function preserveReplayFile(file, contents) {
  try {
    if (await fs.readFile(file, 'utf8') !== contents) throw new Error(`Frozen replay input changed: ${file}; use a new output directory.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, contents); await fs.rename(`${file}.tmp`, file);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' }, mode: { type: 'string', default: 'engineering' }, seed: { type: 'string' }, resume: { type: 'boolean', default: false } } });
  if (!values.input || !values.output || !/^\d+$/.test(values.seed || '')) throw new Error('Use --input DIRECTORY --output DIRECTORY --mode engineering|prepare-ablation --seed INTEGER [--resume].');
  const report = await evaluateResearchFeedback({ ...values, seed: Number(values.seed) });
  console.log(JSON.stringify({ status: report.status, output: path.resolve(values.output), checks: report.checks, saved_status: report.saved_status }, null, 2));
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
