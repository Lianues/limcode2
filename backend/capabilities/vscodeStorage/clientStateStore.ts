import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentAnswerRecord,
  AgentAnswerSubmissionLinkRecord,
  AgentAnswerTargetLinkRecord,
  AgentRecord,
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ClientState,
  ConversationCheckpointRepositoryLinkRecord,
  ConversationBranchLinkRecord,
  ConversationAgentSelectionRecord,
  ConversationWorkflowSelectionRecord,
  ConversationProjectLinkRecord,
  ConversationRecord,
  ConversationRunDetailRecord,
  ConversationRunHistoryPageRecord,
  ConversationRunSummaryRecord,
  ConversationTimelinePageRecord,
  ConversationTimelinePageRequest,
  ConversationOriginLinkRecord,
  ConversationReuseLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  WorkflowRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  ProjectContextRecord,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  RuntimeContextSnapshotRecord,
  ConversationRuntimeContextSnapshotLinkRecord,
  RunHistorySettingsRecord,
  RunRuntimeContextSnapshotLinkRecord,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  SkillPolicyRecord,
  SkillPolicyScopeLinkRecord,
  WorkEnvironmentRecord,
  ShadowRepositoryRecord,
  ConversationWorkEnvironmentLinkRecord,
  RunWorkEnvironmentLinkRecord,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord
} from '../../../shared/protocol';
import { createEmptyClientState, isConversationScopeLinkRecord } from '../../../shared/clientStateSchema';
import { INDEX_FILE, STORAGE_VERSION } from './constants';
import { createVscodeStoragePaths } from './paths';
import { loadRecordStore, removeRecordStoreRecord, saveRecordStore } from './recordStore';
import { isFileNotFoundError as isStorageFileNotFoundError, readJsonStrict, writeJson } from './json';
import { loadGlobalSettingsFile } from './globalSettings';
import {
  loadConversationTimelinePage,
  loadConversationTimelineRange,
  loadConversationTimelineDetail,
  mergeConversationTimelineDetailIntoStore,
  mutateConversationTimelineDetailInStore,
  saveConversationTimelineDetail,
  saveConversationTimelineRenderDetailIncremental,
  truncateConversationTimeline
} from './conversationTimelineStore';
import { withStorageResourceLock } from './storageResourceLock';
import {
  cleanupInactiveStorageGenerations,
  createStorageGenerationLocation,
  isSafeStorageGenerationId,
  STORAGE_GENERATIONS_DIR
} from './storageGeneration';
import { loadConversationCompressionDetail, saveConversationCompressionDetail } from './compressionStore';
import { assertUniqueClientStateIds, assertUniqueRecords } from '../../utils/uniqueIds';
import type { DeleteConversationDataResult } from '../types';
import { deleteShadowWorktreeDirectory } from './shadowWorktreeLock';
import {
  withClientStateSkeletonMutation,
  withClientStateSkeletonReadTransaction
} from './clientStateSkeletonTransaction';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export interface LoadConversationDetailOptions {
  includeRunHistory?: boolean;
}

export interface LoadClientStateSkeletonOptions {
  profile?: 'startup' | 'deferred' | 'full';
}

export interface SaveConversationRunHistoryOptions {
  mode: 'merge' | 'replace';
}

export interface ClientStateSkeletonStoreTestHooks {
  afterStoresSaved?: () => void | Promise<void>;
}

export const __clientStateSkeletonStoreTestHooks: ClientStateSkeletonStoreTestHooks = {};

type StoreKey = string;
type StoreRecord = { id: string };


interface ConversationRunHistoryIndexFile {
  kind: 'conversationRunHistory.index';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  conversationId: string;
  pageSize: number;
  total: number;
  runs: ConversationRunSummaryRecord[];
  pages: ConversationRunHistoryPageIndexRecord[];
}

interface ConversationRunHistoryPageIndexRecord {
  generation: string;
  file: string;
  count: number;
  newestUpdatedAt?: number;
  oldestUpdatedAt?: number;
}

interface ConversationRunHistoryPageFile {
  kind: 'conversationRunHistory.page';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  generation: string;
  conversationId: string;
  runs: ConversationRunSummaryRecord[];
}

interface RunHistoryDetailFile {
  kind: 'runHistory.detail';
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  runId: string;
  summaries: ConversationRunSummaryRecord[];
  state: ClientState;
}

interface ConversationRunHistoryIndexSnapshot {
  index: ConversationRunHistoryIndexFile;
  uri: vscode.Uri;
}

export interface RunHistoryStoreTestHookContext {
  rootUri: vscode.Uri;
  conversationId: string;
  generation: string;
}

export interface RunHistoryStoreReadPageHookContext extends RunHistoryStoreTestHookContext {
  pageFile: string;
  attempt: number;
}

export interface RunHistoryStoreTestHooks {
  /** 测试专用：conversation run-history pages 完整写入后、根 active index 原子发布前触发。 */
  beforePublishConversationIndex?: (context: RunHistoryStoreTestHookContext) => void | Promise<void>;
  /** 测试专用：reader 读取 index 后、读取 page 前触发，用于模拟 generation 被清理的竞态。 */
  beforeReadConversationPage?: (context: RunHistoryStoreReadPageHookContext) => void | Promise<void>;
}

export const __runHistoryStoreTestHooks: RunHistoryStoreTestHooks = {};


const CONVERSATION_REUSE_LINKS_DIR = 'reuse-links';
const CONVERSATION_BRANCH_LINKS_DIR = 'branch-links';
const CONVERSATION_ORIGIN_LINKS_DIR = 'origin-links';
const CONVERSATION_DETAILS_DIR = 'details';
const RUN_HISTORY_CONVERSATIONS_DIR = 'conversations';
const RUN_HISTORY_PAGES_DIR = 'pages';
const RUN_HISTORY_RUNS_DIR = 'runs';
const RUN_HISTORY_PAGE_SIZE = 20;
const RUN_HISTORY_PAGE_READ_MAX_ATTEMPTS = 3;

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
  'runWorkflowLinks',
  'runSystemPromptLinks',
  'runModelProfileLinks',
  'runToolPolicyLinks',
  'runRuntimeContextSnapshotLinks',
  'runConversationPolicyLinks',
  'runContextPolicyLinks',
  'runDeliveryPolicyLinks',
  'runEditPolicyLinks',
  'llmInvocations',
  'runLlmInvocationLinks',
  'messageLlmInvocationLinks',
  'runWorkEnvironmentLinks',
  'agentRunInputRevisions',
  'runCompressionBlockLinks',
  'planProposals',
  'runPlanProposalLinks'
] as const;

const RUN_DETAIL_TABLE_KEYS = [
  ...RUN_HISTORY_TABLE_KEYS,
  'conversations',
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'compressionBlockLlmInvocationLinks',
  'llmInvocations'
] as const;

export interface LoadedClientStateSkeletonSnapshot {
  state: ClientState | undefined;
  transactionId: string;
}

export async function loadClientStateSkeletonFromStores(paths: StoragePaths, options: LoadClientStateSkeletonOptions = {}): Promise<ClientState | undefined> {
  return (await loadClientStateSkeletonSnapshotFromStores(paths, options)).state;
}

export async function loadClientStateSkeletonSnapshotFromStores(
  paths: StoragePaths,
  options: LoadClientStateSkeletonOptions = {},
  expectedTransactionId?: string
): Promise<LoadedClientStateSkeletonSnapshot> {
  return withClientStateSkeletonReadTransaction(paths, async ({ transactionId }) => {
    const state = createEmptyClientState();
    const profile = options.profile ?? 'full';

    if (profile === 'startup' || profile === 'full') {
      await loadStartupSkeletonRecords(paths, state);
    }

    if (profile === 'deferred' || profile === 'full') {
      await loadDeferredSkeletonRecords(paths, state);
    }

    assertUniqueClientStateIds(state, `clientStateSkeleton:${profile}`);
    return { state: hasAnyState(state) ? state : undefined, transactionId };
  }, expectedTransactionId);
}

