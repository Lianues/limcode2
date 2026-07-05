import type { Entity, WorldReader } from '../../../ecs/types';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type ContentPart,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent
} from '../../../../shared/protocol';
import { Message, type MessageData } from '../chat/components';
import { conversationMessages } from '../chat/queries';
import { CompressionBlock, CompressionContextVariant } from '../compression/components';
import { ToolCall, ToolState } from '../tools/components';
import { simplifyToolResponseForModel } from '../tools/responseSimplifier';
import { toolStateToResponse } from '../tools/state';
import {
  AgentRunSourceLink,
  MessageRunLink,
  type RunContextPolicyData
} from './components';
import { runRuntimeContextSnapshots } from '../runtimeContext/queries';

const DEFAULT_LAST_N = 20;
const MAX_SYNTHETIC_CONTEXT_CHARS = 12_000;
const MAX_JSON_PREVIEW_CHARS = 4_000;

export interface BuildRunContextInput {
  run: Entity;
  conversation: Entity;
  modelMessage: Entity;
  policy?: RunContextPolicyData;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
}

export interface SelectedRunCompressionContext {
  block: Entity;
  variant: Entity;
  mode: 'provider_native' | 'summary_fallback';
}

/**
 * Build LLM contents for a run from ECS facts.
 *
 * This helper intentionally returns transient MessageContent values only: synthetic
 * source/summary blocks are not persisted as Message entities and therefore do not
 * couple Conversation storage to context assembly policy.
 */
export function buildRunContextContents(world: WorldReader, input: BuildRunContextInput): MessageContent[] {
  const policy = input.policy ?? defaultContextPolicy();
  return [
    ...buildRuntimeContextSnapshotContents(world, input),
    ...buildSourceContextContents(world, input, policy),
    ...buildTargetConversationContents(world, input, policy)
  ];
}

function buildRuntimeContextSnapshotContents(world: WorldReader, input: BuildRunContextInput): MessageContent[] {
  const text = runRuntimeContextSnapshots(world, input.run)
    .map((snapshot) => snapshot.data.text.trim())
    .filter(Boolean)
    .join('\n\n');
  return text ? [syntheticTextContent(text)] : [];
}

export function selectRunContextMessageEntities(world: WorldReader, input: BuildRunContextInput): Entity[] {
  const policy = input.policy ?? defaultContextPolicy();
  const selected: Entity[] = [];
  const seen = new Set<Entity>();
  const push = (entities: Entity[]): void => {
    for (const entity of entities) {
      if (seen.has(entity)) continue;
      seen.add(entity);
      selected.push(entity);
    }
  };

  const source = world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .find((candidate) => candidate?.run === input.run);
  if (policy.includeSourceContext === true && source?.sourceConversation !== undefined && source.sourceConversation !== input.conversation) {
    push(selectHistoryMessages(world, nonStreamingConversationMessages(world, source.sourceConversation), policy));
  }

  const targetMessages = nonStreamingConversationMessagesBefore(world, input.conversation, input.modelMessage);
  const runScopedMessageSet = runScopedMessagesIn(world, input.run, targetMessages);
  const runScopedMessages = targetMessages.filter((entity) => runScopedMessageSet.has(entity));
  const extraHistoryMessages = targetMessages.filter((entity) => !runScopedMessageSet.has(entity));
  const selectedHistory = selectHistoryMessages(world, extraHistoryMessages, policy);
  push(targetMessages.filter((entity) => selectedHistory.includes(entity) || runScopedMessageSet.has(entity)));

  return selected;
}

function buildTargetConversationContents(
  world: WorldReader,
  input: BuildRunContextInput,
  policy: RunContextPolicyData
): MessageContent[] {
  const targetMessages = nonStreamingConversationMessagesBefore(world, input.conversation, input.modelMessage);
  const runScopedMessageSet = runScopedMessagesIn(world, input.run, targetMessages);
  const runScopedMessages = targetMessages.filter((entity) => runScopedMessageSet.has(entity));
  const extraHistoryMessages = targetMessages.filter((entity) => !runScopedMessageSet.has(entity));

  const compression = selectRunContextCompressionVariant(world, input.conversation, input.settingsSnapshot);
  if (compression) {
    const block = world.get(compression.block, CompressionBlock);
    const boundarySeq = block?.endSeq ?? block?.anchorSeq ?? 0;
    const afterCompressedHistory = extraHistoryMessages.filter((entity) => (world.get(entity, Message)?.seq ?? 0) > boundarySeq);
    const afterCompressedRunScoped = runScopedMessages.filter((entity) => (world.get(entity, Message)?.seq ?? 0) > boundarySeq);
    const variant = world.get(compression.variant, CompressionContextVariant);
    return [
      ...(variant?.contents ?? []),
      ...messageContents(world, afterCompressedHistory),
      ...messageContents(world, afterCompressedRunScoped)
    ];
  }

  if (policy.historyMode === 'summary') {
    const selectedForSummary = selectHistoryMessages(world, extraHistoryMessages, policy);
    const summary = syntheticMessagesBlock(world, '[Context summary]', selectedForSummary);
    return [
      ...(summary ? [summary] : []),
      ...messageContents(world, runScopedMessages)
    ];
  }

  const selectedHistory = selectHistoryMessages(world, extraHistoryMessages, policy);
  const selected = new Set([...selectedHistory, ...runScopedMessages]);
  return messageContents(world, targetMessages.filter((entity) => selected.has(entity)));
}

