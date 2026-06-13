import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentModeLinkRecord,
  AgentModeRecord,
  AgentRecord,
  ApprovalPolicyRecord,
  ClientState,
  ConversationBranchLinkRecord,
  ConversationProjectLinkRecord,
  ConversationRecord,
  ConversationRunDetailRecord,
  ConversationRunHistoryPageRecord,
  ConversationRunSummaryRecord,
  ConversationReuseLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ModeApprovalPolicyLinkRecord,
  ModeModelProfileLinkRecord,
  ModeSystemPromptLinkRecord,
  ModeToolPolicyLinkRecord,
  ModelProfileRecord,
  ProjectContextRecord,
  SystemPromptRecord,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord
} from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import { createVscodeStoragePaths } from './paths';
import { loadRecordStore, saveRecordStore } from './recordStore';
import { readJson, writeJson } from './json';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export interface LoadConversationDetailOptions {
  includeRunHistory?: boolean;
}

export interface SaveConversationRunHistoryOptions {
  mode: 'merge' | 'replace';
}

type StoreKey = string;
type StoreRecord = { id: string };

interface StoreLocation {
  root: vscode.Uri;
  indexUri: vscode.Uri;
}

interface ConversationRunHistoryIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  pageSize: number;
  total: number;
  runs: ConversationRunSummaryRecord[];
  pages: ConversationRunHistoryPageIndexRecord[];
}

interface ConversationRunHistoryPageIndexRecord {
  file: string;
  count: number;
  newestUpdatedAt?: number;
  oldestUpdatedAt?: number;
}

interface ConversationRunHistoryPageFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  runs: ConversationRunSummaryRecord[];
}

interface RunHistoryDetailFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  runId: string;
  summaries: ConversationRunSummaryRecord[];
  state: ClientState;
}

const CONVERSATION_REUSE_LINKS_DIR = 'reuse-links';
const CONVERSATION_BRANCH_LINKS_DIR = 'branch-links';
const CONVERSATION_DETAILS_DIR = 'details';
const CONVERSATION_MESSAGES_DIR = 'messages';
const CONVERSATION_TOOL_CALLS_DIR = 'tool-calls';
const CONVERSATION_TOOL_CALL_EVENTS_DIR = 'tool-call-events';
const CONVERSATION_MESSAGE_REVISIONS_DIR = 'message-revisions';
const MESSAGE_CURRENT_REVISION_LINKS_DIR = 'message-current-revision-links';
const RUN_HISTORY_CONVERSATIONS_DIR = 'conversations';
const RUN_HISTORY_PAGES_DIR = 'pages';
const RUN_HISTORY_RUNS_DIR = 'runs';
const RUN_HISTORY_PAGE_SIZE = 20;

const RUN_HISTORY_TABLE_KEYS = [
  'agentRuns',
  'agentRunSourceLinks',
  'agentRunTargetLinks',
  'messageRunLinks',
  'toolCallRunLinks',
  'runConversationPolicies',
  'runContextPolicies',
  'runDeliveryPolicies',
  'runEditPolicies',
  'runModeLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runApprovalPolicyLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'agentRunInputRevisions'
] as const;

const RUN_DETAIL_TABLE_KEYS = [
  ...RUN_HISTORY_TABLE_KEYS,
  'conversations',
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents'
] as const;