async function loadStartupSkeletonRecords(paths: StoragePaths, state: ClientState): Promise<void> {
  const [
    agents,
    workflows,
    planReviewPolicies,
    planReviewPolicyScopeLinks,
    toolPolicies,
    toolPolicyScopeLinks,
    skillPolicies,
    skillPolicyScopeLinks,
    systemPrompts,
    systemPromptScopeLinks,
    runtimeContexts,
    runtimeContextScopeLinks,
    runtimeContextSnapshots,
    conversationRuntimeContextSnapshotLinks,
    runRuntimeContextSnapshotLinks,
    modelProfiles,
    modelProfileScopeLinks,
    conversationWorkflowSelections,
    conversations,
    conversationReuseLinks,
    conversationBranchLinks,
    conversationOriginLinks,
    agentConversationLinks,
    conversationAgentSelections,
    agentAnswers,
    agentAnswerSubmissionLinks,
    agentAnswerTargetLinks
  ] = await Promise.all([
    loadSkeletonRecords<AgentRecord>('agents', [paths.agentsRootUri, paths.agentsIndexUri], 'agent'),
    loadSkeletonRecords<WorkflowRecord>('workflows', [paths.workflowsRootUri, paths.workflowsIndexUri], 'workflow'),
    loadSkeletonRecords<PlanReviewPolicyRecord>('planReviewPolicies', [paths.planReviewPoliciesRootUri, paths.planReviewPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<PlanReviewPolicyScopeLinkRecord>('planReviewPolicyScopeLinks', [paths.planReviewPolicyScopeLinksRootUri, paths.planReviewPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ToolPolicyRecord>('toolPolicies', [paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri], 'toolPolicy'),
    loadSkeletonRecords<ToolPolicyScopeLinkRecord>('toolPolicyScopeLinks', [paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<SkillPolicyRecord>('skillPolicies', [paths.skillPoliciesRootUri, paths.skillPoliciesIndexUri], 'skillPolicy'),
    loadSkeletonRecords<SkillPolicyScopeLinkRecord>('skillPolicyScopeLinks', [paths.skillPolicyScopeLinksRootUri, paths.skillPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<SystemPromptRecord>('systemPrompts', [paths.systemPromptsRootUri, paths.systemPromptsIndexUri], 'systemPrompt'),
    loadSkeletonRecords<SystemPromptScopeLinkRecord>('systemPromptScopeLinks', [paths.systemPromptScopeLinksRootUri, paths.systemPromptScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<RuntimeContextRecord>('runtimeContexts', [paths.runtimeContextsRootUri, paths.runtimeContextsIndexUri], 'runtimeContext'),
    loadSkeletonRecords<RuntimeContextScopeLinkRecord>('runtimeContextScopeLinks', [paths.runtimeContextScopeLinksRootUri, paths.runtimeContextScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<RuntimeContextSnapshotRecord>('runtimeContextSnapshots', [paths.runtimeContextSnapshotsRootUri, paths.runtimeContextSnapshotsIndexUri], 'snapshot'),
    loadSkeletonRecords<ConversationRuntimeContextSnapshotLinkRecord>('conversationRuntimeContextSnapshotLinks', [paths.conversationRuntimeContextSnapshotLinksRootUri, paths.conversationRuntimeContextSnapshotLinksIndexUri], 'link'),
    loadSkeletonRecords<RunRuntimeContextSnapshotLinkRecord>('runRuntimeContextSnapshotLinks', [paths.runRuntimeContextSnapshotLinksRootUri, paths.runRuntimeContextSnapshotLinksIndexUri], 'link'),
    loadSkeletonRecords<ModelProfileRecord>('modelProfiles', [paths.modelProfilesRootUri, paths.modelProfilesIndexUri], 'modelProfile'),
    loadSkeletonRecords<ModelProfileScopeLinkRecord>('modelProfileScopeLinks', [paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ConversationWorkflowSelectionRecord>('conversationWorkflowSelections', [paths.conversationWorkflowSelectionsRootUri, paths.conversationWorkflowSelectionsIndexUri], 'selection'),
    loadSkeletonRecords<ConversationRecord>('conversations', [paths.conversationsRootUri, paths.conversationsIndexUri], 'conversation'),
    loadSkeletonRecords<ConversationReuseLinkRecord>('conversationReuseLinks', subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link'),
    loadSkeletonRecords<ConversationBranchLinkRecord>('conversationBranchLinks', subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link'),
    loadSkeletonRecords<ConversationOriginLinkRecord>('conversationOriginLinks', subStore(paths.conversationsRootUri, CONVERSATION_ORIGIN_LINKS_DIR), 'link'),
    loadSkeletonRecords<AgentConversationLinkRecord>('agentConversationLinks', [paths.linksRootUri, paths.linksIndexUri], 'link'),
    loadSkeletonRecords<ConversationAgentSelectionRecord>('conversationAgentSelections', [paths.conversationAgentSelectionsRootUri, paths.conversationAgentSelectionsIndexUri], 'selection'),
    loadSkeletonRecords<AgentAnswerRecord>('agentAnswers', [paths.agentAnswersRootUri, paths.agentAnswersIndexUri], 'answer'),
    loadSkeletonRecords<AgentAnswerSubmissionLinkRecord>('agentAnswerSubmissionLinks', [paths.agentAnswerSubmissionLinksRootUri, paths.agentAnswerSubmissionLinksIndexUri], 'link'),
    loadSkeletonRecords<AgentAnswerTargetLinkRecord>('agentAnswerTargetLinks', [paths.agentAnswerTargetLinksRootUri, paths.agentAnswerTargetLinksIndexUri], 'link')
  ]);

  state.agents = agents;
  state.workflows = workflows;
  state.planReviewPolicies = planReviewPolicies;
  state.planReviewPolicyScopeLinks = planReviewPolicyScopeLinks;
  state.toolPolicies = toolPolicies;
  state.toolPolicyScopeLinks = toolPolicyScopeLinks;
  state.skillPolicies = skillPolicies;
  state.skillPolicyScopeLinks = skillPolicyScopeLinks;
  state.systemPrompts = systemPrompts;
  state.systemPromptScopeLinks = systemPromptScopeLinks;
  state.runtimeContexts = runtimeContexts;
  state.runtimeContextScopeLinks = runtimeContextScopeLinks;
  state.runtimeContextSnapshots = runtimeContextSnapshots;
  state.conversationRuntimeContextSnapshotLinks = conversationRuntimeContextSnapshotLinks;
  state.runRuntimeContextSnapshotLinks = runRuntimeContextSnapshotLinks;
  state.modelProfiles = modelProfiles;
  state.modelProfileScopeLinks = modelProfileScopeLinks;
  state.conversationWorkflowSelections = conversationWorkflowSelections;
  state.conversations = conversations;
  state.conversationReuseLinks = conversationReuseLinks;
  state.conversationBranchLinks = conversationBranchLinks;
  state.conversationOriginLinks = conversationOriginLinks;
  state.agentConversationLinks = agentConversationLinks;
  state.conversationAgentSelections = conversationAgentSelections;
  state.agentAnswers = agentAnswers;
  state.agentAnswerSubmissionLinks = agentAnswerSubmissionLinks;
  state.agentAnswerTargetLinks = agentAnswerTargetLinks;
}

async function loadDeferredSkeletonRecords(paths: StoragePaths, state: ClientState): Promise<void> {
  const [
    projectContexts,
    conversationProjectLinks,
    workEnvironments,
    conversationWorkEnvironmentLinks,
    runWorkEnvironmentLinks,
    workEnvironmentPolicies,
    workEnvironmentPolicyScopeLinks,
    checkpointPolicies,
    checkpointPolicyScopeLinks,
    shadowRepositories,
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors
  ] = await Promise.all([
    loadSkeletonRecords<ProjectContextRecord>('projectContexts', [paths.projectContextsRootUri, paths.projectContextsIndexUri], 'projectContext'),
    loadSkeletonRecords<ConversationProjectLinkRecord>('conversationProjectLinks', [paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri], 'link'),
    loadSkeletonRecords<WorkEnvironmentRecord>('workEnvironments', [paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri], 'workEnvironment'),
    loadSkeletonRecords<ConversationWorkEnvironmentLinkRecord>('conversationWorkEnvironmentLinks', [paths.conversationWorkEnvironmentLinksRootUri, paths.conversationWorkEnvironmentLinksIndexUri], 'link'),
    loadSkeletonRecords<RunWorkEnvironmentLinkRecord>('runWorkEnvironmentLinks', [paths.runWorkEnvironmentLinksRootUri, paths.runWorkEnvironmentLinksIndexUri], 'link'),
    loadSkeletonRecords<WorkEnvironmentPolicyRecord>('workEnvironmentPolicies', [paths.workEnvironmentPoliciesRootUri, paths.workEnvironmentPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<WorkEnvironmentPolicyScopeLinkRecord>('workEnvironmentPolicyScopeLinks', [paths.workEnvironmentPolicyScopeLinksRootUri, paths.workEnvironmentPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<CheckpointPolicyRecord>('checkpointPolicies', [paths.checkpointPoliciesRootUri, paths.checkpointPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<CheckpointPolicyScopeLinkRecord>('checkpointPolicyScopeLinks', [paths.checkpointPolicyScopeLinksRootUri, paths.checkpointPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ShadowRepositoryRecord>('shadowRepositories', [paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri], 'shadowRepository'),
    loadSkeletonRecords<ConversationCheckpointRepositoryLinkRecord>('conversationCheckpointRepositoryLinks', [paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri], 'link'),
    loadSkeletonRecords<CheckpointRecord>('checkpoints', [paths.checkpointsRootUri, paths.checkpointsIndexUri], 'checkpoint'),
    loadSkeletonRecords<CheckpointTimelineAnchorRecord>('checkpointTimelineAnchors', [paths.checkpointTimelineAnchorsRootUri, paths.checkpointTimelineAnchorsIndexUri], 'anchor')
  ]);

  state.projectContexts = projectContexts;
  state.conversationProjectLinks = conversationProjectLinks;
  state.workEnvironments = workEnvironments;
  state.conversationWorkEnvironmentLinks = conversationWorkEnvironmentLinks;
  state.runWorkEnvironmentLinks = runWorkEnvironmentLinks;
  state.workEnvironmentPolicies = workEnvironmentPolicies;
  state.workEnvironmentPolicyScopeLinks = workEnvironmentPolicyScopeLinks;
  state.checkpointPolicies = checkpointPolicies;
  state.checkpointPolicyScopeLinks = checkpointPolicyScopeLinks;
  state.shadowRepositories = shadowRepositories;
  state.conversationCheckpointRepositoryLinks = conversationCheckpointRepositoryLinks;
  state.checkpoints = checkpoints;
  state.checkpointTimelineAnchors = checkpointTimelineAnchors;
}

export async function loadConversationDetailFromStores(
  paths: StoragePaths,
  conversationId: string,
  options: LoadConversationDetailOptions = {}
): Promise<ClientState | undefined> {
  const includeRunHistory = options.includeRunHistory ?? false;
  const timeline = await loadConversationTimelineDetail(paths, conversationId);
  const state = timeline ?? createEmptyClientState();
  let hasExplicitDetail = timeline !== undefined;
  const compression = await loadConversationCompressionDetail(paths, conversationId, {
    knownMessageIds: new Set(state.messages.map((message) => message.id))
  });
  if (compression) {
    copyCompressionTables(state, compression);
    hasExplicitDetail = true;
  }

  if (includeRunHistory) {
    const runHistory = await loadConversationRunHistoryFromStores(paths, conversationId);
    if (runHistory) {
      copyRunHistoryTables(state, runHistory);
      hasExplicitDetail = true;
    }
  }

  assertUniqueClientStateIds(state, `conversationDetail:${conversationId}`);
  return hasExplicitDetail || hasAnyState(state) ? state : undefined;
}

export async function loadConversationTimelinePageFromStores(paths: StoragePaths, request: ConversationTimelinePageRequest): Promise<ConversationTimelinePageRecord> {
  const page = await loadConversationTimelinePage(paths, request);
  const compression = await loadConversationCompressionDetail(paths, request.conversationId, { includeSourceLinks: false });
  if (compression) {
    copyCompressionTables(page.state, compression);
    pruneCompressionTablesToTimelinePage(page.state, page.pageInfo.startSeq, page.pageInfo.endSeq);
  }
  assertUniqueClientStateIds(page.state, `conversationTimelinePage:${request.conversationId}`);
  return page;
}

export async function loadConversationTimelineRangeFromStores(paths: StoragePaths, request: {
  conversationId: string;
  mode: 'suffix' | 'prefix' | 'between';
  anchorMessageId?: string;
  startMessageId?: string;
  endMessageId?: string;
  contextBeforeChunks?: number;
}): Promise<ClientState | undefined> {
  const state = await loadConversationTimelineRange(paths, request);
  if (!state) return undefined;
  const compression = await loadConversationCompressionDetail(paths, request.conversationId);
  if (compression) copyCompressionTables(state, compression);
  const runHistory = await loadConversationRunHistoryForMessagesFromStores(
    paths,
    request.conversationId,
    new Set(state.messages.map((message) => message.id))
  );
  if (runHistory) copyRunHistoryTables(state, runHistory);
  assertUniqueClientStateIds(state, `conversationTimelineRange:${request.conversationId}`);
  return state;
}

export async function truncateConversationTimelineFromStores(paths: StoragePaths, request: {
  conversationId: string;
  anchorMessageId: string;
  keepAnchor: boolean;
}): Promise<{ conversationId: string; removedMessageIds: string[] }> {
  return truncateConversationTimeline(paths, request);
}



export async function loadConversationRunHistoryPageFromStores(paths: StoragePaths, request: { conversationId: string; cursor?: string; limit?: number }): Promise<ConversationRunHistoryPageRecord> {
  const requestedPageIndex = Math.max(0, Number.parseInt(request.cursor ?? '0', 10) || 0);
  let lastError: unknown;

  for (let attempt = 1; attempt <= RUN_HISTORY_PAGE_READ_MAX_ATTEMPTS; attempt += 1) {
    const index = await loadRunHistoryIndex(paths, request.conversationId);
    const pageSize = normalizeRunHistoryPageSize(index?.pageSize ?? request.limit);
    if (!index || index.total === 0) return emptyRunHistoryPage(request.conversationId, requestedPageIndex, pageSize);

    const pageCount = Math.max(1, Math.ceil(index.total / pageSize));
    const pageIndex = Math.min(requestedPageIndex, pageCount - 1);
    const pageRecord = index.pages[pageIndex];
    if (!pageRecord) {
      console.warn(`[LimCode] Run history index has no page record for ${request.conversationId} page ${pageIndex}.`);
      return emptyRunHistoryPage(request.conversationId, pageIndex, pageSize);
    }

    try {
      await __runHistoryStoreTestHooks.beforeReadConversationPage?.({
        rootUri: runHistoryRoot(paths, request.conversationId),
        conversationId: request.conversationId,
        generation: index.generation,
        pageFile: pageRecord.file,
        attempt
      });
      const page = await readRunHistoryPageStrict(runHistoryRoot(paths, request.conversationId), request.conversationId, pageRecord);
      const confirmedIndex = await loadRunHistoryIndex(paths, request.conversationId);
      if (confirmedIndex?.generation !== index.generation) {
        lastError = new Error(`Run history generation changed while reading page: ${index.generation} -> ${confirmedIndex?.generation ?? 'missing'}`);
        continue;
      }

      const runs = page.runs.map(normalizeRestoredRunLikeRecord);
      assertUniqueRecords(runs, `runHistoryPage:${request.conversationId}`);
      return {
        conversationId: request.conversationId,
        runs,
        pageInfo: {
          cursor: String(pageIndex),
          ...(pageIndex > 0 ? { previousCursor: String(pageIndex - 1) } : {}),
          ...(pageIndex + 1 < pageCount ? { nextCursor: String(pageIndex + 1) } : {}),
          pageIndex,
          pageSize,
          total: index.total,
          hasNext: pageIndex + 1 < pageCount,
          hasPrevious: pageIndex > 0
        }
      };
    } catch (error) {
      lastError = error;
      const latestIndex = await loadRunHistoryIndex(paths, request.conversationId);
      if (latestIndex?.generation !== index.generation && attempt < RUN_HISTORY_PAGE_READ_MAX_ATTEMPTS) continue;
      console.warn(`[LimCode] Failed to load stable run history page for ${request.conversationId}: ${pageRecord.file}`, error);
      return emptyRunHistoryPage(request.conversationId, pageIndex, pageSize);
    }
  }

  console.warn(`[LimCode] Failed to load stable run history page for ${request.conversationId} after retries:`, lastError);
  return emptyRunHistoryPage(request.conversationId, requestedPageIndex, normalizeRunHistoryPageSize(request.limit));
}

function emptyRunHistoryPage(conversationId: string, pageIndex: number, pageSize: number): ConversationRunHistoryPageRecord {
  return {
    conversationId,
    runs: [],
    pageInfo: {
      cursor: String(Math.max(0, pageIndex)),
      pageIndex: Math.max(0, pageIndex),
      pageSize,
      total: 0,
      hasNext: false,
      hasPrevious: false
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

async function loadConversationRunHistoryForMessagesFromStores(paths: StoragePaths, conversationId: string, messageIds: ReadonlySet<string>): Promise<ClientState | undefined> {
  if (messageIds.size === 0) return undefined;
  const index = await loadRunHistoryIndex(paths, conversationId);
  if (!index || index.runs.length === 0) return undefined;
  const ids = [...messageIds];
  const referencedRuns = index.runs.filter((run) => ids.some((messageId) => summaryReferencesMessage(run, messageId)));
  if (referencedRuns.length === 0) return undefined;
  const state = createEmptyClientState();
  const details = await Promise.all(referencedRuns.map((run) => loadRunDetail(paths, conversationId, run.id)));
  for (const detail of details) {
    if (detail) mergeClientStateTables(state, detail.state);
  }
  return state;
}

export async function deleteConversationDataFromStores(paths: StoragePaths, conversationId: string): Promise<DeleteConversationDataResult> {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) {
    return { ok: false, conversationId, deletedPaths: [], errors: ['conversationId is empty'] };
  }
  return withClientStateSkeletonMutation(paths, async () => {
    const result = await deleteConversationDataFromStoresUnlocked(paths, normalizedConversationId);
    return { value: result, commit: result.ok };
  });
}

async function deleteConversationDataFromStoresUnlocked(paths: StoragePaths, normalizedConversationId: string): Promise<DeleteConversationDataResult> {
  const deletedPaths: string[] = [];
  const errors: string[] = [];

  const runIds = await collectRunIdsForDeletion(paths, normalizedConversationId, errors);
  const checkpointDeletion = await collectCheckpointDeletionPlan(paths, normalizedConversationId, errors);

  await tryDeleteUri(conversationDetailRoot(paths, normalizedConversationId), deletedPaths, errors, { recursive: true });
  await tryDeleteUri(runHistoryRoot(paths, normalizedConversationId), deletedPaths, errors, { recursive: true });
  for (const runId of runIds) {
    await pruneRunDetailForConversation(paths, runId, normalizedConversationId, deletedPaths, errors);
  }

  for (const root of [
    paths.compressionBlocksRootUri,
    paths.compressionBlockSourceLinksRootUri,
    paths.compressionContextVariantsRootUri,
    paths.compressionBlockLlmInvocationLinksRootUri,
    paths.compressionLlmInvocationsRootUri
  ]) {
    await tryDeleteUri(vscode.Uri.joinPath(root, 'conversations', safeShardName(normalizedConversationId)), deletedPaths, errors, { recursive: true });
  }

  await removeStoreRecord(paths.conversationsRootUri, paths.conversationsIndexUri, normalizedConversationId, 'conversation', deletedPaths, errors);
  await pruneStoreRecords<ConversationReuseLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationBranchLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link', (record) => record.sourceConversationId === normalizedConversationId || record.targetConversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationOriginLinkRecord>(...subStore(paths.conversationsRootUri, CONVERSATION_ORIGIN_LINKS_DIR), 'link', (record) => record.conversationId === normalizedConversationId || record.sourceConversationId === normalizedConversationId || runIds.has(record.sourceRunId ?? ''), deletedPaths, errors);
  await pruneStoreRecords<AgentConversationLinkRecord>(paths.linksRootUri, paths.linksIndexUri, 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationAgentSelectionRecord>(paths.conversationAgentSelectionsRootUri, paths.conversationAgentSelectionsIndexUri, 'selection', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationWorkflowSelectionRecord>(paths.conversationWorkflowSelectionsRootUri, paths.conversationWorkflowSelectionsIndexUri, 'selection', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationProjectLinkRecord>(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationWorkEnvironmentLinkRecord>(paths.conversationWorkEnvironmentLinksRootUri, paths.conversationWorkEnvironmentLinksIndexUri, 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<ConversationRuntimeContextSnapshotLinkRecord>(paths.conversationRuntimeContextSnapshotLinksRootUri, paths.conversationRuntimeContextSnapshotLinksIndexUri, 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<CheckpointPolicyScopeLinkRecord>(paths.checkpointPolicyScopeLinksRootUri, paths.checkpointPolicyScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<WorkEnvironmentPolicyScopeLinkRecord>(paths.workEnvironmentPolicyScopeLinksRootUri, paths.workEnvironmentPolicyScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<SystemPromptScopeLinkRecord>(paths.systemPromptScopeLinksRootUri, paths.systemPromptScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<ModelProfileScopeLinkRecord>(paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<RuntimeContextScopeLinkRecord>(paths.runtimeContextScopeLinksRootUri, paths.runtimeContextScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<PlanReviewPolicyScopeLinkRecord>(paths.planReviewPolicyScopeLinksRootUri, paths.planReviewPolicyScopeLinksIndexUri, 'link', (record) => isConversationScopeLinkRecord(record, normalizedConversationId), deletedPaths, errors);
  await pruneStoreRecords<ConversationCheckpointRepositoryLinkRecord>(paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri, 'link', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<CheckpointRecord>(paths.checkpointsRootUri, paths.checkpointsIndexUri, 'checkpoint', (record) => record.conversationId === normalizedConversationId, deletedPaths, errors);
  await pruneStoreRecords<CheckpointTimelineAnchorRecord>(paths.checkpointTimelineAnchorsRootUri, paths.checkpointTimelineAnchorsIndexUri, 'anchor', (record) => record.conversationId === normalizedConversationId || checkpointDeletion.checkpointIds.has(record.checkpointId), deletedPaths, errors);
  if (checkpointDeletion.shadowRepositoryIds.size > 0) {
    await pruneStoreRecords<ShadowRepositoryRecord>(paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri, 'shadowRepository', (record) => checkpointDeletion.shadowRepositoryIds.has(record.id), deletedPaths, errors);
    await deleteUnusedShadowWorktreeDirectories(paths, checkpointDeletion.storageKeys, deletedPaths, errors);
  }

  if (runIds.size > 0) {
    await pruneStoreRecords<RunRuntimeContextSnapshotLinkRecord>(paths.runRuntimeContextSnapshotLinksRootUri, paths.runRuntimeContextSnapshotLinksIndexUri, 'link', (record) => runIds.has(record.runId), deletedPaths, errors);
    await pruneStoreRecords<RunWorkEnvironmentLinkRecord>(paths.runWorkEnvironmentLinksRootUri, paths.runWorkEnvironmentLinksIndexUri, 'link', (record) => runIds.has(record.runId), deletedPaths, errors);
  }

  return { ok: errors.length === 0, conversationId: normalizedConversationId, deletedPaths, errors };
}

export async function saveClientStateSkeletonToStores(paths: StoragePaths, state: ClientState): Promise<void> {
  return withClientStateSkeletonMutation(paths, async () => {
    await saveClientStateSkeletonToStoresUnlocked(paths, state);
    return { value: undefined, commit: true };
  });
}

async function saveClientStateSkeletonToStoresUnlocked(paths: StoragePaths, state: ClientState): Promise<void> {
  assertUniqueClientStateIds(state, 'saveClientStateSkeleton');
  const results = await Promise.allSettled([
    saveRecords(paths.agentsRootUri, paths.agentsIndexUri, state.agents, 'agent', (record) => record.name || record.id),
    saveRecords(paths.workflowsRootUri, paths.workflowsIndexUri, state.workflows, 'workflow', (record) => record.name || record.id),
    saveRecords(paths.planReviewPoliciesRootUri, paths.planReviewPoliciesIndexUri, state.planReviewPolicies, 'policy', (record) => record.id),
    saveRecords(paths.planReviewPolicyScopeLinksRootUri, paths.planReviewPolicyScopeLinksIndexUri, state.planReviewPolicyScopeLinks, 'link'),
    saveRecords(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, state.toolPolicies, 'toolPolicy', (record) => record.name || record.id),
    saveRecords(paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri, state.toolPolicyScopeLinks, 'link'),
    saveRecords(paths.skillPoliciesRootUri, paths.skillPoliciesIndexUri, state.skillPolicies, 'skillPolicy', (record) => record.name || record.id),
    saveRecords(paths.skillPolicyScopeLinksRootUri, paths.skillPolicyScopeLinksIndexUri, state.skillPolicyScopeLinks, 'link'),
    saveRecords(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, state.systemPrompts, 'systemPrompt', (record) => record.name || record.id),
    saveRecords(paths.systemPromptScopeLinksRootUri, paths.systemPromptScopeLinksIndexUri, state.systemPromptScopeLinks, 'link'),
    saveRecords(paths.runtimeContextsRootUri, paths.runtimeContextsIndexUri, state.runtimeContexts, 'runtimeContext', (record) => record.name || record.id),
    saveRecords(paths.runtimeContextScopeLinksRootUri, paths.runtimeContextScopeLinksIndexUri, state.runtimeContextScopeLinks, 'link'),
    saveRecords(paths.runtimeContextSnapshotsRootUri, paths.runtimeContextSnapshotsIndexUri, state.runtimeContextSnapshots, 'snapshot', (record) => record.name || record.id),
    saveRecords(paths.conversationRuntimeContextSnapshotLinksRootUri, paths.conversationRuntimeContextSnapshotLinksIndexUri, state.conversationRuntimeContextSnapshotLinks, 'link'),
    saveRecords(paths.runRuntimeContextSnapshotLinksRootUri, paths.runRuntimeContextSnapshotLinksIndexUri, state.runRuntimeContextSnapshotLinks, 'link'),
    saveRecords(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, state.modelProfiles, 'modelProfile', (record) => record.name || record.id),
    saveRecords(paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri, state.modelProfileScopeLinks, 'link'),
    saveRecords(paths.conversationWorkflowSelectionsRootUri, paths.conversationWorkflowSelectionsIndexUri, state.conversationWorkflowSelections, 'selection'),
    saveRecords(paths.conversationsRootUri, paths.conversationsIndexUri, state.conversations, 'conversation', (record) => record.title || record.id),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), state.conversationReuseLinks, 'link'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), state.conversationBranchLinks, 'link'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_ORIGIN_LINKS_DIR), state.conversationOriginLinks, 'link'),
    saveRecords(paths.linksRootUri, paths.linksIndexUri, state.agentConversationLinks, 'link'),
    saveRecords(paths.conversationAgentSelectionsRootUri, paths.conversationAgentSelectionsIndexUri, state.conversationAgentSelections, 'selection'),
    saveRecords(paths.agentAnswersRootUri, paths.agentAnswersIndexUri, state.agentAnswers, 'answer', (record) => record.title || record.id),
    saveRecords(paths.agentAnswerSubmissionLinksRootUri, paths.agentAnswerSubmissionLinksIndexUri, state.agentAnswerSubmissionLinks, 'link'),
    saveRecords(paths.agentAnswerTargetLinksRootUri, paths.agentAnswerTargetLinksIndexUri, state.agentAnswerTargetLinks, 'link'),
    saveRecords(paths.projectContextsRootUri, paths.projectContextsIndexUri, state.projectContexts, 'projectContext', (record) => record.name || record.id),
    saveRecords(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, state.conversationProjectLinks, 'link'),
    saveRecords(paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri, state.workEnvironments, 'workEnvironment', (record) => record.name || record.id),
    saveRecords(paths.workEnvironmentPoliciesRootUri, paths.workEnvironmentPoliciesIndexUri, state.workEnvironmentPolicies, 'policy', (record) => record.name || record.id),
    saveRecords(paths.workEnvironmentPolicyScopeLinksRootUri, paths.workEnvironmentPolicyScopeLinksIndexUri, state.workEnvironmentPolicyScopeLinks, 'link'),
    saveRecords(paths.conversationWorkEnvironmentLinksRootUri, paths.conversationWorkEnvironmentLinksIndexUri, state.conversationWorkEnvironmentLinks, 'link'),
    saveRecords(paths.runWorkEnvironmentLinksRootUri, paths.runWorkEnvironmentLinksIndexUri, state.runWorkEnvironmentLinks, 'link'),
    saveRecords(paths.checkpointPoliciesRootUri, paths.checkpointPoliciesIndexUri, state.checkpointPolicies, 'policy', (record) => record.name || record.id),
    saveRecords(paths.checkpointPolicyScopeLinksRootUri, paths.checkpointPolicyScopeLinksIndexUri, state.checkpointPolicyScopeLinks, 'link'),
    saveRecords(paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri, state.shadowRepositories, 'shadowRepository'),
    saveRecords(paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri, state.conversationCheckpointRepositoryLinks, 'link'),
    saveRecords(paths.checkpointsRootUri, paths.checkpointsIndexUri, state.checkpoints, 'checkpoint', (record) => record.projectDisplayPath || record.id),
    saveRecords(paths.checkpointTimelineAnchorsRootUri, paths.checkpointTimelineAnchorsIndexUri, state.checkpointTimelineAnchors, 'anchor')
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    const details = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join('; ');
    throw new Error(`Failed to save ${failures.length} client state store(s): ${details}`);
  }
  await __clientStateSkeletonStoreTestHooks.afterStoresSaved?.();
}

export async function saveConversationRenderDetailToStores(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  assertUniqueClientStateIds(state, `saveConversationRenderDetail:${conversationId}:source`);
  const detail = conversationRenderDetailSlice(state, conversationId);
  assertUniqueClientStateIds(detail, `saveConversationRenderDetail:${conversationId}:detail`);
  const compression = createEmptyClientState();
  copyCompressionTables(compression, detail);
  const incrementalSaved = await saveConversationTimelineRenderDetailIncremental(paths, conversationId, detail);
  const timelineSave = incrementalSaved
    ? Promise.resolve()
    : saveMergedConversationTimelineDetail(paths, conversationId, detail);
  const existingCompression = await loadConversationCompressionDetail(paths, conversationId);
  if (existingCompression) preserveKnownCompressionSourceLinks(compression, existingCompression);
  await Promise.all([
    timelineSave,
    saveConversationCompressionDetail(paths, conversationId, compression)
  ]);
}

async function saveMergedConversationTimelineDetail(paths: StoragePaths, conversationId: string, detail: ClientState): Promise<void> {
  await mergeConversationTimelineDetailIntoStore(paths, conversationId, detail);
}

export async function saveConversationRunHistoryToStores(
  paths: StoragePaths,
  conversationId: string,
  state: ClientState,
  options: SaveConversationRunHistoryOptions
): Promise<void> {
  const settings = (await loadGlobalSettingsFile(paths.settingsRootUri, 'runHistory')).settings as RunHistorySettingsRecord;
  if (!settings.detailPersistenceEnabled) return;

  assertUniqueClientStateIds(state, `saveConversationRunHistory:${conversationId}:source`);
  const detail = conversationRunHistorySlice(state, conversationId);
  assertUniqueClientStateIds(detail, `saveConversationRunHistory:${conversationId}:detail`);
  if (options.mode === 'merge' && !hasRunHistoryRecords(detail)) return;

  const runDetails = detail.agentRuns.map((run) => conversationRunDetailRecord(state, conversationId, run.id)).filter(isDefined);
  await Promise.all(runDetails.map((record) => writeRunDetail(paths, record)));

  const summaries = uniqueRunSummaries(runDetails.map((record) => record.summary).filter(isDefined))
    .sort(compareRunSummaries);
  await writeRunHistoryIndexAndPages(paths, conversationId, summaries, options);
}

export async function saveMessageRecord(paths: StoragePaths, conversationId: string, message: MessageRecord): Promise<void> {
  await mutateConversationTimelineDetailInStore(paths, conversationId, (detail) => {
    detail.messages = upsertById(detail.messages, { ...message, conversationId });
  });
}

export async function removeMessageRecord(paths: StoragePaths, conversationId: string, messageId: string): Promise<void> {
  await mutateConversationTimelineDetailInStore(paths, conversationId, (detail) => {
    const toolCallIds = new Set(detail.toolCalls.filter((toolCall) => toolCall.messageId === messageId).map((toolCall) => toolCall.id));
    detail.messages = detail.messages.filter((message) => message.id !== messageId);
    detail.messageRevisions = detail.messageRevisions.filter((revision) => revision.messageId !== messageId);
    detail.messageCurrentRevisionLinks = detail.messageCurrentRevisionLinks.filter((link) => link.messageId !== messageId);
    detail.toolCalls = detail.toolCalls.filter((toolCall) => toolCall.messageId !== messageId);
    detail.toolCallEvents = detail.toolCallEvents.filter((event) => !toolCallIds.has(event.toolCallId));
  });
}

export async function saveToolCallRecord(paths: StoragePaths, conversationId: string, toolCall: ToolCallRecord): Promise<void> {
  await mutateConversationTimelineDetailInStore(paths, conversationId, (detail) => {
    detail.toolCalls = upsertById(detail.toolCalls, toolCall);
  });
}

export async function appendToolCallEventRecord(paths: StoragePaths, conversationId: string, event: ToolCallEventRecord): Promise<void> {
  await mutateConversationTimelineDetailInStore(paths, conversationId, (detail) => {
    detail.toolCallEvents = upsertById(detail.toolCallEvents, event);
  });
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
  detail.checkpointTimelineAnchors = state.checkpointTimelineAnchors.filter((anchor) => anchor.conversationId === conversationId);
  const checkpointIds = new Set(detail.checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  detail.checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.status !== 'pending' && (checkpoint.conversationId === conversationId || checkpointIds.has(checkpoint.id)));
  const persistedCheckpointIds = new Set(detail.checkpoints.map((checkpoint) => checkpoint.id));
  detail.checkpointTimelineAnchors = detail.checkpointTimelineAnchors.filter((anchor) => persistedCheckpointIds.has(anchor.checkpointId));
  for (const checkpoint of detail.checkpoints) checkpointIds.add(checkpoint.id);
  const shadowRepositoryIds = new Set(detail.checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  const projectContextIds = new Set(detail.checkpoints.map((checkpoint) => checkpoint.projectContextId));
  detail.conversationCheckpointRepositoryLinks = state.conversationCheckpointRepositoryLinks.filter((link) => {
    const matches = link.conversationId === conversationId || shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
    if (matches) {
      shadowRepositoryIds.add(link.shadowRepositoryId);
      projectContextIds.add(link.projectContextId);
    }
    return matches;
  });
  detail.shadowRepositories = state.shadowRepositories.filter((repository) => shadowRepositoryIds.has(repository.id));
  detail.projectContexts = state.projectContexts.filter((projectContext) => projectContextIds.has(projectContext.id));
  detail.compressionBlocks = state.compressionBlocks.filter((block) => block.conversationId === conversationId);
  const compressionBlockIds = new Set(detail.compressionBlocks.map((block) => block.id));
  detail.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId));
  detail.compressionContextVariants = state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId));
  detail.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId));
  const invocationIds = new Set(detail.compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));
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
  detail.runWorkflowLinks = state.runWorkflowLinks.filter((link) => runIds.has(link.runId));
  detail.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => runIds.has(link.runId));
  detail.runModelProfileLinks = state.runModelProfileLinks.filter((link) => runIds.has(link.runId));
  detail.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => runIds.has(link.runId));
  detail.runLlmInvocationLinks = state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId));
  const invocationIds = new Set(detail.runLlmInvocationLinks.map((link) => link.invocationId));
  detail.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => invocationIds.has(link.invocationId));
  detail.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => {
    const matches = messageIds.has(link.messageId) || invocationIds.has(link.invocationId);
    if (matches) invocationIds.add(link.invocationId);
    return matches;
  });
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));
  detail.runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => runIds.has(link.runId));
  detail.agentRunInputRevisions = state.agentRunInputRevisions.filter((input) => runIds.has(input.runId) || input.conversationId === conversationId || revisionIds.has(input.revisionId));
  detail.runCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) => runIds.has(link.runId));
  detail.runPlanProposalLinks = state.runPlanProposalLinks.filter((link) => runIds.has(link.runId));
  const planProposalIds = new Set(detail.runPlanProposalLinks.map((link) => link.planProposalId));
  detail.planProposals = state.planProposals.filter((proposal) => planProposalIds.has(proposal.id));
  return detail;
}

export function conversationDetailSlice(state: ClientState, conversationId: string): ClientState {
  const detail = conversationRenderDetailSlice(state, conversationId);
  copyRunHistoryTables(detail, conversationRunHistorySlice(state, conversationId));
  return detail;
}

function mergeRenderDetailTables(target: ClientState, source: ClientState): void {
  const keys = [
    'messages',
    'messageRevisions',
    'messageCurrentRevisionLinks',
    'toolCalls',
    'toolCallEvents',
    'projectContexts',
    'shadowRepositories',
    'conversationCheckpointRepositoryLinks',
    'checkpoints',
    'checkpointTimelineAnchors'
  ] as const;
  mergeClientStateTables(target, source, keys);
}

function mergeCompressionTables(target: ClientState, source: ClientState): void {
  const keys = [
    'compressionBlocks',
    'compressionBlockSourceLinks',
    'compressionContextVariants',
    'compressionBlockLlmInvocationLinks',
    'llmInvocations'
  ] as const;
  mergeClientStateTables(target, source, keys);
}

function preserveKnownCompressionSourceLinks(target: ClientState, existing: ClientState): void {
  const blockIds = new Set(target.compressionBlocks.map((block) => block.id));
  const sourceLinks = existing.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  target.compressionBlockSourceLinks = upsertManyById(sourceLinks, target.compressionBlockSourceLinks);
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
  target.runWorkflowLinks = source.runWorkflowLinks;
  target.runSystemPromptLinks = source.runSystemPromptLinks;
  target.runModelProfileLinks = source.runModelProfileLinks;
  target.runToolPolicyLinks = source.runToolPolicyLinks;
  target.runConversationPolicyLinks = source.runConversationPolicyLinks;
  target.runContextPolicyLinks = source.runContextPolicyLinks;
  target.runDeliveryPolicyLinks = source.runDeliveryPolicyLinks;
  target.runEditPolicyLinks = source.runEditPolicyLinks;
  target.llmInvocations = source.llmInvocations;
  target.runLlmInvocationLinks = source.runLlmInvocationLinks;
  target.messageLlmInvocationLinks = source.messageLlmInvocationLinks;
  target.compressionBlockLlmInvocationLinks = mergeUniqueById(target.compressionBlockLlmInvocationLinks, source.compressionBlockLlmInvocationLinks);
  target.runWorkEnvironmentLinks = source.runWorkEnvironmentLinks;
  target.agentRunInputRevisions = source.agentRunInputRevisions;
  target.runCompressionBlockLinks = source.runCompressionBlockLinks;
  target.planProposals = source.planProposals;
  target.runPlanProposalLinks = source.runPlanProposalLinks;
}

function copyCompressionTables(target: ClientState, source: ClientState): void {
  target.compressionBlocks = source.compressionBlocks;
  target.compressionBlockSourceLinks = source.compressionBlockSourceLinks;
  target.compressionContextVariants = source.compressionContextVariants;
  target.compressionBlockLlmInvocationLinks = source.compressionBlockLlmInvocationLinks;
  target.llmInvocations = mergeUniqueById(target.llmInvocations, source.llmInvocations);
}

function pruneCompressionTablesToTimelinePage(state: ClientState, startSeq: number | undefined, endSeq: number | undefined): void {
  const beforeBlockCount = state.compressionBlocks.length;
  if (startSeq === undefined || endSeq === undefined) {
    state.compressionBlocks = [];
    state.compressionBlockSourceLinks = [];
    state.compressionContextVariants = [];
    state.compressionBlockLlmInvocationLinks = [];
    return;
  }

  const latestCompleteBeforeStart = state.compressionBlocks
    .filter((block) => block.status === 'complete')
    .filter((block) => {
      const seq = block.anchorSeq ?? block.endSeq;
      return seq !== undefined && seq < startSeq;
    })
    .sort((left, right) => (right.anchorSeq ?? right.endSeq ?? 0) - (left.anchorSeq ?? left.endSeq ?? 0) || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
  const keptBlockIds = new Set<string>();
  state.compressionBlocks = state.compressionBlocks.filter((block) => {
    const seq = block.anchorSeq ?? block.endSeq;
    const keep = seq !== undefined && seq >= startSeq && seq <= endSeq;
    if (keep) keptBlockIds.add(block.id);
    return keep;
  });
  if (latestCompleteBeforeStart && !keptBlockIds.has(latestCompleteBeforeStart.id)) {
    state.compressionBlocks.push(latestCompleteBeforeStart);
    keptBlockIds.add(latestCompleteBeforeStart.id);
  }
  const blockIds = new Set(state.compressionBlocks.map((block) => block.id));
  state.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  state.compressionContextVariants = state.compressionContextVariants.filter((variant) => blockIds.has(variant.blockId));
  state.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => blockIds.has(link.blockId));
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
  detail.runWorkflowLinks = state.runWorkflowLinks.filter((link) => link.runId === runId);
  detail.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => link.runId === runId);
  detail.runModelProfileLinks = state.runModelProfileLinks.filter((link) => link.runId === runId);
  detail.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => link.runId === runId);
  detail.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => link.runId === runId);
  detail.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => link.runId === runId);
  detail.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => link.runId === runId);
  detail.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => link.runId === runId);
  detail.runLlmInvocationLinks = state.runLlmInvocationLinks.filter((link) => link.runId === runId);
  detail.runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => link.runId === runId);
  detail.agentRunInputRevisions = state.agentRunInputRevisions.filter((input) => input.runId === runId);
  detail.runCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) => link.runId === runId);
  detail.runPlanProposalLinks = state.runPlanProposalLinks.filter((link) => link.runId === runId);
  const planProposalIds = new Set(detail.runPlanProposalLinks.map((link) => link.planProposalId));
  detail.planProposals = state.planProposals.filter((proposal) => planProposalIds.has(proposal.id));

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

  const invocationIds = new Set(detail.runLlmInvocationLinks.map((link) => link.invocationId));
  detail.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => {
    const matches = messageIds.has(link.messageId) || invocationIds.has(link.invocationId);
    if (matches) invocationIds.add(link.invocationId);
    return matches;
  });
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));

  const compressionBlockIds = new Set(detail.runCompressionBlockLinks.map((link) => link.blockId));
  const compressionVariantIds = new Set(detail.runCompressionBlockLinks.map((link) => link.variantId).filter((id): id is string => !!id));
  detail.compressionBlocks = state.compressionBlocks.filter((block) => compressionBlockIds.has(block.id));
  detail.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId));
  detail.compressionContextVariants = state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId) || compressionVariantIds.has(variant.id));
  detail.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId) || invocationIds.has(link.invocationId));
  for (const link of detail.compressionBlockLlmInvocationLinks) invocationIds.add(link.invocationId);
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));

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
  const root = runHistoryRoot(paths, conversationId);
  try {
    return (await loadRunHistoryIndexStrict(root, conversationId, { allowMissing: true }))?.index;
  } catch (error) {
    console.warn(`[LimCode] Failed to load run history index for ${conversationId}:`, error);
    return undefined;
  }
}

