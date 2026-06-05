import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentModeLinkRecord,
  AgentModeRecord,
  AgentRecord,
  AgentRunInputRevisionRecord,
  AgentRunRecord,
  AgentRunSourceLinkRecord,
  AgentRunTargetLinkRecord,
  ApprovalPolicyRecord,
  ClientState,
  ConversationBranchLinkRecord,
  ConversationProjectLinkRecord,
  ConversationRecord,
  ConversationReuseLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  MessageRunLinkRecord,
  ModeApprovalPolicyLinkRecord,
  ModeModelProfileLinkRecord,
  ModeSystemPromptLinkRecord,
  ModeToolPolicyLinkRecord,
  ModelProfileRecord,
  ProjectContextRecord,
  RunApprovalPolicyLinkRecord,
  RunContextPolicyLinkRecord,
  RunContextPolicyRecord,
  RunConversationPolicyLinkRecord,
  RunConversationPolicyRecord,
  RunDeliveryPolicyLinkRecord,
  RunDeliveryPolicyRecord,
  RunEditPolicyLinkRecord,
  RunEditPolicyRecord,
  RunModeLinkRecord,
  RunModelProfileLinkRecord,
  RunSystemPromptLinkRecord,
  RunToolPolicyLinkRecord,
  SystemPromptRecord,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallRunLinkRecord,
  ToolPolicyRecord
} from '../../../shared/protocol';
import { INDEX_FILE } from './constants';
import { createVscodeStoragePaths } from './paths';
import { loadRecordStore, saveRecordStore } from './recordStore';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

type StoreKey = string;
type StoreRecord = { id: string };

interface StoreLocation {
  root: vscode.Uri;
  indexUri: vscode.Uri;
}

const CONVERSATION_REUSE_LINKS_DIR = 'reuse-links';
const CONVERSATION_BRANCH_LINKS_DIR = 'branch-links';
const CONVERSATION_MESSAGES_DIR = 'messages';
const CONVERSATION_TOOL_CALLS_DIR = 'tool-calls';
const CONVERSATION_TOOL_CALL_EVENTS_DIR = 'tool-call-events';
const MESSAGE_CURRENT_REVISION_LINKS_DIR = 'current-links';
const AGENT_RUN_INPUT_REVISIONS_DIR = 'agent-run-input-revisions';
const RUN_CONVERSATION_POLICIES_DIR = 'conversation-policies';
const RUN_CONTEXT_POLICIES_DIR = 'context-policies';
const RUN_DELIVERY_POLICIES_DIR = 'delivery-policies';
const RUN_EDIT_POLICIES_DIR = 'edit-policies';
const RUN_MODE_LINKS_DIR = 'mode-links';
const RUN_SYSTEM_PROMPT_LINKS_DIR = 'system-prompt-links';
const RUN_MODEL_PROFILE_LINKS_DIR = 'model-profile-links';
const RUN_TOOL_POLICY_LINKS_DIR = 'tool-policy-links';
const RUN_APPROVAL_POLICY_LINKS_DIR = 'approval-policy-links';
const RUN_CONVERSATION_POLICY_LINKS_DIR = 'conversation-policy-links';
const RUN_CONTEXT_POLICY_LINKS_DIR = 'context-policy-links';
const RUN_DELIVERY_POLICY_LINKS_DIR = 'delivery-policy-links';
const RUN_EDIT_POLICY_LINKS_DIR = 'edit-policy-links';

