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
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { INDEX_FILE } from './constants';
import { createVscodeStoragePaths } from './paths';
import { loadRecordStore, loadRecordStoreByIds, saveRecordStore, upsertRecordStoreRecords } from './recordStore';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

type StoreKey = string;
type StoreRecord = { id: string };

interface StoreLocation {
  root: vscode.Uri;
  indexUri: vscode.Uri;
}

interface ConversationRunIndexRecord extends StoreRecord {
  conversationId: string;
  agentRunIds: string[];
  agentRunSourceLinkIds: string[];
  agentRunTargetLinkIds: string[];
  messageRunLinkIds: string[];
  toolCallRunLinkIds: string[];
  runConversationPolicyIds: string[];
  runContextPolicyIds: string[];
  runDeliveryPolicyIds: string[];
  runEditPolicyIds: string[];
  runModeLinkIds: string[];
  runSystemPromptLinkIds: string[];
  runModelProfileLinkIds: string[];
  runToolPolicyLinkIds: string[];
  runApprovalPolicyLinkIds: string[];
  runConversationPolicyLinkIds: string[];
  runContextPolicyLinkIds: string[];
  runDeliveryPolicyLinkIds: string[];
  runEditPolicyLinkIds: string[];
  agentRunInputRevisionIds: string[];
  updatedAt: number;
}

const CONVERSATION_REUSE_LINKS_DIR = 'reuse-links';
const CONVERSATION_BRANCH_LINKS_DIR = 'branch-links';
const CONVERSATION_DETAILS_DIR = 'details';
const CONVERSATION_RUN_INDEX_DIR = 'run-index';
const CONVERSATION_MESSAGES_DIR = 'messages';
const CONVERSATION_TOOL_CALLS_DIR = 'tool-calls';
const CONVERSATION_TOOL_CALL_EVENTS_DIR = 'tool-call-events';
const CONVERSATION_MESSAGE_REVISIONS_DIR = 'message-revisions';
const MESSAGE_CURRENT_REVISION_LINKS_DIR = 'message-current-revision-links';
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

