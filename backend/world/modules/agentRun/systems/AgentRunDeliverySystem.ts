import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import type {
  ContentPart,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRunRole,
  MsgRole,
  MsgStatus,
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
import { activeDeliveryPolicyForRun, defaultAgentForConversation, runSource, runTarget } from '../queries';

const MAX_SUMMARY_CHARS = 4_000;
const MAX_RESULT_CHARS = 16_000;
const MAX_MESSAGE_TEXT_CHARS = 8_000;

interface DeliveryExecutorInfo {
  agentId: string;
  name?: string;
}

interface DeliveryTranscriptMessage {
  id: string;
  role: MsgRole;
  status: MsgStatus;
  runRole?: MessageRunRole;
  text: string;
  content: MessageContent;
}

type DeliveryTranscript =
  | { mode: 'summary'; runId: string; conversationId?: string; summary: string; messageCount: number }
  | { mode: 'link'; runId: string; conversationId?: string; messageIds: string[]; runMessageIds: string[] }
  | { mode: 'selected' | 'full'; runId: string; conversationId?: string; messages: DeliveryTranscriptMessage[] };

interface DeliveryEnvelope {
  ok: true;
  type: 'agent_run';
  status: 'completed';
  runId: string;
  conversationId?: string;
  executor?: DeliveryExecutorInfo;
  summary: string;
  result: string;
  usage?: LlmUsageMetadataRecord;
  transcript?: DeliveryTranscript;
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
    ToolState
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
    bundles: [UserMessageBundle, ToolCallEventBundle, AgentRunBundle]
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

      cmd.add(runEntity, AgentRun, { ...run, status: 'completed', updatedAt: Date.now() });
    }
  }
});

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

  const envelope = buildDeliveryEnvelope(world, runEntity, policy?.includeTranscript ?? 'summary');
  const message = spawnUserMessage(cmd, sourceConversation, deliveryXml('task-notification', envelope));
  spawnMessageRunLink(cmd, { message, run: runEntity, role: 'notification' });

  const agent = source.sourceAgent ?? defaultAgentForConversation(world, sourceConversation);
  if (agent !== undefined) {
    spawnAgentRun(cmd, {
      kind: 'notification',
      agent,
      conversation: sourceConversation,
      sourceKind: 'agentRun',
      sourceRun: runEntity,
      sourceConversation,
      sourceMessage: message,
      inputMessage: message,
      deliveryMode: 'direct_reply',
      includeTranscript: 'full'
    });
  }
  return true;
}

function buildDeliveryEnvelope(world: WorldReader, runEntity: Entity, includeTranscript: TranscriptInclusion): DeliveryEnvelope {
  const runId = runRecordId(world, runEntity);
  const target = runTarget(world, runEntity);
  const conversation = target ? world.get(target.conversation, Conversation) : undefined;
  const agent = target ? world.get(target.agent, Agent) : undefined;
  const result = truncate(finalModelText(world, runEntity) || `[AgentRun ${runId} completed]`, MAX_RESULT_CHARS);
  const summary = summarizeResult(result);
  const modelMessages = runModelMessages(world, runEntity).map((entity) => world.get(entity, Message)).filter(isDefined);
  const usage = mergeUsageMetadata(modelMessages.map((message) => message.usageMetadata).filter(isDefined));
  const transcript = buildTranscript(world, runEntity, includeTranscript, summary);

  return {
    ok: true,
    type: 'agent_run',
    status: 'completed',
    runId,
    ...(conversation ? { conversationId: conversation.id } : {}),
    ...(agent ? { executor: { agentId: agent.id, ...(agent.name ? { name: agent.name } : {}) } } : {}),
    summary,
    result,
    ...(usage ? { usage } : {}),
    ...(transcript ? { transcript } : {})
  };
}

function buildTranscript(world: WorldReader, runEntity: Entity, mode: TranscriptInclusion, summary: string): DeliveryTranscript | undefined {
  if (mode === 'none') return undefined;

  const runId = runRecordId(world, runEntity);
  const target = runTarget(world, runEntity);
  const conversation = target ? world.get(target.conversation, Conversation) : undefined;
  const allMessages = target ? nonStreamingConversationMessages(world, target.conversation) : [];
  const runRoles = runMessageRoles(world, runEntity);
  const runMessages = allMessages.filter((entity) => runRoles.has(entity));

  if (mode === 'summary') {
    return { mode, runId, ...(conversation ? { conversationId: conversation.id } : {}), summary, messageCount: allMessages.length };
  }

  if (mode === 'link') {
    return {
      mode,
      runId,
      ...(conversation ? { conversationId: conversation.id } : {}),
      messageIds: messageIds(world, allMessages),
      runMessageIds: messageIds(world, runMessages)
    };
  }

  const messages = (mode === 'full' ? allMessages : runMessages).map((entity) => buildTranscriptMessage(world, entity, runRoles)).filter(isDefined);
  return { mode, runId, ...(conversation ? { conversationId: conversation.id } : {}), messages };
}