export async function loadClientStateSkeletonFromStores(paths: StoragePaths): Promise<ClientState | undefined> {
  const state = createEmptyClientState();
  const [
    agents,
    agentModes,
    toolPolicies,
    toolPolicyScopeLinks,
    approvalPolicies,
    systemPrompts,
    modelProfiles,
    agentModeLinks,
    modeToolPolicyLinks,
    modeApprovalPolicyLinks,
    modeSystemPromptLinks,
    modeModelProfileLinks,
    conversations,
    conversationReuseLinks,
    conversationBranchLinks,
    agentConversationLinks,
    projectContexts,
    conversationProjectLinks
  ] = await Promise.all([
    loadSkeletonRecords<AgentRecord>('agents', [paths.agentsRootUri, paths.agentsIndexUri], 'agent'),
    loadSkeletonRecords<AgentModeRecord>('agentModes', [paths.agentModesRootUri, paths.agentModesIndexUri], 'agentMode'),
    loadSkeletonRecords<ToolPolicyRecord>('toolPolicies', [paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri], 'toolPolicy'),
    loadSkeletonRecords<ToolPolicyScopeLinkRecord>('toolPolicyScopeLinks', [paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ApprovalPolicyRecord>('approvalPolicies', [paths.approvalPoliciesRootUri, paths.approvalPoliciesIndexUri], 'approvalPolicy'),
    loadSkeletonRecords<SystemPromptRecord>('systemPrompts', [paths.systemPromptsRootUri, paths.systemPromptsIndexUri], 'systemPrompt'),
    loadSkeletonRecords<ModelProfileRecord>('modelProfiles', [paths.modelProfilesRootUri, paths.modelProfilesIndexUri], 'modelProfile'),
    loadSkeletonRecords<AgentModeLinkRecord>('agentModeLinks', [paths.agentModeLinksRootUri, paths.agentModeLinksIndexUri], 'link'),
    loadSkeletonRecords<ModeToolPolicyLinkRecord>('modeToolPolicyLinks', [paths.modeToolPolicyLinksRootUri, paths.modeToolPolicyLinksIndexUri], 'link'),
    loadSkeletonRecords<ModeApprovalPolicyLinkRecord>('modeApprovalPolicyLinks', [paths.modeApprovalPolicyLinksRootUri, paths.modeApprovalPolicyLinksIndexUri], 'link'),
    loadSkeletonRecords<ModeSystemPromptLinkRecord>('modeSystemPromptLinks', [paths.modeSystemPromptLinksRootUri, paths.modeSystemPromptLinksIndexUri], 'link'),
    loadSkeletonRecords<ModeModelProfileLinkRecord>('modeModelProfileLinks', [paths.modeModelProfileLinksRootUri, paths.modeModelProfileLinksIndexUri], 'link'),
    loadSkeletonRecords<ConversationRecord>('conversations', [paths.conversationsRootUri, paths.conversationsIndexUri], 'conversation'),
    loadSkeletonRecords<ConversationReuseLinkRecord>('conversationReuseLinks', subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link'),
    loadSkeletonRecords<ConversationBranchLinkRecord>('conversationBranchLinks', subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link'),
    loadSkeletonRecords<AgentConversationLinkRecord>('agentConversationLinks', [paths.linksRootUri, paths.linksIndexUri], 'link'),
    loadSkeletonRecords<ProjectContextRecord>('projectContexts', [paths.projectContextsRootUri, paths.projectContextsIndexUri], 'projectContext'),
    loadSkeletonRecords<ConversationProjectLinkRecord>('conversationProjectLinks', [paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri], 'link')
  ]);

  state.agents = agents;
  state.agentModes = agentModes;
  state.toolPolicies = toolPolicies;
  state.toolPolicyScopeLinks = toolPolicyScopeLinks;
  state.approvalPolicies = approvalPolicies;
  state.systemPrompts = systemPrompts;
  state.modelProfiles = modelProfiles;
  state.agentModeLinks = agentModeLinks;
  state.modeToolPolicyLinks = modeToolPolicyLinks;
  state.modeApprovalPolicyLinks = modeApprovalPolicyLinks;
  state.modeSystemPromptLinks = modeSystemPromptLinks;
  state.modeModelProfileLinks = modeModelProfileLinks;
  state.conversations = conversations;
  state.conversationReuseLinks = conversationReuseLinks;
  state.conversationBranchLinks = conversationBranchLinks;
  state.agentConversationLinks = agentConversationLinks;
  state.projectContexts = projectContexts;
  state.conversationProjectLinks = conversationProjectLinks;

  return hasAnyState(state) ? state : undefined;
}

export async function loadConversationDetailFromStores(
  paths: StoragePaths,
  conversationId: string,
  options: LoadConversationDetailOptions = {}
): Promise<ClientState | undefined> {
  const includeRunHistory = options.includeRunHistory ?? false;
  const state = createEmptyClientState();
  const detailRoot = conversationDetailRoot(paths, conversationId);

  const [
    messages,
    messageRevisions,
    messageCurrentRevisionLinks,
    toolCalls,
    toolCallEvents
  ] = await Promise.all([
    loadRecords<MessageRecord>(...subStore(detailRoot, CONVERSATION_MESSAGES_DIR), 'message'),
    loadRecords<MessageRevisionRecord>(...subStore(detailRoot, CONVERSATION_MESSAGE_REVISIONS_DIR), 'revision'),
    loadRecords<MessageCurrentRevisionLinkRecord>(...subStore(detailRoot, MESSAGE_CURRENT_REVISION_LINKS_DIR), 'link'),
    loadRecords<ToolCallRecord>(...subStore(detailRoot, CONVERSATION_TOOL_CALLS_DIR), 'toolCall'),
    loadRecords<ToolCallEventRecord>(...subStore(detailRoot, CONVERSATION_TOOL_CALL_EVENTS_DIR), 'event')
  ]);
  state.messages = messages;
  state.messageRevisions = messageRevisions;
  state.messageCurrentRevisionLinks = messageCurrentRevisionLinks;
  state.toolCalls = toolCalls;
  state.toolCallEvents = toolCallEvents;

  if (includeRunHistory) {
    const runHistory = await loadConversationRunHistoryFromStores(paths, conversationId);
    if (runHistory) copyRunHistoryTables(state, runHistory);
  }

  return hasAnyState(state) ? state : undefined;
}

export async function loadConversationRunHistoryPageFromStores(paths: StoragePaths, request: { conversationId: string; cursor?: string; limit?: number }): Promise<ConversationRunHistoryPageRecord> {
  const index = await loadRunHistoryIndex(paths, request.conversationId);
  const pageSize = normalizeRunHistoryPageSize(index?.pageSize ?? request.limit);
  const requestedPageIndex = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  const total = index?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
  const pageRecord = index?.pages[pageIndex];
  const page = pageRecord ? await readRunHistoryPage(paths, request.conversationId, pageRecord.file) : undefined;
  const runs = page?.runs ?? [];

  return {
    conversationId: request.conversationId,
    runs,
    pageInfo: {
      cursor: String(pageIndex),
      ...(pageIndex > 0 ? { previousCursor: String(pageIndex - 1) } : {}),
      ...(pageIndex + 1 < pageCount ? { nextCursor: String(pageIndex + 1) } : {}),
      pageIndex,
      pageSize,
      total,
      hasNext: pageIndex + 1 < pageCount,
      hasPrevious: pageIndex > 0
    }
  };
}

export async function loadConversationRunDetailFromStores(paths: StoragePaths, request: { conversationId: string; runId?: string; messageId?: string }): Promise<ConversationRunDetailRecord | undefined> {
  const runId = request.runId ?? (request.messageId ? await resolveConversationRunIdForMessageFromStores(paths, request.conversationId, request.messageId) : undefined);
  if (!runId) return undefined;
  return loadRunDetail(paths, request.conversationId, runId);
}

export async function resolveConversationRunIdForMessageFromStores(paths: StoragePaths, conversationId: string, messageId: string): Promise<string | undefined> {
  const index = await loadRunHistoryIndex(paths, conversationId);
  if (!index) return undefined;

  const summary = index.runs.find((run) => summaryReferencesMessage(run, messageId));
  if (summary) return summary.id;

  for (const run of index.runs) {
    const detail = await loadRunDetail(paths, conversationId, run.id);
    if (!detail) continue;
    if (detail.state.messageRunLinks.some((link) => link.messageId === messageId)) return run.id;
    if (detail.state.messages.some((message) => message.id === messageId)) return run.id;
  }
  return undefined;
}

function summaryReferencesMessage(summary: ConversationRunSummaryRecord, messageId: string): boolean {
  return summary.sourceMessageId === messageId
    || summary.inputMessageIds?.includes(messageId) === true
    || summary.outputMessageIds?.includes(messageId) === true;
}

async function loadConversationRunHistoryFromStores(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const index = await loadRunHistoryIndex(paths, conversationId);
  if (!index || index.runs.length === 0) return undefined;
  const state = createEmptyClientState();
  const details = await Promise.all(index.runs.map((run) => loadRunDetail(paths, conversationId, run.id)));
  for (const detail of details) {
    if (detail) mergeClientStateTables(state, detail.state);
  }
  return state;
}

export async function saveClientStateSkeletonToStores(paths: StoragePaths, state: ClientState): Promise<void> {
  await Promise.all([
    saveRecords(paths.agentsRootUri, paths.agentsIndexUri, state.agents, 'agent', (record) => record.name || record.id),
    saveRecords(paths.agentModesRootUri, paths.agentModesIndexUri, state.agentModes, 'agentMode', (record) => record.name || record.id),
    saveRecords(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, state.toolPolicies, 'toolPolicy', (record) => record.name || record.id),
    saveRecords(paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri, state.toolPolicyScopeLinks, 'link'),
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

export async function saveConversationRenderDetailToStores(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  const detail = conversationRenderDetailSlice(state, conversationId);
  const detailRoot = conversationDetailRoot(paths, conversationId);
  await Promise.all([
    saveRecords(...subStore(detailRoot, CONVERSATION_MESSAGES_DIR), detail.messages, 'message'),
    saveRecords(...subStore(detailRoot, CONVERSATION_MESSAGE_REVISIONS_DIR), detail.messageRevisions, 'revision'),
    saveRecords(...subStore(detailRoot, MESSAGE_CURRENT_REVISION_LINKS_DIR), detail.messageCurrentRevisionLinks, 'link'),
    saveRecords(...subStore(detailRoot, CONVERSATION_TOOL_CALLS_DIR), detail.toolCalls, 'toolCall'),
    saveRecords(...subStore(detailRoot, CONVERSATION_TOOL_CALL_EVENTS_DIR), detail.toolCallEvents, 'event')
  ]);
}

export async function saveConversationRunHistoryToStores(
  paths: StoragePaths,
  conversationId: string,
  state: ClientState,
  options: SaveConversationRunHistoryOptions
): Promise<void> {
  const detail = conversationRunHistorySlice(state, conversationId);
  if (options.mode === 'merge' && !hasRunHistoryRecords(detail)) return;

  const runDetails = detail.agentRuns.map((run) => conversationRunDetailRecord(state, conversationId, run.id)).filter(isDefined);
  await Promise.all(runDetails.map((record) => writeRunDetail(paths, record)));

  const previousIndex = options.mode === 'merge' ? await loadRunHistoryIndex(paths, conversationId) : undefined;
  const previousRuns = options.mode === 'merge' ? previousIndex?.runs ?? [] : [];
  const summaries = uniqueRunSummaries([...previousRuns, ...runDetails.map((record) => record.summary).filter(isDefined)])
    .sort(compareRunSummaries);
  await writeRunHistoryIndexAndPages(paths, conversationId, summaries);
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

export function conversationRenderDetailSlice(state: ClientState, conversationId: string): ClientState {
  const detail = createEmptyClientState();
  detail.messages = state.messages.filter((message) => message.conversationId === conversationId);
  const messageIds = new Set(detail.messages.map((message) => message.id));
  detail.messageRevisions = state.messageRevisions.filter((revision) => revision.conversationId === conversationId || messageIds.has(revision.messageId));
  const revisionIds = new Set(detail.messageRevisions.map((revision) => revision.id));
  detail.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || revisionIds.has(link.revisionId));
  detail.toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(detail.toolCalls.map((toolCall) => toolCall.id));
  detail.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  return detail;
}

export function conversationRunHistorySlice(state: ClientState, conversationId: string): ClientState {
  const detail = createEmptyClientState();
  const messages = state.messages.filter((message) => message.conversationId === conversationId);
  const messageIds = new Set(messages.map((message) => message.id));
  const toolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
  const revisionIds = new Set(
    state.messageRevisions
      .filter((revision) => revision.conversationId === conversationId || messageIds.has(revision.messageId))
      .map((revision) => revision.id)
  );

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

export function conversationDetailSlice(state: ClientState, conversationId: string): ClientState {
  const detail = conversationRenderDetailSlice(state, conversationId);
  copyRunHistoryTables(detail, conversationRunHistorySlice(state, conversationId));
  return detail;
}

function copyRunHistoryTables(target: ClientState, source: ClientState): void {
  target.agentRuns = source.agentRuns;
  target.agentRunSourceLinks = source.agentRunSourceLinks;
  target.agentRunTargetLinks = source.agentRunTargetLinks;
  target.messageRunLinks = source.messageRunLinks;
  target.toolCallRunLinks = source.toolCallRunLinks;
  target.runConversationPolicies = source.runConversationPolicies;
  target.runContextPolicies = source.runContextPolicies;
  target.runDeliveryPolicies = source.runDeliveryPolicies;
  target.runEditPolicies = source.runEditPolicies;
  target.runModeLinks = source.runModeLinks;
  target.runSystemPromptLinks = source.runSystemPromptLinks;
  target.runModelProfileLinks = source.runModelProfileLinks;
  target.runToolPolicyLinks = source.runToolPolicyLinks;
  target.runApprovalPolicyLinks = source.runApprovalPolicyLinks;
  target.runConversationPolicyLinks = source.runConversationPolicyLinks;
  target.runContextPolicyLinks = source.runContextPolicyLinks;
  target.runDeliveryPolicyLinks = source.runDeliveryPolicyLinks;
  target.runEditPolicyLinks = source.runEditPolicyLinks;
  target.agentRunInputRevisions = source.agentRunInputRevisions;
}

function conversationRunDetailRecord(state: ClientState, conversationId: string, runId: string): ConversationRunDetailRecord | undefined {
  const detail = runDetailSlice(state, runId);
  const summary = conversationRunSummaryFromDetail(conversationId, detail);
  if (!summary) return undefined;
  return { conversationId, runId, summary, state: detail };
}

function runDetailSlice(state: ClientState, runId: string): ClientState {
  const detail = createEmptyClientState();
  const runIds = new Set([runId]);
  detail.agentRuns = state.agentRuns.filter((run) => runIds.has(run.id));
  if (detail.agentRuns.length === 0) return detail;

  detail.agentRunSourceLinks = state.agentRunSourceLinks.filter((link) => link.runId === runId);
  detail.agentRunTargetLinks = state.agentRunTargetLinks.filter((link) => link.runId === runId);
  detail.messageRunLinks = state.messageRunLinks.filter((link) => link.runId === runId);
  detail.toolCallRunLinks = state.toolCallRunLinks.filter((link) => link.runId === runId);
  detail.runModeLinks = state.runModeLinks.filter((link) => link.runId === runId);
  detail.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => link.runId === runId);
  detail.runModelProfileLinks = state.runModelProfileLinks.filter((link) => link.runId === runId);
  detail.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => link.runId === runId);
  detail.runApprovalPolicyLinks = state.runApprovalPolicyLinks.filter((link) => link.runId === runId);
  detail.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => link.runId === runId);
  detail.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => link.runId === runId);
  detail.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => link.runId === runId);
  detail.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => link.runId === runId);
  detail.agentRunInputRevisions = state.agentRunInputRevisions.filter((input) => input.runId === runId);

  const conversationPolicyIds = new Set(detail.runConversationPolicyLinks.map((link) => link.policyId));
  const contextPolicyIds = new Set(detail.runContextPolicyLinks.map((link) => link.policyId));
  const deliveryPolicyIds = new Set(detail.runDeliveryPolicyLinks.map((link) => link.policyId));
  const editPolicyIds = new Set(detail.runEditPolicyLinks.map((link) => link.policyId));
  detail.runConversationPolicies = state.runConversationPolicies.filter((policy) => conversationPolicyIds.has(policy.id));
  detail.runContextPolicies = state.runContextPolicies.filter((policy) => contextPolicyIds.has(policy.id));
  detail.runDeliveryPolicies = state.runDeliveryPolicies.filter((policy) => deliveryPolicyIds.has(policy.id));
  detail.runEditPolicies = state.runEditPolicies.filter((policy) => editPolicyIds.has(policy.id));

  const messageIds = new Set<string>();
  for (const link of detail.messageRunLinks) messageIds.add(link.messageId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceMessageId) messageIds.add(link.sourceMessageId);

  const toolCallIds = new Set<string>();
  for (const link of detail.toolCallRunLinks) toolCallIds.add(link.toolCallId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceToolCallId) toolCallIds.add(link.sourceToolCallId);

  const revisionIds = new Set(detail.agentRunInputRevisions.map((input) => input.revisionId));
  const inputRevisions = state.messageRevisions.filter((revision) => revisionIds.has(revision.id));
  for (const revision of inputRevisions) messageIds.add(revision.messageId);

  detail.messages = state.messages.filter((message) => messageIds.has(message.id));
  detail.messageRevisions = state.messageRevisions.filter((revision) => revisionIds.has(revision.id) || messageIds.has(revision.messageId));
  const allRevisionIds = new Set(detail.messageRevisions.map((revision) => revision.id));
  detail.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || allRevisionIds.has(link.revisionId));

  detail.toolCalls = state.toolCalls.filter((toolCall) => toolCallIds.has(toolCall.id) || messageIds.has(toolCall.messageId));
  for (const toolCall of detail.toolCalls) toolCallIds.add(toolCall.id);
  detail.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));

  const conversationIds = new Set<string>();
  for (const link of detail.agentRunTargetLinks) conversationIds.add(link.conversationId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceConversationId) conversationIds.add(link.sourceConversationId);
  for (const input of detail.agentRunInputRevisions) conversationIds.add(input.conversationId);
  detail.conversations = state.conversations.filter((conversation) => conversationIds.has(conversation.id));

  return detail;
}

