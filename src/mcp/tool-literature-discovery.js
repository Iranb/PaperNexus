import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCorpus } from '../storage/corpus-store.js';
import {
  buildDiscoveryMetadataGraph,
  buildLiteratureDiscoveryRunPlan,
  runLiteratureDiscovery
} from '../core/discovery/workflow.js';
import { submitDiscoveryImports } from '../core/discovery/import-bridge.js';
import { runImportQueueUntilIdle } from '../core/imports/worker.js';
import { listDiscoveryRuns, loadDiscoveryRun, saveDiscoveryRun } from '../core/discovery/store.js';
import { loadImportTask } from '../storage/import-store.js';
import {
  createDiscoverySupplementationInterface,
  resolveDiscoverySources
} from '../core/discovery/source-resolution.js';
import { createContentSha256, createSourceIdentity, normalizePaperIdentifiers } from '../lib/paper-identifiers.js';

function normalizeOperation(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').trim();
}

function unique(values = []) {
  return [...new Set(values)];
}

function identifiersOf(entry = {}) {
  const identifiers = normalizeObject(entry.identifiers);
  return {
    ...identifiers,
    ...normalizePaperIdentifiers({ ...entry, identifiers })
  };
}

function sourceResolutionStatus(candidate = {}) {
  return candidate.source?.resolutionStatus || candidate.source?.resolution_status || '';
}

function importKey(type = '', value = '', options = {}) {
  const text = compactText(value);
  if (!text) return '';
  return `${type}:${options.caseSensitive ? text : text.toLowerCase()}`;
}

function importKeysFromCandidate(candidate = {}) {
  const identifiers = identifiersOf(candidate);
  const source = normalizeObject(candidate.source);
  return unique([
    importKey('canonical', candidate.canonicalId),
    importKey('canonical', candidate.canonical_id),
    importKey('source_path', source.sourcePath, { caseSensitive: true }),
    importKey('source_path', source.source_path, { caseSensitive: true }),
    importKey('candidate', candidate.id, { caseSensitive: true }),
    importKey('candidate', candidate.candidateId, { caseSensitive: true }),
    importKey('candidate', candidate.candidate_id, { caseSensitive: true }),
    importKey('doi', identifiers.doi),
    importKey('arxiv', identifiers.arxivId),
    importKey('pmid', identifiers.pmid),
    importKey('pmcid', identifiers.pmcid)
  ].filter(Boolean));
}

function importKeysFromResult(entry = {}) {
  const identifiers = identifiersOf(entry);
  return unique([
    importKey('canonical', entry.canonicalId),
    importKey('canonical', entry.canonical_id),
    importKey('source_path', entry.sourcePath, { caseSensitive: true }),
    importKey('source_path', entry.source_path, { caseSensitive: true }),
    importKey('candidate', entry.candidateId, { caseSensitive: true }),
    importKey('candidate', entry.candidate_id, { caseSensitive: true }),
    importKey('doi', identifiers.doi),
    importKey('arxiv', identifiers.arxivId),
    importKey('pmid', identifiers.pmid),
    importKey('pmcid', identifiers.pmcid)
  ].filter(Boolean));
}

function importResultsByKey(importResult = {}) {
  const importsByKey = new Map();
  for (const entry of importResult.results || []) {
    for (const key of importKeysFromResult(entry)) {
      if (!importsByKey.has(key)) importsByKey.set(key, entry);
    }
  }
  return importsByKey;
}