export async function loadClientStateSkeletonFromStores(paths: StoragePaths): Promise<ClientState | undefined> {
  const state = createEmptyClientState();
  state.agents = await loadRecords<AgentRecord>(paths.agentsRootUri, paths.agentsIndexUri, 'agent');
  state.agentModes = await loadRecords<AgentModeRecord>(paths.agentModesRootUri, paths.agentModesIndexUri, 'agentMode');
  state.toolPolicies = await loadRecords<ToolPolicyRecord>(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, 'toolPolicy');
  state.approvalPolicies = await loadRecords<ApprovalPolicyRecord>(paths.approvalPoliciesRootUri, paths.approvalPoliciesIndexUri, 'approvalPolicy');
  state.systemPrompts = await loadRecords<SystemPromptRecord>(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, 'systemPrompt');
  state.modelProfiles = await loadRecords<ModelProfileRecord>(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile');
  state.agentModeLinks = await loadRecords<AgentModeLinkRecord>(paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri, 'link');
  state.modeToolPolicyLinks = await loadRecords<ModeToolPolicyLinkRecord>(paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri, 'link');
  state.modeApprovalPolicyLinks = await loadRecords<ModeApprovalPolicyLinkRecord>(paths.modeApprovalPolicyLinksRootUri, paths.modeApprovalPolicyLinksIndexUri, 'link');
  state.modeSystemPromptLinks = await loadRecords<ModeSystemPromptLinkRecord>(paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri, 'link');
  state.modeModelProfileLinks = await loadRecords<ModeModelProfileLinkRecord>(paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri, 'link');
  state.conversations = await loadRecords<ConversationRecord>(paths.conversationsRootUri, paths.conversationsIndexUri, 'conversation');
  state.conversationReuseLinks = await loadRecords<ConversationReuseLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link');
  state.conversationBranchLinks = await loadRecords<ConversationBranchLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link');
  state.agentConversationLinks = await loadRecords<AgentConversationLinkRecord>(paths.linksRootUri, paths.linksIndexUri, 'link');
  state.projectContexts = await loadRecords<ProjectContextRecord>(paths.projectContextsRootUri, paths.projectContextsIndexUri, 'projectContext');
  state.conversationProjectLinks = await loadRecords<ConversationProjectLinkRecord>(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, 'link');
  return hasAnyState(state) ? state : undefined;
}

export async function loadConversationDetailFromStores(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const state = createEmptyClientState();
  const detailRoot = conversationDetailRoot(paths, conversationId);
  state.messages = await loadRecords<MessageRecord>(...subStore(detailRoot, CONVERSATION_MESSAGES_DIR), 'message');
  state.messageRevisions = await loadRecords<MessageRevisionRecord>(...subStore(detailRoot, CONVERSATION_MESSAGE_REVISIONS_DIR), 'revision');
  state.messageCurrentRevisionLinks = await loadRecords<MessageCurrentRevisionLinkRecord>(...subStore(detailRoot, MESSAGE_CURRENT_REVISION_LINKS_DIR), 'link');
  state.toolCalls = await loadRecords<ToolCallRecord>(...subStore(detailRoot, CONVERSATION_TOOL_CALLS_DIR), 'toolCall');
  state.toolCallEvents = await loadRecords<ToolCallEventRecord>(...subStore(detailRoot, CONVERSATION_TOOL_CALL_EVENTS_DIR), 'event');

  const runIndex = await loadConversationRunIndex(paths, conversationId);
  if (runIndex) {
    state.agentRuns = await loadRecordsByIds<AgentRunRecord>(paths.agentRunsRootUri, paths.agentRunsIndexUri, 'run', runIndex.agentRunIds);
    state.agentRunSourceLinks = await loadRecordsByIds<AgentRunSourceLinkRecord>(paths.agentRunSourceLinksRootUri, paths.agentRunSourceLinksIndexUri, 'link', runIndex.agentRunSourceLinkIds);
    state.agentRunTargetLinks = await loadRecordsByIds<AgentRunTargetLinkRecord>(paths.agentRunTargetLinksRootUri, paths.agentRunTargetLinksIndexUri, 'link', runIndex.agentRunTargetLinkIds);
    state.messageRunLinks = await loadRecordsByIds<MessageRunLinkRecord>(paths.messageRunLinksRootUri, paths.messageRunLinksIndexUri, 'link', runIndex.messageRunLinkIds);
    state.toolCallRunLinks = await loadRecordsByIds<ToolCallRunLinkRecord>(paths.toolCallRunLinksRootUri, paths.toolCallRunLinksIndexUri, 'link', runIndex.toolCallRunLinkIds);
    state.runConversationPolicies = await loadRecordsByIds<RunConversationPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICIES_DIR), 'policy', runIndex.runConversationPolicyIds);
    state.runContextPolicies = await loadRecordsByIds<RunContextPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICIES_DIR), 'policy', runIndex.runContextPolicyIds);
    state.runDeliveryPolicies = await loadRecordsByIds<RunDeliveryPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICIES_DIR), 'policy', runIndex.runDeliveryPolicyIds);
    state.runEditPolicies = await loadRecordsByIds<RunEditPolicyRecord>(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICIES_DIR), 'policy', runIndex.runEditPolicyIds);
    state.runModeLinks = await loadRecordsByIds<RunModeLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_MODE_LINKS_DIR), 'link', runIndex.runModeLinkIds);
    state.runSystemPromptLinks = await loadRecordsByIds<RunSystemPromptLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_SYSTEM_PROMPT_LINKS_DIR), 'link', runIndex.runSystemPromptLinkIds);
    state.runModelProfileLinks = await loadRecordsByIds<RunModelProfileLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_MODEL_PROFILE_LINKS_DIR), 'link', runIndex.runModelProfileLinkIds);
    state.runToolPolicyLinks = await loadRecordsByIds<RunToolPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_TOOL_POLICY_LINKS_DIR), 'link', runIndex.runToolPolicyLinkIds);
    state.runApprovalPolicyLinks = await loadRecordsByIds<RunApprovalPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_APPROVAL_POLICY_LINKS_DIR), 'link', runIndex.runApprovalPolicyLinkIds);
    state.runConversationPolicyLinks = await loadRecordsByIds<RunConversationPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICY_LINKS_DIR), 'link', runIndex.runConversationPolicyLinkIds);
    state.runContextPolicyLinks = await loadRecordsByIds<RunContextPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICY_LINKS_DIR), 'link', runIndex.runContextPolicyLinkIds);
    state.runDeliveryPolicyLinks = await loadRecordsByIds<RunDeliveryPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICY_LINKS_DIR), 'link', runIndex.runDeliveryPolicyLinkIds);
    state.runEditPolicyLinks = await loadRecordsByIds<RunEditPolicyLinkRecord>(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICY_LINKS_DIR), 'link', runIndex.runEditPolicyLinkIds);
    state.agentRunInputRevisions = await loadRecordsByIds<AgentRunInputRevisionRecord>(...subStore(paths.runPoliciesRootUri, AGENT_RUN_INPUT_REVISIONS_DIR), 'inputRevision', runIndex.agentRunInputRevisionIds);
  }

  return hasAnyState(state) ? state : undefined;
}

