export interface LlmModelSettings {
  provider: 'fake' | 'openai-compatible' | 'anthropic';
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
