/**
 * 响应后处理模块
 *
 * 统一处理流式和非流式响应。
 * 内部使用 FormatAdapter 做格式解码，内置 SSE 解析处理流式数据。
 */

import type { LLMRawErrorInfo, LLMResponse, LLMStreamChunk } from '../types.js';
import type { FormatAdapter } from './formats/types.js';

// ============ 通用错误透传 ============

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

function stringifyError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function readResponseBody(res: Response): Promise<{ bodyText: string; rawBody?: unknown }> {
  const bodyText = await res.text();
  const parsed = tryParseJson(bodyText);
  return parsed.ok ? { bodyText, rawBody: parsed.value } : { bodyText };
}

function createErrorResponse(error: LLMRawErrorInfo): LLMResponse {
  return {
    content: { role: 'model', parts: [{ text: '' }] },
    error,
    rawResponse: error.rawBody ?? error.bodyText,
  };
}

function createErrorStreamChunk(error: LLMRawErrorInfo): LLMStreamChunk {
  return {
    error,
    rawChunk: error.rawChunk ?? error.rawBody ?? error.bodyText ?? error.data,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hasErrorLikeEvent(event: unknown): boolean {
  if (typeof event !== 'string') return false;
  const normalized = event.toLowerCase();
  return normalized.includes('error')
    || normalized.includes('failed')
    || normalized.includes('incomplete');
}

function hasErrorLikeType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const normalized = type.toLowerCase();
  return normalized === 'error'
    || normalized.endsWith('_error')
    || normalized.includes('error')
    || normalized.includes('failed')
    || normalized.includes('incomplete');
}

function hasErrorLikeStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const normalized = status.toLowerCase();
  return normalized === 'error'
    || normalized === 'failed'
    || normalized === 'incomplete'
    || normalized === 'cancelled';
}

function hasNonNullErrorField(payload: Record<string, unknown>): boolean {
  return 'error' in payload && payload.error !== null && payload.error !== undefined;
}

function isProviderErrorPayload(payload: unknown, event?: string): boolean {
  if (hasErrorLikeEvent(event)) return true;
  if (!isPlainObject(payload)) return false;

  if (hasNonNullErrorField(payload)) return true;
  if (hasErrorLikeEvent(payload.event)) return true;
  if (hasErrorLikeType(payload.type)) return true;
  if (hasErrorLikeStatus(payload.status) && ('message' in payload || 'last_error' in payload || 'incomplete_details' in payload || hasNonNullErrorField(payload))) return true;

  const response = payload.response;
  if (isPlainObject(response)) {
    if (hasNonNullErrorField(response)) return true;
    if (hasErrorLikeStatus(response.status) && ('message' in response || 'last_error' in response || 'incomplete_details' in response || hasNonNullErrorField(response))) return true;
  }

  return false;
}

// ============ 非流式 ============

/** 处理非流式响应 */
export async function processResponse(
  res: Response,
  format: FormatAdapter,
): Promise<LLMResponse> {
  const headers = headersToRecord(res.headers);
  const { bodyText, rawBody } = await readResponseBody(res);
  const rawResponse = rawBody ?? bodyText;

  if (!res.ok) {
    return createErrorResponse({
      kind: 'http_error',
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyText,
      ...(rawBody !== undefined ? { rawBody } : {}),
    });
  }

  if (isProviderErrorPayload(rawResponse)) {
    return createErrorResponse({
      kind: 'response_error',
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyText,
      rawBody: rawResponse,
    });
  }

  try {
    return format.decodeResponse(rawResponse);
  } catch (err) {
    return createErrorResponse({
      kind: 'decode_error',
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyText,
      rawBody: rawResponse,
      message: stringifyError(err),
    });
  }
}

// ============ 流式 ============