export async function saveClientStateSkeletonToStores(paths: StoragePaths, state: ClientState): Promise<void> {
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
    saveRecords(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, state.conversationProjectLinks, 'link')
  ]);
}

export async function saveConversationDetailToStores(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  const detail = conversationDetailSlice(state, conversationId);
  const detailRoot = conversationDetailRoot(paths, conversationId);
  const runIndex = conversationRunIndex(conversationId, detail);
  await Promise.all([
    saveRecords(...subStore(detailRoot, CONVERSATION_MESSAGES_DIR), detail.messages, 'message'),
    saveRecords(...subStore(detailRoot, CONVERSATION_MESSAGE_REVISIONS_DIR), detail.messageRevisions, 'revision'),
    saveRecords(...subStore(detailRoot, MESSAGE_CURRENT_REVISION_LINKS_DIR), detail.messageCurrentRevisionLinks, 'link'),
    saveRecords(...subStore(detailRoot, CONVERSATION_TOOL_CALLS_DIR), detail.toolCalls, 'toolCall'),
    saveRecords(...subStore(detailRoot, CONVERSATION_TOOL_CALL_EVENTS_DIR), detail.toolCallEvents, 'event'),
    upsertRecords(paths.agentRunsRootUri, paths.agentRunsIndexUri, detail.agentRuns, 'run'),
    upsertRecords(paths.agentRunSourceLinksRootUri, paths.agentRunSourceLinksIndexUri, detail.agentRunSourceLinks, 'link'),
    upsertRecords(paths.agentRunTargetLinksRootUri, paths.agentRunTargetLinksIndexUri, detail.agentRunTargetLinks, 'link'),
    upsertRecords(paths.messageRunLinksRootUri, paths.messageRunLinksIndexUri, detail.messageRunLinks, 'link'),
    upsertRecords(paths.toolCallRunLinksRootUri, paths.toolCallRunLinksIndexUri, detail.toolCallRunLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICIES_DIR), detail.runConversationPolicies, 'policy'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICIES_DIR), detail.runContextPolicies, 'policy'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICIES_DIR), detail.runDeliveryPolicies, 'policy'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICIES_DIR), detail.runEditPolicies, 'policy'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_MODE_LINKS_DIR), detail.runModeLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_SYSTEM_PROMPT_LINKS_DIR), detail.runSystemPromptLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_MODEL_PROFILE_LINKS_DIR), detail.runModelProfileLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_TOOL_POLICY_LINKS_DIR), detail.runToolPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_APPROVAL_POLICY_LINKS_DIR), detail.runApprovalPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_CONVERSATION_POLICY_LINKS_DIR), detail.runConversationPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_CONTEXT_POLICY_LINKS_DIR), detail.runContextPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_DELIVERY_POLICY_LINKS_DIR), detail.runDeliveryPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, RUN_EDIT_POLICY_LINKS_DIR), detail.runEditPolicyLinks, 'link'),
    upsertRecords(...subStore(paths.runPoliciesRootUri, AGENT_RUN_INPUT_REVISIONS_DIR), detail.agentRunInputRevisions, 'inputRevision'),
    upsertRecords(...subStore(paths.conversationsRootUri, CONVERSATION_RUN_INDEX_DIR), [runIndex], 'runIndex')
  ]);
}

export async function saveMessageRecord(paths: StoragePaths, conversationId: string, message: MessageRecord): Promise<void> {
  const location = detailStore(paths, conversationId, CONVERSATION_MESSAGES_DIR);
  const messages = await loadRecords<MessageRecord>(location.root, location.indexUri, 'message');
  await saveRecords(location.root, location.indexUri, upsertById(messages, { ...message, conversationId }), 'message');
}

export async function removeMessageRecord(paths: StoragePaths, conversationId: string, messageId: string): Promise<void> {
  const location = detailStore(paths, conversationId, CONVERSATION_MESSAGES_DIR);
  const messages = await loadRecords<MessageRecord>(location.root, location.indexUri, 'message');
  await saveRecords(location.root, location.indexUri, messages.filter((message) => message.id !== messageId), 'message');
}

