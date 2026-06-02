import { LlmEventType } from '../world/modules/llm/events';
import type { LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart
} from '../../shared/protocol';
import type { ContentPart, LlmProviderKind, LlmSettingsRecord, LlmUsageMetadataRecord, MessageContent } from '../../shared/protocol';

export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';

type MaybeProvider<T> = T | undefined | (() => T | undefined | Promise<T | undefined>);

type UnifiedModule = typeof import('unified-llm-provider');
type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedLLMStreamChunk = import('unified-llm-provider').LLMStreamChunk;
type UnifiedFunctionDeclaration = import('unified-llm-provider').FunctionDeclaration;
type UndiciModule = typeof import('undici');

export interface LlmProviderOptions {
  settings: MaybeProvider<LlmSettingsRecord>;
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
    const settings = normalizeSettings(await resolveMaybe(options.settings));
    if (!settings.apiKey) {
      emitLlmError(emit, request.id, '缺少 LLM API Key。请在 Webview 顶部“LLM 设置”里填写并保存。');
      return;
    }

    const unified = await importUnifiedLlmProvider();
    const registry = unified.createBootstrapExtensionRegistry();
    const proxy = normalizeOptionalString(settings.proxy);
    const proxyFetch = proxy ? await createUndiciFetch() : undefined;
    if (proxy) console.log(`[LimCode] LLM proxy enabled: ${proxy} (fetch=undici)`);
    const provider = unified.createLLMFromConfig({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      headers: await resolveMaybe(options.headers),
      ...(proxy ? { proxy, fetch: proxyFetch } : {})
    }, registry.llmProviders);

    let latestUsageMetadata: LlmUsageMetadataRecord | undefined;
    let firstStreamChunkAt: number | undefined;
    let lastStreamChunkAt: number | undefined;
    let activeThoughtBlock: ActiveThoughtBlock | undefined;
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(request, request.model?.temperature ?? settings.temperature), {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    })) {
      const chunkAt = Date.now();
      activeThoughtBlock = emitThoughtDeltas(request.id, activeThoughtBlock, chunk, chunkAt, emit);
      if (activeThoughtBlock && shouldCloseThoughtBlock(chunk)) activeThoughtBlock = finishThoughtBlock(request.id, activeThoughtBlock, chunkAt, emit);
      const chunkUsageMetadata = usageMetadataFromChunk(chunk);
      if (chunkUsageMetadata) latestUsageMetadata = mergeUsageMetadata(latestUsageMetadata, chunkUsageMetadata);
      if (hasStreamOutput(chunk)) {
        firstStreamChunkAt ??= chunkAt;
        lastStreamChunkAt = chunkAt;
      }
      emitUnifiedChunk(request.id, chunk, emit);
    }

    const finishedAt = Date.now();
    if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
    emit({
      type: LlmEventType.Done,
      payload: { requestId: request.id, ...createDoneTiming(firstStreamChunkAt, lastStreamChunkAt, finishedAt), ...(latestUsageMetadata ? { usageMetadata: latestUsageMetadata } : {}) }
    });
  } catch (error) {
    if (isAbortError(error)) return;
    emitLlmError(emit, request.id, error instanceof Error ? error.message : String(error));
  }
}

function normalizeSettings(settings: LlmSettingsRecord | undefined): LlmSettingsRecord {
  return {
    provider: normalizeProvider(settings?.provider),
    baseUrl: settings?.baseUrl?.trim() || DEFAULT_LLM_BASE_URL,
    model: settings?.model?.trim() || DEFAULT_LLM_MODEL,
    apiKey: settings?.apiKey?.trim() ?? '',
    temperature: settings?.temperature,
    ...(normalizeOptionalString(settings?.proxy) ? { proxy: normalizeOptionalString(settings?.proxy) } : {})
  };
}

function normalizeProvider(provider: LlmProviderKind | undefined): LlmProviderKind {
  return provider === 'gemini' || provider === 'claude' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'deepseek'
    ? provider
    : 'deepseek';
}

function toUnifiedRequest(request: LlmStartRequest, temperature?: number): UnifiedLLMRequest {
  return {
    contents: request.contents.map(toUnifiedContent),
    ...(request.systemInstruction ? { systemInstruction: { parts: request.systemInstruction.parts.map(toUnifiedPart) } } : {}),
    ...(request.tools.length === 0 ? {} : { tools: [{ functionDeclarations: request.tools.map(toUnifiedFunctionDeclaration) }] }),
    ...(temperature === undefined ? {} : { generationConfig: { temperature } })
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

function createDoneTiming(firstChunkAt: number | undefined, lastChunkAt: number | undefined, finishedAt = Date.now()): LlmDoneTiming {
  return {
    createdAt: firstChunkAt ?? finishedAt,
    ...(firstChunkAt !== undefined && lastChunkAt !== undefined ? { streamOutputDurationMs: Math.max(0, lastChunkAt - firstChunkAt) } : {})
  };
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

async function resolveMaybe<T>(value: MaybeProvider<T>): Promise<T | undefined> {
  if (typeof value === 'function') return (value as () => T | undefined | Promise<T | undefined>)();
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
function emitLlmError(emit: Emit, requestId: string, message: string): void {
  emit({ type: LlmEventType.Error, payload: { requestId, message } });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
