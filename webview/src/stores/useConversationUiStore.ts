import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import {
  buildConversationTimelineRows,
  type ConversationCheckpointTimelineRow,
  type ConversationCompressionTimelineRow,
  type ConversationTimelineRow
} from '@shared/conversationTimeline';
import { isVisibleTextPart, type CheckpointRecord, type CheckpointTimelineAnchorRecord, type CompressionBlockRecord, type LlmTransientNoticePayload, type MessageRecord } from '@shared/protocol';

export type MessageViewPhase = 'stable' | 'entering' | 'exiting';
export type ComposerMode = 'chat' | 'edit';
export type ComposerZone = 'top' | 'left' | 'right' | 'bottom';
export type ComposerZoneSnapshot = Record<string, unknown>;

export interface MessageViewRow {
  kind: 'message';
  id: string;
  message: MessageRecord;
  messageFloorNumber: number;
  deleteCount: number;
  phase: MessageViewPhase;
}

export interface CheckpointMarkerView extends ConversationCheckpointTimelineRow {
  phase: MessageViewPhase;
  expanded: boolean;
}

export interface CompressionViewRow extends ConversationCompressionTimelineRow {
  phase: MessageViewPhase;
}

export interface ActivityTimelineRowInput {
  id: string;
  conversationId: string;
  runId?: string;
  hiddenMessageId?: string;
  activityKind: 'preparing';
}

export interface ActivityViewRow extends ActivityTimelineRowInput {
  kind: 'activity';
  phase: MessageViewPhase;
}

export type ConversationTimelineViewRow = MessageViewRow | CompressionViewRow | ActivityViewRow;

export interface ComposerSnapshot {
  draft: string;
  zones: Record<ComposerZone, ComposerZoneSnapshot>;
}

export interface EditingMessageState {
  message: MessageRecord;
  deleteCount: number;
  originalText: string;
}

export type LlmErrorBlockStatus = 'retrying' | 'cancelled' | 'resolved' | 'failed';

