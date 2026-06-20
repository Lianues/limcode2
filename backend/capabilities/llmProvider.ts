import { LlmEventType } from '../world/modules/llm/events';
import type { LlmDryRunOptions, LlmDryRunResult, LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart
} from '../../shared/protocol';
import type {
  ContentPart,
  LlmGenerationConfigRecord,
  LlmProviderConfigRecord,
  LlmProviderHeadersRecord,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmToolCallFormat,
  LlmUsageMetadataRecord,
  MessageContent
} from '../../shared/protocol';

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';

type MaybeProvider<T, TArg = void> = T | undefined | ((arg: TArg) => T | undefined | Promise<T | undefined>);

type UnifiedModule = typeof import('unified-llm-provider');
type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedLLMStreamChunk = import('unified-llm-provider').LLMStreamChunk;
type UnifiedFunctionDeclaration = import('unified-llm-provider').FunctionDeclaration;
type UnifiedModelCatalogEntry = import('unified-llm-provider').ModelCatalogEntry;
type UndiciModule = typeof import('undici');

interface UnifiedDryRunResult {
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  providerName: string;
  inputFormat: string;
  outputFormat: string;
  timestamp: number;
}

interface UnifiedDryRunCapable {
  dryRun(request: unknown, options?: { inputFormat?: string; outputFormat?: string; stream?: boolean; curl?: { includeApiKey?: boolean; prettyBody?: boolean } }): Promise<UnifiedDryRunResult>;
}

export interface LlmProviderOptions {
  settings: MaybeProvider<LlmProviderConfigRecord, LlmStartRequest | undefined>;
  headers?: MaybeProvider<Record<string, string>>;
}

/**
 * LLM capability 只维护 unified/Gemini-like 请求。
 * provider 真实 wire format 交给 unified-llm-provider 的 provider/format registry 处理。
 */
export function createLlmProviderCapability(options: LlmProviderOptions): LlmCapability {
  const controllers = new Map<string, AbortController>();

  return {
    start(request, emit) {
      controllers.get(request.id)?.abort(createAbortError(`Superseded LLM request: ${request.id}`));

      const controller = new AbortController();
      controllers.set(request.id, controller);

      void startLlmProvider(request, emit, options, controller.signal)
        .finally(() => {
          if (controllers.get(request.id) === controller) {
            controllers.delete(request.id);
          }
        });
    },
    dryRun(request, dryRunOptions) {
      return dryRunLlmProvider(request, options, dryRunOptions);
    },
    listModels(config) {
      return listLlmProviderModels(config, options);
    },
    abort(requestId) {
      const controller = controllers.get(requestId);
      if (!controller) return;
      controllers.delete(requestId);
      controller.abort(createAbortError(`Aborted LLM request: ${requestId}`));
    }
  };
}

export async function startLlmProvider(
  request: LlmStartRequest,
  emit: Emit,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<void> {
  try {
    const settings = normalizeSettings(await resolveMaybe(options.settings, request));
    emitLlmStarted(emit, request.id, resolveModelDisplayName(settings));
    if (!settings.apiKey) {
      emitLlmError(emit, request.id, '缺少 LLM API Key。请在全局设置的“渠道”页签里填写并保存。');
      return;
    }

    const unified = await importUnifiedLlmProvider();
    const registry = unified.createBootstrapExtensionRegistry();
    const proxy = normalizeOptionalString(settings.proxy);
    const proxyFetch = proxy ? await createUndiciFetch() : undefined;
    const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
    if (proxy) console.log(`[LimCode] LLM proxy enabled: ${proxy} (fetch=undici)`);
    const provider = unified.createLLMFromConfig({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      ...(headers ? { headers } : {}),
      ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
      ...(proxy ? { proxy, fetch: proxyFetch } : {})
    }, registry.llmProviders);

    let latestUsageMetadata: LlmUsageMetadataRecord | undefined;
    let firstStreamChunkAt: number | undefined;
    let firstStreamChunkMark: number | undefined;
    let streamTimingChunkCount = 0;
    let activeThoughtBlock: ActiveThoughtBlock | undefined;
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(request, settings.generationConfig), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    })) {
      const chunkAt = Date.now();
      const chunkMark = nowMonotonicMs();
      activeThoughtBlock = emitThoughtDeltas(request.id, activeThoughtBlock, chunk, chunkAt, emit);
      if (activeThoughtBlock && shouldCloseThoughtBlock(chunk)) activeThoughtBlock = finishThoughtBlock(request.id, activeThoughtBlock, chunkAt, emit);
      const chunkUsageMetadata = usageMetadataFromChunk(chunk);
      if (chunkUsageMetadata) latestUsageMetadata = mergeUsageMetadata(latestUsageMetadata, chunkUsageMetadata);
      if (hasStreamTimingChunk(chunk)) {
        firstStreamChunkAt ??= chunkAt;
        firstStreamChunkMark ??= chunkMark;
        streamTimingChunkCount += 1;
      }
      emitUnifiedChunk(request.id, chunk, emit);
    }

    const finishedAt = Date.now();
    const finishedMark = nowMonotonicMs();
    if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
    emit({
      type: LlmEventType.Done,
      payload: { requestId: request.id, ...createDoneTiming(firstStreamChunkAt, finishedAt, firstStreamChunkMark, finishedMark, streamTimingChunkCount), ...(latestUsageMetadata ? { usageMetadata: latestUsageMetadata } : {}) }
    });
  } catch (error) {
    if (isAbortError(error)) return;
    emitLlmError(emit, request.id, error instanceof Error ? error.message : String(error));
  }
}

