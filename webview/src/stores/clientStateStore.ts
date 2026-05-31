import { reactive } from 'vue';
import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationIdFromClientStateStreamId,
  type AgentConversationLinkRecord,
  type AgentModeLinkRecord,
  type AgentModeRecord,
  type AgentRecord,
  type AgentRunInputRevisionRecord,
  type AgentRunRecord,
  type AgentRunSourceLinkRecord,
  type AgentRunTargetLinkRecord,
  type ApprovalPolicyRecord,
  type ClientPatchOp,
  type ClientState,
  type ConversationBranchLinkRecord,
  type ConversationRecord,
  type ConversationReuseLinkRecord,
  isTextPart,
  isVisibleTextPart,
  type MessageCurrentRevisionLinkRecord,
  type MessageRecord,
  type MessageRevisionRecord,
  type MessageRunLinkRecord,
  type ModeApprovalPolicyLinkRecord,
  type ModeModelProfileLinkRecord,
  type ModeSystemPromptLinkRecord,
  type ModeToolPolicyLinkRecord,
  type ModelProfileRecord,
  type RunApprovalPolicyLinkRecord,
  type RunContextPolicyLinkRecord,
  type RunContextPolicyRecord,
  type RunConversationPolicyLinkRecord,
  type RunConversationPolicyRecord,
  type RunDeliveryPolicyLinkRecord,
  type RunDeliveryPolicyRecord,
  type RunEditPolicyLinkRecord,
  type RunEditPolicyRecord,
  type RunModeLinkRecord,
  type RunModelProfileLinkRecord,
  type RunSystemPromptLinkRecord,
  type RunToolPolicyLinkRecord,
  type SystemPromptRecord,
  type ToolCallEventRecord,
  type ToolCallRecord,
  type ToolCallRunLinkRecord,
  type ToolPolicyRecord
} from '@shared/protocol';

interface ClientStateStore extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  currentConversationId: string;
  showHiddenConversations: boolean;
}

export const clientState = reactive<ClientStateStore>({
  ...emptyClientState(),
  streamSeqs: {},
  currentConversationId: '',
  showHiddenConversations: false
});

export function applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
  clientState.streamSeqs[streamId] = streamSeq;
  if (streamId === GLOBAL_CLIENT_STATE_STREAM_ID) {
    applyGlobalSnapshot(state);
    ensureCurrentConversation();
    return;
  }

  const conversationId = conversationIdFromClientStateStreamId(streamId) ?? state.conversations[0]?.id ?? state.messages[0]?.conversationId;
  if (!conversationId) return;
  replaceConversationState(conversationId, state);
  ensureCurrentConversation();
}

export function applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
  const currentStreamSeq = clientState.streamSeqs[streamId] ?? 0;
  if (streamSeq !== currentStreamSeq + 1) return false;
  for (const patch of patches) applyClientPatchOp(patch);
  clientState.streamSeqs[streamId] = streamSeq;
  ensureCurrentConversation();
  return true;
}

function applyGlobalSnapshot(state: ClientState): void {
  clientState.agents = state.agents;
  clientState.agentModes = state.agentModes;
  clientState.toolPolicies = state.toolPolicies;
  clientState.approvalPolicies = state.approvalPolicies;
  clientState.systemPrompts = state.systemPrompts;
  clientState.modelProfiles = state.modelProfiles;
  clientState.agentModeLinks = state.agentModeLinks;
  clientState.modeToolPolicyLinks = state.modeToolPolicyLinks;
  clientState.modeApprovalPolicyLinks = state.modeApprovalPolicyLinks;
  clientState.modeSystemPromptLinks = state.modeSystemPromptLinks;
  clientState.modeModelProfileLinks = state.modeModelProfileLinks;
  clientState.conversations = state.conversations;
  clientState.conversationReuseLinks = state.conversationReuseLinks;
  clientState.conversationBranchLinks = state.conversationBranchLinks;
  clientState.agentConversationLinks = state.agentConversationLinks;
  clientState.agentRuns = state.agentRuns;
  clientState.agentRunSourceLinks = state.agentRunSourceLinks;
  clientState.agentRunTargetLinks = state.agentRunTargetLinks;
  clientState.messageRunLinks = state.messageRunLinks;
  clientState.toolCallRunLinks = state.toolCallRunLinks;
  clientState.runConversationPolicies = state.runConversationPolicies;
  clientState.runContextPolicies = state.runContextPolicies;
  clientState.runDeliveryPolicies = state.runDeliveryPolicies;
  clientState.runEditPolicies = state.runEditPolicies;
  clientState.runModeLinks = state.runModeLinks;
  clientState.runSystemPromptLinks = state.runSystemPromptLinks;
  clientState.runModelProfileLinks = state.runModelProfileLinks;
  clientState.runToolPolicyLinks = state.runToolPolicyLinks;
  clientState.runApprovalPolicyLinks = state.runApprovalPolicyLinks;
  clientState.runConversationPolicyLinks = state.runConversationPolicyLinks;
  clientState.runContextPolicyLinks = state.runContextPolicyLinks;
  clientState.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks;
  clientState.runEditPolicyLinks = state.runEditPolicyLinks;
  clientState.agentRunInputRevisions = state.agentRunInputRevisions;
}