export interface LlmErrorBlockRecord {
  id: string;
  conversationId: string;
  messageId: string;
  requestId: string;
  runId?: string;
  invocationId?: string;
  message: string;
  rawError?: unknown;
  status: LlmErrorBlockStatus;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  cancelPending?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface TimelineSyncSnapshot {
  messages: MessageRecord[];
  anchorMessages: MessageRecord[];
  checkpoints: CheckpointRecord[];
  checkpointAnchors: CheckpointTimelineAnchorRecord[];
  compressionBlocks: CompressionBlockRecord[];
  activityRows: ActivityTimelineRowInput[];
  floorByMessageId: Record<string, number>;
  totalMessageCount: number;
}

// CSS 动画是 100ms；JS 计时保持一致，让新增/删除节奏更利落。
const MESSAGE_ANIMATION_SETTLE_MS = 100;
const MESSAGE_ENTER_MS = MESSAGE_ANIMATION_SETTLE_MS;
const MESSAGE_EXIT_MS = MESSAGE_ANIMATION_SETTLE_MS;
const MESSAGE_EXIT_ACTION_DELAY_MS = MESSAGE_EXIT_MS;

/**
 * 当前标签页/会话 UI 状态。
 *
 * 后端同步数据仍以 useClientStateStore 为权威源；这里保存的是视图层状态：
 * - 消息展示行与进入/退出动画 phase
 * - 输入框不同模式下的快照（chat/edit，预留功能区 zone 快照）
 * - 当前编辑消息与确认面板状态
 */
export const useConversationUiStore = defineStore('conversationUi', () => {
  const messageRows = shallowRef<MessageViewRow[]>([]);
  const timelineRows = shallowRef<ConversationTimelineViewRow[]>([]);
  const checkpointMarkers = shallowRef<CheckpointMarkerView[]>([]);
  const llmErrorBlocks = shallowRef<LlmErrorBlockRecord[]>([]);
  const enteringMessageIds = ref<Set<string>>(new Set());
  const expandedCheckpointRowId = ref<string | undefined>();
  const composerSnapshots = ref<Record<ComposerMode, ComposerSnapshot>>({
    chat: createComposerSnapshot(),
    edit: createComposerSnapshot()
  });
  const composerMode = ref<ComposerMode>('chat');
  const composerHighlightKey = ref(0);
  const editingMessage = shallowRef<EditingMessageState>();
  const editingQueueRunId = ref<string | undefined>(undefined);
  const editConfirmOpen = ref(false);
  const pendingEditText = ref('');
  const pendingTimelineMutationActivity = shallowRef<ActivityTimelineRowInput>();

  const seenMessageIds = new Set<string>();
  const enterTimers = new Map<string, number>();
  let lastTimelineSnapshot: TimelineSyncSnapshot = createEmptyTimelineSyncSnapshot();
  let initializedMessages = false;
  let exitingFromId: string | undefined;
  let optimisticallyHiddenFromId: string | undefined;
  let exitActionTimer: number | undefined;

  const isEditing = computed(() => composerMode.value === 'edit');
  const hasPendingTimelineMutation = computed(() => pendingTimelineMutationActivity.value !== undefined);
  const activeComposerSnapshot = computed(() => composerSnapshots.value[composerMode.value]);
  const composerDraft = computed(() => activeComposerSnapshot.value.draft);

  function syncMessages(messages: readonly MessageRecord[]): void {
    syncTimeline(messages, messages, [], [], []);
  }

  function syncTimeline(
    messages: readonly MessageRecord[],
    anchorMessages: readonly MessageRecord[],
    checkpoints: readonly CheckpointRecord[],
    checkpointAnchors: readonly CheckpointTimelineAnchorRecord[],
    compressionBlocks: readonly CompressionBlockRecord[] = [],
    activityRows: readonly ActivityTimelineRowInput[] = [],
    floorByMessageId: Readonly<Record<string, number>> = {},
    totalMessageCount = messages.length
  ): void {
    const nextSnapshot: TimelineSyncSnapshot = {
      messages: [...messages],
      anchorMessages: [...anchorMessages],
      checkpoints: [...checkpoints],
      checkpointAnchors: [...checkpointAnchors],
      compressionBlocks: [...compressionBlocks],
      activityRows: [...activityRows],
      floorByMessageId: { ...floorByMessageId },
      totalMessageCount
    };
    const canReuseRows = initializedMessages && canReuseTimelineRows(lastTimelineSnapshot, nextSnapshot);
    lastTimelineSnapshot = nextSnapshot;

    // 流式文本、思考耗时和普通状态 mutation 会原地更新同一条 message。
    // 当行结构、记录引用和楼层映射均未变化时，现有 row 已持有最新 reactive record，
    // 无需再次构建整条 timelineRows，也避免所有历史 MessageItem 重收 props。
    if (canReuseRows) return;

    const hiddenMessageIds = new Set(activityRows.map((row) => row.hiddenMessageId).filter((id): id is string => !!id));
    const currentIds = new Set(messages.map((message) => message.id));
    const activeIds = new Set([...currentIds, ...hiddenMessageIds]);
    pruneErrorBlocks(currentIds);
    for (const id of [...enterTimers.keys()]) {
      if (!activeIds.has(id)) clearEntering(id);
    }

    if (!initializedMessages) {
      for (const message of messages) seenMessageIds.add(message.id);
      for (const id of hiddenMessageIds) seenMessageIds.add(id);
      initializedMessages = true;
    } else {
      for (const id of hiddenMessageIds) seenMessageIds.add(id);
      for (const message of messages) {
        if (seenMessageIds.has(message.id)) continue;
        // 新消息一出现就标记进入态。AI/model 消息通常会先以「streaming + 空内容」占位创建，
        // 如果等到首个 token 再开动画，元素会先稳定渲染再突然补动画，重试时会表现为“顿一下”。
        seenMessageIds.add(message.id);
        markEntering(message.id);
      }
    }

    if (exitingFromId && !currentIds.has(exitingFromId)) clearExitState();

    rebuildTimelineRows();
  }

  function rebuildTimelineRows(): void {
    const { messages, anchorMessages, checkpoints, checkpointAnchors, compressionBlocks, activityRows, floorByMessageId, totalMessageCount } = lastTimelineSnapshot;
    const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));
    const allRows = buildConversationTimelineRows({ messages, anchorMessages, checkpoints, checkpointAnchors, compressionBlocks });
    pruneExpandedCheckpointRows(allRows);

    checkpointMarkers.value = allRows
      .filter((row): row is ConversationCheckpointTimelineRow => row.kind === 'checkpoint')
      .map((row): CheckpointMarkerView => ({
        ...row,
        expanded: expandedCheckpointRowId.value === row.id,
        phase: phaseForAnchoredTimelineRow(row, messageIndexById, messages)
      }))
      .filter((row) => !optimisticallyHiddenFromId || row.phase !== 'exiting');

    const rows = allRows.flatMap((row): ConversationTimelineViewRow[] => {
      if (row.kind === 'checkpoint') return [];
      if (row.kind === 'message') {
        const messageIndex = messageIndexById.get(row.message.id) ?? 0;
        const floorNumber = floorByMessageId[row.message.id] ?? row.messageFloorNumber;
        return [{
          ...row,
          messageFloorNumber: floorNumber,
          deleteCount: Math.max(1, totalMessageCount - floorNumber + 1),
          phase: phaseForMessage(row.message.id, messageIndex, messages)
        }];
      }
      if (row.kind === 'compression') {
        return [{
          ...row,
          phase: phaseForAnchoredTimelineRow(row, messageIndexById, messages)
        }];
      }
      return [];
    });
    const localPreparingActivity = pendingTimelineMutationActivity.value;
    const hasBackendPreparingActivity = !!localPreparingActivity && activityRows.some((row) =>
      row.conversationId === localPreparingActivity.conversationId && row.activityKind === 'preparing'
    );
    const effectiveActivityRows = localPreparingActivity && !hasBackendPreparingActivity
      ? [...activityRows, localPreparingActivity]
      : activityRows;
    const activityViewRows: ActivityViewRow[] = effectiveActivityRows.map((row) => ({
      ...row,
      kind: 'activity',
      phase: 'stable'
    }));
    const visibleRows = optimisticallyHiddenFromId
      ? rows.filter((row) => row.phase !== 'exiting')
      : rows;
    timelineRows.value = [...visibleRows, ...activityViewRows];
    messageRows.value = visibleRows.filter((row): row is MessageViewRow => row.kind === 'message');
  }

