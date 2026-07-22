import { defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { Conversation, ConversationFullContextLoaded, Message, PartOf } from '../../chat/components';
import { conversationMessages } from '../../chat/queries';
import { LlmInvocation, MessageLlmInvocationLink, type LlmInvocationData } from '../../llm/components';
import { compressionThresholdTokens, observedUsageTokenCount } from '../../llm/usage';
import type { LlmInvocationSettingsSnapshotRecord } from '../../../../../shared/protocol';
import {
  CompressionBlock,
  CompressionBlockLlmInvocationLink,
  CompressionBlockSourceLink
} from '../components';
import { selectLatestClosedCompressionBoundary } from '../selection';
import {
  COMPRESSION_READ_COMPONENTS,
  tryCreateCompressionBlock
} from './CompressionSystem';

interface AutoCompressionCandidate {
  invocationEntity: Entity;
  invocation: LlmInvocationData;
  settings: LlmInvocationSettingsSnapshotRecord;
  conversation: Entity;
  conversationId: string;
  modelMessage: Entity;
  modelMessageId: string;
  modelMessageSeq: number;
  observedTokens: number;
  thresholdTokens: number;
}

/**
 * 根据已经提交到 ECS World 的 invocation / message / tool facts 重评自动压缩。
 *
 * 与 LlmPollSystem 当场发出一次性 create 事件不同，这个 system 会在后续任何 World 变化时继续解释
 * 尚未被压缩块覆盖的超阈值 invocation。临时的流式消息或未闭合工具调用只会让本轮不产生命令，
 * 不会永久吞掉自动压缩请求。
 */
export const AutoCompressionSystem = defineSystem({
  name: 'AutoCompressionSystem',
  access: {
    reads: {
      components: [
        ...COMPRESSION_READ_COMPONENTS,
        MessageLlmInvocationLink,
        ConversationFullContextLoaded
      ]
    },
    writes: {
      components: [CompressionBlock, CompressionBlockSourceLink, LlmInvocation, CompressionBlockLlmInvocationLink],
      mutationMode: 'update'
    },
    effects: { emit: ['llm.compact'] }
  },
  run({ world, cmd }) {
    const candidatesByConversation = collectCandidates(world);

    for (const candidates of candidatesByConversation.values()) {
      const sorted = [...candidates].sort((left, right) =>
        right.modelMessageSeq - left.modelMessageSeq
        || (right.invocation.completedAt ?? right.invocation.createdAt) - (left.invocation.completedAt ?? left.invocation.createdAt)
        || right.invocation.id.localeCompare(left.invocation.id)
      );
      const conversation = sorted[0]?.conversation;
      if (conversation === undefined) continue;
      const messages = conversationMessages(world, conversation);
      // 不能在同一会话仍有模型流式输出时启动压缩；流式结束会再次改变 World 并触发重评。
      if (messages.some((entity) => world.get(entity, Message)?.status === 'streaming')) continue;

      for (const candidate of sorted) {
        if (hasCompressionAttemptAtOrAfter(world, candidate.conversation, candidate.modelMessageSeq)) continue;

        const boundary = selectLatestClosedCompressionBoundary(world, messages, { minSeq: candidate.modelMessageSeq });
        if (!boundary) continue;
        const methodKind = candidate.settings.compressionMethodKind;
        if (!methodKind || hasCompressionAttemptForAnchor(world, candidate.conversation, boundary.id, methodKind)) continue;

        const created = tryCreateCompressionBlock(world, cmd, {
          conversationId: candidate.conversationId,
          endMessageId: boundary.id,
          ...(candidate.settings.compressionConfigId ? { methodConfigId: candidate.settings.compressionConfigId } : {}),
          methodKind,
          trigger: 'auto'
        });
        if (!created) continue;

        logAutoCompression('reconcile.created', {
          conversationId: candidate.conversationId,
          invocationId: candidate.invocation.id,
          modelId: candidate.settings.modelId,
          observedTokens: candidate.observedTokens,
          thresholdTokens: candidate.thresholdTokens,
          anchorMessageId: boundary.id,
          anchorSeq: boundary.seq,
          methodKind,
          compressionConfigId: candidate.settings.compressionConfigId
        });
        // 一个会话同一轮只创建一个最新可用压缩块，下一轮会基于新块边界继续判断是否还有增量。
        break;
      }
    }
  }
});

function collectCandidates(world: WorldReader): Map<Entity, AutoCompressionCandidate[]> {
  const result = new Map<Entity, AutoCompressionCandidate[]>();

  for (const invocationEntity of world.query(LlmInvocation)) {
    const invocation = world.get(invocationEntity, LlmInvocation);
    const settings = invocation?.settings;
    const trigger = settings?.compressionTrigger;
    if (!invocation || invocation.status !== 'complete' || !invocation.usageMetadata || !settings || !trigger) continue;
    if (trigger.mode !== 'token_threshold') continue;
    if (!settings.compressionMethodKind || settings.compressionMethodKind === 'disabled' || settings.compressionMethodKind === 'manual_summary') continue;

    const observedTokens = observedUsageTokenCount(invocation.usageMetadata);
    const thresholdTokens = compressionThresholdTokens(settings);
    if (observedTokens === undefined || thresholdTokens === undefined || observedTokens < thresholdTokens) continue;

    const linkedMessage = latestMessageForInvocation(world, invocationEntity);
    if (!linkedMessage) continue;
    const partOf = world.get(linkedMessage.entity, PartOf);
    if (!partOf || !world.has(partOf.parent, Conversation) || !world.has(partOf.parent, ConversationFullContextLoaded)) continue;
    const conversation = world.get(partOf.parent, Conversation);
    if (!conversation) continue;

    const candidate: AutoCompressionCandidate = {
      invocationEntity,
      invocation,
      settings,
      conversation: partOf.parent,
      conversationId: conversation.id,
      modelMessage: linkedMessage.entity,
      modelMessageId: linkedMessage.id,
      modelMessageSeq: linkedMessage.seq,
      observedTokens,
      thresholdTokens
    };
    const list = result.get(partOf.parent) ?? [];
    list.push(candidate);
    result.set(partOf.parent, list);
  }

  return result;
}

function latestMessageForInvocation(
  world: WorldReader,
  invocation: Entity
): { entity: Entity; id: string; seq: number } | undefined {
  let latest: { entity: Entity; id: string; seq: number } | undefined;
  for (const linkEntity of world.query(MessageLlmInvocationLink)) {
    const link = world.get(linkEntity, MessageLlmInvocationLink);
    if (!link || link.invocation !== invocation) continue;
    const message = world.get(link.message, Message);
    if (!message || message.role !== 'model') continue;
    const candidate = { entity: link.message, id: message.id, seq: message.seq };
    if (!latest || candidate.seq > latest.seq || (candidate.seq === latest.seq && candidate.id > latest.id)) latest = candidate;
  }
  return latest;
}

function hasCompressionAttemptAtOrAfter(world: WorldReader, conversation: Entity, minimumSeq: number): boolean {
  return world.query(CompressionBlock).some((entity) => {
    const block = world.get(entity, CompressionBlock);
    if (!block || block.conversation !== conversation) return false;
    const boundary = block.endSeq ?? block.anchorSeq ?? 0;
    return boundary >= minimumSeq;
  });
}

function hasCompressionAttemptForAnchor(
  world: WorldReader,
  conversation: Entity,
  anchorMessageId: string,
  methodKind: NonNullable<LlmInvocationSettingsSnapshotRecord['compressionMethodKind']>
): boolean {
  return world.query(CompressionBlock).some((entity) => {
    const block = world.get(entity, CompressionBlock);
    return block?.conversation === conversation
      && block.anchorMessageId === anchorMessageId
      && block.methodKind === methodKind;
  });
}

function logAutoCompression(stage: string, payload: Record<string, unknown>): void {
  console.info('[LimCode][AutoCompression]', stage, payload);
}
