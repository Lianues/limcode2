/**
 * 调试工具模块
 */
import type { LLMRequestDebugEvent, LLMResponseDebugEvent, LLMDebugHooks } from '../config/types.js';

function expandHomePath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    const os = require('os') as typeof import('os');
    const home = os.homedir();
    if (!home) throw new Error('无法解析用户主目录');
    if (filePath === '~') return home;
    return `${home}${filePath.slice(1)}`;
  }
  return filePath;
}


export interface RequestTrace {
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: string;
  curl: string;
  timestamp: number;
}

export interface ResponseTrace {
  url: string;
  stream: boolean;
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
  error?: string;
  timestamp: number;
}

export interface DebugTraceStore {
  request?: RequestTrace;
  response?: ResponseTrace;
  streamChunks?: string[];
}

export function bodyToCurlPayload(body: unknown, pretty = true): string {
  if (body === null || body === undefined) return '';
  return JSON.stringify(body, null, pretty ? 2 : undefined) ?? '';
}

function quoteShellSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function headersToCurlFlags(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `-H ${quoteShellSingle(`${key}: ${value}`)}`)
    .join(' \\\n  ');
}

export interface CurlFormatOptions {
  /** 是否在 curl 命令中保留可见 API Key，默认 true */
  includeApiKey?: boolean;
  /** 是否缩进 body，默认 true */
  prettyBody?: boolean;
}

export function formatRequestAsCurl(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options?: CurlFormatOptions,
): string {
  const includeApiKey = options?.includeApiKey !== false;
  const prettyBody = options?.prettyBody !== false;
  const bodyStr = body === null || body === undefined ? '' : bodyToCurlPayload(body, prettyBody);
  const headersToInclude = includeApiKey ? headers : maskApiKeyHeaders(headers);
  const headerFlags = headersToCurlFlags(headersToInclude);
  const bodyFlag = bodyStr ? `-d ${quoteShellSingle(bodyStr)}` : "-d ''";
  const lines: string[] = [`curl -X POST ${quoteShellSingle(url)}`];
  if (headerFlags) lines.push(`  ${headerFlags}`);
  lines.push(`  ${bodyFlag}`);
  return lines.join(' \\\n');
}

function maskApiKeyHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitiveKeys = new Set([
    'x-api-key', 'x-goog-api-key', 'authorization', 'api-key', 'openai-key',
  ]);
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      masked[key] = '***';
    }
  }
  return masked;
}

export function formatResponseForLog(event: LLMResponseDebugEvent): string {
  const lines: string[] = [];
  lines.push(`HTTP ${event.status ?? '???'}`);
  if (event.error) {
    lines.push(`ERROR: ${event.error}`);
  }
  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
      if (key.toLowerCase() === 'content-type' || key.toLowerCase() === 'content-length' || key.toLowerCase().startsWith('x-')) {
        lines.push(`  ${key}: ${value}`);
      }
    }
  }
  if (event.bodyText !== undefined) {
    lines.push('');
    lines.push(event.bodyText.length > 2000 ? `${event.bodyText.slice(0, 2000)}... (truncated)` : event.bodyText);
  }
  return lines.join('\n');
}

export function createDebugTraceStore(): DebugTraceStore {
  return {};
}

export function createTraceDebugHooks(store: DebugTraceStore, curlOptions?: CurlFormatOptions): LLMDebugHooks {
  return {
    onRequest(event: LLMRequestDebugEvent): void {
      store.request = {
        url: event.url,
        method: 'POST',
        stream: event.stream,
        headers: event.headers,
        body: bodyToCurlPayload(event.body),
        curl: formatRequestAsCurl(event.url, event.headers, event.body, curlOptions),
        timestamp: Date.now(),
      };
    },
    onResponse(event: LLMResponseDebugEvent): void {
      store.response = {
        url: event.url,
        stream: event.stream,
        status: event.status,
        headers: event.headers,
        bodyText: event.bodyText,
        error: event.error,
        timestamp: Date.now(),
      };
    },
    onStreamChunk(event: { chunk: string; accumulated: string }): void {
      if (!store.streamChunks) {
        store.streamChunks = [];
      }
      store.streamChunks.push(event.chunk);
      (store.response as any) ??= {};
      (store.response as any).bodyText = event.accumulated;
    },
  };
}


export function createFileDebugHooks(filePath: string, curlOptions?: CurlFormatOptions): LLMDebugHooks {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const resolved = expandHomePath(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return {
    onRequest(event: LLMRequestDebugEvent): void {
      const lines = [
        `=== REQUEST ${new Date().toISOString()} ===`,
        formatRequestAsCurl(event.url, event.headers, event.body, curlOptions),
        '',
      ];
      fs.appendFileSync(resolved, lines.join('\n'));
    },
    onResponse(event: LLMResponseDebugEvent): void {
      const lines = [
        `=== RESPONSE ${new Date().toISOString()} ===`,
        formatResponseForLog(event),
        '',
      ];
      fs.appendFileSync(resolved, lines.join('\n'));
    },
  };
}

export function createSplitFileDebugHooks(logDir: string, curlOptions?: CurlFormatOptions): LLMDebugHooks {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const resolvedDir = expandHomePath(logDir);
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const ts = Date.now();
  const tsStr = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const reqPath = path.join(resolvedDir, `req_${tsStr}.log`);
  const respPath = path.join(resolvedDir, `resp_${tsStr}.log`);

  return {
    onRequest(event: LLMRequestDebugEvent): void {
      const lines = [
        `=== REQUEST ${new Date().toISOString()} ===`,
        formatRequestAsCurl(event.url, event.headers, event.body, curlOptions),
        '',
      ];
      fs.appendFileSync(reqPath, lines.join('\n'));
    },
    onResponse(event: LLMResponseDebugEvent): void {
      const lines = [
        `=== RESPONSE ${new Date().toISOString()} ===`,
        formatResponseForLog(event),
        '',
      ];
      fs.appendFileSync(respPath, lines.join('\n'));
    },
    onStreamChunk(event: { chunk: string; accumulated: string }): void {
      fs.appendFileSync(respPath, event.chunk);
    },
  };
}