function applyClientPatchOp(patch: ClientPatchOp): void {
  switch (patch.kind) {
    case 'agent.upsert': upsert(clientState.agents, patch.agent); break;
    case 'agent.remove': removeById(clientState.agents, patch.id); break;
    case 'agentMode.upsert': upsert(clientState.agentModes, patch.agentMode); break;
    case 'agentMode.remove': removeById(clientState.agentModes, patch.id); break;
    case 'toolPolicy.upsert': upsert(clientState.toolPolicies, patch.toolPolicy); break;
    case 'toolPolicy.remove': removeById(clientState.toolPolicies, patch.id); break;
    case 'approvalPolicy.upsert': upsert(clientState.approvalPolicies, patch.approvalPolicy); break;
    case 'approvalPolicy.remove': removeById(clientState.approvalPolicies, patch.id); break;
    case 'systemPrompt.upsert': upsert(clientState.systemPrompts, patch.systemPrompt); break;
    case 'systemPrompt.remove': removeById(clientState.systemPrompts, patch.id); break;
    case 'modelProfile.upsert': upsert(clientState.modelProfiles, patch.modelProfile); break;
    case 'modelProfile.remove': removeById(clientState.modelProfiles, patch.id); break;
    case 'agentModeLink.upsert': upsert(clientState.agentModeLinks, patch.link); break;
    case 'agentModeLink.remove': removeById(clientState.agentModeLinks, patch.id); break;
    case 'modeToolPolicyLink.upsert': upsert(clientState.modeToolPolicyLinks, patch.link); break;
    case 'modeToolPolicyLink.remove': removeById(clientState.modeToolPolicyLinks, patch.id); break;
    case 'modeApprovalPolicyLink.upsert': upsert(clientState.modeApprovalPolicyLinks, patch.link); break;
    case 'modeApprovalPolicyLink.remove': removeById(clientState.modeApprovalPolicyLinks, patch.id); break;
    case 'modeSystemPromptLink.upsert': upsert(clientState.modeSystemPromptLinks, patch.link); break;
    case 'modeSystemPromptLink.remove': removeById(clientState.modeSystemPromptLinks, patch.id); break;
    case 'modeModelProfileLink.upsert': upsert(clientState.modeModelProfileLinks, patch.link); break;
    case 'modeModelProfileLink.remove': removeById(clientState.modeModelProfileLinks, patch.id); break;
    case 'conversation.upsert': upsert(clientState.conversations, patch.conversation); break;
    case 'conversation.remove': removeConversation(patch.id); break;
    case 'conversationReuseLink.upsert': upsert(clientState.conversationReuseLinks, patch.link); break;
    case 'conversationReuseLink.remove': removeById(clientState.conversationReuseLinks, patch.id); break;
    case 'conversationBranchLink.upsert': upsert(clientState.conversationBranchLinks, patch.link); break;
    case 'conversationBranchLink.remove': removeById(clientState.conversationBranchLinks, patch.id); break;
    case 'agentConversationLink.upsert': upsert(clientState.agentConversationLinks, patch.link); break;
    case 'agentConversationLink.remove': removeById(clientState.agentConversationLinks, patch.id); break;
    case 'message.upsert':
      upsert(clientState.messages, patch.message);
      clientState.messages.sort((a, b) => a.seq - b.seq);
      break;
    case 'message.remove': removeMessage(patch.id); break;
    case 'message.appendText': appendMessageText(patch.id, patch.delta); break;
    case 'message.appendThought': appendMessageThought(patch.id, patch.partIndex, patch.delta, patch.thoughtSignature); break;
    case 'message.status': {
      const message = clientState.messages.find((item) => item.id === patch.id);
      if (message) message.status = patch.status;
      break;
    }
    case 'messageRevision.upsert': upsert(clientState.messageRevisions, patch.revision); break;
    case 'messageRevision.remove': removeById(clientState.messageRevisions, patch.id); break;
    case 'messageCurrentRevisionLink.upsert': upsert(clientState.messageCurrentRevisionLinks, patch.link); break;
    case 'messageCurrentRevisionLink.remove': removeById(clientState.messageCurrentRevisionLinks, patch.id); break;
    case 'toolcall.upsert': upsert(clientState.toolCalls, patch.toolCall); break;
    case 'toolcall.remove': removeToolCall(patch.id); break;
    case 'toolcallEvent.append':
      upsert(clientState.toolCallEvents, patch.event);
      clientState.toolCallEvents.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
      break;
    case 'toolcallEvent.remove': removeById(clientState.toolCallEvents, patch.id); break;
    case 'agentRun.upsert': upsert(clientState.agentRuns, patch.run); break;
    case 'agentRun.remove': removeAgentRun(patch.id); break;
    case 'agentRunSourceLink.upsert': upsert(clientState.agentRunSourceLinks, patch.link); break;
    case 'agentRunSourceLink.remove': removeById(clientState.agentRunSourceLinks, patch.id); break;
    case 'agentRunTargetLink.upsert': upsert(clientState.agentRunTargetLinks, patch.link); break;
    case 'agentRunTargetLink.remove': removeById(clientState.agentRunTargetLinks, patch.id); break;
    case 'messageRunLink.upsert': upsert(clientState.messageRunLinks, patch.link); break;
    case 'messageRunLink.remove': removeById(clientState.messageRunLinks, patch.id); break;
    case 'toolCallRunLink.upsert': upsert(clientState.toolCallRunLinks, patch.link); break;
    case 'toolCallRunLink.remove': removeById(clientState.toolCallRunLinks, patch.id); break;
    case 'runConversationPolicy.upsert': upsert(clientState.runConversationPolicies, patch.policy); break;
    case 'runConversationPolicy.remove': removeById(clientState.runConversationPolicies, patch.id); break;
    case 'runContextPolicy.upsert': upsert(clientState.runContextPolicies, patch.policy); break;
    case 'runContextPolicy.remove': removeById(clientState.runContextPolicies, patch.id); break;
    case 'runDeliveryPolicy.upsert': upsert(clientState.runDeliveryPolicies, patch.policy); break;
    case 'runDeliveryPolicy.remove': removeById(clientState.runDeliveryPolicies, patch.id); break;
    case 'runEditPolicy.upsert': upsert(clientState.runEditPolicies, patch.policy); break;
    case 'runEditPolicy.remove': removeById(clientState.runEditPolicies, patch.id); break;
    case 'runModeLink.upsert': upsert(clientState.runModeLinks, patch.link); break;
    case 'runModeLink.remove': removeById(clientState.runModeLinks, patch.id); break;
    case 'runSystemPromptLink.upsert': upsert(clientState.runSystemPromptLinks, patch.link); break;
    case 'runSystemPromptLink.remove': removeById(clientState.runSystemPromptLinks, patch.id); break;
    case 'runModelProfileLink.upsert': upsert(clientState.runModelProfileLinks, patch.link); break;
    case 'runModelProfileLink.remove': removeById(clientState.runModelProfileLinks, patch.id); break;
    case 'runToolPolicyLink.upsert': upsert(clientState.runToolPolicyLinks, patch.link); break;
    case 'runToolPolicyLink.remove': removeById(clientState.runToolPolicyLinks, patch.id); break;
    case 'runApprovalPolicyLink.upsert': upsert(clientState.runApprovalPolicyLinks, patch.link); break;
    case 'runApprovalPolicyLink.remove': removeById(clientState.runApprovalPolicyLinks, patch.id); break;
    case 'runConversationPolicyLink.upsert': upsert(clientState.runConversationPolicyLinks, patch.link); break;
    case 'runConversationPolicyLink.remove': removeById(clientState.runConversationPolicyLinks, patch.id); break;
    case 'runContextPolicyLink.upsert': upsert(clientState.runContextPolicyLinks, patch.link); break;
    case 'runContextPolicyLink.remove': removeById(clientState.runContextPolicyLinks, patch.id); break;
    case 'runDeliveryPolicyLink.upsert': upsert(clientState.runDeliveryPolicyLinks, patch.link); break;
    case 'runDeliveryPolicyLink.remove': removeById(clientState.runDeliveryPolicyLinks, patch.id); break;
    case 'runEditPolicyLink.upsert': upsert(clientState.runEditPolicyLinks, patch.link); break;
    case 'runEditPolicyLink.remove': removeById(clientState.runEditPolicyLinks, patch.id); break;
    case 'agentRunInputRevision.upsert': upsert(clientState.agentRunInputRevisions, patch.inputRevision); break;
    case 'agentRunInputRevision.remove': removeById(clientState.agentRunInputRevisions, patch.id); break;
  }
}

