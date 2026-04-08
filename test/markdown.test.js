import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePaperMarkdown } from '../src/core/ingestion/markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.join(__dirname, '..', 'examples', 'retrieval-augmented-experiment-planning.md');

test('parsePaperMarkdown extracts title, authors, section roles, and citations from example markdown', async () => {
  const markdown = await fs.readFile(examplePath, 'utf8');
  const parsed = parsePaperMarkdown(markdown, examplePath);

  assert.equal(parsed.title, 'Retrieval-Augmented Experiment Planning with Lab Notebooks');
  assert.deepEqual(parsed.authors, ['Mina Lee', 'Tomas Hsu']);
  assert.equal(parsed.references.length, 2);

  const sectionRoles = new Map(parsed.sections.map((section) => [section.heading, section.role]));
  assert.equal(sectionRoles.get('Abstract'), 'abstract');
  assert.equal(sectionRoles.get('Method'), 'method');
  assert.equal(sectionRoles.get('References'), 'references');

  const methodSection = parsed.sections.find((section) => section.heading === 'Method');
  assert.ok(methodSection, 'expected method section to exist');
  assert.ok(
    methodSection.chunks.some((chunk) => chunk.citations.some((citation) => citation.style === 'author-year')),
    'expected at least one author-year citation mention in method section'
  );

  assert.ok(
    parsed.conceptCandidates.some((candidate) => candidate.phrase.includes('experiment planning')),
    'expected concept candidates to include experiment planning'
  );
});

test('cleanText filters chart/axis noise from OCR output', async () => {
  const markdownWithChartNoise = `
# Test Paper

## Abstract
This paper studies chart noise filtering.

## Results
0.50 0.45 0.40 0.35
[SSR] [CLIP] + 1.0 0.9 0.8
[???]
Main finding: our method improves performance.

## Conclusion
Chart noise should be filtered.
`;

  const parsed = parsePaperMarkdown(markdownWithChartNoise, 'test.md');

  // 图表噪声行应该被过滤
  const resultsSection = parsed.sections.find((s) => s.heading === 'Results');
  assert.ok(resultsSection);

  // 不应该包含纯数字行
  assert.ok(
    !resultsSection.text.includes('0.50 0.45 0.40 0.35'),
    'should filter out pure number lines'
  );

  // 应该保留有效文本
  assert.ok(
    resultsSection.text.includes('Main finding'),
    'should keep valid text'
  );
});

test('parsePaperMarkdown flags degenerate section-heading titles and falls back to the filename for display', () => {
  const parsed = parsePaperMarkdown(`## Abstract

This parser output lost the real title.

## Method

Fallback titles should not be treated as canonical paper titles.
`, '/tmp/degenerate-title-paper.md');

  assert.equal(parsed.title, 'degenerate-title-paper');
  assert.equal(parsed.titleValidation?.isValid, false);
  assert.equal(parsed.titleValidation?.rawTitle, 'Abstract');
  assert.equal(parsed.titleValidation?.usedFallbackTitle, true);
  assert.match(parsed.titleValidation?.reason || '', /section-heading|degenerate/i);
});
