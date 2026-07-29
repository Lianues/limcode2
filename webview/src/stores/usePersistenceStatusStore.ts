import { defineStore } from 'pinia';
import type { PersistenceStatusRecord } from '@shared/protocol';

interface PersistenceStatusStoreState {
  status: PersistenceStatusRecord;
  hasSnapshot: boolean;
}

export const usePersistenceStatusStore = defineStore('persistenceStatus', {
  state: (): PersistenceStatusStoreState => ({
    status: {
      phase: 'pending',
      updatedAt: Date.now(),
      pendingSince: Date.now()
    },
    hasSnapshot: false
  }),
  actions: {
    applySnapshot(status: PersistenceStatusRecord): void {
      this.status = {
        phase: status.phase,
        updatedAt: status.updatedAt,
        ...(status.pendingSince !== undefined ? { pendingSince: status.pendingSince } : {}),
        ...(status.lastSavedAt !== undefined ? { lastSavedAt: status.lastSavedAt } : {}),
        ...(status.retryAttempt !== undefined ? { retryAttempt: status.retryAttempt } : {}),
        ...(status.nextRetryAt !== undefined ? { nextRetryAt: status.nextRetryAt } : {}),
        ...(status.error ? { error: status.error } : {})
      };
      this.hasSnapshot = true;
    }
  }
});