export async function loadClientStateFromStores(paths: StoragePaths): Promise<ClientState | undefined> {
  const conversations = await loadRecords<ConversationRecord>(paths.conversationsRootUri, paths.conversationsIndexUri, 'conversation');
  const messages = await loadConversationShards<MessageRecord>(paths, conversations, CONVERSATION_MESSAGES_DIR, 'message');
  const toolCalls = await loadConversationShards<ToolCallRecord>(paths, conversations, CONVERSATION_TOOL_CALLS_DIR, 'toolCall');
  const toolCallEvents = await loadConversationShards<ToolCallEventRecord>(paths, conversations, CONVERSATION_TOOL_CALL_EVENTS_DIR, 'event');

  const state: ClientState = {
    agents: await loadRecords<AgentRecord>(paths.agentsRootUri, paths.agentsIndexUri, 'agent'),
    agentModes: await loadRecords<AgentModeRecord>(paths.agentModesRootUri, paths.agentModesIndexUri, 'agentMode'),
    toolPolicies: await loadRecords<ToolPolicyRecord>(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, 'toolPolicy'),
    approvalPolicies: await loadRecords<ApprovalPolicyRecord>(paths.approvalPoliciesRootUri, paths.approvalPoliciesIndexUri, 'approvalPolicy'),
    systemPrompts: await loadRecords<SystemPromptRecord>(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, 'systemPrompt'),
    modelProfiles: await loadRecords<ModelProfileRecord>(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile'),
    agentModeLinks: await loadRecords<AgentModeLinkRecord>(paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri, 'link'),
    modeToolPolicyLinks: await loadRecords<ModeToolPolicyLinkRecord>(paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri, 'link'),
    modeApprovalPolicyLinks: await loadRecords<ModeApprovalPolicyLinkRecord>(paths.modeApprovalPolicyLinksRootUri, paths.modeApprovalPolicyLinksIndexUri, 'link'),
    modeSystemPromptLinks: await loadRecords<ModeSystemPromptLinkRecord>(paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri, 'link'),
    modeModelProfileLinks: await loadRecords<ModeModelProfileLinkRecord>(paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri, 'link'),
    conversations,
    conversationReuseLinks: await loadRecords<ConversationReuseLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link'),
    conversationBranchLinks: await loadRecords<ConversationBranchLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link'),
    agentConversationLinks: await loadRecords<AgentConversationLinkRecord>(paths.linksRootUri, paths.linksIndexUri, 'link'),
    projectContexts: await loadRecords<ProjectContextRecord>(paths.projectContextsRootUri, paths.projectContextsIndexUri, 'projectContext'),
    conversationProjectLinks: await loadRecords<ConversationProjectLinkRecord>(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, 'link'),
    messages,
    messageRevisions: await loadRecords<MessageRevisionRecord>(paths.messageRevisionsRootUri, paths.messageRevisionsIndexUri, 'revision'),
    messageCurrentRevisionLinks: await loadRecords<MessageCurrentRevisionLinkRecord>(...subStore(paths.messageRevisionsRootUri, MESSAGE_CURRENT_REVISION_LINKS_DIR), 'link'),
    toolCalls,
    toolCallEvents,
    agentRuns: await loadRecords<AgentRunRecord>(paths.agentRunsRootUri, paths.agentRunsIndexUri, 'run'),
    agentRunSourceLinks: await loadRecords<AgentRunSourceLinkRecord>(paths.agentRunSourceLinksRootUri, paths.agentRunSourceLinksIndexUri, 'link'),
    agentRunTargetLinks: await loadRecords<AgentRunTargetLinkRecord>(paths.agentRunTargetLinksRootUri, paths.agentRunTargetLinksIndexUri, 'link'),
    messageRunLinks: await loadRecords<MessageRunLinkRecord>(paths.messageRunLinksRootUri, paths.messageRunLinksIndexUri, 'link'),
    toolCallRunLinks: await loadRecords<ToolCallRunLinkRecord>(paths.toolCallRunLinksRootUri, paths.toolCallRunLinksIndexUri, 'link'),
    runConversationPolicies: await loadRecords<RunConversationPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICIES_DIR), 'policy'),
    runContextPolicies: await loadRecords<RunContextPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICIES_DIR), 'policy'),
    runDeliveryPolicies: await loadRecords<RunDeliveryPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICIES_DIR), 'policy'),
    runEditPolicies: await loadRecords<RunEditPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICIES_DIR), 'policy'),
    runModeLinks: await loadRecords<RunModeLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_MODE_LINKS_DIR), 'link'),
    runSystemPromptLinks: await loadRecords<RunSystemPromptLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_SYSTEM_PROMPT_LINKS_DIR), 'link'),
    runModelProfileLinks: await loadRecords<RunModelProfileLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_MODEL_PROFILE_LINKS_DIR), 'link'),
    runToolPolicyLinks: await loadRecords<RunToolPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_TOOL_POLICY_LINKS_DIR), 'link'),
    runApprovalPolicyLinks: await loadRecords<RunApprovalPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_APPROVAL_POLICY_LINKS_DIR), 'link'),
    runConversationPolicyLinks: await loadRecords<RunConversationPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICY_LINKS_DIR), 'link'),
    runContextPolicyLinks: await loadRecords<RunContextPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICY_LINKS_DIR), 'link'),
    runDeliveryPolicyLinks: await loadRecords<RunDeliveryPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICY_LINKS_DIR), 'link'),
    runEditPolicyLinks: await loadRecords<RunEditPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICY_LINKS_DIR), 'link'),
    agentRunInputRevisions: await loadRecords<AgentRunInputRevisionRecord>(...subStore(paths.messageRevisionsRootUri, AGENT_RUN_INPUT_REVISIONS_DIR), 'inputRevision')
  };

  return hasAnyState(state) ? state : undefined;
}