export async function dryRunLlmProvider(request: LlmStartRequest, options: LlmProviderOptions, dryRunOptions: LlmDryRunOptions = {}): Promise<LlmDryRunResult> {
  const settings = normalizeSettings(await resolveMaybe(options.settings, request));
  if (!settings.apiKey) {
    throw new Error('缺少 LLM API Key，无法构建真实 provider 请求。');
  }

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(settings.proxy);
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const provider = unified.createLLMFromConfig({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(headers ? { headers } : {}),
    ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
    ...(proxy ? { proxy } : {})
  }, registry.llmProviders);

  const dryRun = (provider as unknown as Partial<UnifiedDryRunCapable>).dryRun;
  if (typeof dryRun !== 'function') {
    throw new Error('当前 unified-llm-provider 版本不支持 provider.dryRun，请更新依赖。');
  }

  const result = await dryRun.call(provider, toUnifiedRequest(request, settings.generationConfig), {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: true,
    curl: { includeApiKey: dryRunOptions.includeApiKey === true, prettyBody: true }
  });

  return {
    provider: settings.provider,
    model: settings.model,
    providerName: result.providerName,
    url: result.url,
    method: result.method,
    stream: result.stream,
    headers: result.headers,
    body: result.body,
    bodyText: result.bodyText,
    curl: result.curl,
    maskedCurl: unified.formatRequestAsCurl(result.url, result.headers, result.body, { includeApiKey: false, prettyBody: true }),
    inputFormat: result.inputFormat,
    outputFormat: result.outputFormat,
    generatedAt: result.timestamp,
    maskedSecrets: dryRunOptions.includeApiKey !== true
  };
}

export async function listLlmProviderModels(config: LlmProviderConfigRecord, options: LlmProviderOptions): Promise<LlmProviderModelRecord[]> {
  const settings = normalizeSettings(config);
  if (!settings.apiKey) {
    throw new Error('缺少 LLM API Key，无法获取模型列表。');
  }

  const unified = await importUnifiedLlmProvider();
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const result = await unified.listAvailableModels({
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(headers ? { headers } : {}),
    outputFormat: 'unified'
  });

  return result.models.map(modelCatalogEntryToRecord);
}

function modelCatalogEntryToRecord(model: UnifiedModelCatalogEntry): LlmProviderModelRecord {
  return {
    id: model.id,
    name: model.displayName || model.label || model.name || model.id,
    ...(model.createdAt ? { createdAt: model.createdAt } : {})
  };
}

function normalizeSettings(settings: LlmProviderConfigRecord | undefined): LlmProviderConfigRecord {
  const proxy = normalizeOptionalString(settings?.proxy);
  const headers = normalizeHeaders(settings?.headers);
  const generationConfig = settings?.generationConfig;
  const requestBody = settings?.requestBody;
  return {
    id: settings?.id?.trim() || 'llm-provider-config-default',
    name: settings?.name?.trim() || '默认渠道',
    provider: normalizeProvider(settings?.provider),
    baseUrl: settings?.baseUrl?.trim() || DEFAULT_LLM_BASE_URL,
    model: settings?.model?.trim() ?? '',
    models: settings?.models ?? [],
    apiKey: settings?.apiKey?.trim() ?? '',
    toolCallFormat: normalizeToolCallFormat(settings?.toolCallFormat),
    ...(proxy ? { proxy } : {}),
    ...(headers ? { headers } : {}),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {}),
    ...(nonEmptyRecord(requestBody) ? { requestBody } : {}),
    createdAt: settings?.createdAt ?? 0,
    updatedAt: settings?.updatedAt ?? 0
  };
}

function resolveModelDisplayName(settings: LlmProviderConfigRecord): string | undefined {
  const modelId = settings.model.trim();
  if (!modelId) return undefined;
  const catalogName = settings.models.find((model) => model.id === modelId)?.name.trim();
  return catalogName || modelId;
}

function normalizeProvider(provider: LlmProviderKind | undefined): LlmProviderKind {
  return provider === 'gemini' || provider === 'claude' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'deepseek'
    ? provider
    : 'openai-compatible';
}

