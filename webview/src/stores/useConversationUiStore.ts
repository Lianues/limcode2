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

export type ConversationTimelineViewRow = MessageViewRow | CompressionViewRow;

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
  checkpoints: CheckpointRecord[];
  checkpointAnchors: CheckpointTimelineAnchorRecord[];
  compressionBlocks: CompressionBlockRecord[];
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

  const seenMessageIds = new Set<string>();
  const enterTimers = new Map<string, number>();
  let lastTimelineSnapshot: TimelineSyncSnapshot = createEmptyTimelineSyncSnapshot();
  let initializedMessages = false;
  let exitingFromId: string | undefined;
  let exitActionTimer: number | undefined;

  const isEditing = computed(() => composerMode.value === 'edit');
  const activeComposerSnapshot = computed(() => composerSnapshots.value[composerMode.value]);
  const composerDraft = computed(() => activeComposerSnapshot.value.draft);

  function syncMessages(messages: readonly MessageRecord[]): void {
    syncTimeline(messages, [], [], []);
  }

  function syncTimeline(
    messages: readonly MessageRecord[],
    checkpoints: readonly CheckpointRecord[],
    checkpointAnchors: readonly CheckpointTimelineAnchorRecord[],
    compressionBlocks: readonly CompressionBlockRecord[] = [],
    floorByMessageId: Readonly<Record<string, number>> = {},
    totalMessageCount = messages.length
  ): void {
    lastTimelineSnapshot = {
      messages: [...messages],
      checkpoints: [...checkpoints],
      checkpointAnchors: [...checkpointAnchors],
      compressionBlocks: [...compressionBlocks],
      floorByMessageId: { ...floorByMessageId },
      totalMessageCount
    };

    const currentIds = new Set(messages.map((message) => message.id));
    pruneErrorBlocks(currentIds);
    for (const id of [...enterTimers.keys()]) {
      if (!currentIds.has(id)) clearEntering(id);
    }

    if (!initializedMessages) {
      for (const message of messages) seenMessageIds.add(message.id);
      initializedMessages = true;
    } else {
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
    const { messages, checkpoints, checkpointAnchors, compressionBlocks, floorByMessageId, totalMessageCount } = lastTimelineSnapshot;
    const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));
    const allRows = buildConversationTimelineRows({ messages, checkpoints, checkpointAnchors, compressionBlocks });
    pruneExpandedCheckpointRows(allRows);

    checkpointMarkers.value = allRows
      .filter((row): row is ConversationCheckpointTimelineRow => row.kind === 'checkpoint')
      .map((row): CheckpointMarkerView => ({
        ...row,
        expanded: expandedCheckpointRowId.value === row.id,
        phase: phaseForAnchoredTimelineRow(row, messageIndexById, messages)
      }));

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
    timelineRows.value = rows;
    messageRows.value = rows.filter((row): row is MessageViewRow => row.kind === 'message');
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

  function clearExitState(): void {
    exitingFromId = undefined;
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
    syncMessages,
    syncTimeline,
    toggleCheckpointMarker,
    playExitFrom,
    startEditMessage,
    startEditQueueItem,
    cancelEditMode,
    setComposerDraft,
    clearChatDraft,
    llmErrorBlocksForMessage,
    applyLlmTransientNotice,
    removeLlmErrorBlock,
    markLlmRetryCancelPending
  };
});

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
    checkpoints: [],
    checkpointAnchors: [],
    compressionBlocks: [],
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
