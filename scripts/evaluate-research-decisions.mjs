#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { executeResearchDecisionOperation } from '../src/core/research/decision-service.js';

const { values } = parseArgs({ options: { fixtures: { type: 'string', default: 'test/fixtures/research-decision' }, seed: { type: 'string' }, output: { type: 'string' } } });
if (!values.output || !/^\d+$/.test(values.seed || '')) throw new Error('Use --seed INTEGER --output NEW_DIRECTORY [--fixtures DIRECTORY].');
const output = path.resolve(values.output);
try {
  await fs.access(output);
  let saved;
  try { saved = JSON.parse(await fs.readFile(path.join(output, 'evaluation.json'), 'utf8')); } catch {}
  console.log(JSON.stringify({ status: 'existing_output', output, saved_status: saved?.status || 'incomplete', next: 'Inspect the saved trace to resume analysis, or choose a new output directory. No files were overwritten.' }, null, 2));
  process.exit(2);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const fixtures = path.resolve(values.fixtures);
const { createDecisionFixture } = await import(pathToFileURL(path.join(fixtures, 'scenarios.js')));
await fs.mkdir(output, { recursive: true });
let randomState = Number(values.seed) >>> 0;
const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
const cases = ['negative', 'wide', 'positive', 'unexplained', 'failed', 'mismatched', 'retrospective', 'unreviewed'];
for (let i = cases.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cases[i], cases[j]] = [cases[j], cases[i]]; }
const results = [];
for (const domain of ['gcd', 'retrieval']) for (const scenario of cases) {
  const start = performance.now(), trace = [];
  const directory = path.join(output, `${domain}-${scenario}`);
  await fs.mkdir(directory);
  const f = await createDecisionFixture(null, { retrieval: domain === 'retrieval', root: path.join(directory, 'corpus') });
  let revision = 0, sequence = 0;
  const call = async (operation, payload, extra = {}) => {
    const mutation = ['init', 'register_hypotheses', 'register_actions', 'record_run', 'assess_results', 'update_opportunities', 'refresh_evidence'].includes(operation);
    const request = { operation, project: 'quality-vs-count', ...(payload === undefined ? {} : { payload }),
      ...(mutation ? { requestId: `${operation}-${++sequence}`, ...(operation === 'init' ? {} : { expectedRevision: revision }) } : {}), ...extra };
    const response = await executeResearchDecisionOperation(f.root, request);
    revision = response.current_revision ?? response.revision;
    trace.push({ request, response });
    return response.result;
  };
  try {
    await call('init', f.input.init);
    await call('register_hypotheses', { hypotheses: f.input.hypotheses });
    await call('register_actions', { actions: f.input.actions }, { requestId: 'actions-1' });
    const visibleInputs = structuredClone(f.input);
    const first = await call('recommend_next');
    const priority = [...visibleInputs.candidate_priority_baseline].sort((a, b) => b.controller_utility - a.controller_utility)[0];
    const baseline = visibleInputs.actions.find(a => a.action_id === priority.action_id);
    const selected = visibleInputs.actions.find(a => a.action_id === first.decision.action_id);
    trace.push({ event: 'outcome_revealed_after_action_selection', scenario, baseline_action_id: baseline.action_id, policy_action_id: selected?.action_id });
    const run = f.run(['negative', 'wide', 'positive', 'unexplained'].includes(scenario) ? scenario : 'negative', { recommendation_ref: first.recommendation_ref });
    if (scenario === 'failed') run.status = 'failed';
    if (scenario === 'mismatched') run.protocol.split = 'different-test';
    if (scenario === 'retrospective') run.started_at = '2000-01-01T00:00:00Z';
    if (scenario === 'unreviewed') run.measurements[0].uncertainty.review.status = 'unreviewed';
    await call('record_run', { run });
    const beforeReplay = (await call('status')).budget;
    await call('record_run', { run });
    const afterReplay = (await call('status')).budget;
    const assessed = await call('assess_results', { run_record_ids: [run.record_id], hypothesis_versions: [{ hypothesis_id: 'Hq', version: 1 }, { hypothesis_id: 'Hn', version: 1 }] });
    const next = await call('recommend_next');
    const status = await call('status');
    await call('refresh_evidence', { candidate_refs: f.input.candidates });
    await call('update_opportunities', { changes: [{ op: 'park', candidate_id: 'far', reason: 'Wait for admitted transfer evidence', revisit_conditions: [{ type: 'new_admitted_evidence', source_id: 'source:far' }] }] });
    const unchanged = await call('refresh_evidence', {});
    await fs.writeFile(f.refs[2].artifact_path, JSON.stringify({ source_id: 'source:far', source_version: '1', admitted: true }));
    const changed = await call('refresh_evidence', {});
    const repeated = await call('refresh_evidence', {});
    const exported = await call('export');
    await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(exported.json, null, 2));
    await fs.writeFile(path.join(directory, 'report.md'), exported.markdown);
    const rows = assessed.assessment?.rows || [];
    const forbiddenExclusion = ['wide', 'failed', 'mismatched', 'retrospective', 'unreviewed'].includes(scenario);
    const positiveClaims = rows.filter(r => ['supported_in_scope', 'excluded_in_scope'].includes(r.status));
    const checks = {
      first_discriminating_control: first.decision.action_id === 'E1',
      exclusion_gates: !forbiddenExclusion || !rows.some(r => r.status === 'excluded_in_scope'),
      incompatible_protocol_no_promotion: scenario !== 'mismatched' || positiveClaims.length === 0,
      repeat_cost_stable: JSON.stringify(beforeReplay) === JSON.stringify(afterReplay),
      no_repeat_action: next.decision.action_id !== first.decision.action_id,
      selected_budget_allowed: first.budget_gate?.allowed === true && (next.decision.kind !== 'execute_action' || next.budget_gate?.allowed === true),
      condition_trigger_once: unchanged.revisit_events.length === 0 && changed.revisit_events.length === 1 && repeated.revisit_events.length === 0,
      negative_branch: scenario !== 'negative' || next.decision.action_id === 'E3',
      wide_branch: scenario !== 'wide' || next.decision.action_id === 'E4',
      unmodeled_retained: scenario !== 'unexplained' || assessed.unmodeled_explanation === true
    };
    results.push({ domain, scenario, checks, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
      baseline: { action_id: baseline.action_id, cost_upper: baseline.estimated_cost.upper, basis: 'Frozen candidate priority; not a rerun of the legacy controller.', outcome: 'not_observed' },
      policy: { first_action: first.decision.action_id, cost_upper: selected.estimated_cost.upper, next_decision: next.decision,
        statuses: Object.fromEntries(status.scientific_state.map(h => [h.hypothesis_id, h.status])), spent: status.budget.dimensions['gpu_hours:fixture-gpu'].spent,
        unresolved: status.scientific_state.some(h => ['inconclusive', 'unassessable', 'conflicted', 'weakened_in_scope'].includes(h.status)) },
      errors: { false_exclusions: forbiddenExclusion ? rows.filter(r => r.status === 'excluded_in_scope').length : 0,
        incomparable_promotions: scenario === 'mismatched' ? positiveClaims.length : 0, duplicate_charges: checks.repeat_cost_stable ? 0 : 1,
        budget_violations: checks.selected_budget_allowed ? 0 : 1, invalid_repeated_actions: checks.no_repeat_action ? 0 : 1 },
      revisit_events: changed.revisit_events.length, elapsed_ms: performance.now() - start });
    await fs.writeFile(path.join(directory, 'visible-inputs.json'), JSON.stringify(visibleInputs, null, 2));
  } catch (error) { results.push({ domain, scenario, status: 'error', error: error.stack, elapsed_ms: performance.now() - start }); }
  finally {
    await fs.writeFile(path.join(directory, 'trace.json'), JSON.stringify(trace, null, 2));
  }
}
const failures = results.filter(r => r.status !== 'passed');
const report = { status: failures.length ? 'failed' : 'passed', seed: Number(values.seed), fixtures, case_order: cases, cases: results,
  totals: { cases: results.length, failures: failures.length, ...Object.fromEntries(['false_exclusions', 'incomparable_promotions', 'duplicate_charges', 'budget_violations', 'invalid_repeated_actions'].map(key => [key, results.reduce((sum, r) => sum + (r.errors?.[key] || 0), 0)])),
    unresolved_cases: results.filter(r => r.policy?.unresolved).length, condition_triggered_revisits: results.reduce((sum, r) => sum + (r.revisit_events || 0), 0) },
  limitations: 'Synthetic fixture behavior only. The frozen candidate-priority baseline has no generated outcome; realized baseline cost and research-success comparison are not established. Timings are local diagnostics.' };
await fs.writeFile(path.join(output, 'evaluation.json'), JSON.stringify(report, null, 2));
const lines = ['# Research decision offline evaluation', '', `Status: ${report.status}. Seed: ${report.seed}. Cases: ${results.length}.`, '',
  '| Case | Result | Priority action | Policy action | Feedback decision | Cost observed |', '| --- | --- | --- | --- | --- | ---: |',
  ...results.map(r => `| ${r.domain}/${r.scenario} | ${r.status} | ${r.baseline?.action_id || 'unknown'} | ${r.policy?.first_action || 'unknown'} | ${r.policy?.next_decision.action_id || r.policy?.next_decision.kind || 'unknown'} | ${r.policy?.spent ?? 'unknown'} |`),
  '', '## Observed checks', '', ...Object.entries(report.totals).map(([key, value]) => `- ${key}: ${value}`), '', '## Limitations', '', report.limitations, ''];
await fs.writeFile(path.join(output, 'evaluation.md'), lines.join('\n'));
console.log(JSON.stringify({ status: report.status, output, totals: report.totals }, null, 2));
process.exitCode = failures.length ? 1 : 0;
