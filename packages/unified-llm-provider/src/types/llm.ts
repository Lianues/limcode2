/**
 * LLM 请求 / 响应类型定义
 *
 * 内部统一使用 Gemini 格式。各 LLM Provider 负责与自身 API 格式互转。
 */

import { Content, Part, UsageMetadata, FunctionCallPart } from './message.js';
import { FunctionDeclaration } from './tool.js';

export interface LLMThinkingConfig {
  /** 是否要求 Gemini 返回 thought parts。仅 Gemini 原生生效；其它 provider 会忽略该统一字段。 */
  includeThoughts?: boolean;
  /** 思考预算 token。Gemini 原生透传；Claude 映射为 thinking.budget_tokens；OpenAI 系默认忽略。 */
  thinkingBudget?: number;
  /** 思考强度等级。当前 Gemini 原生透传；Claude/OpenAI 系默认忽略。 */
  thinkingLevel?: string;
  /** 推理模式。仅 OpenAI Responses 映射为 reasoning.mode；支持 standard/pro。 */
  reasoningMode?: string;
  [key: string]: unknown;
}

/** 统一生成参数（允许 provider 扩展字段） */
export interface LLMGenerationConfig {
  /** 控制随机性。映射到 OpenAI/Claude temperature、Gemini generationConfig.temperature。 */
  temperature?: number;
  /** nucleus sampling。统一使用 Gemini 风格 topP，映射到 OpenAI/Claude top_p。 */
  topP?: number;
  /** token 候选采样数。Gemini 原生 topK，Claude 映射到 top_k；OpenAI 系默认不映射。 */
  topK?: number;
  /** 最大输出 token。映射到 OpenAI Chat/Claude max_tokens、OpenAI Responses max_output_tokens。 */
  maxOutputTokens?: number;
  stopSequences?: string[];
  /**
   * 统一思考配置。
   * 规则：传入 thinkingBudget 或 thinkingLevel 时，Gemini 会自动视为 includeThoughts=true；
   * Claude 只映射 thinkingBudget；OpenAI 系默认忽略整个 thinkingConfig。
   */
  thinkingConfig?: LLMThinkingConfig;
  /**
   * 允许暂存后续统一字段或 provider 扩展字段；真正无损透传请优先使用 LLMConfig.requestBody。
   */
  [key: string]: unknown;
}

/** LLM 请求体（Gemini generateContent 格式） */
export interface LLMRequest {
  contents: Content[];
  tools?: {
    functionDeclarations: FunctionDeclaration[];
  }[];
  systemInstruction?: {
    parts: Part[];
  };
  generationConfig?: LLMGenerationConfig;
}

/**
 * 上游原生错误透传信息。
 *
 * 设计目标：只标记“这是错误”，并尽量保留 HTTP 响应体 / SSE 原始块，
 * 不把各家 provider 的错误结构强行转换成统一错误码。
 */
export interface LLMRawErrorInfo {
  /** 错误来源类型，便于前端决定展示样式。 */
  kind:
    | 'http_error'
    | 'response_error'
    | 'stream_error'
    | 'stream_parse_error'
    | 'stream_read_error'
    | 'decode_error';
  /** HTTP 状态码。仅 HTTP 层可用。 */
  status?: number;
  /** HTTP 状态文本。 */
  statusText?: string;
  /** HTTP 响应头，转为普通对象后透传。 */
  headers?: Record<string, string>;
  /** 完整响应体文本。HTTP 错误或非 JSON 响应时可用。 */
  bodyText?: string;
  /** 响应体 JSON 解析结果；解析失败时不设置，bodyText 仍保留原文。 */
  rawBody?: unknown;
  /** SSE 事件名，流式错误块里可用。 */
  event?: string;
  /** SSE data 原文。 */
  data?: string;
  /** SSE JSON 解析后的原始块。 */
  rawChunk?: unknown;
  /** 上游结构化错误码，例如 OpenAI WebSocket error event 的 error.code。 */
  code?: string;
  /** 传输类型。当前仅 WebSocket 错误需要额外标记。 */
  transport?: 'websocket';
  /** WebSocket 请求失败时所处的阶段。 */
  phase?: 'connecting' | 'sending_response_create' | 'awaiting_first_event' | 'streaming';
  /** WebSocket 标准关闭码。 */
  closeCode?: number;
  /** WebSocket 服务端关闭原因。 */
  closeReason?: string;
  /** WebSocket CloseEvent.wasClean。 */
  closeWasClean?: boolean;
  /** 关闭或读取失败前是否已经收到过服务端事件。 */
  receivedServerEvent?: boolean;
  /** 当前物理连接尝试序号，从 1 开始。 */
  attempt?: number;
  /** 当前请求允许的最大物理连接尝试数。 */
  maxAttempts?: number;
  /** 该错误是否适合由上层策略再次尝试。 */
  retryable?: boolean;
  /** 本库内部解析/读取失败时的错误文本；不替代 rawBody/rawChunk。 */
  message?: string;
}

/** LLM 响应（统一格式） */
export interface LLMResponse {
  /** 模型返回的消息内容 */
  content: Content;
  /** 结束原因 */
  finishReason?: string;
  /** Token 用量统计 */
  usageMetadata?: UsageMetadata;
  /** 上游报错时原生透传的错误信息；正常响应不设置。 */
  error?: LLMRawErrorInfo;
  /** 上游原始响应体；成功路径通常不设置，错误路径尽量保留。 */
  rawResponse?: unknown;
}

/** 压缩端点返回的统一结果。contents 是压缩后的下一轮上下文窗口。 */
export interface LLMCompactResponse {
  /** provider compact response id，例如 resp_... */
  id?: string;
  /** provider 原始 object，例如 response.compaction */
  object?: string;
  /** 创建时间。OpenAI Responses 为秒级 Unix timestamp。 */
  createdAt?: number;
  /** compact 后的上下文窗口，可由客户端继续维护并传回本包调用。 */
  contents: Content[];
  /** 压缩过程 token 用量 */
  usageMetadata?: UsageMetadata;
  /** 原始 provider 响应，调试或完全保真时可用。 */
  rawResponse?: unknown;
}

/** 流式响应的单个数据块 */
export interface LLMStreamChunk {
  /** 本块新增的有序 parts（优先使用） */
  partsDelta?: Part[];
  /** 本块新增的文本 */
  textDelta?: string;
  /** 完整的函数调用（通常在最后一块或专用块中出现） */
  functionCalls?: FunctionCallPart[];
  /** 结束原因（最后一块） */
  finishReason?: string;
  /** Token 用量（最后一块） */
  usageMetadata?: UsageMetadata;
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
  /** 上游报错时原生透传的错误信息；正常 chunk 不设置。 */
  error?: LLMRawErrorInfo;
  /** 上游原始 SSE 块；错误 chunk 会尽量保留。 */
  rawChunk?: unknown;
}
