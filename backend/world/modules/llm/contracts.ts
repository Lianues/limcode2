import type { LlmProviderKind, MessageContent } from '../../../../shared/protocol';

export type { LlmProviderKind };

export interface LlmModelSettings {
  provider: LlmProviderKind;
  model: string;
  temperature?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export interface LlmStartRequest {
  id: string;
  systemInstruction?: MessageContent;
  contents: MessageContent[];
  tools: ToolSchema[];
  model?: LlmModelSettings;
}
