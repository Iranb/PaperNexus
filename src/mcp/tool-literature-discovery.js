import { resolveCorpus } from '../storage/corpus-store.js';
import { buildLiteratureDiscoveryRunPlan, runLiteratureDiscovery } from '../core/discovery/workflow.js';
import { submitDiscoveryImports } from '../core/discovery/import-bridge.js';
import { listDiscoveryRuns, loadDiscoveryRun, saveDiscoveryRun } from '../core/discovery/store.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function buildLlmDiscoveryParams(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const llmConfig = normalizeObject(config.llm);
  const ollamaConfig = normalizeObject(config.ollama);
  const fallbackConfig = normalizeObject(llmConfig.fallback);
  const fallbackOllamaConfig = normalizeObject(fallbackConfig.ollamaBootstrap || fallbackConfig.ollama);

  return {
    llmQueryPlanner: firstDefined(args.llmQueryPlanner, args.llm_query_planner),
    maxLlmQueries: firstDefined(args.maxLlmQueries, args.max_llm_queries),
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

function buildDiscoveryParams(rootPath, args = {}, options = {}) {
  return {
    rootPath,
    topic: args.topic || args.query,
    depth: args.depth,
    discipline: args.discipline,
    maxQueries: args.maxQueries || args.max_queries,
    maxResultsPerQuery: args.maxResultsPerQuery || args.max_results_per_query,
    maxCandidates: args.maxCandidates || args.max_candidates,
    providerConcurrency: args.providerConcurrency || args.provider_concurrency || args.maxProviderThreads || args.max_provider_threads,
    maxDownloads: args.maxDownloads || args.max_downloads,
    downloadConcurrency: args.downloadConcurrency || args.download_concurrency || args.maxDownloadThreads || args.max_download_threads,
    providers: args.providers,
    mailto: args.mailto,
    openAlexApiKey: args.openAlexApiKey || args.openalexApiKey || args.openalex_api_key,
    openAlexApiKeyFile: args.openAlexApiKeyFile
      || args.openAlexApiKeyPath
      || args.openalexApiKeyFile
      || args.openalexApiKeyPath
      || args.openalex_api_key_file
      || args.openalex_api_key_path,
    coreApiKey: args.coreApiKey || args.core_api_key,
    timeoutMs: args.timeoutMs || args.timeout_ms,
    retryCount: args.retryCount ?? args.retry_count,
    retryBackoffMs: args.retryBackoffMs || args.retry_backoff_ms,
    providerRequestDelayMs: args.providerRequestDelayMs ?? args.provider_request_delay_ms,
    maxRetryAfterMs: args.maxRetryAfterMs || args.max_retry_after_ms,
    resolveSources: args.resolveSources ?? args.resolve_sources,
    allowDownloads: args.allowDownloads ?? args.allow_downloads,
    seedPapers: args.seedPapers || args.seed_papers || args.knownPapers || args.known_papers,
    sourceIndex: args.sourceIndex || args.source_index,
    maxSeedPapers: args.maxSeedPapers || args.max_seed_papers,
    maxSeedQueries: args.maxSeedQueries || args.max_seed_queries,
    entitySeeds: args.entitySeeds || args.entity_seeds,
    datasetSeeds: args.datasetSeeds || args.dataset_seeds,
    benchmarkSeeds: args.benchmarkSeeds || args.benchmark_seeds,
    seedTexts: args.seedTexts || args.seed_texts || args.sourceTexts || args.source_texts,
    maxSeedEntities: args.maxSeedEntities || args.max_seed_entities,
    maxExtractedEntities: args.maxExtractedEntities || args.max_extracted_entities,
    maxEntityQueries: args.maxEntityQueries || args.max_entity_queries,
    citationExpansion: args.citationExpansion ?? args.citation_expansion,
    maxCitationSeeds: args.maxCitationSeeds || args.max_citation_seeds,
    maxCitationsPerSeed: args.maxCitationsPerSeed || args.max_citations_per_seed,
    maxRelatedPerSeed: args.maxRelatedPerSeed || args.max_related_per_seed,
    openAlexRelatedExpansion: args.openAlexRelatedExpansion ?? args.openalexRelatedExpansion ?? args.openalex_related_expansion,
    institutionalResolverBaseUrl: args.institutionalResolverBaseUrl || args.institutional_resolver_base_url,
    institutionalAccessMode: args.institutionalAccessMode || args.institutional_access_mode,
    persist: args.persist,
    ...buildLlmDiscoveryParams(args, options)
  };
}

function applyImportResultsToRun(run, importResult) {
  const importsByCanonicalId = new Map(
    (importResult.results || []).map((entry) => [entry.canonicalId, entry])
  );
  return {
    ...run,
    candidates: (run.candidates || []).map((candidate) => {
      const importEntry = importsByCanonicalId.get(candidate.canonicalId);
      return {
        ...candidate,
        import: importEntry
          ? {
              status: importEntry.status,
              taskId: importEntry.taskId || null,
              error: importEntry.error || ''
            }
          : {
              status: 'not_submitted'
            }
      };
    }),
    importSummary: importResult
  };
}

export async function executeLiteratureDiscoveryTool(args = {}, options = {}) {
  const operation = normalizeOperation(args.operation || 'run');

  if (operation === 'plan') {
    return JSON.stringify(await buildLiteratureDiscoveryRunPlan(buildDiscoveryParams(undefined, args, options)), null, 2);
  }

  const rootPath = await resolveCorpus(args.corpus);

  if (operation === 'list') {
    return JSON.stringify({
      rootPath,
      runs: await listDiscoveryRuns(rootPath, args.limit)
    }, null, 2);
  }

  if (operation === 'status' || operation === 'report') {
    const run = await loadDiscoveryRun(rootPath, args.runId || args.run_id);
    if (!run) {
      throw new Error('No literature discovery run found.');
    }
    return JSON.stringify(run, null, 2);
  }

  if (operation === 'search' || operation === 'resolve' || operation === 'run' || operation === 'import') {
    const run = await runLiteratureDiscovery({
      ...buildDiscoveryParams(rootPath, args, options),
      resolveSources: operation === 'search' ? false : (args.resolveSources ?? args.resolve_sources),
      persist: args.persist !== false
    });

    if (operation === 'import' || args.importResolved || args.import_resolved) {
      const importResult = await submitDiscoveryImports({
        corpus: args.corpus || rootPath,
        candidates: run.candidates,
        maxImported: args.maxImported || args.max_imported,
        options
      });
      const nextRun = applyImportResultsToRun(run, importResult);
      nextRun.coverage = {
        ...nextRun.coverage,
        importedCount: importResult.submitted + importResult.deduped
      };
      if (args.persist !== false) {
        await saveDiscoveryRun(rootPath, nextRun);
      }
      return JSON.stringify(nextRun, null, 2);
    }

    return JSON.stringify(run, null, 2);
  }

  throw new Error(`Unknown literature_discovery operation: ${args.operation || '<missing>'}`);
}
