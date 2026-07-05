import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import type {
  ContentPart,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRunRole,
  TranscriptInclusion
} from '../../../../../shared/protocol';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart
} from '../../../../../shared/protocol';
import { Agent } from '../../agent/components';
import { Conversation, InFlight, Message, PartOf, type MessageData } from '../../chat/components';
import { spawnMessage, spawnUserMessage, UserMessageBundle } from '../../chat/bundles';
import { conversationMessages } from '../../chat/queries';
import { ToolCall, ToolState } from '../../tools/components';
import { spawnToolCallEvent, ToolCallEventBundle } from '../../tools/bundles';
import { isTerminalToolStatus, transitionToolState } from '../../tools/state';
import { AgentRunBundle, spawnAgentRun, spawnMessageRunLink } from '../bundles';
import {
  AgentRun,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunDeliveryPolicy,
  type RunDeliveryPolicyData
} from '../components';
import { activeDeliveryPolicyForRun, defaultAgentForConversation, isTerminalRunStatus, runSource, runTarget } from '../queries';
import { CheckpointEventType } from '../../checkpoint/events';
import { AgentAnswer } from '../../agentAnswer/components';
import { agentAnswerById } from '../../agentAnswer/queries';

const MAX_SUMMARY_CHARS = 4_000;
const MAX_RESULT_CHARS = 16_000;

interface DeliveryEnvelope {
  ok: true;
  status: 'completed';
  runId?: string;
  agentId?: string;
  conversationId?: string;
  answerBridgeId?: string;
  answerSubmitted?: boolean;
  title?: string;
  content: string;
}

const DeliveringRunsQuery = defineQuery({
  name: 'DeliveringRuns',
  all: [AgentRun],
  read: [
    AgentRun,
    AgentRunSourceLink,
    AgentRunTargetLink,
    RunDeliveryPolicy,
    Agent,
    Conversation,
    Message,
    MessageRunLink,
    PartOf,
    ToolCall,
    ToolState,
    AgentAnswer
  ],
  write: [AgentRun, ToolState],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunDeliverySystem = defineSystem({
  name: 'AgentRunDeliverySystem',
  access: {
    queries: [DeliveringRunsQuery],
    bundles: [UserMessageBundle, ToolCallEventBundle, AgentRunBundle],
    events: { emit: [CheckpointEventType.Requested] }
  },
  run({ world, cmd }) {
    for (const runEntity of world.query(AgentRun)) {
      const run = world.get(runEntity, AgentRun);
      if (!run || run.status !== 'delivering') continue;
      const policy = activeDeliveryPolicyForRun(world, runEntity);
      const mode = policy?.mode ?? 'direct_reply';

      if (mode === 'tool_response') {
        const delivered = deliverToolResponse(world, cmd, runEntity, policy);
        if (!delivered) continue;
      } else if (mode === 'notification') {
        const delivered = deliverNotification(world, cmd, runEntity, policy);
        if (!delivered) continue;
      } else if (mode === 'append_to_source_conversation') {
        const delivered = deliverAppendToSourceConversation(world, cmd, runEntity, policy);
        if (!delivered) continue;
      } else if (mode === 'silent') {
        // Explicitly silent: no source message, no parent tool response, no notification run.
      }

      const now = Date.now();
      const usageMetadata = runUsageMetadata(world, runEntity);
      const target = runTarget(world, runEntity);
      const conversation = target ? world.get(target.conversation, Conversation) : undefined;
      if (conversation) {
        requestRunCompletionCheckpoints(cmd, conversation.id, run.id, runCompletionFloorMessageId(world, runEntity));
      }
      cmd.add(runEntity, AgentRun, { ...run, status: 'completed', updatedAt: now, completedAt: now, endReason: 'completed', ...(usageMetadata ? { usageMetadata } : {}) });
    }
  }
});

function requestRunCompletionCheckpoints(cmd: CommandSink, conversationId: string, runId: string, floorMessageId: string | undefined): void {
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, runId, trigger: 'agent_run_completed_before', ...(floorMessageId ? { floorMessageId, anchorPosition: 'before' as const } : {}) }
  });

  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: { conversationId, runId, trigger: 'agent_run_completed_after', ...(floorMessageId ? { floorMessageId, anchorPosition: 'after' as const } : {}) }
  });
}

function runCompletionFloorMessageId(world: WorldReader, runEntity: Entity): string | undefined {
  const modelMessages = runModelMessages(world, runEntity);
  const finalModelMessage = modelMessages[modelMessages.length - 1];
  return finalModelMessage === undefined ? undefined : world.get(finalModelMessage, Message)?.id;
}

