import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { llmConfigPayload, updateLlmConfigPayload } from '../src/server/api.js';

test('llmConfigPayload resolves effective provider and model from config', () => {
  const payload = llmConfigPayload({
    llm: {
      provider: 'claudecode',
      model: 'claude-3-5-sonnet-latest',
      batchConcurrency: 3,
      contextWindowTokens: 1_000_000
    }
  });

  assert.equal(payload.llm.provider, 'anthropic');
  assert.equal(payload.llm.model, 'claude-3-5-sonnet-latest');
  assert.equal(payload.llm.batchConcurrency, 3);
  assert.equal(payload.llm.contextWindowTokens, 1_000_000);
});

test('updateLlmConfigPayload persists llm provider and model to config.json', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-config-'));
  const configPath = path.join(tempDir, 'config.json');

  try {
    const payload = await updateLlmConfigPayload({
      provider: 'openai',
      model: 'gpt-4o-mini',
      batchConcurrency: 2,
      contextWindowTokens: 1_000_000
    }, {
      config: {
        sources: {
          inputs: ['./papers']
        }
      },
      configBaseDir: tempDir,
      configPath
    });

    assert.equal(payload.llm.provider, 'openai');
    assert.equal(payload.llm.model, 'gpt-4o-mini');
    assert.equal(payload.llm.batchConcurrency, 2);
    assert.equal(payload.llm.contextWindowTokens, 1_000_000);

    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.llm.provider, 'openai');
    assert.equal(saved.llm.model, 'gpt-4o-mini');
    assert.equal(saved.llm.batchConcurrency, 2);
    assert.equal(saved.llm.contextWindowTokens, 1_000_000);
    assert.equal(saved.sources.inputs[0], './papers');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('updateLlmConfigPayload rotates default keychain account when provider changes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-keychain-config-'));
  const configPath = path.join(tempDir, 'config.json');

  try {
    const payload = await updateLlmConfigPayload({
      provider: 'claudecode',
      model: 'claude-3-5-sonnet-latest'
    }, {
      config: {
        llm: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
          apiKeySource: 'keychain',
          apiKeyService: 'papernexus.llm',
          apiKeyAccount: 'openai:https://api.openai.com/v1'
        }
      },
      configBaseDir: tempDir,
      configPath
    });

    assert.equal(payload.llm.provider, 'anthropic');
    assert.equal(payload.llm.apiKeyAccount, 'anthropic:https://api.anthropic.com/v1');

    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.llm.apiKeySource, 'keychain');
    assert.equal(saved.llm.apiKeyAccount, 'anthropic:https://api.anthropic.com/v1');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('updateLlmConfigPayload persists DeepSeek defaults and single-item batch size', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-deepseek-config-'));
  const configPath = path.join(tempDir, 'config.json');

  try {
    const payload = await updateLlmConfigPayload({
      provider: 'deepseek',
      model: 'deepseek-chat'
    }, {
      config: {
        llm: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
          batchSize: 8,
          apiKeySource: 'keychain',
          apiKeyService: 'papernexus.llm',
          apiKeyAccount: 'openai:https://api.openai.com/v1'
        }
      },
      configBaseDir: tempDir,
      configPath
    });

    assert.equal(payload.llm.provider, 'deepseek');
    assert.equal(payload.llm.model, 'deepseek-chat');
    assert.equal(payload.llm.baseUrl, 'https://api.deepseek.com');
    assert.equal(payload.llm.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(payload.llm.apiKeyAccount, 'deepseek:https://api.deepseek.com');
    assert.equal(payload.llm.batchSize, 1);

    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.llm.provider, 'deepseek');
    assert.equal(saved.llm.baseUrl, 'https://api.deepseek.com');
    assert.equal(saved.llm.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(saved.llm.apiKeyAccount, 'deepseek:https://api.deepseek.com');
    assert.equal(saved.llm.batchSize, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
