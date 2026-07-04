/**
 * LimCode - 代理 Fetch 实现
 *
 * 支持通过 HTTP 代理发起 HTTPS 请求（CONNECT 隧道方式）。
 * 返回标准 fetch 签名，兼容 unified-llm-provider 的 fetch 参数。
 * 返回的 Response 拥有流式 ReadableStream body，支持 SSE 流式输出。
 */

import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import { URL } from 'url';

const USER_AGENT = 'LimCode';
const DEFAULT_TIMEOUT = 120_000;

/**
 * 创建一个支持代理的 fetch 函数。
 *
 * @param proxyUrl 代理地址（可选），如 http://127.0.0.1:7890
 * @returns 兼容 fetch 签名的函数；proxyUrl 为空时返回原生 fetch
 */
export function createProxyFetch(proxyUrl?: string): typeof fetch {
  if (!proxyUrl) return fetch;

  const proxyParsed = new URL(proxyUrl);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const targetUrl = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const method = init?.method || 'GET';
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((value, key) => { headers[key] = value; });
      } else if (Array.isArray(rawHeaders)) {
        for (const [key, value] of rawHeaders) { headers[key] = value; }
      } else {
        for (const [key, value] of Object.entries(rawHeaders)) { headers[key] = String(value); }
      }
    }
    const body = init?.body;
    const bodyText = typeof body === 'string' ? body : '';
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) throw new Error('Request cancelled');

    // 建立 CONNECT 隧道
    const socket = await connectThroughProxy(targetUrl, proxyParsed, signal);

    // 发送 HTTP 请求
    const bodyBuffer = Buffer.from(bodyText, 'utf8');
    const requestLine = `${method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
    const headerLines = [
      `Host: ${targetUrl.hostname}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${bodyBuffer.length}`,
      'Connection: close',
      '', ''
    ].join('\r\n');

    socket.write(requestLine + headerLines);
    if (bodyBuffer.length > 0) socket.write(bodyBuffer);

    // 读取响应 headers，然后将 body 作为 ReadableStream 返回
    return readResponse(socket, signal);
  };
}

/**
 * 建立 CONNECT 隧道并返回底层 socket。
 */
function connectThroughProxy(
  targetUrl: URL,
  proxyParsed: URL,
  signal?: AbortSignal
): Promise<tls.TLSSocket | import('net').Socket> {
  return new Promise((resolve, reject) => {
    const targetHost = targetUrl.hostname;
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80);
    const isHttps = targetUrl.protocol === 'https:';
    let settled = false;
    let proxyReq: http.ClientRequest | null = null;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finishResolve = (sock: tls.TLSSocket | import('net').Socket) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(sock);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      proxyReq?.destroy();
      finishReject(new Error('Request cancelled'));
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    proxyReq = http.request({
      hostname: proxyParsed.hostname,
      port: proxyParsed.port || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      timeout: DEFAULT_TIMEOUT
    });

    proxyReq.on('connect', (res: http.IncomingMessage, socket: import('net').Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finishReject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      if (isHttps) {
        const tlsSocket = tls.connect({
          socket,
          servername: targetHost,
          rejectUnauthorized: false
        }, () => finishResolve(tlsSocket));
        tlsSocket.on('error', (error: Error) => finishReject(new Error(`TLS error: ${error.message}`)));
      } else {
        finishResolve(socket);
      }
    });

    proxyReq.on('error', (error: Error) => finishReject(new Error(`Proxy request failed: ${error.message}`)));
    proxyReq.on('timeout', () => { proxyReq?.destroy(); finishReject(new Error('Proxy request timeout')); });
    proxyReq.end();
  });
}

/**
 * 从 socket 读取 HTTP 响应：先解析 headers，然后将 body 数据流式写入 ReadableStream。
 */
function readResponse(
  socket: tls.TLSSocket | import('net').Socket,
  signal?: AbortSignal
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let statusCode = 0;
    let statusText = '';
    let responseHeaders: Record<string, string> = {};
    let isChunked = false;
    let contentLength = -1;
    let bodyStarted = false;
    let remainingAfterHeaders = Buffer.alloc(0);

    // chunked 解码状态
    let chunkedBuffer = Buffer.alloc(0);
    let chunkedDone = false;
    let nonChunkedReceived = 0;

    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let streamClosed = false;
    let responseResolved = false;

    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      try { controller?.close(); } catch { /* already closed */ }
    };

    const errorStream = (error: Error) => {
      if (streamClosed) return;
      streamClosed = true;
      try { controller?.error(error); } catch { /* already closed */ }
    };

    const rejectBeforeHeaders = (error: Error) => {
      if (responseResolved) return;
      responseResolved = true;
      try { socket.destroy(); } catch { /* already closed */ }
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    };

    const onAbort = () => {
      socket.destroy();
      const error = new Error('Request cancelled');
      if (!headersParsed) rejectBeforeHeaders(error);
      else errorStream(error);
    };

    if (signal) {
      if (signal.aborted) { onAbort(); reject(new Error('Request cancelled')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const processBodyData = (data: Buffer) => {
      if (streamClosed) return;

      if (isChunked) {
        chunkedBuffer = Buffer.concat([chunkedBuffer, data]);
        const { decoded, remaining, done } = decodeChunkedStream(chunkedBuffer);
        chunkedBuffer = Buffer.from(remaining);
        if (decoded.length > 0) {
          controller?.enqueue(Buffer.from(decoded, 'utf8'));
        }
        if (done) {
          chunkedDone = true;
          socket.end();
          closeStream();
        }
      } else if (contentLength >= 0) {
        const remaining = contentLength - nonChunkedReceived;
        const chunk = data.length <= remaining ? data : data.subarray(0, remaining);
        if (chunk.length > 0) {
          nonChunkedReceived += chunk.length;
          controller?.enqueue(new Uint8Array(chunk));
        }
        if (nonChunkedReceived >= contentLength) {
          socket.end();
          closeStream();
        }
      } else {
        // 无 content-length，持续读取直到连接关闭
        controller?.enqueue(new Uint8Array(data));
      }
    };

    const onData = (chunk: Buffer) => {
      if (signal?.aborted || streamClosed) return;

      if (!headersParsed) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEndMarker = Buffer.from('\r\n\r\n');
        const headerEnd = headerBuffer.indexOf(headerEndMarker);

        if (headerEnd === -1) return;

        // 解析 headers
        const headerPart = headerBuffer.subarray(0, headerEnd).toString('utf8');
        const lines = headerPart.split('\r\n');
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+) ?(.*)/);
        statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        statusText = statusMatch ? (statusMatch[2] || '') : '';

        for (const line of lines.slice(1)) {
          const colonIndex = line.indexOf(':');
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim().toLowerCase();
            const value = line.substring(colonIndex + 1).trim();
            responseHeaders[key] = value;
            if (key === 'transfer-encoding' && value.includes('chunked')) {
              isChunked = true;
            } else if (key === 'content-length') {
              contentLength = parseInt(value, 10);
            }
          }
        }

        headersParsed = true;
        const bodyRemainder = headerBuffer.subarray(headerEnd + 4);
        headerBuffer = Buffer.alloc(0);

        // 创建 ReadableStream 作为 Response body
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            controller = ctrl;
            // 如果 headers 之后已经有 body 数据，立即处理
            if (bodyRemainder.length > 0) {
              processBodyData(bodyRemainder);
            }
          },
          cancel() {
            socket.destroy();
          }
        });

        const responseInit: ResponseInit = {
          status: statusCode,
          statusText: statusText || undefined
        };
        const responseHeadersInit = new Headers();
        for (const [key, value] of Object.entries(responseHeaders)) {
          try { responseHeadersInit.set(key, value); } catch { /* skip invalid header */ }
        }

        // 检查是否是错误状态码
        bodyStarted = true;
        responseResolved = true;
        resolve(new Response(stream, { ...responseInit, headers: responseHeadersInit }));

        // 如果剩余数据已经包含完整响应（如错误响应），可能已关闭
        if (!streamClosed && bodyRemainder.length === 0 && contentLength === 0) {
          closeStream();
        }
      } else if (bodyStarted) {
        processBodyData(chunk);
      } else {
        // headers 之后的初始数据（在 start 回调之前到达）
        remainingAfterHeaders = Buffer.concat([remainingAfterHeaders, chunk]);
      }
    };

    const onEnd = () => {
      if (signal?.aborted) return;
      if (streamClosed) return;
      if (!headersParsed) {
        rejectBeforeHeaders(new Error('Connection closed before headers received'));
        return;
      }
      closeStream();
    };

    const onClose = () => {
      if (signal?.aborted) return;
      if (!headersParsed) {
        rejectBeforeHeaders(new Error('Connection closed before headers received'));
        return;
      }
      if (!streamClosed) closeStream();
    };

    const onError = (err: Error) => {
      if (signal?.aborted) return;
      if (!headersParsed) {
        rejectBeforeHeaders(err);
      } else {
        errorStream(err);
      }
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    socket.on('error', onError);
  });
}

/**
 * 解码 chunked transfer encoding 数据流。
 * 返回已解码的字符串、剩余未处理的 buffer、以及是否遇到结束标记。
 */
function decodeChunkedStream(data: Buffer): { decoded: string; remaining: Buffer; done: boolean } {
  let decoded = '';
  let offset = 0;
  let done = false;

  while (offset < data.length) {
    // 查找 chunk size 行的结束 (\r\n)
    let sizeEnd = -1;
    for (let i = offset; i < data.length - 1; i++) {
      if (data[i] === 0x0d && data[i + 1] === 0x0a) {
        sizeEnd = i;
        break;
      }
    }

    if (sizeEnd === -1) break;

    // 解析 chunk size（十六进制）
    const sizeLine = data.subarray(offset, sizeEnd).toString('ascii').trim();
    const chunkSize = parseInt(sizeLine, 16);

    if (isNaN(chunkSize)) {
      offset = sizeEnd + 2;
      continue;
    }

    if (chunkSize === 0) {
      done = true;
      break;
    }

    // 计算 chunk 数据的位置
    const chunkDataStart = sizeEnd + 2;
    const chunkDataEnd = chunkDataStart + chunkSize;

    if (chunkDataEnd + 2 > data.length) {
      // 数据不完整，保留从 offset 开始的所有数据
      break;
    }

    // 提取并解码 chunk 数据
    decoded += data.subarray(chunkDataStart, chunkDataEnd).toString('utf8');

    // 移动到下一个 chunk（跳过 \r\n）
    offset = chunkDataEnd + 2;
  }

  return {
    decoded,
    remaining: data.subarray(offset),
    done
  };
}
