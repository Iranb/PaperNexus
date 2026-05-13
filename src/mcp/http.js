import { createJsonRpcError, createJsonRpcSuccess, handleMessage } from './core.js';

const JSON_MIME_TYPE = 'application/json; charset=utf-8';
const DEFAULT_MCP_JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeMcpPath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '/mcp';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': JSON_MIME_TYPE,
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function resolveMcpJsonBodyLimitBytes(options = {}) {
  const serveConfig = options.config?.serve && typeof options.config.serve === 'object'
    ? options.config.serve
    : {};
  const mcpConfig = serveConfig.mcp && typeof serveConfig.mcp === 'object' && !Array.isArray(serveConfig.mcp)
    ? serveConfig.mcp
    : {};
  const raw = firstDefined(
    options.maxJsonBodyBytes,
    options.jsonBodyLimitBytes,
    mcpConfig.maxJsonBodyBytes,
    mcpConfig.jsonBodyLimitBytes,
    serveConfig.maxJsonBodyBytes,
    serveConfig.jsonBodyLimitBytes
  );
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MCP_JSON_BODY_LIMIT_BYTES;
  }
  return Math.floor(parsed);
}

async function readRequestText(request, options = {}) {
  const maxBytes = resolveMcpJsonBodyLimitBytes(options);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > maxBytes) {
      const error = new Error(`MCP request body exceeds the configured limit of ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function resolveJsonRpcErrorCode(error) {
  if (error?.message && /^Method not found:/i.test(error.message)) {
    return -32601;
  }
  return -32603;
}

export function getMcpHttpConfig(options = {}) {
  const serveConfig = options.config?.serve;
  const rawConfig = serveConfig?.mcp;
  const mcpConfig = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig
    : {};

  return {
    enabled: mcpConfig.enabled === true,
    path: normalizeMcpPath(mcpConfig.path),
    transport: typeof mcpConfig.transport === 'string' && mcpConfig.transport.trim()
      ? mcpConfig.transport.trim()
      : 'streamable-http',
    allowSseFallback: mcpConfig.allowSseFallback === true
  };
}

export async function handleMcpHttpRequest(request, response, options = {}) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method Not Allowed' });
    return {
      rpcMethod: request.method || 'UNKNOWN',
      statusCode: 405
    };
  }

  let message;
  try {
    const rawBody = await readRequestText(request, options);
    message = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch (error) {
    const statusCode = Number(error?.statusCode || 0) || 400;
    sendJson(response, statusCode, createJsonRpcError(null, -32700, statusCode === 413 ? error.message : 'Parse error'));
    return {
      rpcMethod: 'parse',
      statusCode
    };
  }

  if (Array.isArray(message)) {
    sendJson(response, 400, createJsonRpcError(null, -32600, 'Batch requests are not supported over HTTP MCP.'));
    return {
      rpcMethod: 'batch',
      statusCode: 400
    };
  }

  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    sendJson(response, 400, createJsonRpcError(message?.id ?? null, -32600, 'Invalid Request'));
    return {
      rpcMethod: 'invalid',
      statusCode: 400
    };
  }

  try {
    const result = await handleMessage(message, options);
    sendJson(response, 200, createJsonRpcSuccess(message.id ?? null, result));
    return {
      rpcMethod: message.method,
      statusCode: 200
    };
  } catch (error) {
    sendJson(response, 200, createJsonRpcError(
      message.id ?? null,
      resolveJsonRpcErrorCode(error),
      error.message || 'Internal error'
    ));
    return {
      rpcMethod: message.method,
      statusCode: 200
    };
  }
}
