import type { LLMCompactResponse, LLMRequest, LLMResponse, LLMStreamChunk, Content, Part, FunctionDeclaration, ProviderContextItem, InlineDataPart } from '../types/index.js';
import { isProviderContextPart, isTextPart } from '../types/index.js';
import { normalizeCallId } from './formats/tool-call-ids.js';
import { normalizeLLMRequestThoughtSignatures, normalizeLLMResponseThoughtSignatures, normalizeLLMStreamChunkThoughtSignatures, detectLLMRequestSignatureRepresentation } from '../signatures/normalize.js';
import { serializeLLMRequestThoughtSignatures, serializeLLMResponseThoughtSignatures, serializeLLMStreamChunkThoughtSignatures } from '../signatures/serialize.js';
import { createBuiltinFormatRegistry, type FormatFactoryOptions, type FormatRegistry } from '../registry/formats.js';
import { normalizeThinkingLevel, normalizeReasoningMode } from './formats/thinking-level.js';
import { isCompactFormatAdapter } from './formats/types.js';
import { isSupportedToolResponseMimeType, isToolResponseDocumentMimeType, parseBase64DataUrl } from './vision.js';

export type UnifiedFormatId = 'unified';
export type WireFormatId = 'gemini' | 'claude' | 'openai-compatible' | 'openai-responses' | 'deepseek';
export type FormatId = UnifiedFormatId | WireFormatId | 'canonical' | 'gemini-like';
export type UnifiedSignatureMode = 'string' | 'object' | 'preserve';

export interface FormatTransformOptions extends FormatFactoryOptions {
  registry?: Pick<FormatRegistry, 'get'>;
  signatureMode?: UnifiedSignatureMode;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveFormatRegistry(registry?: Pick<FormatRegistry, 'get'>): Pick<FormatRegistry, 'get'> {
  return registry ?? createBuiltinFormatRegistry();
}

export function normalizeFormatId(format: FormatId): UnifiedFormatId | WireFormatId {
  switch (format) {
    case 'canonical':
    case 'gemini-like':
      return 'unified';
    default:
      return format;
  }
}

function normalizeWireFormatId(format: WireFormatId): Exclude<WireFormatId, 'deepseek'> {
  return format === 'deepseek' ? 'openai-compatible' : format;
}

export function getSignatureProviderForFormat(format: FormatId): string | undefined {
  switch (normalizeFormatId(format)) {
    case 'unified':
    case 'gemini':
      return 'gemini';
    case 'claude':
      return 'claude';
    case 'openai-compatible':
      return 'openai-compatible';
    case 'openai-responses':
      return 'openai-responses';
    case 'deepseek':
      return 'openai-compatible';
    default:
      return undefined;
  }
}

function createAdapter(
  format: WireFormatId,
  registry: Pick<FormatRegistry, 'get'>,
  options?: FormatFactoryOptions,
) {
  const normalized = normalizeWireFormatId(format);
  const factory = registry.get(normalized);
  if (!factory) {
    throw new Error(`未注册的 format: ${format}`);
  }
  return factory(options);
}

function parseJSONValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function utf8ToBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}


function toRecord(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (Array.isArray(value)) return { items: value };
  if (typeof value === 'string') return { content: value };
  if (value === undefined) return {};
  return { value };
}

function cloneRawItem<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}


function createOpenAIResponsesProviderContext(item: any, endpoint = 'responses'): ProviderContextItem {
  return {
    provider: 'openai',
    format: 'openai-responses',
    endpoint,
    itemType: typeof item?.type === 'string' ? item.type : 'unknown',
    id: typeof item?.id === 'string' ? item.id : undefined,
    encryptedContent: typeof item?.encrypted_content === 'string' ? item.encrypted_content : undefined,
    rawItem: cloneRawItem(item),
  };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined);
}

function getRawErrorPassthroughPayload(value: {
  error?: { rawChunk?: unknown; rawBody?: unknown; bodyText?: string; data?: string };
  rawResponse?: unknown;
  rawChunk?: unknown;
}): unknown {
  return firstDefined(value.rawResponse, value.rawChunk, value.error?.rawChunk, value.error?.rawBody, value.error?.bodyText, value.error?.data, { error: value.error });
}

function hasRawErrorLikeEvent(event: unknown): boolean {
  if (typeof event !== 'string') return false;
  const normalized = event.toLowerCase();
  return normalized.includes('error')
    || normalized.includes('failed')
    || normalized.includes('incomplete');
}

function hasRawErrorLikeType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const normalized = type.toLowerCase();
  return normalized === 'error'
    || normalized.endsWith('_error')
    || normalized.includes('error')
    || normalized.includes('failed')
    || normalized.includes('incomplete');
}

function hasRawErrorLikeStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const normalized = status.toLowerCase();
  return normalized === 'error'
    || normalized === 'failed'
    || normalized === 'incomplete'
    || normalized === 'cancelled';
}

function hasNonNullRawErrorField(raw: Record<string, unknown>): boolean {
  return 'error' in raw && raw.error !== null && raw.error !== undefined;
}

function isRawProviderErrorPayload(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  if (hasNonNullRawErrorField(raw)) return true;
  if (hasRawErrorLikeEvent(raw.event)) return true;
  if (hasRawErrorLikeType(raw.type)) return true;
  if (hasRawErrorLikeStatus(raw.status) && ('message' in raw || 'last_error' in raw || 'incomplete_details' in raw || hasNonNullRawErrorField(raw))) return true;

  const response = raw.response;
  if (isPlainObject(response)) {
    if (hasNonNullRawErrorField(response)) return true;
    if (hasRawErrorLikeStatus(response.status) && ('message' in response || 'last_error' in response || 'incomplete_details' in response || hasNonNullRawErrorField(response))) return true;
  }

  return false;
}

function rawErrorResponse(raw: unknown): LLMResponse {
  return {
    content: { role: 'model', parts: [{ text: '' }] },
    error: { kind: 'response_error', rawBody: raw },
    rawResponse: raw,
  };
}

function rawErrorStreamChunk(raw: unknown): LLMStreamChunk {
  const event = isPlainObject(raw) && typeof raw.event === 'string' ? raw.event : undefined;
  return {
    error: { kind: 'stream_error', event, rawChunk: raw },
    rawChunk: raw,
  };
}

