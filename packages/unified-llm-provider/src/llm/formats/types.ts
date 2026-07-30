/**
 * 格式适配器接口
 *
 * 每个渠道格式（Gemini、OpenAI 等）实现此接口，
 * 负责内部 Gemini 格式 ↔ 渠道 API 格式的双向转换。
 */

import { LLMCompactResponse, LLMRequest, LLMResponse, LLMStreamChunk } from '../../types.js';

/** 流式解码跨 chunk 状态（如 OpenAI tool_call 分片累积） */
export interface StreamDecodeState {
  [key: string]: unknown;
}

export interface FormatAdapter {
  /** 编码请求：LLMRequest (Gemini) → 渠道请求体。stream=true 时可注入流式参数 */
  encodeRequest(request: LLMRequest, stream?: boolean): unknown;

  /** 解码非流式响应：渠道原始 JSON → LLMResponse (Gemini) */
  decodeResponse(raw: unknown): LLMResponse;

  /** 解码流式单块：渠道原始 JSON → LLMStreamChunk */
  decodeStreamChunk(raw: unknown, state: StreamDecodeState): LLMStreamChunk;

  /** 创建流式解码状态（每次流式调用前调用） */
  createStreamState(): StreamDecodeState;
}

/** 支持独立 compact / compaction 端点的格式适配器扩展。 */
export interface CompactFormatAdapter extends FormatAdapter {
  /** 编码 compact 请求：LLMRequest (unified) → provider compact 请求体 */
  encodeCompactRequest(request: LLMRequest): unknown;
  /** 解码 compact 响应：provider 原始 JSON → unified compact 结果 */
  decodeCompactResponse(raw: unknown): LLMCompactResponse;
  /** unified compact 结果 → provider 原生 compact 响应（用于 outputFormat=provider format） */
  encodeCompactResponse?(response: LLMCompactResponse): unknown;
}

export function isCompactFormatAdapter(format: FormatAdapter): format is CompactFormatAdapter {
  return typeof (format as Partial<CompactFormatAdapter>).encodeCompactRequest === 'function'
    && typeof (format as Partial<CompactFormatAdapter>).decodeCompactResponse === 'function';
}
