import crypto from 'node:crypto';

const COOKIE = 'papernexus_session';
const TTL = 12 * 60 * 60 * 1000;

export function createBrowserAuth(config = {}) {
  const username = process.env.PAPERNEXUS_LOGIN_USERNAME ?? config.username ?? 'admin';
  const password = process.env.PAPERNEXUS_LOGIN_PASSWORD ?? config.password ?? 'hhh123';
  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync(password, salt, 32);
  const sessions = new Map();
  const attempts = new Map();
  const sessionId = (request) => (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const sameOrigin = (request) => {
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!request.headers.origin) return true;
    try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
  };
  const cookie = (request, id, age) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${request.socket.encrypted ? '; Secure' : ''}`;
  function authenticated(request) {
    const id = sessionId(request);
    const expires = sessions.get(id);
    if (!expires || expires <= Date.now()) { sessions.delete(id); return false; }
    return ['GET', 'HEAD'].includes(request.method) || sameOrigin(request);
  }
  async function handle(request, response, pathname, { readJsonBody, sendJson }) {
    if (!['/auth/login', '/auth/logout', '/auth/session'].includes(pathname)) return false;
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/auth/session' && request.method === 'GET') {
      sendJson(response, authenticated(request) ? 200 : 401, { authenticated: authenticated(request) });
      return true;
    }
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed' }); return true; }
    if (!sameOrigin(request)) { sendJson(response, 403, { error: 'Cross-origin request rejected' }); return true; }
    if (pathname === '/auth/logout') {
      sessions.delete(sessionId(request));
      response.setHeader('Set-Cookie', cookie(request, '', 0));
      sendJson(response, 200, { ok: true });
      return true;
    }
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    const address = request.socket.remoteAddress;
    const attempt = attempts.get(address) || { count: 0, until: now + 60_000 };
    if (attempt.count >= 10) {
      response.setHeader('Retry-After', String(Math.ceil((attempt.until - now) / 1000)));
      sendJson(response, 429, { error: '尝试次数过多，请稍后重试' }); return true;
    }
    attempt.count += 1;
    attempts.set(address, attempt);
    const body = await readJsonBody(request, { maxJsonBodyBytes: 4096 });
    const supplied = typeof body?.password === 'string' ? body.password : '';
    const digest = await new Promise((resolve, reject) => crypto.scrypt(supplied, salt, 32, (error, result) => error ? reject(error) : resolve(result)));
    if (!crypto.timingSafeEqual(digest, passwordHash) || body?.username !== username) {
      sendJson(response, 401, { error: '账号或密码错误' }); return true;
    }
    attempts.delete(address);
    sessions.delete(sessionId(request));
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, now + TTL);
    response.setHeader('Set-Cookie', cookie(request, id, TTL / 1000));
    sendJson(response, 200, { ok: true, username });
    return true;
  }
  return { authenticated, handle };
}
