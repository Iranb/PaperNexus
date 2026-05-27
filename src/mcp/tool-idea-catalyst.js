import {
  catalystGraphPayload
} from '../server/api.js';
import { runLiveIdeaCatalyst } from '../core/graph/idea-catalyst-live.js';
import { buildIdeaCatalystEvidenceExport } from '../core/graph/idea-catalyst-evidence-export.js';
import { buildInnovationArtifactGraphMutations } from '../core/graph/innovation-writeback.js';
import { selectIdeas } from '../core/graph/diversity-selection.js';
import { applyCorpusMutations } from '../storage/corpus-store.js';

function clampScore(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMechanisms(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? undefined;
}

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function disabledFlag(value) {
  if (value === false) return true;
  if (value === true || value === undefined || value === null) return false;
  return ['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function resolveWritebackApplyRequested(args = {}) {
  const mode = String(args.writeBackMode || args.write_back_mode || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return ['apply', 'commit', 'write'].includes(mode)
    || enabledFlag(args.writeBackApply ?? args.write_back_apply)
    || disabledFlag(args.writeBackDryRun ?? args.write_back_dry_run);
}

function serializeMutationResult(mutationResult = {}) {
  return {
    dryRun: mutationResult.dryRun,
    actor: mutationResult.actor,
    operationsCount: mutationResult.operationsCount,
    countsBefore: mutationResult.countsBefore,
    countsAfter: mutationResult.countsAfter,
    summary: mutationResult.summary,
    results: mutationResult.results
  };
}

async function buildWritebackResult(artifact, args = {}, rootPath = null) {
  if (!enabledFlag(args.writeBack ?? args.write_back)) return undefined;

  const applyRequested = resolveWritebackApplyRequested(args);
  const dryRun = !applyRequested;
  const actor = String(args.writeBackActor || args.write_back_actor || args.actor || 'idea-catalyst').trim() || 'idea-catalyst';
  const preview = buildInnovationArtifactGraphMutations(artifact, {
    actor,
    allowWeakEvidence: enabledFlag(args.allowWeakEvidence ?? args.allow_weak_evidence)
  });
  const payload = {
    ...preview,
    requested: true,
    requestedMode: applyRequested ? 'apply' : 'dry_run',
    dryRun,
    actor,
    applyStatus: 'not_requested',
    graphValidationStatus: 'not_run'
  };

  if (!preview.operations.length || preview.writebackStatus !== 'ready') {
    payload.applyStatus = 'blocked';
    payload.dryRun = true;
    return payload;
  }

  if (!rootPath) {
    payload.applyStatus = applyRequested ? 'blocked' : 'preview_only';
    payload.dryRun = true;
    payload.warnings = [
      ...(payload.warnings || []),
      {
        code: 'corpus_required_for_writeback_validation',
        message: 'A corpus is required to validate or apply idea_catalyst writeback operations against a graph.'
      }
    ];
    return payload;
  }

  const { mutationResult } = await applyCorpusMutations(rootPath, preview.operations, {
    actor,
    dryRun
  });
  payload.applyStatus = dryRun ? 'previewed' : 'applied';
  payload.graphValidationStatus = 'validated';
  payload.mutationResult = serializeMutationResult(mutationResult);
  return payload;
}

function normalizeMode(args = {}) {
  const raw = String(args.mode || args.workflowMode || args.workflow_mode || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (enabledFlag(args.liveDiscovery ?? args.live_discovery)) return 'live_discovery';
  if (raw === 'live' || raw === 'snippets' || raw === 'paper_faithful') return 'live_discovery';
  if (raw === 'live_discovery' || raw === 'hybrid' || raw === 'graph') return raw;
  return 'graph';
}

function normalizeSelectionParams(args = {}, problem = '') {
  const mode = String(args.selectionMode || args.selection_mode || 'default').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return {
    mode: ['topk', 'mmr', 'submodular', 'greedy_submodular', 'dpp'].includes(mode) ? mode : 'default',
    k: Math.max(1, Number(args.selectionK || args.selection_k || args.k || 3)),
    lambda: args.mmrLambda ?? args.mmr_lambda,
    minEvidenceTier: args.minEvidenceTier || args.min_evidence_tier || 'moderate',
    requireBridgePath: enabledFlag(args.requireBridgePath ?? args.require_bridge_path),
    context: { problem }
  };
}

function applyIdeaSelection(fragments = [], selectionParams = {}) {
  if (!['topk', 'mmr', 'submodular', 'greedy_submodular', 'dpp'].includes(selectionParams.mode)) return null;
  return selectIdeas(fragments, selectionParams);
}

function applyPacketBundleSelection(packetBundle = {}, selectionParams = {}) {
  const selection = applyIdeaSelection(packetBundle.idea_fragments || [], selectionParams);
  if (!selection) return { packetBundle, selectionTrace: null };
  return {
    packetBundle: {
      ...packetBundle,
      idea_fragments: selection.selected,
      selection_trace: selection.selection_trace
    },
    selectionTrace: selection.selection_trace
  };
}

function extractInnovationFields(source = {}) {
  return {
    innovation_contract_version: source.innovation_contract_version,
    contribution_claims: source.contribution_claims,
    must_cite_set: source.must_cite_set,
    novelty_certificate: source.novelty_certificate,
    review_packet: source.review_packet,
    storyline_dag: source.storyline_dag,
    counterfactuals: source.counterfactuals,
    falsification_plans: source.falsification_plans
  };
}

function buildLiveLlmParams(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const llmConfig = normalizeObject(config.llm);
  const ollamaConfig = normalizeObject(config.ollama);
  const fallbackConfig = normalizeObject(llmConfig.fallback);
  const fallbackOllamaConfig = normalizeObject(fallbackConfig.ollamaBootstrap || fallbackConfig.ollama);

  return {
    llmProvider: firstDefined(args.llmProvider, args.llm_provider, llmConfig.provider),
    llmModel: firstDefined(args.llmModel, args.llm_model, args.ollamaModel, args.ollama_model, llmConfig.model, ollamaConfig.model),
    llmBaseUrl: firstDefined(args.llmBaseUrl, args.llm_base_url, args.ollamaUrl, args.ollama_url, llmConfig.baseUrl, llmConfig.url, ollamaConfig.url),
    llmApiKey: firstDefined(args.llmApiKey, args.llm_api_key, llmConfig.apiKey),
    llmApiKeyEnv: firstDefined(args.llmApiKeyEnv, args.llm_api_key_env, llmConfig.apiKeyEnv),
    llmApiKeySource: firstDefined(args.llmApiKeySource, args.llm_api_key_source, llmConfig.apiKeySource),
    llmApiKeyService: firstDefined(args.llmApiKeyService, args.llm_api_key_service, llmConfig.apiKeyService),
    llmApiKeyAccount: firstDefined(args.llmApiKeyAccount, args.llm_api_key_account, llmConfig.apiKeyAccount),
    llmTimeoutMs: firstDefined(args.llmTimeoutMs, args.llm_timeout_ms, llmConfig.timeoutMs, ollamaConfig.timeoutMs),
    llmMaxTokens: firstDefined(args.llmMaxTokens, args.llm_max_tokens, llmConfig.maxTokens),
    llmFallbackProvider: firstDefined(args.llmFallbackProvider, args.llm_fallback_provider, fallbackConfig.provider),
    llmFallbackModel: firstDefined(args.llmFallbackModel, args.llm_fallback_model, fallbackConfig.model),
    llmFallbackBaseUrl: firstDefined(args.llmFallbackBaseUrl, args.llm_fallback_base_url, fallbackConfig.baseUrl, fallbackConfig.url),
    llmFallbackApiKey: firstDefined(args.llmFallbackApiKey, args.llm_fallback_api_key, fallbackConfig.apiKey),
    llmFallbackApiKeyEnv: firstDefined(args.llmFallbackApiKeyEnv, args.llm_fallback_api_key_env, fallbackConfig.apiKeyEnv),
    llmFallbackApiKeySource: firstDefined(args.llmFallbackApiKeySource, args.llm_fallback_api_key_source, fallbackConfig.apiKeySource),
    llmFallbackApiKeyService: firstDefined(args.llmFallbackApiKeyService, args.llm_fallback_api_key_service, fallbackConfig.apiKeyService),
    llmFallbackApiKeyAccount: firstDefined(args.llmFallbackApiKeyAccount, args.llm_fallback_api_key_account, fallbackConfig.apiKeyAccount),
    llmFallbackTimeoutMs: firstDefined(args.llmFallbackTimeoutMs, args.llm_fallback_timeout_ms, fallbackConfig.timeoutMs),
    llmFallbackMaxTokens: firstDefined(args.llmFallbackMaxTokens, args.llm_fallback_max_tokens, fallbackConfig.maxTokens),
    llmFallbackAutoStart: firstDefined(args.llmFallbackAutoStart, args.llm_fallback_auto_start, fallbackConfig.autoStart),
    llmFallbackAutoPull: firstDefined(args.llmFallbackAutoPull, args.llm_fallback_auto_pull, fallbackConfig.autoPull),
    llmFallbackOllamaBootstrap: firstDefined(args.llmFallbackOllamaBootstrap, args.llm_fallback_ollama_bootstrap, fallbackOllamaConfig.mode)
  };
}

function buildLiveCatalystParams(args = {}, problem = '', targetDomain = '', options = {}) {
  return {
    ...args,
    problem,
    targetDomain,
    fineGrainedDomain: args.fineGrainedDomain || args.fine_grained_domain,
    coarseGrainedDomain: args.coarseGrainedDomain || args.coarse_grained_domain,
    numQuestions: args.numQuestions || args.num_questions,
    numSourceDomains: args.numSourceDomains || args.num_source_domains,
    maxPapersPerQuery: args.maxPapersPerQuery ?? args.max_papers_per_query,
    sourceRelevanceThreshold: args.sourceRelevanceThreshold ?? args.source_relevance_threshold,
    targetFieldOfStudy: args.targetFieldOfStudy || args.target_field_of_study || args.fieldsOfStudy || args.fields_of_study,
    semanticScholarRequestDelayMs: firstDefined(args.semanticScholarRequestDelayMs, args.semantic_scholar_request_delay_ms, args.s2RequestDelayMs, args.s2_request_delay_ms),
    semanticScholarMaxConcurrent: firstDefined(args.semanticScholarMaxConcurrent, args.semantic_scholar_max_concurrent),
    retryCount: args.retryCount ?? args.retry_count,
    retryBackoffMs: args.retryBackoffMs ?? args.retry_backoff_ms,
    timeoutMs: args.timeoutMs ?? args.timeout_ms,
    timeCutoff: args.timeCutoff || args.time_cutoff,
    mustCiteK: args.mustCiteK || args.must_cite_k,
    reviewerPanel: args.reviewerPanel || args.reviewer_panel,
    storylineMode: args.storylineMode || args.storyline_mode,
    writeBack: args.writeBack ?? args.write_back,
    counterfactualBudget: args.counterfactualBudget ?? args.counterfactual_budget,
    ...buildLiveLlmParams(args, options)
  };
}

function buildIdeaFragment(entry, problem, threshold, index) {
  return {
    rank: index + 1,
    title: `${entry.source_domain} bridge for ${problem}`.slice(0, 120),
    target_challenge: problem,
    abstract_challenge: problem,
    source_domain: entry.source_domain,
    source_takeaways: Array.isArray(entry.source_takeaways) ? entry.source_takeaways : [],
    integration_rationale: [
      `Prioritize ${entry.source_domain} because it remains one of the strongest graph-ranked bridge domains for "${problem}".`,
      entry.integration_mechanism
        ? `Transfer mechanism: ${entry.integration_mechanism}.`
        : 'No explicit mechanism was returned; rely on the graph evidence in the packet bundle.'
    ].join(' '),
    novelty_score: Number((clampScore(Number(entry.ranking_signals?.interdisciplinary_potential || 0), 0, 1) * 5).toFixed(2)),
    usefulness_score: Number((clampScore(Number((entry.supporting_papers || []).length || 0) / Math.max(1, threshold), 0, 1) * 5).toFixed(2)),
    supporting_kg_nodes: Array.isArray(entry.supporting_kg_nodes) ? entry.supporting_kg_nodes : [],
    ...entry
  };
}

function buildLegacyIdeaCatalystResponse(payload, problem, relevanceThreshold) {
  const bundle = payload.packetBundle || payload.result?.packetBundle || {};
  if (bundle.requisition_report) {
    return {
      rootPath: payload.rootPath,
      requisition_report: bundle.requisition_report,
      analysis: {
        target_domain: payload.result?.targetDomain || '',
        candidate_source_domains: payload.result?.candidateSourceDomains || [],
        catalyst: payload.result
      },
      generatedAt: payload.generatedAt
    };
  }

  return {
    rootPath: payload.rootPath,
    idea_fragments: (bundle.idea_fragments || [])
      .slice(0, 3)
      .map((entry, index) => buildIdeaFragment(entry, problem, relevanceThreshold, index)),
    analysis: {
      target_domain: payload.result?.targetDomain || '',
      candidate_source_domains: payload.result?.candidateSourceDomains || [],
      catalyst: payload.result
    },
    generatedAt: payload.generatedAt
  };
}

export async function executeIdeaCatalystTool(args = {}, options = {}) {
  const candidate = typeof args.corpus === 'string' && args.corpus.trim() ? args.corpus.trim() : undefined;
  const problem = String(args.problem || args.query || '').trim();
  const targetDomain = String(args.targetDomain || args.target_domain || '').trim();
  const fineGrainedDomain = String(args.fineGrainedDomain || args.fine_grained_domain || '').trim();
  const coarseGrainedDomain = String(args.coarseGrainedDomain || args.coarse_grained_domain || '').trim();
  const limit = Math.max(1, Number(args.limit || 8));
  const numSourceDomains = Math.max(1, Number(args.numSourceDomains || args.num_source_domains || 3));
  const relevanceThreshold = Math.max(1, Number(args.relevanceThreshold || args.relevance_threshold || 3));
  const mechanisms = normalizeMechanisms(args.mechanisms);
  const outputMode = String(args.outputMode || args.output_mode || 'idea_fragments').trim() || 'idea_fragments';
  const includeAnalysis = args.includeAnalysis === true || args.include_analysis === true;
  const mode = normalizeMode(args);
  const selectionParams = normalizeSelectionParams(args, problem);

  if (!problem) {
    throw new Error('problem is required.');
  }
  if (!targetDomain) {
    throw new Error('targetDomain is required.');
  }

  if (mode === 'live_discovery') {
    const live = await runLiveIdeaCatalyst(
      buildLiveCatalystParams(args, problem, targetDomain, options),
      options
    );
    const evidenceExport = live.evidence_export || buildIdeaCatalystEvidenceExport({
      mode,
      problem,
      targetDomain,
      live,
      runId: args.runId || args.run_id || null,
      traceId: args.traceId || args.trace_id || null
    });

    if (outputMode === 'packet_bundle') {
      const { packetBundle, selectionTrace } = applyPacketBundleSelection(live.packetBundle || {}, selectionParams);
      const writeback = await buildWritebackResult(packetBundle, args, null);
      return {
        mode,
        packet_bundle: packetBundle,
        selection_trace: selectionTrace || undefined,
        ...extractInnovationFields(packetBundle),
        writeback,
        evidence_export: evidenceExport,
        run_id: evidenceExport.run_id,
        trace_id: evidenceExport.trace_id,
        live_discovery: includeAnalysis ? live : undefined,
        generatedAt: live.generatedAt
      };
    }

    const liveSelection = applyIdeaSelection(live.idea_fragments || [], selectionParams);
    const writeback = await buildWritebackResult(live, args, null);
    return {
      mode,
      idea_fragments: liveSelection?.selected || live.idea_fragments || [],
      selection_trace: liveSelection?.selection_trace || undefined,
      faithfulness_report: live.faithfulness_report,
      ...extractInnovationFields(live),
      writeback,
      evidence_export: evidenceExport,
      run_id: evidenceExport.run_id,
      trace_id: evidenceExport.trace_id,
      ...(includeAnalysis ? { analysis: live } : {}),
      generatedAt: live.generatedAt
    };
  }

  const payload = await catalystGraphPayload(candidate, {
    name: candidate,
    targetDomain,
    fineGrainedDomain,
    coarseGrainedDomain,
    abstractChallenge: problem,
    mechanisms,
    numSourceDomains,
    relevanceThreshold,
    options: {
      limit
    }
  }, options);

  if (outputMode === 'packet_bundle') {
    const { packetBundle, selectionTrace } = applyPacketBundleSelection(payload.packetBundle || {}, selectionParams);
    const writeback = await buildWritebackResult(packetBundle, args, payload.rootPath);
    const graphEvidenceExport = buildIdeaCatalystEvidenceExport({
      mode,
      problem,
      targetDomain,
      graphPayload: payload,
      runId: args.runId || args.run_id || null,
      traceId: args.traceId || args.trace_id || null
    });
    const graphResponse = {
      rootPath: payload.rootPath,
      packet_bundle: packetBundle,
      selection_trace: selectionTrace || undefined,
      ...extractInnovationFields(packetBundle),
      writeback,
      evidence_export: graphEvidenceExport,
      run_id: graphEvidenceExport.run_id,
      trace_id: graphEvidenceExport.trace_id,
      ...(includeAnalysis ? {
        analysis: {
          target_domain: payload.result?.targetDomain || '',
          candidate_source_domains: payload.result?.candidateSourceDomains || [],
          catalyst: payload.result
        }
      } : {}),
      generatedAt: payload.generatedAt
    };
    if (mode !== 'hybrid') return graphResponse;
    const live = await runLiveIdeaCatalyst(
      buildLiveCatalystParams(args, problem, targetDomain, options),
      options
    );
    const hybridEvidenceExport = buildIdeaCatalystEvidenceExport({
      mode,
      problem,
      targetDomain,
      graphPayload: payload,
      live,
      runId: args.runId || args.run_id || null,
      traceId: args.traceId || args.trace_id || null
    });
    const livePacketSelection = applyPacketBundleSelection(live.packetBundle || {}, selectionParams);
    const liveWriteback = await buildWritebackResult(livePacketSelection.packetBundle, {
      ...args,
      writeBackApply: false,
      write_back_apply: false,
      writeBackDryRun: true,
      write_back_dry_run: true
    }, null);
    return {
      ...graphResponse,
      mode,
      evidence_export: hybridEvidenceExport,
      run_id: hybridEvidenceExport.run_id,
      trace_id: hybridEvidenceExport.trace_id,
      live_packet_bundle: livePacketSelection.packetBundle,
      live_selection_trace: livePacketSelection.selectionTrace || undefined,
      live_innovation_artifacts: extractInnovationFields(livePacketSelection.packetBundle),
      live_writeback: liveWriteback,
      live_discovery: includeAnalysis ? live : undefined
    };
  }

  const legacy = buildLegacyIdeaCatalystResponse(payload, problem, relevanceThreshold);
  const legacySelection = applyIdeaSelection(legacy.idea_fragments || [], selectionParams);
  if (legacySelection) {
    legacy.idea_fragments = legacySelection.selected;
    legacy.selection_trace = legacySelection.selection_trace;
  }
  legacy.mode = mode;
  legacy.evidence_export = buildIdeaCatalystEvidenceExport({
    mode,
    problem,
    targetDomain,
    graphPayload: payload,
    runId: args.runId || args.run_id || null,
    traceId: args.traceId || args.trace_id || null
  });
  Object.assign(legacy, extractInnovationFields(payload.packetBundle || legacy.evidence_export || {}));
  legacy.writeback = await buildWritebackResult(payload.packetBundle || legacy.evidence_export || {}, args, payload.rootPath);
  legacy.run_id = legacy.evidence_export.run_id;
  legacy.trace_id = legacy.evidence_export.trace_id;
  if (mode === 'hybrid') {
    const live = await runLiveIdeaCatalyst(
      buildLiveCatalystParams(args, problem, targetDomain, options),
      options
    );
    const liveSelection = applyIdeaSelection(live.idea_fragments || [], selectionParams);
    legacy.live_idea_fragments = liveSelection?.selected || live.idea_fragments || [];
    if (liveSelection) legacy.live_selection_trace = liveSelection.selection_trace;
    legacy.faithfulness_report = live.faithfulness_report;
    legacy.evidence_export = buildIdeaCatalystEvidenceExport({
      mode,
      problem,
      targetDomain,
      graphPayload: payload,
      live,
      runId: args.runId || args.run_id || null,
      traceId: args.traceId || args.trace_id || null
    });
    Object.assign(legacy, extractInnovationFields(legacy.evidence_export || {}));
    legacy.live_writeback = await buildWritebackResult(legacy.evidence_export || live, {
      ...args,
      writeBackApply: false,
      write_back_apply: false,
      writeBackDryRun: true,
      write_back_dry_run: true
    }, null);
    legacy.run_id = legacy.evidence_export.run_id;
    legacy.trace_id = legacy.evidence_export.trace_id;
    if (includeAnalysis) legacy.live_analysis = live;
  }
  if (!includeAnalysis) {
    delete legacy.analysis;
  }
  return legacy;
}
