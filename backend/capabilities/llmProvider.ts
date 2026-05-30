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
import type { ContentPart, LlmProviderKind, LlmSettingsRecord, MessageContent } from '../../shared/protocol';

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
  return {
    start(request, emit) {
      void startLlmProvider(request, emit, options);
    }
  };
}

export async function startLlmProvider(
  request: LlmStartRequest,
  emit: Emit,
  options: LlmProviderOptions
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

    let didEmitDone = false;
    let firstStreamChunkAt: number | undefined;
    let lastStreamChunkAt: number | undefined;
    let activeThoughtBlock: ActiveThoughtBlock | undefined;
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(request, request.model?.temperature ?? settings.temperature), {
      inputFormat: 'unified',
      outputFormat: 'unified'
    })) {
      const chunkAt = Date.now();
      activeThoughtBlock = collectThoughtBlock(activeThoughtBlock, chunk, chunkAt);
      if (activeThoughtBlock && shouldCloseThoughtBlock(chunk)) activeThoughtBlock = flushThoughtBlock(request.id, activeThoughtBlock, chunkAt, emit);
      if (hasStreamOutput(chunk)) {
        firstStreamChunkAt ??= chunkAt;
        lastStreamChunkAt = chunkAt;
      }
      didEmitDone = emitUnifiedChunk(request.id, chunk, emit, createDoneTiming(firstStreamChunkAt, lastStreamChunkAt, chunkAt)) || didEmitDone;
    }

    if (!didEmitDone) {
      const finishedAt = Date.now();
      if (activeThoughtBlock) flushThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
      emit({ type: LlmEventType.Done, payload: { requestId: request.id, ...createDoneTiming(firstStreamChunkAt, lastStreamChunkAt, finishedAt) } });
    }
  } catch (error) {
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
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(part.thoughtSignatures ? { thoughtSignatures: part.thoughtSignatures } : {})
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

function emitUnifiedChunk(requestId: string, chunk: UnifiedLLMStreamChunk, emit: Emit, doneTiming: LlmDoneTiming): boolean {
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

  if (chunk.finishReason) {
    emit({ type: LlmEventType.Done, payload: { requestId, ...doneTiming } });
    return true;
  }

  return false;
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
  text: string;
  thoughtSignature?: string;
  thoughtSignatures?: Record<string, string | undefined>;
}

function collectThoughtBlock(current: ActiveThoughtBlock | undefined, chunk: UnifiedLLMStreamChunk, at: number): ActiveThoughtBlock | undefined {
  let block = current;
  for (const part of chunk.partsDelta ?? []) {
    if (!isUnifiedThoughtTextPart(part)) continue;
    const text = part.text ?? '';
    if (!text) continue;
    block ??= { startedAt: at, text: '' };
    block.text += text;
    const signature = thoughtSignatureFromPart(part);
    if (signature) block.thoughtSignature = signature;
    const signatures = thoughtSignaturesFromPart(part);
    if (signatures) block.thoughtSignatures = { ...block.thoughtSignatures, ...signatures };
  }
  return block;
}

function shouldCloseThoughtBlock(chunk: UnifiedLLMStreamChunk): boolean {
  return !!chunk.finishReason || hasStreamOutput(chunk);
}

function flushThoughtBlock(requestId: string, block: ActiveThoughtBlock, finishedAt: number, emit: Emit): undefined {
  emit({
    type: LlmEventType.Thought,
    payload: {
      requestId,
      text: block.text,
      thoughtDurationMs: Math.max(0, finishedAt - block.startedAt),
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
      ...(block.thoughtSignatures ? { thoughtSignatures: block.thoughtSignatures } : {})
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
  const record = part as { thoughtSignature?: unknown; thoughtSignatures?: Record<string, unknown> };
  if (typeof record.thoughtSignature === 'string') return record.thoughtSignature;
  if (record.thoughtSignatures) {
    const gemini = record.thoughtSignatures.gemini;
    if (typeof gemini === 'string') return gemini;
    return Object.values(record.thoughtSignatures).find((value): value is string => typeof value === 'string');
  }
  return undefined;
}

function thoughtSignaturesFromPart(part: UnifiedPart): Record<string, string | undefined> | undefined {
  const value = (part as { thoughtSignatures?: unknown }).thoughtSignatures;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string | undefined> : undefined;
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

function emitLlmError(emit: Emit, requestId: string, message: string): void {
  emit({ type: LlmEventType.Error, payload: { requestId, message } });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
