import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.join(__dirname, '..', 'examples');

async function canListenOnPort(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function pickAvailablePort(min, span = 1000) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = min + Math.floor(Math.random() * span);
    if (await canListenOnPort(port)) return port;
  }
  throw new Error(`No free test port found in ${min}-${min + span - 1}`);
}

test('serveCommand requires a token for all API routes while keeping static UI reachable', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-auth-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(49000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      config: {
        serve: {
          apiToken: 'test'
        }
      }
    });

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(unauthorized.status, 401);

      const authorized = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: {
          Authorization: 'Bearer test'
        }
      });
      assert.equal(authorized.status, 200);

      const wrongLengthToken = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: {
          Authorization: 'Bearer test-extra'
        }
      });
      assert.equal(wrongLengthToken.status, 401);

      const xHeaderAuthorized = await fetch(`http://127.0.0.1:${port}/api/corpora`, {
        headers: {
          'x-papernexus-token': 'test'
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

test('serveCommand returns client errors for malformed and oversized JSON API bodies', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-json-body-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(50500);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      maxJsonBodyBytes: 64,
      config: {
        serve: {
          apiToken: 'test'
        }
      }
    });

    try {
      const headers = {
        Authorization: 'Bearer test',
        'content-type': 'application/json'
      };
      const malformed = await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: 'POST',
        headers,
        body: '{"query":'
      });
      assert.equal(malformed.status, 400);
      assert.match((await malformed.json()).error, /Invalid JSON/);

      const oversized = await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: 'x'.repeat(128) })
      });
      assert.equal(oversized.status, 413);
      assert.match((await oversized.json()).error, /exceeds the configured limit/);
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
  const port = await pickAvailablePort(50000);

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
          Authorization: 'Bearer test'
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

