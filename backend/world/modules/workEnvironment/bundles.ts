import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  type WorkEnvironmentData,
  type WorkEnvironmentPolicyData,
  type WorkEnvironmentPolicyScopeLinkData
} from './components';
import type { LocalWorkEnvironmentCandidate } from './events';
import type { WorkEnvironmentPolicyScopeKind, WorkEnvironmentRecord } from '../../../../shared/protocol';
import {
  createLocalFolderWorkEnvironmentRecord,
  finiteTimestamp,
  getWorkEnvironmentKindDefinition,
  isLocalFolderWorkEnvironment,
  isRemoteServerWorkEnvironmentKind,
  normalizePort,
  normalizeString,
  normalizeWorkEnvironmentKind,
  workEnvironmentDisplayPath,
  remoteWorkEnvironmentIdFromHost as sharedRemoteWorkEnvironmentIdFromHost,
  uniqueStrings,
  workEnvironmentIdForKind,
  workEnvironmentIdFromUri as sharedWorkEnvironmentIdFromUri
} from '../../../../shared/workEnvironmentCatalog';

export const WorkEnvironmentBundle = defineBundle({
  name: 'WorkEnvironmentBundle',
  writes: [WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, RunWorkEnvironmentLink],
  mutationMode: 'update',
  spawns: true,
  despawns: true
});

export function upsertLocalWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  candidate: LocalWorkEnvironmentCandidate
): Entity {
  return upsertWorkEnvironment(world, cmd, createLocalFolderWorkEnvironmentRecord(candidate));
}

export function upsertWorkEnvironment(world: WorldReader, cmd: CommandSink, record: WorkEnvironmentRecord): Entity {
  const now = Date.now();
  const existing = findWorkEnvironmentById(world, record.id);
  const previous = existing !== undefined ? world.get(existing, WorkEnvironment) : undefined;
  const next = normalizeWorkEnvironmentRecord(record, previous, now);

  if (existing !== undefined) {
    cmd.add(existing, WorkEnvironment, next);
    return existing;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironment, next);
  return entity;
}

export function markMissingLocalWorkEnvironmentsUnavailable(
  world: WorldReader,
  cmd: CommandSink,
  activeIds: ReadonlySet<string>
): void {
  const now = Date.now();
  for (const entity of world.query(WorkEnvironment)) {
    const current = world.get(entity, WorkEnvironment);
    if (!current || !isLocalFolderWorkEnvironment(current) || activeIds.has(current.id) || !current.available) continue;
    const { index: _index, ...withoutIndex } = current;
    cmd.add(entity, WorkEnvironment, { ...withoutIndex, available: false, updatedAt: now });
  }
}

