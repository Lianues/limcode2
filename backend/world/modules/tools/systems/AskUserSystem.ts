import { defineQuery, defineSystem, type Entity } from '../../../../ecs/types';
import { normalizeAskUserToolRequest, resolveAskUserAnswer } from '../../../../../shared/askUser';
import { ASK_USER_TOOL_NAME } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { toolCallEntityById } from '../../agentRun/queries';
import { InFlight } from '../../chat/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState } from '../components';
import { ToolEventType } from '../events';
import { transitionToolState } from '../state';

const AwaitingAskUserCallsQuery = defineQuery({
  name: 'AwaitingAskUserCalls',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState],
  write: [ToolState],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

/** 把用户提交的结构化回答写成 ask_user 工具结果；后续仍由 ToolResultSystem 统一回传给模型。 */
export const AskUserSystem = defineSystem({
  name: 'AskUserSystem',
  shouldRun(ctx) {
    return readEvents(ctx, ToolEventType.AskUserAnswerSubmitted).length > 0;
  },
  access: {
    queries: [AwaitingAskUserCallsQuery],
    bundles: [ToolCallEventBundle],
    events: { read: [ToolEventType.AskUserAnswerSubmitted] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const handled = new Set<Entity>();

    for (const payload of readEvents(ctx, ToolEventType.AskUserAnswerSubmitted)) {
      const entity = toolCallEntityById(world, payload.toolCallId);
      if (entity === undefined || handled.has(entity)) continue;

      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state || call.name !== ASK_USER_TOOL_NAME || state.status !== 'awaiting_user_input') continue;

      try {
        const request = normalizeAskUserToolRequest(call.argsJson);
        const output = resolveAskUserAnswer(request, payload.answer);
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
        handled.add(entity);
      } catch (error) {
        // 前端与后端共用同一套校验；非法或过期提交保持等待状态，避免错误输入终止整个 AgentRun。
        console.warn('[LimCode] Ignored invalid ask_user answer:', error);
      }
    }
  }
});
