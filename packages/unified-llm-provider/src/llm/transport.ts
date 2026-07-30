/**
 * HTTP 请求模块
 *
 * 通用的 HTTP 发送逻辑，不含任何格式转换。
 * 支持流式和非流式请求，通过 streamUrl 字段区分 URL。
 */

import type { FetchLike, LLMDebugHooks, LLMProxyOption, LLMTransportMode } from '../config/types.js';

export interface EndpointConfig {
  /** 非流式请求 URL */
  url: string;
  /** 流式请求 URL（与非流式不同时使用，如 Gemini），默认同 url */
  streamUrl?: string;
  /** compact / compaction 请求 URL（可选） */
  compactUrl?: string;
  /** WebSocket URL（OpenAI Responses WebSocket mode）。 */
  webSocketUrl?: string;
  /** 传输模式。默认 HTTP；OpenAI Responses 可选 WebSocket。 */
  transport?: LLMTransportMode;
  /** WebSocket continuation 会话隔离 key。 */
  webSocketSessionKey?: string;
  /** 请求头（不含 Content-Type，内部自动加） */
  headers: Record<string, string>;
  /** 自定义 fetch 实现 */
  fetch?: FetchLike;
  /** 调试钩子 */
  debug?: LLMDebugHooks;
  /** 显式指定 HTTP/HTTPS 代理 */
  proxy?: LLMProxyOption;
  /** 自定义 User-Agent */
  userAgent?: string;
}

export interface BuiltRequestTransport {
  url: string;
  headers: Record<string, string>;
}

type ProxyAgentOptions = {
  uri: string;
  headers?: Record<string, string>;
  requestTls?: { rejectUnauthorized?: boolean };
};

type ProxyAgentConstructor = new (options: string | ProxyAgentOptions) => unknown;

const proxyDispatcherCache = new Map<string, unknown>();
let proxyAgentConstructorPromise: Promise<ProxyAgentConstructor> | undefined;

interface NormalizedProxyOption {
  uri: string;
  headers?: Record<string, string>;
  cacheKey: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function callDebugHookSafely<T>(hook: ((event: T) => void | Promise<void>) | undefined, event: T): Promise<void> {
  if (!hook) return;
  try {
    await hook(event);
  } catch {
    // 调试钩子不应影响主流程
  }
}

function settleFetchWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(errorFromAbortSignal(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(errorFromAbortSignal(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(finishResolve, finishReject);
  });
}

function errorFromAbortSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : 'LLM request aborted');
  error.name = reason && typeof reason === 'object' && 'name' in reason && typeof (reason as { name?: unknown }).name === 'string'
    ? (reason as { name: string }).name
    : 'AbortError';
  return error;
}
function normalizeProxyOption(proxy?: LLMProxyOption): NormalizedProxyOption | undefined {
  if (!proxy) return undefined;

  if (typeof proxy === 'string') {
    const uri = proxy.trim();
    return uri ? { uri, cacheKey: JSON.stringify({ uri }) } : undefined;
  }

  const uri = proxy.url.trim();
  if (!uri) return undefined;
  const headers = proxy.headers && Object.keys(proxy.headers).length > 0 ? proxy.headers : undefined;
  const sortedHeaders = headers
    ? Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)))
    : undefined;

  return {
    uri,
    headers,
    cacheKey: JSON.stringify({ uri, headers: sortedHeaders }),
  };
}

async function loadProxyAgentConstructor(): Promise<ProxyAgentConstructor> {
  if (!proxyAgentConstructorPromise) {
    proxyAgentConstructorPromise = import('undici')
      .then(mod => mod.ProxyAgent as unknown as ProxyAgentConstructor);
  }
  return proxyAgentConstructorPromise;
}

export async function getProxyDispatcher(proxy?: LLMProxyOption): Promise<unknown | undefined> {
  const normalized = normalizeProxyOption(proxy);
  if (!normalized) return undefined;

  const cached = proxyDispatcherCache.get(normalized.cacheKey);
  if (cached) return cached;

  const ProxyAgent = await loadProxyAgentConstructor();
  // 仅在显式 proxy 配置存在时使用 ProxyAgent。
  // 调试代理/抓包代理常会替换 HTTPS 证书；这里对目标请求关闭证书校验，避免 Node/undici 拒绝握手。
  const dispatcher = new ProxyAgent({
    uri: normalized.uri,
    ...(normalized.headers ? { headers: normalized.headers } : {}),
    requestTls: { rejectUnauthorized: false },
  });

  proxyDispatcherCache.set(normalized.cacheKey, dispatcher);
  return dispatcher;
}

export function buildRequestTransport(
  endpoint: EndpointConfig,
  stream: boolean,
): BuiltRequestTransport {
  const url = stream ? (endpoint.streamUrl ?? endpoint.url) : endpoint.url;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': endpoint.userAgent ?? 'unified-llm-provider',
    ...endpoint.headers,
  };
  return { url, headers };
}

export async function sendRequest(
  endpoint: EndpointConfig,
  body: unknown,
  stream: boolean,
  signal?: AbortSignal,
  _loggingDir?: string,
): Promise<Response> {
  const { url, headers } = buildRequestTransport(endpoint, stream);

  await callDebugHookSafely(endpoint.debug?.onRequest, {
    url,
    stream,
    headers,
    body,
  });

  const fetchImpl = endpoint.fetch ?? fetch;
  const requestSignal = signal;
  const init: RequestInit & { dispatcher?: unknown } = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: requestSignal,
  };

  let res: Response;
  try {
    const dispatcher = await getProxyDispatcher(endpoint.proxy);
    if (dispatcher) init.dispatcher = dispatcher;
    res = await settleFetchWithSignal(fetchImpl(url, init), requestSignal);
  } catch (err) {
    await callDebugHookSafely(endpoint.debug?.onResponse, {
      url,
      stream,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    throw err;
  }

  if (stream) {
    return wrapStreamForDebug(res, url, endpoint.debug);
  }

  void res.clone().text().then(
    async (text) => {
      await callDebugHookSafely(endpoint.debug?.onResponse, {
        url,
        stream: false,
        status: res.status,
        headers: headersToRecord(res.headers),
        bodyText: text,
      });
    },
    async (err) => {
      await callDebugHookSafely(endpoint.debug?.onResponse, {
        url,
        stream: false,
        status: res.status,
        headers: headersToRecord(res.headers),
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    },
  );

  return res;
}

function wrapStreamForDebug(res: Response, url: string, debug?: LLMDebugHooks): Response {
  const body = res.body;
  if (!body || !debug?.onResponse) return res;

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const reader = body.getReader();

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await callDebugHookSafely(debug.onResponse, {
            url,
            stream: true,
            status: res.status,
            headers: headersToRecord(res.headers),
            bodyText: chunks.join(''),
          });
          controller.close();
          return;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
        if (debug?.onStreamChunk) {
          await callDebugHookSafely(debug.onStreamChunk, {
            url, chunk: chunks[chunks.length - 1], accumulated: chunks.join(''),
          });
        }
      } catch (err) {
        await callDebugHookSafely(debug.onResponse, {
          url,
          stream: true,
          status: res.status,
          headers: headersToRecord(res.headers),
          bodyText: chunks.join(''),
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        controller.error(err);
      }
    },
    async cancel(reason) {
      await callDebugHookSafely(debug.onResponse, {
        url,
        stream: true,
        status: res.status,
        headers: headersToRecord(res.headers),
        bodyText: chunks.join(''),
        error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      });
      return reader.cancel(reason);
    },
  });

  return new Response(wrapped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
