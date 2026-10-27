#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSemanticSnapshot } from '../src/core/ingestion/semantic-status.js';
import { normalizeResearchProvenance, researchRecordKey } from '../src/core/graph/research-provenance.js';
import { assessResearchRelation } from '../src/core/graph/relation-admission.js';
import { normalizeText } from '../src/lib/utils.js';

const evidenceFields = ['researchQuestions', 'openChallenges', 'abstractMechanismObjects'];

export function auditSnapshot(snapshot) {
  const semantics = snapshot.llmSemanticObjects || {};
  const provenance = {};
  const duplicates = [];
  for (const field of evidenceFields) {
    const records = semantics[field] || [];
    provenance[field] = { total: records.length, missingQuote: 0, missingQuoteAndChunk: 0 };
    const seen = new Set();
    for (const record of records) {
      const source = normalizeResearchProvenance(record);
      if (!source.evidenceText && !source.supportingSnippets?.length) {
        provenance[field].missingQuote += 1;
        if (!source.sourceChunkIds?.length) provenance[field].missingQuoteAndChunk += 1;
      }
      const key = researchRecordKey(record);
      if (seen.has(key)) duplicates.push({ field, name: record.name });
      seen.add(key);
    }
  }
  return {
    ...summarizeSemanticSnapshot(snapshot, { requireRelations: true }),
    paperTitle: snapshot.paperTitle,
    provenance,
    placeholderMechanisms: (semantics.abstractMechanismObjects || []).filter(record =>
      !record.description || normalizeText(record.description) === normalizeText(record.name)).length,
    evidenceWithoutExperimentContext: (semantics.evidences || []).filter(record =>
      !Object.keys(normalizeResearchProvenance(record).experimentContext || {}).length).length,
    duplicates,
    excludedRelations: (snapshot.llmRelations || []).map((record, index) => ({
      index, ...assessResearchRelation(record)
    })).filter(record => !record.admitted)
  };
}

function correctedRecord(record, replacement) {
  return { ...record, ...replacement,
    text: replacement.name || record.text,
    normalized: normalizeText(replacement.name || record.name) };
}

export function applyReviewedCase(snapshot, review) {
  const next = structuredClone(snapshot);
  if (review.action === 'replace') {
    const records = next.llmSemanticObjects?.[review.field];
    const previous = records?.[review.index];
    if (previous?.name !== review.expectedName) throw new Error(`${review.id}: reviewed object does not match input`);
    const replacements = review.replacements.map(value => correctedRecord(previous, value));
    records.splice(review.index, 1, ...replacements);
    const index = (next[review.field] || []).findIndex(record => record.name === previous.name);
    if (index >= 0) next[review.field].splice(index, 1, ...replacements);
    return { snapshot: next, difference: { id: review.id, key: review.key, pointer: review.pointer,
      before: previous, after: replacements, sourceUrl: review.sourceUrl, sourceLines: review.sourceLines } };
  }
  if (review.action === 'qualify-relation') {
    const previous = next.llmRelations?.[review.index];
    if (previous?.sourceName !== review.expectedSource || previous?.targetName !== review.expectedTarget) {
      throw new Error(`${review.id}: reviewed relation does not match input`);
    }
    const corrected = { ...previous, ...review.qualification };
    corrected.graphAdmission = assessResearchRelation(corrected);
    next.llmRelations[review.index] = corrected;
    const finding = correctedRecord({ type: 'Finding', explicitOrInferred: 'explicit' }, review.appendFinding);
    next.llmSemanticObjects.findings = [...(next.llmSemanticObjects.findings || []), finding];
    next.findings = [...(next.findings || []), finding];
    return { snapshot: next, difference: { id: review.id, key: review.key, pointer: review.pointer,
      before: previous, after: corrected, addedFinding: finding, sourceUrl: review.sourceUrl, sourceLines: review.sourceLines } };
  }
  return { snapshot: next, difference: null };
}