export async function saveClientStateToStores(paths: StoragePaths, state: ClientState): Promise<void> {
  await Promise.all([
    saveRecords(paths.agentsRootUri, paths.agentsIndexUri, state.agents, 'agent', (record) => record.name || record.id),
    saveRecords(paths.agentModesRootUri, paths.agentModesIndexUri, state.agentModes, 'agentMode', (record) => record.name || record.id),
    saveRecords(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, state.toolPolicies, 'toolPolicy', (record) => record.name || record.id),
    saveRecords(paths.approvalPoliciesRootUri, paths.approvalPoliciesIndexUri, state.approvalPolicies, 'approvalPolicy', (record) => record.name || record.id),
    saveRecords(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, state.systemPrompts, 'systemPrompt', (record) => record.name || record.id),
    saveRecords(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, state.modelProfiles, 'modelProfile', (record) => record.name || record.id),
    saveRecords(paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri, state.agentModeLinks, 'link'),
    saveRecords(paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri, state.modeToolPolicyLinks, 'link'),
    saveRecords(paths.modeApprovalPolicyLinksRootUri, paths.modeApprovalPolicyLinksIndexUri, state.modeApprovalPolicyLinks, 'link'),
    saveRecords(paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri, state.modeSystemPromptLinks, 'link'),
    saveRecords(paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri, state.modeModelProfileLinks, 'link'),
    saveRecords(paths.conversationsRootUri, paths.conversationsIndexUri, state.conversations, 'conversation', (record) => record.title || record.id),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), state.conversationReuseLinks, 'link'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), state.conversationBranchLinks, 'link'),
    saveRecords(paths.linksRootUri, paths.linksIndexUri, state.agentConversationLinks, 'link'),
    saveRecords(paths.projectContextsRootUri, paths.projectContextsIndexUri, state.projectContexts, 'projectContext', (record) => record.name || record.id),
    saveRecords(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, state.conversationProjectLinks, 'link'),
    saveRecords(paths.messageRevisionsRootUri, paths.messageRevisionsIndexUri, state.messageRevisions, 'revision'),
    saveRecords(...subStore(paths.messageRevisionsRootUri, MESSAGE_CURRENT_REVISION_LINKS_DIR), state.messageCurrentRevisionLinks, 'link'),
    saveRecords(paths.agentRunsRootUri, paths.agentRunsIndexUri, state.agentRuns, 'run'),
    saveRecords(paths.agentRunSourceLinksRootUri, paths.agentRunSourceLinksIndexUri, state.agentRunSourceLinks, 'link'),
    saveRecords(paths.agentRunTargetLinksRootUri, paths.agentRunTargetLinksIndexUri, state.agentRunTargetLinks, 'link'),
    saveRecords(paths.messageRunLinksRootUri, paths.messageRunLinksIndexUri, state.messageRunLinks, 'link'),
    saveRecords(paths.toolCallRunLinksRootUri, paths.toolCallRunLinksIndexUri, state.toolCallRunLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICIES_DIR), state.runConversationPolicies, 'policy'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICIES_DIR), state.runContextPolicies, 'policy'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICIES_DIR), state.runDeliveryPolicies, 'policy'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICIES_DIR), state.runEditPolicies, 'policy'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_MODE_LINKS_DIR), state.runModeLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_SYSTEM_PROMPT_LINKS_DIR), state.runSystemPromptLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_MODEL_PROFILE_LINKS_DIR), state.runModelProfileLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_TOOL_POLICY_LINKS_DIR), state.runToolPolicyLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_APPROVAL_POLICY_LINKS_DIR), state.runApprovalPolicyLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICY_LINKS_DIR), state.runConversationPolicyLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICY_LINKS_DIR), state.runContextPolicyLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICY_LINKS_DIR), state.runDeliveryPolicyLinks, 'link'),
    saveRecords(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICY_LINKS_DIR), state.runEditPolicyLinks, 'link'),
    saveRecords(...subStore(paths.messageRevisionsRootUri, AGENT_RUN_INPUT_REVISIONS_DIR), state.agentRunInputRevisions, 'inputRevision')
  ]);

  await saveConversationShardedRecords(paths, state.conversations, CONVERSATION_MESSAGES_DIR, 'message', groupMessagesByConversation(state.messages));
  const toolCallsByConversation = groupToolCallsByConversation(state.messages, state.toolCalls);
  await saveConversationShardedRecords(paths, state.conversations, CONVERSATION_TOOL_CALLS_DIR, 'toolCall', toolCallsByConversation);
  await saveConversationShardedRecords(paths, state.conversations, CONVERSATION_TOOL_CALL_EVENTS_DIR, 'event', groupToolCallEventsByConversation(toolCallsByConversation, state.toolCallEvents));
}