export function selectConversationWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  workEnvironment: Entity
): Entity | undefined {
  if (!world.has(workEnvironment, WorkEnvironment)) return undefined;

  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const link = world.get(entity, ConversationWorkEnvironmentLink);
    if (!link || link.conversation !== conversation || link.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else cmd.despawn(entity);
  }

  if (selected !== undefined) {
    const current = world.get(selected, ConversationWorkEnvironmentLink)!;
    cmd.add(selected, ConversationWorkEnvironmentLink, {
      ...current,
      workEnvironment,
      updatedAt: now
    });
    return selected;
  }

  const entity = cmd.spawn();
  cmd.add(entity, ConversationWorkEnvironmentLink, {
    id: `cwel${entity}`,
    conversation,
    workEnvironment,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function selectRunWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  workEnvironment: Entity
): Entity | undefined {
  if (!world.has(workEnvironment, WorkEnvironment)) return undefined;

  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(RunWorkEnvironmentLink)) {
    const link = world.get(entity, RunWorkEnvironmentLink);
    if (!link || link.run !== run || link.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else cmd.despawn(entity);
  }

  if (selected !== undefined) {
    const current = world.get(selected, RunWorkEnvironmentLink)!;
    cmd.add(selected, RunWorkEnvironmentLink, {
      ...current,
      workEnvironment,
      updatedAt: now
    });
    return selected;
  }

  const entity = cmd.spawn();
  cmd.add(entity, RunWorkEnvironmentLink, {
    id: `rwel${entity}`,
    run,
    workEnvironment,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function upsertWorkEnvironmentPolicy(
  world: WorldReader,
  cmd: CommandSink,
  input: { id: string; name: string; allowedWorkEnvironmentIds: string[]; defaultWorkEnvironmentId?: string }
): Entity {
  const now = Date.now();
  const existing = findWorkEnvironmentPolicyById(world, input.id);
  const previous = existing !== undefined ? world.get(existing, WorkEnvironmentPolicy) : undefined;
  const allowedWorkEnvironmentIds = normalizeAllowedWorkEnvironmentIds(world, input.allowedWorkEnvironmentIds);
  const defaultWorkEnvironmentId = input.defaultWorkEnvironmentId && allowedWorkEnvironmentIds.includes(input.defaultWorkEnvironmentId)
    ? input.defaultWorkEnvironmentId
    : allowedWorkEnvironmentIds[0];
  const policy: WorkEnvironmentPolicyData = {
    id: input.id,
    name: input.name.trim() || '工作环境策略',
    allowedWorkEnvironmentIds,
    ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };

  if (existing !== undefined) {
    cmd.add(existing, WorkEnvironmentPolicy, policy);
    return existing;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironmentPolicy, policy);
  return entity;
}

export function upsertWorkEnvironmentPolicyScopeLink(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    scopeKind: WorkEnvironmentPolicyScopeKind;
    scopeId?: string;
    policy: Entity;
    data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }>;
  }
): Entity {
  const now = Date.now();
  const existing = findActivePolicyScopeLink(world, input.scopeKind, input.scopeId);
  if (existing) {
    cmd.add(existing.entity, WorkEnvironmentPolicyScopeLink, {
      ...existing.link,
      policy: input.policy,
      ...input.data,
      updatedAt: now
    });
    return existing.entity;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironmentPolicyScopeLink, {
    id: workEnvironmentPolicyScopeLinkId(input.scopeKind, input.scopeId),
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    policy: input.policy,
    ...input.data,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function findWorkEnvironmentById(world: WorldReader, id: string): Entity | undefined {
  return world.query(WorkEnvironment).find((entity) => world.get(entity, WorkEnvironment)?.id === id);
}

export function findWorkEnvironmentPolicyById(world: WorldReader, id: string): Entity | undefined {
  return world.query(WorkEnvironmentPolicy).find((entity) => world.get(entity, WorkEnvironmentPolicy)?.id === id);
}

export function findActivePolicyScopeLink(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined): { entity: Entity; link: WorkEnvironmentPolicyScopeLinkData } | undefined {
  const normalized = scopeKind === 'global' ? undefined : scopeId?.trim();
  const matches = world.query(WorkEnvironmentPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, WorkEnvironmentPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: WorkEnvironmentPolicyScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : item.link.scopeId === normalized))
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity);
  return matches[0];
}

export function workEnvironmentIdFromUri(uri: string): string {
  return sharedWorkEnvironmentIdFromUri(uri);
}

export function remoteWorkEnvironmentIdFromHost(host: string): string {
  return sharedRemoteWorkEnvironmentIdFromHost(host);
}

export function workEnvironmentPolicyIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy:${scopeKind}:${scopeKind === 'global' ? 'global' : scopeId ?? 'unknown'}`;
}

export function workEnvironmentPolicyScopeLinkId(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy-scope:${scopeKind}:${scopeKind === 'global' ? 'global' : scopeId ?? 'unknown'}`;
}

export function normalizeAllowedWorkEnvironmentIds(world: WorldReader, ids: readonly string[]): string[] {
  void world;
  return uniqueStrings(ids);
}

function normalizeWorkEnvironmentRecord(record: WorkEnvironmentRecord, previous: WorkEnvironmentData | undefined, now: number): WorkEnvironmentData {
  const kind = normalizeWorkEnvironmentKind(record.kind, previous?.kind);
  const definition = getWorkEnvironmentKindDefinition(kind);
  const isRemoteServer = isRemoteServerWorkEnvironmentKind(kind);
  const name = normalizeString(record.name)
    ?? (isRemoteServer ? normalizeString(record.host) : undefined)
    ?? previous?.name
    ?? definition.defaultName;
  const host = normalizeString(record.host) ?? (isRemoteServer ? previous?.host ?? normalizeString(record.name) : undefined);
  const user = normalizeString(record.user);
  const port = normalizePort(record.port);
  const identityFile = normalizeString(record.identityFile);
  const password = identityFile ? undefined : typeof record.password === 'string' ? record.password : undefined;
  const workdir = normalizeString(record.workdir);
  const uri = normalizeString(record.uri);
  const rootPath = normalizeString(record.rootPath);
  const displayPath = normalizeString(record.displayPath)
    ?? workEnvironmentDisplayPath({
      id: previous?.id ?? '',
      kind,
      name,
      ...(uri ? { uri } : {}),
      ...(rootPath ? { rootPath } : {}),
      ...(host ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(user ? { user } : {}),
      ...(workdir ? { workdir } : {})
    })
    ?? previous?.displayPath;
  const source = record.source
    ?? previous?.source
    ?? (isRemoteServer ? 'manual' as const : isLocalFolderWorkEnvironment({ kind }) ? 'workspaceFolder' as const : undefined);
  const capabilities = uniqueStrings(record.capabilities ?? previous?.capabilities ?? []);
  const metadata = normalizeMetadata(record.metadata) ?? normalizeMetadata(previous?.metadata);
  const id = normalizeString(record.id)
    ?? previous?.id
    ?? (isRemoteServer && host ? sharedRemoteWorkEnvironmentIdFromHost(host) : workEnvironmentIdForKind(kind, `${name}:${displayPath ?? now}`));

  return {
    id,
    kind,
    name,
    ...(uri ? { uri } : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(displayPath ? { displayPath } : {}),
    ...(source ? { source } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(metadata ? { metadata } : {}),
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(workdir ? { workdir } : {}),
    ...(normalizeString(record.os) ? { os: normalizeString(record.os) } : {}),
    ...(normalizeString(record.description) ? { description: normalizeString(record.description) } : {}),
    ...(record.index !== undefined ? { index: record.index } : previous?.index !== undefined ? { index: previous.index } : {}),
    available: record.available !== undefined ? record.available !== false : previous?.available ?? true,
    createdAt: previous?.createdAt ?? finiteTimestamp(record.createdAt, now),
    updatedAt: now
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}
