/**
 * 消息类型定义 —— 采用 Gemini 格式作为内部统一数据格式
 *
 * 所有模块之间传递的消息数据均使用此格式。
 * 对于非 Gemini 的 LLM 提供商（如 OpenAI），在 LLM 调用层进行格式转换。
 */

import type { ToolDiffPreviewResponseLike } from '../plugin/tool-preview.js';

/** 文本部分 */
export interface TextPart {
  text?: string;
  /** Gemini thinking 文本块 */
  thought?: boolean;
  /** 便于用户直接存取的单字符串签名形式，如 gemini:abc / claude:def */
  thoughtSignature?: string;
  /** 不同渠道格式的思考签名 */
  thoughtSignatures?: {
    gemini?: string;
    claude?: string;
    'openai-compatible'?: string;
    'openai-responses'?: string;
    [key: string]: string | undefined;
  };
  /** 连续 thought 片段的累计耗时（毫秒） */
  thoughtDurationMs?: number;
}

/**
 * Provider 原生上下文状态项。
 *
 * 用于保存 compact / cache / opaque state 等无法跨厂商语义化转换、但需要在同一
 * provider / wire format 后续调用中原样回放的内容。
 */
export interface ProviderContextItem {
  /** 厂商命名，例如 openai / anthropic / google / deepseek */
  provider: string;
  /** wire format / 接口族，例如 openai-responses / claude */
  format: string;
  /** 产生或适用的接口，例如 responses.compact / responses */
  endpoint?: string;
  /** provider 原生 item.type，例如 compaction / message / reasoning */
  itemType: string;
  /** provider 原生 item id */
  id?: string;
  /** 常见不透明加密上下文内容的便捷字段 */
  encryptedContent?: string;
  /** provider 原生 item；目标 format 匹配时应优先原样回放 */
  rawItem: unknown;
}

/** Provider 原生上下文状态 part（如 OpenAI Responses compaction item） */
export interface ProviderContextPart {
  providerContext: ProviderContextItem;
}

/** 内联数据部分（图片等二进制数据，base64 编码） */
export interface InlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
    /** 原始文件名（存储用，发送给 LLM 时剥离） */
    name?: string;
  };
}

/** 函数调用部分（由模型发出） */
export interface FunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
    /** provider 原生工具调用 ID（OpenAI tool_call.id / Responses call_id / Claude tool_use.id） */
    callId?: string;
  };
}

/** 函数响应部分（工具执行结果，回传给模型） */
export interface FunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
    /** 对应的 provider 原生工具调用 ID，需与上一轮 functionCall.callId 对齐 */
    callId?: string;
    /** 工具结果附带的多模态内联数据（截图、音频等），对齐 Gemini FunctionResponse.parts */
    parts?: InlineDataPart[];
    /** 工具执行耗时（毫秒），存储用，不发送给 LLM */
    durationMs?: number;
    /** 工具 diff 预览（存储用，不发送给 LLM，仅供前端展示） */
    diffPreview?: ToolDiffPreviewResponseLike;
  };
}

/** 消息部分的联合类型 */
export type Part = TextPart | InlineDataPart | FunctionCallPart | FunctionResponsePart | ProviderContextPart;

/** 消息角色 */
export type Role = 'user' | 'model';

/** API 调用的 Token 用量统计 */
export interface CacheCreationInputTokensDetails {
  /** Claude: usage.cache_creation.ephemeral_5m_input_tokens */
  ephemeral5mInputTokenCount?: number;
  /** Claude: usage.cache_creation.ephemeral_1h_input_tokens */
  ephemeral1hInputTokenCount?: number;
}

export interface UsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** Gemini thoughtsTokenCount / Claude thinking_tokens / OpenAI reasoning_tokens */
  thoughtsTokenCount?: number;
  /** Claude: usage.cache_creation_input_tokens，已包含在 promptTokenCount 内 */
  cacheCreationInputTokenCount?: number;
  /** Claude: usage.cache_creation 的小时级/TTL 级缓存创建明细 */
  cacheCreationInputTokensDetails?: CacheCreationInputTokensDetails;
}

/** 一条消息内容（Gemini Content 格式） */
export interface Content {
  role: Role;
  parts: Part[];
  /** provider 原生顶层 item 元数据；同 format 回放时可用于保留 id/status/phase 等字段 */
  providerContext?: ProviderContextItem;
  /** 该轮 API 调用的 Token 用量（存储用，组装请求时剥离） */
  usageMetadata?: UsageMetadata;
  /** 本轮响应耗时（毫秒），存储用 */
  durationMs?: number;
  /** 流式输出阶段耗时（从首个有效流式块到最后一个有效流式块，毫秒） */
  streamOutputDurationMs?: number;
  /** 产生该消息的 AI 模型名称（例如：gemini-2.5-flash），用于历史回显 */
  modelName?: string;
  /** 消息创建时间戳（毫秒），用户消息为发送时间，模型消息为首个流式块或非流响应到达时间 */
  createdAt?: number;
  /** 是否为上下文总结消息（/compact 生成），后续 LLM 调用仅从最后一条总结消息开始加载上下文 */
  isSummary?: boolean;
}

// ============ 类型守卫工具函数 ============

export function isTextPart(part: Part): part is TextPart {
  return 'text' in part || 'thought' in part || 'thoughtSignature' in part || 'thoughtSignatures' in part;
}

export function isThoughtTextPart(part: Part): part is TextPart & { thought: true } {
  return 'text' in part && (part as TextPart).thought === true;
}

export function isVisibleTextPart(part: Part): part is TextPart {
  return 'text' in part && (part as TextPart).thought !== true;
}

export function isInlineDataPart(part: Part): part is InlineDataPart {
  return 'inlineData' in part;
}

export function isFunctionCallPart(part: Part): part is FunctionCallPart {
  return 'functionCall' in part;
}

export function isFunctionResponsePart(part: Part): part is FunctionResponsePart {
  return 'functionResponse' in part;
}

export function isProviderContextPart(part: Part): part is ProviderContextPart {
  return 'providerContext' in part;
}

/** 从 Parts 数组中提取所有文本并拼接 */
export function extractText(parts: Part[]): string {
  return parts.filter(isVisibleTextPart).map(p => p.text || '').join('');
}
