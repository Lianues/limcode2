import { reactive } from 'vue';
import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationIdFromClientStateStreamId,
  type AgentConversationLinkRecord,
  type AgentModeLinkRecord,
  type AgentModeRecord,
  type AgentRecord,
  type AgentRunRecord,
  type AgentRunSourceLinkRecord,
  type AgentRunTargetLinkRecord,
  type ClientPatchOp,
  type ClientState,
  type ConversationRecord,
  isTextPart,
  isVisibleTextPart,
  type MessageRecord,
  type ModeModelProfileLinkRecord,
  type ModeSystemPromptLinkRecord,
  type ModeToolPolicyLinkRecord,
  type ModelProfileRecord,
  type SystemPromptRecord,
  type ToolCallEventRecord,
  type ToolCallRecord,
  type ToolPolicyRecord
} from '@shared/protocol';

interface ClientStateStore {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  currentConversationId: string;
  showHiddenConversations: boolean;
  agents: AgentRecord[];
  agentModes: AgentModeRecord[];
  toolPolicies: ToolPolicyRecord[];
  systemPrompts: SystemPromptRecord[];
  modelProfiles: ModelProfileRecord[];
  agentModeLinks: AgentModeLinkRecord[];
  modeToolPolicyLinks: ModeToolPolicyLinkRecord[];
  modeSystemPromptLinks: ModeSystemPromptLinkRecord[];
  modeModelProfileLinks: ModeModelProfileLinkRecord[];
  conversations: ConversationRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  agentRuns: AgentRunRecord[];
  agentRunSourceLinks: AgentRunSourceLinkRecord[];
  agentRunTargetLinks: AgentRunTargetLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  toolCallEvents: ToolCallEventRecord[];
}

export const clientState = reactive<ClientStateStore>({
  streamSeqs: {},
  currentConversationId: '',
  showHiddenConversations: false,
  agents: [],
  agentModes: [],
  toolPolicies: [],
  systemPrompts: [],
  modelProfiles: [],
  agentModeLinks: [],
  modeToolPolicyLinks: [],
  modeSystemPromptLinks: [],
  modeModelProfileLinks: [],
  conversations: [],
  agentConversationLinks: [],
  agentRuns: [],
  agentRunSourceLinks: [],
  agentRunTargetLinks: [],
  messages: [],
  toolCalls: [],
  toolCallEvents: []
});

export function applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
  clientState.streamSeqs[streamId] = streamSeq;
  if (streamId === GLOBAL_CLIENT_STATE_STREAM_ID) {
    clientState.agents = state.agents;
    clientState.agentModes = state.agentModes;
    clientState.toolPolicies = state.toolPolicies;
    clientState.systemPrompts = state.systemPrompts;
    clientState.modelProfiles = state.modelProfiles;
    clientState.agentModeLinks = state.agentModeLinks;
    clientState.modeToolPolicyLinks = state.modeToolPolicyLinks;
    clientState.modeSystemPromptLinks = state.modeSystemPromptLinks;
    clientState.modeModelProfileLinks = state.modeModelProfileLinks;
    clientState.conversations = state.conversations;
    clientState.agentConversationLinks = state.agentConversationLinks;
    clientState.agentRuns = state.agentRuns;
    clientState.agentRunSourceLinks = state.agentRunSourceLinks;
    clientState.agentRunTargetLinks = state.agentRunTargetLinks;
    ensureCurrentConversation();
    return;
  }

  const conversationId = conversationIdFromClientStateStreamId(streamId) ?? state.conversations[0]?.id ?? state.messages[0]?.conversationId;
  if (!conversationId) return;
  replaceConversationState(conversationId, state.messages, state.toolCalls, state.toolCallEvents ?? []);
}

export function applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
  const currentStreamSeq = clientState.streamSeqs[streamId] ?? 0;
  if (streamSeq !== currentStreamSeq + 1) return false;
  for (const patch of patches) applyClientPatchOp(patch);
  clientState.streamSeqs[streamId] = streamSeq;
  ensureCurrentConversation();
  return true;
}