function conversationRunSummaryFromDetail(conversationId: string, detail: ClientState): ConversationRunSummaryRecord | undefined {
  const run = detail.agentRuns[0];
  if (!run) return undefined;
  const target = detail.agentRunTargetLinks.find((link) => link.conversationId === conversationId);
  const source = detail.agentRunSourceLinks.find((link) => link.sourceConversationId === conversationId) ?? detail.agentRunSourceLinks[0];
  const inputTouchesConversation = detail.agentRunInputRevisions.some((input) => input.conversationId === conversationId);
  if (!target && !source && !inputTouchesConversation) return undefined;

  const inputMessageIds = new Set(detail.messageRunLinks.filter((link) => link.role === 'input').map((link) => link.messageId));
  const outputMessageIds = new Set(detail.messageRunLinks.filter((link) => link.role !== 'input').map((link) => link.messageId));
  const toolCallIds = new Set([...detail.toolCallRunLinks.map((link) => link.toolCallId), ...detail.toolCalls.map((toolCall) => toolCall.id)]);
  const inputMessages = detail.messages.filter((message) => inputMessageIds.has(message.id)).sort(compareMessagesBySeq);
  const outputMessages = detail.messages.filter((message) => outputMessageIds.has(message.id)).sort(compareMessagesBySeq);

  return {
    id: run.id,
    conversationId,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.endReason !== undefined ? { endReason: run.endReason } : {}),
    ...(run.errorType !== undefined ? { errorType: run.errorType } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.retryOfRunId !== undefined ? { retryOfRunId: run.retryOfRunId } : {}),
    ...(run.attempt !== undefined ? { attempt: run.attempt } : {}),
    ...(source?.sourceKind !== undefined ? { sourceKind: source.sourceKind } : {}),
    ...(source?.sourceMessageId !== undefined ? { sourceMessageId: source.sourceMessageId } : {}),
    ...(source?.sourceToolCallId !== undefined ? { sourceToolCallId: source.sourceToolCallId } : {}),
    ...(source?.sourceRunId !== undefined ? { sourceRunId: source.sourceRunId } : {}),
    ...(target?.agentId !== undefined ? { targetAgentId: target.agentId } : {}),
    ...(target?.conversationId !== undefined ? { targetConversationId: target.conversationId } : {}),
    inputMessageCount: inputMessageIds.size,
    outputMessageCount: outputMessageIds.size,
    ...(inputMessageIds.size > 0 ? { inputMessageIds: [...inputMessageIds] } : {}),
    ...(outputMessageIds.size > 0 ? { outputMessageIds: [...outputMessageIds] } : {}),
    ...(toolCallIds.size > 0 ? { toolCallIds: [...toolCallIds] } : {}),
    toolCallCount: toolCallIds.size,
    ...(messagePreview(inputMessages[0]) ? { inputPreview: messagePreview(inputMessages[0]) } : {}),
    ...(messagePreview(outputMessages[outputMessages.length - 1]) ? { outputPreview: messagePreview(outputMessages[outputMessages.length - 1]) } : {})
  };
}

