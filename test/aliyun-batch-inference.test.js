import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  runAliyunBatchPreparation,
  validateAliyunBatchRequests
} from '../scripts/prepare-aliyun-batch-inference.mjs';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function fixtureEntries() {
  return [
    {
      id: 'paper-1',
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: 'Extract paper one.' }
      ]
    },
    {
      id: 'paper-2',
      prompt: 'Extract paper two.',
      body: {
        temperature: 0
      }
    },
    {
      id: 'paper-3',
      title: 'Graph Batch Processing',
      abstract: 'A benchmark for batch graph extraction.'
    }
  ];
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body)
  };
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => body
  };
}

test('Aliyun batch preparation writes OpenAI-compatible JSONL shards and validation artifacts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-'));

  try {
    const report = await runAliyunBatchPreparation({
      runId: 'test-aliyun-batch',
      outputDir: tempRoot,
      entries: fixtureEntries(),
      model: 'qwen-plus',
      maxRequests: 2,
      responseFormat: 'json_object',
      temperature: 0
    });

    assert.equal(report.status, 'prepared');
    assert.equal(report.requestCount, 3);
    assert.equal(report.shardCount, 2);
    assert.equal(report.mappedCustomIdCount, 0);
    assert.ok(await fileExists(report.artifacts.manifestPath));
    assert.ok(await fileExists(report.artifacts.validationPath));
    assert.ok(await fileExists(report.artifacts.customIdMapPath));
    assert.ok(await fileExists(report.artifacts.llmBatchesPath));
    assert.ok(await fileExists(report.artifacts.llmResultsPath));
    assert.ok(await fileExists(report.artifacts.llmFailuresPath));
    assert.equal(report.artifacts.shardPaths.length, 2);
    assert.equal(report.llmLedger.batchCount, 2);

    const firstShard = await readJsonl(report.artifacts.shardPaths[0]);
    assert.equal(firstShard.length, 2);
    assert.deepEqual(Object.keys(firstShard[0]).sort(), ['body', 'custom_id', 'method', 'url']);
    assert.equal(firstShard[0].method, 'POST');
    assert.equal(firstShard[0].url, '/v1/chat/completions');
    assert.equal(firstShard[0].body.model, 'qwen-plus');
    assert.deepEqual(firstShard[0].body.response_format, { type: 'json_object' });
    assert.equal(firstShard[0].body.messages[1].content, 'Extract paper one.');

    const validation = JSON.parse(await fs.readFile(report.artifacts.validationPath, 'utf8'));
    assert.equal(validation.status, 'passed');
    assert.equal(validation.shardCount, 2);
    assert.equal(validation.limits.maxRequestsPerFile, 2);

    const ledgerBatches = await readJsonl(report.artifacts.llmBatchesPath);
    assert.equal(ledgerBatches.length, 2);
    assert.equal(ledgerBatches[0].contractVersion, 'papernexus-llm-batch-ledger-v1');
    assert.equal(ledgerBatches[0].phase, 'aliyun-batch-inference');
    assert.equal(ledgerBatches[0].status, 'prepared');
    assert.equal(ledgerBatches[0].batchSize, 2);
    assert.deepEqual(ledgerBatches[0].entryIds, ['paper-1', 'paper-2']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Aliyun remote submit is explicit opt-in and records remote jobs without leaking token', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-remote-'));

  try {
    await assert.rejects(
      runAliyunBatchPreparation({
        runId: 'test-aliyun-remote-guard',
        outputDir: tempRoot,
        entries: fixtureEntries().slice(0, 1),
        remoteMode: 'submit',
        apiKey: 'test-token',
        fetch: async () => jsonResponse({})
      }),
      /--confirm-cost true/
    );

    const calls = [];
    let fileIndex = 0;
    let batchIndex = 0;
    const report = await runAliyunBatchPreparation({
      runId: 'test-aliyun-remote-submit',
      outputDir: tempRoot,
      entries: fixtureEntries(),
      maxRequests: 2,
      remoteMode: 'submit',
      confirmCost: true,
      apiKey: 'test-token',
      remoteMaxRequests: 3,
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        if (String(url).endsWith('/files')) {
          fileIndex += 1;
          return jsonResponse({ id: `file-${fileIndex}`, purpose: 'batch' });
        }
        if (String(url).endsWith('/batches')) {
          batchIndex += 1;
          const body = JSON.parse(init.body);
          return jsonResponse({
            id: `batch-${batchIndex}`,
            status: 'validating',
            input_file_id: body.input_file_id,
            endpoint: body.endpoint
          });
        }
        throw new Error(`Unexpected URL ${url}`);
      }
    });

    assert.equal(report.kind, 'aliyun-batch-inference-remote-artifacts');
    assert.equal(report.remoteSummary.status, 'submitted');
    assert.equal(report.remoteSummary.submittedCount, 2);
    assert.equal(report.remoteSummary.apiKeyPresent, true);
    assert.equal(calls.filter((call) => String(call.url).endsWith('/files')).length, 2);
    assert.equal(calls.filter((call) => String(call.url).endsWith('/batches')).length, 2);
    assert.ok(await fileExists(report.artifacts.remoteJobsPath));

    const manifestText = await fs.readFile(report.artifacts.manifestPath, 'utf8');
    assert.equal(manifestText.includes('test-token'), false);

    const remoteRows = await readJsonl(report.artifacts.remoteJobsPath);
    assert.equal(remoteRows[0].event, 'submitted');
    assert.equal(remoteRows[0].batchId, 'batch-1');

    const ledgerBatches = await readJsonl(report.artifacts.llmBatchesPath);
    assert.equal(ledgerBatches.some((row) => row.remoteBatchId === 'batch-1'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Aliyun submit-and-wait downloads remote output and updates parsed ledger', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-remote-wait-'));

  try {
    const calls = [];
    const report = await runAliyunBatchPreparation({
      runId: 'test-aliyun-remote-wait',
      outputDir: tempRoot,
      entries: fixtureEntries().slice(0, 1),
      remoteMode: 'submit-and-wait',
      confirmCost: true,
      apiKey: 'test-token',
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        const urlText = String(url);
        if (urlText.endsWith('/files') && init.method === 'POST') {
          return jsonResponse({ id: 'file-input' });
        }
        if (urlText.endsWith('/batches') && init.method === 'POST') {
          return jsonResponse({ id: 'batch-remote-1', status: 'in_progress' });
        }
        if (urlText.endsWith('/batches/batch-remote-1')) {
          return jsonResponse({
            id: 'batch-remote-1',
            status: 'completed',
            output_file_id: 'file-output'
          });
        }
        if (urlText.endsWith('/files/file-output/content')) {
          return textResponse(`${JSON.stringify({
            custom_id: 'paper-1',
            response: {
              status_code: 200,
              body: {
                model: 'qwen-plus',
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5
                },
                choices: [{
                  finish_reason: 'stop',
                  message: { content: '{"claim_count":1}' }
                }]
              }
            }
          })}\n`);
        }
        throw new Error(`Unexpected URL ${url}`);
      }
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.remoteSummary.status, 'completed');
    assert.equal(report.remoteSummary.downloadedResultCount, 1);
    assert.equal(report.parseSummary.completedCount, 1);
    assert.deepEqual(report.parseSummary.totalUsage, {
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5
    });

    const parsedRows = await readJsonl(report.artifacts.parsedResultsPath);
    assert.deepEqual(parsedRows[0].parsedJson, { claim_count: 1 });

    const ledgerResults = await readJsonl(report.artifacts.llmResultsPath);
    assert.equal(ledgerResults[0].status, 'completed');
    assert.equal(ledgerResults[0].results[0].sourceId, 'paper-1');
    assert.equal(calls.some((call) => String(call.url).endsWith('/files/file-output/content')), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Aliyun batch preparation maps unsafe custom ids and enforces per-line limits', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-limits-'));

  try {
    const report = await runAliyunBatchPreparation({
      runId: 'test-aliyun-batch-mapping',
      outputDir: tempRoot,
      entries: [{
        id: 'x'.repeat(300),
        prompt: 'Short prompt.'
      }]
    });

    assert.equal(report.mappedCustomIdCount, 1);
    const idMapRows = await readJsonl(report.artifacts.customIdMapPath);
    assert.equal(idMapRows[0].mappedReason, 'too_long');
    assert.equal(idMapRows[0].customId.length < 256, true);

    const validation = validateAliyunBatchRequests([{
      custom_id: 'too-big',
      method: 'POST',
      url: '/v1/chat/completions',
      body: {
        model: 'qwen-plus',
        messages: [{ role: 'user', content: 'x'.repeat(100) }]
      }
    }], {
      maxRequests: 50000,
      maxFileBytes: 1000,
      maxLineBytes: 50
    });
    assert.equal(validation.status, 'failed');
    assert.equal(validation.errors.some((error) => error.code === 'line_too_large'), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Aliyun batch preparation parses mock output and error JSONL by custom_id', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-parse-'));

  try {
    const resultPath = path.join(tempRoot, 'output.jsonl');
    const errorPath = path.join(tempRoot, 'errors.jsonl');
    await fs.writeFile(resultPath, `${JSON.stringify({
      id: 'batch_req_1',
      custom_id: 'paper-1',
      response: {
        status_code: 200,
        body: {
          model: 'qwen-plus',
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18
          },
          choices: [{
            finish_reason: 'stop',
            message: {
              content: '{"method":"graph","claim_count":2}'
            }
          }]
        }
      },
      error: null
    })}\n`);
    await fs.writeFile(errorPath, `${JSON.stringify({
      custom_id: 'paper-2',
      error: {
        code: 'BadRequest',
        message: 'invalid request'
      }
    })}\n`);

    const report = await runAliyunBatchPreparation({
      runId: 'test-aliyun-batch-parse',
      outputDir: tempRoot,
      entries: fixtureEntries().slice(0, 2),
      resultPaths: [resultPath],
      errorPaths: [errorPath]
    });

    assert.equal(report.status, 'partial');
    assert.equal(report.parseSummary.completedCount, 1);
    assert.equal(report.parseSummary.failedCount, 1);
    assert.equal(report.parseSummary.totalUsage.totalTokens, 18);

    const parsedRows = await readJsonl(report.artifacts.parsedResultsPath);
    assert.equal(parsedRows[0].sourceId, 'paper-1');
    assert.deepEqual(parsedRows[0].parsedJson, { method: 'graph', claim_count: 2 });

    const parsedErrors = await readJsonl(report.artifacts.parsedErrorsPath);
    assert.equal(parsedErrors[0].sourceId, 'paper-2');
    assert.equal(parsedErrors[0].status, 'failed');

    const ledgerResults = await readJsonl(report.artifacts.llmResultsPath);
    assert.equal(ledgerResults.length, 1);
    assert.equal(ledgerResults[0].status, 'completed_with_failures');
    assert.equal(ledgerResults[0].results.length, 2);

    const ledgerFailures = await readJsonl(report.artifacts.llmFailuresPath);
    assert.equal(ledgerFailures.length, 1);
    assert.equal(ledgerFailures[0].failedCount, 1);
    assert.deepEqual(ledgerFailures[0].entryIds, ['paper-2']);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Aliyun batch preparation CLI runs from repository paths with spaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-aliyun-batch-cli-'));

  try {
    const inputPath = path.join(tempRoot, 'entries.json');
    const outputDir = path.join(tempRoot, 'out');
    await fs.writeFile(inputPath, `${JSON.stringify({ entries: fixtureEntries().slice(0, 1) }, null, 2)}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/prepare-aliyun-batch-inference.mjs'),
      '--input', inputPath,
      '--output-dir', outputDir,
      '--run-id', 'cli-aliyun-batch',
      '--model', 'qwen-plus',
      '--json-mode', 'true'
    ], {
      cwd: process.cwd()
    });

    const report = JSON.parse(stdout);
    assert.equal(report.runId, 'cli-aliyun-batch');
    assert.equal(report.status, 'prepared');
    assert.equal(report.outputDir, outputDir);
    assert.ok(await fileExists(path.join(outputDir, 'batch-input.jsonl')));
    const shardRows = await readJsonl(path.join(outputDir, 'batch-input.jsonl'));
    assert.deepEqual(shardRows[0].body.response_format, { type: 'json_object' });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
