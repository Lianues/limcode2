import { LlmEventType } from '../world/modules/llm/events';
import type { LlmStartRequest, PromptMessage } from '../world/modules/llm/contracts';
import type { Emit, LlmCapability } from './types';

const CHUNK_DELAY_MS = 18;
const CHUNK_SIZE = 4;

export function startFakeLlm(request: LlmStartRequest, emit: Emit): void {
  const lastUser = lastByRole(request.messages, 'user');
  const lastTool = lastByRole(request.messages, 'tool');
  const text = (lastUser?.content ?? '').trim();

  const readMatch = /^\/read\s+(.+)$/.exec(text);
  if (readMatch && !lastTool) {
    const path = readMatch[1].trim();
    setTimeout(() => {
      emit({
        type: LlmEventType.ToolCall,
        payload: {
          requestId: request.id,
          calls: [{ name: 'read_file', argsJson: JSON.stringify({ path }) }]
        }
      });
      emit({ type: LlmEventType.Done, payload: { requestId: request.id } });
    }, CHUNK_DELAY_MS);
    return;
  }

  const reply = lastTool
    ? `已读取文件，内容预览：\n${lastTool.content.split('\n').slice(0, 6).join('\n')}`
    : `（FakeLLM 回显）你说：“${text}”`;
  streamText(request.id, reply, emit);
}

export function createFakeLlmCapability(): LlmCapability {
  return { start: startFakeLlm };
}

function streamText(requestId: string, text: string, emit: Emit): void {
  const chunks = chunkText(text, CHUNK_SIZE);
  let index = 0;
  const next = (): void => {
    if (index >= chunks.length) {
      emit({ type: LlmEventType.Done, payload: { requestId } });
      return;
    }
    emit({ type: LlmEventType.Delta, payload: { requestId, text: chunks[index] } });
    index += 1;
    setTimeout(next, CHUNK_DELAY_MS);
  };
  setTimeout(next, CHUNK_DELAY_MS);
}

function lastByRole(messages: PromptMessage[], role: PromptMessage['role']): PromptMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === role) {
      return messages[i];
    }
  }
  return undefined;
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out.length > 0 ? out : [''];
}
