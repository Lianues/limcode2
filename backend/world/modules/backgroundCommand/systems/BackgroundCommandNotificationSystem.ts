import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../../agent/components';
import { AgentRun, AgentRunTargetLink, ToolCallRunLink } from '../../agentRun/components';
import { AgentRunBundle } from '../../agentRun/bundles';
import { AgentRunEventType } from '../../agentRun/events';
import { spawnAgentRunNotification } from '../../agentRun/notificationDelivery';
import { defaultAgentForConversation, findConversationById, runForToolCall, runTarget, toolCallEntityById } from '../../agentRun/queries';
import { Conversation } from '../../chat/components';
import { UserMessageBundle } from '../../chat/bundles';
import { ToolCall } from '../../tools/components';
import { simplifyToolResponseForModel } from '../../tools/responseSimplifier';
import { BackgroundCommandEventType, type BackgroundCommandExitedPayload } from '../events';

export const BackgroundCommandNotificationSystem = defineSystem({
  name: 'BackgroundCommandNotificationSystem',
  shouldRun(ctx) {
    return readEvents(ctx, BackgroundCommandEventType.Exited).length > 0;
  },
  access: {
    reads: {
      components: [
        Agent,
        AgentConversationLink,
        ConversationAgentSelection,
        AgentRun,
        AgentRunTargetLink,
        ToolCallRunLink,
        Conversation,
        ToolCall
      ]
    },
    bundles: [AgentRunBundle, UserMessageBundle],
    events: { read: [BackgroundCommandEventType.Exited], emit: [AgentRunEventType.Promote] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, BackgroundCommandEventType.Exited)) {
      const target = resolveBackgroundCommandTarget(world, payload);
      if (!target) {
        console.warn('[LimCode] Ignored background command exit notification without target conversation:', payload.processId);
        continue;
      }

      spawnAgentRunNotification(world, cmd, {
        conversation: target.conversation,
        ...(target.agent !== undefined ? { agent: target.agent } : {}),
        text: serializedBackgroundCommandExitNotification(payload),
        sourceKind: target.sourceToolCall !== undefined ? 'toolCall' : target.sourceRun !== undefined ? 'agentRun' : 'system',
        ...(target.sourceRun !== undefined ? { sourceRun: target.sourceRun } : {}),
        sourceConversation: target.conversation,
        ...(target.sourceToolCall !== undefined ? { sourceToolCall: target.sourceToolCall } : {}),
        promoteIfActive: true
      });
    }
  }
});

interface ResolvedBackgroundCommandTarget {
  conversation: Entity;
  agent?: Entity;
  sourceRun?: Entity;
  sourceToolCall?: Entity;
}

function resolveBackgroundCommandTarget(world: WorldReader, payload: BackgroundCommandExitedPayload): ResolvedBackgroundCommandTarget | undefined {
  const sourceToolCall = payload.toolCallId ? toolCallEntityById(world, payload.toolCallId) : undefined;
  const sourceRun = payload.runId
    ? findRunById(world, payload.runId)
    : sourceToolCall !== undefined
      ? runForToolCall(world, sourceToolCall)
      : undefined;
  const runResolvedTarget = sourceRun !== undefined ? runTarget(world, sourceRun) : undefined;
  const conversation = runResolvedTarget?.conversation
    ?? (payload.conversationId ? findConversationById(world, payload.conversationId) : undefined);
  if (conversation === undefined) return undefined;
  const agent = runResolvedTarget?.agent ?? defaultAgentForConversation(world, conversation);
  return {
    conversation,
    ...(agent !== undefined ? { agent } : {}),
    ...(sourceRun !== undefined ? { sourceRun } : {}),
    ...(sourceToolCall !== undefined ? { sourceToolCall } : {})
  };
}

function findRunById(world: WorldReader, runId: string): Entity | undefined {
  const normalized = runId.trim();
  if (!normalized) return undefined;
  return world.query(AgentRun).find((entity) => world.get(entity, AgentRun)?.id === normalized);
}

function serializedBackgroundCommandExitNotification(payload: BackgroundCommandExitedPayload): string {
  const toolStatus = payload.exitCode === 0 && !payload.killed ? 'success' : 'error';
  const toolLikeResponse = simplifyToolResponseForModel(payload.toolName, toolStatus, {
    command: payload.command,
    exitCode: payload.exitCode,
    killed: payload.killed,
    stdout: payload.stdout,
    stderr: payload.stderr,
    status: payload.status,
    processId: payload.processId,
    running: false,
    ...(payload.droppedChars !== undefined && payload.droppedChars > 0 ? { droppedChars: payload.droppedChars } : {})
  });

  return [
    '[Background command exited]',
    '后台 shell/bash 命令已结束。下面是按普通 shell 工具响应规则精简后的结果，请把它当作该后台命令主动返回给当前对话的结果：',
    JSON.stringify(toolLikeResponse, null, 2),
    '处理要求：请基于这次后台命令结果继续处理；不要重复启动同一个命令。如确实需要更多或更新日志，可调用 shell/bash 的 mode=output 并传入结果中的 processId。'
  ].join('\n\n');
}