test('serveCommand API routes prefer the configured storage index over stale registry roots', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-config-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-config-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(51000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );

    const [ingestion, registryApi, httpApi] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/storage/registry.js'),
      import('../src/server/http.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'http-config-test',
      force: true
    });

    await registryApi.saveRegistry({
      corpora: [
        {
          name: 'stale-macos-corpus',
          rootPath: '~/.papernexus/index-store',
          indexedAt: new Date(0).toISOString(),
          paperCount: 999
        }
      ]
    });

    const serverHandle = await httpApi.serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: indexRoot
        },
        serve: {
          apiToken: 'test'
        }
      },
      configBaseDir: workspaceRoot
    });

    try {
      const corpora = await fetch(`http://127.0.0.1:${port}/api/corpora`, {
        headers: {
          Authorization: 'Bearer test'
        }
      }).then((response) => response.json());
      assert.equal(corpora.corpora.length, 1);
      assert.equal(corpora.corpora[0].rootPath, indexRoot);

      const corpus = await fetch(`http://127.0.0.1:${port}/api/corpus?name=http-config-test`, {
        headers: {
          Authorization: 'Bearer test'
        }
      }).then((response) => response.json());
      assert.equal(corpus.meta.name, 'http-config-test');
      assert.ok(Array.isArray(corpus.graph.nodes));
      assert.ok(corpus.graph.nodes.length > 0);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand logs background worker startup states', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-worker-log-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(52000);
  const logs = [];
  const logger = {
    log(message) {
      logs.push(String(message));
    },
    warn(message) {
      logs.push(String(message));
    },
    error(message) {
      logs.push(String(message));
    }
  };

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: true,
      enableImports: true,
      enableAuthoritativeSync: true,
      logger,
      config: {
        serve: {
          apiToken: 'test'
        }
      }
    });

    try {
      assert.ok(logs.some((line) => line.includes('[serve] enhancement worker started')));
      assert.ok(logs.some((line) => line.includes('[serve] import worker started')));
      assert.ok(logs.some((line) => line.includes('[serve] authoritative sync worker started')));
      assert.ok(logs.some((line) => line.includes('[serve] registry reconcile worker started')));
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand warms MinerU backends in the background when imports are enabled', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-mineru-warmup-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(53000);
  const calls = [];
  const logs = [];
  const logger = {
    log(message) {
      logs.push(String(message));
    },
    warn(message) {
      logs.push(String(message));
    },
    error(message) {
      logs.push(String(message));
    }
  };

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      logger,
      config: {
        analyze: {
          pdfParser: 'mineru',
          mineruHttpUrl: 'http://127.0.0.1:30000'
        },
        serve: {
          apiToken: 'test'
        }
      },
      warmMineruBackends: async (warmupOptions) => {
        calls.push(warmupOptions);
        return {
          attempted: ['http://127.0.0.1:30000'],
          warmed: ['http://127.0.0.1:30000'],
          failed: []
        };
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].logger, logger);
      assert.ok(logs.some((line) => line.includes('[serve] MinerU warmup started')));
      assert.ok(logs.some((line) => line.includes('[serve] MinerU warmup finished')));
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand forwards analyze parser config into the import worker', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-import-worker-config-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(53100);
  const calls = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      config: {
        analyze: {
          pdfParser: 'markitdown',
          pythonCommand: './shared-python',
          semanticExtraction: 'llm-primary'
        },
        llm: {
          relations: true,
          batchSize: 8
        },
        imports: {
          batchEnabled: true,
          batchMaxTasks: 4,
          batchInitialTasks: 2,
          batchProgressive: false,
          batchMaxFiles: 12,
          batchMaxBytes: 1048576
        },
        serve: {
          apiToken: 'test'
        }
      },
      startImportWorker(workerOptions) {
        calls.push(workerOptions);
        return {
          stop() {},
          pollNow() {}
        };
      },
      warmDoclingRuntime() {
        return Promise.resolve({ warmed: true });
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].pdfParser, 'markitdown');
      assert.equal(calls[0].pythonCommand, './shared-python');
      assert.equal(calls[0].markitdownPython, './shared-python');
      assert.equal(calls[0].semanticExtraction, 'llm-primary');
      assert.equal(calls[0].llmRelations, false);
      assert.equal(calls[0].llmBatchSize, 12);
      assert.equal(calls[0].batchEnabled, true);
      assert.equal(calls[0].batchMaxTasks, 4);
      assert.equal(calls[0].batchInitialTasks, 2);
      assert.equal(calls[0].batchProgressive, false);
      assert.equal(calls[0].batchMaxFiles, 12);
      assert.equal(calls[0].batchMaxBytes, 1048576);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand enables import batching by default for MCP serve workers', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-import-worker-batch-default-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(53200);
  const calls = [];

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      config: {
        serve: {
          apiToken: 'test'
        }
      },
      startImportWorker(workerOptions) {
        calls.push(workerOptions);
        return {
          stop() {},
          pollNow() {}
        };
      },
      warmDoclingRuntime() {
        return Promise.resolve({ warmed: true });
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].batchEnabled, true);
      assert.equal(calls[0].batchMaxTasks, 16);
      assert.equal(calls[0].batchInitialTasks, 4);
      assert.equal(calls[0].batchProgressive, true);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand warms Docling runtime in the background when imports are enabled', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-docling-warmup-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(53400);
  const calls = [];
  const logs = [];
  const logger = {
    log(message) {
      logs.push(String(message));
    },
    warn(message) {
      logs.push(String(message));
    },
    error(message) {
      logs.push(String(message));
    }
  };

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      logger,
      config: {
        analyze: {
          pdfParser: 'docling',
          doclingCommand: 'docling',
          doclingDevice: 'cuda',
          doclingCudaVisibleDevices: '2'
        },
        serve: {
          apiToken: 'test'
        }
      },
      warmDoclingRuntime: async (warmupOptions) => {
        calls.push(warmupOptions);
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].doclingCommand, 'docling');
      assert.equal(calls[0].doclingDevice, 'cuda');
      assert.equal(calls[0].doclingCudaVisibleDevices, '2');
      assert.ok(logs.some((line) => line.includes('[serve] Docling warmup started')));
      assert.ok(logs.some((line) => line.includes('[serve] Docling warmup finished')));
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand keeps background Docling warmup failure logs compact', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-docling-warmup-fail-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(53500);
  const logs = [];
  const logger = {
    log(message) {
      logs.push(String(message));
    },
    warn(message) {
      logs.push(String(message));
    },
    error(message) {
      logs.push(String(message));
    }
  };

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      logger,
      config: {
        analyze: {
          pdfParser: 'docling'
        },
        serve: {
          apiToken: 'test'
        }
      },
      warmDoclingRuntime: async () => {
        throw new Error(`line one\nline two\nline three\nline four ${'x'.repeat(800)}`);
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const warning = logs.find((line) => line.includes('[serve] Docling warmup failed'));
      assert.ok(warning);
      assert.match(warning, /line one/);
      assert.match(warning, /line two/);
      assert.match(warning, /line three/);
      assert.doesNotMatch(warning, /line four/);
      assert.ok(warning.length < 560);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand forwards paddleocr-vl parser config into the import worker', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-worker-paddleocr-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const calls = [];
  const port = await pickAvailablePort(54000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      config: {
        analyze: {
          pdfParser: 'paddleocr-vl',
          pythonCommand: './shared-python',
          paddleocrVlServerUrl: 'http://127.0.0.1:8080/v1'
        },
        serve: {
          apiToken: 'test'
        }
      },
      startImportWorker(workerOptions) {
        calls.push(workerOptions);
        return {
          stop() {},
          pollNow() {}
        };
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].pdfParser, 'paddleocr-vl');
      assert.equal(calls[0].pythonCommand, './shared-python');
      assert.equal(calls[0].paddleocrVlPython, './shared-python');
      assert.equal(calls[0].paddleocrVlServerUrl, 'http://127.0.0.1:8080/v1');
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand forwards Docling GPU config into the import worker', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-worker-docling-home-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  const calls = [];
  const port = await pickAvailablePort(54150);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    const { serveCommand } = await import('../src/server/http.js');
    const serverHandle = await serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: true,
      config: {
        analyze: {
          pdfParser: 'docling',
          pythonCommand: './shared-python',
          doclingCommand: 'docling',
          doclingDevice: 'cuda',
          doclingCudaVisibleDevices: '2',
          doclingArtifactsPath: '/home/researcher/.cache/docling/models',
          doclingImageExportMode: 'placeholder',
          doclingEnrichPictureClasses: false,
          doclingEnrichPictureDescription: false,
          doclingPreload: true
        },
        serve: {
          apiToken: 'test'
        }
      },
      startImportWorker(workerOptions) {
        calls.push(workerOptions);
        return {
          stop() {},
          pollNow() {}
        };
      }
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].pdfParser, 'docling');
      assert.equal(calls[0].doclingPython, './shared-python');
      assert.equal(calls[0].doclingDevice, 'cuda');
      assert.equal(calls[0].doclingCudaVisibleDevices, '2');
      assert.equal(calls[0].doclingArtifactsPath, '/home/researcher/.cache/docling/models');
      assert.equal(calls[0].doclingImageExportMode, 'placeholder');
      assert.equal(calls[0].doclingEnrichPictureClasses, false);
      assert.equal(calls[0].doclingEnrichPictureDescription, false);
      assert.equal(calls[0].doclingPreload, true);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});