function findImportResultForCandidate(candidate = {}, importsByKey = new Map()) {
  return importKeysFromCandidate(candidate)
    .map((key) => importsByKey.get(key))
    .find(Boolean);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function enabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function shouldSubmitImports(operation, args = {}) {
  return operation === 'import'
    || operation === 'ingest'
    || operation === 'import_and_process'
    || enabledFlag(firstDefined(args.importResolved, args.import_resolved));
}

function shouldProcessImports(operation, args = {}) {
  return operation === 'ingest'
    || operation === 'import_and_process'
    || enabledFlag(firstDefined(args.processImports, args.process_imports, args.waitForImports, args.wait_for_imports));
}

function explicitImportMaxPasses(args = {}, options = {}) {
  const config = normalizeObject(options.config);
  const importConfig = normalizeObject(config.imports || config.import);
  return firstDefined(
    args.importMaxPasses,
    args.import_max_passes,
    args.maxImportPasses,
    args.max_import_passes,
    importConfig.maxPasses,
    importConfig.maxImportPasses
  );
}

function countProcessableImportTasks(importResult = {}) {
  return (importResult.results || []).filter((entry) => {
    if (!entry.taskId) return false;
    if (entry.status === 'submitted') return true;
    if (entry.status !== 'deduped') return false;
    const taskStatus = String(entry.taskStatus || '').trim().toLowerCase();
    return taskStatus !== 'completed' && taskStatus !== 'failed';
  }).length;
}

function buildImportProcessingOptions(args = {}, options = {}, importResult = {}) {
  const config = normalizeObject(options.config);
  const importConfig = normalizeObject(config.imports || config.import);
  const ingestionConfig = normalizeObject(config.ingestion);
  const pdfConfig = normalizeObject(config.pdf || config.pdfParser || config.pdf_parser);
  const submittedTaskCount = countProcessableImportTasks(importResult);

  return {
    ...options,
    maxPasses: firstDefined(
      explicitImportMaxPasses(args, options),
      Math.max(1, submittedTaskCount)
    ),
    semanticExtraction: firstDefined(
      args.semanticExtraction,
      args.semantic_extraction,
      importConfig.semanticExtraction,
      ingestionConfig.semanticExtraction
    ),
    pdfParser: firstDefined(
      args.pdfParser,
      args.pdf_parser,
      importConfig.pdfParser,
      ingestionConfig.pdfParser,
      pdfConfig.parser
    ),
    pdfCommand: firstDefined(args.pdfCommand, args.pdf_command, importConfig.pdfCommand, pdfConfig.command),
    pythonCommand: firstDefined(args.pythonCommand, args.python_command, importConfig.pythonCommand),
    doclingCommand: firstDefined(args.doclingCommand, args.docling_command, importConfig.doclingCommand),
    doclingPython: firstDefined(args.doclingPython, args.docling_python, importConfig.doclingPython),
    markitdownPython: firstDefined(args.markitdownPython, args.markitdown_python, importConfig.markitdownPython),
    markpdfdownPython: firstDefined(args.markpdfdownPython, args.markpdfdown_python, importConfig.markpdfdownPython),
    opendataloaderPdfPython: firstDefined(
      args.opendataloaderPdfPython,
      args.opendataloader_pdf_python,
      importConfig.opendataloaderPdfPython
    ),
    importPreparseConcurrency: firstDefined(
      args.importPreparseConcurrency,
      args.import_preparse_concurrency,
      importConfig.importPreparseConcurrency
    ),
    importTaskTimeoutMs: firstDefined(args.importTaskTimeoutMs, args.import_task_timeout_ms, importConfig.importTaskTimeoutMs),
    importPendingTimeoutMs: firstDefined(
      args.importPendingTimeoutMs,
      args.import_pending_timeout_ms,
      importConfig.importPendingTimeoutMs
    ),
    importBatchEnabled: firstDefined(
      args.importBatchEnabled,
      args.import_batch_enabled,
      args.batchEnabled,
      args.batch_enabled,
      options.importBatchEnabled,
      options.batchEnabled,
      importConfig.importBatchEnabled,
      importConfig.batchEnabled,
      true
    ),
    importBatchMaxTasks: firstDefined(
      args.importBatchMaxTasks,
      args.import_batch_max_tasks,
      args.batchMaxTasks,
      args.batch_max_tasks,
      options.importBatchMaxTasks,
      options.batchMaxTasks,
      importConfig.importBatchMaxTasks,
      importConfig.batchMaxTasks,
      importConfig.maxTasks,
      8
    ),
    importBatchMaxFiles: firstDefined(
      args.importBatchMaxFiles,
      args.import_batch_max_files,
      args.batchMaxFiles,
      args.batch_max_files,
      options.importBatchMaxFiles,
      options.batchMaxFiles,
      importConfig.importBatchMaxFiles,
      importConfig.batchMaxFiles,
      importConfig.maxFiles
    ),
    importBatchMaxBytes: firstDefined(
      args.importBatchMaxBytes,
      args.import_batch_max_bytes,
      args.batchMaxBytes,
      args.batch_max_bytes,
      options.importBatchMaxBytes,
      options.batchMaxBytes,
      importConfig.importBatchMaxBytes,
      importConfig.batchMaxBytes,
      importConfig.maxBytes
    )
  };
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
  const config = normalizeObject(options.config);
  const discoveryConfig = normalizeObject(config.literatureDiscovery || config.literature_discovery || config.discovery);
  return {
    rootPath,
    topic: args.topic || args.query,
    depth: args.depth,
    operation: args.operation,
    discoveryOperation: args.operation,
    searchMode: firstDefined(args.searchMode, args.search_mode),
    searchBudgetMs: firstDefined(args.searchBudgetMs, args.search_budget_ms),
    discoveryBudgetMs: firstDefined(args.discoveryBudgetMs, args.discovery_budget_ms),
    budgetMs: firstDefined(args.budgetMs, args.budget_ms),
    maxQueriesPerProvider: firstDefined(args.maxQueriesPerProvider, args.max_queries_per_provider),
    minProviderQueryBudgetMs: firstDefined(args.minProviderQueryBudgetMs, args.min_provider_query_budget_ms),
    returnPartial: firstDefined(args.returnPartial, args.return_partial),
    skipRemainingProviderQueriesOnRateLimit: firstDefined(
      args.skipRemainingProviderQueriesOnRateLimit,
      args.skip_remaining_provider_queries_on_rate_limit
    ),
    planningMode: firstDefined(args.planningMode, args.planning_mode),
    discipline: args.discipline,
    maxQueries: args.maxQueries || args.max_queries,
    maxResultsPerQuery: args.maxResultsPerQuery || args.max_results_per_query,
    maxCandidates: args.maxCandidates || args.max_candidates,
    providerConcurrency: args.providerConcurrency || args.provider_concurrency || args.maxProviderThreads || args.max_provider_threads,
    providerRequestSchedulerDelayMs: firstDefined(args.providerRequestSchedulerDelayMs, args.provider_request_scheduler_delay_ms),
    providerRequestMaxConcurrent: firstDefined(args.providerRequestMaxConcurrent, args.provider_request_max_concurrent),
    discoveryRequestCache: firstDefined(args.discoveryRequestCache, args.discovery_request_cache),
    discoveryRequestCacheTtlMs: firstDefined(args.discoveryRequestCacheTtlMs, args.discovery_request_cache_ttl_ms),
    openAlexRequestDelayMs: firstDefined(args.openAlexRequestDelayMs, args.openalexRequestDelayMs, args.openalex_request_delay_ms),
    openAlexMaxConcurrent: firstDefined(args.openAlexMaxConcurrent, args.openalexMaxConcurrent, args.openalex_max_concurrent),
    semanticScholarRequestDelayMs: firstDefined(args.semanticScholarRequestDelayMs, args.semantic_scholar_request_delay_ms, args.s2RequestDelayMs, args.s2_request_delay_ms),
    semanticScholarMaxConcurrent: firstDefined(args.semanticScholarMaxConcurrent, args.semantic_scholar_max_concurrent),
    papersCoolBaseUrl: firstDefined(args.papersCoolBaseUrl, args.papers_cool_base_url),
    papersCoolSort: firstDefined(args.papersCoolSort, args.papers_cool_sort),
    papersCoolMaxQueries: firstDefined(args.papersCoolMaxQueries, args.papers_cool_max_queries),
    pasaApiBaseUrl: firstDefined(args.pasaApiBaseUrl, args.pasa_api_base_url),
    pasaRequestTimeoutMs: firstDefined(args.pasaRequestTimeoutMs, args.pasa_request_timeout_ms),
    pasaTimeoutSeconds: firstDefined(args.pasaTimeoutSeconds, args.pasa_timeout_seconds),
    pasaPollIntervalSeconds: firstDefined(args.pasaPollIntervalSeconds, args.pasa_poll_interval_seconds),
    pasaMaxQueries: firstDefined(args.pasaMaxQueries, args.pasa_max_queries),
    maxDownloads: args.maxDownloads || args.max_downloads,
    downloadConcurrency: args.downloadConcurrency || args.download_concurrency || args.maxDownloadThreads || args.max_download_threads,
    preferMarkdown: args.preferMarkdown ?? args.prefer_markdown,
    generateArxivMarkdownSources: args.generateArxivMarkdownSources ?? args.generate_arxiv_markdown_sources,
    markdownStagingRoot: args.markdownStagingRoot || args.markdown_staging_root || args.mdStagingRoot || args.md_staging_root,
    pdfStagingRoot: args.pdfStagingRoot || args.pdf_staging_root,
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
    institutionalAccessMode: firstDefined(args.institutionalAccessMode, args.institutional_access_mode, discoveryConfig.institutionalAccessMode, discoveryConfig.institutional_access_mode),
    browserProfileDir: firstDefined(args.browserProfileDir, args.browser_profile_dir, discoveryConfig.browserProfileDir, discoveryConfig.browser_profile_dir),
    browserProfileName: firstDefined(args.browserProfileName, args.browser_profile_name, discoveryConfig.browserProfileName, discoveryConfig.browser_profile_name),
    browserExecutablePath: firstDefined(args.browserExecutablePath, args.browser_executable_path, discoveryConfig.browserExecutablePath, discoveryConfig.browser_executable_path),
    browserChannel: firstDefined(args.browserChannel, args.browser_channel, discoveryConfig.browserChannel, discoveryConfig.browser_channel),
    browserHeadless: firstDefined(args.browserHeadless, args.browser_headless, discoveryConfig.browserHeadless, discoveryConfig.browser_headless),
    browserDownloadTimeoutMs: firstDefined(args.browserDownloadTimeoutMs, args.browser_download_timeout_ms, discoveryConfig.browserDownloadTimeoutMs, discoveryConfig.browser_download_timeout_ms),
    browserAuthHosts: firstDefined(args.browserAuthHosts, args.browser_auth_hosts, discoveryConfig.browserAuthHosts, discoveryConfig.browser_auth_hosts),
    browserAuthUrlFragments: firstDefined(args.browserAuthUrlFragments, args.browser_auth_url_fragments, discoveryConfig.browserAuthUrlFragments, discoveryConfig.browser_auth_url_fragments),
    browserAuthPageTitles: firstDefined(args.browserAuthPageTitles, args.browser_auth_page_titles, discoveryConfig.browserAuthPageTitles, discoveryConfig.browser_auth_page_titles),
    persist: args.persist,
    ...buildLlmDiscoveryParams(args, options)
  };
}

function applyImportResultsToRun(run, importResult) {
  const importsByKey = importResultsByKey(importResult);
  return {
    ...run,
    candidates: (run.candidates || []).map((candidate) => {
      const importEntry = findImportResultForCandidate(candidate, importsByKey);
      return {
        ...candidate,
        import: importEntry
          ? {
              status: importEntry.status,
              taskId: importEntry.taskId || null,
              taskStatus: importEntry.taskStatus || importEntry.status || '',
              taskStage: importEntry.taskStage || '',
              graphUpdate: importEntry.graphUpdate || null,
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

function countAcceptedImportResults(importResult = {}) {
  const acceptedStatuses = new Set(['submitted', 'deduped', 'completed']);
  return (importResult.results || []).filter((entry) => acceptedStatuses.has(entry.status)).length;
}

function resolveSupplementTarget(run = {}, args = {}) {
  const candidateId = String(args.candidateId || args.candidate_id || '').trim();
  const canonicalId = String(args.canonicalId || args.canonical_id || '').trim();
  const title = String(args.title || args.paperTitle || args.paper_title || '').trim().toLowerCase();
  return (run.candidates || []).find((candidate) => {
    if (candidateId && (candidate.id === candidateId || candidate.candidateId === candidateId || candidate.candidate_id === candidateId)) return true;
    if (canonicalId && (candidate.canonicalId === canonicalId || candidate.canonical_id === canonicalId)) return true;
    if (title && String(candidate.title || '').trim().toLowerCase() === title) return true;
    return false;
  }) || null;
}

function inferSupplementSourceKind(sourcePath = '', explicit = '') {
  const requested = String(explicit || '').trim().toLowerCase();
  if (requested === 'markdown' || requested === 'md') return 'markdown';
  if (requested === 'pdf') return 'pdf';
  const extension = path.extname(String(sourcePath || '')).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.pdf') return 'pdf';
  return '';
}

function resolveLocalSupplementPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '~') return process.env.HOME || raw;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2));
  return raw;
}

function mergeSupplementPaperMetadata(candidate = {}, args = {}) {
  const paperMetadata = normalizeObject(args.paperMetadata || args.paper_metadata);
  const identifiers = {
    ...(candidate.identifiers || {}),
    ...normalizeObject(paperMetadata.identifiers),
    ...normalizeObject(args.identifiers)
  };
  for (const key of ['doi', 'arxivId', 'pmid', 'pmcid', 'isbn', 'issn']) {
    if (args[key]) identifiers[key] = args[key];
    if (paperMetadata[key]) identifiers[key] = paperMetadata[key];
  }
  return {
    ...candidate,
    ...paperMetadata,
    title: args.title || paperMetadata.title || candidate.title,
    authors: paperMetadata.authors || candidate.authors,
    year: args.year || paperMetadata.year || candidate.year,
    identifiers
  };
}

async function createManualSupplementedCandidate(candidate = {}, args = {}) {
  const sourcePath = resolveLocalSupplementPath(args.sourcePath || args.source_path || args.serverFilePath || args.server_file_path);
  if (!sourcePath) return null;
  const sourceKind = inferSupplementSourceKind(sourcePath, args.sourceKind || args.source_kind);
  if (sourceKind !== 'markdown' && sourceKind !== 'pdf') {
    throw new Error('supplement sourcePath must point to a .md, .markdown, or .pdf file, or provide sourceKind.');
  }
  const stats = await fs.stat(sourcePath);
  if (!stats.isFile()) {
    throw new Error('supplement sourcePath must point to a regular file.');
  }
  const buffer = await fs.readFile(sourcePath);
  const contentSha256 = createContentSha256(buffer);
  const sourceProvider = String(args.sourceProvider || args.source_provider || 'manual_supplement').trim();
  const next = mergeSupplementPaperMetadata(candidate, args);
  const identity = createSourceIdentity({
    ...next,
    sourceKind,
    sourceProvider,
    contentSha256,
    resolutionStatus: 'fulltext_ready'
  });

  return {
    ...next,
    source: {
      ...(next.source || {}),
      sourceKind,
      sourcePath,
      sourceProvider: identity.sourceProvider,
      contentSha256: identity.contentSha256,
      sourceId: identity.sourceId,
      resolutionStatus: 'fulltext_ready',
      fullTextStatus: sourceKind === 'markdown' ? 'open_markdown' : 'open_pdf',
      downloadStatus: 'downloaded',
      downloadError: null,
      localMarkdownPath: sourceKind === 'markdown' ? sourcePath : null,
      localPdfPath: sourceKind === 'pdf' ? sourcePath : null,
      markdownUrl: args.markdownUrl || args.markdown_url || next.source?.markdownUrl || '',
      pdfUrl: args.pdfUrl || args.pdf_url || next.source?.pdfUrl || '',
      supplementedAt: new Date().toISOString(),
      resolutionAttempts: [
        ...(next.source?.resolutionAttempts || []),
        {
          provider: identity.sourceProvider,
          sourceKind,
          status: 'success',
          detail: 'manual-supplement',
          path: sourcePath,
          at: new Date().toISOString()
        }
      ],
      supplementation: createDiscoverySupplementationInterface(next, {
        resolutionStatus: 'fulltext_ready'
      })
    }
  };
}

async function resolveUrlSupplementedCandidate(rootPath, candidate = {}, args = {}, options = {}) {
  const markdownUrl = String(args.markdownUrl || args.markdown_url || '').trim();
  const pdfUrl = String(args.pdfUrl || args.pdf_url || '').trim();
  if (!markdownUrl && !pdfUrl) return null;
  const supplemented = mergeSupplementPaperMetadata({
    ...candidate,
    markdownUrl: markdownUrl || candidate.markdownUrl,
    pdfUrl: pdfUrl || candidate.pdfUrl,
    sourceHints: [
      ...(candidate.sourceHints || []),
      markdownUrl,
      pdfUrl
    ].filter(Boolean),
    fullTextUrls: [
      ...(candidate.fullTextUrls || []),
      markdownUrl,
      pdfUrl
    ].filter(Boolean)
  }, args);
  const resolution = await resolveDiscoverySources({
    ...buildDiscoveryParams(rootPath, args, options),
    rootPath,
    candidates: [supplemented],
    maxDownloads: 1,
    allowDownloads: args.allowDownloads ?? args.allow_downloads ?? true,
    preferMarkdown: args.preferMarkdown ?? args.prefer_markdown ?? true
  });
  return resolution.candidates?.[0] || null;
}

function applySupplementCandidate(run = {}, candidate = {}) {
  return {
    ...run,
    candidates: (run.candidates || []).map((entry) => (
      entry === candidate
        || (candidate.canonicalId && (entry.canonicalId === candidate.canonicalId || entry.canonical_id === candidate.canonicalId))
        || (candidate.canonical_id && (entry.canonicalId === candidate.canonical_id || entry.canonical_id === candidate.canonical_id))
        || (candidate.id && (entry.id === candidate.id || entry.candidateId === candidate.id || entry.candidate_id === candidate.id))
        || (candidate.candidateId && (entry.id === candidate.candidateId || entry.candidateId === candidate.candidateId || entry.candidate_id === candidate.candidateId))
        || (candidate.candidate_id && (entry.id === candidate.candidate_id || entry.candidateId === candidate.candidate_id || entry.candidate_id === candidate.candidate_id))
        ? candidate
        : entry
    ))
  };
}

function applySupplementImportResultsToRun(run = {}, importResult = {}) {
  const importsByKey = importResultsByKey(importResult);
  return {
    ...run,
    candidates: (run.candidates || []).map((candidate) => {
      const importEntry = findImportResultForCandidate(candidate, importsByKey);
      if (!importEntry) return candidate;
      return {
        ...candidate,
        import: {
          status: importEntry.status,
          taskId: importEntry.taskId || null,
          taskStatus: importEntry.taskStatus || importEntry.status || '',
          taskStage: importEntry.taskStage || '',
          graphUpdate: importEntry.graphUpdate || null,
          error: importEntry.error || ''
        }
      };
    }),
    importSummary: importResult
  };
}

async function refreshImportTaskStatuses(rootPath, importResult = {}) {
  const results = [];

  for (const entry of importResult.results || []) {
    if (!entry.taskId) {
      results.push(entry);
      continue;
    }

    try {
      const task = await loadImportTask(rootPath, entry.taskId);
      const taskStatus = String(task?.status || '').trim().toLowerCase();
      const status = taskStatus === 'completed'
        ? 'completed'
        : (taskStatus === 'failed' ? 'failed' : entry.status);
      results.push({
        ...entry,
        status,
        taskStatus: taskStatus || entry.status,
        taskStage: task?.stage || '',
        graphUpdate: task?.result?.fastCommitted
          ? {
              paperCount: task.result.fastCommitted.paperCount || 0,
              nodeCount: task.result.fastCommitted.nodeCount || 0,
              relationshipCount: task.result.fastCommitted.relationshipCount || 0,
              authoritativeSyncStatus: task.result.authoritativeSync?.status || ''
            }
          : null,
        error: task?.error?.message || task?.error || entry.error || ''
      });
    } catch (error) {
      results.push({
        ...entry,
        status: entry.status,
        taskStatus: entry.status,
        error: entry.error || error?.message || ''
      });
    }
  }

  return {
    ...importResult,
    completed: results.filter((entry) => entry.status === 'completed').length,
    queued: results.filter((entry) => entry.status === 'submitted').length,
    deduped: results.filter((entry) => entry.status === 'deduped').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results
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

  if (operation === 'supplement') {
    const run = await loadDiscoveryRun(rootPath, args.runId || args.run_id);
    if (!run) {
      throw new Error('No literature discovery run found to supplement.');
    }
    const target = resolveSupplementTarget(run, args);
    if (!target) {
      throw new Error('No matching literature discovery candidate found. Provide candidateId, canonicalId, or title.');
    }

    const supplemented = await createManualSupplementedCandidate(target, args)
      || await resolveUrlSupplementedCandidate(rootPath, target, args, options)
      || {
        ...mergeSupplementPaperMetadata(target, args),
        source: {
          ...(target.source || {}),
          supplementation: createDiscoverySupplementationInterface(target, target.source || {})
        }
      };

    let nextRun = applySupplementCandidate(run, supplemented);
    nextRun.metadataGraph = buildDiscoveryMetadataGraph(nextRun.candidates);
    nextRun.coverage = {
      ...nextRun.coverage,
      resolvedFullTextCount: nextRun.candidates.filter((candidate) => sourceResolutionStatus(candidate) === 'fulltext_ready').length,
      metadataOnlyCount: nextRun.candidates.filter((candidate) => sourceResolutionStatus(candidate) !== 'fulltext_ready').length
    };

    if (enabledFlag(firstDefined(args.importResolved, args.import_resolved, args.processImports, args.process_imports))) {
      let importResult = await submitDiscoveryImports({
        corpus: args.corpus || rootPath,
        candidates: [supplemented],
        maxImported: 1,
        options
      });
      if (shouldProcessImports(operation, args) || enabledFlag(firstDefined(args.processImports, args.process_imports))) {
        importResult = await refreshImportTaskStatuses(rootPath, importResult);
        const processableTaskCount = countProcessableImportTasks(importResult);
        const maxPasses = explicitImportMaxPasses(args, options);
        const processing = processableTaskCount > 0 || maxPasses !== undefined
          ? await runImportQueueUntilIdle(rootPath, buildImportProcessingOptions(args, options, importResult))
          : {
              completedTaskIds: [],
              failedCount: 0,
              skipped: true,
              reason: 'no-submitted-imports'
            };
        importResult = {
          ...(await refreshImportTaskStatuses(rootPath, importResult)),
          processing
        };
      }
      nextRun = applySupplementImportResultsToRun(nextRun, importResult);
      nextRun.coverage = {
        ...nextRun.coverage,
        importedCount: countAcceptedImportResults(importResult)
      };
    }

    if (args.persist !== false) {
      await saveDiscoveryRun(rootPath, nextRun);
    }
    return JSON.stringify(nextRun, null, 2);
  }

  if (
    operation === 'search'
    || operation === 'resolve'
    || operation === 'run'
    || operation === 'import'
    || operation === 'ingest'
    || operation === 'import_and_process'
  ) {
    const run = await runLiteratureDiscovery({
      ...buildDiscoveryParams(rootPath, args, options),
      operation,
      discoveryOperation: operation,
      resolveSources: operation === 'search' ? false : (args.resolveSources ?? args.resolve_sources),
      persist: args.persist !== false
    });

    if (shouldSubmitImports(operation, args)) {
      let importResult = await submitDiscoveryImports({
        corpus: args.corpus || rootPath,
        candidates: run.candidates,
        maxImported: args.maxImported || args.max_imported,
        options
      });
      if (shouldProcessImports(operation, args)) {
        importResult = await refreshImportTaskStatuses(rootPath, importResult);
        const processableTaskCount = countProcessableImportTasks(importResult);
        const maxPasses = explicitImportMaxPasses(args, options);
        const processing = processableTaskCount > 0 || maxPasses !== undefined
          ? await runImportQueueUntilIdle(rootPath, buildImportProcessingOptions(args, options, importResult))
          : {
              completedTaskIds: [],
              failedCount: 0,
              skipped: true,
              reason: 'no-submitted-imports'
            };
        importResult = {
          ...(await refreshImportTaskStatuses(rootPath, importResult)),
          processing
        };
      }
      const nextRun = applyImportResultsToRun(run, importResult);
      nextRun.coverage = {
        ...nextRun.coverage,
        importedCount: countAcceptedImportResults(importResult)
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