function createOpenAIResponsesProviderContextPart(item: any, endpoint = 'responses'): Part {
  return {
    providerContext: createOpenAIResponsesProviderContext(item, endpoint),
  };
}

function addInlineDataPart(parts: Part[], inlineData: ReturnType<typeof parseBase64DataUrl>, name?: unknown): void {
  if (!inlineData) return;
  parts.push({
    inlineData: {
      ...inlineData,
      ...(typeof name === 'string' && name ? { name } : {}),
    },
  });
}

function parseOpenAICompatibleFilePart(item: any): ReturnType<typeof parseBase64DataUrl> | undefined {
  const file = item.file && typeof item.file === 'object' ? item.file : item;
  const inlineData = parseBase64DataUrl(file.file_data ?? file.data ?? item.file_data ?? item.data);
  if (!inlineData) return undefined;
  return isToolResponseDocumentMimeType(inlineData.mimeType) ? inlineData : undefined;
}

function parseOpenAIContentBlocks(blocks: unknown): Part[] {
  if (!Array.isArray(blocks)) return [];
  const parts: Part[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push({ text: block });
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const item = block as any;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push({ text: item.text });
    } else if (item.type === 'image_url') {
      addInlineDataPart(parts, parseBase64DataUrl(item.image_url?.url));
    } else if (item.type === 'file') {
      addInlineDataPart(parts, parseOpenAICompatibleFilePart(item));
    }
  }
  return parts;
}

function decodeToolContentBlocks(parts: Part[]): { response: Record<string, unknown>; parts?: InlineDataPart[] } {
  const text = parts
    .filter((part): part is Part & { text?: string } => 'text' in part)
    .map(part => part.text ?? '')
    .join('\n');
  const inlineParts = parts
    .filter((part): part is InlineDataPart => 'inlineData' in part)
    .filter(part => isSupportedToolResponseMimeType(part.inlineData.mimeType));
  return {
    response: toRecord(parseJSONValue(text)),
    ...(inlineParts.length > 0 ? { parts: inlineParts } : {}),
  };
}

function decodeToolContentValue(content: unknown, blockParser: (blocks: unknown) => Part[]): { response: Record<string, unknown>; parts?: InlineDataPart[] } {
  if (Array.isArray(content)) {
    return decodeToolContentBlocks(blockParser(content));
  }
  return { response: toRecord(parseJSONValue(content)) };
}


function parseOpenAIResponsesUserBlocks(blocks: unknown): Part[] {
  if (!Array.isArray(blocks)) return [];
  const parts: Part[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const item = block as any;
    if ((item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string') {
      parts.push({ text: item.text });
    } else if (item.type === 'input_image') {
      addInlineDataPart(parts, parseBase64DataUrl(item.image_url));
    } else if (item.type === 'input_file') {
      addInlineDataPart(parts, parseBase64DataUrl(item.file_data), firstDefined(item.filename, item.file_name, item.name));
    }
  }
  return parts;
}

function normalizeGeminiLikeRequest(raw: unknown): LLMRequest {
  const cloned = structuredClone(raw as Record<string, unknown>) as Record<string, any>;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, any>;
    if (record.thoughtSignature) {
      record.thoughtSignatures = { ...(record.thoughtSignatures ?? {}), gemini: record.thoughtSignature };
      delete record.thoughtSignature;
    }
    if (Array.isArray(record.function_declarations) && !Array.isArray(record.functionDeclarations)) {
      record.functionDeclarations = record.function_declarations;
      delete record.function_declarations;
    }
    if (record.functionCall?.id && !record.functionCall.callId) {
      record.functionCall.callId = record.functionCall.id;
      delete record.functionCall.id;
    }
    if (record.functionResponse?.id && !record.functionResponse.callId) {
      record.functionResponse.callId = record.functionResponse.id;
      delete record.functionResponse.id;
    }

    Object.values(record).forEach(visit);
  };

  visit(cloned);
  return normalizeLLMRequestThoughtSignatures(cloned as unknown as LLMRequest, {
    formatHint: 'gemini',
  });
}

const parseClaudeToolResultContent = (content: unknown): { response: Record<string, unknown>; parts?: InlineDataPart[] } => {
    if (typeof content === 'string') {
      return { response: toRecord(parseJSONValue(content)) };
    }
    if (!Array.isArray(content)) {
      return { response: toRecord(parseJSONValue(content)) };
    }

    const textBlocks: string[] = [];
    const inlineParts: InlineDataPart[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as any;
      if (item.type === 'text' && typeof item.text === 'string') {
        textBlocks.push(item.text);
        continue;
      }
      if (item.type !== 'image' && item.type !== 'document') continue;
      const source = item.source;
      if (!source || typeof source !== 'object' || typeof source.media_type !== 'string' || typeof source.data !== 'string') continue;
      if (!isSupportedToolResponseMimeType(source.media_type)) continue;
      inlineParts.push({
        inlineData: {
          mimeType: source.media_type,
          data: source.type === 'text' ? utf8ToBase64(source.data) : source.data,
        },
      });
    }

    const text = textBlocks.join('\n');
    return {
      response: toRecord(parseJSONValue(text)),
      ...(inlineParts.length > 0 ? { parts: inlineParts } : {}),
    };
  };