export async function saveMessageRecord(paths: StoragePaths, conversationId: string, message: MessageRecord): Promise<void> {
  const location = conversationShard(paths, CONVERSATION_MESSAGES_DIR, conversationId);
  const messages = await loadRecords<MessageRecord>(location.root, location.indexUri, 'message');
  await saveRecords(location.root, location.indexUri, upsertById(messages, { ...message, conversationId }), 'message');
}

export async function removeMessageRecord(paths: StoragePaths, conversationId: string, messageId: string): Promise<void> {
  const location = conversationShard(paths, CONVERSATION_MESSAGES_DIR, conversationId);
  const messages = await loadRecords<MessageRecord>(location.root, location.indexUri, 'message');
  await saveRecords(location.root, location.indexUri, messages.filter((message) => message.id !== messageId), 'message');
}

export async function saveToolCallRecord(paths: StoragePaths, conversationId: string, toolCall: ToolCallRecord): Promise<void> {
  const location = conversationShard(paths, CONVERSATION_TOOL_CALLS_DIR, conversationId);
  const toolCalls = await loadRecords<ToolCallRecord>(location.root, location.indexUri, 'toolCall');
  await saveRecords(location.root, location.indexUri, upsertById(toolCalls, toolCall), 'toolCall');
}

export async function appendToolCallEventRecord(paths: StoragePaths, conversationId: string, event: ToolCallEventRecord): Promise<void> {
  const location = conversationShard(paths, CONVERSATION_TOOL_CALL_EVENTS_DIR, conversationId);
  const events = await loadRecords<ToolCallEventRecord>(location.root, location.indexUri, 'event');
  await saveRecords(location.root, location.indexUri, upsertById(events, event), 'event');
}

