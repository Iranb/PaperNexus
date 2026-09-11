import test from 'node:test';
import assert from 'node:assert/strict';
import { getSecret } from '../src/lib/keychain-linux.js';

test('Linux key retrieval uses the injected runner for tool discovery and Secret Service', async () => {
  const calls = [];
  const secret = await getSecret({service:'test-service', account:'test-account'}, {
    runner: async (command, args) => {
      calls.push([command, args]);
      return {stdout: command === 'which' ? '/mock/secret-tool\n' : 'fixture-secret\n'};
    }
  });
  assert.equal(secret, 'fixture-secret');
  assert.deepEqual(calls, [
    ['which', ['secret-tool']],
    ['secret-tool', ['lookup', 'service', 'test-service', 'account', 'test-account']]
  ]);
});

test('Linux key retrieval preserves the pass fallback and missing-tool result', async () => {
  const calls = [];
  const secret = await getSecret({service:'test-service', account:'test-account'}, {
    runner: async (command, args) => {
      calls.push([command, args]);
      if (command === 'which' && args[0] === 'secret-tool') throw new Error('not installed');
      return {stdout: command === 'which' ? '/mock/pass\n' : 'pass-fixture\n'};
    }
  });
  assert.equal(secret, 'pass-fixture');
  assert.deepEqual(calls.at(-1), ['pass', ['show', 'papernexus/test-service/test-account']]);
  assert.equal(await getSecret({service:'test-service', account:'test-account'}, {
    runner: async () => { throw new Error('not installed'); }
  }), '');
});