function decodeClaudeRequest(raw: unknown): LLMRequest {
  const data = raw as any;
  const contents: Content[] = [];
  const toolNameByCallId = new Map<string, string>();

  const parseUserBlocks = (content: unknown): Part[] => {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return [];

    const parts: Part[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as any;
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push({ text: item.text });
      } else if (item.type === 'image' || item.type === 'document') {
        const source = item.source;
        if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
          parts.push({
            inlineData: {
              mimeType: source.media_type,
              data: source.data,
            },
          });
        }
      } else if (item.type === 'tool_result') {
        const callId = normalizeCallId(item.tool_use_id);
        const name = (callId && toolNameByCallId.get(callId)) || String(item.name ?? 'unknown_tool');
        const decoded = parseClaudeToolResultContent(item.content);
        parts.push({
          functionResponse: {
            name,
            response: decoded.response,
            callId,
            ...(decoded.parts ? { parts: decoded.parts } : {}),
          },
        });
      }
    }
    return parts;
  };

  const parseAssistantBlocks = (content: unknown): Part[] => {
    const blocks = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];
    const parts: Part[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const item = block as any;
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push({ text: item.text });
      } else if (item.type === 'thinking') {
        parts.push({
          text: item.thinking || '',
          thought: true,
          thoughtSignatures: item.signature ? { claude: item.signature } : undefined,
        });
      } else if (item.type === 'tool_use') {
        const callId = normalizeCallId(item.id);
        if (callId && typeof item.name === 'string') {
          toolNameByCallId.set(callId, item.name);
        }
        parts.push({
          functionCall: {
            name: String(item.name ?? ''),
            args: isPlainObject(item.input) ? item.input : {},
            callId,
          },
        });
      }
    }
    return parts;
  };

  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant') {
      const parts = parseAssistantBlocks(message.content);
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (message.role === 'user') {
      const parts = parseUserBlocks(message.content);
      if (parts.length > 0) contents.push({ role: 'user', parts });
    }
  }

  const functionDeclarations: FunctionDeclaration[] = Array.isArray(data.tools)
    ? data.tools
        .filter((tool: any) => tool && typeof tool === 'object' && typeof tool.name === 'string')
        .map((tool: any) => ({
          name: tool.name,
          description: String(tool.description ?? ''),
          parameters: isPlainObject(tool.input_schema) ? tool.input_schema as any : undefined,
        }))
    : [];

  const systemParts = Array.isArray(data.system)
    ? data.system
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: any) => ({ text: part.text }))
    : typeof data.system === 'string' && data.system
      ? [{ text: data.system }]
      : undefined;

  const thinkingBudget = typeof data.thinking?.budget_tokens === 'number'
    ? data.thinking.budget_tokens
    : undefined;
  const thinkingLevel = data.thinking?.type === 'disabled'
    ? 'none'
    : normalizeThinkingLevel(data.output_config?.effort);
  const thinkingConfig = {
    ...(thinkingBudget !== undefined || thinkingLevel ? { includeThoughts: true } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };

  return normalizeLLMRequestThoughtSignatures({
    contents,
    systemInstruction: systemParts ? { parts: systemParts } : undefined,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    generationConfig: {
      ...(typeof data.max_tokens === 'number' ? { maxOutputTokens: data.max_tokens } : {}),
      ...(typeof data.temperature === 'number' ? { temperature: data.temperature } : {}),
      ...(typeof data.top_p === 'number' ? { topP: data.top_p } : {}),
      ...(typeof data.top_k === 'number' ? { topK: data.top_k } : {}),
      ...(Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}),
    },
  }, { formatHint: 'claude' });
}

function decodeOpenAICompatibleRequest(raw: unknown): LLMRequest {
  const data = raw as any;
  const contents: Content[] = [];
  const systemParts: Part[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content) {
        systemParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        systemParts.push(...parseOpenAIContentBlocks(message.content));
      }
      continue;
    }

    if (message.role === 'assistant') {
      const parts: Part[] = [];
      if ((typeof message.reasoning_content === 'string' && message.reasoning_content) || typeof message.reasoning_signature === 'string') {
        parts.push({
          text: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
          thought: true,
          ...(typeof message.reasoning_signature === 'string' ? { thoughtSignature: message.reasoning_signature } : {}),
        } as any);
      }
      if (typeof message.content === 'string' && message.content) {
        parts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        parts.push(...parseOpenAIContentBlocks(message.content));
      }
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (!toolCall?.function?.name) continue;
          const callId = normalizeCallId(toolCall.id);
          if (callId) toolNameByCallId.set(callId, toolCall.function.name);
          parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: toRecord(parseJSONValue(toolCall.function.arguments)),
              callId,
            },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    if (message.role === 'tool') {
      const callId = normalizeCallId(message.tool_call_id);
      const decoded = decodeToolContentValue(message.content, parseOpenAIContentBlocks);
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: (callId && toolNameByCallId.get(callId)) || String(message.name ?? 'unknown_tool'),
            response: decoded.response,
            callId,
            ...(decoded.parts ? { parts: decoded.parts } : {}),
          },
        }],
      });
      continue;
    }

    if (message.role === 'user') {
      const parts: Part[] = typeof message.content === 'string'
        ? (message.content ? [{ text: message.content }] : [])
        : parseOpenAIContentBlocks(message.content);
      if (parts.length > 0) contents.push({ role: 'user', parts });
    }
  }

  const functionDeclarations: FunctionDeclaration[] = Array.isArray(data.tools)
    ? data.tools
        .filter((tool: any) => tool?.type === 'function' && tool.function?.name)
        .map((tool: any) => ({
          name: tool.function.name,
          description: String(tool.function.description ?? ''),
          parameters: isPlainObject(tool.function.parameters) ? tool.function.parameters as any : undefined,
        }))
    : [];

  return normalizeLLMRequestThoughtSignatures({
    contents,
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    generationConfig: {
      ...(typeof data.temperature === 'number' ? { temperature: data.temperature } : {}),
      ...(typeof data.top_p === 'number' ? { topP: data.top_p } : {}),
      ...(typeof data.max_tokens === 'number' ? { maxOutputTokens: data.max_tokens } : {}),
      ...(Array.isArray(data.stop) ? { stopSequences: data.stop } : {}),
      ...(normalizeThinkingLevel(data.reasoning_effort) ? { thinkingConfig: { thinkingLevel: normalizeThinkingLevel(data.reasoning_effort) } } : {}),
    },
  }, { formatHint: 'openai-compatible' });
}