function replaceConversationState(conversationId: string, state: ClientState): void {
  const previousMessageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const previousToolCallIds = new Set(clientState.toolCalls.filter((toolCall) => previousMessageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const runIdsToReplace = new Set([...relatedRunIdsForConversation(conversationId), ...state.agentRuns.map((run) => run.id)]);

  upsertMany(clientState.conversations, state.conversations);
  clientState.conversationReuseLinks = [...clientState.conversationReuseLinks.filter((link) => link.conversationId !== conversationId), ...state.conversationReuseLinks];
  clientState.conversationBranchLinks = [...clientState.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId), ...state.conversationBranchLinks];
  clientState.messages = [...clientState.messages.filter((message) => message.conversationId !== conversationId), ...state.messages].sort((a, b) => a.seq - b.seq);
  clientState.messageRevisions = [...clientState.messageRevisions.filter((revision) => revision.conversationId !== conversationId), ...state.messageRevisions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  clientState.messageCurrentRevisionLinks = [...clientState.messageCurrentRevisionLinks.filter((link) => !previousMessageIds.has(link.messageId)), ...state.messageCurrentRevisionLinks];
  clientState.toolCalls = [...clientState.toolCalls.filter((toolCall) => !previousMessageIds.has(toolCall.messageId)), ...state.toolCalls];
  clientState.toolCallEvents = [...clientState.toolCallEvents.filter((event) => !previousToolCallIds.has(event.toolCallId)), ...state.toolCallEvents].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  removeRunScopedState(runIdsToReplace);
  upsertMany(clientState.agentRuns, state.agentRuns);
  upsertMany(clientState.agentRunSourceLinks, state.agentRunSourceLinks);
  upsertMany(clientState.agentRunTargetLinks, state.agentRunTargetLinks);
  upsertMany(clientState.messageRunLinks, state.messageRunLinks);
  upsertMany(clientState.toolCallRunLinks, state.toolCallRunLinks);
  upsertMany(clientState.runConversationPolicies, state.runConversationPolicies);
  upsertMany(clientState.runContextPolicies, state.runContextPolicies);
  upsertMany(clientState.runDeliveryPolicies, state.runDeliveryPolicies);
  upsertMany(clientState.runEditPolicies, state.runEditPolicies);
  upsertMany(clientState.runModeLinks, state.runModeLinks);
  upsertMany(clientState.runSystemPromptLinks, state.runSystemPromptLinks);
  upsertMany(clientState.runModelProfileLinks, state.runModelProfileLinks);
  upsertMany(clientState.runToolPolicyLinks, state.runToolPolicyLinks);
  upsertMany(clientState.runApprovalPolicyLinks, state.runApprovalPolicyLinks);
  upsertMany(clientState.runConversationPolicyLinks, state.runConversationPolicyLinks);
  upsertMany(clientState.runContextPolicyLinks, state.runContextPolicyLinks);
  upsertMany(clientState.runDeliveryPolicyLinks, state.runDeliveryPolicyLinks);
  upsertMany(clientState.runEditPolicyLinks, state.runEditPolicyLinks);
  upsertMany(clientState.agentRunInputRevisions, state.agentRunInputRevisions);
}

function removeConversation(conversationId: string): void {
  const messageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const runIds = relatedRunIdsForConversation(conversationId);
  removeById(clientState.conversations, conversationId);
  clientState.conversationReuseLinks = clientState.conversationReuseLinks.filter((link) => link.conversationId !== conversationId);
  clientState.conversationBranchLinks = clientState.conversationBranchLinks.filter((link) => link.sourceConversationId !== conversationId && link.targetConversationId !== conversationId);
  clientState.agentConversationLinks = clientState.agentConversationLinks.filter((item) => item.conversationId !== conversationId);
  clientState.messages = clientState.messages.filter((message) => message.conversationId !== conversationId);
  clientState.messageRevisions = clientState.messageRevisions.filter((revision) => revision.conversationId !== conversationId);
  clientState.messageCurrentRevisionLinks = clientState.messageCurrentRevisionLinks.filter((link) => !messageIds.has(link.messageId));
  clientState.toolCalls = clientState.toolCalls.filter((toolCall) => !toolCallIds.has(toolCall.id));
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => !toolCallIds.has(event.toolCallId));
  removeRunScopedState(runIds);
  if (clientState.currentConversationId === conversationId) clientState.currentConversationId = clientState.conversations[0]?.id ?? '';
}

function removeMessage(messageId: string): void {
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => toolCall.messageId === messageId).map((toolCall) => toolCall.id));
  removeById(clientState.messages, messageId);
  clientState.messageRevisions = clientState.messageRevisions.filter((revision) => revision.messageId !== messageId);
  clientState.messageCurrentRevisionLinks = clientState.messageCurrentRevisionLinks.filter((link) => link.messageId !== messageId);
  clientState.messageRunLinks = clientState.messageRunLinks.filter((link) => link.messageId !== messageId);
  clientState.toolCalls = clientState.toolCalls.filter((toolCall) => toolCall.messageId !== messageId);
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => !toolCallIds.has(event.toolCallId));
}