function applyClientPatchOp(patch: ClientPatchOp): void {
  switch (patch.kind) {
    case 'agent.upsert': upsert(clientState.agents, patch.agent, (item) => item.id === patch.agent.id); break;
    case 'agent.remove': remove(clientState.agents, (item) => item.id === patch.id); break;
    case 'agentMode.upsert': upsert(clientState.agentModes, patch.agentMode, (item) => item.id === patch.agentMode.id); break;
    case 'agentMode.remove': remove(clientState.agentModes, (item) => item.id === patch.id); break;
    case 'toolPolicy.upsert': upsert(clientState.toolPolicies, patch.toolPolicy, (item) => item.id === patch.toolPolicy.id); break;
    case 'toolPolicy.remove': remove(clientState.toolPolicies, (item) => item.id === patch.id); break;
    case 'systemPrompt.upsert': upsert(clientState.systemPrompts, patch.systemPrompt, (item) => item.id === patch.systemPrompt.id); break;
    case 'systemPrompt.remove': remove(clientState.systemPrompts, (item) => item.id === patch.id); break;
    case 'modelProfile.upsert': upsert(clientState.modelProfiles, patch.modelProfile, (item) => item.id === patch.modelProfile.id); break;
    case 'modelProfile.remove': remove(clientState.modelProfiles, (item) => item.id === patch.id); break;
    case 'agentModeLink.upsert': upsert(clientState.agentModeLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'agentModeLink.remove': remove(clientState.agentModeLinks, (item) => item.id === patch.id); break;
    case 'modeToolPolicyLink.upsert': upsert(clientState.modeToolPolicyLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'modeToolPolicyLink.remove': remove(clientState.modeToolPolicyLinks, (item) => item.id === patch.id); break;
    case 'modeSystemPromptLink.upsert': upsert(clientState.modeSystemPromptLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'modeSystemPromptLink.remove': remove(clientState.modeSystemPromptLinks, (item) => item.id === patch.id); break;
    case 'modeModelProfileLink.upsert': upsert(clientState.modeModelProfileLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'modeModelProfileLink.remove': remove(clientState.modeModelProfileLinks, (item) => item.id === patch.id); break;
    case 'conversation.upsert': upsert(clientState.conversations, patch.conversation, (item) => item.id === patch.conversation.id); break;
    case 'conversation.remove': removeConversation(patch.id); break;
    case 'agentConversationLink.upsert': upsert(clientState.agentConversationLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'agentConversationLink.remove': remove(clientState.agentConversationLinks, (item) => item.id === patch.id); break;
    case 'agentRun.upsert': upsert(clientState.agentRuns, patch.run, (item) => item.id === patch.run.id); break;
    case 'agentRun.remove': remove(clientState.agentRuns, (item) => item.id === patch.id); break;
    case 'agentRunSourceLink.upsert': upsert(clientState.agentRunSourceLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'agentRunSourceLink.remove': remove(clientState.agentRunSourceLinks, (item) => item.id === patch.id); break;
    case 'agentRunTargetLink.upsert': upsert(clientState.agentRunTargetLinks, patch.link, (item) => item.id === patch.link.id); break;
    case 'agentRunTargetLink.remove': remove(clientState.agentRunTargetLinks, (item) => item.id === patch.id); break;
    case 'message.upsert':
      upsert(clientState.messages, patch.message, (item) => item.id === patch.message.id);
      clientState.messages.sort((a, b) => a.seq - b.seq);
      break;
    case 'message.remove': removeMessage(patch.id); break;
    case 'message.appendText': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) {
        const parts = [...message.content.parts];
        const last = parts[parts.length - 1];
        if (last && isVisibleTextPart(last)) parts[parts.length - 1] = { ...last, text: last.text + patch.delta };
        else parts.push({ text: patch.delta });
        message.content = { ...message.content, parts };
      }
      break;
    }
    case 'message.appendThought': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) {
        const parts = [...message.content.parts];
        const existing = parts[patch.partIndex];
        if (existing && isTextPart(existing) && existing.thought === true) {
          parts[patch.partIndex] = { ...existing, text: existing.text + patch.delta, ...(patch.thoughtSignature ? { thoughtSignature: patch.thoughtSignature } : {}) };
        } else {
          const thoughtPart = { text: patch.delta, thought: true as const, ...(patch.thoughtSignature ? { thoughtSignature: patch.thoughtSignature } : {}) };
          if (patch.partIndex >= 0 && patch.partIndex <= parts.length) parts.splice(patch.partIndex, 0, thoughtPart);
          else parts.push(thoughtPart);
        }
        message.content = { ...message.content, parts };
      }
      break;
    }
    case 'message.status': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) message.status = patch.status;
      break;
    }
    case 'toolcall.upsert': upsert(clientState.toolCalls, patch.toolCall, (item) => item.id === patch.toolCall.id); break;
    case 'toolcall.remove': removeToolCall(patch.id); break;
    case 'toolcallEvent.append':
      upsert(clientState.toolCallEvents, patch.event, (item) => item.id === patch.event.id);
      clientState.toolCallEvents.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
      break;
    case 'toolcallEvent.remove': remove(clientState.toolCallEvents, (item) => item.id === patch.id); break;
    default: break;
  }
}

