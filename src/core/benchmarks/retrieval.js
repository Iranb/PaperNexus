import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, readJson, writeJson, writeText } from '../../lib/fs.js';
import { createPaperIdentity, normalizePaperIdentifiers, paperIdentifiersOverlap } from '../../lib/paper-identifiers.js';
import {
  jaccardSimilarity,
  scoreTokenOverlap,
  slugify,
  stableHash,
  toNumber,
  tokenizeWithoutStopwords,
  truncate,
  unique
} from '../../lib/utils.js';
import { runLiteratureDiscovery } from '../discovery/workflow.js';
import {
  aggregateTaskEvaluationMetrics,
  evaluateBenchmarkTaskCase,
  normalizeRelations
} from './task-evaluation.js';

const DEFAULT_CUTOFFS = [1, 5, 10, 20];
const DEFAULT_TITLE_MATCH_THRESHOLD = 0.96;
const DEFAULT_FIXED_CORPUS_LIMIT = 1000;

const BENCHMARK_FORMAT_ALIASES = {
  beir: 'beir',
  scifact: 'beir',
  scidocs: 'beir',
  'trec-covid': 'beir',
  treccovid: 'beir',
  nfcorpus: 'beir',
  litsearch: 'litsearch',
  bioasq: 'bioasq',
  trec: 'trec',
  'trec-biomed': 'trec',
  'trec-cds': 'trec',
  'trec-pm': 'trec',
  sage: 'sage',
  scholarqa: 'scholarqa',
  scholarqabench: 'scholarqa',
  openscholar: 'scholarqa',
  paperask: 'paperask',
  sparbench: 'sparbench',
  spar: 'sparbench',
  scinetbench: 'scinetbench',
  csfcube: 'csfcube',
  custom: 'custom',
  json: 'custom',
  jsonl: 'custom'
};

const BENCHMARK_PROFILES = {
  beir: {
    taskType: 'document_retrieval',
    evaluationStyle: 'fixed_corpus_ir',
    nativeMetrics: ['NDCG@k', 'MAP@k', 'Recall@k', 'Precision@k']
  },
  litsearch: {
    taskType: 'paper_retrieval',
    evaluationStyle: 'scientific_literature_search',
    nativeMetrics: ['Recall@k', 'Precision@k', 'MRR@k', 'NDCG@k']
  },
  bioasq: {
    taskType: 'biomedical_qa_retrieval',
    evaluationStyle: 'document_and_snippet_retrieval',
    nativeMetrics: ['MAP', 'GMAP', 'Recall', 'F1']
  },
  trec: {
    taskType: 'biomedical_literature_retrieval',
    evaluationStyle: 'trec_qrels',
    nativeMetrics: ['trec_eval qrels metrics']
  },
  sage: {
    taskType: 'agentic_literature_retrieval',
    evaluationStyle: 'fixed_corpus_agentic_retrieval',
    nativeMetrics: ['ExactMatch@k', 'WeightedRecall@k']
  },
  scholarqa: {
    taskType: 'citation_grounded_qa_retrieval',
    evaluationStyle: 'qa_citation_grounding',
    nativeMetrics: ['accuracy', 'rouge-l', 'rubrics', 'prometheus', 'citations', 'citations_short']
  },
  paperask: {
    taskType: 'scholarly_assistant_reliability',
    evaluationStyle: 'paper_search_reading_claim_verification',
    nativeMetrics: ['citation_retrieval_success', 'content_extraction_field_accuracy', 'paper_discovery_recall', 'claim_verification_success']
  },
  sparbench: {
    taskType: 'agentic_paper_retrieval',
    evaluationStyle: 'expert_annotated_academic_search',
    nativeMetrics: ['F1', 'Recall', 'Precision']
  },
  scinetbench: {
    taskType: 'relation_aware_retrieval',
    evaluationStyle: 'scientific_network_retrieval',
    nativeMetrics: ['novelty/disruption rank', 'novelty/disruption recall', 'novelty/disruption SoS', 'cite accuracy', 'citation sentiment accuracy', 'co-mention accuracy', 'path connectivity', 'path rationality']
  },
  csfcube: {
    taskType: 'faceted_query_by_example',
    evaluationStyle: 'graded_facet_retrieval',
    nativeMetrics: ['NDCG@k', 'MAP@k']
  },
  custom: {
    taskType: 'paper_retrieval',
    evaluationStyle: 'custom_relevance_set',
    nativeMetrics: ['Hit@k', 'Recall@k', 'Precision@k', 'MRR@k', 'MAP@k', 'NDCG@k']
  }
};

function canonicalBenchmarkFormat(value = 'auto') {
  const normalized = String(value || 'auto').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized || normalized === 'auto') return 'auto';
  return BENCHMARK_FORMAT_ALIASES[normalized] || normalized;
}

function benchmarkProfile(format = 'custom') {
  return BENCHMARK_PROFILES[canonicalBenchmarkFormat(format)] || BENCHMARK_PROFILES.custom;
}

function inferTaskType(format = 'custom', entry = {}, fallback = '') {
  const explicit = compactText(pickFirst(
    fallback,
    entry.taskType,
    entry.task_type,
    entry.task,
    entry.subtask
  ));
  if (explicit) return explicit;

  const normalizedFormat = canonicalBenchmarkFormat(format);
  const queryText = compactText(pickFirst(entry.query, entry.question, entry.input, entry.prompt, entry.claim)).toLowerCase();
  const sourceHint = compactText(pickFirst(entry.__sourceFile, entry.sourceFile, entry.source_file, entry.filePath, entry.file_path)).toLowerCase();
  const taskHint = `${queryText} ${sourceHint}`;
  if (normalizedFormat === 'sage') {
    const groundTruth = asObject(entry.groundTruth || entry.ground_truth);
    if (entry.complete_query || entry.completeQuery || sourceHint.includes('sage_short_form_questions')) return 'short_form_paper_finding';
    if (groundTruth.most_relevant || groundTruth.mostRelevant || sourceHint.includes('sage_open_ended_questions')) return 'open_ended_paper_recommendation';
  }
  if (normalizedFormat === 'paperask') {
    if (Array.isArray(entry.fields_tested) || (entry.ground_truth && typeof entry.ground_truth === 'object') || taskHint.includes('content_extraction')) return 'content_extraction';
    if (Array.isArray(entry.papers) || taskHint.includes('citation_retrieval') || queryText.includes('bibtex')) return 'citation_retrieval';
    if (entry.paper_url || entry.paperUrl || taskHint.includes('open_book_cf') || queryText.includes('fact-check') || queryText.includes('verify the claims')) return 'claim_verification';
    if (Array.isArray(entry.ground_truth_papers) || taskHint.includes('open_domain_qa') || queryText.includes('published paper')) return 'paper_discovery';
  }
  if (normalizedFormat === 'scinetbench') {
    if (taskHint.includes('task3') || queryText.includes('citation path') || queryText.includes('evolutionary') || queryText.includes('lineage')) return 'path-wise evolutionary analysis';
    if (taskHint.includes('cooccur') || queryText.includes('co-occur') || queryText.includes('co-mention')) return 'pair-wise co-mention retrieval';
    if (taskHint.includes('pncites') || taskHint.includes('sentiment') || queryText.includes('positively cite') || queryText.includes('negatively cite') || queryText.includes('cite the paper')) return 'pair-wise citation sentiment';
    if (taskHint.includes('task1') || taskHint.includes('novel') || taskHint.includes('disruptive') || queryText.includes('most novel') || queryText.includes('most disruptive')) return 'ego-centric relation retrieval';
  }
  return benchmarkProfile(format).taskType;
}

function normalizeEvaluationMode(value = '') {
  const normalized = String(value || 'live').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'fixed' || normalized === 'fixed-corpus' || normalized === 'corpus') return 'fixed-corpus';
  if (normalized === 'live' || normalized === 'discovery' || normalized === 'providers') return 'live';
  return normalized || 'live';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function normalizeIdentifierAliases(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized.includes(':')) return {};
  const [kind, ...rest] = normalized.split(':');
  const id = rest.join(':').trim();
  const key = kind.trim().toLowerCase();
  if (key === 'arxiv') return { arxivId: id };
  if (key === 'doi') return { doi: id };
  if (key === 'pmid' || key === 'pubmed') return { pmid: id };
  if (key === 'pmcid') return { pmcid: id };
  return {};
}

function extractIdentifiersFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return {};
  const identifiers = {};
  const doiMatch = text.match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  const arxivMatch = text.match(/(?:arxiv:|arxiv\.org\/(?:abs|pdf)\/)([a-z.-]+\/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)/i);
  const pmidMatch = text.match(/(?:pubmed\/|pmid[:/\s]+)(\d+)/i);
  const pmcidMatch = text.match(/(?:pmc\/articles\/|pmcid[:/\s]+|\/)(PMC\d+)/i);
  if (doiMatch) identifiers.doi = doiMatch[0].replace(/[),.;]+$/, '');
  if (arxivMatch) identifiers.arxivId = arxivMatch[1];
  if (pmidMatch) identifiers.pmid = pmidMatch[1];
  if (pmcidMatch) identifiers.pmcid = pmcidMatch[1];
  if (/^\d{6,9}$/.test(text)) identifiers.pmid = text;
  if (/^PMC\d+$/i.test(text)) identifiers.pmcid = text;
  return identifiers;
}