function removeToolCall(toolCallId: string): void {
  removeById(clientState.toolCalls, toolCallId);
  clientState.toolCallRunLinks = clientState.toolCallRunLinks.filter((link) => link.toolCallId !== toolCallId);
  clientState.toolCallEvents = clientState.toolCallEvents.filter((event) => event.toolCallId !== toolCallId);
}

function removeAgentRun(runId: string): void {
  removeById(clientState.agentRuns, runId);
  removeRunScopedState(new Set([runId]));
}

function removeRunScopedState(runIds: ReadonlySet<string>): void {
  if (runIds.size === 0) return;
  clientState.agentRunSourceLinks = clientState.agentRunSourceLinks.filter((link) => !runIds.has(link.runId));
  clientState.agentRunTargetLinks = clientState.agentRunTargetLinks.filter((link) => !runIds.has(link.runId));
  clientState.messageRunLinks = clientState.messageRunLinks.filter((link) => !runIds.has(link.runId));
  clientState.toolCallRunLinks = clientState.toolCallRunLinks.filter((link) => !runIds.has(link.runId));
  clientState.runModeLinks = clientState.runModeLinks.filter((link) => !runIds.has(link.runId));
  clientState.runSystemPromptLinks = clientState.runSystemPromptLinks.filter((link) => !runIds.has(link.runId));
  clientState.runModelProfileLinks = clientState.runModelProfileLinks.filter((link) => !runIds.has(link.runId));
  clientState.runToolPolicyLinks = clientState.runToolPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runApprovalPolicyLinks = clientState.runApprovalPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runConversationPolicyLinks = clientState.runConversationPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runContextPolicyLinks = clientState.runContextPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runDeliveryPolicyLinks = clientState.runDeliveryPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.runEditPolicyLinks = clientState.runEditPolicyLinks.filter((link) => !runIds.has(link.runId));
  clientState.agentRunInputRevisions = clientState.agentRunInputRevisions.filter((inputRevision) => !runIds.has(inputRevision.runId));
}