async function loadRunHistoryIndexStrict(root: vscode.Uri, conversationId: string, options: { allowMissing: boolean; validatePages?: boolean }): Promise<ConversationRunHistoryIndexSnapshot | undefined> {
  const indexUri = vscode.Uri.joinPath(root, INDEX_FILE);
  const result = await readJsonStrict<unknown>(indexUri);
  if (result.status === 'missing') {
    const traces = await findExistingRunHistoryTraces(root);
    if (traces.length > 0) throw new Error(`Run history index is missing but storage contains page traces: ${traces.join(', ')}`);
    if (options.allowMissing) return undefined;
    throw new Error(`Run history index is missing: ${indexUri.fsPath}`);
  }
  if (result.status === 'invalid') throw new Error(`Run history index JSON is invalid: ${indexUri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read run history index: ${indexUri.fsPath}`);
  const snapshot = parseRunHistoryIndex(result.value, indexUri, conversationId);
  if (options.validatePages) await validateRunHistoryPagesForWrite(root, conversationId, snapshot.index);
  return snapshot;
}

async function readRunHistoryPage(paths: StoragePaths, conversationId: string, pageRecord: ConversationRunHistoryPageIndexRecord): Promise<ConversationRunHistoryPageFile | undefined> {
  const root = runHistoryRoot(paths, conversationId);
  try {
    return await readRunHistoryPageStrict(root, conversationId, pageRecord);
  } catch (error) {
    console.warn(`[LimCode] Failed to load run history page for ${conversationId}: ${pageRecord.file}`, error);
    return undefined;
  }
}

