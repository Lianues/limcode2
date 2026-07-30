export type FetchLike = typeof fetch;
export type LLMTransportMode = 'http' | 'websocket';

export interface LLMRequestDebugEvent {
  url: string;
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
}

export interface LLMResponseDebugEvent {
  url: string;
  stream: boolean;
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
  error?: string;
}

export interface LLMStreamChunkDebugEvent {
  url: string;
  /** 本块原始文本 chunk */
  chunk: string;
  /** 当前累计已接收的完整文本 */
  accumulated: string;
}

export interface LLMDebugHooks {
  onRequest?(event: LLMRequestDebugEvent): void | Promise<void>;
  onResponse?(event: LLMResponseDebugEvent): void | Promise<void>;
  /** 流式响应每个 SSE chunk 的实时回调 */
  onStreamChunk?(event: LLMStreamChunkDebugEvent): void | Promise<void>;
}

export interface LLMEndpointOverride {
  url?: string;
  streamUrl?: string;
  compactUrl?: string;
  /** OpenAI Responses WebSocket URL；未填时由 url/baseUrl 自动转换为 ws(s)。 */
  webSocketUrl?: string;
  /** 传输模式：默认 HTTP；OpenAI Responses 可选 WebSocket。 */
  transport?: LLMTransportMode;
  /** WebSocket continuation 会话隔离 key，避免不同对话复用同一 previous_response_id。 */
  webSocketSessionKey?: string;
  headers?: Record<string, string>;
  /** 显式指定此 endpoint 使用的 HTTP/HTTPS 代理 */
  proxy?: LLMProxyOption;
}

export interface LLMProxyConfig {
  /** 代理地址，例如 http://127.0.0.1:7890 */
  url: string;
  /** 连接代理服务器时附加的请求头 */
  headers?: Record<string, string>;
}

export type LLMProxyOption = string | LLMProxyConfig;

export type LLMPromptCacheTtl = '5m' | '30m' | '1h';

export type LLMPromptCacheMode = 'key' | 'implicit' | 'explicit';

export interface LLMPromptCacheBreakpoints {
  /** 在系统提示词末尾写入缓存断点。 */
  system?: boolean;
  /** 在工具定义提示词末尾写入缓存断点。 */
  tools?: boolean;
  /** 在本次请求聊天记录末尾写入缓存断点。 */
  messages?: boolean;
}

export interface LLMPromptCacheConfig {
  /** 是否启用 Prompt Cache。 */
  enabled?: boolean;
  /** [OpenAI Responses] 稳定 cache key，用于更可靠的自动缓存匹配。 */
  key?: string;
  /** 缓存 TTL 档位；不同 provider 会自动裁剪到其支持的值。 */
  ttl?: LLMPromptCacheTtl;
  /** [OpenAI Responses] 缓存模式：key=仅发送 prompt_cache_key；implicit/explicit=使用 prompt_cache_options + 显式断点。 */
  mode?: LLMPromptCacheMode;
  /** 需要写入的断点位置；默认三处都启用。 */
  breakpoints?: LLMPromptCacheBreakpoints;
}

export interface LLMConfig {
  provider: string;
  /** 默认使用哪个 wire format；未填则由 provider 自身决定 */
  format?: string;
  apiKey?: string;
  /** 提供商真实模型 id */
  model: string;
  /** 默认 baseUrl。若 endpoint.url 已给定，则可不依赖 baseUrl */
  baseUrl?: string;
  /** 直接覆盖最终 endpoint（优先级高于 provider 默认拼接规则） */
  endpoint?: LLMEndpointOverride;
  /** 模型上下文窗口大小（token 数） */
  contextWindow?: number;
  /** 显式声明当前模型是否支持图片输入 */
  supportsVision?: boolean;
  /** 自定义请求头，会覆盖 provider 内置同名 header */
  headers?: Record<string, string>;
  /** 预留给上层 UI 或客户端的思考控制标记 */
  thinkingControl?: boolean;
  /** 自定义请求体，会深合并到 provider 编码后的最终请求体 */
  requestBody?: Record<string, unknown>;
  /** Prompt Cache 显式断点配置（OpenAI Responses / Claude）。 */
  promptCache?: LLMPromptCacheConfig;
  /** [Deprecated] [Claude] 手动 Prompt Caching */
  promptCaching?: boolean;
  /** [Deprecated] [Claude] 顶层自动缓存 */
  autoCaching?: boolean;
  /** 传输模式：默认 HTTP；OpenAI Responses 可选 WebSocket。 */
  transport?: LLMTransportMode;
  /** WebSocket continuation 会话隔离 key，避免不同对话复用同一 previous_response_id。 */
  webSocketSessionKey?: string;
  /** 自定义 fetch 实现 */
  fetch?: FetchLike;
  /** 显式指定 HTTP/HTTPS 代理，例如 http://127.0.0.1:7890 */
  proxy?: LLMProxyOption;
  /** 调试钩子 */
  debug?: LLMDebugHooks;
  /** 友好名称，可选 */
  name?: string;
  [key: string]: unknown;
}

export interface LLMModelDef extends LLMConfig {
  modelName: string;
}

export interface LLMRegistryConfig {
  defaultModelName: string;
  models: LLMModelDef[];
}
