const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const diagnosticsChannel = require('node:diagnostics_channel');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event) => {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error('WebSocket open failed'));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('unified-llm-provider resolves an undici WebSocket with Node inspector-compatible diagnostics', async () => {
  const providerEntry = require.resolve('unified-llm-provider');
  const undiciPackagePath = require.resolve('undici/package.json', {
    paths: [path.dirname(providerEntry)]
  });
  const undiciPackage = require(undiciPackagePath);
  const { WebSocket } = require(path.dirname(undiciPackagePath));
  assert.equal(Number.parseInt(undiciPackage.version, 10) >= 7, true);

  const connectedSockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    connectedSockets.add(socket);
    socket.once('close', () => connectedSockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n'));
  });
  await listen(server);

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const events = [];
  const channel = diagnosticsChannel.channel('undici:websocket:open');
  const onDiagnosticOpen = (event) => events.push(event);
  channel.subscribe(onDiagnosticOpen);
  let socket;

  try {
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/responses`, {
      headers: { 'x-limcode-test': 'websocket-diagnostics' }
    });
    await waitForOpen(socket);
    await nextImmediate();

    const payload = events.find((event) => event.websocket === socket);
    assert.notEqual(payload, undefined);
    assert.equal(payload.websocket, socket);
    assert.equal(payload.handshakeResponse.status, 101);
    assert.equal(typeof payload.handshakeResponse.headers, 'object');
  } finally {
    channel.unsubscribe(onDiagnosticOpen);
    try { socket?.close(); } catch { /* noop */ }
    for (const connected of connectedSockets) connected.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
