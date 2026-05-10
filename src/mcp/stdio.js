import { createJsonRpcError, createJsonRpcSuccess, handleMessage } from './core.js';

function sendMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function withToolStdoutRedirected(task) {
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = function redirectedStdoutWrite(chunk, encoding, callback) {
    return process.stderr.write(chunk, encoding, callback);
  };

  try {
    return await task();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

export function startMcpServer(options = {}) {
  let buffer = Buffer.alloc(0);

  process.stdin.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = Buffer.alloc(0);
        return;
      }

      const bodyLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + bodyLength;
      if (buffer.length < messageEnd) return;

      const body = buffer.slice(headerEnd + 4, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        continue;
      }

      try {
        const result = await withToolStdoutRedirected(() => handleMessage(message, options));
        sendMessage(createJsonRpcSuccess(message.id, result));
      } catch (error) {
        sendMessage(createJsonRpcError(message.id, -32603, error.message));
      }
    }
  });
}