function decodeOpenAIResponsesRequest(raw: unknown): LLMRequest {
  const data = raw as any;
  const contents: Content[] = [];
  const toolNameByCallId = new Map<string, string>();

  let pendingModelParts: Part[] = [];
  let pendingUserParts: Part[] = [];

  const flushModel = () => {
    if (pendingModelParts.length === 0) return;
    contents.push({ role: 'model', parts: pendingModelParts });
    pendingModelParts = [];
  };

  const flushUser = () => {
    if (pendingUserParts.length === 0) return;
    contents.push({ role: 'user', parts: pendingUserParts });
    pendingUserParts = [];
  };

  for (const item of Array.isArray(data.input) ? data.input : []) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'reasoning') {
      flushUser();
      pendingModelParts.push({
        text: Array.isArray(item.summary)
          ? item.summary.map((part: any) => String(part?.text ?? part?.summary_text ?? '')).filter(Boolean).join('\n')
          : '',
        thought: true,
        thoughtSignatures: typeof item.encrypted_content === 'string'
          ? { 'openai-responses': item.encrypted_content }
          : undefined,
      });
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      flushUser();
      pendingModelParts.push(...parseOpenAIResponsesUserBlocks(item.content));
      continue;
    }

    if (item.type === 'function_call') {
      flushUser();
      const callId = normalizeCallId(item.call_id) ?? normalizeCallId(item.id);
      if (callId && typeof item.name === 'string') {
        toolNameByCallId.set(callId, item.name);
      }
      pendingModelParts.push({
        functionCall: {
          name: String(item.name ?? ''),
          args: toRecord(parseJSONValue(item.arguments)),
          callId,
        },
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      flushModel();
      const callId = normalizeCallId(item.call_id);
      const decoded = decodeToolContentValue(item.output, parseOpenAIResponsesUserBlocks);
      pendingUserParts.push({
        functionResponse: {
          name: (callId && toolNameByCallId.get(callId)) || String(item.name ?? 'unknown_tool'),
          response: decoded.response,
          callId,
          ...(decoded.parts ? { parts: decoded.parts } : {}),
        },
      });
      continue;
    }

    if (item.type === 'compaction') {
      flushModel();
      flushUser();
      contents.push({
        role: 'model',
        parts: [createOpenAIResponsesProviderContextPart(item, 'responses')],
        providerContext: createOpenAIResponsesProviderContext(item, 'responses'),
      });
      continue;
    }

    if (item.role === 'user') {
      flushModel();
      pendingUserParts.push(...parseOpenAIResponsesUserBlocks(item.content));
    }
  }

  flushModel();
  flushUser();

  const functionDeclarations: FunctionDeclaration[] = Array.isArray(data.tools)
    ? data.tools
        .filter((tool: any) => tool?.type === 'function' && tool.name)
        .map((tool: any) => ({
          name: tool.name,
          description: String(tool.description ?? ''),
          parameters: isPlainObject(tool.parameters) ? tool.parameters as any : undefined,
        }))
    : [];

  return normalizeLLMRequestThoughtSignatures({
    contents,
    systemInstruction: typeof data.instructions === 'string' && data.instructions
      ? { parts: [{ text: data.instructions }] }
      : undefined,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    generationConfig: {
      ...(typeof data.max_output_tokens === 'number' ? { maxOutputTokens: data.max_output_tokens } : {}),
      ...(typeof data.temperature === 'number' ? { temperature: data.temperature } : {}),
      ...(typeof data.top_p === 'number' ? { topP: data.top_p } : {}),
      ...((normalizeThinkingLevel(data.reasoning?.effort) || normalizeReasoningMode(data.reasoning?.mode)) ? { thinkingConfig: {
        ...(normalizeThinkingLevel(data.reasoning?.effort) ? { thinkingLevel: normalizeThinkingLevel(data.reasoning.effort) } : {}),
        ...(normalizeReasoningMode(data.reasoning?.mode) ? { reasoningMode: normalizeReasoningMode(data.reasoning.mode) } : {}),
      } } : {}),
    },
  }, { formatHint: 'openai-responses' });
}

export interface DecodeRequestFromFormatOptions extends FormatFactoryOptions {
  format: FormatId;
  registry?: Pick<FormatRegistry, 'get'>;
}

export function decodeRequestFromFormat(raw: unknown, options: DecodeRequestFromFormatOptions): LLMRequest {
  const format = normalizeFormatId(options.format);
  switch (format) {
    case 'unified':
      return normalizeLLMRequestThoughtSignatures(raw as LLMRequest, {
        formatHint: getSignatureProviderForFormat('unified'),
      });
    case 'gemini':
      return normalizeGeminiLikeRequest(raw);
    case 'claude':
      return decodeClaudeRequest(raw);
    case 'openai-compatible':
    case 'deepseek':
      return decodeOpenAICompatibleRequest(raw);
    case 'openai-responses':
      return decodeOpenAIResponsesRequest(raw);
    default:
      throw new Error(`不支持的请求格式: ${String(options.format)}`);
  }
}

function mapUsageToClaude(usage: LLMResponse['usageMetadata']): Record<string, unknown> | undefined {
  if (!usage) return undefined;

  const cacheCreation = getCacheCreationInputTokenCount(usage);
  const hasCacheCreation = cacheCreation !== undefined || usage.cacheCreationInputTokensDetails !== undefined;
  const cacheRead = usage.cachedContentTokenCount ?? 0;
  const promptTotal = usage.promptTokenCount ?? 0;
  const inputTokens = hasCacheCreation
    ? Math.max(0, promptTotal - (cacheCreation ?? 0) - cacheRead)
    : promptTotal;
  const cacheCreationDetails = mapCacheCreationDetailsToClaude(usage.cacheCreationInputTokensDetails);
  const outputTokensDetails = usage.thoughtsTokenCount !== undefined
    ? { thinking_tokens: usage.thoughtsTokenCount }
    : undefined;

  return {
    input_tokens: inputTokens,
    ...(hasCacheCreation ? { cache_creation_input_tokens: cacheCreation ?? 0 } : {}),
    cache_read_input_tokens: cacheRead,
    ...(cacheCreationDetails ? { cache_creation: cacheCreationDetails } : {}),
    output_tokens: usage.candidatesTokenCount ?? 0,
    ...(outputTokensDetails ? { output_tokens_details: outputTokensDetails } : {}),
  };
}