test('serveCommand accepts server-side single file path imports over HTTP', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-server-file-import-home-'));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'papernexus-http-server-file-import-workspace-'));
  const inputRoot = path.join(workspaceRoot, 'papers');
  const indexRoot = path.join(workspaceRoot, 'index-store');
  const uploadRoot = path.join(workspaceRoot, 'uploads');
  const uploadPath = path.join(uploadRoot, 'server-side-upload.md');
  const previousHome = process.env.PAPERNEXUS_HOME;
  const port = await pickAvailablePort(54000);

  try {
    process.env.PAPERNEXUS_HOME = tempHome;
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.copyFile(
      path.join(examplesRoot, 'retrieval-augmented-experiment-planning.md'),
      path.join(inputRoot, 'retrieval-augmented-experiment-planning.md')
    );
    await fs.writeFile(uploadPath, '# Server Path Upload\n\n## Abstract\n\nHTTP route import.\n', 'utf8');

    const [ingestion, httpApi] = await Promise.all([
      import('../src/core/ingestion/pipeline.js'),
      import('../src/server/http.js')
    ]);

    await ingestion.analyzeCorpus(inputRoot, {
      rootPath: indexRoot,
      name: 'http-server-file-import-test',
      force: true
    });

    const serverHandle = await httpApi.serveCommand({
      host: '127.0.0.1',
      port,
      apiToken: 'test',
      enableEnhancements: false,
      enableAuthoritativeSync: false,
      enableImports: false,
      config: {
        storage: {
          indexDir: indexRoot
        },
        serve: {
          apiToken: 'test'
        }
      },
      configBaseDir: workspaceRoot
    });

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/imports?name=http-server-file-import-test`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serverFilePath: uploadPath,
          identifiers: {
            doi: '10.48550/papernexus.http-server-upload'
          }
        })
      });
      assert.equal(created.status, 202);
      const createdPayload = await created.json();
      assert.equal(createdPayload.deduped, false);
      assert.equal(createdPayload.task.files[0].originalName, 'server-side-upload.md');

      const deduped = await fetch(`http://127.0.0.1:${port}/api/imports?name=http-server-file-import-test`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serverFilePath: uploadPath,
          identifiers: {
            doi: '10.48550/papernexus.http-server-upload'
          }
        })
      });
      assert.equal(deduped.status, 202);
      const dedupedPayload = await deduped.json();
      assert.equal(dedupedPayload.deduped, true);
      assert.equal(dedupedPayload.task.id, createdPayload.task.id);

      const invalid = await fetch(`http://127.0.0.1:${port}/api/imports?name=http-server-file-import-test`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          serverFilePath: uploadRoot
        })
      });
      assert.equal(invalid.status, 400);
      const invalidPayload = await invalid.json();
      assert.match(invalidPayload.error, /regular file/i);
    } finally {
      await serverHandle.stop();
    }
  } finally {
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME;
    else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