function appendMessageText(messageId: string, delta: string): void {
  const message = clientState.messages.find((item) => item.id === messageId);
  if (!message) return;
  const parts = [...message.content.parts];
  const last = parts[parts.length - 1];
  if (last && isVisibleTextPart(last)) parts[parts.length - 1] = { ...last, text: last.text + delta };
  else parts.push({ text: delta });
  message.content = { ...message.content, parts };
}

function appendMessageThought(messageId: string, partIndex: number, delta: string, thoughtSignature?: string): void {
  const message = clientState.messages.find((item) => item.id === messageId);
  if (!message) return;
  const parts = [...message.content.parts];
  const existing = parts[partIndex];
  if (existing && isTextPart(existing) && existing.thought === true) {
    parts[partIndex] = { ...existing, text: existing.text + delta, ...(thoughtSignature ? { thoughtSignature } : {}) };
  } else {
    const thoughtPart = { text: delta, thought: true as const, ...(thoughtSignature ? { thoughtSignature } : {}) };
    if (partIndex >= 0 && partIndex <= parts.length) parts.splice(partIndex, 0, thoughtPart);
    else parts.push(thoughtPart);
  }
  message.content = { ...message.content, parts };
}

function relatedRunIdsForConversation(conversationId: string): Set<string> {
  const messageIds = new Set(clientState.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const toolCallIds = new Set(clientState.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId)).map((toolCall) => toolCall.id));
  const runIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id: string | undefined): void => {
      if (!id || runIds.has(id)) return;
      runIds.add(id);
      changed = true;
    };
    for (const link of clientState.agentRunTargetLinks) if (link.conversationId === conversationId || runIds.has(link.runId)) add(link.runId);
    for (const link of clientState.agentRunSourceLinks) {
      if (link.sourceConversationId === conversationId || (link.sourceMessageId && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && toolCallIds.has(link.sourceToolCallId)) || (link.sourceRunId && runIds.has(link.sourceRunId)) || runIds.has(link.runId)) add(link.runId);
    }
    for (const link of clientState.messageRunLinks) if (messageIds.has(link.messageId) || runIds.has(link.runId)) add(link.runId);
    for (const link of clientState.toolCallRunLinks) if (toolCallIds.has(link.toolCallId) || runIds.has(link.runId)) add(link.runId);
  }
  return runIds;
}

