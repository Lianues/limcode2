import * as vscode from 'vscode';
import type { CheckpointSkipReason, CheckpointStatus } from '../../../../shared/protocol';
import { CheckpointEventType } from '../../../world/modules/checkpoint/events';
import type { EffectHandlerRegistry } from '../registry';

/** 同一对话同一类问题在该时间窗口内只提醒一次，避免每条消息后重复弹窗。 */
const CHECKPOINT_NOTICE_INTERVAL_MS = 5 * 60 * 1000;
const lastCheckpointNoticeAt = new Map<string, number>();

export function registerCheckpointEffectHandlers(registry: EffectHandlerRegistry): void {
  registry.register('checkpoint.create', (effect, env, emit) => {
    env.storage
      .createShadowCheckpoint(effect)
      .then((record) => {
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
        maybeNotifyCheckpointIssue({ conversationId: record.conversationId, status: record.status, skipReason: record.skipReason, message: record.message });
      })
      .catch((error) => {
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
        maybeNotifyCheckpointIssue({ conversationId: effect.conversationId, status: 'failed', skipReason: 'io_error', message });
      });
  });
}

interface CheckpointIssueInput {
  conversationId: string;
  status: CheckpointStatus;
  skipReason?: CheckpointSkipReason;
  message?: string;
}

function maybeNotifyCheckpointIssue(input: CheckpointIssueInput): void {
  const notice = checkpointIssueNotice(input);
  if (!notice) return;
  const key = `${input.conversationId}:${notice.code}`;
  const now = Date.now();
  const last = lastCheckpointNoticeAt.get(key);
  if (last !== undefined && now - last < CHECKPOINT_NOTICE_INTERVAL_MS) return;
  lastCheckpointNoticeAt.set(key, now);
  void vscode.window.showWarningMessage(notice.message);
}

function checkpointIssueNotice(input: CheckpointIssueInput): { code: string; message: string } | undefined {
  if (input.status === 'skipped' && input.skipReason === 'initial_size_exceeded') {
    return {
      code: 'initial_size_exceeded',
      message: `LimCode 存档点未创建：${input.message ?? '项目体积超过初始存档大小上限。'} 可在「设置 → 存档点」调高初始存档大小上限。`
    };
  }
  if (input.status === 'failed' && input.skipReason === 'git_unavailable') {
    return {
      code: 'git_unavailable',
      message: `LimCode 存档点未创建：未检测到系统 Git。${input.message ?? ''}`.trim()
    };
  }
  if (input.status === 'failed') {
    return {
      code: 'io_error',
      message: `LimCode 存档点创建失败：${input.message ?? '未知错误'}`
    };
  }
  return undefined;
}
