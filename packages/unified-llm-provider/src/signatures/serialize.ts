import type { LLMRequest, LLMResponse, LLMStreamChunk } from '../types/llm.js';
import type { Content, Part, TextPart } from '../types/message.js';
import { isTextPart } from '../types/message.js';
import type { SignatureOutputMode, SignatureRepresentation, SignatureSerializationOptions } from './types.js';
import { detectLLMRequestSignatureRepresentation, normalizeSignatureProviderId } from './normalize.js';

function getSignatureEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([provider, signature]): [string, string] => [normalizeSignatureProviderId(provider), signature.trim()])
    .filter(([provider]) => !!provider)
    .reduce<Array<[string, string]>>((result, entry) => {
      if (!result.some(([provider, signature]) => provider === entry[0] && signature === entry[1])) result.push(entry);
      return result;
    }, []);
}

function selectSignatureEntry(
  signatures: unknown,
  preferProvider?: string,
): [string, string] | undefined {
  const entries = getSignatureEntries(signatures);
  if (entries.length === 0) return undefined;
  if (preferProvider) {
    const matched = entries.find(([provider]) => provider === preferProvider);
    if (matched) return matched;
  }
  return entries.length === 1 ? entries[0] : undefined;
}

function serializeTextPart<T extends TextPart>(
  part: T,
  options: SignatureSerializationOptions,
): T {
  const cloned = { ...part } as T & { thoughtSignatures?: Record<string, string>; thoughtSignature?: string };
  const entries = getSignatureEntries(cloned.thoughtSignatures);
  if (entries.length === 0) {
    delete cloned.thoughtSignature;
    delete cloned.thoughtSignatures;
    return cloned;
  }

  if (options.mode === 'object') {
    delete cloned.thoughtSignature;
    return cloned;
  }

  const selected = selectSignatureEntry(cloned.thoughtSignatures, options.preferProvider);
  if (selected) {
    const [provider, signature] = selected;
    cloned.thoughtSignature = `${provider}:${signature}`;
    delete cloned.thoughtSignatures;
    return cloned;
  }

  if (options.fallbackToObject === false) {
    delete cloned.thoughtSignature;
    return cloned;
  }

  delete cloned.thoughtSignature;
  return cloned;
}

function serializePart(part: Part, options: SignatureSerializationOptions): Part {
  if (!isTextPart(part)) return part;
  return serializeTextPart(part, options);
}

export function serializeLLMRequestThoughtSignatures(
  request: LLMRequest,
  options: SignatureSerializationOptions,
): LLMRequest {
  return serializeRequestLike(request, options);
}

function serializeContent(content: Content, options: SignatureSerializationOptions): Content {
  return {
    ...content,
    parts: content.parts.map(part => serializePart(part, options)),
  };
}

function serializeRequestLike(request: LLMRequest, options: SignatureSerializationOptions): LLMRequest {
  return {
    ...request,
    contents: request.contents.map(content => serializeContent(content, options)),
    systemInstruction: request.systemInstruction
      ? {
          ...request.systemInstruction,
          parts: request.systemInstruction.parts.map(part => serializePart(part, options)),
        }
      : undefined,
  };
}

export function serializeLLMResponseThoughtSignatures(
  response: LLMResponse,
  options: SignatureSerializationOptions,
): LLMResponse {
  return {
    ...response,
    content: serializeContent(response.content, options),
  };
}

export function serializeLLMStreamChunkThoughtSignatures(
  chunk: LLMStreamChunk,
  options: SignatureSerializationOptions,
): LLMStreamChunk {
  const nextChunk: LLMStreamChunk & { thoughtSignature?: string; thoughtSignatures?: Record<string, string | undefined> } = {
    ...chunk,
    partsDelta: chunk.partsDelta?.map(part => serializePart(part, options)),
  };

  const selected = selectSignatureEntry(nextChunk.thoughtSignatures, options.preferProvider);
  if (options.mode === 'object') {
    delete nextChunk.thoughtSignature;
  } else if (selected) {
    const [provider, signature] = selected;
    nextChunk.thoughtSignature = `${provider}:${signature}`;
    delete nextChunk.thoughtSignatures;
  } else if (options.fallbackToObject === false) {
    delete nextChunk.thoughtSignature;
  } else {
    delete nextChunk.thoughtSignature;
  }

  return nextChunk;
}

export function resolveSignatureOutputMode(
  request: LLMRequest,
  options?: {
    requestedMode?: SignatureOutputMode;
    formatSpecified?: boolean;
  },
): 'string' | 'object' | 'preserve' {
  if (options?.requestedMode && options.requestedMode !== 'auto') {
    return options.requestedMode;
  }

  if (options?.formatSpecified) {
    return 'string';
  }

  const representation = detectLLMRequestSignatureRepresentation(request);
  if (representation === 'string') return 'string';
  if (representation === 'object') return 'object';
  return 'preserve';
}

export function inferPreferredSignatureProvider(
  responseOrChunk: LLMResponse | LLMStreamChunk,
  fallback?: string,
): string | undefined {
  const candidates = new Set<string>();

  const collectFromPart = (part: Part) => {
    if (!isTextPart(part)) return;
    for (const [provider, signature] of getSignatureEntries((part as any).thoughtSignatures)) {
      if (signature) candidates.add(provider);
    }
  };

  if ('content' in responseOrChunk) {
    for (const part of responseOrChunk.content.parts) collectFromPart(part);
  } else {
    for (const part of responseOrChunk.partsDelta ?? []) collectFromPart(part);
    for (const [provider, signature] of getSignatureEntries((responseOrChunk as any).thoughtSignatures)) {
      if (signature) candidates.add(provider);
    }
  }

  if (fallback && candidates.has(fallback)) return fallback;
  return candidates.size === 1 ? [...candidates][0] : fallback;
}

export function shouldSerializeSignatureOutput(
  request: LLMRequest,
  options?: {
    requestedMode?: SignatureOutputMode;
    formatSpecified?: boolean;
  },
): boolean {
  return resolveSignatureOutputMode(request, options) !== 'preserve';
}