function deliverToolResponse(world: WorldReader, cmd: CommandSink, runEntity: Entity, policy: RunDeliveryPolicyData | undefined): boolean {
  const source = runSource(world, runEntity);
  const toolCallEntity = policy?.targetToolCall ?? source?.sourceToolCall;
  if (toolCallEntity === undefined) return false;
  const call = world.get(toolCallEntity, ToolCall);
  const state = world.get(toolCallEntity, ToolState);
  if (!call || !state) return false;

  const envelope = buildDeliveryEnvelope(world, runEntity, policy?.includeTranscript ?? 'summary');
  const now = Date.now();
  if (!isTerminalToolStatus(state.status)) {
    cmd.add(toolCallEntity, ToolState, transitionToolState(state, 'success', { result: envelope, durationMs: Math.max(0, now - call.createdAt) }, now));
  }
  cmd.remove(toolCallEntity, InFlight);
  spawnToolCallEvent(cmd, {
    toolCall: toolCallEntity,
    toolCallId: call.id,
    kind: 'completed',
    status: 'success',
    at: now,
    elapsedMs: Math.max(0, now - call.createdAt),
    durationMs: Math.max(0, now - call.createdAt),
    payload: envelope
  });
  return true;
}

function deliverAppendToSourceConversation(world: WorldReader, cmd: CommandSink, runEntity: Entity, policy: RunDeliveryPolicyData | undefined): boolean {
  const source = runSource(world, runEntity);
  const targetConversation = policy?.targetConversation ?? source?.sourceConversation;
  if (targetConversation === undefined) return false;
  const envelope = buildDeliveryEnvelope(world, runEntity, policy?.includeTranscript ?? 'summary');
  const message = spawnMessage(cmd, {
    parent: targetConversation,
    role: 'model',
    parts: [{ text: deliveryXml('agent-run-delivery', envelope) }],
    status: 'complete'
  });
  spawnMessageRunLink(cmd, { message, run: runEntity, role: 'notification' });
  return true;
}

function deliverNotification(world: WorldReader, cmd: CommandSink, runEntity: Entity, policy: RunDeliveryPolicyData | undefined): boolean {
  const source = runSource(world, runEntity);
  if (!source) return false;
  const sourceConversation = policy?.targetConversation ?? source.sourceConversation;
  if (sourceConversation === undefined) return false;

  const sourceToolCall = policy?.targetToolCall ?? source.sourceToolCall;
  if (sourceToolCall !== undefined && toolResultAlreadyContainsRunAgentAnswer(world, sourceToolCall)) {
    return true;
  }

  const envelope = buildDeliveryEnvelope(world, runEntity, policy?.includeTranscript ?? 'summary');
  const agent = source.sourceAgent ?? defaultAgentForConversation(world, sourceConversation);
  const notificationText = serializedReadAgentAnswerNotification(envelope);

  if (agent === undefined) {
    const message = spawnUserMessage(cmd, sourceConversation, notificationText);
    spawnMessageRunLink(cmd, { message, run: runEntity, role: 'notification' });
    return true;
  }

  spawnAgentRun(cmd, {
    kind: 'notification',
    agent,
    conversation: sourceConversation,
    sourceKind: 'agentRun',
    sourceRun: runEntity,
    sourceConversation,
    deliveryMode: 'direct_reply',
    includeTranscript: 'full',
    needsModel: false,
    queuedInputContent: { role: 'user', parts: [{ text: notificationText }] }
  });
  return true;
}

function buildDeliveryEnvelope(world: WorldReader, runEntity: Entity, includeTranscript: TranscriptInclusion): DeliveryEnvelope {
  const source = runSource(world, runEntity);
  const run = world.get(runEntity, AgentRun);
  const target = runTarget(world, runEntity);
  const agent = target ? world.get(target.agent, Agent) : undefined;
  const conversation = target ? world.get(target.conversation, Conversation) : undefined;
  const targetIds = { ...(run?.id ? { runId: run.id } : {}), ...(agent?.id ? { agentId: agent.id } : {}), ...(conversation?.id ? { conversationId: conversation.id } : {}) };
  const answerBridgeId = source?.answerBridgeId?.trim();
  const submittedAnswerEntity = answerBridgeId ? agentAnswerById(world, answerBridgeId) : undefined;
  const submittedAnswer = submittedAnswerEntity !== undefined ? world.get(submittedAnswerEntity, AgentAnswer) : undefined;
  const fallback = truncate(finalModelText(world, runEntity) || '[AgentRun completed]', MAX_RESULT_CHARS);

  if (submittedAnswer) {
    return {
      ok: true,
      status: 'completed',
      ...targetIds,
      ...(answerBridgeId ? { answerBridgeId, answerSubmitted: true } : {}),
      title: submittedAnswer.title,
      content: submittedAnswer.content
    };
  }

  return {
    ok: true,
    status: 'completed',
    ...targetIds,
    ...(answerBridgeId ? { answerBridgeId, answerSubmitted: false } : {}),
    content: fallback
  };
}

function runMessageRoles(world: WorldReader, runEntity: Entity): Map<Entity, MessageRunRole> {
  const result = new Map<Entity, MessageRunRole>();
  for (const entity of world.query(MessageRunLink)) {

    const link = world.get(entity, MessageRunLink);
    if (link?.run === runEntity && !result.has(link.message)) result.set(link.message, link.role);
  }
  return result;
}

