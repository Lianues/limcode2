import * as vscode from 'vscode';
import {
  BridgeMessageType,
  createMessageId,
  type CheckpointRecord,
  type CheckpointSkipReason,
  type CheckpointStatus,
  type WebviewClientMeta
} from '../../../../shared/protocol';
import { CheckpointEventType } from '../../../world/modules/checkpoint/events';
import type { CheckpointCreateEffect } from '../../../world/modules/checkpoint/effects';
import type { Emit } from '../../../capabilities/types';
import type { WebviewCapability, StorageCapability } from '../../../capabilities/types';
import type { EffectHandlerRegistry } from '../registry';

/** 每个对话标签页在自身生命周期内只展示一次存档点问题提醒；关闭后重新打开会获得新的 clientId，可再次提醒。 */
const checkpointNoticeShownClientIds = new Set<string>();
/** 同一 shadow 仓库内串行创建存档点，避免首次消息同时触发 initial/after 时并发 git init 锁冲突。 */
const checkpointCreateQueues = new Map<string, Promise<void>>();

export function registerCheckpointEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('checkpoint.create', (effect, env, emit) => {
    enqueueCheckpointCreate(effect.shadowRepositoryStorageKey, () => runCheckpointCreate(effect, env.storage, env.webview, emit));
  });
}

function enqueueCheckpointCreate(storageKey: string, task: () => Promise<void>): void {
  const previous = checkpointCreateQueues.get(storageKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tracked = next.finally(() => {
    if (checkpointCreateQueues.get(storageKey) === tracked) checkpointCreateQueues.delete(storageKey);
  });
  checkpointCreateQueues.set(storageKey, tracked);
}

async function runCheckpointCreate(effect: CheckpointCreateEffect, storage: StorageCapability, webview: WebviewCapability, emit: Emit): Promise<void> {
  try {
    const record = await storage.createShadowCheckpoint(effect);
    emitCompletedCheckpoint(record, effect, emit);
    void broadcastShadowStats(storage, webview);
    maybeNotifyCheckpointIssue({ conversationId: record.conversationId, status: record.status, skipReason: record.skipReason, message: record.message }, webview);
  } catch (error) {
    const now = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    emit({
      type: CheckpointEventType.Completed,
      payload: {
        checkpointId: effect.checkpointId,
        conversationId: effect.conversationId,
        projectContextId: effect.projectContextId,
        shadowRepositoryId: effect.shadowRepositoryId,
        trigger: effect.trigger,
        status: 'failed',
        projectUri: effect.projectUri,
        projectDisplayPath: effect.projectDisplayPath,
        createdAt: now,
        updatedAt: now,
        skipReason: 'io_error',
        message,
        ...(effect.floorMessageId ? { floorMessageId: effect.floorMessageId } : {}),
        ...(effect.anchorPosition ? { anchorPosition: effect.anchorPosition } : {}),
        ...(effect.sourceRunId ? { sourceRunId: effect.sourceRunId } : {}),
        ...(effect.sourceToolCallId ? { sourceToolCallId: effect.sourceToolCallId } : {})
      }
    });
    void broadcastShadowStats(storage, webview);
    maybeNotifyCheckpointIssue({ conversationId: effect.conversationId, status: 'failed', skipReason: 'io_error', message }, webview);
  }
}

async function broadcastShadowStats(storage: StorageCapability, webview: WebviewCapability): Promise<void> {
  try {
    const stats = await storage.collectShadowWorktreeStats();
    webview.broadcast({
      id: createMessageId(),
      type: BridgeMessageType.CheckpointShadowStatsSnapshot,
      channel: 'state',
      payload: { stats }
    });
  } catch (error) {
    console.warn('[LimCode] Failed to broadcast checkpoint shadow stats.', error);
  }
}

function emitCompletedCheckpoint(record: CheckpointRecord, effect: CheckpointCreateEffect, emit: Emit): void {
  emit({
    type: CheckpointEventType.Completed,
    payload: {
      checkpointId: record.id,
      conversationId: record.conversationId,
      projectContextId: record.projectContextId,
      shadowRepositoryId: record.shadowRepositoryId,
      trigger: record.trigger,
      status: record.status,
      projectUri: record.projectUri,
      projectDisplayPath: record.projectDisplayPath,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.commitSha ? { commitSha: record.commitSha } : {}),
      ...(record.skipReason ? { skipReason: record.skipReason } : {}),
      ...(record.message ? { message: record.message } : {}),
      ...(record.fileCount !== undefined ? { fileCount: record.fileCount } : {}),
      ...(record.byteCount !== undefined ? { byteCount: record.byteCount } : {}),
      ...(record.emptyDirectoryCount !== undefined ? { emptyDirectoryCount: record.emptyDirectoryCount } : {}),
      ...(effect.floorMessageId ? { floorMessageId: effect.floorMessageId } : {}),
      ...(effect.anchorPosition ? { anchorPosition: effect.anchorPosition } : {}),
      ...(effect.sourceRunId ? { sourceRunId: effect.sourceRunId } : {}),
      ...(effect.sourceToolCallId ? { sourceToolCallId: effect.sourceToolCallId } : {})
    }
  });
}

interface CheckpointIssueInput {
  conversationId: string;
  status: CheckpointStatus;
  skipReason?: CheckpointSkipReason;
  message?: string;
}

function maybeNotifyCheckpointIssue(input: CheckpointIssueInput, webview: WebviewCapability): void {
  const notice = checkpointIssueNotice(input);
  if (!notice) return;
  const targets = webview.clientRecords().filter((client) => checkpointNoticeClientMatches(client.meta, input.conversationId));
  const unseenTargets = targets.filter((client) => !checkpointNoticeShownClientIds.has(client.id));
  if (unseenTargets.length === 0) return;
  for (const client of unseenTargets) checkpointNoticeShownClientIds.add(client.id);
  void vscode.window.showWarningMessage(notice.message);
}

function checkpointNoticeClientMatches(meta: WebviewClientMeta, conversationId: string): boolean {
  if (meta.kind !== 'mainPanel') return false;
  // 旧的默认对话标签页可能没有显式 conversationId；它仍属于当前对话标签页生命周期。
  return !meta.conversationId || meta.conversationId === conversationId;
}

function checkpointIssueNotice(input: CheckpointIssueInput): { message: string } | undefined {
  if (input.status === 'skipped' && input.skipReason === 'initial_size_exceeded') {
    return {
      message: `LimCode 存档点未创建：${input.message ?? '项目体积超过初始存档大小上限。'} 可在「设置 → 存档点」调高初始存档大小上限。`
    };
  }
  if (input.status === 'failed' && input.skipReason === 'git_unavailable') {
    return {
      message: `LimCode 存档点未创建：未检测到系统 Git。${input.message ?? ''}`.trim()
    };
  }
  if (input.status === 'failed') {
    return {
      message: `LimCode 存档点创建失败：${input.message ?? '未知错误'}`
    };
  }
  return undefined;
}
