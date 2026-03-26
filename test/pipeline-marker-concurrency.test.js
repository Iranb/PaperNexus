import test from 'node:test';
import assert from 'node:assert/strict';
import { __pipelineTestables } from '../src/core/ingestion/pipeline.js';

test('resolveMarkerConcurrency defaults to 4 for remote marker runs', () => {
  assert.equal(__pipelineTestables.resolveMarkerConcurrency({ markerSshHost: '211.71.76.29' }), 4);
});

test('resolveMarkerConcurrency defaults to 1 for local marker runs', () => {
  assert.equal(__pipelineTestables.resolveMarkerConcurrency({}), 1);
});

test('resolveMarkerConcurrency respects explicit override', () => {
  assert.equal(__pipelineTestables.resolveMarkerConcurrency({ markerSshHost: '211.71.76.29', markerConcurrency: 2 }), 2);
  assert.equal(__pipelineTestables.resolveMarkerConcurrency({ markerConcurrency: 6 }), 6);
});

test('resolveAnalyzeConcurrency keeps conservative defaults for local marker runs', () => {
  assert.equal(__pipelineTestables.resolveAnalyzeConcurrency({
    pdfParser: 'marker',
    availableParallelism: 8
  }), 1);
});

test('resolveAnalyzeConcurrency increases local docling parallelism', () => {
  assert.equal(__pipelineTestables.resolveAnalyzeConcurrency({
    pdfParser: 'docling',
    availableParallelism: 8
  }), 4);
});

test('resolveAnalyzeConcurrency keeps higher concurrency when llm-assisted extraction is enabled', () => {
  assert.equal(__pipelineTestables.resolveAnalyzeConcurrency({
    pdfParser: 'docling',
    semanticExtraction: 'llm-assisted',
    availableParallelism: 8
  }), 8);
});

test('resolveAnalyzeConcurrency uses more parallelism for remote mineru plus llm', () => {
  assert.equal(__pipelineTestables.resolveAnalyzeConcurrency({
    pdfParser: 'mineru',
    mineruHttpUrl: 'http://example.test',
    semanticExtraction: 'llm-primary',
    llmRelations: true,
    availableParallelism: 12
  }), 12);
});

test('resolveAnalyzeConcurrency respects explicit override', () => {
  assert.equal(__pipelineTestables.resolveAnalyzeConcurrency({
    pdfParser: 'docling',
    concurrency: 5,
    availableParallelism: 8
  }), 5);
});