  function pruneExpandedCheckpointRows(rows: readonly ConversationTimelineRow[]): void {
    const validCheckpointRowIds = new Set(rows.filter((row) => row.kind === 'checkpoint').map((row) => row.id));
    if (expandedCheckpointRowId.value && !validCheckpointRowIds.has(expandedCheckpointRowId.value)) {
      expandedCheckpointRowId.value = undefined;
    }
  }

  function toggleCheckpointMarker(rowId: string): void {
    expandedCheckpointRowId.value = expandedCheckpointRowId.value === rowId ? undefined : rowId;
    rebuildTimelineRows();
  }

  function playExitFrom(messageId: string, action: () => void, delay = MESSAGE_EXIT_ACTION_DELAY_MS): void {
    clearExitTimers();
    exitingFromId = messageId;
    refreshRowPhases();

    exitActionTimer = window.setTimeout(() => {
      // 动画结束后立即收起布局，并用本地 preparing row 衔接后端真实状态；
      // 不让透明消息继续占位，也不留下“什么都没有”的等待空窗。
      optimisticallyHiddenFromId = messageId;
      const targetMessage = lastTimelineSnapshot.messages.find((message) => message.id === messageId);
      if (targetMessage) {
        pendingTimelineMutationActivity.value = {
          id: `activity:timeline-mutation:${messageId}`,
          conversationId: targetMessage.conversationId,
          activityKind: 'preparing'
        };
      }
      refreshRowPhases();
      action();
      exitActionTimer = undefined;
    }, delay);
  }

  function startEditMessage(message: MessageRecord, deleteCount: number): void {
    editingMessage.value = {
      message,
      deleteCount,
      originalText: visibleMessageText(message)
    };
    pendingEditText.value = '';
    editConfirmOpen.value = false;
    composerMode.value = 'edit';
    composerSnapshots.value.edit = createComposerSnapshot(visibleMessageText(message));
    composerHighlightKey.value += 1;
  }

  function cancelEditMode(): void {
    editingMessage.value = undefined;
    editingQueueRunId.value = undefined;
    pendingEditText.value = '';
    editConfirmOpen.value = false;
    composerMode.value = 'chat';
    composerSnapshots.value.edit = createComposerSnapshot();
  }