function normalizePaperRecord(value, fallbackId = '') {
  const raw = typeof value === 'string' ? { id: value, title: value } : asObject(value);
  const stringUrl = typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
  const sourceId = compactText(pickFirst(
    raw.id,
    raw._id,
    raw.docId,
    raw.doc_id,
    raw.documentId,
    raw.document_id,
    raw.corpusid,
    raw.corpusId,
    raw.paperId,
    raw.paperID,
    raw.paperid,
    raw.paper_id,
    raw.s2PaperId,
    raw.s2_paper_id,
    raw.semanticScholarId,
    raw.semantic_scholar_id,
    raw.arxivId,
    raw.arxiv_id,
    raw.doi,
    raw.pmid,
    raw.pubmedId,
    raw.url,
    raw.uri,
    fallbackId
  ));
  const canonicalIdInput = compactText(pickFirst(raw.canonicalId, raw.canonical_id));
  const title = compactText(pickFirst(
    raw.title,
    raw.paperTitle,
    raw.paper_title,
    raw.name,
    raw.display_name
  ));
  const identifiers = normalizePaperIdentifiers({
    ...normalizeIdentifierAliases(canonicalIdInput),
    ...extractIdentifiersFromText(sourceId),
    ...extractIdentifiersFromText(canonicalIdInput),
    ...extractIdentifiersFromText(raw.url || raw.uri || raw.sourceUrl || raw.source_url),
    ...asObject(raw.identifiers),
    ...raw
  });
  const identity = createPaperIdentity({
    identifiers,
    title,
    normalizedTitle: raw.normalizedTitle || raw.normalized_title
  });

  return {
    id: sourceId || identity.canonicalId || identity.titleSignature || stableHash(title || JSON.stringify(raw), 16),
    title,
    abstract: compactText(pickFirst(raw.abstract, raw.text, raw.summary)),
    relevance: toNumber(pickFirst(raw.relevance, raw.score, raw.grade), 1),
    identifiers,
    sourceUrl: compactText(pickFirst(raw.url, raw.uri, raw.sourceUrl, raw.source_url, stringUrl)),
    ...identity
  };
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

async function readJsonOrJsonl(filePath) {
  if (filePath.endsWith('.jsonl') || filePath.endsWith('.ndjson')) {
    return readJsonl(filePath);
  }
  const parsed = await readJson(filePath, null);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.queries)) return parsed.queries;
  if (Array.isArray(parsed?.questions)) return parsed.questions;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;
  const mappedEntries = expandObjectMapEntries(parsed);
  if (mappedEntries) return mappedEntries;
  return parsed ? [parsed] : [];
}

async function findFirstExisting(baseDir, names = []) {
  for (const name of names) {
    const candidate = path.join(baseDir, name);
    if (await fileExists(candidate)) return candidate;
  }
  return '';
}

function looksLikePaperReference(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    const identifiers = extractIdentifiersFromText(value);
    return Boolean(identifiers.doi || identifiers.arxivId || identifiers.pmid || identifiers.pmcid);
  }
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(pickFirst(
    value.title,
    value.paperTitle,
    value.paper_title,
    value.doi,
    value.arxivId,
    value.arxiv,
    value.pmid,
    value.pubmedId,
    value.pmcid,
    value.corpusid,
    value.corpusId,
    value.paperId,
    value.paperID,
    value.paperid,
    value.paper_id,
    value.s2PaperId,
    value.s2_paper_id,
    value.semanticScholarId,
    value.semantic_scholar_id,
    value.docId,
    value.doc_id,
    value.url
  ));
}

function paperLikeAnswers(values = []) {
  return values.filter((entry) => looksLikePaperReference(entry));
}

function extractGradedPaperSet(values = [], relevance = 1) {
  return asArray(values)
    .filter((paper) => looksLikePaperReference(paper))
    .map((paper) => ({
      ...(typeof paper === 'object' && !Array.isArray(paper) ? paper : { id: paper, title: paper }),
      relevance: pickFirst(paper?.relevance, paper?.score, paper?.grade, relevance)
    }));
}

function extractSageGroundTruthPapers(entry = {}) {
  const groundTruth = asObject(entry.groundTruth || entry.ground_truth);
  if (!groundTruth.most_relevant && !groundTruth.mostRelevant && !groundTruth.relevant) return [];
  return [
    ...extractGradedPaperSet(groundTruth.most_relevant || groundTruth.mostRelevant, 2),
    ...extractGradedPaperSet(groundTruth.relevant, 1)
  ];
}

function resolveGoldContexts(entry = {}) {
  const ctxs = asArray(entry.ctxs || entry.contexts);
  const byId = new Map(ctxs.map((ctx) => [compactText(ctx?.id), ctx]).filter(([id]) => id));
  return [
    ...asArray(entry.gold_ctx),
    ...asArray(entry.goldCtx),
    ...asArray(entry.gold_context),
    ...asArray(entry.goldContext),
    ...asArray(entry.gold_contexts),
    ...asArray(entry.goldContexts),
    ...asArray(entry.gold_ctxs),
    ...asArray(entry.goldCtxs)
  ].map((ctx) => {
    if (typeof ctx === 'number' && Number.isInteger(ctx)) return ctxs[ctx] || ctxs[ctx - 1] || null;
    if (typeof ctx === 'string' && byId.has(ctx)) return byId.get(ctx);
    return ctx;
  }).filter(Boolean);
}

function hasGoldContextRefs(entry = {}) {
  return [
    entry.gold_ctx,
    entry.goldCtx,
    entry.gold_context,
    entry.goldContext,
    entry.gold_contexts,
    entry.goldContexts,
    entry.gold_ctxs,
    entry.goldCtxs
  ].some((value) => asArray(value).length);
}

function isReferenceOutputEntry(entry = {}) {
  return Boolean(
    entry.output
    && (entry.annotator || entry.subject)
    && !entry.systemAnswer
    && !entry.system_answer
    && !entry.generatedAnswer
    && !entry.generated_answer
    && !entry.predictedAnswer
    && !entry.predicted_answer
    && !entry.prediction
  );
}

function resolveReferenceContexts(entry = {}) {
  if (!isReferenceOutputEntry(entry) || hasGoldContextRefs(entry)) return [];
  return asArray(entry.ctxs || entry.contexts);
}

function extractRelevantInputs(entry = {}) {
  return [
    ...resolveGoldContexts(entry),
    ...resolveReferenceContexts(entry),
    ...asArray(entry.paper),
    ...asArray(entry.papers),
    ...asArray(entry.url),
    ...asArray(entry.sourceUrl),
    ...asArray(entry.source_url),
    ...asArray(entry.paperUrl),
    ...asArray(entry.paper_url),
    ...asArray(entry.paperUrls),
    ...asArray(entry.paper_urls),
    ...asArray(entry.urls),
    ...asArray(entry.relevant),
    ...asArray(entry.relevantPapers),
    ...asArray(entry.relevant_papers),
    ...asArray(entry.relevantDocs),
    ...asArray(entry.relevant_docs),
    ...asArray(entry.relevantDocuments),
    ...asArray(entry.relevant_documents),
    ...asArray(entry.gold),
    ...asArray(entry.goldPapers),
    ...asArray(entry.gold_papers),
    ...asArray(entry.groundTruthPapers),
    ...asArray(entry.ground_truth_papers),
    ...asArray(entry.goldDocs),
    ...asArray(entry.gold_docs),
    ...asArray(entry.goldDocuments),
    ...asArray(entry.gold_documents),
    ...asArray(entry.positivePapers),
    ...asArray(entry.positive_papers),
    ...asArray(entry.positiveDocs),
    ...asArray(entry.positive_docs),
    ...asArray(entry.citations),
    ...asArray(entry.references),
    ...asArray(entry.documents),
    ...asArray(entry.docs),
    ...asArray(entry.evidence),
    ...asArray(entry.evidencePapers),
    ...asArray(entry.evidence_papers),
    ...asArray(entry.supportingPapers),
    ...asArray(entry.supporting_papers),
    ...asArray(entry.supportDocs),
    ...asArray(entry.support_docs),
    ...asArray(entry.targetPapers),
    ...asArray(entry.target_papers),
    ...asArray(entry.pathPapers),
    ...asArray(entry.path_papers),
    ...asArray(entry.inspiringPaper),
    ...asArray(entry.inspiring_paper),
    ...extractSageGroundTruthPapers(entry),
    ...paperLikeAnswers(asArray(entry.answers)),
    ...paperLikeAnswers(asArray(entry.expected)),
    ...paperLikeAnswers(asArray(entry.groundTruth)),
    ...paperLikeAnswers(asArray(entry.ground_truth))
  ];
}

function extractGoldIds(entry = {}) {
  return [
    ...asArray(entry.goldIds),
    ...asArray(entry.gold_ids),
    ...asArray(entry.goldPaperIds),
    ...asArray(entry.gold_paper_ids),
    ...asArray(entry.relevantIds),
    ...asArray(entry.relevant_ids),
    ...asArray(entry.corpusids),
    ...asArray(entry.corpusIds),
    ...asArray(entry.corpus_ids),
    ...asArray(entry.paperIds),
    ...asArray(entry.paper_ids),
    ...asArray(entry.docIds),
    ...asArray(entry.doc_ids),
    ...asArray(entry.documentIds),
    ...asArray(entry.document_ids),
    ...asArray(entry.positiveDocIds),
    ...asArray(entry.positive_doc_ids),
    ...asArray(entry.evidenceIds),
    ...asArray(entry.evidence_ids),
    ...asArray(entry.referenceIds),
    ...asArray(entry.reference_ids),
    ...asArray(entry.citationIds),
    ...asArray(entry.citation_ids)
  ].map((value) => compactText(value)).filter(Boolean);
}

function extractReferenceAnswers(entry = {}) {
  const values = [
    ...asArray(entry.groundTruth).filter((answer) => !looksLikePaperReference(answer)),
    ...asArray(entry.ground_truth).filter((answer) => !looksLikePaperReference(answer)),
    ...asArray(entry.referenceAnswer),
    ...asArray(entry.reference_answer),
    ...asArray(entry.referenceAnswers),
    ...asArray(entry.reference_answers),
    ...asArray(entry.idealAnswer),
    ...asArray(entry.ideal_answer),
    ...asArray(entry.idealAnswers),
    ...asArray(entry.ideal_answers),
    ...asArray(entry.expectedAnswer),
    ...asArray(entry.expected_answer),
    ...asArray(entry.expectedAnswers),
    ...asArray(entry.expected_answers),
    ...asArray(entry.expectedOutput),
    ...asArray(entry.expected_output),
    ...asArray(isReferenceOutputEntry(entry) ? entry.output : []),
    ...asArray(entry.answer),
    ...asArray(entry.answer_txt),
    ...asArray(entry.answers).filter((answer) => !looksLikePaperReference(answer))
  ];
  return values
    .map((value) => (typeof value === 'string' ? value : pickFirst(value?.text, value?.answer, value?.value)))
    .map(compactText)
    .filter(Boolean);
}

