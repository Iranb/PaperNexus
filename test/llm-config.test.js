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
      model: 'claude-3-5-sonnet-latest'
    }
  });

  assert.equal(payload.llm.provider, 'anthropic');
  assert.equal(payload.llm.model, 'claude-3-5-sonnet-latest');
});

test('updateLlmConfigPayload persists llm provider and model to config.json', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-llm-config-'));
  const configPath = path.join(tempDir, 'config.json');

  try {
    const payload = await updateLlmConfigPayload({
      provider: 'openai',
      model: 'gpt-4o-mini'
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

    const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(saved.llm.provider, 'openai');
    assert.equal(saved.llm.model, 'gpt-4o-mini');
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
