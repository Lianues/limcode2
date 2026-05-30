import { LlmEventType } from '../world/modules/llm/events';
import type { LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';
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
    const provider = unified.createLLMFromConfig({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      headers: await resolveMaybe(options.headers)
    }, registry.llmProviders);

    let didEmitDone = false;
    for await (const chunk of provider.chatStream<UnifiedLLMStreamChunk>(toUnifiedRequest(request, request.model?.temperature ?? settings.temperature), {
      inputFormat: 'unified',
      outputFormat: 'unified'
    })) {
      didEmitDone = emitUnifiedChunk(request.id, chunk, emit) || didEmitDone;
    }

    if (!didEmitDone) {
      emit({ type: LlmEventType.Done, payload: { requestId: request.id } });
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
    temperature: settings?.temperature
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
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'functionCall':
      return { functionCall: { name: part.name, args: asRecord(part.args), callId: part.id } };
    case 'functionResponse':
      return { functionResponse: { name: part.name, response: asRecord(part.response), callId: part.id } };
    case 'inlineData':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    case 'fileData':
      // unified-llm-provider 当前统一 Part 没有 fileData；先作为文本占位保留语义。
      return { text: `[fileData:${part.mimeType ?? 'unknown'}:${part.uri}]` };
    default:
      return assertNever(part);
  }
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

function emitUnifiedChunk(requestId: string, chunk: UnifiedLLMStreamChunk, emit: Emit): boolean {
  const text = chunk.textDelta ?? textFromParts(chunk.partsDelta ?? []);
  if (text) emit({ type: LlmEventType.Delta, payload: { requestId, text } });

  const calls = [
    ...(chunk.functionCalls ?? []),
    ...(chunk.partsDelta ?? []).filter(isUnifiedFunctionCallPart)
  ].map((part, index) => ({
    id: part.functionCall.callId ?? `tool_call_${index}`,
    name: part.functionCall.name,
    argsJson: stringifyJson(part.functionCall.args ?? {})
  }));

  if (calls.length > 0) {
    emit({ type: LlmEventType.ToolCall, payload: { requestId, calls } });
  }

  if (chunk.finishReason) {
    emit({ type: LlmEventType.Done, payload: { requestId } });
    return true;
  }

  return false;
}

function textFromParts(parts: UnifiedPart[]): string {
  return parts.map((part) => 'text' in part ? part.text ?? '' : '').join('');
}

function isUnifiedFunctionCallPart(part: UnifiedPart): part is Extract<UnifiedPart, { functionCall: unknown }> {
  return 'functionCall' in part;
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

async function resolveMaybe<T>(value: MaybeProvider<T>): Promise<T | undefined> {
  if (typeof value === 'function') return (value as () => T | undefined | Promise<T | undefined>)();
  return value;
}

async function importUnifiedLlmProvider(): Promise<UnifiedModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UnifiedModule>;
  return dynamicImport('unified-llm-provider');
}

function emitLlmError(emit: Emit, requestId: string, message: string): void {
  emit({ type: LlmEventType.Error, payload: { requestId, message } });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