function extractReferenceRubrics(entry = {}) {
  const metricConfig = asObject(entry.metric_config?.config || entry.metricConfig?.config || entry.metricConfig || entry.metric_config);
  const ingredients = asObject(entry.ingredients);
  const rubricItems = [
    ...asArray(entry.rubric),
    ...asArray(entry.rubrics),
    ...asArray(entry.criteria),
    ...asArray(entry.referenceRubric),
    ...asArray(entry.reference_rubric),
    ...asArray(metricConfig.other_properties),
    ...asArray(metricConfig.rubric),
    ...asArray(metricConfig.rubrics),
    ...asArray(ingredients.most_important),
    ...asArray(ingredients.nice_to_have)
  ];
  return rubricItems
    .map((item, index) => {
      if (typeof item === 'string') return { name: `rubric_${index + 1}`, criterion: compactText(item), weight: 1, evidence: [] };
      const raw = asObject(item);
      const criterion = compactText(pickFirst(raw.criterion, raw.text, raw.description, raw.name));
      if (!criterion) return null;
      return {
        name: compactText(pickFirst(raw.name, `rubric_${index + 1}`)),
        criterion,
        weight: toNumber(raw.weight, 1),
        evidence: asArray(raw.evidence || raw.snippets || raw.references).map(compactText).filter(Boolean)
      };
    })
    .filter(Boolean);
}

function extractExpectedLabel(entry = {}) {
  const label = compactText(pickFirst(
    entry.expectedLabel,
    entry.expected_label,
    entry.label,
    entry.verdict,
    entry.claimLabel,
    entry.claim_label,
    entry.goldLabel,
    entry.gold_label,
    entry.classification,
    entry.expectedVerdict,
    entry.expected_verdict
  ));
  if (label) return label;
  const groundTruth = [entry.groundTruth, entry.ground_truth]
    .find((value) => typeof value === 'string' && /^(true|false|yes|no|supported|refuted|insufficient|maybe|unknown|not enough information|nei)$/i.test(value.trim()));
  if (groundTruth) return groundTruth;
  const answer = compactText(entry.answer);
  return /^(true|false|yes|no|supported|refuted|insufficient|maybe|unknown|not enough information|nei)$/i.test(answer)
    ? answer
    : '';
}

function isGradedPaperGroundTruth(value = {}) {
  const raw = asObject(value);
  return Boolean(raw.most_relevant || raw.mostRelevant || raw.relevant);
}

function extractExpectedStructuredAnswer(entry = {}) {
  const candidates = [entry.expectedStructuredAnswer, entry.expected_structured_answer, entry.groundTruth, entry.ground_truth]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value) && !isGradedPaperGroundTruth(value));
  return candidates.find((value) => Array.isArray(entry.fields_tested) || !looksLikePaperReference(value)) || null;
}

function extractExpectedLabels(entry = {}) {
  return [
    ...asArray(entry.expectedLabels),
    ...asArray(entry.expected_labels),
    ...asArray(entry.labels),
    ...asArray(entry.verdicts),
    ...asArray(entry.claimLabels),
    ...asArray(entry.claim_labels),
    ...asArray(entry.goldLabels),
    ...asArray(entry.gold_labels),
    ...asArray(entry.expectedVerdicts),
    ...asArray(entry.expected_verdicts)
  ].map(compactText).filter(Boolean);
}

function extractGoldRelations(entry = {}) {
  const directRelations = [
    ...asArray(entry.goldRelations),
    ...asArray(entry.gold_relations),
    ...asArray(entry.expectedRelations),
    ...asArray(entry.expected_relations),
    ...asArray(entry.relations),
    ...asArray(entry.paths),
    ...asArray(entry.paperPath),
    ...asArray(entry.paper_path),
    ...asArray(entry.evolutionPath),
    ...asArray(entry.evolution_path),
    ...asArray(entry.trajectory),
    ...asArray(entry.trajectories),
    ...asArray(entry.goldPaths),
    ...asArray(entry.gold_paths),
    ...asArray(entry.evidencePaths),
    ...asArray(entry.evidence_paths)
  ];
  const pairRelation = pickFirst(
    entry.citationSentiment,
    entry.citation_sentiment,
    entry.citeSentiment,
    entry.cite_sentiment,
    entry.coMention,
    entry.co_mention,
    entry.coMentionLabel,
    entry.co_mention_label,
    entry.relationLabel,
    entry.relation_label
  );
  if (pairRelation) {
    directRelations.push({
      source: pickFirst(entry.sourcePaper, entry.source_paper, entry.sourcePaperId, entry.source_paper_id, entry.source),
      target: pickFirst(entry.targetPaper, entry.target_paper, entry.targetPaperId, entry.target_paper_id, entry.target),
      type: pairRelation,
      evidence: pickFirst(entry.citationContext, entry.citation_context, entry.context, entry.paragraph)
    });
  }
  return normalizeRelations(directRelations);
}

function extractSystemAnswer(entry = {}) {
  const output = isReferenceOutputEntry(entry) ? undefined : entry.output;
  const explicit = pickFirst(
    entry.systemAnswer,
    entry.system_answer,
    entry.generatedAnswer,
    entry.generated_answer,
    entry.predictedAnswer,
    entry.predicted_answer,
    entry.prediction,
    output
  );
  if (explicit && typeof explicit === 'object') return explicit;
  const answer = compactText(explicit);
  const predictedRelations = normalizeRelations([
    ...asArray(entry.predictedRelations),
    ...asArray(entry.predicted_relations),
    ...asArray(entry.predictedPaths),
    ...asArray(entry.predicted_paths)
  ]);
  const predictedLabel = compactText(pickFirst(
    entry.predictedLabel,
    entry.predicted_label,
    entry.predictedVerdict,
    entry.predicted_verdict,
    entry.outputLabel,
    entry.output_label
  ));
  if (!answer && !predictedRelations.length && !predictedLabel) return null;
  return {
    answer,
    verdict: predictedLabel,
    labels: [
      ...asArray(entry.predictedLabels),
      ...asArray(entry.predicted_labels),
      ...asArray(entry.outputLabels),
      ...asArray(entry.output_labels)
    ].map(compactText).filter(Boolean),
    relations: predictedRelations,
    citations: [
      ...asArray(entry.predictedCitations),
      ...asArray(entry.predicted_citations),
      ...asArray(entry.citedPapers),
      ...asArray(entry.cited_papers),
      ...asArray(entry.ctxs),
      ...asArray(entry.contexts)
    ]
  };
}

function hasBenchmarkEntryShape(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Boolean(pickFirst(
    parsed.query,
    parsed.question,
    parsed.input,
    parsed.body,
    parsed.topic,
    parsed.text,
    parsed.claim,
    parsed.prompt,
    parsed.initial_prompt,
    parsed.complete_query,
    parsed.completeQuery,
    parsed.metric_config?.config?.question,
    parsed.metricConfig?.config?.question,
    parsed.problem,
    parsed.userQuery,
    parsed.user_query,
    parsed.searchQuery,
    parsed.search_query
  ));
}

function expandObjectMapEntries(parsed = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || hasBenchmarkEntryShape(parsed)) return null;
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  return entries.map(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        ...value,
        id: pickFirst(value.id, value._id, value.qid, value.queryId, value.query_id, value.test_case, value.case_id, key),
        query: pickFirst(value.query, value.question, value.input, value.prompt, value.text, value.title, key)
      };
    }
    return {
      id: key,
      query: compactText(value)
    };
  });
}

function normalizeBenchmarkQuery(entry = {}, index = 0, corpusById = new Map(), options = {}) {
  const id = compactText(pickFirst(
    entry.id,
    entry._id,
    entry.qid,
    entry.queryId,
    entry.query_id,
    entry.test_case,
    entry.case_id,
    entry.caseId,
    entry.paperId,
    entry.paperID,
    entry.paperid,
    entry.paper_id,
    index + 1
  ));
  const query = compactText(pickFirst(
    entry.query,
    entry.question,
    entry.input,
    entry.body,
    entry.topic,
    entry.text,
    entry.claim,
    entry.prompt,
    entry.initial_prompt,
    entry.initialPrompt,
    entry.complete_query,
    entry.completeQuery,
    entry.metric_config?.config?.question,
    entry.metricConfig?.config?.question,
    entry.problem,
    entry.userQuery,
    entry.user_query,
    entry.searchQuery,
    entry.search_query
  ));
  if (!query) return null;

  const directRelevant = extractRelevantInputs(entry).map((paper, relevantIndex) => (
    normalizePaperRecord(paper, `${id}:rel:${relevantIndex}`)
  ));
  const idRelevant = extractGoldIds(entry)
    .map((goldId) => corpusById.get(goldId) || normalizePaperRecord({ id: goldId, title: goldId }))
    .filter(Boolean);
  const relevant = dedupePapers([...directRelevant, ...idRelevant]);
  const format = canonicalBenchmarkFormat(options.format || entry.format || 'custom');
  const taskType = inferTaskType(format, entry, options.taskType);
  const referenceAnswers = extractReferenceAnswers(entry);
  const referenceRubrics = extractReferenceRubrics(entry);
  const expectedLabel = extractExpectedLabel(entry);
  const expectedLabels = extractExpectedLabels(entry);
  const expectedStructuredAnswer = extractExpectedStructuredAnswer(entry);
  const goldRelations = extractGoldRelations(entry);
  const systemAnswer = extractSystemAnswer(entry);

  return {
    id,
    query,
    referenceAnswers,
    referenceRubrics,
    expectedLabel,
    expectedLabels,
    expectedStructuredAnswer,
    goldRelations,
    systemAnswer,
    metadata: {
      benchmarkFormat: format,
      taskType,
      hasTaskEvaluationTarget: Boolean(referenceAnswers.length || referenceRubrics.length || expectedLabel || expectedLabels.length || expectedStructuredAnswer || goldRelations.length || systemAnswer),
      queryType: compactText(pickFirst(entry.queryType, entry.query_type, entry.type, options.queryType)),
      facet: compactText(pickFirst(entry.facet, entry.aspect, entry.section, entry.category)),
      sourcePaperId: compactText(pickFirst(entry.sourcePaperId, entry.source_paper_id, entry.queryPaperId, entry.query_paper_id)),
      relationType: compactText(pickFirst(entry.relationType, entry.relation_type, entry.relation)),
      sourceFile: compactText(entry.__sourceFile || entry.sourceFile || entry.source_file),
      specificity: entry.specificity ?? null,
      quality: entry.quality ?? null,
      source: entry.source ?? entry.sourceType ?? entry.source_type ?? null,
      native: asObject(entry.metadata)
    },
    relevant
  };
}

