import type { LlmProviderKind } from '../../../../shared/protocol';

export type { LlmProviderKind };

export interface LlmModelSettings {
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LlmStartRequest {
  id: string;
  messages: PromptMessage[];
  tools: ToolSchema[];
  model?: LlmModelSettings;
}