async function readRunHistoryPageStrict(root: vscode.Uri, conversationId: string, pageRecord: ConversationRunHistoryPageIndexRecord): Promise<ConversationRunHistoryPageFile> {
  const uri = vscode.Uri.joinPath(root, ...pageRecord.file.split('/'));
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') throw new Error(`Indexed run history page is missing: ${uri.fsPath}`);
  if (result.status === 'invalid') throw new Error(`Indexed run history page JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read indexed run history page: ${uri.fsPath}`);
  return parseRunHistoryPage(result.value, uri, conversationId, pageRecord);
}

async function validateRunHistoryPagesForWrite(root: vscode.Uri, conversationId: string, index: ConversationRunHistoryIndexFile): Promise<void> {
  const pages = await Promise.all(index.pages.map((pageRecord) => readRunHistoryPageStrict(root, conversationId, pageRecord)));
  const runs = pages.flatMap((page) => page.runs);
  if (runs.length !== index.runs.length) throw new Error(`Run history pages do not match index total: ${conversationId}`);
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    if (runs[runIndex].id !== index.runs[runIndex].id || runs[runIndex].conversationId !== index.runs[runIndex].conversationId) {
      throw new Error(`Run history page summary order does not match index: ${conversationId}`);
    }
  }
}

async function loadRunDetail(paths: StoragePaths, conversationId: string, runId: string): Promise<ConversationRunDetailRecord | undefined> {
  try {
    const file = await readRunDetailFileStrict(runDetailUri(paths, runId), runId, { allowMissing: true });
    if (!file) return undefined;
    const summary = file.summaries.find((candidate) => candidate.conversationId === conversationId);
    if (!summary) return undefined;
    return { conversationId, runId: file.runId, summary, state: file.state };
  } catch (error) {
    console.warn(`[LimCode] Failed to load run detail for ${runId}:`, error);
    return undefined;
  }
}

