import { defineStore } from 'pinia';
import {
  createMessageId,
  type ConversationWorkEnvironmentLinkRecord,
  type WorkEnvironmentPolicyRecord,
  type WorkEnvironmentPolicyScopeKind,
  type WorkEnvironmentPolicyScopeLinkRecord,
  type WorkEnvironmentPolicyScopeSetPayload,
  type WorkEnvironmentRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { GLOBAL_MODE_OPTION_ID, useModeStore } from './useModeStore';

export interface WorkEnvironmentPolicyResolution {
  policy?: WorkEnvironmentPolicyRecord;
  link?: WorkEnvironmentPolicyScopeLinkRecord;
  inheritedFrom?: WorkEnvironmentPolicyScopeKind | 'mode' | 'fallback';
}

function scopeIdFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string | undefined {
  return scopeKind === 'global' ? undefined : scopeId?.trim();
}

function scopeLinkMatches(link: WorkEnvironmentPolicyScopeLinkRecord, scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): boolean {
  return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId);
}

function latestLink(links: WorkEnvironmentPolicyScopeLinkRecord[]): WorkEnvironmentPolicyScopeLinkRecord | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function policyIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function linkIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy-scope:${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

function defaultPolicyName(scopeKind: WorkEnvironmentPolicyScopeKind): string {
  switch (scopeKind) {
    case 'global': return '全局默认工作环境策略';
    case 'conversation': return '对话工作环境策略';
    case 'agent': return 'Agent 工作环境策略';
    case 'agentSystem': return '多 Agent 系统工作环境策略';
    case 'mode': return '模式工作环境策略';
    case 'run': return '运行工作环境策略';
  }
}

function upsertById<T extends { id: string }>(list: T[], record: T): void {
  const index = list.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) list[index] = record;
  else list.push(record);
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  const kind = environment.kind === 'localFolder' ? '0' : '1';
  const index = environment.index === undefined ? '999999' : String(environment.index).padStart(6, '0');
  return `${kind}:${index}:${environment.name}`;
}

function uniqueAllowed(ids: readonly string[]): string[] {
  const result: string[] = [];
  for (const id of ids) {
    const text = id.trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function availableEnvironmentIds(): string[] {
  const clientState = useClientStateStore();
  return sortedWorkEnvironments(clientState.workEnvironments.filter((environment) => environment.available)).map((environment) => environment.id);
}

function sortedWorkEnvironments(items: WorkEnvironmentRecord[]): WorkEnvironmentRecord[] {
  return [...items].sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id));
}

function fallbackPolicy(): WorkEnvironmentPolicyRecord | undefined {
  const ids = availableEnvironmentIds();
  if (ids.length === 0) return undefined;
  const now = Date.now();
  return { id: 'work-environment-policy:fallback', name: '默认工作环境策略', allowedWorkEnvironmentIds: ids, defaultWorkEnvironmentId: ids[0], createdAt: now, updatedAt: now };
}

function sanitizePolicyInput(allowedIds: string[], defaultId?: string): { allowed: string[]; defaultId?: string } {
  const available = new Set(availableEnvironmentIds());
  const allowed = uniqueAllowed(allowedIds).filter((id) => available.has(id));
  const resolvedDefault = defaultId && allowed.includes(defaultId) ? defaultId : allowed[0];
  return { allowed, ...(resolvedDefault ? { defaultId: resolvedDefault } : {}) };
}