async function loadRunHistoryIndex(paths: StoragePaths, conversationId: string): Promise<ConversationRunHistoryIndexFile | undefined> {
  const index = await readJson<ConversationRunHistoryIndexFile>(vscode.Uri.joinPath(runHistoryRoot(paths, conversationId), INDEX_FILE));
  if (!index || index.schemaVersion !== STORAGE_VERSION || index.conversationId !== conversationId) return undefined;
  return index;
}

async function readRunHistoryPage(paths: StoragePaths, conversationId: string, file: string): Promise<ConversationRunHistoryPageFile | undefined> {
  const page = await readJson<ConversationRunHistoryPageFile>(vscode.Uri.joinPath(runHistoryRoot(paths, conversationId), ...file.split('/')));
  if (!page || page.schemaVersion !== STORAGE_VERSION || page.conversationId !== conversationId) return undefined;
  return page;
}

async function loadRunDetail(paths: StoragePaths, conversationId: string, runId: string): Promise<ConversationRunDetailRecord | undefined> {
  const file = await readJson<RunHistoryDetailFile>(runDetailUri(paths, runId));
  if (!file || file.schemaVersion !== STORAGE_VERSION || file.runId !== runId) return undefined;
  const summary = file.summaries.find((candidate) => candidate.conversationId === conversationId);
  if (!summary) return undefined;
  return { conversationId, runId: file.runId, summary, state: file.state };
}

