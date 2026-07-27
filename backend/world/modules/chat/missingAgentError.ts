import type { CommandSink, Entity } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import { conversationClientStateStreamId, createMessageId } from '../../../../shared/protocol';
import { spawnMessage } from './bundles';

export const MISSING_AGENT_ERROR_MESSAGE = '当前对话未选择 Agent，请先选择后再发送消息。';

/** 创建可由现有 LlmErrorBlock 渲染的 model 错误楼层，不创建 AgentRun 或 LLM 请求。 */
export function spawnMissingAgentError(
  cmd: CommandSink,
  conversation: Entity,
  conversationId: string
): Entity {
  const modelMessageId = createStableId('msg');
  const modelMessage = spawnMessage(cmd, {
    id: modelMessageId,
    parent: conversation,
    role: 'model',
    parts: [],
    status: 'error'
  });
  cmd.effect({
    kind: 'client.transientNotice',
    streamId: conversationClientStateStreamId(conversationId),
    payload: {
      id: createMessageId(),
      kind: 'error',
      conversationId,
      messageId: modelMessageId,
      requestId: `missing-agent-${modelMessageId}`,
      message: MISSING_AGENT_ERROR_MESSAGE,
      rawError: {
        code: 'missing_agent',
        message: MISSING_AGENT_ERROR_MESSAGE
      },
      createdAt: Date.now()
    }
  });
  return modelMessage;
}