async function writeRunDetail(paths: StoragePaths, record: ConversationRunDetailRecord): Promise<void> {
  assertUniqueClientStateIds(record.state, `writeRunDetail:${record.runId}:record`);
  const uri = runDetailUri(paths, record.runId);
  await withStorageResourceLock(uri, async () => {
    const existing = await readRunDetailFileStrict(uri, record.runId, { allowMissing: true });
    const state = createEmptyClientState();
    if (existing) mergeClientStateTables(state, existing.state, RUN_DETAIL_TABLE_KEYS);
    mergeClientStateTables(state, record.state, RUN_DETAIL_TABLE_KEYS);

    const summaries = uniqueRunSummaries([
      ...(existing ? existing.summaries : []),
      record.summary
    ].filter(isDefined)).sort(compareRunSummaries);

    await writeJson(uri, {
      kind: 'runHistory.detail',
      schemaVersion: STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      runId: record.runId,
      summaries,
      state
    } satisfies RunHistoryDetailFile);
  });
}

async function writeRunHistoryIndexAndPages(
  paths: StoragePaths,
  conversationId: string,
  incomingSummaries: ConversationRunSummaryRecord[],
  options: SaveConversationRunHistoryOptions
): Promise<void> {
  const root = runHistoryRoot(paths, conversationId);
  await withStorageResourceLock(root, async () => {
    const previous = await loadRunHistoryIndexStrict(root, conversationId, { allowMissing: true, validatePages: true });
    const previousRuns = options.mode === 'merge' ? previous?.index.runs ?? [] : [];
    const summaries = uniqueRunSummaries([...previousRuns, ...incomingSummaries]).sort(compareRunSummaries);
    await publishRunHistoryIndexAndPages(root, conversationId, summaries, previous?.index);
  });
}