export async function saveToolCallRecord(paths: StoragePaths, conversationId: string, toolCall: ToolCallRecord): Promise<void> {
  const location = detailStore(paths, conversationId, CONVERSATION_TOOL_CALLS_DIR);
  const toolCalls = await loadRecords<ToolCallRecord>(location.root, location.indexUri, 'toolCall');
  await saveRecords(location.root, location.indexUri, upsertById(toolCalls, toolCall), 'toolCall');
}

export async function appendToolCallEventRecord(paths: StoragePaths, conversationId: string, event: ToolCallEventRecord): Promise<void> {
  const location = detailStore(paths, conversationId, CONVERSATION_TOOL_CALL_EVENTS_DIR);
  const events = await loadRecords<ToolCallEventRecord>(location.root, location.indexUri, 'event');
  await saveRecords(location.root, location.indexUri, upsertById(events, event), 'event');
}

export function conversationDetailSlice(state: ClientState, conversationId: string): ClientState {
  const detail = createEmptyClientState();
  detail.conversations = state.conversations.filter((conversation) => conversation.id === conversationId);
  detail.messages = state.messages.filter((message) => message.conversationId === conversationId);
  const messageIds = new Set(detail.messages.map((message) => message.id));
  detail.messageRevisions = state.messageRevisions.filter((revision) => revision.conversationId === conversationId || messageIds.has(revision.messageId));
  const revisionIds = new Set(detail.messageRevisions.map((revision) => revision.id));
  detail.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || revisionIds.has(link.revisionId));
  detail.toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(detail.toolCalls.map((toolCall) => toolCall.id));
  detail.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));

  const runIds = collectConversationRunIds(state, conversationId, messageIds, toolCallIds);
  detail.agentRuns = state.agentRuns.filter((run) => runIds.has(run.id));
  detail.agentRunSourceLinks = state.agentRunSourceLinks.filter((link) => runIds.has(link.runId) || (link.sourceRunId !== undefined && runIds.has(link.sourceRunId)) || link.sourceConversationId === conversationId || (link.sourceMessageId !== undefined && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId !== undefined && toolCallIds.has(link.sourceToolCallId)));
  detail.agentRunTargetLinks = state.agentRunTargetLinks.filter((link) => runIds.has(link.runId) || link.conversationId === conversationId);
  detail.messageRunLinks = state.messageRunLinks.filter((link) => runIds.has(link.runId) || messageIds.has(link.messageId));
  detail.toolCallRunLinks = state.toolCallRunLinks.filter((link) => runIds.has(link.runId) || toolCallIds.has(link.toolCallId));
  const policyIds = collectRunPolicyIds(state, runIds);
  detail.runConversationPolicies = state.runConversationPolicies.filter((policy) => policyIds.conversationPolicyIds.has(policy.id));
  detail.runContextPolicies = state.runContextPolicies.filter((policy) => policyIds.contextPolicyIds.has(policy.id));
  detail.runDeliveryPolicies = state.runDeliveryPolicies.filter((policy) => policyIds.deliveryPolicyIds.has(policy.id));
  detail.runEditPolicies = state.runEditPolicies.filter((policy) => policyIds.editPolicyIds.has(policy.id));
  detail.runModeLinks = state.runModeLinks.filter((link) => runIds.has(link.runId));
  detail.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => runIds.has(link.runId));
  detail.runModelProfileLinks = state.runModelProfileLinks.filter((link) => runIds.has(link.runId));
  detail.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runApprovalPolicyLinks = state.runApprovalPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.agentRunInputRevisions = state.agentRunInputRevisions.filter((input) => runIds.has(input.runId) || input.conversationId === conversationId || revisionIds.has(input.revisionId));
  return detail;
}

