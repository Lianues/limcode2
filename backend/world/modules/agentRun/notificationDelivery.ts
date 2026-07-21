import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import type { AgentRunSourceKind, MessageContent } from '../../../../shared/protocol';
import { Conversation } from '../chat/components';
import { spawnUserMessage } from '../chat/bundles';
import { spawnAgentRun, spawnMessageRunLink } from './bundles';
import { AgentRunEventType } from './events';
import { conversationHasActiveRun, defaultAgentForConversation } from './queries';

export interface SpawnAgentRunNotificationInput {
  conversation: Entity;
  text: string;
  agent?: Entity;
  sourceKind?: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceConversation?: Entity;
  sourceMessage?: Entity;
  sourceToolCall?: Entity;
  sourceRun?: Entity;
  /** 默认 true：目标对话正在响应时，复用 Promote 语义强制发送通知。 */
  promoteIfActive?: boolean;
}

/**
 * 统一后台通知投递管路：把异步事件物化为 notification AgentRun。
 *
 * 该 helper 只解释调用方传入的关系数据，不持有任何特定领域对象语义；
 * submit_agent_answer、后台 shell 等异步生产者都应复用这里的投递路径。
 */
export function spawnAgentRunNotification(world: WorldReader, cmd: CommandSink, input: SpawnAgentRunNotificationInput): Entity | undefined {
  const text = input.text.trim();
  if (!text) return undefined;

  const agent = input.agent ?? defaultAgentForConversation(world, input.conversation);
  if (agent === undefined) {
    const message = spawnUserMessage(cmd, input.conversation, text);
    if (input.sourceRun !== undefined) spawnMessageRunLink(cmd, { message, run: input.sourceRun, role: 'notification' });
    return undefined;
  }

  const conversation = world.get(input.conversation, Conversation);
  const forcePromoteNotification = input.promoteIfActive !== false
    && !!conversation
    && conversationHasActiveRun(world, input.conversation);
  const queuedInputContent: MessageContent = { role: 'user', parts: [{ text }] };

  const notificationRunId = createStableId('run');
  const notificationRun = spawnAgentRun(cmd, {
    id: notificationRunId,
    kind: 'notification',
    agent,
    conversation: input.conversation,
    sourceKind: input.sourceKind ?? 'system',
    ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
    ...(input.sourceConversation !== undefined ? { sourceConversation: input.sourceConversation } : {}),
    ...(input.sourceMessage !== undefined ? { sourceMessage: input.sourceMessage } : {}),
    ...(input.sourceToolCall !== undefined ? { sourceToolCall: input.sourceToolCall } : {}),
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    deliveryMode: 'direct_reply',
    includeTranscript: 'full',
    needsModel: false,
    queuedInputContent,
    ...(forcePromoteNotification ? { queueHoldReason: 'manual' as const } : {})
  });

  if (forcePromoteNotification && conversation) {
    cmd.enqueue({
      type: AgentRunEventType.Promote,
      payload: { runId: notificationRunId, conversationId: conversation.id }
    });
  }

  return notificationRun;
}