function getCacheCreationInputTokenCount(usage: LLMResponse['usageMetadata']): number | undefined {
  if (!usage) return undefined;
  if (usage.cacheCreationInputTokenCount !== undefined) return usage.cacheCreationInputTokenCount;

  const details = usage.cacheCreationInputTokensDetails;
  const values = [
    details?.ephemeral5mInputTokenCount,
    details?.ephemeral1hInputTokenCount,
  ].filter((value): value is number => typeof value === 'number');

  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function mapCacheCreationDetailsToClaude(
  details: NonNullable<LLMResponse['usageMetadata']>['cacheCreationInputTokensDetails'] | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const mapped: Record<string, unknown> = {};
  if (details.ephemeral5mInputTokenCount !== undefined) {
    mapped.ephemeral_5m_input_tokens = details.ephemeral5mInputTokenCount;
  }
  if (details.ephemeral1hInputTokenCount !== undefined) {
    mapped.ephemeral_1h_input_tokens = details.ephemeral1hInputTokenCount;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapUsageToGemini(usage: LLMResponse['usageMetadata']): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.promptTokenCount !== undefined ? { promptTokenCount: usage.promptTokenCount } : {}),
    ...(usage.cachedContentTokenCount !== undefined ? { cachedContentTokenCount: usage.cachedContentTokenCount } : {}),
    ...(usage.candidatesTokenCount !== undefined ? { candidatesTokenCount: usage.candidatesTokenCount } : {}),
    ...(usage.thoughtsTokenCount !== undefined ? { thoughtsTokenCount: usage.thoughtsTokenCount } : {}),
    ...(usage.totalTokenCount !== undefined ? { totalTokenCount: usage.totalTokenCount } : {}),
  };
}

function mapUsageToOpenAI(usage: LLMResponse['usageMetadata']): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokenCount ?? 0,
    prompt_tokens_details: {
      cached_tokens: usage.cachedContentTokenCount ?? 0,
    },
    completion_tokens: usage.candidatesTokenCount ?? 0,
    ...(usage.thoughtsTokenCount !== undefined ? { completion_tokens_details: {
      reasoning_tokens: usage.thoughtsTokenCount,
    } } : {}),
    total_tokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)),
  };
}

function mapUsageToOpenAIResponses(usage: LLMResponse['usageMetadata']): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokenCount ?? 0,
    input_tokens_details: {
      cached_tokens: usage.cachedContentTokenCount ?? 0,
    },
    output_tokens: usage.candidatesTokenCount ?? 0,
    ...(usage.thoughtsTokenCount !== undefined ? { output_tokens_details: {
      reasoning_tokens: usage.thoughtsTokenCount,
    } } : {}),
    total_tokens: usage.totalTokenCount ?? ((usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)),
  };
}

function mapFinishReasonToClaude(reason?: string): string | undefined {
  switch (reason) {
    case 'STOP': return 'end_turn';
    case 'TOOL_CALLS': return 'tool_use';
    case 'MAX_TOKENS': return 'max_tokens';
    default: return reason ? String(reason).toLowerCase() : undefined;
  }
}

function mapFinishReasonToOpenAI(reason?: string): string | undefined {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'TOOL_CALLS': return 'tool_calls';
    case 'MAX_TOKENS': return 'length';
    default: return reason ? String(reason).toLowerCase() : undefined;
  }
}

function normalizeUnifiedSignatureMode(mode: UnifiedSignatureMode | undefined): 'string' | 'object' | 'preserve' {
  return mode ?? 'string';
}

export interface EncodeRequestToFormatOptions extends FormatTransformOptions {
  format: FormatId;
  sourceFormat?: FormatId;
  stream?: boolean;
}

export function encodeRequestToFormat(request: LLMRequest, options: EncodeRequestToFormatOptions): unknown {
  const format = normalizeFormatId(options.format);
  const sourceFormat = options.sourceFormat ? normalizeFormatId(options.sourceFormat) : 'unified';
  const normalizedRequest = normalizeLLMRequestThoughtSignatures(request, {
    formatHint: getSignatureProviderForFormat(sourceFormat),
  });

  if (format === 'unified') {
    const mode = normalizeUnifiedSignatureMode(options.signatureMode ?? (sourceFormat === 'unified'
      ? (detectLLMRequestSignatureRepresentation(normalizedRequest) === 'object' ? 'object' : 'string')
      : 'string'));
    if (mode === 'preserve') return normalizedRequest;
    return serializeLLMRequestThoughtSignatures(normalizedRequest, { mode });
  }

  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  return adapter.encodeRequest(normalizedRequest, options.stream);
}

function getSignatureEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0);
}

function pickSignatureEntry(value: unknown, preferProvider?: string): [string, string] | undefined {
  const entries = getSignatureEntries(value);
  if (entries.length === 0) return undefined;
  if (preferProvider) {
    const matched = entries.find(([provider]) => provider === preferProvider);
    if (matched) return matched;
  }
  return entries[0];
}

function buildPortableSignature(value: unknown, preferProvider?: string): string | undefined {
  const selected = pickSignatureEntry(value, preferProvider);
  return selected ? `${selected[0]}:${selected[1]}` : undefined;
}

function getSignatureSlotProviderForFormat(format: Exclude<WireFormatId, 'deepseek'>): string | undefined {
  switch (format) {
    case 'gemini': return 'gemini';
    case 'claude': return 'claude';
    case 'openai-compatible': return 'openai-compatible';
    case 'openai-responses': return 'openai-responses';
    default: return undefined;
  }
}

function remapPartSignaturesForTargetFormat(part: Part, format: Exclude<WireFormatId, 'deepseek'>, preferProvider?: string): Part {
  if (!isTextPart(part)) return part;
  const slotProvider = getSignatureSlotProviderForFormat(format);
  const portableSignature = buildPortableSignature((part as any).thoughtSignatures, preferProvider);
  if (!slotProvider || !portableSignature) return part;

  const cloned: any = { ...part };
  delete cloned.thoughtSignature;
  cloned.thoughtSignatures = { [slotProvider]: portableSignature };
  return cloned;
}

function createSyntheticRequestFromResponse(response: LLMResponse, format: Exclude<WireFormatId, 'deepseek'>, preferProvider?: string): LLMRequest {
  return {
    contents: [{
      ...response.content,
      parts: response.content.parts.map(part => remapPartSignaturesForTargetFormat(part, format, preferProvider)),
    }],
  };
}

function extractPortableSignatureFromParts(parts: Part[], preferProvider?: string): string | undefined {
  for (const part of parts) {
    if (!isTextPart(part)) continue;
    const portable = buildPortableSignature((part as any).thoughtSignatures, preferProvider);
    if (portable) return portable;
  }
  return undefined;
}