function shouldKeepLoadedQuery(queryCase = null, format = 'custom') {
  if (!queryCase) return false;
  if (queryCase.relevant.length || queryCase.metadata?.hasTaskEvaluationTarget) return true;
  return canonicalBenchmarkFormat(format) === 'scinetbench' && Boolean(queryCase.query);
}

function dedupePapers(papers = []) {
  const seen = new Set();
  const deduped = [];
  for (const paper of papers) {
    const key = paper.canonicalId || paper.normalizedTitle || paper.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }
  return deduped;
}

function normalizeCutoffs(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const cutoffs = rawValues
    .map((entry) => Math.floor(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return unique(cutoffs.length ? cutoffs : DEFAULT_CUTOFFS).sort((left, right) => left - right);
}

async function loadCustomBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const parsed = absolutePath.endsWith('.jsonl') || absolutePath.endsWith('.ndjson')
    ? await readJsonl(absolutePath)
    : await readJson(absolutePath, null);
  const corpus = Array.isArray(parsed?.corpus)
    ? parsed.corpus.map((entry, index) => normalizePaperRecord(entry, `corpus:${index}`))
    : [];
  const corpusById = new Map(corpus.flatMap((paper) => (
    [paper.id, paper.canonicalId, paper.normalizedTitle].filter(Boolean).map((id) => [id, paper])
  )));
  const entries = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.queries) ? parsed.queries : await readJsonOrJsonl(absolutePath));
  const queries = entries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format: options.formatName || options.format || 'custom',
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, options.formatName || options.format || 'custom'));
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'custom');

  return {
    name: options.name || parsed?.name || path.basename(absolutePath).replace(/\.(jsonl|ndjson|json)$/i, '') || 'custom-retrieval',
    format,
    profile: benchmarkProfile(format),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function loadBeirCorpus(corpusPath) {
  const entries = await readJsonl(corpusPath);
  const byId = new Map();
  for (const entry of entries) {
    const id = compactText(pickFirst(entry._id, entry.id, entry.docId, entry.doc_id));
    if (!id) continue;
    byId.set(id, normalizePaperRecord({
      ...entry,
      id,
      title: entry.title,
      abstract: entry.text
    }));
  }
  return byId;
}

async function loadBeirQueries(queriesPath) {
  const entries = await readJsonl(queriesPath);
  const byId = new Map();
  for (const entry of entries) {
    const id = compactText(pickFirst(entry._id, entry.id, entry.qid, entry.queryId, entry.query_id));
    const query = compactText(pickFirst(entry.text, entry.query, entry.question));
    if (id && query) byId.set(id, query);
  }
  return byId;
}

function parseQrelsLine(line = '', lineNumber = 0) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes('\t') ? /\t+/ : /\s+/;
  const parts = trimmed.split(separator).map((part) => part.trim()).filter(Boolean);
  if (lineNumber === 0 && /query|qid/i.test(parts[0] || '') && /corpus|doc/i.test(parts[1] || '')) {
    return null;
  }
  if (parts.length >= 4 && parts[1] === '0') {
    return {
      queryId: parts[0],
      documentId: parts[2],
      relevance: Number(parts[3])
    };
  }
  if (parts.length >= 3) {
    return {
      queryId: parts[0],
      documentId: parts[1],
      relevance: Number(parts[2])
    };
  }
  return null;
}

async function loadQrels(qrelsPath) {
  const content = await fs.readFile(qrelsPath, 'utf8');
  const byQuery = new Map();
  content.split(/\r?\n/).forEach((line, lineNumber) => {
    const entry = parseQrelsLine(line, lineNumber);
    if (!entry || !entry.queryId || !entry.documentId || !(entry.relevance > 0)) return;
    if (!byQuery.has(entry.queryId)) byQuery.set(entry.queryId, []);
    byQuery.get(entry.queryId).push(entry);
  });
  return byQuery;
}

