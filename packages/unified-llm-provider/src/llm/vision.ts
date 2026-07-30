/**
 * Vision 能力检测 + 文档能力检测
 */

import type { LLMConfig } from '../config/types.js';

export interface Base64InlineData {
  mimeType: string;
  data: string;
  name?: string;
}

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

/** 检查是否为文档 MIME 类型（PDF / DOCX / PPTX / XLSX） */
export function isDocumentMimeType(mimeType: string): boolean {
  return DOCUMENT_MIME_TYPES.has(mimeType.toLowerCase());
}

const TOOL_RESPONSE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const TOOL_RESPONSE_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
]);

export function isToolResponseImageMimeType(mimeType: string): boolean {
  return TOOL_RESPONSE_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isToolResponseDocumentMimeType(mimeType: string): boolean {
  return TOOL_RESPONSE_DOCUMENT_MIME_TYPES.has(mimeType.toLowerCase());
}

export function isSupportedToolResponseMimeType(mimeType: string): boolean {
  return isToolResponseImageMimeType(mimeType) || isToolResponseDocumentMimeType(mimeType);
}


/** 把内部 inlineData 转成 base64 data URL（不处理远程 URL/link）。 */
export function toBase64DataUrl(inlineData: Pick<Base64InlineData, 'mimeType' | 'data'>): string {
  return `data:${inlineData.mimeType};base64,${inlineData.data}`;
}

/** 解析 base64 data URL（不处理远程 URL/link）。 */
export function parseBase64DataUrl(value: unknown): Base64InlineData | undefined {
  if (typeof value !== 'string') return undefined;
  const matched = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/is.exec(value);
  if (!matched) return undefined;
  return {
    mimeType: matched[1],
    data: matched[2],
  };
}


/** PDF 原生直传: Gemini, Claude, OpenAI Responses */
export function supportsNativePDF(config?: Pick<LLMConfig, 'provider'>): boolean {
  if (!config) return false;
  return config.provider === 'gemini' || config.provider === 'claude' || config.provider === 'openai-responses';
}

/** Office 原生直传: OpenAI Responses only */
export function supportsNativeOffice(config?: Pick<LLMConfig, 'provider'>): boolean {
  if (!config) return false;
  return config.provider === 'openai-responses';
}

const VISION_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-turbo/i,
  /gemini/i,
  /claude-3/i,
  /claude-sonnet-4/i,
  /claude-opus-4/i,
  /qwen.*vl/i,
  /glm-4v/i,
  /minicpm-v/i,
  /pixtral/i,
  /llava/i,
  /(?:^|[-_/])vision(?:[-_/]|$)/i,
];

export function supportsVision(config?: Pick<LLMConfig, 'model' | 'supportsVision'>): boolean {
  if (!config) return false;
  if (typeof config.supportsVision === 'boolean') {
    return config.supportsVision;
  }
  return VISION_PATTERNS.some((pattern) => pattern.test(config.model ?? ''));
}
