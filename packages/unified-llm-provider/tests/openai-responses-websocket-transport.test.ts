import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { resetOpenAIResponsesWebSocketSessions, streamOpenAIResponsesWebSocket } from '../src/llm/websocket-openai-responses.js';
import type { FormatAdapter } from '../src/llm/formats/types.js';
import { OpenAIResponsesFormat } from '../src/llm/formats/openai-responses.js';
import type { Content } from '../src/types.js';

const passthroughFormat: FormatAdapter = {
  encodeRequest: () => ({ input: [] }),
  decodeResponse: () => ({ content: { role: 'model', parts: [] } }),
  decodeStreamChunk: (raw) => {
    const record = raw as { delta?: unknown };
    return typeof record.delta === 'string' ? { textDelta: record.delta } : {};
  },
  createStreamState: () => ({}),
};

const userContent = (text: string): Content => ({ role: 'user', parts: [{ text }] });
const modelContent = (text: string): Content => ({ role: 'model', parts: [{ text }] });

describe('OpenAI Responses WebSocket undici transport', () => {
  afterEach(() => resetOpenAIResponsesWebSocketSessions());

  it('consumes a burst of delta events and the terminal event without per-message pacing', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let requestedExtensions: string | undefined;
    let negotiatedExtensions: string | undefined;
    const undiciOpenEvents: unknown[] = [];
    const undiciOpenChannel = channel('undici:websocket:open');
    const onUndiciOpen = (event: unknown) => undiciOpenEvents.push(event);
    undiciOpenChannel.subscribe(onUndiciOpen);
    server.once('headers', (_headers, request) => {
      requestedExtensions = request.headers['sec-websocket-extensions'];
    });
    server.once('connection', (socket) => {
      negotiatedExtensions = socket.extensions;
      socket.once('message', () => {
        for (let index = 0; index < 50; index += 1) {
          socket.send(JSON.stringify({
            type: 'response.output_text.delta',
            response_id: 'resp_burst',
            item_id: 'msg_burst',
            output_index: 0,
            content_index: 0,
            sequence_number: index,
            delta: String(index % 10),
          }));
        }
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_burst', output: [] },
        }), () => socket.close());
      });
    });

    const startedAt = performance.now();
    let text = '';
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url: `http://127.0.0.1:${address.port}`,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `transport-test-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url: `http://127.0.0.1:${address.port}`,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
      })) {
        text += chunk.textDelta ?? '';
      }
    } finally {
      undiciOpenChannel.unsubscribe(onUndiciOpen);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(text).toBe('0123456789'.repeat(5));
    const undiciOpen = undiciOpenEvents[0] as { websocket?: unknown; handshakeResponse?: { status?: number; headers?: unknown } } | undefined;
    expect(undiciOpen?.websocket).toBeDefined();
    expect(undiciOpen?.handshakeResponse?.status).toBe(101);
    expect(undiciOpen?.handshakeResponse?.headers).toBeDefined();
    expect(requestedExtensions).toBeUndefined();
    expect(negotiatedExtensions).toBe('');
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('fails a WebSocket handshake that does not open before the connection deadline', async () => {
    const sockets = new Set<net.Socket>();
    let connectionCount = 0;
    const server = net.createServer((socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.resume();
      // Consume the handshake but keep the TCP connection open without returning an upgrade response.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Handshake test server did not expose a TCP port');

    const url = `http://127.0.0.1:${address.port}`;
    const consume = async (): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `connect-timeout-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 40,
        responseIdleTimeoutMs: 200,
      })) {
        // The handshake must fail before a stream can be produced.
      }
    };

    const startedAt = performance.now();
    try {
      await expect(consume()).rejects.toMatchObject({
        name: 'TimeoutError',
        message: 'OpenAI Responses WebSocket connection timed out after 40ms',
      });
      expect(connectionCount).toBe(1);
      expect(performance.now() - startedAt).toBeLessThan(500);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(connectionCount).toBe(1);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('refreshes the response inactivity deadline whenever a WebSocket event arrives', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let activityInterval: ReturnType<typeof setInterval> | undefined;
    server.once('connection', (socket) => {
      socket.once('message', () => {
        const deltas = ['a', 'b', 'c'];
        let index = 0;
        activityInterval = setInterval(() => {
          if (index < deltas.length) {
            socket.send(JSON.stringify({
              type: 'response.output_text.delta',
              response_id: 'resp_activity',
              item_id: 'msg_activity',
              output_index: 0,
              content_index: 0,
              delta: deltas[index++],
            }));
            return;
          }
          if (activityInterval) clearInterval(activityInterval);
          activityInterval = undefined;
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_activity', output: [] },
          }));
        }, 25);
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ textDelta?: string; error?: unknown }> = [];
    const startedAt = performance.now();
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `idle-refresh-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        responseIdleTimeoutMs: 80,
      })) chunks.push(chunk);

      expect(performance.now() - startedAt).toBeGreaterThan(80);
      expect(chunks.map((chunk) => chunk.textDelta ?? '').join('')).toBe('abc');
      expect(chunks.some((chunk) => chunk.error !== undefined)).toBe(false);
    } finally {
      if (activityInterval) clearInterval(activityInterval);
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('invalidates continuation after response inactivity and full-replays the next request', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_before_timeout', status: 'completed', output: [] },
          }));
        } else if (payloads.length === 2) {
          socket.send(JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_during_timeout', status: 'in_progress' },
          }));
        } else if (payloads.length === 3) {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_after_timeout', status: 'completed', output: [] },
          }));
        }
        // The second response becomes silent after its first event until the client times it out.
      });
    });

    const sessionKey = `response-timeout-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const inputItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const firstInput = inputItem('first');
    const secondInput = inputItem('second');
    const thirdInput = inputItem('third');
    const consume = async (input: unknown[]): Promise<Array<{ error?: unknown }>> => {
      const chunks: Array<{ error?: unknown }> = [];
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        responseIdleTimeoutMs: 50,
      })) chunks.push(chunk);
      return chunks;
    };

    try {
      await consume([firstInput]);
      const timedOut = await consume([firstInput, secondInput]);
      const timeoutMessage = timedOut
        .map((chunk) => (chunk.error as { message?: unknown } | undefined)?.message)
        .find((message): message is string => typeof message === 'string');
      expect(timeoutMessage).toContain('TimeoutError: OpenAI Responses WebSocket received no events for 50ms');

      await consume([firstInput, secondInput, thirdInput]);

      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(3);
      expect(payloads[0]).toMatchObject({ connection: 1, payload: { input: [firstInput] } });
      expect(payloads[1]).toMatchObject({
        connection: 1,
        payload: { input: [secondInput], previous_response_id: 'resp_before_timeout' },
      });
      expect(payloads[2]).toMatchObject({
        connection: 2,
        payload: { input: [firstInput, secondInput, thirdInput] },
      });
      expect(payloads[2].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fences an idle socket when the local network identity changes and preserves the new socket', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: `resp_network_${payloads.length}`, status: 'completed', output: [] },
        }));
      });
    });

    const sessionKey = `network-fence-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const inputItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const firstInput = inputItem('first');
    const secondInput = inputItem('second');
    const thirdInput = inputItem('third');
    const consume = async (input: unknown[], networkIdentityFingerprint: string): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        networkIdentityFingerprint,
      })) {
        // Consume the complete response.
      }
    };

    try {
      await consume([firstInput], 'network-a');
      await consume([firstInput, secondInput], 'network-b');
      await new Promise((resolve) => setTimeout(resolve, 30));
      await consume([firstInput, secondInput, thirdInput], 'network-b');

      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(3);
      expect(payloads[0]).toMatchObject({ connection: 1, payload: { input: [firstInput] } });
      expect(payloads[0].payload.previous_response_id).toBeUndefined();
      expect(payloads[1]).toMatchObject({ connection: 2, payload: { input: [firstInput, secondInput] } });
      expect(payloads[1].payload.previous_response_id).toBeUndefined();
      expect(payloads[2]).toMatchObject({
        connection: 2,
        payload: { input: [thirdInput], previous_response_id: 'resp_network_2' },
      });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('interrupts an active response when the local network changes and full-replays the next request', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    let networkIdentity = 'network-a';
    let resolveSecondRequest!: () => void;
    const secondRequestReceived = new Promise<void>((resolve) => { resolveSecondRequest = resolve; });
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_before_network_switch', status: 'completed', output: [] },
          }));
        } else if (payloads.length === 2) {
          socket.send(JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_interrupted_by_network_switch', status: 'in_progress' },
          }));
          resolveSecondRequest();
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_after_network_switch', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `active-network-switch-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const inputItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const firstInput = inputItem('first');
    const secondInput = inputItem('second');
    const thirdInput = inputItem('third');
    const consume = async (input: unknown[]): Promise<Array<{ error?: Record<string, unknown> }>> => {
      const chunks: Array<{ error?: Record<string, unknown> }> = [];
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 1_000,
        networkIdentityFingerprint: () => networkIdentity,
        networkIdentityCheckIntervalMs: 10,
      })) chunks.push(chunk as { error?: Record<string, unknown> });
      return chunks;
    };

    try {
      await consume([firstInput]);
      const interruptedPromise = consume([firstInput, secondInput]);
      await secondRequestReceived;
      const switchedAt = performance.now();
      networkIdentity = 'network-b';
      const interrupted = await interruptedPromise;

      expect(performance.now() - switchedAt).toBeLessThan(500);
      expect(interrupted.find((chunk) => chunk.error)?.error).toMatchObject({
        kind: 'stream_read_error',
        transport: 'websocket',
        phase: 'streaming',
        code: 'network_changed',
        receivedServerEvent: true,
        attempt: 1,
        maxAttempts: 1,
        retryable: true,
      });

      await consume([firstInput, secondInput, thirdInput]);

      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(3);
      expect(payloads[1]).toMatchObject({
        connection: 1,
        payload: { input: [secondInput], previous_response_id: 'resp_before_network_switch' },
      });
      expect(payloads[2]).toMatchObject({
        connection: 2,
        payload: { input: [firstInput, secondInput, thirdInput] },
      });
      expect(payloads[2].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('reconnects with full context when the socket dies before the first response event', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_before_network_drop', status: 'completed', output: [] },
          }));
        } else if (payloads.length === 2) {
          socket.terminate();
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_after_network_drop', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `pre-event-network-drop-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const inputItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const firstInput = inputItem('first');
    const secondInput = inputItem('second');
    const consume = async (input: unknown[]): Promise<Array<{ error?: unknown }>> => {
      const chunks: Array<{ error?: unknown }> = [];
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk);
      return chunks;
    };

    try {
      await consume([firstInput]);
      const recovered = await consume([firstInput, secondInput]);

      expect(recovered.some((chunk) => chunk.error !== undefined)).toBe(false);
      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(3);
      expect(payloads[1]).toMatchObject({
        connection: 1,
        payload: { input: [secondInput], previous_response_id: 'resp_before_network_drop' },
      });
      expect(payloads[2]).toMatchObject({
        connection: 2,
        payload: { input: [firstInput, secondInput] },
      });
      expect(payloads[2].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('surfaces a first-event timeout without multiplying slow transport attempts', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Record<string, unknown>[] = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', (data) => {
        payloads.push(JSON.parse(data.toString()) as Record<string, unknown>);
        // Keep the connection silent until the client-side first-event deadline.
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ error?: Record<string, unknown> }> = [];
    const startedAt = performance.now();
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `first-event-timeout-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 40,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk as { error?: Record<string, unknown> });

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(connectionCount).toBe(1);
      expect(payloads).toHaveLength(1);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.error).toMatchObject({
        kind: 'stream_read_error',
        transport: 'websocket',
        phase: 'awaiting_first_event',
        receivedServerEvent: false,
        attempt: 1,
        maxAttempts: 1,
        retryable: true,
      });
      expect(chunks[0]?.error?.message).toContain('received no first event for 40ms');
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('recovers when sub2api closes fresh connections for a missing first response.create message', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Record<string, unknown>[] = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.once('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push(payload);
        if (connection < 3) {
          socket.close(1008, 'missing first response.create message');
          return;
        }
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_after_missing_first', status: 'completed', output: [] },
        }));
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'recover' }] }];
    const chunks: Array<{ error?: unknown }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `missing-first-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.error !== undefined)).toBe(false);
      expect(connectionCount).toBe(3);
      expect(payloads).toHaveLength(3);
      for (const payload of payloads) {
        expect(payload.type).toBe('response.create');
        expect(payload.input).toEqual(input);
        expect(payload.previous_response_id).toBeUndefined();
      }
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('retries 1011 upstream proxy failures and exposes structured close metadata after exhaustion', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', () => {
        socket.close(1011, 'upstream websocket proxy failed');
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ error?: Record<string, unknown> }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `upstream-1011-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'retry 1011' }] }] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk as { error?: Record<string, unknown> });

      expect(connectionCount).toBe(3);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.error).toMatchObject({
        kind: 'stream_read_error',
        transport: 'websocket',
        phase: 'awaiting_first_event',
        closeCode: 1011,
        closeReason: 'upstream websocket proxy failed',
        receivedServerEvent: false,
        attempt: 3,
        maxAttempts: 3,
        retryable: true,
      });
      expect(chunks[0]?.error?.message).toContain('1011 upstream websocket proxy failed');
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('recovers from a standard 1013 try-again-later close before the first server event', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Record<string, unknown>[] = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.once('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push(payload);
        if (connection === 1) {
          socket.close(1013, 'upstream service temporarily unavailable');
          return;
        }
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_after_1013', status: 'completed', output: [] },
        }));
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'retry 1013' }] }];
    const chunks: Array<{ error?: unknown }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `upstream-1013-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.error !== undefined)).toBe(false);
      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toMatchObject({ input });
      expect(payloads[1]?.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not retry a 1008 authentication or policy close', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', () => {
        socket.close(1008, 'upstream websocket authentication failed');
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ error?: Record<string, unknown> }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `auth-1008-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk as { error?: Record<string, unknown> });

      expect(connectionCount).toBe(1);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.error).toMatchObject({
        kind: 'stream_read_error',
        transport: 'websocket',
        phase: 'awaiting_first_event',
        closeCode: 1008,
        closeReason: 'upstream websocket authentication failed',
        receivedServerEvent: false,
        attempt: 1,
        maxAttempts: 1,
        retryable: false,
      });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('preserves an OpenAI WebSocket error event code, message, status, and retryability', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', () => {
        socket.send(JSON.stringify({
          type: 'error',
          status: 401,
          error: {
            type: 'invalid_request_error',
            code: 'invalid_api_key',
            message: 'Incorrect API key provided.',
          },
        }));
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ error?: Record<string, unknown> }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `official-error-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk as { error?: Record<string, unknown> });

      expect(connectionCount).toBe(1);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.error).toMatchObject({
        kind: 'stream_error',
        transport: 'websocket',
        phase: 'streaming',
        code: 'invalid_api_key',
        status: 401,
        message: 'Incorrect API key provided.',
        receivedServerEvent: true,
        attempt: 1,
        maxAttempts: 3,
        retryable: false,
      });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not replay inside the WS transport after a server event has already been emitted', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let connectionCount = 0;
    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.once('message', () => {
        socket.send(JSON.stringify({
          type: 'response.output_text.delta',
          response_id: 'resp_partial',
          item_id: 'msg_partial',
          output_index: 0,
          content_index: 0,
          delta: 'partial',
        }), () => socket.terminate());
      });
    });

    const url = `http://127.0.0.1:${address.port}`;
    const chunks: Array<{ textDelta?: string; error?: unknown }> = [];
    try {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `partial-network-drop-${Date.now()}-${Math.random()}`,
          headers: {},
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        responseIdleTimeoutMs: 500,
        networkIdentityFingerprint: 'stable-network',
      })) chunks.push(chunk);

      expect(chunks.map((chunk) => chunk.textDelta ?? '').join('')).toBe('partial');
      const errorMessage = chunks
        .map((chunk) => (chunk.error as { message?: unknown } | undefined)?.message)
        .find((message): message is string => typeof message === 'string');
      expect(errorMessage).toMatch(/WebSocket/);
      expect(errorMessage?.trim()).not.toBe('TypeError:');
      expect(connectionCount).toBe(1);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('reconnects when the proxy configuration changes for the same session key', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let targetConnectionCount = 0;
    const requestedExtensions: Array<string | undefined> = [];
    const negotiatedExtensions: string[] = [];
    server.on('headers', (_headers, request) => {
      requestedExtensions.push(request.headers['sec-websocket-extensions']);
    });
    server.on('connection', (socket) => {
      targetConnectionCount += 1;
      negotiatedExtensions.push(socket.extensions);
      socket.on('message', () => {
        socket.send(JSON.stringify({
          type: 'response.output_text.delta',
          response_id: `resp_proxy_${targetConnectionCount}`,
          item_id: `msg_proxy_${targetConnectionCount}`,
          output_index: 0,
          content_index: 0,
          delta: 'ok',
        }));
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: `resp_proxy_${targetConnectionCount}`, output: [] },
        }));
      });
    });

    let proxyConnectCount = 0;
    const proxyServer = http.createServer();
    proxyServer.on('connect', (request, clientSocket, head) => {
      const targetUrl = new URL(`http://${request.url ?? ''}`);
      proxyConnectCount += 1;
      const upstream = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
    });
    proxyServer.listen(0, '127.0.0.1');
    await once(proxyServer, 'listening');
    const proxyAddress = proxyServer.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy test server did not expose a TCP port');

    const sessionKey = `proxy-switch-test-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const run = async (proxy?: string): Promise<string> => {
      let text = '';
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
          ...(proxy !== undefined ? { proxy } : {}),
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
      })) {
        text += chunk.textDelta ?? '';
      }
      return text;
    };

    try {
      expect(await run()).toBe('ok');
      expect(proxyConnectCount).toBe(0);
      expect(targetConnectionCount).toBe(1);

      expect(await run()).toBe('ok');
      expect(proxyConnectCount).toBe(0);
      expect(targetConnectionCount).toBe(1);

      const proxyUrl = `http://proxy-user:proxy-secret@127.0.0.1:${proxyAddress.port}`;
      expect(await run(proxyUrl)).toBe('ok');
      expect(proxyConnectCount).toBe(1);
      expect(targetConnectionCount).toBe(2);

      expect(await run(proxyUrl)).toBe('ok');
      expect(proxyConnectCount).toBe(1);
      expect(targetConnectionCount).toBe(2);

      expect(await run('')).toBe('ok');
      expect(proxyConnectCount).toBe(1);
      expect(targetConnectionCount).toBe(3);
      expect(requestedExtensions).toEqual([undefined, undefined, undefined]);
      expect(negotiatedExtensions).toEqual(['', '', '']);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => proxyServer.close((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

  });

  it('closes an aborted socket and sends the next turn on a new connection with full local context', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    let resolveInterruptedRequest!: () => void;
    const interruptedRequestReceived = new Promise<void>((resolve) => { resolveInterruptedRequest = resolve; });
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_seed', output: [] } }));
        } else if (payloads.length === 2) {
          resolveInterruptedRequest();
        } else if (payloads.length === 3) {
          socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_after_interrupt', output: [] } }));
        }
      });
    });

    const sessionKey = `abort-reconnect-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const inputItem = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const firstInput = inputItem('first');
    const secondInput = inputItem('second');
    const interruptInput = inputItem('[Background command exited] done');
    const consume = async (input: unknown[], signal?: AbortSignal): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: sessionKey,
          headers: {},
        },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
        signal,
      })) {
        // Consume until the response completes or the caller aborts it.
      }
    };

    try {
      await consume([firstInput]);

      const controller = new AbortController();
      const interrupted = consume([firstInput, secondInput], controller.signal);
      await interruptedRequestReceived;
      controller.abort(new Error('test interrupt'));
      await expect(interrupted).rejects.toThrow('test interrupt');

      await consume([firstInput, secondInput, interruptInput]);

      expect(connectionCount).toBe(2);
      expect(payloads).toHaveLength(3);
      expect(payloads[0]).toMatchObject({ connection: 1, payload: { input: [firstInput] } });
      expect(payloads[0].payload.previous_response_id).toBeUndefined();
      expect(payloads[1]).toMatchObject({ connection: 1, payload: { input: [secondInput], previous_response_id: 'resp_seed' } });
      expect(payloads[2]).toMatchObject({ connection: 2, payload: { input: [firstInput, secondInput, interruptInput] } });
      expect(payloads[2].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('uses response.output_item.done as the continuation baseline when response.completed.output is empty', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const format = new OpenAIResponsesFormat('gpt-test');
    const firstContent = userContent('first');
    const secondContent = userContent('second');
    const firstBody = format.encodeRequest({ contents: [firstContent] }, true) as Record<string, unknown>;
    const secondBody = format.encodeRequest({
      contents: [firstContent, modelContent('answer'), secondContent],
    }, true) as Record<string, unknown>;
    const secondInput = (secondBody.input as unknown[]).at(-1);
    const assistantItem = {
      id: 'msg_exact_output',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    };
    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.output_item.done',
            response_id: 'resp_exact_1',
            output_index: 0,
            item: assistantItem,
          }));
          socket.send(JSON.stringify({
            type: 'response.output_item.done',
            response_id: 'resp_exact_1',
            output_index: 0,
            item: assistantItem,
          }));
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_exact_1', status: 'completed', output: [] },
          }));
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_exact_2', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `exact-output-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const consume = async (body: Record<string, unknown>): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: { url, webSocketUrl: `ws://127.0.0.1:${address.port}`, webSocketSessionKey: sessionKey, headers: {} },
        url,
        headers: {},
        body,
        format,
      })) {
        // Consume the complete response.
      }
    };

    try {
      await consume(firstBody);
      await consume(secondBody);

      expect(connectionCount).toBe(1);
      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toMatchObject({
        connection: 1,
        payload: { previous_response_id: 'resp_exact_1', input: [secondInput] },
      });
      expect(JSON.stringify(payloads[1].payload.input)).not.toContain('answer');
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not duplicate a completed function call in the next incremental suffix', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const format = new OpenAIResponsesFormat('gpt-test');
    const firstContent = userContent('write');
    const modelToolContent: Content = {
      role: 'model',
      parts: [{ functionCall: { callId: 'call_exact', name: 'write', args: { path: 'a.txt' } } }],
    };
    const toolResultContent: Content = {
      role: 'user',
      parts: [{ functionResponse: { callId: 'call_exact', name: 'write', response: { ok: true } } }],
    };
    const firstBody = format.encodeRequest({ contents: [firstContent] }, true) as Record<string, unknown>;
    const secondBody = format.encodeRequest({
      contents: [firstContent, modelToolContent, toolResultContent],
    }, true) as Record<string, unknown>;
    const functionResult = (secondBody.input as unknown[]).at(-1);
    const functionCall = {
      id: 'fc_exact',
      type: 'function_call',
      call_id: 'call_exact',
      name: 'write',
      arguments: '{"path":"a.txt"}',
    };
    const payloads: Record<string, unknown>[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push(payload);
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.output_item.done',
            response_id: 'resp_tool_1',
            output_index: 0,
            item: functionCall,
          }));
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_tool_1', status: 'completed', output: [] },
          }));
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_tool_2', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `tool-output-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const consume = async (body: Record<string, unknown>): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: { url, webSocketUrl: `ws://127.0.0.1:${address.port}`, webSocketSessionKey: sessionKey, headers: {} },
        url,
        headers: {},
        body,
        format,
      })) {
        // Consume the complete response.
      }
    };

    try {
      await consume(firstBody);
      await consume(secondBody);

      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toMatchObject({ previous_response_id: 'resp_tool_1', input: [functionResult] });
      expect((payloads[1].input as Array<Record<string, unknown>>).some((item) => item.type === 'function_call')).toBe(false);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('invalidates continuation after response.cancelled and full-replays the next request', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const firstInput = { role: 'user', content: [{ type: 'input_text', text: 'cancel me' }] };
    const secondInput = { role: 'user', content: [{ type: 'input_text', text: 'after cancel' }] };
    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        if (payloads.length === 1) {
          socket.send(JSON.stringify({
            type: 'response.cancelled',
            response: { id: 'resp_cancelled', status: 'cancelled' },
          }));
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_after_cancel', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `cancelled-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const consume = async (input: unknown[]): Promise<Array<{ error?: unknown }>> => {
      const chunks: Array<{ error?: unknown }> = [];
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: { url, webSocketUrl: `ws://127.0.0.1:${address.port}`, webSocketSessionKey: sessionKey, headers: {} },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
      })) chunks.push(chunk);
      return chunks;
    };

    try {
      const cancelled = await consume([firstInput]);
      expect(cancelled.some((chunk) => chunk.error !== undefined)).toBe(true);
      await consume([firstInput, secondInput]);

      expect(connectionCount).toBe(2);
      expect(payloads[1]).toMatchObject({
        connection: 2,
        payload: { input: [firstInput, secondInput] },
      });
      expect(payloads[1].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not poison the session lock when an awaiting request is aborted', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Record<string, unknown>[] = [];
    let resolveFirstReceived!: () => void;
    let completeFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => { resolveFirstReceived = resolve; });
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push(payload);
        if (payloads.length === 1) {
          completeFirst = () => socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_lock_1', status: 'completed', output: [] },
          }));
          resolveFirstReceived();
        } else {
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_lock_3', status: 'completed', output: [] },
          }));
        }
      });
    });

    const sessionKey = `lock-abort-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const input = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
    const consume = async (items: unknown[], signal?: AbortSignal): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: { url, webSocketUrl: `ws://127.0.0.1:${address.port}`, webSocketSessionKey: sessionKey, headers: {} },
        url,
        headers: {},
        body: { input: items },
        format: passthroughFormat,
        signal,
      })) {
        // Consume the complete response.
      }
    };

    try {
      const firstInput = input('first');
      const first = consume([firstInput]);
      await firstReceived;

      const waitingAbort = new AbortController();
      const waiting = consume([firstInput, input('cancelled waiter')], waitingAbort.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      waitingAbort.abort(new Error('queued abort'));
      await expect(waiting).rejects.toThrow('queued abort');

      completeFirst();
      await first;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          consume([firstInput, input('third')]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('third request remained blocked')), 1_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      expect(payloads).toHaveLength(2);
      expect(payloads[1]).toMatchObject({ previous_response_id: 'resp_lock_1', input: [input('third')] });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('reset closes retained sessions and forces the next request to full-replay', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    const payloads: Array<{ connection: number; payload: Record<string, unknown> }> = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const connection = ++connectionCount;
      socket.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        payloads.push({ connection, payload });
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: `resp_reset_${payloads.length}`, status: 'completed', output: [] },
        }));
      });
    });

    const sessionKey = `reset-${Date.now()}-${Math.random()}`;
    const url = `http://127.0.0.1:${address.port}`;
    const firstInput = { role: 'user', content: [{ type: 'input_text', text: 'first' }] };
    const secondInput = { role: 'user', content: [{ type: 'input_text', text: 'second' }] };
    const consume = async (input: unknown[]): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: { url, webSocketUrl: `ws://127.0.0.1:${address.port}`, webSocketSessionKey: sessionKey, headers: {} },
        url,
        headers: {},
        body: { input },
        format: passthroughFormat,
      })) {
        // Consume the complete response.
      }
    };

    try {
      await consume([firstInput]);
      resetOpenAIResponsesWebSocketSessions();
      await consume([firstInput, secondInput]);

      expect(connectionCount).toBe(2);
      expect(payloads[1]).toMatchObject({ connection: 2, payload: { input: [firstInput, secondInput] } });
      expect(payloads[1].payload.previous_response_id).toBeUndefined();
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fails instead of falling back to a direct socket when the proxy is unavailable', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('WebSocket test server did not expose a TCP port');

    let targetConnectionCount = 0;
    server.on('connection', () => { targetConnectionCount += 1; });

    const unavailableProxy = http.createServer();
    unavailableProxy.listen(0, '127.0.0.1');
    await once(unavailableProxy, 'listening');
    const proxyAddress = unavailableProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy test server did not expose a TCP port');
    await new Promise<void>((resolve, reject) => unavailableProxy.close((error) => error ? reject(error) : resolve()));

    const url = `http://127.0.0.1:${address.port}`;
    const consume = async (): Promise<void> => {
      for await (const _chunk of streamOpenAIResponsesWebSocket({
        endpoint: {
          url,
          webSocketUrl: `ws://127.0.0.1:${address.port}`,
          webSocketSessionKey: `unavailable-proxy-${Date.now()}-${Math.random()}`,
          headers: {},
          proxy: `http://127.0.0.1:${proxyAddress.port}`,
        },
        url,
        headers: {},
        body: { input: [] },
        format: passthroughFormat,
      })) {
        // Consume the generator until it rejects during connection setup.
      }
    };

    try {
      await expect(consume()).rejects.toThrow();
      expect(targetConnectionCount).toBe(0);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

  });
});
