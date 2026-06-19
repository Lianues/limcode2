import { CheckpointEventType } from '../../../world/modules/checkpoint/events';
import type { EffectHandlerRegistry } from '../registry';

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
            ...(record.emptyDirectoryCount !== undefined ? { emptyDirectoryCount: record.emptyDirectoryCount } : {})
          }
        });
      })
      .catch((error) => {
        const now = Date.now();
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
            message: error instanceof Error ? error.message : String(error)
          }
        });
      });
  });
}
