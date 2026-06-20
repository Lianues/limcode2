import { defineStore } from 'pinia';
import type {
  CheckpointGitStatusRecord,
  CheckpointPolicyRecord,
  CheckpointRecord,
  CheckpointPolicyScopeKind,
  CheckpointPolicyScopeLinkRecord,
  CheckpointPolicyScopeSetPayload,
  CheckpointRestoreResultPayload,
  ExtensionToWebviewMessage,
  CheckpointTriggerConfigRecord,
  ShadowCheckpointRestoreResult,
  ShadowRepositoryDiskStatRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

export interface CheckpointPolicyResolution {
  policy?: CheckpointPolicyRecord;
  link?: CheckpointPolicyScopeLinkRecord;
  inheritedFrom?: CheckpointPolicyScopeKind | 'fallback';
}

const DEFAULT_TRIGGERS: CheckpointTriggerConfigRecord = {
  conversationInitial: true,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  toolExecutionBefore: true,
  toolExecutionAfter: true,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: true,
  manual: true
};

const CHECKPOINT_RESTORE_TIMEOUT_MS = 120_000;


function scopeIdFor(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: CheckpointPolicyScopeLinkRecord, scopeKind: CheckpointPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: CheckpointPolicyScopeLinkRecord[]): CheckpointPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): string {
  return `checkpoint-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): string {
  return `checkpoint-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function defaultPolicy(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): CheckpointPolicyRecord {
  const now = Date.now();
  return {
    id: policyIdForScope(scopeKind, scopeId),
    name: scopeKind === 'global' ? '全局默认存档点策略' : '存档点策略',
    enabled: true,
    initialSnapshotMaxBytes: 50 * 1024 * 1024,
    preserveEmptyDirectories: true,
    useGitignore: true,
    skipPatterns: ['node_modules/', 'dist/', 'out/', 'build/'],
    triggers: { ...DEFAULT_TRIGGERS },
    createdAt: now,
    updatedAt: now
  };
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

export const useCheckpointPolicyStore = defineStore('checkpointPolicy', {
  state: () => ({
    gitStatus: undefined as CheckpointGitStatusRecord | undefined,
    gitStatusListening: false,
    shadowStats: [] as ShadowRepositoryDiskStatRecord[],
    shadowStatsListening: false,
    shadowStatsLoading: false,
    shadowStatsLoaded: false
  }),
  actions: {
    ensureGitStatusListener(): void {
      if (this.gitStatusListening) return;
      this.gitStatusListening = true;
      bridge.on(BridgeMessageType.CheckpointGitStatusSnapshot, (message: Extract<ExtensionToWebviewMessage, { type: BridgeMessageType.CheckpointGitStatusSnapshot }>) => {
        this.gitStatus = message.payload?.status;
      });
    },
    requestGitStatus(): void {
      this.ensureGitStatusListener();
      bridge.request(BridgeMessageType.CheckpointGitStatusGet);
    },
    ensureShadowStatsListener(): void {
      if (this.shadowStatsListening) return;
      this.shadowStatsListening = true;
      bridge.on(BridgeMessageType.CheckpointShadowStatsSnapshot, (message: Extract<ExtensionToWebviewMessage, { type: BridgeMessageType.CheckpointShadowStatsSnapshot }>) => {
        this.shadowStats = message.payload?.stats ?? [];
        this.shadowStatsLoading = false;
        this.shadowStatsLoaded = true;
      });
    },
    requestShadowStats(): void {
      this.ensureShadowStatsListener();
      this.shadowStatsLoading = true;
      bridge.request(BridgeMessageType.CheckpointShadowStatsGet);
    },
    ensureShadowStats(): void {
      if (this.shadowStatsLoaded || this.shadowStatsLoading) return;
      this.requestShadowStats();
    },
    deleteShadowRepositories(storageKeys: string[]): void {
      const keys = [...new Set(storageKeys.map((key) => key.trim()).filter((key) => key.length > 0))];
      if (keys.length === 0) return;
      this.ensureShadowStatsListener();
      this.shadowStatsLoading = true;
      bridge.request(BridgeMessageType.CheckpointShadowDelete, { storageKeys: keys });
    },
    dismissCheckpoint(checkpointId: string, conversationId: string): void {
      if (!checkpointId.trim() || !conversationId.trim()) return;
      bridge.request(BridgeMessageType.CheckpointDismiss, { checkpointId, conversationId });
    },
    restoreCheckpoint(checkpoint: CheckpointRecord): Promise<ShadowCheckpointRestoreResult> {
      const commitSha = checkpoint.commitSha;
      if (!commitSha) return Promise.resolve({ status: 'failed', message: '该存档点没有可回档的快照。' });
      const clientState = useClientStateStore();
      const repository = clientState.shadowRepositories.find((item) => item.id === checkpoint.shadowRepositoryId);
      if (!repository) return Promise.resolve({ status: 'failed', message: '未找到此存档点关联的 shadow 仓库。' });
      const policy = this.effectivePolicyFor('conversation', checkpoint.conversationId).policy ?? defaultPolicy('conversation', checkpoint.conversationId);
      return new Promise((resolve) => {
        let requestId = '';
        let unsubscribe: (() => void) | undefined;
        let timeoutId: number | undefined;

        const cleanup = (): void => {
          unsubscribe?.();
          unsubscribe = undefined;
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
            timeoutId = undefined;
          }
        };

        unsubscribe = bridge.on(BridgeMessageType.CheckpointRestoreResult, (message: Extract<ExtensionToWebviewMessage, { type: BridgeMessageType.CheckpointRestoreResult }>) => {
          if (message.correlationId !== requestId) return;
          cleanup();
          resolve((message.payload as CheckpointRestoreResultPayload | undefined)?.result ?? { status: 'failed', message: '回档失败：未收到结果。' });
        });

        timeoutId = window.setTimeout(() => {
          cleanup();
          resolve({ status: 'failed', message: '回档请求超时。' });
        }, CHECKPOINT_RESTORE_TIMEOUT_MS);

        requestId = bridge.request(BridgeMessageType.CheckpointRestore, {
          checkpointId: checkpoint.id,
          conversationId: checkpoint.conversationId,
          shadowRepositoryStorageKey: repository.storageKey,
          commitSha,
          projectUri: checkpoint.projectUri,
          policy
        });
      });
    },
    localPolicyFor(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): CheckpointPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.checkpointPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.checkpointPolicies.find((candidate) => candidate.id === link?.checkpointPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    effectivePolicyFor(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): CheckpointPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      if (local.policy) return local;
      if (scopeKind !== 'global') {
        const global = this.localPolicyFor('global');
        if (global.policy) return { ...global, inheritedFrom: 'global' };
      }
      return { policy: defaultPolicy(scopeKind, scopeId), inheritedFrom: 'fallback' };
    },
    setPolicyForScope(scopeKind: CheckpointPolicyScopeKind, scopeId: string | undefined, next: Partial<CheckpointPolicyRecord>): void {
      const resolution = this.effectivePolicyFor(scopeKind, scopeId);
      const base = resolution.policy ?? defaultPolicy(scopeKind, scopeId);
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const policy: CheckpointPolicyRecord = {
        ...base,
        ...next,
        id: resolution.link?.checkpointPolicyId ?? base.id,
        name: next.name?.trim() || base.name,
        triggers: { ...base.triggers, ...(next.triggers ?? {}) },
        skipPatterns: sanitizePatterns(next.skipPatterns ?? base.skipPatterns),
        initialSnapshotMaxBytes: Math.max(1, Math.floor(next.initialSnapshotMaxBytes ?? base.initialSnapshotMaxBytes)),
        updatedAt: Date.now()
      };
      this.applyOptimisticPolicyScopeSet(scopeKind, normalizedScopeId, policy);
      const payload: CheckpointPolicyScopeSetPayload = {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        name: policy.name,
        enabled: policy.enabled,
        initialSnapshotMaxBytes: policy.initialSnapshotMaxBytes,
        preserveEmptyDirectories: policy.preserveEmptyDirectories,
        useGitignore: policy.useGitignore,
        skipPatterns: policy.skipPatterns,
        triggers: policy.triggers
      };
      bridge.request(BridgeMessageType.CheckpointPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: CheckpointPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.checkpointPolicyScopeLinks = clientState.checkpointPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.CheckpointPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    applyOptimisticPolicyScopeSet(scopeKind: CheckpointPolicyScopeKind, scopeId: string | undefined, policy: CheckpointPolicyRecord): void {
      const clientState = useClientStateStore();
      const existingLink = latestLink(clientState.checkpointPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policyId = existingLink?.checkpointPolicyId ?? policyIdForScope(scopeKind, scopeId);
      const now = Date.now();
      upsertById(clientState.checkpointPolicies, { ...policy, id: policyId, createdAt: policy.createdAt ?? now, updatedAt: now });
      upsertById(clientState.checkpointPolicyScopeLinks, {
        id: existingLink?.id ?? linkIdForScope(scopeKind, scopeId),
        scopeKind,
        ...(scopeId ? { scopeId } : {}),
        checkpointPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      });
    }
  }
});

function sanitizePatterns(patterns: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.replace(/\r?\n/g, '');
    if (!pattern.trim() || result.includes(pattern)) continue;
    result.push(pattern);
  }
  return result;
}
