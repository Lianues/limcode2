import { IconMessage } from '@tabler/icons-vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { ToolDisplayContext, ToolDisplayResolver } from './types';

export const runAgentToolDisplay: ToolDisplayResolver = (context) => {
  const conversationId = conversationIdFromRunAgentContext(context);
  if (!conversationId) return undefined;

  return {
    headerActions: [{
      id: 'open-agent-run-conversation',
      label: '打开对话',
      title: '打开这个 AgentRun 对应的聊天标签页',
      icon: IconMessage,
      invoke: () => {
        bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
      }
    }]
  };
};

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