function runModelMessages(world: WorldReader, runEntity: Entity): Entity[] {
  const roles = runMessageRoles(world, runEntity);
  return [...roles]
    .filter(([, role]) => role === 'model')
    .map(([message]) => message)
    .filter((entity) => !!world.get(entity, Message))
    .sort((a, b) => (world.get(a, Message)?.seq ?? 0) - (world.get(b, Message)?.seq ?? 0));
}

function finalModelText(world: WorldReader, runEntity: Entity): string {
  const messages = runModelMessages(world, runEntity)
    .map((entity) => world.get(entity, Message))
    .filter(isDefined);
  const last = messages[messages.length - 1];
  return last ? visibleTextFromMessage(last).trim() : '';
}

function runUsageMetadata(world: WorldReader, runEntity: Entity): LlmUsageMetadataRecord | undefined {
  return mergeUsageMetadata(runModelMessages(world, runEntity)
    .map((entity) => world.get(entity, Message)?.usageMetadata)
    .filter(isDefined));
}

function visibleTextFromMessage(message: MessageData): string {
  return message.content.parts
    .map((part) => isTextPart(part) && part.thought !== true ? part.text : '')
    .join('');
}

function renderMessageText(message: MessageData): string {
  return message.content.parts.map(renderPart).filter(Boolean).join('\n');
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[function_call name=${part.functionCall.name} args=${jsonPreview(part.functionCall.args)}]`;
  if (isFunctionResponsePart(part)) return `[function_response name=${part.functionResponse.name} response=${jsonPreview(part.functionResponse.response)}]`;
  if (isInlineDataPart(part)) return `[inline_data mimeType=${part.inlineData.mimeType} name=${part.inlineData.name ?? ''} bytes=${part.inlineData.data?.length ?? part.inlineData.sizeBytes ?? 0}]`;
  if (isFileDataPart(part)) return `[file_data uri=${part.fileData.uri} mimeType=${part.fileData.mimeType ?? 'unknown'}]`;
  return '';
}

function messageIds(world: WorldReader, messages: Entity[]): string[] {
  return messages.map((entity) => world.get(entity, Message)?.id).filter(isDefined);
}

function summarizeResult(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return '';
  return truncate(trimmed, MAX_SUMMARY_CHARS);
}

function mergeUsageMetadata(items: LlmUsageMetadataRecord[]): LlmUsageMetadataRecord | undefined {
  if (items.length === 0) return undefined;
  const merged: LlmUsageMetadataRecord = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      const previous = merged[key];
      if (typeof previous === 'number' && typeof value === 'number') {
        merged[key] = previous + value;
      } else if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function serializedReadAgentAnswerNotification(envelope: DeliveryEnvelope): string {
  return [
    '[Agent answer completed]',
    '后台 Agent 已完成回答。下面是等同于 read_agent_answer 工具响应的序列化文本，请把它当作该后台 Agent 返回给当前对话的结果：',
    jsonString({
      ok: true,
      answerBridgeId: envelope.answerBridgeId,
      ...(envelope.answerSubmitted !== undefined ? { answerSubmitted: envelope.answerSubmitted } : {}),
      ...(envelope.runId ? { runId: envelope.runId } : {}),
      ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
      ...(envelope.conversationId ? { conversationId: envelope.conversationId } : {}),
      ...(envelope.title ? { title: envelope.title } : {}),
      content: envelope.content
    })
  ].join('\n\n');
}

function deliveryXml(root: 'task-notification' | 'agent-run-delivery', envelope: DeliveryEnvelope): string {
  return [
    `<${root}>`,
    `<status>${escapeXml(envelope.status)}</status>`,
    ...(envelope.answerBridgeId ? [`<answer-bridge-id>${escapeXml(envelope.answerBridgeId)}</answer-bridge-id>`] : []),
    ...(envelope.answerSubmitted !== undefined ? [`<answer-submitted>${String(envelope.answerSubmitted)}</answer-submitted>`] : []),
    ...(envelope.title ? [`<title>${escapeXml(envelope.title)}</title>`] : []),
    `<content>${escapeXml(envelope.content)}</content>`,
    `</${root}>`
  ].join('\n');
}

function toolResultAlreadyContainsRunAgentAnswer(world: WorldReader, toolCallEntity: Entity): boolean {
  return containsRunAgentAnswer(world.get(toolCallEntity, ToolState)?.result);
}

function containsRunAgentAnswer(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (hasText(record.content) || hasText(record.title)) return true;
  const answer = asRecord(record.answer);
  return !!answer && (hasText(answer.content) || hasText(answer.title));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}


function runRecordId(world: WorldReader, runEntity: Entity): string {
  return world.get(runEntity, AgentRun)?.id ?? String(runEntity);
}

function jsonPreview(value: unknown): string {
  return truncate(jsonString(value), 4_000);
}

function jsonString(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