function replaceConversationState(conversationId: string, messages: MessageRecord[], toolCalls: ToolCallRecord[], toolCallEvents: ToolCallEventRecord[]): void {
  const previousMessageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const previousToolCallIds = new Set(clientState.toolCalls.filter((toolCall) => previousMessageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  clientState.messages = [...clientState.messages.filter((message) => message.conversationId !== conversationId), ...messages].sort((a, b) => a.seq - b.seq);
  clientState.toolCalls = [...clientState.toolCalls.filter((toolCall) => !previousMessageIds.has(toolCall.messageId)), ...toolCalls];
  clientState.toolCallEvents = [...clientState.toolCallEvents.filter((event) => !previousToolCallIds.has(event.toolCallId)), ...toolCallEvents]
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function removeConversation(conversationId: string): void {
  const messageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  remove(clientState.conversations, (item) => item.id === conversationId);
  remove(clientState.agentConversationLinks, (item) => item.conversationId === conversationId);
  clientState.messages = clientState.messages.filter((message) => message.conversationId !== conversationId);
  clientState.toolCalls = clientState.toolCalls.filter((toolCall) => !toolCallIds.has(toolCall.id));
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => !toolCallIds.has(event.toolCallId));
  if (clientState.currentConversationId === conversationId) clientState.currentConversationId = clientState.conversations[0]?.id ?? '';
}

function removeMessage(messageId: string): void {
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => toolCall.messageId === messageId).map((toolCall) => toolCall.id));
  remove(clientState.messages, (item) => item.id === messageId);
  clientState.toolCalls = clientState.toolCalls.filter((toolCall) => toolCall.messageId !== messageId);
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => !toolCallIds.has(event.toolCallId));
}

function removeToolCall(toolCallId: string): void {
  remove(clientState.toolCalls, (item) => item.id === toolCallId);
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => event.toolCallId !== toolCallId);
}

function ensureCurrentConversation(): void {
  const hasCurrent = !!clientState.currentConversationId && clientState.conversations.some((conversation) => conversation.id === clientState.currentConversationId);
  if (!hasCurrent) {
    clientState.currentConversationId = clientState.conversations.find((conversation) => conversation.id === 'default')?.id ?? clientState.conversations[0]?.id ?? '';
  }
}

function upsert<T>(list: T[], item: T, predicate: (candidate: T) => boolean): void {
  const index = list.findIndex(predicate);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function remove<T>(list: T[], predicate: (candidate: T) => boolean): void {
  const index = list.findIndex(predicate);
  if (index >= 0) list.splice(index, 1);
}