function buildTranscriptMessage(world: WorldReader, entity: Entity, runRoles: ReadonlyMap<Entity, MessageRunRole>): DeliveryTranscriptMessage | undefined {
  const message = world.get(entity, Message);
  if (!message) return undefined;
  const runRole = runRoles.get(entity);
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    ...(runRole ? { runRole } : {}),
    text: truncate(renderMessageText(message), MAX_MESSAGE_TEXT_CHARS),
    content: message.content
  };
}

function nonStreamingConversationMessages(world: WorldReader, conversation: Entity): Entity[] {
  return conversationMessages(world, conversation).filter((entity) => world.get(entity, Message)?.status !== 'streaming');
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
  if (isInlineDataPart(part)) return `[inline_data mimeType=${part.inlineData.mimeType} bytes=${part.inlineData.data.length}]`;
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

function deliveryXml(root: 'task-notification' | 'agent-run-delivery', envelope: DeliveryEnvelope): string {
  return [
    `<${root}>`,
    '<type>agent_run</type>',
    `<status>${escapeXml(envelope.status)}</status>`,
    `<run-id>${escapeXml(envelope.runId)}</run-id>`,
    ...(envelope.conversationId ? [`<conversation-id>${escapeXml(envelope.conversationId)}</conversation-id>`] : []),
    ...(envelope.executor ? executorXml(envelope.executor) : []),
    `<summary>${escapeXml(envelope.summary)}</summary>`,
    `<result>${escapeXml(envelope.result)}</result>`,
    ...(envelope.usage ? [`<usage>${escapeXml(jsonString(envelope.usage))}</usage>`] : []),
    ...(envelope.transcript ? [transcriptXml(envelope.transcript)] : []),
    `</${root}>`
  ].join('\n');
}

function executorXml(executor: DeliveryExecutorInfo): string[] {
  return [
    '<executor>',
    `<agent-id>${escapeXml(executor.agentId)}</agent-id>`,
    ...(executor.name ? [`<name>${escapeXml(executor.name)}</name>`] : []),
    '</executor>'
  ];
}

function transcriptXml(transcript: DeliveryTranscript): string {
  if (transcript.mode === 'summary') {
    return [
      '<transcript mode="summary">',
      `<run-id>${escapeXml(transcript.runId)}</run-id>`,
      ...(transcript.conversationId ? [`<conversation-id>${escapeXml(transcript.conversationId)}</conversation-id>`] : []),
      `<message-count>${transcript.messageCount}</message-count>`,
      `<summary>${escapeXml(transcript.summary)}</summary>`,
      '</transcript>'
    ].join('\n');
  }

  if (transcript.mode === 'link') {
    return [
      '<transcript mode="link">',
      `<run-id>${escapeXml(transcript.runId)}</run-id>`,
      ...(transcript.conversationId ? [`<conversation-id>${escapeXml(transcript.conversationId)}</conversation-id>`] : []),
      '<message-ids>',
      ...transcript.messageIds.map((id) => `<message-id>${escapeXml(id)}</message-id>`),
      '</message-ids>',
      '<run-message-ids>',
      ...transcript.runMessageIds.map((id) => `<message-id>${escapeXml(id)}</message-id>`),
      '</run-message-ids>',
      '</transcript>'
    ].join('\n');
  }

  return [
    `<transcript mode="${transcript.mode}">`,
    `<run-id>${escapeXml(transcript.runId)}</run-id>`,
    ...(transcript.conversationId ? [`<conversation-id>${escapeXml(transcript.conversationId)}</conversation-id>`] : []),
    '<messages>',
    ...transcript.messages.map(transcriptMessageXml),
    '</messages>',
    '</transcript>'
  ].join('\n');
}

function transcriptMessageXml(message: DeliveryTranscriptMessage): string {
  return [
    `<message id="${escapeXmlAttribute(message.id)}" role="${escapeXmlAttribute(message.role)}" status="${escapeXmlAttribute(message.status)}"${message.runRole ? ` run-role="${escapeXmlAttribute(message.runRole)}"` : ''}>`,
    `<text>${escapeXml(message.text)}</text>`,
    `<content>${escapeXml(jsonString(message.content))}</content>`,
    '</message>'
  ].join('\n');
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
