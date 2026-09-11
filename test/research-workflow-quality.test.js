import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { searchGraph } from '../src/core/search/search.js';
import { cleanMarkdownWithReport, parsePaperMarkdown } from '../src/core/ingestion/markdown.js';

test('search requires lexical evidence and ranks relevance before recency', () => {
  const graph = createKnowledgeGraph();
  graph.addNode({ id: 'older', type: 'Paper', name: 'Adaptive calibration',
    properties: { paperId: 'older', year: 2020 } });
  graph.addNode({ id: 'newer', type: 'Paper', name: 'Calibration overview',
    properties: { paperId: 'newer', year: 2026 } });
  graph.addNode({ id: 'unrelated', type: 'Method', name: 'Protein folding',
    properties: { aliases: ['AlphaFold'] } });
  assert.deepEqual(searchGraph(graph, 'zzzz nonexistent').groups, []);
  assert.deepEqual(searchGraph(graph, '').groups, []);
  assert.equal(searchGraph(graph, 'AlphaFold').groups[0].id, 'unrelated');
  assert.equal(searchGraph(graph, 'Adaptive calibration').groups[0].id, 'older');
  assert.equal(searchGraph(graph, 'Adaptive calibration', { sortBy: 'date' }).groups[0].id, 'newer');
});

test('Markdown cleanup preserves metrics, model names, equations, tables and code with auditable offsets', () => {
  const lines = ['# Numeric Evidence', '## Results', 'Accuracy 95.2', 'ResNet 50',
    'L = α + β / 2', '| value | 0.50 0.45 0.40 |', '$$', '0.50 0.45 0.40', '$$',
    '~~~', '0.50 0.45 0.40', '~~~', '0.50 0.45 0.40', '[???]'];
  const source = lines.join('\r\n');
  const result = cleanMarkdownWithReport(source);
  assert.equal(result.report.removedLineCount, 2);
  for (const removed of result.report.removedLines) {
    assert.equal(source.slice(removed.startOffset, removed.endOffset), removed.text);
  }
  assert.equal(cleanMarkdownWithReport(result.text).text, result.text);
  const parsed = parsePaperMarkdown(source, 'numeric.md');
  const results = parsed.sections.find((s) => s.heading === 'Results');
  for (const preserved of lines.slice(2, 12)) assert.ok(results.text.includes(preserved), preserved);
  assert.equal(parsed.textQuality.sourceHash, result.report.sourceHash);
});

test('section parsing and chunking preserve code headings, indentation and protected blank lines', () => {
  const code = ['    0.50 0.45 0.40', '    pass', '', '~~~python', '# code comment',
    '0.50 0.45 0.40', '', '', 'print(95.2)', '~~~'].join('\n');
  const parsed = parsePaperMarkdown('# Numeric Code\n## Method\n' + code, 'numeric-code.md');
  assert.equal(parsed.sections.length, 1);
  assert.equal(parsed.sections[0].heading, 'Method');
  assert.equal(parsed.sections[0].text, code);
  assert.equal(parsed.sections[0].chunks.map((chunk) => chunk.text).join('\n\n'), code);
  assert.equal(parsed.textQuality.removedLineCount, 0);
});