/** 处理流式响应（SSE 解析 + 逐块解码） */
export async function* processStreamResponse(
  res: Response,
  format: FormatAdapter,
): AsyncGenerator<LLMStreamChunk> {
  const headers = headersToRecord(res.headers);

  if (!res.ok) {
    const { bodyText, rawBody } = await readResponseBody(res);
    yield createErrorStreamChunk({
      kind: 'http_error',
      status: res.status,
      statusText: res.statusText,
      headers,
      bodyText,
      ...(rawBody !== undefined ? { rawBody } : {}),
    });
    return;
  }

  const state = format.createStreamState();
  try {
    for await (const sse of parseSSE(res)) {
      const parsed = tryParseJson(sse.data);
      if (!parsed.ok) {
        yield createErrorStreamChunk({
          kind: 'stream_parse_error',
          status: res.status,
          statusText: res.statusText,
          headers,
          event: sse.event,
          data: sse.data,
          bodyText: sse.data,
          message: `SSE data 不是 JSON: ${sse.data}`,
          rawChunk: sse.data,
        });
        continue;
      }

      const payload = isPlainObject(parsed.value)
        ? { ...parsed.value, ...(sse.event ? { event: sse.event } : {}) }
        : parsed.value;

      if (isProviderErrorPayload(payload, sse.event)) {
        yield createErrorStreamChunk({
          kind: 'stream_error',
          status: res.status,
          statusText: res.statusText,
          headers,
          event: sse.event ?? stringField(isPlainObject(payload) ? payload.event : undefined),
          data: sse.data,
          rawChunk: payload,
        });
        continue;
      }

      try {
        yield format.decodeStreamChunk(payload, state);
      } catch (err) {
        yield createErrorStreamChunk({
          kind: 'decode_error',
          status: res.status,
          statusText: res.statusText,
          headers,
          event: sse.event,
          data: sse.data,
          rawChunk: payload,
          message: stringifyError(err),
        });
      }
    }
  } catch (err) {
    yield createErrorStreamChunk({
      kind: 'stream_read_error',
      status: res.status,
      statusText: res.statusText,
      headers,
      message: stringifyError(err),
    });
  }
}

// ============ SSE 解析 ============

export interface SSEChunk {
  event?: string;
  data: string;
}

/**
 * 从 fetch Response 中解析 SSE 流，逐条 yield 包含 data 字段的原始字符串的对象。
 * 遇到 `data: [DONE]` 时自动结束。
 */
async function* parseSSE(response: Response): AsyncGenerator<SSEChunk> {
  const body = response.body;
  if (!body) throw new Error('Response body is null');

  const reader = (body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];
  let chunksRead = 0;

  const dispatch = (): SSEChunk | 'done' | undefined => {
    const data = dataLines.join('\n');
    const event = currentEvent;
    dataLines = [];
    currentEvent = undefined;

    if (data === '[DONE]') return 'done';
    return data ? { event, data } : undefined;
  };

  const handleLine = (rawLine: string): SSEChunk | 'done' | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined; // SSE comment / heartbeat

    const colonIndex = line.indexOf(':');
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : '';
    // SSE 规范：冒号后可选一个空格。Anthropic 兼容端点可能发送 `data:{...}`，
    // 也可能发送 `data: {...}`，两种都必须接受。
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      const event = value.trim();
      currentEvent = event || undefined;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunksRead++;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const chunk = handleLine(line);
        if (chunk === 'done') return;
        if (chunk) yield chunk;
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        const chunk = handleLine(line);
        if (chunk === 'done') return;
        if (chunk) yield chunk;
      }
    }

    const chunk = dispatch();
    if (chunk !== 'done' && chunk) yield chunk;
  } catch (err) {
    // 为连接中断错误补充上下文（已接收块数帮助判断是建连失败还是中途断开）
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`SSE 流读取中断（已接收 ${chunksRead} 个数据块）: ${msg}`);
    (wrapped as any).cause = err;
    throw wrapped;
  } finally {
    reader.releaseLock();
  }
}