function ensureCurrentConversation(): void {
  const hasCurrent = !!clientState.currentConversationId && clientState.conversations.some((conversation) => conversation.id === clientState.currentConversationId);
  if (!hasCurrent) {
    clientState.currentConversationId = clientState.conversations.find((conversation) => conversation.id === 'default')?.id ?? clientState.conversations[0]?.id ?? '';
  }
}

function upsertMany<T extends { id: string }>(list: T[], items: T[]): void {
  for (const item of items) upsert(list, item);
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function removeById<T extends { id: string }>(list: T[], id: string): void {
  const index = list.findIndex((candidate) => candidate.id === id);
  if (index >= 0) list.splice(index, 1);
}

function emptyClientState(): ClientState {
  return {
    agents: [], agentModes: [], toolPolicies: [], approvalPolicies: [], systemPrompts: [], modelProfiles: [],
    agentModeLinks: [], modeToolPolicyLinks: [], modeApprovalPolicyLinks: [], modeSystemPromptLinks: [], modeModelProfileLinks: [],
    conversations: [], conversationReuseLinks: [], conversationBranchLinks: [], agentConversationLinks: [], messages: [], messageRevisions: [], messageCurrentRevisionLinks: [],
    toolCalls: [], toolCallEvents: [], agentRuns: [], agentRunSourceLinks: [], agentRunTargetLinks: [], messageRunLinks: [], toolCallRunLinks: [],
    runConversationPolicies: [], runContextPolicies: [], runDeliveryPolicies: [], runEditPolicies: [],
    runModeLinks: [], runSystemPromptLinks: [], runModelProfileLinks: [], runToolPolicyLinks: [], runApprovalPolicyLinks: [],
    runConversationPolicyLinks: [], runContextPolicyLinks: [], runDeliveryPolicyLinks: [], runEditPolicyLinks: [], agentRunInputRevisions: []
  };
}