  function startEditQueueItem(runId: string, messageText: string): void {
    editingMessage.value = undefined;
    editingQueueRunId.value = runId;
    pendingEditText.value = '';
    editConfirmOpen.value = false;
    composerMode.value = 'edit';
    composerSnapshots.value.edit = createComposerSnapshot(messageText);
    composerHighlightKey.value += 1;
  }

  function setComposerDraft(value: string): void {
    activeComposerSnapshot.value.draft = value;
  }

  function clearChatDraft(): void {
    composerSnapshots.value.chat.draft = '';
  }

  function phaseForMessage(id: string, index: number, messages: readonly MessageRecord[]): MessageViewPhase {
    const exitStart = exitingFromId ? messages.findIndex((message) => message.id === exitingFromId) : -1;
    if (exitStart >= 0 && index >= exitStart) return 'exiting';
    if (enteringMessageIds.value.has(id)) return 'entering';
    return 'stable';
  }

  function phaseForAnchoredTimelineRow(
    row: ConversationCheckpointTimelineRow | ConversationCompressionTimelineRow,
    messageIndexById: ReadonlyMap<string, number>,
    messages: readonly MessageRecord[]
  ): MessageViewPhase {
    const messageId = row.floorMessageId;
    const index = messageId ? messageIndexById.get(messageId) ?? -1 : -1;
    return index >= 0 && messageId ? phaseForMessage(messageId, index, messages) : 'stable';
  }

  function llmErrorBlocksForMessage(messageId: string): LlmErrorBlockRecord[] {
    return llmErrorBlocks.value.filter((block) => block.messageId === messageId);
  }

  function applyLlmTransientNotice(payload: LlmTransientNoticePayload): void {
    const status = statusFromNoticeKind(payload.kind);
    if (status === 'resolved') {
      llmErrorBlocks.value = llmErrorBlocks.value.filter((block) => block.requestId !== payload.requestId);
      return;
    }

    const index = llmErrorBlocks.value.findIndex((block) => block.requestId === payload.requestId);
    const previous = index >= 0 ? llmErrorBlocks.value[index] : undefined;
    const now = payload.createdAt || Date.now();
    const next: LlmErrorBlockRecord = {
      id: previous?.id ?? payload.id,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      requestId: payload.requestId,
      ...(payload.runId ? { runId: payload.runId } : previous?.runId ? { runId: previous.runId } : {}),
      ...(payload.invocationId ? { invocationId: payload.invocationId } : previous?.invocationId ? { invocationId: previous.invocationId } : {}),
      message: payload.message || previous?.message || 'LLM 请求失败。',
      ...(payload.rawError !== undefined ? { rawError: payload.rawError } : previous?.rawError !== undefined ? { rawError: previous.rawError } : {}),
      status,
      ...(payload.retryAttempt !== undefined ? { retryAttempt: payload.retryAttempt } : previous?.retryAttempt !== undefined ? { retryAttempt: previous.retryAttempt } : {}),
      ...(payload.retryMaxAttempts !== undefined ? { retryMaxAttempts: payload.retryMaxAttempts } : previous?.retryMaxAttempts !== undefined ? { retryMaxAttempts: previous.retryMaxAttempts } : {}),
      ...(payload.retryDelayMs !== undefined ? { retryDelayMs: payload.retryDelayMs } : previous?.retryDelayMs !== undefined && status === 'retrying' ? { retryDelayMs: previous.retryDelayMs } : {}),
      cancelPending: status === 'retrying' ? previous?.cancelPending === true : false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    const blocks = [...llmErrorBlocks.value];
    if (index >= 0) blocks[index] = next;
    else blocks.push(next);
    llmErrorBlocks.value = blocks;
  }

  function removeLlmErrorBlock(id: string): void {
    llmErrorBlocks.value = llmErrorBlocks.value.filter((block) => block.id !== id);
  }

  function markLlmRetryCancelPending(requestId: string): void {
    llmErrorBlocks.value = llmErrorBlocks.value.map((block) => block.requestId === requestId && block.status === 'retrying'
      ? { ...block, cancelPending: true, updatedAt: Date.now() }
      : block);
  }

  function pruneErrorBlocks(currentMessageIds: ReadonlySet<string>): void {
    const next = llmErrorBlocks.value.filter((block) => currentMessageIds.has(block.messageId));
    if (next.length === llmErrorBlocks.value.length) return;

    llmErrorBlocks.value = next;
  }

  function refreshRowPhases(): void {
    rebuildTimelineRows();
  }

  function markEntering(id: string): void {
    const next = new Set(enteringMessageIds.value);
    next.add(id);
    enteringMessageIds.value = next;
    enterTimers.set(id, window.setTimeout(() => clearEntering(id), MESSAGE_ENTER_MS));
  }

  function clearEntering(id: string): void {
    const timer = enterTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    enterTimers.delete(id);

    const next = new Set(enteringMessageIds.value);
    next.delete(id);
    enteringMessageIds.value = next;
    refreshRowPhases();
  }

  function cancelPendingTimelineMutation(): boolean {
    if (!pendingTimelineMutationActivity.value) return false;
    pendingTimelineMutationActivity.value = undefined;
    refreshRowPhases();
    return true;
  }

  function clearExitState(): void {
    exitingFromId = undefined;
    optimisticallyHiddenFromId = undefined;
    pendingTimelineMutationActivity.value = undefined;
    clearExitTimers();
    refreshRowPhases();
  }

  function clearExitTimers(): void {
    if (exitActionTimer !== undefined) {
      window.clearTimeout(exitActionTimer);
      exitActionTimer = undefined;
    }
  }

  return {
    messageRows,
    timelineRows,
    checkpointMarkers,
    llmErrorBlocks,
    composerMode,
    composerHighlightKey,
    composerDraft,
    editingMessage,
    editingQueueRunId,
    editConfirmOpen,
    pendingEditText,
    isEditing,
    hasPendingTimelineMutation,
    syncMessages,
    syncTimeline,
    toggleCheckpointMarker,
    playExitFrom,
    startEditMessage,
    startEditQueueItem,
    cancelEditMode,
    setComposerDraft,
    clearChatDraft,
    cancelPendingTimelineMutation,
    clearExitState,
    llmErrorBlocksForMessage,
    applyLlmTransientNotice,
    removeLlmErrorBlock,
    markLlmRetryCancelPending
  };
});