async function writeRunDetail(paths: StoragePaths, record: ConversationRunDetailRecord): Promise<void> {
  const existing = await readJson<RunHistoryDetailFile>(runDetailUri(paths, record.runId));
  const state = createEmptyClientState();
  if (existing?.schemaVersion === STORAGE_VERSION && existing.runId === record.runId) {
    mergeClientStateTables(state, existing.state, RUN_DETAIL_TABLE_KEYS);
  }
  mergeClientStateTables(state, record.state, RUN_DETAIL_TABLE_KEYS);

  const summaries = uniqueRunSummaries([
    ...(existing?.schemaVersion === STORAGE_VERSION && existing.runId === record.runId ? existing.summaries : []),
    record.summary
  ].filter(isDefined)).sort(compareRunSummaries);

  await writeJson(runDetailUri(paths, record.runId), {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date().toISOString(),
    runId: record.runId,
    summaries,
    state
  } satisfies RunHistoryDetailFile);
}

async function writeRunHistoryIndexAndPages(paths: StoragePaths, conversationId: string, summaries: ConversationRunSummaryRecord[]): Promise<void> {
  const savedAt = new Date().toISOString();
  const root = runHistoryRoot(paths, conversationId);
  const pagesRoot = vscode.Uri.joinPath(root, RUN_HISTORY_PAGES_DIR);
  await vscode.workspace.fs.createDirectory(pagesRoot);

  const pageSize = RUN_HISTORY_PAGE_SIZE;
  const pages: ConversationRunHistoryPageIndexRecord[] = [];
  const pageCount = Math.ceil(summaries.length / pageSize);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const runs = summaries.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const file = `${RUN_HISTORY_PAGES_DIR}/${pageIndex.toString().padStart(6, '0')}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      conversationId,
      runs
    } satisfies ConversationRunHistoryPageFile);
    pages.push({
      file,
      count: runs.length,
      ...(runs[0]?.updatedAt !== undefined ? { newestUpdatedAt: runs[0].updatedAt } : {}),
      ...(runs[runs.length - 1]?.updatedAt !== undefined ? { oldestUpdatedAt: runs[runs.length - 1].updatedAt } : {})
    });
  }

  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    conversationId,
    pageSize,
    total: summaries.length,
    runs: summaries,
    pages
  } satisfies ConversationRunHistoryIndexFile);
}

function uniqueRunSummaries(items: ConversationRunSummaryRecord[]): ConversationRunSummaryRecord[] {
  return [...new Map(items.map((item) => [`${item.conversationId}:${item.id}`, item])).values()];
}

function compareRunSummaries(left: ConversationRunSummaryRecord, right: ConversationRunSummaryRecord): number {
  return right.createdAt - left.createdAt || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id);
}

function mergeClientStateTables(target: ClientState, source: ClientState, keys: readonly string[] = RUN_HISTORY_TABLE_KEYS): void {
  const writableTarget = target as unknown as Record<string, StoreRecord[]>;
  const readableSource = source as unknown as Record<string, StoreRecord[]>;
  for (const key of keys) writableTarget[key] = upsertManyById(writableTarget[key] ?? [], readableSource[key] ?? []);
}

function upsertManyById<T extends StoreRecord>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}

function normalizeRunHistoryPageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return RUN_HISTORY_PAGE_SIZE;
  return Math.max(1, Math.min(100, Math.floor(value)));
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

async function loadSkeletonRecords<TRecord extends StoreRecord>(
  _label: string,
  location: [vscode.Uri, vscode.Uri],
  recordKey: StoreKey
): Promise<TRecord[]> {
  const [root, indexUri] = location;
  return loadRecords<TRecord>(root, indexUri, recordKey);
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

function conversationDetailRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.conversationsRootUri, CONVERSATION_DETAILS_DIR, safeShardName(conversationId));
}

function detailStore(paths: StoragePaths, conversationId: string, dir: string): StoreLocation {
  const [root, indexUri] = subStore(conversationDetailRoot(paths, conversationId), dir);
  return { root, indexUri };
}

function runHistoryRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.runHistoryRootUri, RUN_HISTORY_CONVERSATIONS_DIR, safeShardName(conversationId));
}

function runDetailUri(paths: StoragePaths, runId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.runHistoryRootUri, RUN_HISTORY_RUNS_DIR, `${safeShardName(runId)}.json`);
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

function hasRunHistoryRecords(state: ClientState): boolean {
  return RUN_HISTORY_TABLE_KEYS.some((key) => state[key].length > 0);
}

function compareMessagesBySeq(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function messagePreview(message: MessageRecord | undefined): string {
  if (!message) return '';
  const text = normalizeText(textPreview(message));
  if (text) return truncateText(text, 120);
  return message.role === 'user' ? '用户消息' : message.status === 'streaming' ? '响应中' : '空响应';
}

function textPreview(message: MessageRecord): string {
  for (const part of message.content.parts) {
    if ('text' in part && part.thought !== true && part.text.trim()) return part.text;
    if ('functionCall' in part) return `调用工具：${part.functionCall.name}`;
    if ('functionResponse' in part) return `工具返回：${part.functionResponse.name}`;
    if ('fileData' in part) return `文件：${part.fileData.uri}`;
    if ('inlineData' in part) return `附件：${part.inlineData.mimeType}`;
  }
  return '';
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
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