export const useWorkEnvironmentStore = defineStore('workEnvironment', {
  state: () => ({ status: '' }),
  getters: {
    environments(): WorkEnvironmentRecord[] {
      const clientState = useClientStateStore();
      return sortedWorkEnvironments(clientState.workEnvironments);
    },
    availableEnvironments(): WorkEnvironmentRecord[] {
      return this.environments.filter((environment) => environment.available);
    },
    remoteServerEnvironments(): WorkEnvironmentRecord[] {
      return this.environments.filter((environment) => environment.kind === 'remoteServer');
    }
  },
  actions: {
    localPolicyFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): WorkEnvironmentPolicyResolution {
      const clientState = useClientStateStore();
      const link = latestLink(clientState.workEnvironmentPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, scopeId)));
      const policy = clientState.workEnvironmentPolicies.find((candidate) => candidate.id === link?.workEnvironmentPolicyId);
      return { ...(policy ? { policy } : {}), ...(link ? { link } : {}) };
    },
    effectivePolicyFor(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): WorkEnvironmentPolicyResolution {
      const local = this.localPolicyFor(scopeKind, scopeId);
      if (local.policy) return local;
      if (scopeKind !== 'global') {
        const global = this.localPolicyFor('global');
        if (global.policy) return { ...global, inheritedFrom: 'global' };
      }
      const fallback = fallbackPolicy();
      return fallback ? { policy: fallback, inheritedFrom: 'fallback' } : {};
    },
    effectivePolicyForConversation(conversationId: string): WorkEnvironmentPolicyResolution {
      if (!conversationId) return this.effectivePolicyFor('global');
      const modeStore = useModeStore();
      const activeModeId = modeStore.activeModeIdForConversation(conversationId);
      if (activeModeId && activeModeId !== GLOBAL_MODE_OPTION_ID) {
        const modePolicy = this.localPolicyFor('mode', activeModeId);
        if (modePolicy.policy) return { ...modePolicy, inheritedFrom: 'mode' };
      }
      const local = this.localPolicyFor('conversation', conversationId);
      if (local.policy) return local;
      const global = this.localPolicyFor('global');
      if (global.policy) return { ...global, inheritedFrom: 'global' };
      const fallback = fallbackPolicy();
      return fallback ? { policy: fallback, inheritedFrom: 'fallback' } : {};
    },
    allowedEnvironmentsForConversation(conversationId: string): WorkEnvironmentRecord[] {
      const policy = this.effectivePolicyForConversation(conversationId).policy;
      const allowedIds = policy?.allowedWorkEnvironmentIds;
      if (!allowedIds || allowedIds.length === 0) return this.availableEnvironments;
      const allowed = new Set(allowedIds);
      return this.availableEnvironments.filter((environment) => allowed.has(environment.id));
    },
    activeEnvironmentForConversation(conversationId: string): WorkEnvironmentRecord | undefined {
      const clientState = useClientStateStore();
      const allowed = this.allowedEnvironmentsForConversation(conversationId);
      const allowedIds = new Set(allowed.map((environment) => environment.id));
      const link = clientState.conversationWorkEnvironmentLinks.find((candidate) => candidate.conversationId === conversationId && candidate.role === 'active');
      const linked = allowed.find((environment) => environment.id === link?.workEnvironmentId);
      if (linked) return linked;
      const policy = this.effectivePolicyForConversation(conversationId).policy;
      return allowed.find((environment) => environment.id === policy?.defaultWorkEnvironmentId) ?? allowed[0];
    },
    selectConversationEnvironment(conversationId: string, workEnvironmentId: string): void {
      if (!conversationId || !workEnvironmentId) return;
      const allowed = new Set(this.allowedEnvironmentsForConversation(conversationId).map((environment) => environment.id));
      if (!allowed.has(workEnvironmentId)) return;
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = clientState.conversationWorkEnvironmentLinks.find((link) => link.conversationId === conversationId && link.role === 'active');
      const link: ConversationWorkEnvironmentLinkRecord = {
        id: existing?.id ?? `cwel-local-${createMessageId()}`,
        conversationId,
        workEnvironmentId,
        role: 'active',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      clientState.conversationWorkEnvironmentLinks = clientState.conversationWorkEnvironmentLinks.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active'));
      upsertById(clientState.conversationWorkEnvironmentLinks, link);
      bridge.request(BridgeMessageType.WorkEnvironmentSelect, { conversationId, workEnvironmentId });
    },
    setPolicyForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined, allowedIds: string[], defaultId?: string, name?: string): void {
      const sanitized = sanitizePolicyInput(allowedIds, defaultId);
      this.applyOptimisticPolicyScopeSet(scopeKind, scopeId, sanitized.allowed, sanitized.defaultId, name);
      const payload: WorkEnvironmentPolicyScopeSetPayload = {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}),
        ...(name?.trim() ? { name: name.trim() } : {}),
        allowedWorkEnvironmentIds: sanitized.allowed,
        ...(sanitized.defaultId ? { defaultWorkEnvironmentId: sanitized.defaultId } : {})
      };
      bridge.request(BridgeMessageType.WorkEnvironmentPolicyScopeSet, payload);
    },
    clearPolicyScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.workEnvironmentPolicyScopeLinks = clientState.workEnvironmentPolicyScopeLinks.filter((link) => !scopeLinkMatches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.WorkEnvironmentPolicyScopeClear, {
        scopeKind,
        ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {})
      });
    },
    applyOptimisticPolicyScopeSet(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined, allowedIds: string[], defaultId?: string, name?: string): void {
      const clientState = useClientStateStore();
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const existingLink = latestLink(clientState.workEnvironmentPolicyScopeLinks.filter((candidate) => scopeLinkMatches(candidate, scopeKind, normalizedScopeId)));
      const existingPolicy = clientState.workEnvironmentPolicies.find((policy) => policy.id === existingLink?.workEnvironmentPolicyId);
      const policyId = existingLink?.workEnvironmentPolicyId ?? policyIdForScope(scopeKind, normalizedScopeId);
      const now = Date.now();
      const policy: WorkEnvironmentPolicyRecord = {
        id: policyId,
        name: name?.trim() || existingPolicy?.name || defaultPolicyName(scopeKind),
        allowedWorkEnvironmentIds: allowedIds,
        ...(defaultId ? { defaultWorkEnvironmentId: defaultId } : {}),
        createdAt: existingPolicy?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.workEnvironmentPolicies, policy);
      const link: WorkEnvironmentPolicyScopeLinkRecord = {
        id: existingLink?.id ?? linkIdForScope(scopeKind, normalizedScopeId),
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        workEnvironmentPolicyId: policyId,
        role: 'active',
        createdAt: existingLink?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.workEnvironmentPolicyScopeLinks, link);
    },
    upsertRemoteServerEnvironment(patch: Partial<WorkEnvironmentRecord> & { id?: string; host?: string; name?: string }): string {
      const clientState = useClientStateStore();
      const now = Date.now();
      const existing = patch.id ? clientState.workEnvironments.find((item) => item.id === patch.id) : undefined;
      const host = (patch.host ?? patch.name ?? existing?.host ?? existing?.name ?? 'server').trim() || 'server';
      const id = existing?.id ?? patch.id ?? `work-env-remote-${createMessageId()}`;
      const hasField = (key: keyof WorkEnvironmentRecord): boolean => Object.prototype.hasOwnProperty.call(patch, key);
      const stringField = (key: keyof WorkEnvironmentRecord): string | undefined => {
        const value = hasField(key) ? patch[key] : existing?.[key];
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
      };
      const port = hasField('port') ? normalizePort(patch.port) : normalizePort(existing?.port);
      const user = stringField('user');
      const identityFile = stringField('identityFile');
      const password = identityFile ? undefined : hasField('password') ? patch.password : existing?.password;
      const workdir = stringField('workdir');
      const os = stringField('os');
      const description = stringField('description');
      const displayPath = `${user ? `${user}@` : ''}${host}${port !== undefined && port !== 22 ? `:${port}` : ''}${workdir ? ` ${workdir}` : ''}`;
      const record: WorkEnvironmentRecord = {
        id,
        kind: 'remoteServer',
        source: patch.source ?? existing?.source ?? 'manual',
        name: (patch.name ?? existing?.name ?? host).trim() || host,
        host,
        ...(port !== undefined ? { port } : {}),
        ...(user ? { user } : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(typeof password === 'string' ? { password } : {}),
        ...(workdir ? { workdir } : {}),
        ...(os ? { os } : {}),
        ...(description ? { description } : {}),
        ...(displayPath ? { displayPath } : {}),
        available: patch.available ?? existing?.available ?? true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      upsertById(clientState.workEnvironments, record);
      this.ensureEnvironmentAllowedInGlobal(record.id);
      bridge.request(BridgeMessageType.WorkEnvironmentUpsert, { workEnvironment: record });
      return record.id;
    },
    removeEnvironment(workEnvironmentId: string): void {
      const clientState = useClientStateStore();
      const environment = clientState.workEnvironments.find((candidate) => candidate.id === workEnvironmentId);
      if (!environment || environment.kind === 'localFolder') return;
      clientState.workEnvironments = clientState.workEnvironments.filter((candidate) => candidate.id !== workEnvironmentId);
      clientState.conversationWorkEnvironmentLinks = clientState.conversationWorkEnvironmentLinks.filter((link) => link.workEnvironmentId !== workEnvironmentId);
      clientState.runWorkEnvironmentLinks = clientState.runWorkEnvironmentLinks.filter((link) => link.workEnvironmentId !== workEnvironmentId);
      for (const policy of clientState.workEnvironmentPolicies) {
        policy.allowedWorkEnvironmentIds = policy.allowedWorkEnvironmentIds.filter((id) => id !== workEnvironmentId);
        if (policy.defaultWorkEnvironmentId === workEnvironmentId) policy.defaultWorkEnvironmentId = policy.allowedWorkEnvironmentIds[0];
      }
      bridge.request(BridgeMessageType.WorkEnvironmentRemove, { workEnvironmentId });
    },
    importFromVscode(): void {
      this.status = '正在从 VS Code SSH 配置导入工作环境...';
      bridge.request(BridgeMessageType.WorkEnvironmentImportFromVscode, { includeDefaultSshConfig: true });
    },
    ensureEnvironmentAllowedInGlobal(workEnvironmentId: string): void {
      const global = this.effectivePolicyFor('global').policy;
      const allowed = uniqueAllowed([...(global?.allowedWorkEnvironmentIds ?? availableEnvironmentIds()), workEnvironmentId]);
      const defaultId = global?.defaultWorkEnvironmentId && allowed.includes(global.defaultWorkEnvironmentId) ? global.defaultWorkEnvironmentId : allowed[0];
      this.applyOptimisticPolicyScopeSet('global', undefined, allowed, defaultId, global?.name);
    }
  }
});

function normalizePort(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : undefined;
  return number !== undefined && Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