export function selectRunContextCompressionVariant(
  world: WorldReader,
  conversation: Entity,
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord
): SelectedRunCompressionContext | undefined {
  const candidates = world.query(CompressionBlock)
    .filter((entity) => {
      const block = world.get(entity, CompressionBlock);
      return block?.conversation === conversation && block.status === 'complete';
    })
    .sort((left, right) => {
      const leftBlock = world.get(left, CompressionBlock)!;
      const rightBlock = world.get(right, CompressionBlock)!;
      return (rightBlock.anchorSeq ?? rightBlock.endSeq ?? 0) - (leftBlock.anchorSeq ?? leftBlock.endSeq ?? 0)
        || rightBlock.createdAt - leftBlock.createdAt
        || rightBlock.id.localeCompare(leftBlock.id);
    });

  for (const blockEntity of candidates) {
    const block = world.get(blockEntity, CompressionBlock)!;
    const variants = world.query(CompressionContextVariant)
      .filter((entity) => world.get(entity, CompressionContextVariant)?.block === blockEntity)
      .sort((left, right) => world.get(left, CompressionContextVariant)!.createdAt - world.get(right, CompressionContextVariant)!.createdAt);
    const canUseOpenAIResponsesNative = settingsSnapshot?.provider === 'openai-responses' && settingsSnapshot.compressionMethodKind === 'openai_responses_compact' && block.methodKind === 'openai_responses_compact';
    if (canUseOpenAIResponsesNative) {
      const native = variants.find((entity) => world.get(entity, CompressionContextVariant)?.kind === 'provider_native');
      if (native !== undefined) return { block: blockEntity, variant: native, mode: 'provider_native' };
    }
    const summary = variants.find((entity) => world.get(entity, CompressionContextVariant)?.kind === 'provider_neutral_summary');
    if (summary !== undefined) return { block: blockEntity, variant: summary, mode: 'summary_fallback' };
  }
  return undefined;
}


function buildSourceContextContents(
  world: WorldReader,
  input: BuildRunContextInput,
  policy: RunContextPolicyData
): MessageContent[] {
  const source = world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .find((candidate) => candidate?.run === input.run);
  if (!source) return [];

  const contents: MessageContent[] = [];

  if (policy.includeSourceContext === true && source.sourceConversation !== undefined && source.sourceConversation !== input.conversation) {
    const sourceMessages = nonStreamingConversationMessages(world, source.sourceConversation);
    const selectedSourceMessages = selectHistoryMessages(world, sourceMessages, policy);
    const sourceContext = syntheticMessagesBlock(world, '[Source conversation context]', selectedSourceMessages);
    if (sourceContext) contents.push(sourceContext);
  }

  if (policy.includeSourceToolResult === true && source.sourceToolCall !== undefined) {
    const sourceTool = syntheticSourceToolBlock(world, source.sourceToolCall);
    if (sourceTool) contents.push(sourceTool);
  }

  return contents;
}

function selectHistoryMessages(
  world: WorldReader,
  messages: Entity[],
  policy: RunContextPolicyData
): Entity[] {
  switch (policy.historyMode) {
    case 'none':
      return [];
    case 'last_n':
      return messages.slice(-positiveInt(policy.lastN, DEFAULT_LAST_N));
    case 'since_message': {
      if (!policy.sinceMessageId) return messages;
      const index = messages.findIndex((entity) => world.get(entity, Message)?.id === policy.sinceMessageId);
      return index >= 0 ? messages.slice(index) : messages;
    }
    case 'selected_messages': {
      const ids = new Set(policy.selectedMessageIds ?? []);
      if (ids.size === 0) return [];
      return messages.filter((entity) => ids.has(world.get(entity, Message)?.id ?? ''));
    }
    case 'summary':
    case 'full':
    default:
      return messages;
  }
}