async function loadConversationShards<TRecord extends StoreRecord>(
  paths: StoragePaths,
  conversations: ConversationRecord[],
  shardDir: string,
  recordKey: StoreKey
): Promise<TRecord[]> {
  const records: TRecord[] = [];
  for (const conversation of conversations) {
    const location = conversationShard(paths, shardDir, conversation.id);
    records.push(...await loadRecords<TRecord>(location.root, location.indexUri, recordKey));
  }
  return records;
}

async function saveConversationShardedRecords<TRecord extends StoreRecord>(
  paths: StoragePaths,
  conversations: ConversationRecord[],
  shardDir: string,
  recordKey: StoreKey,
  grouped: Map<string, TRecord[]>
): Promise<void> {
  await Promise.all(conversations.map((conversation) => {
    const location = conversationShard(paths, shardDir, conversation.id);
    return saveRecords(location.root, location.indexUri, grouped.get(conversation.id) ?? [], recordKey);
  }));
}

function groupMessagesByConversation(messages: MessageRecord[]): Map<string, MessageRecord[]> {
  return groupBy(messages, (message) => message.conversationId);
}

function groupToolCallsByConversation(messages: MessageRecord[], toolCalls: ToolCallRecord[]): Map<string, ToolCallRecord[]> {
  const messageConversation = new Map(messages.map((message) => [message.id, message.conversationId]));
  const grouped = new Map<string, ToolCallRecord[]>();
  for (const toolCall of toolCalls) {
    const conversationId = messageConversation.get(toolCall.messageId);
    if (!conversationId) continue;
    pushGrouped(grouped, conversationId, toolCall);
  }
  return grouped;
}

function groupToolCallEventsByConversation(toolCallsByConversation: Map<string, ToolCallRecord[]>, events: ToolCallEventRecord[]): Map<string, ToolCallEventRecord[]> {
  const toolCallConversation = new Map<string, string>();
  for (const [conversationId, toolCalls] of toolCallsByConversation) {
    for (const toolCall of toolCalls) toolCallConversation.set(toolCall.id, conversationId);
  }
  const grouped = new Map<string, ToolCallEventRecord[]>();
  for (const event of events) {
    const conversationId = toolCallConversation.get(event.toolCallId);
    if (!conversationId) continue;
    pushGrouped(grouped, conversationId, event);
  }
  return grouped;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) pushGrouped(grouped, keyFor(item), item);
  return grouped;
}

function pushGrouped<T>(grouped: Map<string, T[]>, key: string, item: T): void {
  const values = grouped.get(key);
  if (values) values.push(item);
  else grouped.set(key, [item]);
}

async function loadRecords<TRecord extends StoreRecord>(root: vscode.Uri, indexUri: vscode.Uri, recordKey: StoreKey): Promise<TRecord[]> {
  return (await loadRecordStore<TRecord, string>(root, indexUri, recordKey)) ?? [];
}

async function saveRecords<TRecord extends StoreRecord>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: StoreKey,
  labelForRecord?: (record: TRecord) => string
): Promise<void> {
  await saveRecordStore<TRecord, string>(root, indexUri, records, recordKey, labelForRecord);
}

function subStore(root: vscode.Uri, dir: string): [vscode.Uri, vscode.Uri] {
  const childRoot = vscode.Uri.joinPath(root, dir);
  return [childRoot, vscode.Uri.joinPath(childRoot, INDEX_FILE)];
}

function conversationShard(paths: StoragePaths, shardDir: string, conversationId: string): StoreLocation {
  const [root, indexUri] = subStore(vscode.Uri.joinPath(paths.conversationsRootUri, shardDir), safeShardName(conversationId));
  return { root, indexUri };
}

function upsertById<T extends StoreRecord>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function hasAnyState(state: ClientState): boolean {
  return (Object.values(state) as unknown[]).some((value) => Array.isArray(value) && value.length > 0);
}

function safeShardName(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