async function loadBeirBenchmark(datasetPath, options = {}) {
  const baseDir = path.resolve(options.cwd || process.cwd(), datasetPath);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstExisting(baseDir, ['corpus.jsonl']);
  const queriesPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : await findFirstExisting(baseDir, ['queries.jsonl']);
  const qrelsPath = options.qrelsPath
    ? path.resolve(options.cwd || process.cwd(), options.qrelsPath)
    : await findFirstExisting(baseDir, [
      path.join('qrels', 'test.tsv'),
      path.join('qrels', 'dev.tsv'),
      path.join('qrels', 'train.tsv'),
      'qrels.tsv',
      'test.tsv'
    ]);

  if (!corpusPath || !queriesPath || !qrelsPath) {
    throw new Error('BEIR format requires corpus.jsonl, queries.jsonl, and qrels/*.tsv.');
  }

  const [corpusById, queryById, qrelsByQuery] = await Promise.all([
    loadBeirCorpus(corpusPath),
    loadBeirQueries(queriesPath),
    loadQrels(qrelsPath)
  ]);
  const queries = [...qrelsByQuery.entries()]
    .map(([queryId, qrels]) => {
      const query = queryById.get(queryId);
      if (!query) return null;
      return normalizeBenchmarkQuery({
        id: queryId,
        query,
        relevant: qrels.map((entry) => ({
          ...(corpusById.get(entry.documentId) || {}),
          id: entry.documentId,
          relevance: entry.relevance
        }))
      }, 0, corpusById, {
        format: options.formatName || options.format || 'beir',
        taskType: options.taskType
      });
    })
    .filter(Boolean);
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'beir');
  const corpus = [...corpusById.values()];

  return {
    name: options.name || path.basename(baseDir) || 'beir-retrieval',
    format,
    profile: benchmarkProfile(format),
    sourcePath: baseDir,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function loadLitSearchBenchmark(datasetPath, options = {}) {
  const baseDir = path.resolve(options.cwd || process.cwd(), datasetPath);
  const queryPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : await findFirstExisting(baseDir, ['query.jsonl', 'queries.jsonl', 'query.json', 'queries.json']);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstExisting(baseDir, ['corpus_clean.jsonl', 'corpus.jsonl', 'corpus_clean.json', 'corpus.json']);

  if (!queryPath || !corpusPath) {
    throw new Error('LitSearch format requires exported query and corpus_clean files as JSON/JSONL.');
  }

  const corpusEntries = await readJsonOrJsonl(corpusPath);
  const corpusById = new Map();
  for (const entry of corpusEntries) {
    const id = compactText(pickFirst(entry.corpusid, entry.corpusId, entry.corpus_id, entry._id, entry.id));
    if (id) corpusById.set(id, normalizePaperRecord({ ...entry, id }));
  }

  const queryEntries = await readJsonOrJsonl(queryPath);
  const queries = queryEntries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format: options.formatName || options.format || 'litsearch',
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, options.formatName || options.format || 'litsearch'));
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'litsearch');
  const corpus = [...corpusById.values()];

  return {
    name: options.name || 'LitSearch',
    format,
    profile: benchmarkProfile(format),
    sourcePath: baseDir,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

async function listDirectoryFiles(baseDir) {
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function pathKey(filePath = '') {
  return String(filePath || '').split(path.sep).join('/');
}

async function findFirstMatchingFile(baseDir, matchers = []) {
  const files = await listDirectoryFiles(baseDir);
  for (const matcher of matchers) {
    const found = files.find((file) => (
      typeof matcher === 'string'
        ? file.toLowerCase() === matcher.toLowerCase()
        : matcher.test(file)
    ));
    if (found) return path.join(baseDir, found);
  }
  return '';
}

async function findMatchingFiles(baseDir, matchers = []) {
  const files = await listDirectoryFiles(baseDir);
  return files
    .filter((file) => matchers.some((matcher) => (
      typeof matcher === 'string'
        ? file.toLowerCase() === matcher.toLowerCase()
        : matcher.test(file)
    )))
    .map((file) => path.join(baseDir, file))
    .sort();
}

async function listFilesRecursive(baseDir, options = {}) {
  const maxDepth = Math.max(0, Number(options.maxDepth ?? 4));
  const skipDirs = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
  const files = [];

  async function visit(currentDir, depth) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await visit(path.join(currentDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        files.push(path.join(currentDir, entry.name));
      }
    }
  }

  await visit(baseDir, 0);
  return files.sort();
}

function isJsonDataFile(filePath = '') {
  return /\.(jsonl|ndjson|json)$/i.test(filePath);
}

function isFlexibleQueryPath(filePath = '', baseDir = '', format = 'custom') {
  if (!isJsonDataFile(filePath)) return false;
  const relative = pathKey(path.relative(baseDir, filePath)).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  if (format === 'paperask') {
    return relative.includes('test_cases/')
      || ['citation_retrieval', 'content_extraction', 'open_domain_qa', 'open_book_cf'].some((part) => relative.includes(part));
  }

  if (format === 'scholarqa') {
    if (relative.includes('/src_answers/') || relative.startsWith('src_answers/')) return false;
    return basename === 'test_configs_snippets.json'
      || basename === 'human_answers.json'
      || /(?:scifact|pubmed|qasa)_test\.jsonl$/i.test(basename)
      || /^scholarqabench_(?:bio|neuro)\.jsonl$/i.test(basename);
  }

  if (format === 'sage') {
    return relative.includes('sage_short_form_questions/')
      || relative.includes('sage_open_ended_questions/')
      || ['queries.jsonl', 'queries.json', 'questions.jsonl', 'questions.json', 'query.jsonl', 'query.json'].includes(basename)
      || /(?:sage|questions?).*\.(jsonl|ndjson|json)$/i.test(basename);
  }

  if (format === 'scinetbench') {
    return relative.includes('queries/')
      || /^queries(?:_|-)/i.test(basename)
      || /^queries_task/i.test(basename);
  }

  return [
    'queries.jsonl',
    'queries.json',
    'questions.jsonl',
    'questions.json',
    'query.jsonl',
    'query.json',
    'data.jsonl',
    'data.json',
    'benchmark.jsonl',
    'benchmark.json'
  ].includes(basename) || /(?:queries|questions|benchmark).*\.(jsonl|json)$/i.test(basename);
}

async function findFlexibleQueryPaths(queryInputPath, baseDir, format = 'custom') {
  const stat = await fs.stat(queryInputPath);
  if (!stat.isDirectory()) return [queryInputPath];
  const files = await listFilesRecursive(queryInputPath, { maxDepth: 5 });
  return files.filter((filePath) => isFlexibleQueryPath(filePath, baseDir, format));
}

async function hasBeirQrels(baseDir) {
  return Boolean(await findFirstExisting(baseDir, [
    path.join('qrels', 'test.tsv'),
    path.join('qrels', 'dev.tsv'),
    path.join('qrels', 'train.tsv'),
    'qrels.tsv',
    'test.tsv'
  ]));
}

async function loadCorpusFromPath(corpusPath = '') {
  if (!corpusPath) return { corpus: [], corpusById: new Map() };
  const entries = await readJsonOrJsonl(corpusPath);
  const corpus = entries.map((entry, index) => normalizePaperRecord(entry, `corpus:${index}`));
  const corpusById = new Map();
  for (const paper of corpus) {
    for (const id of unique([paper.id, paper.canonicalId, paper.normalizedTitle, ...collectMatchAliases(paper)].filter(Boolean))) {
      corpusById.set(id, paper);
    }
  }
  return { corpus, corpusById };
}

async function loadFlexibleSchemaBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const format = canonicalBenchmarkFormat(options.formatName || options.format || 'custom');
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : (stat.isDirectory() ? await findFirstMatchingFile(baseDir, [
      'corpus.jsonl',
      'corpus.json',
      'papers.jsonl',
      'papers.json',
      'documents.jsonl',
      'documents.json',
      /metadata.*\.jsonl$/i,
      /corpus.*\.jsonl$/i
    ]) : '');
  const queryInputPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : absolutePath;
  const queryPaths = stat.isDirectory()
    ? await findFlexibleQueryPaths(queryInputPath, baseDir, format)
    : [absolutePath];

  if (!queryPaths.length) {
    throw new Error(`${format} format requires a query/question JSON or JSONL file.`);
  }

  const { corpus, corpusById } = await loadCorpusFromPath(corpusPath);
  const entries = (await Promise.all(queryPaths.map(async (queryPath) => {
    const sourceFile = pathKey(path.relative(baseDir, queryPath));
    const loaded = await readJsonOrJsonl(queryPath);
    return loaded.map((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...entry, __sourceFile: sourceFile }
        : { query: entry, __sourceFile: sourceFile }
    ));
  }))).flat();
  const queries = entries
    .map((entry, index) => normalizeBenchmarkQuery(entry, index, corpusById, {
      format,
      taskType: options.taskType
    }))
    .filter((entry) => shouldKeepLoadedQuery(entry, format));

  return {
    name: options.name || format,
    format,
    profile: benchmarkProfile(format),
    sourcePath: absolutePath,
    queryPaths,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

function bioasqDocumentToPaper(document = '') {
  const text = compactText(document);
  const identifiers = extractIdentifiersFromText(text);
  const pmid = identifiers.pmid || text.match(/\/(\d{6,9})(?:$|[?#])/i)?.[1] || '';
  return normalizePaperRecord({
    id: text || pmid,
    title: text || pmid,
    url: text,
    pmid
  });
}

async function loadBioAsqBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const dataPath = stat.isDirectory()
    ? await findFirstMatchingFile(absolutePath, [
      'bioasq.json',
      'training.json',
      'train.json',
      'test.json',
      'questions.json',
      /bioasq.*\.json$/i,
      /.*questions.*\.json$/i
    ])
    : absolutePath;
  if (!dataPath) throw new Error('BioASQ format requires a JSON file with a questions array.');

  const parsed = await readJson(dataPath, null);
  const entries = Array.isArray(parsed) ? parsed : asArray(parsed?.questions || parsed?.data || parsed?.items);
  const queries = entries.map((entry, index) => {
    const documents = [
      ...asArray(entry.documents),
      ...asArray(entry.ideal_answer_documents),
      ...asArray(entry.exact_answer_documents),
      ...asArray(entry.snippets).map((snippet) => snippet?.document).filter(Boolean)
    ];
    return normalizeBenchmarkQuery({
      ...entry,
      id: pickFirst(entry.id, entry._id, entry.qid, index + 1),
      query: pickFirst(entry.body, entry.question, entry.query),
      relevant: documents.map(bioasqDocumentToPaper),
      taskType: 'biomedical_qa_retrieval',
      queryType: entry.type
    }, index, new Map(), {
      format: 'bioasq',
      taskType: 'biomedical_qa_retrieval'
    });
  }).filter((entry) => entry && entry.relevant.length);

  return {
    name: options.name || parsed?.name || 'BioASQ',
    format: 'bioasq',
    profile: benchmarkProfile('bioasq'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: 0,
    corpus: [],
    queries
  };
}

function stripXmlTags(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlField(block = '', field = '') {
  const pattern = new RegExp(`<${field}[^>]*>([\\s\\S]*?)<\\/${field}>`, 'i');
  return stripXmlTags(block.match(pattern)?.[1] || '');
}

async function parseTrecTopics(topicsPath) {
  if (topicsPath.endsWith('.json') || topicsPath.endsWith('.jsonl') || topicsPath.endsWith('.ndjson')) {
    const entries = await readJsonOrJsonl(topicsPath);
    return new Map(entries.map((entry, index) => [
      compactText(pickFirst(entry.id, entry._id, entry.number, entry.qid, index + 1)),
      compactText(pickFirst(entry.query, entry.title, entry.summary, entry.description, entry.question, entry.text))
    ]).filter(([id, query]) => id && query));
  }

  const content = await fs.readFile(topicsPath, 'utf8');
  const topics = new Map();
  const topicBlocks = [...content.matchAll(/<topic\b[^>]*>[\s\S]*?<\/topic>/gi)];
  for (const match of topicBlocks) {
    const block = match[0];
    const id = compactText(
      block.match(/<topic\b[^>]*(?:number|id)=["']?([^"'\s>]+)["']?/i)?.[1]
      || extractXmlField(block, 'number')
      || extractXmlField(block, 'num').replace(/^Number:\s*/i, '')
    );
    const fields = [
      extractXmlField(block, 'title'),
      extractXmlField(block, 'summary'),
      extractXmlField(block, 'description'),
      extractXmlField(block, 'desc'),
      extractXmlField(block, 'narrative'),
      extractXmlField(block, 'disease'),
      extractXmlField(block, 'gene'),
      extractXmlField(block, 'demographic'),
      extractXmlField(block, 'other')
    ].filter(Boolean);
    if (id && fields.length) topics.set(id, compactText(fields.join(' ')));
  }
  return topics;
}

async function loadTrecBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);

  if (stat.isDirectory() && await fileExists(path.join(baseDir, 'corpus.jsonl')) && await fileExists(path.join(baseDir, 'queries.jsonl'))) {
    return loadBeirBenchmark(baseDir, { ...options, formatName: 'trec' });
  }

  const topicsPath = options.queriesPath
    ? path.resolve(options.cwd || process.cwd(), options.queriesPath)
    : (stat.isDirectory() ? await findFirstMatchingFile(baseDir, [
      'topics.xml',
      'queries.xml',
      'topics.json',
      'topics.jsonl',
      'queries.json',
      'queries.jsonl',
      /topics.*\.(xml|json|jsonl)$/i
    ]) : absolutePath);
  const qrelsPath = options.qrelsPath
    ? path.resolve(options.cwd || process.cwd(), options.qrelsPath)
    : await findFirstExisting(baseDir, ['qrels/test.tsv', 'qrels.tsv', 'qrels.txt', 'qrels']);
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstMatchingFile(baseDir, ['corpus.jsonl', 'corpus.json', 'papers.jsonl', 'documents.jsonl']);

  if (!topicsPath || !qrelsPath) {
    throw new Error('TREC format requires topics plus qrels, or a BEIR-style directory.');
  }

  const [queryById, qrelsByQuery, { corpus, corpusById }] = await Promise.all([
    parseTrecTopics(topicsPath),
    loadQrels(qrelsPath),
    loadCorpusFromPath(corpusPath)
  ]);
  const queries = [...qrelsByQuery.entries()].map(([queryId, qrels], index) => {
    const query = queryById.get(queryId);
    if (!query) return null;
    return normalizeBenchmarkQuery({
      id: queryId,
      query,
      relevant: qrels.map((entry) => ({
        ...(corpusById.get(entry.documentId) || {}),
        id: entry.documentId,
        title: entry.documentId,
        relevance: entry.relevance
      }))
    }, index, corpusById, {
      format: 'trec',
      taskType: 'biomedical_literature_retrieval'
    });
  }).filter(Boolean);

  return {
    name: options.name || path.basename(baseDir) || 'TREC',
    format: 'trec',
    profile: benchmarkProfile('trec'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

function normalizeCsfcubeAnnotationSet(value, corpusById = new Map()) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizePaperRecord({
      ...(typeof entry === 'object' ? entry : { id: entry }),
      id: pickFirst(entry?.id, entry?.paperId, entry?.paper_id, entry?.pid, entry?.corpusid, entry?.corpusId, entry),
      relevance: pickFirst(entry?.relevance, entry?.score, entry?.grade, entry?.label, 1)
    }, `csfcube:${index}`));
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, relevance]) => Number(relevance) > 0)
      .map(([paperId, relevance]) => normalizePaperRecord({
        ...(corpusById.get(paperId) || {}),
        id: paperId,
        title: corpusById.get(paperId)?.title || paperId,
        relevance
      }));
  }
  return [];
}

