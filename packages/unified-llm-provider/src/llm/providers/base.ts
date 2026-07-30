/**
 * LLM Provider 组合器
 */

import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../../types/index.js';
import type { FormatId, UnifiedSignatureMode } from '../convert.js';
import { decodeRequestFromFormat, encodeCompactResponseToFormat, encodeResponseToFormat, encodeStreamChunkToFormat, normalizeFormatId } from '../convert.js';
import { isCompactFormatAdapter, type FormatAdapter } from '../formats/types.js';
import { detectLLMRequestSignatureRepresentation } from '../../signatures/normalize.js';
import { buildRequestTransport, sendRequest, type EndpointConfig } from '../transport.js';
import type { LLMProxyOption } from '../../config/types.js';
import { processResponse, processStreamResponse } from '../response.js';
import { streamOpenAIResponsesWebSocket } from '../websocket-openai-responses.js';
import type { FormatRegistry } from '../../registry/formats.js';
import { bodyToCurlPayload, formatRequestAsCurl, type CurlFormatOptions } from '../debug-utils.js';
import type { LLMCompactResponse } from '../../types/llm.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMergeObjects(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      result[key] = [...current, ...value];
    } else if (Array.isArray(current) && value !== null && typeof value === 'object') {
      result[key] = [...current, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function mergeRequestBody(baseBody: unknown, overrideBody?: Record<string, unknown>): unknown {
  if (!overrideBody) return baseBody;
  if (!isPlainObject(baseBody)) return overrideBody;
  return deepMergeObjects(baseBody, overrideBody);
}

export interface LLMCallOptions {
  signal?: AbortSignal;
  /** 输入使用的格式，默认 unified */
  inputFormat?: FormatId;
  /** 输出想要的格式，默认跟随 inputFormat */
  outputFormat?: FormatId;
  /** 自定义格式注册表 */
  formatRegistry?: Pick<FormatRegistry, 'get'>;
  /** 本次调用显式指定 HTTP/HTTPS 代理；传空字符串可临时禁用 provider 默认代理 */
  proxy?: LLMProxyOption;
}

export interface LLMCompactOptions extends LLMCallOptions {
  /** 仅 compact 调用使用的额外请求体字段，会深合并到 compact 编码结果中。 */
  requestBody?: Record<string, unknown>;
}

export interface LLMDryRunOptions extends LLMCallOptions {
  /**
   * true 表示按 chatStream 路径构建流式请求；
   * false 表示按 chat 路径构建非流式请求；
   * 默认 true。
   */
  stream?: boolean;
  /** curl 格式化选项。dryRun 默认 includeApiKey=false、prettyBody=true。 */
  curl?: CurlFormatOptions;
}

export interface LLMDryRunResult {
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  providerName: string;
  inputFormat: FormatId;
  outputFormat: FormatId;
  timestamp: number;
}

interface BuiltProviderRequest {
  inputFormat: FormatId;
  outputFormat: FormatId;
  canonicalRequest: LLMRequest;
  endpoint: EndpointConfig;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface LLMProviderLike {
  setLogging(logsDir: string): void;
  chat<TOutput = LLMResponse>(request: unknown, options?: LLMCallOptions): Promise<TOutput>;
  chatStream<TOutput = LLMStreamChunk>(request: unknown, options?: LLMCallOptions): AsyncGenerator<TOutput>;
  dryRun(request: unknown, options?: LLMDryRunOptions): Promise<LLMDryRunResult>;
  compact?<TOutput = LLMCompactResponse>(request: unknown, options?: LLMCompactOptions): Promise<TOutput>;
  compactDryRun?(request: unknown, options?: LLMCompactOptions & { curl?: CurlFormatOptions }): Promise<LLMDryRunResult>;
  patchRequestBodyOverrides?(patch: Record<string, unknown>): void;
  removeRequestBodyOverridePaths?(...paths: string[]): void;
  removeRequestBodyOverrideKeys?(...keys: string[]): void;
  readonly name: string;
}

export class LLMProvider implements LLMProviderLike {
  private providerName: string;
  private loggingDir?: string;
  private runtimeOverrides?: Record<string, unknown>;

  constructor(
    private format: FormatAdapter,
    private endpoint: EndpointConfig,
    providerName?: string,
    private staticOverrides?: Record<string, unknown>,
    private providerFormat: FormatId = 'unified',
  ) {
    this.providerName = providerName ?? 'LLMProvider';
  }

  private get effectiveOverrides(): Record<string, unknown> | undefined {
    if (!this.runtimeOverrides && !this.staticOverrides) return undefined;
    if (!this.runtimeOverrides) return this.staticOverrides;
    if (!this.staticOverrides) return this.runtimeOverrides;
    // 优先级：统一请求体编码结果 < config.requestBody(static) < 运行时 patchRequestBodyOverrides(runtime)。
    return deepMergeObjects(this.staticOverrides, this.runtimeOverrides);
  }

  private resolveInputFormat(options?: LLMCallOptions): FormatId {
    return options?.inputFormat ?? 'unified';
  }

  private resolveOutputFormat(inputFormat: FormatId, options?: LLMCallOptions): FormatId {
    return options?.outputFormat ?? inputFormat;
  }

  private resolveUnifiedSignatureMode(request: LLMRequest, inputFormat: FormatId, outputFormat: FormatId): UnifiedSignatureMode | undefined {
    if (normalizeFormatId(outputFormat) !== 'unified') return undefined;
    if (normalizeFormatId(inputFormat) === 'unified') {
      return detectLLMRequestSignatureRepresentation(request) === 'object' ? 'object' : 'string';
    }
    return 'string';
  }

  private resolveEndpoint(options?: LLMCallOptions): EndpointConfig {
    return options && 'proxy' in options ? { ...this.endpoint, proxy: options.proxy } : this.endpoint;
  }

  private buildProviderRequest(request: unknown, options: LLMCallOptions | undefined, stream: boolean): BuiltProviderRequest {
    const inputFormat = this.resolveInputFormat(options);
    const outputFormat = this.resolveOutputFormat(inputFormat, options);
    const canonicalRequest = decodeRequestFromFormat(request, {
      format: inputFormat,
      registry: options?.formatRegistry,
    });

    const body = mergeRequestBody(this.format.encodeRequest(canonicalRequest, stream), this.effectiveOverrides);
    const endpoint = this.resolveEndpoint(options);
    const { url, headers } = buildRequestTransport(endpoint, stream);
    return {
      inputFormat,
      outputFormat,
      canonicalRequest,
      endpoint,
      url,
      headers,
      body,
    };
  }

  private buildCompactProviderRequest(request: unknown, options: LLMCompactOptions | undefined): BuiltProviderRequest {
    if (!isCompactFormatAdapter(this.format)) {
      throw new Error(`${this.providerName} 不支持 compact 端点`);
    }

    const inputFormat = this.resolveInputFormat(options);
    const outputFormat = this.resolveOutputFormat(inputFormat, options);
    const canonicalRequest = decodeRequestFromFormat(request, {
      format: inputFormat,
      registry: options?.formatRegistry,
    });

    if (options?.requestBody && 'previous_response_id' in options.requestBody) {
      throw new Error('stateless compact 不支持 previous_response_id；请通过 input 传入完整上下文窗口');
    }

    const body = mergeRequestBody(this.format.encodeCompactRequest(canonicalRequest), options?.requestBody);
    if (isPlainObject(body) && 'previous_response_id' in body) {
      throw new Error('stateless compact 不支持 previous_response_id；请通过 input 传入完整上下文窗口');
    }

    const endpoint = this.resolveEndpoint(options);
    if (!endpoint.compactUrl) {
      throw new Error(`${this.providerName} 未配置 compactUrl`);
    }
    const compactEndpoint: EndpointConfig = { ...endpoint, url: endpoint.compactUrl };
    const { url, headers } = buildRequestTransport(compactEndpoint, false);

    return {
      inputFormat,
      outputFormat,
      canonicalRequest,
      endpoint: compactEndpoint,
      url,
      headers,
      body,
    };
  }


  setLogging(logsDir: string): void {
    this.loggingDir = logsDir;
  }

  async dryRun(request: unknown, options?: LLMDryRunOptions): Promise<LLMDryRunResult> {
    const stream = options?.stream ?? true;
    const built = this.buildProviderRequest(request, options, stream);
    const curlOptions: CurlFormatOptions = {
      includeApiKey: false,
      prettyBody: true,
      ...options?.curl,
    };
    return {
      url: built.url,
      method: 'POST',
      stream,
      headers: built.headers,
      body: built.body,
      bodyText: bodyToCurlPayload(built.body),
      curl: formatRequestAsCurl(built.url, built.headers, built.body, curlOptions),
      providerName: this.providerName,
      inputFormat: built.inputFormat,
      outputFormat: built.outputFormat,
      timestamp: Date.now(),
    };
  }


  async compactDryRun(request: unknown, options?: LLMCompactOptions & { curl?: CurlFormatOptions }): Promise<LLMDryRunResult> {
    const built = this.buildCompactProviderRequest(request, options);
    const curlOptions: CurlFormatOptions = {
      includeApiKey: false,
      prettyBody: true,
      ...options?.curl,
    };
    return {
      url: built.url,
      method: 'POST',
      stream: false,
      headers: built.headers,
      body: built.body,
      bodyText: bodyToCurlPayload(built.body),
      curl: formatRequestAsCurl(built.url, built.headers, built.body, curlOptions),
      providerName: this.providerName,
      inputFormat: built.inputFormat,
      outputFormat: built.outputFormat,
      timestamp: Date.now(),
    };
  }

  async compact<TOutput = LLMCompactResponse>(request: unknown, options?: LLMCompactOptions): Promise<TOutput> {
    const built = this.buildCompactProviderRequest(request, options);
    const res = await sendRequest(built.endpoint, built.body, false, options?.signal, this.loggingDir);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM Compact API 错误 (${res.status}): ${text}`);
    }

    const raw = await res.json();
    if (!isCompactFormatAdapter(this.format)) {
      throw new Error(`${this.providerName} 不支持 compact 端点`);
    }
    const compactResponse = this.format.decodeCompactResponse(raw);

    return encodeCompactResponseToFormat(compactResponse, {
      format: built.outputFormat,
      sourceFormat: this.providerFormat,
      registry: options?.formatRegistry,
    }) as TOutput;
  }


  async chat<TOutput = LLMResponse>(request: unknown, options?: LLMCallOptions): Promise<TOutput> {
    const built = this.buildProviderRequest(request, options, false);
    const res = await sendRequest(built.endpoint, built.body, false, options?.signal, this.loggingDir);
    const canonicalResponse = await processResponse(res, this.format);

    return encodeResponseToFormat(canonicalResponse, {
      format: built.outputFormat,
      sourceFormat: this.providerFormat,
      registry: options?.formatRegistry,
      signatureMode: this.resolveUnifiedSignatureMode(built.canonicalRequest, built.inputFormat, built.outputFormat),
    }) as TOutput;
  }

  async *chatStream<TOutput = LLMStreamChunk>(request: unknown, options?: LLMCallOptions): AsyncGenerator<TOutput> {
    const built = this.buildProviderRequest(request, options, true);

    if (built.endpoint.transport === 'websocket' && this.providerFormat === 'openai-responses') {
      for await (const chunk of streamOpenAIResponsesWebSocket({
        endpoint: built.endpoint,
        url: built.url,
        headers: built.headers,
        body: built.body,
        format: this.format,
        signal: options?.signal,
      })) {
        yield encodeStreamChunkToFormat(chunk, {
          format: built.outputFormat,
          sourceFormat: this.providerFormat,
          registry: options?.formatRegistry,
          signatureMode: this.resolveUnifiedSignatureMode(built.canonicalRequest, built.inputFormat, built.outputFormat),
        }) as TOutput;
      }
      return;
    }

    const res = await sendRequest(built.endpoint, built.body, true, options?.signal, this.loggingDir);

    for await (const chunk of processStreamResponse(res, this.format)) {
      yield encodeStreamChunkToFormat(chunk, {
        format: built.outputFormat,
        sourceFormat: this.providerFormat,
        registry: options?.formatRegistry,
        signatureMode: this.resolveUnifiedSignatureMode(built.canonicalRequest, built.inputFormat, built.outputFormat),
      }) as TOutput;
    }
  }

  patchRequestBodyOverrides(patch: Record<string, unknown>): void {
    this.runtimeOverrides = this.runtimeOverrides
      ? deepMergeObjects(this.runtimeOverrides, patch)
      : { ...patch };
  }

  removeRequestBodyOverrideKeys(...keys: string[]): void {
    if (!this.runtimeOverrides) return;
    for (const key of keys) {
      delete this.runtimeOverrides[key];
    }
    if (Object.keys(this.runtimeOverrides).length === 0) {
      this.runtimeOverrides = undefined;
    }
  }

  removeRequestBodyOverridePaths(...paths: string[]): void {
    if (!this.runtimeOverrides) return;
    for (const path of paths) {
      const segments = path.split('.');
      if (segments.length === 1) {
        delete this.runtimeOverrides[segments[0]];
        continue;
      }

      let obj: Record<string, unknown> = this.runtimeOverrides;
      const parents: Array<{ obj: Record<string, unknown>; key: string }> = [];
      let valid = true;
      for (let i = 0; i < segments.length - 1; i++) {
        parents.push({ obj, key: segments[i] });
        const child = obj[segments[i]];
        if (!isPlainObject(child)) {
          valid = false;
          break;
        }
        obj = child;
      }

      if (!valid) continue;

      delete obj[segments[segments.length - 1]];
      for (let i = parents.length - 1; i >= 0; i--) {
        const { obj: parent, key } = parents[i];
        const child = parent[key];
        if (isPlainObject(child) && Object.keys(child).length === 0) {
          delete parent[key];
        } else {
          break;
        }
      }
    }

    if (Object.keys(this.runtimeOverrides).length === 0) {
      this.runtimeOverrides = undefined;
    }
  }

  get name(): string {
    return this.providerName;
  }
}
