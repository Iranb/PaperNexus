import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Linux keychain backend can store through secret-tool under ESM', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-linux-keychain-'));
  const binDir = path.join(tempRoot, 'bin');
  const secretPath = path.join(tempRoot, 'secret.txt');
  const secretToolPath = path.join(binDir, 'secret-tool');
  const previousPath = process.env.PATH;
  const previousSecretOut = process.env.PAPERNEXUS_FAKE_SECRET_OUT;

  try {
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      secretToolPath,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  store) cat > "$PAPERNEXUS_FAKE_SECRET_OUT" ;;',
        '  lookup) cat "$PAPERNEXUS_FAKE_SECRET_OUT" ;;',
        '  clear) rm -f "$PAPERNEXUS_FAKE_SECRET_OUT" ;;',
        '  *) exit 2 ;;',
        'esac'
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}${path.delimiter}${previousPath || ''}`;
    process.env.PAPERNEXUS_FAKE_SECRET_OUT = secretPath;

    const linuxKeychain = await import('../src/lib/keychain-linux.js');
    assert.equal(await linuxKeychain.isAvailable(), true);

    await linuxKeychain.setSecret({
      service: 'papernexus.test',
      account: 'openai:example',
      secret: 'test-secret'
    });

    assert.equal(await fs.readFile(secretPath, 'utf8'), 'test-secret');
    assert.equal(await linuxKeychain.getSecret({
      service: 'papernexus.test',
      account: 'openai:example'
    }), 'test-secret');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSecretOut === undefined) delete process.env.PAPERNEXUS_FAKE_SECRET_OUT;
    else process.env.PAPERNEXUS_FAKE_SECRET_OUT = previousSecretOut;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