function canReuseTimelineRows(previous: TimelineSyncSnapshot, next: TimelineSyncSnapshot): boolean {
  return sameRecordReferences(previous.messages, next.messages)
    && sameRecordReferences(previous.anchorMessages, next.anchorMessages)
    && sameRecordReferences(previous.checkpoints, next.checkpoints)
    && sameRecordReferences(previous.checkpointAnchors, next.checkpointAnchors)
    && sameRecordReferences(previous.compressionBlocks, next.compressionBlocks)
    && sameActivityRows(previous.activityRows, next.activityRows)
    && sameNumberRecord(previous.floorByMessageId, next.floorByMessageId)
    && previous.totalMessageCount === next.totalMessageCount;
}

function sameRecordReferences<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((record, index) => record === next[index]);
}

function sameActivityRows(previous: readonly ActivityTimelineRowInput[], next: readonly ActivityTimelineRowInput[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((row, index) => {
    const candidate = next[index];
    return candidate !== undefined
      && row.id === candidate.id
      && row.conversationId === candidate.conversationId
      && row.runId === candidate.runId
      && row.hiddenMessageId === candidate.hiddenMessageId
      && row.activityKind === candidate.activityKind;
  });
}

function sameNumberRecord(previous: Readonly<Record<string, number>>, next: Readonly<Record<string, number>>): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => previous[key] === next[key]);
}

function visibleMessageText(message: MessageRecord): string {
  return message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
    .trim();
}

function createComposerSnapshot(draft = ''): ComposerSnapshot {
  return {
    draft,
    zones: {
      top: {},
      left: {},
      right: {},
      bottom: {}
    }
  };
}

function createEmptyTimelineSyncSnapshot(): TimelineSyncSnapshot {
  return {
    messages: [],
    anchorMessages: [],
    checkpoints: [],
    checkpointAnchors: [],
    compressionBlocks: [],
    activityRows: [],
    floorByMessageId: {},
    totalMessageCount: 0
  };
}

function statusFromNoticeKind(kind: LlmTransientNoticePayload['kind']): LlmErrorBlockStatus {
  switch (kind) {
    case 'retryScheduled':
    case 'retryStarted':
      return 'retrying';
    case 'retryCancelled':
      return 'cancelled';
    case 'retryRecovered':
      return 'resolved';
    case 'error':
      return 'failed';
  }
}
