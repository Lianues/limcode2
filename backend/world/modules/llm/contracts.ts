import type { LlmInvocationSettingsSnapshotRecord, LlmProviderKind, MessageContent } from '../../../../shared/protocol';

export type { LlmProviderKind };

export interface LlmModelSettings {
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LlmStartRequest {
  id: string;
  invocationId?: string;
  systemInstruction?: MessageContent;
  contents: MessageContent[];
  tools: ToolSchema[];
  conversationId?: string;
  model?: LlmModelSettings;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
}

export interface LlmResolveInvocationRequest {
  invocationId: string;
  requestId: string;
  conversationId?: string;
  model?: LlmModelSettings;
}

export interface LlmDryRunOptions {
  /** true 时 curl 中显示 API Key；默认 false。 */
  includeApiKey?: boolean;
}

export interface LlmDryRunResult {
  provider?: LlmProviderKind;
  model?: string;
  providerName?: string;
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  /** 始终隐藏敏感 header 的 curl，用于前端本地显示/隐藏切换，避免重复 dry-run。 */
  maskedCurl: string;
  inputFormat?: string;
  outputFormat?: string;
  generatedAt: number;
  /** curl 中是否隐藏了 API Key 等敏感 header。 */
  maskedSecrets: boolean;
  /** 当前是否能从配置中取到真实 API Key；false 时 dry-run 使用占位 key 生成请求结构。 */
  apiKeyAvailable?: boolean;
}