function extractPortableSignatureFromChunk(chunk: LLMStreamChunk, preferProvider?: string): string | undefined {
  return extractPortableSignatureFromParts(chunk.partsDelta ?? [], preferProvider) ?? buildPortableSignature(chunk.thoughtSignatures, preferProvider);
}

export interface DecodeResponseFromFormatOptions extends FormatFactoryOptions {
  format: FormatId;
  registry?: Pick<FormatRegistry, 'get'>;
  signatureMode?: UnifiedSignatureMode;
}

export function decodeResponseFromFormat(raw: unknown, options: DecodeResponseFromFormatOptions): LLMResponse {
  const format = normalizeFormatId(options.format);
  if (format === 'unified') {
    if (isRawProviderErrorPayload(raw)) return rawErrorResponse(raw);
    return normalizeLLMResponseThoughtSignatures(raw as LLMResponse, {
      formatHint: getSignatureProviderForFormat('unified'),
    });
  }

  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  if (isRawProviderErrorPayload(raw)) return rawErrorResponse(raw);
  const normalized = normalizeLLMResponseThoughtSignatures(adapter.decodeResponse(raw), {
    formatHint: getSignatureProviderForFormat(format),
  });
  const mode = options.signatureMode ?? 'string';
  if (mode === 'preserve') {
    return normalized;
  }
  return serializeLLMResponseThoughtSignatures(normalized, {
    mode,
  });
}

export interface EncodeResponseToFormatOptions extends FormatTransformOptions {
  format: FormatId;
  sourceFormat?: FormatId;
}

export function encodeResponseToFormat(response: LLMResponse, options: EncodeResponseToFormatOptions): unknown {
  const format = normalizeFormatId(options.format);
  if (response.error) {
    if (format === 'unified') return response;
    return getRawErrorPassthroughPayload(response);
  }

  const sourceFormat = options.sourceFormat ? normalizeFormatId(options.sourceFormat) : 'unified';
  const normalizedResponse = normalizeLLMResponseThoughtSignatures(response, {
    formatHint: getSignatureProviderForFormat(sourceFormat),
  });

  if (format === 'unified') {
    const mode = normalizeUnifiedSignatureMode(options.signatureMode ?? 'string');
    if (mode === 'preserve') return normalizedResponse;
    return serializeLLMResponseThoughtSignatures(normalizedResponse, { mode });
  }

  const wireFormat = normalizeWireFormatId(format);
  const preferProvider = getSignatureProviderForFormat(sourceFormat);
  const portableSignature = extractPortableSignatureFromParts(normalizedResponse.content.parts, preferProvider);
  const syntheticRequest = createSyntheticRequestFromResponse(normalizedResponse, wireFormat, preferProvider);
  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  const encoded = adapter.encodeRequest(syntheticRequest, false) as any;

  switch (wireFormat) {
    case 'gemini':
      return {
        candidates: [{
          content: encoded.contents?.[0] ?? { role: 'model', parts: [{ text: '' }] },
          finishReason: normalizedResponse.finishReason,
        }],
        usageMetadata: mapUsageToGemini(normalizedResponse.usageMetadata),
      };
    case 'claude': {
      const assistantMessage = Array.isArray(encoded.messages)
        ? encoded.messages.find((message: any) => message.role === 'assistant')
        : undefined;
      return {
        content: assistantMessage?.content ?? [],
        stop_reason: mapFinishReasonToClaude(normalizedResponse.finishReason),
        usage: mapUsageToClaude(normalizedResponse.usageMetadata),
      };
    }
    case 'openai-compatible': {
      const assistantMessage = Array.isArray(encoded.messages)
        ? encoded.messages.find((message: any) => message.role === 'assistant')
        : undefined;
      const responseMessage = assistantMessage
        ? {
            ...assistantMessage,
            ...(portableSignature ? { reasoning_signature: portableSignature } : {}),
          }
        : { role: 'assistant', content: '', ...(portableSignature ? { reasoning_signature: portableSignature } : {}) };
      return {
        choices: [{
          message: responseMessage,
          finish_reason: mapFinishReasonToOpenAI(normalizedResponse.finishReason),
        }],
        usage: mapUsageToOpenAI(normalizedResponse.usageMetadata),
      };
    }
    case 'openai-responses':
      return {
        output: encoded.input ?? [],
        usage: mapUsageToOpenAIResponses(normalizedResponse.usageMetadata),
      };
    default:
      throw new Error(`不支持的响应目标格式: ${format}`);
  }
}

export interface DecodeCompactResponseFromFormatOptions extends FormatTransformOptions {
  format: FormatId;
  registry?: Pick<FormatRegistry, 'get'>;
}

export function decodeCompactResponseFromFormat(raw: unknown, options: DecodeCompactResponseFromFormatOptions): LLMCompactResponse {
  const format = normalizeFormatId(options.format);
  if (format === 'unified') return raw as LLMCompactResponse;

  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  if (!isCompactFormatAdapter(adapter)) {
    throw new Error(`格式 ${format} 不支持 compact 响应解码`);
  }
  return adapter.decodeCompactResponse(raw);
}

export interface EncodeCompactResponseToFormatOptions extends FormatTransformOptions {
  format: FormatId;
  sourceFormat?: FormatId;
}

export function encodeCompactResponseToFormat(response: LLMCompactResponse, options: EncodeCompactResponseToFormatOptions): unknown {
  const format = normalizeFormatId(options.format);
  if (format === 'unified') return response;

  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  if (!isCompactFormatAdapter(adapter) || typeof adapter.encodeCompactResponse !== 'function') {
    throw new Error(`格式 ${format} 不支持 compact 响应编码`);
  }
  return adapter.encodeCompactResponse(response);
}

export interface ConvertCompactResponseOptions extends FormatTransformOptions {
  from: FormatId;
  to: FormatId;
}

export function convertCompactResponse(raw: unknown, options: ConvertCompactResponseOptions): unknown {
  const compact = decodeCompactResponseFromFormat(raw, {
    format: options.from,
    registry: options.registry,
    model: options.model,
    signatureMode: options.signatureMode,
  });
  return encodeCompactResponseToFormat(compact, {
    format: options.to,
    sourceFormat: options.from,
    registry: options.registry,
    model: options.model,
    signatureMode: options.signatureMode,
  });
}