async function publishRunHistoryIndexAndPages(
  root: vscode.Uri,
  conversationId: string,
  summaries: ConversationRunSummaryRecord[],
  previousIndex: ConversationRunHistoryIndexFile | undefined
): Promise<void> {
  const savedAt = new Date().toISOString();
  const generation = createStorageGenerationLocation(root);
  const pagesRoot = vscode.Uri.joinPath(generation.rootUri, RUN_HISTORY_PAGES_DIR);
  await vscode.workspace.fs.createDirectory(pagesRoot);

  const pageSize = RUN_HISTORY_PAGE_SIZE;
  const pages: ConversationRunHistoryPageIndexRecord[] = [];
  const pageCount = Math.ceil(summaries.length / pageSize);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const runs = summaries.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const file = runHistoryPageFile(generation.id, pageIndex);
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      kind: 'conversationRunHistory.page',
      schemaVersion: STORAGE_VERSION,
      savedAt,
      generation: generation.id,
      conversationId,
      runs
    } satisfies ConversationRunHistoryPageFile);
    pages.push({
      generation: generation.id,
      file,
      count: runs.length,
      ...(runs[0]?.updatedAt !== undefined ? { newestUpdatedAt: runs[0].updatedAt } : {}),
      ...(runs[runs.length - 1]?.updatedAt !== undefined ? { oldestUpdatedAt: runs[runs.length - 1].updatedAt } : {})
    });
  }

  const nextIndex: ConversationRunHistoryIndexFile = {
    kind: 'conversationRunHistory.index',
    schemaVersion: STORAGE_VERSION,
    savedAt,
    generation: generation.id,
    conversationId,
    pageSize,
    total: summaries.length,
    runs: summaries,
    pages
  };
  await __runHistoryStoreTestHooks.beforePublishConversationIndex?.({ rootUri: root, conversationId, generation: generation.id });
  await writeJson(vscode.Uri.joinPath(root, INDEX_FILE), nextIndex);
  await cleanupOldRunHistoryGenerationsAfterPublish(root, nextIndex, previousIndex);
}

async function readRunDetailFileStrict(uri: vscode.Uri, runId: string, options: { allowMissing: boolean }): Promise<RunHistoryDetailFile | undefined> {
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') {
    if (options.allowMissing) return undefined;
    throw new Error(`Run detail file is missing: ${uri.fsPath}`);
  }
  if (result.status === 'invalid') throw new Error(`Run detail JSON is invalid: ${uri.fsPath}`);
  if (result.status === 'ioError') throw new Error(`Failed to read run detail: ${uri.fsPath}`);
  return parseRunDetailFile(result.value, uri, runId);
}

function parseRunHistoryIndex(value: unknown, uri: vscode.Uri, conversationId: string): ConversationRunHistoryIndexSnapshot {
  const index = value as Partial<ConversationRunHistoryIndexFile> | undefined;
  if (!isPlainObject(index)) throw new Error(`Run history index must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(index, ['kind', 'schemaVersion', 'savedAt', 'generation', 'conversationId', 'pageSize', 'total', 'runs', 'pages'])) {
    throw new Error(`Run history index has unknown fields: ${uri.fsPath}`);
  }
  if (index.kind !== 'conversationRunHistory.index') throw new Error(`Run history index kind is invalid: ${uri.fsPath}`);
  if (index.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported run history index schema: ${uri.fsPath}`);
  if (typeof index.savedAt !== 'string' || !index.savedAt.trim()) throw new Error(`Run history index savedAt is invalid: ${uri.fsPath}`);
  if (typeof index.generation !== 'string' || !isSafeStorageGenerationId(index.generation)) throw new Error(`Run history index generation is invalid: ${uri.fsPath}`);
  if (index.conversationId !== conversationId) throw new Error(`Run history index conversation mismatch: ${uri.fsPath}`);
  if (!isSafePositiveInteger(index.pageSize)) throw new Error(`Run history index pageSize is invalid: ${uri.fsPath}`);
  if (!isSafeNonNegativeInteger(index.total)) throw new Error(`Run history index total is invalid: ${uri.fsPath}`);
  if (!Array.isArray(index.runs) || !Array.isArray(index.pages)) throw new Error(`Run history index arrays are invalid: ${uri.fsPath}`);

  const runs = index.runs.map((run) => parseRunSummary(run, uri, conversationId));
  assertUniqueRecords(runs, `runHistoryIndex:${conversationId}`);
  if (runs.length !== index.total) throw new Error(`Run history index total does not match runs: ${uri.fsPath}`);

  const pages: ConversationRunHistoryPageIndexRecord[] = [];
  let totalFromPages = 0;
  for (let pageIndex = 0; pageIndex < index.pages.length; pageIndex += 1) {
    const page = index.pages[pageIndex] as Partial<ConversationRunHistoryPageIndexRecord> | undefined;
    if (!isPlainObject(page) || !hasOnlyKeys(page, ['generation', 'file', 'count', 'newestUpdatedAt', 'oldestUpdatedAt'])) {
      throw new Error(`Run history page index is invalid: ${uri.fsPath}`);
    }
    if (page.generation !== index.generation || !isSafeStorageGenerationId(page.generation)) throw new Error(`Run history page index generation mismatch: ${uri.fsPath}`);
    if (page.file !== runHistoryPageFile(index.generation, pageIndex)) throw new Error(`Run history page index file is invalid: ${uri.fsPath}`);
    if (!isSafeNonNegativeInteger(page.count)) throw new Error(`Run history page index count is invalid: ${uri.fsPath}`);
    if (!isOptionalFiniteNumber(page.newestUpdatedAt) || !isOptionalFiniteNumber(page.oldestUpdatedAt)) throw new Error(`Run history page index time range is invalid: ${uri.fsPath}`);
    totalFromPages += page.count;
    pages.push({
      generation: page.generation,
      file: page.file,
      count: page.count,
      ...(page.newestUpdatedAt !== undefined ? { newestUpdatedAt: page.newestUpdatedAt } : {}),
      ...(page.oldestUpdatedAt !== undefined ? { oldestUpdatedAt: page.oldestUpdatedAt } : {})
    });
  }
  if (totalFromPages !== runs.length) throw new Error(`Run history index total does not match page counts: ${uri.fsPath}`);

  return {
    uri,
    index: {
      kind: 'conversationRunHistory.index',
      schemaVersion: STORAGE_VERSION,
      savedAt: index.savedAt,
      generation: index.generation,
      conversationId,
      pageSize: index.pageSize,
      total: index.total,
      runs,
      pages
    }
  };
}

function parseRunHistoryPage(value: unknown, uri: vscode.Uri, conversationId: string, pageRecord: ConversationRunHistoryPageIndexRecord): ConversationRunHistoryPageFile {
  const page = value as Partial<ConversationRunHistoryPageFile> | undefined;
  if (!isPlainObject(page)) throw new Error(`Run history page must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(page, ['kind', 'schemaVersion', 'savedAt', 'generation', 'conversationId', 'runs'])) throw new Error(`Run history page has unknown fields: ${uri.fsPath}`);
  if (page.kind !== 'conversationRunHistory.page') throw new Error(`Run history page kind is invalid: ${uri.fsPath}`);
  if (page.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported run history page schema: ${uri.fsPath}`);
  if (typeof page.savedAt !== 'string' || !page.savedAt.trim()) throw new Error(`Run history page savedAt is invalid: ${uri.fsPath}`);
  if (page.generation !== pageRecord.generation) throw new Error(`Run history page generation mismatch: ${uri.fsPath}`);
  if (page.conversationId !== conversationId) throw new Error(`Run history page conversation mismatch: ${uri.fsPath}`);
  if (!Array.isArray(page.runs)) throw new Error(`Run history page runs are invalid: ${uri.fsPath}`);
  if (page.runs.length !== pageRecord.count) throw new Error(`Run history page count mismatch: ${uri.fsPath}`);
  const runs = page.runs.map((run) => parseRunSummary(run, uri, conversationId));
  assertUniqueRecords(runs, `runHistoryPage:${conversationId}:${pageRecord.file}`);
  return {
    kind: 'conversationRunHistory.page',
    schemaVersion: STORAGE_VERSION,
    savedAt: page.savedAt,
    generation: pageRecord.generation,
    conversationId,
    runs
  };
}

