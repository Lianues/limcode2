import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { LlmRequest, Message, Streaming } from '../chat/components';

/**
 * 终止某个 run 关联的全部 LLM request：
 * 1. 发出 llm.abort effect 让 runtime 真正中断底层流；
 * 2. 把流式中的 model message 标记为 error；
 * 3. 移除 Streaming 并 despawn 对应 LlmRequest。
 */
export function cleanupRunLlmRequests(world: WorldReader, cmd: CommandSink, run: Entity, message: string): void {
  for (const request of world.query(LlmRequest)) {
    const data = world.get(request, LlmRequest);
    if (!data || data.run !== run) continue;

    cmd.effect({ kind: 'llm.abort', requestId: data.id });

    const modelMessage = world.get(data.modelMessage, Message);
    if (modelMessage) {
      cmd.add(data.modelMessage, Message, {
        ...modelMessage,
        status: 'error',
        content: {
          ...modelMessage.content,
          parts: modelMessage.content.parts.length === 0 ? [{ text: `[run stopped] ${message}` }] : modelMessage.content.parts
        }
      });
    }

    cmd.remove(data.modelMessage, Streaming);
    cmd.despawn(request);
  }
}