export interface ConvertRequestOptions extends FormatTransformOptions {
  from: FormatId;
  to: FormatId;
  stream?: boolean;
}

export function convertRequest(raw: unknown, options: ConvertRequestOptions): unknown {
  const canonical = decodeRequestFromFormat(raw, {
    format: options.from,
    registry: options.registry,
    model: options.model,
    promptCache: options.promptCache,
    promptCaching: options.promptCaching,
    autoCaching: options.autoCaching,
  });

  return encodeRequestToFormat(canonical, {
    format: options.to,
    sourceFormat: options.from,
    stream: options.stream,
    registry: options.registry,
    model: options.model,
    promptCache: options.promptCache,
    promptCaching: options.promptCaching,
    autoCaching: options.autoCaching,
    signatureMode: options.signatureMode,
  });
}

export interface ConvertResponseOptions extends FormatTransformOptions {
  from: FormatId;
  to: FormatId;
}

export function convertResponse(raw: unknown, options: ConvertResponseOptions): unknown {
  const canonical = decodeResponseFromFormat(raw, {
    format: options.from,
    registry: options.registry,
    model: options.model,
    promptCache: options.promptCache,
    promptCaching: options.promptCaching,
    autoCaching: options.autoCaching,
  });

  return encodeResponseToFormat(canonical, {
    format: options.to,
    sourceFormat: options.from,
    registry: options.registry,
    model: options.model,
    promptCache: options.promptCache,
    promptCaching: options.promptCaching,
    autoCaching: options.autoCaching,
    signatureMode: options.signatureMode,
  });
}

export interface DecodeStreamChunkFromFormatOptions extends FormatFactoryOptions {
  format: FormatId;
  registry?: Pick<FormatRegistry, 'get'>;
  signatureMode?: UnifiedSignatureMode;
}

function prepareChunkForPortableTarget(
  chunk: LLMStreamChunk,
  format: Exclude<WireFormatId, 'deepseek'>,
  preferProvider?: string,
): LLMStreamChunk {
  const slotProvider = getSignatureSlotProviderForFormat(format);
  const portableSignature = extractPortableSignatureFromChunk(chunk, preferProvider);
  const nextChunk: LLMStreamChunk = {
    ...chunk,
    partsDelta: chunk.partsDelta?.map(part => remapPartSignaturesForTargetFormat(part, format, preferProvider)),
  };

  if (slotProvider && portableSignature) {
    nextChunk.thoughtSignatures = { [slotProvider]: portableSignature };
    delete (nextChunk as any).thoughtSignature;

    if (!nextChunk.partsDelta || nextChunk.partsDelta.length === 0) {
      nextChunk.partsDelta = [{
        thought: true,
        thoughtSignatures: { [slotProvider]: portableSignature },
      } as any];
    }
  }

  return nextChunk;
}

function createGeminiStreamPayload(chunk: LLMStreamChunk): unknown {
  const parts: Part[] = [...(chunk.partsDelta ?? [])];
  if (chunk.textDelta && !parts.some(part => isTextPart(part) && part.text === chunk.textDelta)) {
    parts.push({ text: chunk.textDelta });
  }
  return {
    candidates: [{
      content: parts.length > 0 ? { role: 'model', parts } : undefined,
      ...(chunk.finishReason ? { finishReason: chunk.finishReason } : {}),
    }],
    ...(chunk.usageMetadata ? { usageMetadata: mapUsageToGemini(chunk.usageMetadata) } : {}),
  };
}

function createOpenAICompatibleStreamPayload(chunk: LLMStreamChunk, portableSignature?: string): unknown {
  const delta: Record<string, unknown> = {};
  const toolCalls = (chunk.functionCalls ?? []).map((call, index) => ({
    index,
    id: call.functionCall.callId,
    type: 'function',
    function: {
      name: call.functionCall.name,
      arguments: JSON.stringify(call.functionCall.args ?? {}),
    },
  }));

  if (chunk.partsDelta) {
    const reasoning = chunk.partsDelta
      .filter((part): part is Part & { text?: string; thought: true } => isTextPart(part) && part.thought === true)
      .map(part => part.text ?? '')
      .join('');
    if (reasoning) delta.reasoning_content = reasoning;
  }
  if (portableSignature) delta.reasoning_signature = portableSignature;
  if (chunk.textDelta) delta.content = chunk.textDelta;
  if (toolCalls.length > 0) delta.tool_calls = toolCalls;

  return {
    choices: [{
      delta,
      ...(chunk.finishReason ? { finish_reason: mapFinishReasonToOpenAI(chunk.finishReason) } : {}),
    }],
    ...(chunk.usageMetadata ? { usage: mapUsageToOpenAI(chunk.usageMetadata) } : {}),
  };
}

function createClaudeStreamPayloads(chunk: LLMStreamChunk): unknown[] {
  const payloads: unknown[] = [];

  for (const part of chunk.partsDelta ?? []) {
    if (isTextPart(part) && part.thought === true && part.text) {
      payloads.push({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: part.text } });
    } else if (isTextPart(part) && part.thought !== true && part.text) {
      payloads.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: part.text } });
    } else if ('functionCall' in part) {
      payloads.push({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: part.functionCall.callId,
          name: part.functionCall.name,
        },
      });
      payloads.push({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args ?? {}) },
      });
      payloads.push({ type: 'content_block_stop' });
    }

    if (isTextPart(part) && part.thoughtSignatures?.claude) {
      payloads.push({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: part.thoughtSignatures.claude } });
    }
  }

  if (chunk.finishReason || chunk.usageMetadata) {
    payloads.push({
      type: 'message_delta',
      ...(chunk.finishReason ? { delta: { stop_reason: mapFinishReasonToClaude(chunk.finishReason) } } : {}),
      ...(chunk.usageMetadata ? { usage: mapUsageToClaudeStreamDelta(chunk.usageMetadata) } : {}),
    });
  }

  return payloads;
}