function inferCsfcubeFacetFromPath(filePath = '') {
  const basename = path.basename(filePath).toLowerCase();
  for (const facet of ['background', 'method', 'result']) {
    if (basename.includes(`-${facet}`) || basename.includes(`_${facet}`) || basename.includes(facet)) return facet;
  }
  return '';
}

async function loadCsfcubeBenchmark(datasetPath, options = {}) {
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);
  const baseDir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  const annotationPaths = stat.isDirectory()
    ? await findMatchingFiles(baseDir, [
      'test-pid2anns-csfcube.json',
      'pid2anns.json',
      'annotations.json',
      /.*pid2anns.*\.json$/i,
      /.*annotations.*\.json$/i
    ])
    : [absolutePath];
  const corpusPath = options.corpusPath
    ? path.resolve(options.cwd || process.cwd(), options.corpusPath)
    : await findFirstMatchingFile(baseDir, [
      'corpus.jsonl',
      'corpus.json',
      'papers.jsonl',
      'abstracts.jsonl',
      /abstract.*\.jsonl$/i,
      /metadata.*\.jsonl$/i
    ]);

  if (!annotationPaths.length) return loadFlexibleSchemaBenchmark(absolutePath, { ...options, formatName: 'csfcube' });

  const { corpus, corpusById } = await loadCorpusFromPath(corpusPath);
  const queries = [];
  for (const annotationPath of annotationPaths) {
    const annotations = await readJson(annotationPath, null);
    const fileFacet = inferCsfcubeFacetFromPath(annotationPath);
    Object.entries(asObject(annotations)).forEach(([queryPaperId, facetMap]) => {
      const queryPaper = corpusById.get(queryPaperId) || normalizePaperRecord({ id: queryPaperId, title: queryPaperId });
      if (Array.isArray(facetMap) || Number.isFinite(Number(Object.values(asObject(facetMap))[0]))) {
        const relevant = normalizeCsfcubeAnnotationSet(facetMap, corpusById);
        if (relevant.length) {
          const facet = fileFacet || 'all';
          queries.push(normalizeBenchmarkQuery({
            id: `${queryPaperId}:${facet}`,
            query: compactText([queryPaper.title, facet, queryPaper.abstract].filter(Boolean).join(' ')),
            queryPaperId,
            facet,
            relevant,
            taskType: 'faceted_query_by_example'
          }, queries.length, corpusById, { format: 'csfcube', taskType: 'faceted_query_by_example' }));
        }
        return;
      }
      Object.entries(asObject(facetMap)).forEach(([facet, annotationSet]) => {
        const relevant = normalizeCsfcubeAnnotationSet(annotationSet, corpusById);
        if (!relevant.length) return;
        queries.push(normalizeBenchmarkQuery({
          id: `${queryPaperId}:${facet}`,
          query: compactText([queryPaper.title, facet, queryPaper.abstract].filter(Boolean).join(' ')),
          queryPaperId,
          facet,
          relevant,
          taskType: 'faceted_query_by_example'
        }, queries.length, corpusById, { format: 'csfcube', taskType: 'faceted_query_by_example' }));
      });
    });
  }

  return {
    name: options.name || 'CSFCube',
    format: 'csfcube',
    profile: benchmarkProfile('csfcube'),
    sourcePath: absolutePath,
    queryCount: queries.length,
    corpusSize: corpus.length,
    corpus,
    queries
  };
}

export async function loadRetrievalBenchmark(datasetPath, options = {}) {
  if (!datasetPath) throw new Error('datasetPath is required.');
  const format = canonicalBenchmarkFormat(options.format || 'auto');
  const absolutePath = path.resolve(options.cwd || process.cwd(), datasetPath);
  const stat = await fs.stat(absolutePath);

  if (format === 'beir') return loadBeirBenchmark(absolutePath, options);
  if (format === 'litsearch') return loadLitSearchBenchmark(absolutePath, options);
  if (format === 'bioasq') return loadBioAsqBenchmark(absolutePath, options);
  if (format === 'trec') return loadTrecBenchmark(absolutePath, options);
  if (format === 'csfcube') return loadCsfcubeBenchmark(absolutePath, options);
  if (['sage', 'scholarqa', 'paperask', 'sparbench', 'scinetbench'].includes(format)) {
    if (
      stat.isDirectory()
      && await fileExists(path.join(absolutePath, 'corpus.jsonl'))
      && await fileExists(path.join(absolutePath, 'queries.jsonl'))
      && await hasBeirQrels(absolutePath)
    ) {
      return loadBeirBenchmark(absolutePath, { ...options, formatName: format });
    }
    return loadFlexibleSchemaBenchmark(absolutePath, { ...options, formatName: format });
  }
  if (format === 'custom' || format === 'json' || format === 'jsonl') return loadCustomBenchmark(absolutePath, options);

  if (stat.isDirectory()) {
    if (await fileExists(path.join(absolutePath, 'corpus.jsonl')) && await fileExists(path.join(absolutePath, 'queries.jsonl'))) {
      return loadBeirBenchmark(absolutePath, options);
    }
    if (
      (await findFirstExisting(absolutePath, ['query.jsonl', 'queries.jsonl', 'query.json', 'queries.json']))
      && (await findFirstExisting(absolutePath, ['corpus_clean.jsonl', 'corpus.jsonl', 'corpus_clean.json', 'corpus.json']))
    ) {
      return loadLitSearchBenchmark(absolutePath, options);
    }
    if (await findFirstMatchingFile(absolutePath, [/bioasq.*\.json$/i, /.*questions.*\.json$/i])) {
      const parsed = await readJson(await findFirstMatchingFile(absolutePath, [/bioasq.*\.json$/i, /.*questions.*\.json$/i]), null);
      if (Array.isArray(parsed?.questions) && parsed.questions.some((entry) => Array.isArray(entry.documents))) {
        return loadBioAsqBenchmark(absolutePath, options);
      }
    }
    if (await findFirstMatchingFile(absolutePath, [/.*pid2anns.*\.json$/i])) {
      return loadCsfcubeBenchmark(absolutePath, options);
    }
  }

  return loadCustomBenchmark(absolutePath, options);
}

function collectMatchAliases(paper = {}) {
  const identity = createPaperIdentity({
    identifiers: normalizePaperIdentifiers({
      ...asObject(paper.identifiers),
      ...paper
    }),
    title: paper.title,
    normalizedTitle: paper.normalizedTitle
  });
  return unique([
    paper.canonicalId,
    paper.id,
    identity.canonicalId,
    ...(Array.isArray(paper.identityAliases) ? paper.identityAliases : []),
    ...identity.identityAliases
  ].map((entry) => compactText(entry)).filter(Boolean));
}

function titleSimilarity(left = {}, right = {}) {
  const leftTitle = compactText(left.normalizedTitle || left.title);
  const rightTitle = compactText(right.normalizedTitle || right.title);
  if (!leftTitle || !rightTitle) return 0;
  if (leftTitle.toLowerCase() === rightTitle.toLowerCase()) return 1;
  return jaccardSimilarity(leftTitle, rightTitle);
}

function findRelevantMatch(candidate = {}, relevant = [], options = {}) {
  const titleThreshold = Number(options.titleMatchThreshold || DEFAULT_TITLE_MATCH_THRESHOLD);
  const candidateAliases = new Set(collectMatchAliases(candidate));

  for (let index = 0; index < relevant.length; index += 1) {
    const gold = relevant[index];
    if (paperIdentifiersOverlap(candidate, gold)) {
      return {
        index,
        reason: 'identifier'
      };
    }

    if (collectMatchAliases(gold).some((alias) => candidateAliases.has(alias))) {
      return {
        index,
        reason: 'alias'
      };
    }

    const similarity = titleSimilarity(candidate, gold);
    if (similarity >= titleThreshold) {
      return {
        index,
        reason: similarity === 1 ? 'title_exact' : 'title_similarity',
        similarity
      };
    }
  }

  return null;
}

function buildRankEvents(candidates = [], relevant = [], options = {}) {
  const matchedRelevant = new Set();
  return candidates.map((candidate, index) => {
    const match = findRelevantMatch(candidate, relevant, options);
    const duplicate = match ? matchedRelevant.has(match.index) : false;
    if (match && !duplicate) matchedRelevant.add(match.index);
    const relevanceScore = match && !duplicate
      ? Math.max(0, Number(relevant[match.index]?.relevance || 1))
      : 0;
    return {
      rank: index + 1,
      candidate,
      match,
      isRelevant: Boolean(match && !duplicate),
      relevanceScore,
      duplicateRelevantMatch: duplicate
    };
  });
}

function dcgAt(events = [], cutoff = 10) {
  return events.slice(0, cutoff).reduce((sum, event, index) => (
    sum + (event.relevanceScore > 0 ? event.relevanceScore / Math.log2(index + 2) : 0)
  ), 0);
}

function idcgAt(relevant = [], cutoff = 10) {
  return relevant
    .map((paper) => Math.max(0, Number(paper.relevance || 1)))
    .sort((left, right) => right - left)
    .slice(0, cutoff)
    .reduce((sum, relevance, index) => sum + relevance / Math.log2(index + 2), 0);
}

