import { TextDecoder } from 'node:util';
import { LlmEventType } from '../world/modules/llm/events';
import type { LlmStartRequest, PromptMessage, ToolSchema } from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';

export const LIMCODE_OPENAI_API_KEY_SECRET = 'limcode.openAiCompatible.apiKey';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'deepseek-v4-flash';

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatCompletionMessage[];
  stream: boolean;
  temperature?: number;
  tools?: OpenAiToolDefinition[];
}

interface ChatCompletionResponseLike {
  choices?: Array<{
    message?: { content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

type MaybeProvider<T> = T | undefined | (() => T | undefined | Promise<T | undefined>);

export interface OpenAiCompatibleLlmOptions {
  apiKey: MaybeProvider<string>;
  baseUrl?: MaybeProvider<string>;
  model?: MaybeProvider<string>;
  temperature?: MaybeProvider<number>;
  enableTools?: MaybeProvider<boolean>;
  headers?: MaybeProvider<Record<string, string>>;
}

export function createOpenAiCompatibleLlmCapability(options: OpenAiCompatibleLlmOptions): LlmCapability {
  return {
    start(request, emit) {
      void startOpenAiCompatibleLlm(request, emit, options);
    }
  };
}

export async function startOpenAiCompatibleLlm(
  request: LlmStartRequest,
  emit: Emit,
  options: OpenAiCompatibleLlmOptions
): Promise<void> {
  try {
    const apiKey = await resolveMaybe(options.apiKey);
    if (!apiKey) {
      emitLlmError(
        emit,
        request.id,
        'Missing OpenAI-compatible API key. Run "LimCode: Configure OpenAI Compatible API Key" or set LIMCODE_OPENAI_API_KEY / DEEPSEEK_API_KEY.'
      );
      return;
    }

    const baseUrl = (await resolveMaybe(options.baseUrl)) ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
    const configuredModel = (await resolveMaybe(options.model)) ?? DEFAULT_OPENAI_COMPATIBLE_MODEL;
    const temperature = request.model?.temperature ?? (await resolveMaybe(options.temperature));
    const enableTools = (await resolveMaybe(options.enableTools)) ?? false;
    const extraHeaders = (await resolveMaybe(options.headers)) ?? {};

    const body: ChatCompletionRequestBody = {
      model: request.model?.model ?? configuredModel,
      messages: toChatCompletionMessages(request.messages),
      stream: true,
      ...(temperature === undefined ? {} : { temperature })
    };

    if (enableTools && request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAiToolDefinition);
    }

    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      emitLlmError(emit, request.id, `LLM request failed (${response.status}): ${message}`);
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const json = await response.json() as ChatCompletionResponseLike;
      emitNonStreamingResponse(request.id, json, emit);
      return;
    }

    await emitStreamingResponse(request.id, response, emit);
  } catch (error) {
    emitLlmError(emit, request.id, error instanceof Error ? error.message : String(error));
  }
}

function toChatCompletionMessages(messages: PromptMessage[]): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [];
  for (const message of messages) {
    if (!message.content.trim()) continue;
    if (message.role === 'system' || message.role === 'user' || message.role === 'assistant') {
      out.push({ role: message.role, content: message.content });
    } else {
      // 基础链路暂不传 OpenAI tool role（需要 tool_call_id）。先把工具结果作为普通上下文保留。
      out.push({ role: 'user', content: `Tool result:\n${message.content}` });
    }
  }

  if (out.length === 0) {
    out.push({ role: 'user', content: 'Hello' });
  }

  return out;
}

function toOpenAiToolDefinition(tool: ToolSchema): OpenAiToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  };
}

async function emitStreamingResponse(requestId: string, response: Response, emit: Emit): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    emitLlmError(emit, requestId, 'LLM response body is empty.');
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  const emitDone = (): void => {
    if (!terminal) {
      terminal = true;
      emit({ type: LlmEventType.Done, payload: { requestId } });
    }
  };
  const emitError = (message: string): void => {
    if (!terminal) {
      terminal = true;
      emitLlmError(emit, requestId, message);
    }
  };

  for (;;) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    if (terminal) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (terminal) break;
      handleSseLine(line, requestId, emit, emitDone, emitError);
    }
  }

  if (!terminal && buffer.trim()) {
    handleSseLine(buffer, requestId, emit, emitDone, emitError);
  }

  if (!terminal) emitDone();
}

function handleSseLine(line: string, requestId: string, emit: Emit, emitDone: () => void, emitError: (message: string) => void): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return;
  if (!trimmed.startsWith('data:')) return;

  const data = trimmed.slice('data:'.length).trim();
  if (!data) return;
  if (data === '[DONE]') {
    emitDone();
    return;
  }

  let chunk: ChatCompletionResponseLike;
  try {
    chunk = JSON.parse(data) as ChatCompletionResponseLike;
  } catch {
    return;
  }

  if (chunk.error?.message) {
    emitError(chunk.error.message);
    return;
  }

  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta?.content ?? choice.message?.content;
    if (delta) {
      emit({ type: LlmEventType.Delta, payload: { requestId, text: delta } });
    }
  }
}

function emitNonStreamingResponse(requestId: string, json: ChatCompletionResponseLike, emit: Emit): void {
  if (json.error?.message) {
    emitLlmError(emit, requestId, json.error.message);
    return;
  }

  const content = json.choices?.map((choice) => choice.message?.content ?? choice.delta?.content ?? '').join('') ?? '';
  if (content) {
    emit({ type: LlmEventType.Delta, payload: { requestId, text: content } });
  }
  emit({ type: LlmEventType.Done, payload: { requestId } });
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText || 'Unknown error';
  try {
    const parsed = JSON.parse(text) as ChatCompletionResponseLike;
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function resolveMaybe<T>(value: MaybeProvider<T>): Promise<T | undefined> {
  if (typeof value === 'function') {
    return (value as () => T | undefined | Promise<T | undefined>)();
  }
  return value;
}

function emitLlmError(emit: Emit, requestId: string, message: string): void {
  emit({ type: LlmEventType.Error, payload: { requestId, message } });
}