export async function auditDirectory(input, output, reviews) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('Output must differ from input');
  const files = (await fs.readdir(input)).filter(name => name.endsWith('.snapshot.json')).sort();
  const papers = [];
  const differences = [];
  await fs.mkdir(path.join(output, 'corrected'), { recursive: true });
  for (const file of files) {
    const key = file.slice(0, -'.snapshot.json'.length);
    const original = JSON.parse(await fs.readFile(path.join(input, file), 'utf8'));
    let corrected = original;
    let changed = false;
    for (const review of reviews.filter(review => review.key === key)) {
      const result = applyReviewedCase(corrected, review);
      corrected = result.snapshot;
      if (result.difference) { differences.push(result.difference); changed = true; }
    }
    papers.push({ key, ...auditSnapshot(original), ...(changed ? { afterReviewedCorrection: auditSnapshot(corrected) } : {}) });
    if (changed) await fs.writeFile(path.join(output, 'corrected', file), `${JSON.stringify(corrected, null, 2)}\n`);
  }
  const summary = { snapshotCount: papers.length, artifactStates: {}, completeRequiredStages: 0,
    missingQuote: 0, missingQuoteAndChunk: 0, placeholderMechanisms: 0,
    evidenceWithoutExperimentContext: 0, exactDuplicateRecords: 0, reviewedCorrections: differences.length };
  for (const paper of papers) {
    summary.artifactStates[paper.artifactState] = (summary.artifactStates[paper.artifactState] || 0) + 1;
    summary.completeRequiredStages += Number(paper.complete);
    summary.placeholderMechanisms += paper.placeholderMechanisms;
    summary.evidenceWithoutExperimentContext += paper.evidenceWithoutExperimentContext;
    summary.exactDuplicateRecords += paper.duplicates.length;
    for (const entry of Object.values(paper.provenance)) {
      summary.missingQuote += entry.missingQuote;
      summary.missingQuoteAndChunk += entry.missingQuoteAndChunk;
    }
  }
  const report = { summary, papers, differences, reviewedCases: reviews,
    limitations: [
      'Counts describe stored artifacts and deterministic checks, not extraction accuracy.',
      'Scientific corrections apply only to source-reviewed cases; the audit does not infer missing meaning.',
      'Missing old quotes and experiment conditions still require source review or re-extraction.',
      'GCD source reading order and semantic aliases remain unresolved.',
      'No model calls, production writes, or production graph rebuilds were performed.'
    ] };
  await fs.writeFile(path.join(output, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(output, 'report.md'), [
    '# 抽取质量离线回放', '',
    `检查 ${summary.snapshotCount} 份快照，生成 ${summary.reviewedCorrections} 项原文核验修正。原始文件保留。`, '',
    '| 指标 | 数量 |', '|---|---:|',
    ...Object.entries(summary.artifactStates).map(([state, count]) => `| ${state} | ${count} |`),
    `| 要求的语义与关系阶段完成 | ${summary.completeRequiredStages} |`,
    `| 问题、挑战、机制缺原文引句 | ${summary.missingQuote} |`,
    `| 同时缺引句与块位置 | ${summary.missingQuoteAndChunk} |`,
    `| 机制说明缺失或重复名称 | ${summary.placeholderMechanisms} |`,
    `| Evidence 缺结构化实验条件 | ${summary.evidenceWithoutExperimentContext} |`,
    `| 问题、挑战、机制的同条件精确重复 | ${summary.exactDuplicateRecords} |`, '',
    '## 已核验修正', '',
    ...differences.map(change => `- ${change.id}：${change.key}，${change.pointer}。修正副本位于 corrected/${change.key}.snapshot.json；原文定位及逐字段差异见 audit.json。`), '',
    '## 限制', '',
    '这些计数衡量产物与字段覆盖，不代表准确率。修正仅适用于已人工核对的案例；旧记录缺失的引句和实验条件仍需补证或重抽。GCD 的阅读顺序和语义近义名称尚未修复。本次没有模型调用、生产数据写入或生产图重建。', ''
  ].join('\n'));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  if (!args.includes('--input') || !args.includes('--output')) throw new Error('Usage: --input <snapshot-directory> --output <report-directory> [--reviewed-cases <json>]');
  const reviewPath = args.includes('--reviewed-cases') ? value('--reviewed-cases')
    : fileURLToPath(new URL('../test/fixtures/extraction-quality-reviewed-cases.json', import.meta.url));
  const reviews = JSON.parse(await fs.readFile(reviewPath, 'utf8')).cases;
  const report = await auditDirectory(value('--input'), value('--output'), reviews);
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}