function averagePrecisionAt(events = [], relevantCount = 0, cutoff = 10) {
  if (!relevantCount) return 0;
  let hits = 0;
  let precisionSum = 0;
  for (const event of events.slice(0, cutoff)) {
    if (!event.isRelevant) continue;
    hits += 1;
    precisionSum += hits / event.rank;
  }
  return precisionSum / Math.min(relevantCount, cutoff);
}

function weightedRecallAt(events = [], relevant = [], cutoff = 10) {
  const totalWeight = relevant.reduce((sum, paper) => sum + Math.max(0, Number(paper.relevance || 1)), 0);
  if (!totalWeight) return 0;
  const matchedWeight = events
    .slice(0, cutoff)
    .reduce((sum, event) => sum + Math.max(0, Number(event.relevanceScore || 0)), 0);
  return matchedWeight / totalWeight;
}

export function evaluateRetrievalResults(queryCase = {}, candidates = [], options = {}) {
  const cutoffs = normalizeCutoffs(options.cutoffs);
  const relevant = dedupePapers((queryCase.relevant || []).map((paper, index) => (
    normalizePaperRecord(paper, `${queryCase.id || 'query'}:rel:${index}`)
  )));
  const events = buildRankEvents(candidates, relevant, options);
  const metrics = {};
  let firstRelevantRank = 0;
  for (const event of events) {
    if (event.isRelevant) {
      firstRelevantRank = event.rank;
      break;
    }
  }

  for (const cutoff of cutoffs) {
    const hits = events.slice(0, cutoff).filter((event) => event.isRelevant).length;
    const ideal = idcgAt(relevant, cutoff);
    const precision = hits / cutoff;
    const recall = relevant.length ? hits / relevant.length : 0;
    metrics[`hit@${cutoff}`] = hits > 0 ? 1 : 0;
    metrics[`exact_match@${cutoff}`] = hits > 0 ? 1 : 0;
    metrics[`precision@${cutoff}`] = precision;
    metrics[`recall@${cutoff}`] = recall;
    metrics[`f1@${cutoff}`] = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    metrics[`weighted_recall@${cutoff}`] = weightedRecallAt(events, relevant, cutoff);
    metrics[`mrr@${cutoff}`] = firstRelevantRank && firstRelevantRank <= cutoff ? 1 / firstRelevantRank : 0;
    metrics[`map@${cutoff}`] = averagePrecisionAt(events, relevant.length, cutoff);
    metrics[`ndcg@${cutoff}`] = ideal ? dcgAt(events, cutoff) / ideal : 0;
  }

  return {
    id: queryCase.id,
    query: queryCase.query,
    relevantCount: relevant.length,
    relevantWeight: relevant.reduce((sum, paper) => sum + Math.max(0, Number(paper.relevance || 1)), 0),
    retrievedCount: candidates.length,
    matchedCount: new Set(events.filter((event) => event.isRelevant).map((event) => event.match.index)).size,
    firstRelevantRank,
    metrics,
    topMatches: events
      .filter((event) => event.match)
      .slice(0, 10)
      .map((event) => ({
        rank: event.rank,
        reason: event.match.reason,
        title: event.candidate.title || '',
        canonicalId: event.candidate.canonicalId || '',
        relevance: event.relevanceScore,
        duplicateRelevantMatch: event.duplicateRelevantMatch
      }))
  };
}

function aggregateMetrics(results = []) {
  const metricKeys = unique(results.flatMap((result) => Object.keys(result.metrics || {}))).sort();
  const aggregates = {};
  for (const key of metricKeys) {
    const values = results.map((result) => Number(result.metrics?.[key] || 0));
    aggregates[key] = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  }
  return aggregates;
}

function selectQueries(benchmark = {}, options = {}) {
  const limit = Math.max(0, Math.floor(Number(options.limit || options.benchmarkLimit || 0)));
  const offset = Math.max(0, Math.floor(Number(options.offset || 0)));
  const queries = benchmark.queries || [];
  return (limit ? queries.slice(offset, offset + limit) : queries.slice(offset));
}

async function runWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, Math.floor(Number(concurrency || 1))), Math.max(1, items.length)) },
    () => runWorker()
  ));
  return results;
}

function buildDiscoveryParams(queryCase = {}, options = {}) {
  return {
    rootPath: options.rootPath || process.cwd(),
    topic: queryCase.query,
    depth: options.depth || 'quick',
    discipline: options.discipline,
    providers: options.providers,
    maxQueries: options.maxDiscoveryQueries || options.max_queries || options.discoveryQueries,
    maxResultsPerQuery: options.maxResultsPerQuery || options.max_results_per_query || 10,
    maxCandidates: options.maxCandidates || options.max_candidates || 50,
    providerConcurrency: options.providerConcurrency || options.provider_concurrency,
    timeoutMs: options.timeoutMs || options.timeout_ms,
    retryCount: options.retryCount ?? options.retry_count,
    retryBackoffMs: options.retryBackoffMs || options.retry_backoff_ms,
    mailto: options.mailto,
    coreApiKey: options.coreApiKey || options.core_api_key,
    resolveSources: options.resolveSources === true,
    allowDownloads: options.allowDownloads === true,
    citationExpansion: options.citationExpansion === true,
    persist: options.persistDiscoveryRuns === true
  };
}

function scoreFixedCorpusCandidate(queryCase = {}, paper = {}) {
  const queryTokens = tokenizeWithoutStopwords(queryCase.query);
  const titleTokens = tokenizeWithoutStopwords(paper.title);
  const abstractTokens = tokenizeWithoutStopwords(paper.abstract);
  const combinedTokens = unique([...titleTokens, ...abstractTokens]);
  const titleOverlap = scoreTokenOverlap(queryTokens, titleTokens);
  const combinedOverlap = scoreTokenOverlap(queryTokens, combinedTokens);
  const titleSimilarityScore = jaccardSimilarity(queryCase.query, paper.title);
  const facet = queryCase.metadata?.facet || '';
  const facetBoost = facet ? jaccardSimilarity(facet, `${paper.title} ${paper.abstract}`) : 0;
  return (titleOverlap * 3) + (combinedOverlap * 2) + titleSimilarityScore + facetBoost;
}