function nonStreamingConversationMessagesBefore(world: WorldReader, conversation: Entity, modelMessage: Entity): Entity[] {
  const currentModel = world.get(modelMessage, Message);
  return nonStreamingConversationMessages(world, conversation)
    .filter((entity) => entity !== modelMessage)
    .filter((entity) => currentModel === undefined || (world.get(entity, Message)?.seq ?? 0) < currentModel.seq);
}

function nonStreamingConversationMessages(world: WorldReader, conversation: Entity): Entity[] {
  return conversationMessages(world, conversation)
    .filter((entity) => world.get(entity, Message)?.status !== 'streaming');
}

function runScopedMessagesIn(world: WorldReader, run: Entity, candidates: Entity[]): Set<Entity> {
  const candidateSet = new Set(candidates);
  const result = new Set<Entity>();
  for (const entity of world.query(MessageRunLink)) {
    const link = world.get(entity, MessageRunLink);
    if (link?.run === run && candidateSet.has(link.message)) result.add(link.message);
  }
  return result;
}

function messageContents(world: WorldReader, messages: Entity[]): MessageContent[] {
  return messages
    .map((entity) => world.get(entity, Message)?.content)
    .filter((content): content is MessageContent => !!content);
}

function syntheticMessagesBlock(world: WorldReader, title: string, messages: Entity[]): MessageContent | undefined {
  if (messages.length === 0) return undefined;
  const lines = messages
    .map((entity) => {
      const message = world.get(entity, Message);
      return message ? renderMessage(message) : '';
    })
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  return syntheticTextContent(`${title}\n${truncate(lines.join('\n\n'), MAX_SYNTHETIC_CONTEXT_CHARS)}`);
}

function syntheticSourceToolBlock(world: WorldReader, toolCall: Entity): MessageContent | undefined {
  const call = world.get(toolCall, ToolCall);
  if (!call) return undefined;
  const state = world.get(toolCall, ToolState);
  const lines = [
    '[Source tool call]',
    `id: ${call.id}`,
    `name: ${call.name}`,
    `args: ${jsonPreview(parseArgsJson(call.argsJson))}`,
    ...(state ? [`status: ${state.status}`] : []),
    ...(state?.result !== undefined ? [`result: ${jsonPreview(simplifyToolResponseForModel(call.name, state.status, toolStateToResponse(state)))}`] : []),
    ...(state?.error !== undefined ? [`error: ${state.error}`] : []),
    ...(state?.progress !== undefined ? [`progress: ${jsonPreview(state.progress)}`] : []),
    ...(state?.durationMs !== undefined ? [`durationMs: ${state.durationMs}`] : [])
  ];
  return syntheticTextContent(truncate(lines.join('\n'), MAX_SYNTHETIC_CONTEXT_CHARS));
}

function renderMessage(message: MessageData): string {
  const body = message.content.parts
    .map(renderPart)
    .filter(Boolean)
    .join('\n');
  return `${message.role} ${message.id}: ${body || '[empty]'}`;
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) {
    return part.thought === true ? '' : part.text;
  }
  if (isFunctionCallPart(part)) {
    return `[function_call name=${part.functionCall.name} args=${jsonPreview(part.functionCall.args)}]`;
  }
  if (isFunctionResponsePart(part)) {
    return `[function_response name=${part.functionResponse.name} response=${jsonPreview(part.functionResponse.response)}]`;
  }
  if (isInlineDataPart(part)) {
    return `[inline_data mimeType=${part.inlineData.mimeType} name=${part.inlineData.name ?? ''} bytes=${part.inlineData.data?.length ?? part.inlineData.sizeBytes ?? 0}]`;
  }
  if (isFileDataPart(part)) {
    return `[file_data uri=${part.fileData.uri} mimeType=${part.fileData.mimeType ?? 'unknown'}]`;
  }
  if (isProviderContextPart(part)) {
    return `[provider_context format=${part.providerContext.format} itemType=${part.providerContext.itemType ?? 'context'}]`;
  }
  return '';
}

function syntheticTextContent(text: string): MessageContent {
  return { role: 'user', parts: [{ text }] };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseArgsJson(argsJson: string): unknown {
  try {
    return argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return argsJson;
  }
}

function jsonPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return truncate(json === undefined ? String(value) : json, MAX_JSON_PREVIEW_CHARS);
  } catch {
    return truncate(String(value), MAX_JSON_PREVIEW_CHARS);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function defaultContextPolicy(): RunContextPolicyData {
  return { id: 'default-context-policy', historyMode: 'full' };
}