function normalizeToolCallFormat(format: LlmToolCallFormat | undefined): LlmToolCallFormat {
  return format === 'function-call' ? format : 'function-call';
}

function normalizeHeaders(headers: unknown): LlmProviderHeadersRecord | undefined {
  if (!isRecord(headers)) return undefined;
  const result: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    result[key] = String(rawValue).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeHeaders(...records: Array<Record<string, string> | undefined>): LlmProviderHeadersRecord | undefined {
  const result: LlmProviderHeadersRecord = {};
  for (const record of records) {
    if (!record) continue;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = rawKey.trim();
      if (!key) continue;
      const existingKey = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (existingKey && existingKey !== key) delete result[existingKey];
      result[key] = rawValue;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function nonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function toUnifiedRequest(request: LlmStartRequest, generationConfig?: LlmGenerationConfigRecord): UnifiedLLMRequest {
  return {
    contents: request.contents.map(toUnifiedContent),
    ...(request.systemInstruction ? { systemInstruction: { parts: request.systemInstruction.parts.map(toUnifiedPart) } } : {}),
    ...(request.tools.length === 0 ? {} : { tools: [{ functionDeclarations: request.tools.map(toUnifiedFunctionDeclaration) }] }),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {})
  };
}

function toUnifiedContent(content: MessageContent): UnifiedContent {
  return {
    role: content.role === 'model' ? 'model' : 'user',
    parts: content.parts.map(toUnifiedPart)
  };
}

function toUnifiedPart(part: ContentPart): UnifiedPart {
  if (isTextPart(part)) {
    return {
      text: part.text,
      ...(part.thought !== undefined ? { thought: part.thought } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    };
  }
  if (isFunctionCallPart(part)) {
    return {
      functionCall: { name: part.functionCall.name, args: asRecord(part.functionCall.args), ...(part.id ? { callId: part.id } : {}) },
      // Gemini 会校验带工具调用的 thoughtSignature；作为 part 同层级字段透传给 provider。
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    };
  }
  if (isFunctionResponsePart(part)) {
    return {
      functionResponse: { name: part.functionResponse.name, response: asRecord(part.functionResponse.response), ...(part.id ? { callId: part.id } : {}) }
    };
  }
  if (isInlineDataPart(part)) return { inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data } };
  if (isFileDataPart(part)) {
    // unified-llm-provider 当前统一 Part 没有 fileData；先作为文本占位保留语义。
    return { text: `[fileData:${part.fileData.mimeType ?? 'unknown'}:${part.fileData.uri}]` };
  }
  return assertNever(part);
}

function toUnifiedFunctionDeclaration(tool: ToolSchema): UnifiedFunctionDeclaration {
  const parameters = isFunctionParameters(tool.parameters)
    ? tool.parameters
    : { type: 'object' as const, properties: {} };
  return {
    name: tool.name,
    description: tool.description,
    parameters
  };
}

function emitUnifiedChunk(requestId: string, chunk: UnifiedLLMStreamChunk, emit: Emit): void {
  const text = chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
  if (text) emit({ type: LlmEventType.Delta, payload: { requestId, text } });

  const calls = [
    ...(chunk.functionCalls ?? []),
    ...(chunk.partsDelta ?? []).filter(isUnifiedFunctionCallPart)
  ].map((part, index) => {
    const thoughtSignature = thoughtSignatureFromPart(part);
    return {
      id: part.functionCall.callId ?? `tool_call_${index}`,
      name: part.functionCall.name,
      argsJson: stringifyJson(part.functionCall.args ?? {}),
      ...(thoughtSignature ? { thoughtSignature } : {})
    };
  });

  if (calls.length > 0) {
    emit({ type: LlmEventType.ToolCall, payload: { requestId, calls } });
  }
}

interface LlmDoneTiming {
  createdAt: number;
  streamOutputDurationMs?: number;
}

function createDoneTiming(
  firstChunkAt: number | undefined,
  finishedAt = Date.now(),
  firstChunkMark?: number,
  finishedMark?: number,
  streamChunkCount = 0
): LlmDoneTiming {
  const rawDurationMs = firstChunkAt === undefined
    ? undefined
    : firstChunkMark !== undefined && finishedMark !== undefined
      ? finishedMark - firstChunkMark
      : finishedAt - firstChunkAt;

  const streamOutputDurationMs = streamChunkCount >= 3 && rawDurationMs !== undefined && rawDurationMs >= 2
    ? Math.round(rawDurationMs)
    : undefined;

  return {
    createdAt: firstChunkAt ?? finishedAt,
    ...(streamOutputDurationMs !== undefined ? { streamOutputDurationMs } : {})
  };
}

function nowMonotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function usageMetadataFromChunk(chunk: UnifiedLLMStreamChunk): LlmUsageMetadataRecord | undefined {
  const cleaned = stripUndefined(chunk.usageMetadata);
  return isRecord(cleaned) && Object.keys(cleaned).length > 0
    ? cleaned as LlmUsageMetadataRecord
    : undefined;
}

function mergeUsageMetadata(
  previous: LlmUsageMetadataRecord | undefined,
  next: LlmUsageMetadataRecord
): LlmUsageMetadataRecord {
  if (!previous) return next;
  return { ...previous, ...next };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    result[key] = stripUndefined(child);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasStreamTimingChunk(chunk: UnifiedLLMStreamChunk): boolean {
  return hasStreamOutput(chunk) || hasThoughtOutput(chunk);
}

function hasThoughtOutput(chunk: UnifiedLLMStreamChunk): boolean {
  return (chunk.partsDelta ?? []).some((part) => isUnifiedThoughtTextPart(part) && !!part.text);
}

function hasStreamOutput(chunk: UnifiedLLMStreamChunk): boolean {
  if (chunk.textDelta || visibleTextFromParts(chunk.partsDelta ?? [])) return true;
  if ((chunk.functionCalls?.length ?? 0) > 0) return true;
  return (chunk.partsDelta ?? []).some(isUnifiedFunctionCallPart);
}

function visibleTextFromParts(parts: UnifiedPart[]): string {
  return parts.map((part) => 'text' in part && (part as { thought?: unknown }).thought !== true ? part.text ?? '' : '').join('');
}

interface ActiveThoughtBlock {
  startedAt: number;
  thoughtSignature?: string;
}

function emitThoughtDeltas(requestId: string, current: ActiveThoughtBlock | undefined, chunk: UnifiedLLMStreamChunk, at: number, emit: Emit): ActiveThoughtBlock | undefined {
  let block = current;
  for (const part of chunk.partsDelta ?? []) {
    if (!isUnifiedThoughtTextPart(part)) continue;
    const text = part.text ?? '';
    if (!text) continue;
    block ??= { startedAt: at };
    const signature = thoughtSignatureFromPart(part);
    if (signature) block.thoughtSignature = signature;
    emit({
      type: LlmEventType.ThoughtDelta,
      payload: {
        requestId,
        text,
        ...(signature ? { thoughtSignature: signature } : {})
      }
    });
  }
  return block;
}

function shouldCloseThoughtBlock(chunk: UnifiedLLMStreamChunk): boolean {
  return !!chunk.finishReason || hasStreamOutput(chunk);
}

function finishThoughtBlock(requestId: string, block: ActiveThoughtBlock, finishedAt: number, emit: Emit): undefined {
  emit({
    type: LlmEventType.ThoughtDone,
    payload: {
      requestId,
      thoughtDurationMs: Math.max(0, finishedAt - block.startedAt),
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
    }
  });
  return undefined;
}

function isUnifiedThoughtTextPart(part: UnifiedPart): part is UnifiedPart & { text?: string; thought?: unknown } {
  return 'text' in part && (part as { thought?: unknown }).thought === true;
}

function isUnifiedFunctionCallPart(part: UnifiedPart): part is Extract<UnifiedPart, { functionCall: unknown }> {
  return 'functionCall' in part;
}

function thoughtSignatureFromPart(part: UnifiedPart): string | undefined {
  const value = (part as { thoughtSignature?: unknown }).thoughtSignature;
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function isFunctionParameters(value: unknown): value is UnifiedFunctionDeclaration['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { type?: unknown }).type === 'object';
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function resolveMaybe<T, TArg = void>(value: MaybeProvider<T, TArg>, arg?: TArg): Promise<T | undefined> {
  if (typeof value === 'function') return (value as (input: TArg | undefined) => T | undefined | Promise<T | undefined>)(arg);
  return value;
}

async function importUnifiedLlmProvider(): Promise<UnifiedModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UnifiedModule>;
  return dynamicImport('unified-llm-provider');
}

async function createUndiciFetch(): Promise<typeof fetch> {
  const undici = await importUndici();
  // VS Code Extension Host 的 global fetch 可能不是 undici 实现，会忽略 dispatcher。
  // 这里仅在用户显式配置 LLM proxy 时指定 undici.fetch；ProxyAgent/requestTls 仍由 unified-llm-provider@0.1.3 维护。
  return undici.fetch as unknown as typeof fetch;
}

async function importUndici(): Promise<UndiciModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UndiciModule>;
  return dynamicImport('undici');
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
function emitLlmStarted(emit: Emit, requestId: string, model: string | undefined): void {
  emit({ type: LlmEventType.Started, payload: { requestId, ...(model ? { model } : {}) } });
}

function emitLlmError(emit: Emit, requestId: string, message: string): void {
  emit({ type: LlmEventType.Error, payload: { requestId, message } });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
