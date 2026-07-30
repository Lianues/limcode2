import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../types/llm.js';
import type { Content, Part, TextPart } from '../types/message.js';
import { isTextPart } from '../types/message.js';
import type { SignatureNormalizationOptions, SignatureProviderId, SignatureRepresentation } from './types.js';

export interface ParsedThoughtSignature {
  provider?: SignatureProviderId;
  value: string;
  hadPrefix: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeSignatureProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'openai') {
    throw new Error('不再支持 openai 签名前缀；请明确使用 openai-compatible 或 openai-responses');
  }
  return normalized;
}

function cloneSignatureMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isNonEmptyString(item)) {
      const parsed = parseThoughtSignature(item);
      const provider = normalizeSignatureProviderId(parsed.hadPrefix && parsed.provider ? parsed.provider : key);
      const signature = parsed.hadPrefix && parsed.provider ? parsed.value : item.trim();
      const existing = result[provider];
      if (existing && existing !== signature) {
        throw new Error(`thoughtSignatures 在 provider=${provider} 上存在冲突`);
      }
      result[provider] = signature;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeSignature(
  target: Record<string, string>,
  provider: string,
  value: string,
): void {
  const existing = target[provider];
  if (existing && existing !== value) {
    throw new Error(`thoughtSignature 与 thoughtSignatures 在 provider=${provider} 上存在冲突`);
  }
  target[provider] = value;
}

export function parseThoughtSignature(value: string): ParsedThoughtSignature {
  const trimmed = value.trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex <= 0) {
    return { value: trimmed, hadPrefix: false };
  }

  const provider = trimmed.slice(0, colonIndex).trim();
  const rawValue = trimmed.slice(colonIndex + 1).trim();
  if (!provider || !rawValue || !/^[a-zA-Z0-9_-]+$/.test(provider)) {
    return { value: trimmed, hadPrefix: false };
  }

  return {
    provider: normalizeSignatureProviderId(provider),
    value: rawValue,
    hadPrefix: true,
  };
}

export function normalizeTextPartThoughtSignatures<T extends TextPart>(
  part: T,
  options: SignatureNormalizationOptions = {},
): T {
  const cloned = { ...part } as T & { thoughtSignatures?: Record<string, string>; thoughtSignature?: string };
  const existing = cloneSignatureMap(cloned.thoughtSignatures) ?? {};

  if (isNonEmptyString(cloned.thoughtSignature)) {
    const parsed = parseThoughtSignature(cloned.thoughtSignature);
    if (parsed.hadPrefix && parsed.provider) {
      mergeSignature(existing, normalizeSignatureProviderId(parsed.provider), parsed.value);
      delete cloned.thoughtSignature;
    } else if (options.formatHint) {
      mergeSignature(existing, normalizeSignatureProviderId(options.formatHint), parsed.value);
      delete cloned.thoughtSignature;
    }
  }

  if (Object.keys(existing).length > 0) {
    cloned.thoughtSignatures = existing;
  } else {
    delete cloned.thoughtSignatures;
  }

  return cloned;
}

function normalizePart(part: Part, options: SignatureNormalizationOptions): Part {
  if (!isTextPart(part)) return part;
  return normalizeTextPartThoughtSignatures(part, options);
}

function normalizeContent(content: Content, options: SignatureNormalizationOptions): Content {
  return {
    ...content,
    parts: content.parts.map(part => normalizePart(part, options)),
  };
}

export function normalizeLLMRequestThoughtSignatures(
  request: LLMRequest,
  options: SignatureNormalizationOptions = {},
): LLMRequest {
  return {
    ...request,
    contents: request.contents.map(content => normalizeContent(content, options)),
    systemInstruction: request.systemInstruction
      ? {
          ...request.systemInstruction,
          parts: request.systemInstruction.parts.map(part => normalizePart(part, options)),
        }
      : undefined,
  };
}

export function normalizeLLMResponseThoughtSignatures(
  response: LLMResponse,
  options: SignatureNormalizationOptions = {},
): LLMResponse {
  return {
    ...response,
    content: normalizeContent(response.content, options),
  };
}

export function normalizeLLMStreamChunkThoughtSignatures(
  chunk: LLMStreamChunk,
  options: SignatureNormalizationOptions = {},
): LLMStreamChunk {
  const nextChunk: LLMStreamChunk & { thoughtSignatures?: Record<string, string | undefined>; thoughtSignature?: string } = {
    ...chunk,
    partsDelta: chunk.partsDelta?.map(part => normalizePart(part, options)),
  };

  const existing = cloneSignatureMap(nextChunk.thoughtSignatures) ?? {};
  if (isNonEmptyString((nextChunk as any).thoughtSignature)) {
    const parsed = parseThoughtSignature((nextChunk as any).thoughtSignature);
    if (parsed.hadPrefix && parsed.provider) {
      mergeSignature(existing, normalizeSignatureProviderId(parsed.provider), parsed.value);
      delete (nextChunk as any).thoughtSignature;
    } else if (options.formatHint) {
      mergeSignature(existing, normalizeSignatureProviderId(options.formatHint), parsed.value);
      delete (nextChunk as any).thoughtSignature;
    }
  }

  if (Object.keys(existing).length > 0) {
    nextChunk.thoughtSignatures = existing;
  } else {
    delete nextChunk.thoughtSignatures;
  }

  return nextChunk;
}

function detectPartRepresentation(part: Part): SignatureRepresentation | undefined {
  if (!isTextPart(part)) return undefined;
  if (isNonEmptyString((part as any).thoughtSignature)) return 'string';
  if (cloneSignatureMap((part as any).thoughtSignatures)) return 'object';
  return undefined;
}

export function detectLLMRequestSignatureRepresentation(request: LLMRequest): SignatureRepresentation | undefined {
  for (const content of request.contents) {
    for (const part of content.parts) {
      const detected = detectPartRepresentation(part);
      if (detected) return detected;
    }
  }
  for (const part of request.systemInstruction?.parts ?? []) {
    const detected = detectPartRepresentation(part);
    if (detected) return detected;
  }
  return undefined;
}