function conversationRunIndex(conversationId: string, detail: ClientState): ConversationRunIndexRecord {
  return {
    id: conversationId,
    conversationId,
    agentRunIds: detail.agentRuns.map((record) => record.id),
    agentRunSourceLinkIds: detail.agentRunSourceLinks.map((record) => record.id),
    agentRunTargetLinkIds: detail.agentRunTargetLinks.map((record) => record.id),
    messageRunLinkIds: detail.messageRunLinks.map((record) => record.id),
    toolCallRunLinkIds: detail.toolCallRunLinks.map((record) => record.id),
    runConversationPolicyIds: detail.runConversationPolicies.map((record) => record.id),
    runContextPolicyIds: detail.runContextPolicies.map((record) => record.id),
    runDeliveryPolicyIds: detail.runDeliveryPolicies.map((record) => record.id),
    runEditPolicyIds: detail.runEditPolicies.map((record) => record.id),
    runModeLinkIds: detail.runModeLinks.map((record) => record.id),
    runSystemPromptLinkIds: detail.runSystemPromptLinks.map((record) => record.id),
    runModelProfileLinkIds: detail.runModelProfileLinks.map((record) => record.id),
    runToolPolicyLinkIds: detail.runToolPolicyLinks.map((record) => record.id),
    runApprovalPolicyLinkIds: detail.runApprovalPolicyLinks.map((record) => record.id),
    runConversationPolicyLinkIds: detail.runConversationPolicyLinks.map((record) => record.id),
    runContextPolicyLinkIds: detail.runContextPolicyLinks.map((record) => record.id),
    runDeliveryPolicyLinkIds: detail.runDeliveryPolicyLinks.map((record) => record.id),
    runEditPolicyLinkIds: detail.runEditPolicyLinks.map((record) => record.id),
    agentRunInputRevisionIds: detail.agentRunInputRevisions.map((record) => record.id),
    updatedAt: Date.now()
  };
}

async function loadConversationRunIndex(paths: StoragePaths, conversationId: string): Promise<ConversationRunIndexRecord | undefined> {
  const records = await loadRecordsByIds<ConversationRunIndexRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_RUN_INDEX_DIR), 'runIndex', [conversationId]);
  return records[0];
}

function collectConversationRunIds(state: ClientState, conversationId: string, messageIds: ReadonlySet<string>, toolCallIds: ReadonlySet<string>): Set<string> {
  const runIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id: string | undefined): void => {
      if (!id || runIds.has(id)) return;
      runIds.add(id);
      changed = true;
    };
    for (const link of state.agentRunTargetLinks) if (link.conversationId === conversationId || runIds.has(link.runId)) add(link.runId);
    for (const link of state.agentRunSourceLinks) {
      if (link.sourceConversationId === conversationId || (link.sourceMessageId !== undefined && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId !== undefined && toolCallIds.has(link.sourceToolCallId)) || (link.sourceRunId !== undefined && runIds.has(link.sourceRunId)) || runIds.has(link.runId)) add(link.runId);
    }
    for (const link of state.messageRunLinks) if (messageIds.has(link.messageId) || runIds.has(link.runId)) add(link.runId);
    for (const link of state.toolCallRunLinks) if (toolCallIds.has(link.toolCallId) || runIds.has(link.runId)) add(link.runId);
    for (const input of state.agentRunInputRevisions) if (input.conversationId === conversationId || runIds.has(input.runId)) add(input.runId);
  }
  return runIds;
}

function collectRunPolicyIds(state: ClientState, runIds: ReadonlySet<string>): {
  conversationPolicyIds: Set<string>;
  contextPolicyIds: Set<string>;
  deliveryPolicyIds: Set<string>;
  editPolicyIds: Set<string>;
} {
  return {
    conversationPolicyIds: new Set(state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    contextPolicyIds: new Set(state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    deliveryPolicyIds: new Set(state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    editPolicyIds: new Set(state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId))
  };
}

async function loadRecords<TRecord extends StoreRecord>(root: vscode.Uri, indexUri: vscode.Uri, recordKey: StoreKey): Promise<TRecord[]> {
  return (await loadRecordStore<TRecord, string>(root, indexUri, recordKey)) ?? [];
}

async function loadRecordsByIds<TRecord extends StoreRecord>(root: vscode.Uri, indexUri: vscode.Uri, recordKey: StoreKey, ids: Iterable<string>): Promise<TRecord[]> {
  return loadRecordStoreByIds<TRecord, string>(root, indexUri, recordKey, ids);
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

async function upsertRecords<TRecord extends StoreRecord>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: StoreKey,
  labelForRecord?: (record: TRecord) => string
): Promise<void> {
  if (records.length === 0) return;
  await upsertRecordStoreRecords<TRecord, string>(root, indexUri, records, recordKey, labelForRecord);
}

function subStore(root: vscode.Uri, dir: string): [vscode.Uri, vscode.Uri] {
  const childRoot = vscode.Uri.joinPath(root, dir);
  return [childRoot, vscode.Uri.joinPath(childRoot, INDEX_FILE)];
}

function conversationDetailRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.conversationsRootUri, CONVERSATION_DETAILS_DIR, safeShardName(conversationId));
}

function detailStore(paths: StoragePaths, conversationId: string, dir: string): StoreLocation {
  const [root, indexUri] = subStore(conversationDetailRoot(paths, conversationId), dir);
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
