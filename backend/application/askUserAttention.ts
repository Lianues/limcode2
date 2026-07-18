import { askUserRequestFromArgs } from '../../shared/askUser';
import { ASK_USER_TOOL_NAME } from '../../shared/protocol';
import type { WorldReader } from '../ecs/types';
import { runForToolCall, runTarget } from '../world/modules/agentRun/queries';
import { Conversation } from '../world/modules/chat/components';
import { OpenConversationPanelIdsKey } from '../world/modules/chat/resources';
import { ToolCall, ToolState } from '../world/modules/tools/components';
import { ConversationAttentionTracker, compactAttentionText } from './conversationAttention';

export interface PendingAskUserAttention {
  conversationId: string;
  conversationTitle?: string;
  questionCount: number;
  firstQuestion?: string;
  firstCreatedAt: number;
}

/**
 * 按 AgentRun 自己的目标 conversation 标签页聚合待回答问题。
 * 未打开标签页的 ask_user 会由 AskUserSystem 自动回答，不应弹出用户通知。
 */
export function collectPendingAskUserAttention(world: WorldReader): PendingAskUserAttention[] {
  const openConversationIds = new Set(world.tryGetResource(OpenConversationPanelIdsKey) ?? []);
  if (openConversationIds.size === 0) return [];

  const grouped = new Map<string, PendingAskUserAttention>();
  for (const entity of world.query(ToolCall, ToolState)) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || state?.status !== 'awaiting_user_input' || call.name !== ASK_USER_TOOL_NAME) continue;

    const run = runForToolCall(world, entity);
    const target = run === undefined ? undefined : runTarget(world, run);
    const conversation = target ? world.get(target.conversation, Conversation) : undefined;
    const conversationId = conversation?.id;
    if (!conversationId || !openConversationIds.has(conversationId)) continue;

    const request = askUserRequestFromArgs(call.argsJson);
    const existing = grouped.get(conversationId);
    if (existing) {
      existing.questionCount += 1;
      if (call.createdAt < existing.firstCreatedAt) {
        existing.firstCreatedAt = call.createdAt;
        existing.firstQuestion = request?.question;
      }
      continue;
    }

    grouped.set(conversationId, {
      conversationId,
      ...(conversation.title?.trim() ? { conversationTitle: conversation.title.trim() } : {}),
      questionCount: 1,
      ...(request?.question ? { firstQuestion: request.question } : {}),
      firstCreatedAt: call.createdAt
    });
  }

  return [...grouped.values()].sort((left, right) =>
    left.firstCreatedAt - right.firstCreatedAt || left.conversationId.localeCompare(right.conversationId)
  );
}

/** 保留原导出名称；实际去重逻辑与 Plan 审批提醒共用。 */
export class AskUserAttentionTracker extends ConversationAttentionTracker<PendingAskUserAttention> {}

export function askUserAttentionMessage(request: PendingAskUserAttention): string {
  const tabLabel = request.conversationTitle?.trim() || '当前对话';
  if (request.questionCount > 1) {
    return `LimCode：标签页“${compactAttentionText(tabLabel, 36)}”有 ${request.questionCount} 个问题等待回答。`;
  }
  const question = request.firstQuestion?.trim();
  return question
    ? `LimCode 需要你的回答：${compactAttentionText(question, 96)}`
    : `LimCode：标签页“${compactAttentionText(tabLabel, 36)}”有问题等待回答。`;
}