function parseRunDetailFile(value: unknown, uri: vscode.Uri, runId: string): RunHistoryDetailFile {
  const file = value as Partial<RunHistoryDetailFile> | undefined;
  if (!isPlainObject(file)) throw new Error(`Run detail file must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(file, ['kind', 'schemaVersion', 'savedAt', 'runId', 'summaries', 'state'])) throw new Error(`Run detail has unknown fields: ${uri.fsPath}`);
  if (file.kind !== 'runHistory.detail') throw new Error(`Run detail kind is invalid: ${uri.fsPath}`);
  if (file.schemaVersion !== STORAGE_VERSION) throw new Error(`Unsupported run detail schema: ${uri.fsPath}`);
  if (typeof file.savedAt !== 'string' || !file.savedAt.trim()) throw new Error(`Run detail savedAt is invalid: ${uri.fsPath}`);
  if (file.runId !== runId) throw new Error(`Run detail runId mismatch: ${uri.fsPath}`);
  if (!Array.isArray(file.summaries)) throw new Error(`Run detail summaries are invalid: ${uri.fsPath}`);
  if (!isPlainObject(file.state)) throw new Error(`Run detail state is invalid: ${uri.fsPath}`);
  const summaries = file.summaries.map((summary) => parseRunSummary(summary, uri));
  if (!summaries.every((summary) => summary.id === runId)) throw new Error(`Run detail summary runId mismatch: ${uri.fsPath}`);
  assertUniqueRunSummaries(summaries, `runDetailSummaries:${runId}`);
  const state = { ...(file.state as ClientState), agentRuns: ((file.state as ClientState).agentRuns ?? []).map(normalizeRestoredRunLikeRecord) };
  assertUniqueClientStateIds(state, `runDetailState:${runId}`);
  return {
    kind: 'runHistory.detail',
    schemaVersion: STORAGE_VERSION,
    savedAt: file.savedAt,
    runId,
    summaries,
    state
  };
}

function parseRunSummary(value: unknown, uri: vscode.Uri, conversationId?: string): ConversationRunSummaryRecord {
  const summary = value as Partial<ConversationRunSummaryRecord> | undefined;
  if (!isPlainObject(summary)) throw new Error(`Run summary must be an object: ${uri.fsPath}`);
  if (!hasOnlyKeys(summary, [
    'id',
    'conversationId',
    'kind',
    'status',
    'createdAt',
    'updatedAt',
    'completedAt',
    'endReason',
    'errorType',
    'error',
    'retryOfRunId',
    'attempt',
    'sourceKind',
    'sourceMessageId',
    'sourceToolCallId',
    'sourceRunId',
    'targetAgentId',
    'targetConversationId',
    'inputMessageCount',
    'outputMessageCount',
    'inputMessageIds',
    'outputMessageIds',
    'toolCallIds',
    'toolCallCount',
    'inputPreview',
    'outputPreview'
  ])) {
    throw new Error(`Run summary has unknown fields: ${uri.fsPath}`);
  }
  if (typeof summary.id !== 'string' || !summary.id.trim()) throw new Error(`Run summary id is invalid: ${uri.fsPath}`);
  if (typeof summary.conversationId !== 'string' || !summary.conversationId.trim()) throw new Error(`Run summary conversationId is invalid: ${uri.fsPath}`);
  if (conversationId !== undefined && summary.conversationId !== conversationId) throw new Error(`Run summary conversation mismatch: ${uri.fsPath}`);
  if (typeof summary.kind !== 'string' || !summary.kind.trim()) throw new Error(`Run summary kind is invalid: ${uri.fsPath}`);
  if (typeof summary.status !== 'string' || !summary.status.trim()) throw new Error(`Run summary status is invalid: ${uri.fsPath}`);
  if (!isFiniteNumber(summary.createdAt) || !isFiniteNumber(summary.updatedAt)) throw new Error(`Run summary timestamps are invalid: ${uri.fsPath}`);
  if (!isOptionalFiniteNumber(summary.completedAt) || !isOptionalSafeNonNegativeInteger(summary.attempt)) throw new Error(`Run summary optional numbers are invalid: ${uri.fsPath}`);
  if (!isSafeNonNegativeInteger(summary.inputMessageCount) || !isSafeNonNegativeInteger(summary.outputMessageCount) || !isSafeNonNegativeInteger(summary.toolCallCount)) {
    throw new Error(`Run summary counts are invalid: ${uri.fsPath}`);
  }
  if (!isOptionalString(summary.endReason) || !isOptionalString(summary.errorType) || !isOptionalString(summary.error) || !isOptionalString(summary.retryOfRunId)
    || !isOptionalString(summary.sourceKind) || !isOptionalString(summary.sourceMessageId) || !isOptionalString(summary.sourceToolCallId) || !isOptionalString(summary.sourceRunId)
    || !isOptionalString(summary.targetAgentId) || !isOptionalString(summary.targetConversationId) || !isOptionalString(summary.inputPreview) || !isOptionalString(summary.outputPreview)) {
    throw new Error(`Run summary optional strings are invalid: ${uri.fsPath}`);
  }
  if (!isOptionalStringArray(summary.inputMessageIds) || !isOptionalStringArray(summary.outputMessageIds) || !isOptionalStringArray(summary.toolCallIds)) {
    throw new Error(`Run summary id arrays are invalid: ${uri.fsPath}`);
  }
  return normalizeRestoredRunLikeRecord({
    id: summary.id,
    conversationId: summary.conversationId,
    kind: summary.kind as ConversationRunSummaryRecord['kind'],
    status: summary.status as ConversationRunSummaryRecord['status'],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.completedAt !== undefined ? { completedAt: summary.completedAt } : {}),
    ...(summary.endReason !== undefined ? { endReason: summary.endReason as ConversationRunSummaryRecord['endReason'] } : {}),
    ...(summary.errorType !== undefined ? { errorType: summary.errorType as ConversationRunSummaryRecord['errorType'] } : {}),
    ...(summary.error !== undefined ? { error: summary.error } : {}),
    ...(summary.retryOfRunId !== undefined ? { retryOfRunId: summary.retryOfRunId } : {}),
    ...(summary.attempt !== undefined ? { attempt: summary.attempt } : {}),
    ...(summary.sourceKind !== undefined ? { sourceKind: summary.sourceKind as ConversationRunSummaryRecord['sourceKind'] } : {}),
    ...(summary.sourceMessageId !== undefined ? { sourceMessageId: summary.sourceMessageId } : {}),
    ...(summary.sourceToolCallId !== undefined ? { sourceToolCallId: summary.sourceToolCallId } : {}),
    ...(summary.sourceRunId !== undefined ? { sourceRunId: summary.sourceRunId } : {}),
    ...(summary.targetAgentId !== undefined ? { targetAgentId: summary.targetAgentId } : {}),
    ...(summary.targetConversationId !== undefined ? { targetConversationId: summary.targetConversationId } : {}),
    inputMessageCount: summary.inputMessageCount,
    outputMessageCount: summary.outputMessageCount,
    ...(summary.inputMessageIds !== undefined ? { inputMessageIds: [...summary.inputMessageIds] } : {}),
    ...(summary.outputMessageIds !== undefined ? { outputMessageIds: [...summary.outputMessageIds] } : {}),
    ...(summary.toolCallIds !== undefined ? { toolCallIds: [...summary.toolCallIds] } : {}),
    toolCallCount: summary.toolCallCount,
    ...(summary.inputPreview !== undefined ? { inputPreview: summary.inputPreview } : {}),
    ...(summary.outputPreview !== undefined ? { outputPreview: summary.outputPreview } : {})
  });
}

async function cleanupOldRunHistoryGenerationsAfterPublish(
  root: vscode.Uri,
  currentIndex: ConversationRunHistoryIndexFile,
  previousIndex: ConversationRunHistoryIndexFile | undefined
): Promise<void> {
  try {
    const retained = new Set<string>([
      ...runHistoryGenerationsReferencedByIndex(currentIndex),
      ...(previousIndex ? runHistoryGenerationsReferencedByIndex(previousIndex) : [])
    ]);
    const result = await cleanupInactiveStorageGenerations(root, retained);
    for (const failure of result.failed) {
      console.warn(`[LimCode] Failed to prune run history generation: ${failure.generation.id}`, failure.error);
    }
  } catch (error) {
    console.warn('[LimCode] Failed to prune inactive run history generations:', error);
  }
}

function runHistoryGenerationsReferencedByIndex(index: ConversationRunHistoryIndexFile): string[] {
  const generations = new Set<string>();
  if (isSafeStorageGenerationId(index.generation)) generations.add(index.generation);
  for (const page of index.pages) if (isSafeStorageGenerationId(page.generation)) generations.add(page.generation);
  return [...generations];
}

async function findExistingRunHistoryTraces(root: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    return entries.map(([name]) => name).filter((name) => name !== INDEX_FILE).sort();
  } catch (error) {
    if (isStorageFileNotFoundError(error)) return [];
    throw error;
  }
}

function runHistoryPageFile(generation: string, pageIndex: number): string {
  return `${STORAGE_GENERATIONS_DIR}/${generation}/${RUN_HISTORY_PAGES_DIR}/${pageIndex.toString().padStart(6, '0')}.json`;
}

function assertUniqueRunSummaries(items: ConversationRunSummaryRecord[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.conversationId}:${item.id}`;
    if (seen.has(key)) throw new Error(`Duplicate ${label} id: ${key}`);
    seen.add(key);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalSafeNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isSafeNonNegativeInteger(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0));
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
  assertUniqueRecords(left, 'upsertManyById.left');
  assertUniqueRecords(right, 'upsertManyById.right');
  const byId = new Map<string, T>();
  for (const item of left) byId.set(item.id, item);
  for (const item of right) byId.set(item.id, item);
  return [...byId.values()];
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

async function removeStoreRecord(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  id: string,
  recordKey: StoreKey,
  deletedPaths: string[],
  errors: string[]
): Promise<void> {
  try {
    await removeRecordStoreRecord(root, indexUri, id, recordKey);
    deletedPaths.push(indexUri.fsPath);
  } catch (error) {
    errors.push(`remove ${recordKey}:${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pruneStoreRecords<TRecord extends StoreRecord>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: StoreKey,
  shouldDelete: (record: TRecord) => boolean,
  deletedPaths: string[],
  errors: string[]
): Promise<void> {
  try {
    const records = await loadRecords<TRecord>(root, indexUri, recordKey);
    const next = records.filter((record) => !shouldDelete(record));
    if (next.length === records.length) return;
    await saveRecordStore<TRecord, string>(root, indexUri, next, recordKey, (record) => record.id, { pruneMissing: true });
    deletedPaths.push(indexUri.fsPath);
  } catch (error) {
    errors.push(`prune ${recordKey}:${indexUri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pruneRunDetailForConversation(
  paths: StoragePaths,
  runId: string,
  conversationId: string,
  deletedPaths: string[],
  errors: string[]
): Promise<void> {
  const uri = runDetailUri(paths, runId);
  try {
    await withStorageResourceLock(uri, async () => {
      const existing = await readRunDetailFileStrict(uri, runId, { allowMissing: true });
      if (!existing) return;
      const summaries = existing.summaries.filter((summary) => summary.conversationId !== conversationId);
      if (summaries.length === existing.summaries.length) return;
      if (summaries.length === 0) {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        deletedPaths.push(uri.fsPath);
        return;
      }
      await writeJson(uri, {
        kind: 'runHistory.detail',
        schemaVersion: STORAGE_VERSION,
        savedAt: new Date().toISOString(),
        runId,
        summaries,
        state: scrubSharedRunDetailStateForConversation(existing.state, conversationId, summaries)
      } satisfies RunHistoryDetailFile);
      deletedPaths.push(uri.fsPath);
    });
  } catch (error) {
    if (isStorageFileNotFoundError(error)) return;
    errors.push(`prune run detail:${runId}:${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scrubSharedRunDetailStateForConversation(
  state: ClientState,
  conversationId: string,
  remainingSummaries: readonly ConversationRunSummaryRecord[]
): ClientState {
  const remainingSummaryMessageIds = new Set(remainingSummaries.flatMap((summary) => [
    ...(summary.inputMessageIds ?? []),
    ...(summary.outputMessageIds ?? []),
    ...(summary.sourceMessageId ? [summary.sourceMessageId] : [])
  ]));
  const removedMessageIds = new Set(state.messages.filter((message) => message.conversationId === conversationId).map((message) => message.id));
  const removedRevisionIds = new Set(state.messageRevisions
    .filter((revision) => revision.conversationId === conversationId || removedMessageIds.has(revision.messageId))
    .map((revision) => revision.id));
  const removedToolCallIds = new Set(state.toolCalls
    .filter((toolCall) => removedMessageIds.has(toolCall.messageId))
    .map((toolCall) => toolCall.id));
  const removedCompressionBlockIds = new Set(state.compressionBlocks
    .filter((block) => block.conversationId === conversationId)
    .map((block) => block.id));

  const nextAgentRunSourceLinks = state.agentRunSourceLinks.filter((link) =>
    link.sourceConversationId !== conversationId
    && !removedMessageIds.has(link.sourceMessageId ?? '')
    && !removedToolCallIds.has(link.sourceToolCallId ?? '')
  );
  const nextAgentRunTargetLinks = state.agentRunTargetLinks.filter((link) => link.conversationId !== conversationId);
  const nextMessageRunLinks = state.messageRunLinks.filter((link) => !removedMessageIds.has(link.messageId));
  const nextToolCallRunLinks = state.toolCallRunLinks.filter((link) => !removedToolCallIds.has(link.toolCallId));
  const nextAgentRunInputRevisions = state.agentRunInputRevisions.filter((input) =>
    input.conversationId !== conversationId && !removedRevisionIds.has(input.revisionId)
  );

  const removedConversationPolicyIds = new Set(state.runConversationPolicies
    .filter((policy) => policy.conversationId === conversationId || policy.branchFromConversationId === conversationId)
    .map((policy) => policy.id));
  const removedDeliveryPolicyIds = new Set(state.runDeliveryPolicies
    .filter((policy) => policy.targetConversationId === conversationId || removedToolCallIds.has(policy.targetToolCallId ?? ''))
    .map((policy) => policy.id));

  const nextRunConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => !removedConversationPolicyIds.has(link.policyId));
  const nextRunDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => !removedDeliveryPolicyIds.has(link.policyId));

  const keptCompressionBlockIds = new Set(state.compressionBlocks
    .filter((block) => !removedCompressionBlockIds.has(block.id))
    .map((block) => block.id));
  const nextCompressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) =>
    keptCompressionBlockIds.has(link.blockId)
    && !removedMessageIds.has(link.sourceId)
    && !removedRevisionIds.has(link.revisionId ?? '')
  );
  const nextCompressionContextVariants = state.compressionContextVariants.filter((variant) => keptCompressionBlockIds.has(variant.blockId));
  const keptCompressionVariantIds = new Set(nextCompressionContextVariants.map((variant) => variant.id));
  const nextRunCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) =>
    keptCompressionBlockIds.has(link.blockId)
    && (link.variantId === undefined || keptCompressionVariantIds.has(link.variantId))
  );
  const nextCompressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => keptCompressionBlockIds.has(link.blockId));

  const nextMessageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => !removedMessageIds.has(link.messageId));
  const keptInvocationIds = new Set<string>();
  for (const link of state.runLlmInvocationLinks) keptInvocationIds.add(link.invocationId);
  for (const link of nextMessageLlmInvocationLinks) keptInvocationIds.add(link.invocationId);
  for (const link of nextCompressionBlockLlmInvocationLinks) keptInvocationIds.add(link.invocationId);

  const keptMessageIds = new Set(state.messages.filter((message) => !removedMessageIds.has(message.id)).map((message) => message.id));
  for (const messageId of remainingSummaryMessageIds) {
    if (!removedMessageIds.has(messageId)) keptMessageIds.add(messageId);
  }
  const keptRevisionIds = new Set(state.messageRevisions
    .filter((revision) => !removedRevisionIds.has(revision.id) && keptMessageIds.has(revision.messageId))
    .map((revision) => revision.id));
  const keptToolCallIds = new Set(state.toolCalls
    .filter((toolCall) => !removedToolCallIds.has(toolCall.id) && keptMessageIds.has(toolCall.messageId))
    .map((toolCall) => toolCall.id));

  return {
    ...state,
    conversations: state.conversations.filter((conversation) => conversation.id !== conversationId),
    messages: state.messages.filter((message) => keptMessageIds.has(message.id)),
    messageRevisions: state.messageRevisions.filter((revision) => keptRevisionIds.has(revision.id)),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => keptMessageIds.has(link.messageId) && keptRevisionIds.has(link.revisionId)),
    toolCalls: state.toolCalls.filter((toolCall) => keptToolCallIds.has(toolCall.id)),
    toolCallEvents: state.toolCallEvents.filter((event) => keptToolCallIds.has(event.toolCallId)),
    agentRunSourceLinks: nextAgentRunSourceLinks,
    agentRunTargetLinks: nextAgentRunTargetLinks,
    messageRunLinks: nextMessageRunLinks,
    toolCallRunLinks: nextToolCallRunLinks,
    agentRunInputRevisions: nextAgentRunInputRevisions,
    runConversationPolicies: state.runConversationPolicies.filter((policy) => !removedConversationPolicyIds.has(policy.id)),
    runDeliveryPolicies: state.runDeliveryPolicies.filter((policy) => !removedDeliveryPolicyIds.has(policy.id)),
    runConversationPolicyLinks: nextRunConversationPolicyLinks,
    runDeliveryPolicyLinks: nextRunDeliveryPolicyLinks,
    compressionBlocks: state.compressionBlocks.filter((block) => keptCompressionBlockIds.has(block.id)),
    compressionBlockSourceLinks: nextCompressionBlockSourceLinks,
    compressionContextVariants: nextCompressionContextVariants,
    runCompressionBlockLinks: nextRunCompressionBlockLinks,
    compressionBlockLlmInvocationLinks: nextCompressionBlockLlmInvocationLinks,
    messageLlmInvocationLinks: nextMessageLlmInvocationLinks,
    llmInvocations: state.llmInvocations.filter((invocation) => keptInvocationIds.has(invocation.id))
  };
}


interface CheckpointDeletionPlan {
  checkpointIds: Set<string>;
  shadowRepositoryIds: Set<string>;
  storageKeys: Set<string>;
}

async function collectCheckpointDeletionPlan(paths: StoragePaths, conversationId: string, errors: string[]): Promise<CheckpointDeletionPlan> {
  const empty = (): CheckpointDeletionPlan => ({ checkpointIds: new Set(), shadowRepositoryIds: new Set(), storageKeys: new Set() });
  try {
    const [checkpoints, repositoryLinks, shadowRepositories] = await Promise.all([
      loadRecords<CheckpointRecord>(paths.checkpointsRootUri, paths.checkpointsIndexUri, 'checkpoint'),
      loadRecords<ConversationCheckpointRepositoryLinkRecord>(paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri, 'link'),
      loadRecords<ShadowRepositoryRecord>(paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri, 'shadowRepository')
    ]);
    const checkpointIds = new Set(checkpoints.filter((record) => record.conversationId === conversationId).map((record) => record.id));
    const candidateRepositoryIds = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.conversationId === conversationId) candidateRepositoryIds.add(checkpoint.shadowRepositoryId);
    }
    for (const link of repositoryLinks) {
      if (link.conversationId === conversationId) candidateRepositoryIds.add(link.shadowRepositoryId);
    }

    const referencedAfterDelete = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.conversationId !== conversationId) referencedAfterDelete.add(checkpoint.shadowRepositoryId);
    }
    for (const link of repositoryLinks) {
      if (link.conversationId !== conversationId) referencedAfterDelete.add(link.shadowRepositoryId);
    }

    const shadowRepositoryIds = new Set([...candidateRepositoryIds].filter((id) => !referencedAfterDelete.has(id)));
    const storageKeysReferencedByRetainedRepositories = new Set(shadowRepositories
      .filter((record) => !shadowRepositoryIds.has(record.id))
      .map((record) => record.storageKey));
    const storageKeys = new Set(shadowRepositories
      .filter((record) => shadowRepositoryIds.has(record.id) && !storageKeysReferencedByRetainedRepositories.has(record.storageKey))
      .map((record) => record.storageKey));
    return { checkpointIds, shadowRepositoryIds, storageKeys };
  } catch (error) {
    errors.push(`load checkpoint metadata for delete:${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    return empty();
  }
}

async function deleteUnusedShadowWorktreeDirectories(paths: StoragePaths, storageKeys: ReadonlySet<string>, deletedPaths: string[], errors: string[]): Promise<void> {
  await Promise.all([...storageKeys].map(async (storageKey) => {
    try {
      const result = await deleteShadowWorktreeDirectory(paths.checkpointShadowWorktreesRootPath, storageKey);
      deletedPaths.push(result.worktreePath);
    } catch (error) {
      errors.push(`delete shadow worktree:${storageKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

async function collectRunIdsForDeletion(paths: StoragePaths, conversationId: string, errors: string[]): Promise<Set<string>> {
  try {
    const index = await loadRunHistoryIndexStrict(runHistoryRoot(paths, conversationId), conversationId, { allowMissing: true, validatePages: true });
    return new Set(index?.index.runs.map((run) => run.id) ?? []);
  } catch (error) {
    errors.push(`load run history for delete:${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

async function tryDeleteUri(
  uri: vscode.Uri,
  deletedPaths: string[],
  errors: string[],
  options: { recursive?: boolean } = {}
): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: options.recursive ?? false, useTrash: false });
    deletedPaths.push(uri.fsPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    errors.push(`delete ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'FileNotFound' || code === 'ENOENT';
}

async function loadSkeletonRecords<TRecord extends StoreRecord>(
  label: string,
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


function runHistoryRoot(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.runHistoryRootUri, RUN_HISTORY_CONVERSATIONS_DIR, safeShardName(conversationId));
}

function runDetailUri(paths: StoragePaths, runId: string): vscode.Uri {
  return vscode.Uri.joinPath(paths.runHistoryRootUri, RUN_HISTORY_RUNS_DIR, `${safeShardName(runId)}.json`);
}

function mergeUniqueById<T extends StoreRecord>(left: T[], right: T[]): T[] {
  assertUniqueRecords(left, 'mergeUniqueById.left');
  assertUniqueRecords(right, 'mergeUniqueById.right');
  const byId = new Map<string, T>();
  for (const item of left) byId.set(item.id, item);
  for (const item of right) byId.set(item.id, item);
  return [...byId.values()];
}


function upsertById<T extends StoreRecord>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function normalizeRestoredRunLikeRecord<T extends { status: string; updatedAt: number; completedAt?: number; endReason?: string; errorType?: string; error?: string }>(record: T): T {
  if (record.status === 'queued' || record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'stale') return record;
  const now = Date.now();
  return {
    ...record,
    status: 'cancelled',
    updatedAt: Math.max(record.updatedAt, now),
    completedAt: record.completedAt ?? now,
    endReason: record.endReason ?? 'cancelled_by_policy',
    errorType: record.errorType ?? 'cancelled',
    error: record.error ?? '扩展重启后未完成 AgentRun 已收敛为取消状态。'
  };
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
