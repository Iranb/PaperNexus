import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBrowserAuth } from '../src/server/browser-auth.js';

test('browser login protects access, validates credentials, expires sessions and rejects CSRF', async () => {
  const auth = createBrowserAuth();
  const server = http.createServer(async (request, response) => {
    const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const readJsonBody = async (req) => { let body = ''; for await (const part of req) body += part; return JSON.parse(body); };
    if (await auth.handle(request, response, request.url, { readJsonBody, sendJson })) return;
    sendJson(response, auth.authenticated(request) ? 200 : 401, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (password, headers = {}) => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password }) });
  try {
    assert.equal((await fetch(base + '/private')).status, 401);
    assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('hhh123', { Origin: 'https://evil.example' })).status, 403);
    const response = await login('hhh123');
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    assert.equal(Object.hasOwn(await response.json(), 'token'), false);
    const Cookie = setCookie.split(';')[0];
    assert.equal((await fetch(base + '/private', { headers: { Cookie } })).status, 200);
    assert.equal((await fetch(base + '/private', { method: 'POST', headers: { Cookie, Origin: 'https://evil.example' } })).status, 401);
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie } })).status, 200);
    assert.equal((await fetch(base + '/private', { headers: { Cookie } })).status, 401);
    for (let i = 0; i < 10; i++) assert.equal((await login('wrong')).status, 401);
    assert.equal((await login('wrong')).status, 429);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('server accepts browser sessions for API while MCP still requires its API token', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pn-browser-auth-'));
  const previousHome = process.env.PAPERNEXUS_HOME;
  process.env.PAPERNEXUS_HOME = temp;
  let handle;
  try {
    const { serveCommand } = await import('../src/server/http.js');
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    handle = await serveCommand({ host: '127.0.0.1', port, enableImports: false, enableEnhancements: false, config: { serve: { apiToken: 'integration-token', mcp: { enabled: true } } } });
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'hhh123' }) });
    assert.equal(response.status, 200);
    const Cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/health', { headers: { Cookie } })).status, 200);
    assert.equal((await fetch(base + '/mcp', { headers: { Cookie } })).status, 401);
    assert.equal((await fetch(base + '/login.html')).status, 200);
    await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie } });
    assert.equal((await fetch(base + '/api/health', { headers: { Cookie } })).status, 401);
  } finally {
    await handle?.stop();
    if (previousHome === undefined) delete process.env.PAPERNEXUS_HOME; else process.env.PAPERNEXUS_HOME = previousHome;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
