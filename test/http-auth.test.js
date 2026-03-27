import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('serveCommand requires a token for all API routes while keeping static UI reachable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-auth-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = 49000 + Math.floor(Math.random() * 1000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'secret-token',
      enableEnhancements: false,
      enableImports: false,
      config: {
        serve: {
          apiToken: 'secret-token'
        }
      }
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: {
          Authorization: 'Bearer secret-token'
        }
      });
      assert.equal(authorized.status, 200);

      const xHeaderAuthorized = await fetch(`http://127.0.0.1:${port}/api/corpora`, {
        headers: {
          'x-papernexus-token': 'secret-token'
        }
      });
      assert.equal(xHeaderAuthorized.status, 200);

      const staticIndex = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(staticIndex.status, 200);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand returns 503 for API routes when no token is configured', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-auth-missing-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = 50000 + Math.floor(Math.random() * 1000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      enableEnhancements: false,
      enableImports: false,
      config: {
        serve: {}
      }
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: {
          Authorization: 'Bearer anything'
        }
      });
      assert.equal(response.status, 503);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
