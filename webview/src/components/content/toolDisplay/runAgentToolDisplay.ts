import { IconMessage2, IconUsers } from '@tabler/icons-vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';
import { answerFromValue, answerMarkdownSection } from './agentAnswerToolDisplay';

export const runAgentToolDisplay: ToolDisplayResolver = (context) => {
  const conversationId = conversationIdFromRunAgentContext(context);
  const answer = answerFromValue(context.result);
  const metadataSections = runAgentMetadataSections(context);
  const outputSections = metadataSections.length > 0 || answer?.content
    ? [
        ...metadataSections,
        ...(answer?.content ? [answerMarkdownSection(answer.title ?? 'Agent 回答正文', answer.content)] : [])
      ]
    : undefined;

  return {
    headerIcon: IconUsers,
    ...(outputSections ? { outputSections } : {}),
    headerActions: conversationId ? [{
        id: 'open-agent-run-conversation',
        label: '打开对话',
        title: '打开这个 AgentRun 对应的聊天标签页',
        icon: IconMessage2,
        invoke: () => {
          bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
        }
      }]
      : []
  };
};

function runAgentMetadataSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const record = asRecord(context.result) ?? asRecord(context.progress);
  if (!record) return [];
  const answer = asRecord(record.answer);
  const rows = [
    ...row('ok', record.ok),
    ...row('status', record.status),
    ...row('agentType', record.agentType),
    ...row('answerBridgeId', record.answerBridgeId ?? answer?.answerBridgeId)
  ];
  return rows.length > 0
    ? [{ kind: 'output', title: '运行结果', rows, rowStyle: 'keyValue' }]
    : [];
}

function row(label: string, value: unknown): Array<{ label: string; value: string }> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [{ label, value: text }] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [{ label, value: String(value) }];
  try {
    return [{ label, value: JSON.stringify(value) }];
  } catch {
    return [{ label, value: String(value) }];
  }
}

function conversationIdFromRunAgentContext(context: ToolDisplayContext): string | undefined {
  const direct = conversationIdFromValue(context.result) ?? conversationIdFromValue(context.progress);
  if (direct) return direct;

  const runId = runIdFromValue(context.result)
    ?? runIdFromValue(context.progress)
    ?? runIdFromSourceLinks(context);
  if (!runId) return undefined;

  return context.agentRunTargetLinks?.find((link) => link.runId === runId)?.conversationId;
}

function runIdFromSourceLinks(context: ToolDisplayContext): string | undefined {
  const toolCallId = context.toolCall?.id;
  if (!toolCallId) return undefined;
  return context.agentRunSourceLinks?.find((link) => link.sourceToolCallId === toolCallId)?.runId;
}

function conversationIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const conversationId = record?.conversationId;
  return typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : undefined;
}

function runIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const runId = record?.runId ?? record?.childRunId;
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
