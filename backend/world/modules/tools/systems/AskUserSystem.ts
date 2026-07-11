import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { normalizeAskUserToolRequest, resolveAskUserAnswer } from '../../../../../shared/askUser';
import { ASK_USER_TOOL_NAME, type AskUserAnswerRecord } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import {
  runForToolCall,
  runTarget,
  toolCallEntityById
} from '../../agentRun/queries';
import {
  AgentRunTargetLink,
  ToolCallRunLink
} from '../../agentRun/components';
import { Conversation, InFlight } from '../../chat/components';
import { ChatEventType } from '../../chat/events';
import { OpenConversationPanelIdsKey } from '../../chat/resources';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState, type ToolCallData, type ToolStateData } from '../components';
import { ToolEventType } from '../events';
import { transitionToolState } from '../state';

export const BACKGROUND_ASK_USER_AUTO_ANSWER = '请根据现有上下文自行选择最优方案并继续执行，无需等待用户确认。';

const AwaitingAskUserCallsQuery = defineQuery({
  name: 'AwaitingAskUserCalls',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState],
  write: [ToolState],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

/**
 * 把用户提交或后台策略生成的结构化回答写成 ask_user 工具结果；
 * 后续仍由 ToolResultSystem 统一回传给模型。
 */
export const AskUserSystem = defineSystem({
  name: 'AskUserSystem',
  shouldRun(ctx) {
    return readEvents(ctx, ToolEventType.AskUserAnswerSubmitted).length > 0
      || readEvents(ctx, ChatEventType.ConversationPanelPresenceChanged).length > 0
      || ctx.world.query(ToolCall, ToolState).some((entity) => isAwaitingBackgroundAskUserCall(ctx.world, entity));
  },
  access: {
    queries: [AwaitingAskUserCallsQuery],
    reads: {
      components: [
        ToolCallRunLink,
        AgentRunTargetLink,
        Conversation
      ],
      resources: [OpenConversationPanelIdsKey]
    },
    bundles: [ToolCallEventBundle],
    events: { read: [ToolEventType.AskUserAnswerSubmitted, ChatEventType.ConversationPanelPresenceChanged] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    // 显式用户回答优先；若提交与面板关闭恰好发生在同一 tick，不覆盖用户已经作出的选择。
    for (const payload of readEvents(ctx, ToolEventType.AskUserAnswerSubmitted)) {
      const entity = toolCallEntityById(world, payload.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;

      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || call.name !== ASK_USER_TOOL_NAME || state.status !== 'awaiting_user_input') continue;
      if (completeAskUserCall(cmd, entity, call, state, payload.answer)) handled.add(entity);
    }

    for (const entity of world.query(ToolCall, ToolState)) {
      if (handled.has(entity) || !isAwaitingBackgroundAskUserCall(world, entity)) continue;
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state) continue;
      if (completeAskUserCall(cmd, entity, call, state, {
        selectedOptionIndexes: [],
        customText: BACKGROUND_ASK_USER_AUTO_ANSWER
      })) {
        handled.add(entity);
      }
    }
  }
});

export function isAwaitingBackgroundAskUserCall(world: WorldReader, entity: Entity): boolean {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  if (!call || !state || call.name !== ASK_USER_TOOL_NAME || state.status !== 'awaiting_user_input') return false;

  const run = runForToolCall(world, entity);
  if (run === undefined) return false;

  const openConversationIds = world.tryGetResource(OpenConversationPanelIdsKey);
  if (!openConversationIds) return false;
  // 主/子 Agent 统一按自己的目标 conversation 标签页判定；来源/父对话不代替该 Agent 回答。
  const target = runTarget(world, run);
  if (!target) return false;
  const conversationId = world.get(target.conversation, Conversation)?.id;
  if (!conversationId) return false;
  return !openConversationIds.includes(conversationId);
}

function completeAskUserCall(
  cmd: CommandSink,
  entity: Entity,
  call: ToolCallData,
  state: ToolStateData,
  answer: AskUserAnswerRecord
): boolean {
  try {
    const request = normalizeAskUserToolRequest(call.argsJson);
    const output = resolveAskUserAnswer(request, answer);
    const now = Date.now();
    const durationMs = Math.max(0, now - call.createdAt);
    const result = { ok: true, output };
    cmd.add(entity, ToolState, transitionToolState(state, 'success', { result, durationMs }, now));
    cmd.remove(entity, InFlight);
    spawnToolCallEvent(cmd, {
      toolCall: entity,
      toolCallId: call.id,
      kind: 'completed',
      status: 'success',
      at: now,
      elapsedMs: durationMs,
      durationMs,
      payload: output
    });
    return true;
  } catch (error) {
    // 前后端共用同一套校验；非法或过期回答保持等待状态，避免错误输入终止整个 AgentRun。
    console.warn('[LimCode] Ignored invalid ask_user answer:', error);
    return false;
  }
}
