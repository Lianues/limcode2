import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { LlmRequest, Message, Streaming } from '../chat/components';
import { LlmInvocation } from '../llm/components';
import type { ContentPart, MessageContent, MessageStopReason } from '../../../../shared/protocol';

export type RunLlmCleanupReasonKind =
  | 'paused'
  | 'user_cancelled'
  | 'stale'
  | 'retry_replaced'
  | 'regenerate_replaced'
  | 'new_message_replaced'
  | 'source_edit_cancelled'
  | 'source_edit_stale';

export interface RunLlmCleanupReason {
  kind: RunLlmCleanupReasonKind;
}

/**
 * 终止某个 run 关联的全部 LLM request：
 * 1. 发出 llm.abort effect 让 runtime 真正中断底层流；
 * 2. 把流式中的 model message 标记为 error；
 * 3. 移除 Streaming 并 despawn 对应 LlmRequest。
 */
export function cleanupRunLlmRequests(world: WorldReader, cmd: CommandSink, run: Entity, reason: RunLlmCleanupReason): void {
  const stopNote = noteForCleanupReason(reason.kind);
  const stopReason = stopReasonForCleanupReason(reason.kind);
  for (const request of world.query(LlmRequest)) {
    const data = world.get(request, LlmRequest);
    if (!data || data.run !== run) continue;

    cmd.effect({ kind: 'llm.abort', requestId: data.id });

    const modelMessage = world.get(data.modelMessage, Message);
    if (modelMessage) {
      cmd.add(data.modelMessage, Message, {
        ...modelMessage,
        status: 'error',
        stopReason,
        content: appendStopNote(modelMessage.content, stopNote)
      });
    }

    if (data.invocation !== undefined) {
      const invocation = world.get(data.invocation, LlmInvocation);
      if (invocation) {
        cmd.add(data.invocation, LlmInvocation, { ...invocation, status: 'cancelled', completedAt: Date.now(), error: stopNote });
      }
    }

    cmd.remove(data.modelMessage, Streaming);
    cmd.despawn(request);
  }
}

function appendStopNote(content: MessageContent, note: string): MessageContent {
  const parts = [...content.parts];
  const last = parts[parts.length - 1];
  const noteText = parts.length === 0 ? note : `\n\n${note}`;
  if (last && 'text' in last && last.text === noteText) return content;
  parts.push({ text: noteText } satisfies ContentPart);
  return { ...content, parts };
}

function stopReasonForCleanupReason(kind: RunLlmCleanupReasonKind): MessageStopReason {
  switch (kind) {
    case 'paused':
      return 'paused';
    case 'user_cancelled':
      return 'cancelled';
    case 'stale':
    case 'source_edit_stale':
      return 'stale';
    case 'retry_replaced':
    case 'regenerate_replaced':
    case 'new_message_replaced':
    case 'source_edit_cancelled':
      return 'replaced';
  }
}

function noteForCleanupReason(kind: RunLlmCleanupReasonKind): string {
  switch (kind) {
    case 'paused':
      return '[任务已暂停] 当前回复已暂停，可稍后恢复继续执行。';
    case 'user_cancelled':
      return '[任务已终止] 已手动停止当前回复。';
    case 'stale':
      return '[任务已失效] 当前上下文已变化，本次回复已停止。';
    case 'retry_replaced':
      return '[任务已替换] 已启动新的重试任务。';
    case 'regenerate_replaced':
      return '[任务已替换] 已启动新的重新生成任务。';
    case 'new_message_replaced':
      return '[任务已替换] 因有新消息到达，当前回复已停止。';
    case 'source_edit_cancelled':
      return '[任务已替换] 因源消息已修改，当前回复已停止。';
    case 'source_edit_stale':
      return '[任务已失效] 因源消息已修改，当前回复已失效。';
  }
}