function buildFixedCorpusCandidates(benchmark = {}, queryCase = {}, options = {}) {
  const corpus = asArray(options.fixedCorpus || benchmark.corpus);
  if (!corpus.length) {
    throw new Error(`Benchmark ${benchmark.name || benchmark.format || ''} does not include a local corpus. Use live mode or provide a corpus file.`);
  }
  const sourcePaperId = queryCase.metadata?.sourcePaperId || '';
  const limit = Math.max(1, Math.floor(Number(
    options.fixedCorpusLimit
    || options.maxFixedCorpusResults
    || options.max_fixed_corpus_results
    || options.maxCandidates
    || DEFAULT_FIXED_CORPUS_LIMIT
  )));
  return corpus
    .map((paper, index) => {
      const normalized = normalizePaperRecord(paper, `fixed:${index}`);
      return {
        ...normalized,
        score: scoreFixedCorpusCandidate(queryCase, normalized),
        sourceProvider: 'fixed_corpus'
      };
    })
    .filter((paper) => !sourcePaperId || ![paper.id, paper.canonicalId].includes(sourcePaperId))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function benchmarkAlignment(benchmark = {}, config = {}) {
  const format = canonicalBenchmarkFormat(benchmark.format || 'custom');
  const profile = benchmark.profile || benchmarkProfile(format);
  const evaluationMode = normalizeEvaluationMode(config.evaluationMode);
  const taskEvaluationMode = String(config.taskEvaluationMode || 'rules').trim().toLowerCase();
  const hasFixedCorpus = Number(benchmark.corpusSize || 0) > 0 || asArray(benchmark.corpus).length > 0;
  const hasGoldTargets = asArray(benchmark.queries).some((query) => (
    query?.relevant?.length
    || query?.metadata?.hasTaskEvaluationTarget
    || query?.goldRelations?.length
  ));
  const officialStyle = profile.evaluationStyle || 'custom_relevance_set';
  const limitations = [];
  if (evaluationMode === 'live') {
    limitations.push('Uses live provider discovery, so scores measure PaperNexus real-world discovery rather than closed-corpus leaderboard ranking.');
  }
  if (['scholarqa', 'paperask'].includes(format) && taskEvaluationMode !== 'llm') {
    limitations.push('Uses rule-based task metrics only. Use --task-evaluation llm --generate-task-answers true to score answer correctness, grounding, and citation faithfulness.');
  }
  if (format === 'scinetbench' && taskEvaluationMode !== 'llm') {
    limitations.push('Uses structured relation/path overlap only. Use --task-evaluation llm to judge relation reasoning quality from retrieved evidence.');
  }
  if (format === 'scinetbench' && !hasGoldTargets) {
    limitations.push('Loaded query-only SciNetBench prompts. Official SciNetBench accuracy requires its evaluation scripts plus relation/citation ground truth or OpenAlex database artifacts.');
  }
  if (format === 'scholarqa') {
    limitations.push('Official ScholarQABench comparability requires its citation_correctness_eval.py, rubric_eval.py, and Prometheus evaluators. PaperNexus reports internal rule/LLM approximations unless those scripts are run externally.');
  }
  if (format === 'paperask') {
    limitations.push('PaperAsk currently publishes benchmark cases and sample outputs, while official evaluation scripts and reliability classifier are still marked coming soon upstream. PaperNexus reports schema-aligned diagnostic metrics.');
  }
  if (format === 'scinetbench') {
    limitations.push('Official SciNetBench metrics require the upstream Evaluation/*.py scripts and OpenAlex/relation database artifacts. PaperNexus relation metrics are approximate unless those artifacts are integrated externally.');
  }
  if (format === 'csfcube' && !hasFixedCorpus) {
    limitations.push('CSFCube is strongest in fixed-corpus faceted mode; provide the corpus metadata for official-style ranking.');
  }
  const usesExternalOfficialEvaluator = ['scholarqa', 'paperask', 'scinetbench'].includes(format);
  return {
    format,
    taskType: profile.taskType,
    evaluationStyle: officialStyle,
    evaluationMode,
    hasFixedCorpus,
    nativeMetrics: profile.nativeMetrics,
    officialComparable: evaluationMode === 'fixed-corpus' && hasFixedCorpus && !usesExternalOfficialEvaluator,
    taskEvaluationMode,
    limitations
  };
}

function summarizeBenchmark(benchmark = {}, selectedQueries = []) {
  const relevantCounts = selectedQueries.map((query) => query.relevant.length);
  const taskTypes = unique(selectedQueries.map((query) => query.metadata?.taskType).filter(Boolean));
  return {
    name: benchmark.name,
    format: benchmark.format,
    profile: benchmark.profile || benchmarkProfile(benchmark.format || 'custom'),
    sourcePath: benchmark.sourcePath,
    loadedQueries: benchmark.queryCount,
    evaluatedQueries: selectedQueries.length,
    relevantPapers: relevantCounts.reduce((sum, count) => sum + count, 0),
    corpusSize: benchmark.corpusSize || asArray(benchmark.corpus).length,
    taskTypes,
    minRelevantPerQuery: relevantCounts.length ? Math.min(...relevantCounts) : 0,
    maxRelevantPerQuery: relevantCounts.length ? Math.max(...relevantCounts) : 0
  };
}

export async function runRetrievalBenchmark(params = {}) {
  const benchmark = params.benchmark || await loadRetrievalBenchmark(params.datasetPath, params);
  const selectedQueries = selectQueries(benchmark, params);
  const cutoffs = normalizeCutoffs(params.cutoffs || params.k);
  const runDiscovery = params.runDiscovery || runLiteratureDiscovery;
  const evaluationMode = normalizeEvaluationMode(params.evaluationMode || params.evaluation_mode || params.mode);
  const taskEvaluationMode = String(params.taskEvaluation || params.task_evaluation || 'rules').trim().toLowerCase();
  const startedAt = new Date().toISOString();
  const onProgress = typeof params.onProgress === 'function' ? params.onProgress : null;

  const results = await runWithConcurrency(
    selectedQueries,
    params.benchmarkConcurrency || params.concurrency || 1,
    async (queryCase, index) => {
      onProgress?.({
        completed: index,
        total: selectedQueries.length,
        queryId: queryCase.id,
        query: queryCase.query,
        phase: 'running'
      });
      const discoveryRun = evaluationMode === 'fixed-corpus'
        ? {
          runId: null,
          providers: ['fixed_corpus'],
          rawCandidateCount: benchmark.corpusSize || asArray(benchmark.corpus).length,
          candidates: buildFixedCorpusCandidates(benchmark, queryCase, params),
          coverage: null,
          artifacts: null
        }
        : await runDiscovery(buildDiscoveryParams(queryCase, params));
      const candidates = discoveryRun.candidates || [];
      const evaluation = evaluateRetrievalResults(queryCase, candidates, {
        cutoffs,
        titleMatchThreshold: params.titleMatchThreshold || params.title_match_threshold
      });
      const taskEvaluation = await evaluateBenchmarkTaskCase(queryCase, candidates, {
        ...params,
        taskEvaluation: taskEvaluationMode
      });
      onProgress?.({
        completed: index + 1,
        total: selectedQueries.length,
        queryId: queryCase.id,
        query: queryCase.query,
        phase: 'completed',
        firstRelevantRank: evaluation.firstRelevantRank
      });
      return {
        ...evaluation,
        evaluationMode,
        taskType: queryCase.metadata?.taskType || benchmark.profile?.taskType || null,
        taskEvaluation,
        discovery: {
          runId: discoveryRun.runId || null,
          providerCount: (discoveryRun.providers || []).length,
          rawCandidateCount: discoveryRun.rawCandidateCount || candidates.length,
          mergedPaperCount: candidates.length,
          coverage: discoveryRun.coverage || null,
          artifacts: discoveryRun.artifacts || null
        }
      };
    }
  );
  const endedAt = new Date().toISOString();
  const report = {
    contractVersion: 'retrieval-benchmark-v1',
      generatedAt: endedAt,
    startedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    benchmark: summarizeBenchmark(benchmark, selectedQueries),
    config: {
      cutoffs,
      providers: params.providers || null,
      depth: params.depth || 'quick',
      maxDiscoveryQueries: params.maxDiscoveryQueries || params.max_queries || params.discoveryQueries || null,
      maxResultsPerQuery: params.maxResultsPerQuery || params.max_results_per_query || 10,
      maxCandidates: params.maxCandidates || params.max_candidates || 50,
      evaluationMode,
      taskEvaluationMode,
      generateTaskAnswers: params.generateTaskAnswers === true || params.generate_task_answers === true,
      maxTaskContext: params.maxTaskContext || params.max_task_context || null,
      fixedCorpusLimit: params.fixedCorpusLimit || params.maxFixedCorpusResults || params.max_fixed_corpus_results || null,
      resolveSources: params.resolveSources === true,
      persistDiscoveryRuns: params.persistDiscoveryRuns === true,
      titleMatchThreshold: Number(params.titleMatchThreshold || params.title_match_threshold || DEFAULT_TITLE_MATCH_THRESHOLD)
    },
    alignment: benchmarkAlignment(benchmark, { evaluationMode, taskEvaluationMode }),
    metrics: aggregateMetrics(results),
    taskEvaluation: aggregateTaskEvaluationMetrics(results),
    results
  };

  if (params.outputDir) {
    report.artifacts = await writeRetrievalBenchmarkArtifacts(params.outputDir, report);
  }

  return report;
}

export async function writeRetrievalBenchmarkArtifacts(outputDir, report = {}) {
  const absoluteOutputDir = path.resolve(process.cwd(), outputDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const benchmarkName = slugify(report.benchmark?.name || 'retrieval-benchmark');
  const runDir = path.join(absoluteOutputDir, `${stamp}-${benchmarkName}`);
  const jsonPath = path.join(runDir, 'report.json');
  const markdownPath = path.join(runDir, 'report.md');
  const artifacts = {
    runDir,
    jsonPath,
    markdownPath
  };
  const reportWithArtifacts = {
    ...report,
    artifacts
  };
  await ensureDir(runDir);
  await writeJson(jsonPath, reportWithArtifacts);
  await writeText(markdownPath, `${renderRetrievalBenchmarkReport(reportWithArtifacts)}\n`);
  return artifacts;
}

function formatMetric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.0000';
  return numeric.toFixed(4);
}

function metricRows(metrics = {}, cutoffs = DEFAULT_CUTOFFS) {
  const families = ['hit', 'exact_match', 'recall', 'weighted_recall', 'precision', 'f1', 'mrr', 'map', 'ndcg'];
  return families.flatMap((family) => cutoffs.map((cutoff) => {
    const key = `${family}@${cutoff}`;
    return `| ${key} | ${formatMetric(metrics[key])} |`;
  }));
}

export function renderRetrievalBenchmarkReport(report = {}) {
  const benchmark = report.benchmark || {};
  const config = report.config || {};
  const alignment = report.alignment || {};
  const cutoffs = config.cutoffs || DEFAULT_CUTOFFS;
  const lines = [
    `# Retrieval Benchmark: ${benchmark.name || 'unknown'}`,
    '',
    `Generated: ${report.generatedAt || 'unknown'}`,
    `Format: ${benchmark.format || 'unknown'}`,
    `Task type: ${(benchmark.taskTypes || []).join(', ') || alignment.taskType || 'unknown'}`,
    `Queries: ${benchmark.evaluatedQueries || 0}/${benchmark.loadedQueries || 0}`,
    `Relevant papers: ${benchmark.relevantPapers || 0}`,
    `Corpus size: ${benchmark.corpusSize || 0}`,
    `Evaluation mode: ${alignment.evaluationMode || config.evaluationMode || 'live'}`,
    `Discovery depth: ${config.depth || 'quick'}`,
    `Providers: ${Array.isArray(config.providers) ? config.providers.join(', ') : (config.providers || 'default')}`,
    `Source resolution: ${config.resolveSources ? 'enabled' : 'disabled'}`,
    `Official-style comparable: ${alignment.officialComparable ? 'yes' : 'no'}`,
    '',
    '## Metrics',
    '',
    '| Metric | Macro average |',
    '|---|---:|',
    ...metricRows(report.metrics || {}, cutoffs),
    ''
  ];

  if (report.taskEvaluation?.evaluatedQueries) {
    lines.push(
      '## Task Evaluation',
      '',
      `Task-evaluated queries: ${report.taskEvaluation.evaluatedQueries}`,
      '',
      '| Metric | Macro average |',
      '|---|---:|'
    );
    for (const key of Object.keys(report.taskEvaluation.metrics || {}).sort()) {
      lines.push(`| ${key} | ${formatMetric(report.taskEvaluation.metrics[key])} |`);
    }
    lines.push('');
  }

  lines.push('## Worst Queries By Recall', '');

  const maxCutoff = Math.max(...cutoffs);
  const recallKey = `recall@${maxCutoff}`;
  const worst = [...(report.results || [])]
    .sort((left, right) => (left.metrics?.[recallKey] || 0) - (right.metrics?.[recallKey] || 0))
    .slice(0, 10);

  if (!worst.length) {
    lines.push('No evaluated queries.');
  } else {
    lines.push('| Query | Relevant | Retrieved | First hit | Recall |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const result of worst) {
      lines.push(`| ${truncate(result.query, 90).replace(/\|/g, '\\|')} | ${result.relevantCount} | ${result.retrievedCount} | ${result.firstRelevantRank || '-'} | ${formatMetric(result.metrics?.[recallKey])} |`);
    }
  }

  if (Array.isArray(alignment.limitations) && alignment.limitations.length) {
    lines.push('', '## Alignment Notes', '');
    for (const limitation of alignment.limitations) {
      lines.push(`- ${limitation}`);
    }
  }

  return lines.join('\n');
}