function mapUsageToClaudeStreamDelta(usage: LLMResponse['usageMetadata']): Record<string, unknown> {
  return {
    output_tokens: usage?.candidatesTokenCount ?? 0,
    ...(usage?.thoughtsTokenCount !== undefined ? {
      output_tokens_details: {
        thinking_tokens: usage.thoughtsTokenCount,
      },
    } : {}),
  };
}

function createOpenAIResponsesStreamPayloads(chunk: LLMStreamChunk): unknown[] {
  const payloads: unknown[] = [];
  let reasoningIndex = 0;

  for (const part of chunk.partsDelta ?? []) {
    if (isTextPart(part) && part.thought === true && part.text) {
      payloads.push({
        event: 'response.reasoning_summary_text.delta',
        item_id: `reasoning_${reasoningIndex}`,
        output_index: reasoningIndex,
        delta: part.text,
      });
    } else if (isTextPart(part) && part.thought !== true && part.text) {
      payloads.push({ event: 'response.output_text.delta', delta: part.text });
    } else if ('functionCall' in part) {
      payloads.push({
        event: 'response.output_item.done',
        item: {
          id: part.functionCall.callId,
          type: 'function_call',
          call_id: part.functionCall.callId,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    } else if (isProviderContextPart(part)
      && part.providerContext.format === 'openai-responses'
      && part.providerContext.rawItem
      && typeof part.providerContext.rawItem === 'object'
      && !Array.isArray(part.providerContext.rawItem)) {
      payloads.push({
        event: 'response.output_item.done',
        item: cloneRawItem(part.providerContext.rawItem),
      });
    }

    if (isTextPart(part) && part.thoughtSignatures?.['openai-responses']) {
      payloads.push({
        event: 'response.output_item.done',
        item: {
          id: `reasoning_${reasoningIndex}`,
          type: 'reasoning',
          summary: [],
          encrypted_content: part.thoughtSignatures['openai-responses'],
        },
      });
      reasoningIndex += 1;
    }
  }

  if (chunk.finishReason || chunk.usageMetadata) {
    payloads.push({
      event: 'response.completed',
      usage: mapUsageToOpenAIResponses(chunk.usageMetadata),
      response: {
        output: [],
        usage: mapUsageToOpenAIResponses(chunk.usageMetadata),
      },
    });
  }

  return payloads;
}

export interface EncodeStreamChunkToFormatOptions extends FormatTransformOptions {
  format: FormatId;
  sourceFormat?: FormatId;
}

export function encodeStreamChunkToFormat(chunk: LLMStreamChunk, options: EncodeStreamChunkToFormatOptions): unknown {
  const format = normalizeFormatId(options.format);
  if (chunk.error) {
    if (format === 'unified') return chunk;
    return getRawErrorPassthroughPayload(chunk);
  }

  const sourceFormat = options.sourceFormat ? normalizeFormatId(options.sourceFormat) : 'unified';
  const normalizedChunk = normalizeLLMStreamChunkThoughtSignatures(chunk, {
    formatHint: getSignatureProviderForFormat(sourceFormat),
  });
  const wireFormat = format === 'unified' ? undefined : normalizeWireFormatId(format);
  const preferProvider = getSignatureProviderForFormat(sourceFormat);

  if (format === 'unified') {
    const mode = normalizeUnifiedSignatureMode(options.signatureMode ?? 'string');
    if (mode === 'preserve') return normalizedChunk;
    return serializeLLMStreamChunkThoughtSignatures(normalizedChunk, { mode });
  }

  const portableChunk = prepareChunkForPortableTarget(normalizedChunk, wireFormat!, preferProvider);
  const portableSignature = extractPortableSignatureFromChunk(normalizedChunk, preferProvider);

  switch (wireFormat) {
    case 'gemini':
      return createGeminiStreamPayload(portableChunk);
    case 'openai-compatible':
      return createOpenAICompatibleStreamPayload(normalizedChunk, portableSignature);
    case 'claude':
      return createClaudeStreamPayloads(portableChunk);
    case 'openai-responses':
      return createOpenAIResponsesStreamPayloads(portableChunk);
    default:
      throw new Error(`不支持的流式目标格式: ${format}`);
  }
}

export interface StreamChunkDecoder {
  decode(raw: unknown): LLMStreamChunk;
}

export function createStreamChunkDecoder(options: DecodeStreamChunkFromFormatOptions): StreamChunkDecoder {
  const format = normalizeFormatId(options.format);
  if (format === 'unified') {
    return {
      decode(raw: unknown): LLMStreamChunk {
        if (isRawProviderErrorPayload(raw)) return rawErrorStreamChunk(raw);
        return normalizeLLMStreamChunkThoughtSignatures(raw as LLMStreamChunk, {
          formatHint: getSignatureProviderForFormat('unified'),
        });
      },
    };
  }

  const registry = resolveFormatRegistry(options.registry);
  const adapter = createAdapter(format, registry, options);
  const state = adapter.createStreamState();

  return {
    decode(raw: unknown): LLMStreamChunk {
      if (isRawProviderErrorPayload(raw)) return rawErrorStreamChunk(raw);
      const normalized = normalizeLLMStreamChunkThoughtSignatures(adapter.decodeStreamChunk(raw, state), {
        formatHint: getSignatureProviderForFormat(format),
      });
      const mode = options.signatureMode ?? 'string';
      if (mode === 'preserve') {
        return normalized;
      }
      return serializeLLMStreamChunkThoughtSignatures(normalized, {
        mode,
      });
    },
  };
}

export interface CreateStreamConverterOptions extends FormatTransformOptions {
  from: FormatId;
  to: FormatId;
}

export function createStreamConverter(options: CreateStreamConverterOptions): { convert(raw: unknown): unknown } {
  const decoder = createStreamChunkDecoder({
    format: options.from,
    registry: options.registry,
    model: options.model,
    promptCache: options.promptCache,
    promptCaching: options.promptCaching,
    autoCaching: options.autoCaching,
  });

  return {
    convert(raw: unknown): unknown {
      const chunk = decoder.decode(raw);
      return encodeStreamChunkToFormat(chunk, {
        format: options.to,
        sourceFormat: options.from,
        registry: options.registry,
        model: options.model,
        promptCaching: options.promptCaching,
        autoCaching: options.autoCaching,
        signatureMode: options.signatureMode,
      });
    },
  };
}
