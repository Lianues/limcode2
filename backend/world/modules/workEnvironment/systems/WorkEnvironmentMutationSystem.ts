import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { WorkEnvironmentEventType } from '../events';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../components';
import {
  WorkEnvironmentBundle,
  findActivePolicyScopeLink,
  findWorkEnvironmentById,
  upsertWorkEnvironment,
  upsertWorkEnvironmentPolicy,
  upsertWorkEnvironmentPolicyScopeLink,
  workEnvironmentPolicyIdForScope
} from '../bundles';
import { canRemoveWorkEnvironment, workEnvironmentSortKey } from '../../../../../shared/workEnvironmentCatalog';

export const WorkEnvironmentMutationSystem = defineSystem({
  name: 'WorkEnvironmentMutationSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkEnvironmentEventType.UpsertRequested).length > 0
      || readEvents(ctx, WorkEnvironmentEventType.RemoveRequested).length > 0
      || readEvents(ctx, WorkEnvironmentEventType.ImportFromVscodeRequested).length > 0;
  },
  access: {
    reads: { components: [WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, RunWorkEnvironmentLink] },
    bundles: [WorkEnvironmentBundle],
    events: { read: [WorkEnvironmentEventType.UpsertRequested, WorkEnvironmentEventType.RemoveRequested, WorkEnvironmentEventType.ImportFromVscodeRequested] }
  },
  run(ctx) {
    const { world, cmd } = ctx;

    for (const payload of readEvents(ctx, WorkEnvironmentEventType.UpsertRequested)) {
      const entity = upsertWorkEnvironment(world, cmd, payload.workEnvironment);
      const id = payload.workEnvironment.id;
      ensureGlobalPolicyIncludes(world, cmd, [id]);
      void entity;
    }

    for (const payload of readEvents(ctx, WorkEnvironmentEventType.ImportFromVscodeRequested)) {
      const ids: string[] = [];
      for (const record of payload.records) {
        upsertWorkEnvironment(world, cmd, record);
        ids.push(record.id);
      }
      ensureGlobalPolicyIncludes(world, cmd, ids);
    }

    for (const payload of readEvents(ctx, WorkEnvironmentEventType.RemoveRequested)) {
      removeWorkEnvironment(world, cmd, payload.workEnvironmentId);
    }
  }
});

function ensureGlobalPolicyIncludes(world: WorldReader, cmd: CommandSink, ids: readonly string[]): void {
  const additions = ids.map((id) => id.trim()).filter(Boolean);
  if (additions.length === 0) return;
  const global = findActivePolicyScopeLink(world, 'global', undefined);
  const currentPolicy = global ? world.get(global.link.policy, WorkEnvironmentPolicy) : undefined;
  const allowed = unique([...(currentPolicy?.allowedWorkEnvironmentIds ?? availableEnvironmentIds(world)), ...additions]);
  const defaultId = currentPolicy?.defaultWorkEnvironmentId && allowed.includes(currentPolicy.defaultWorkEnvironmentId)
    ? currentPolicy.defaultWorkEnvironmentId
    : allowed[0];
  const policy = upsertWorkEnvironmentPolicy(world, cmd, {
    id: currentPolicy?.id ?? workEnvironmentPolicyIdForScope('global'),
    name: currentPolicy?.name ?? '全局默认工作环境策略',
    allowedWorkEnvironmentIds: allowed,
    defaultWorkEnvironmentId: defaultId
  });
  upsertWorkEnvironmentPolicyScopeLink(world, cmd, { scopeKind: 'global', policy, data: {} });
}

function removeWorkEnvironment(world: WorldReader, cmd: CommandSink, workEnvironmentId: string): void {
  const target = findWorkEnvironmentById(world, workEnvironmentId);
  if (target === undefined) return;
  const current = world.get(target, WorkEnvironment);
  if (!current || !canRemoveWorkEnvironment(current)) return;

  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const link = world.get(entity, ConversationWorkEnvironmentLink);
    if (link?.workEnvironment === target) cmd.despawn(entity);
  }
  for (const entity of world.query(RunWorkEnvironmentLink)) {
    const link = world.get(entity, RunWorkEnvironmentLink);
    if (link?.workEnvironment === target) cmd.despawn(entity);
  }

  for (const policyEntity of world.query(WorkEnvironmentPolicy)) {
    const policy = world.get(policyEntity, WorkEnvironmentPolicy);
    if (!policy) continue;
    const allowed = policy.allowedWorkEnvironmentIds.filter((id) => id !== workEnvironmentId);
    const defaultWorkEnvironmentId = policy.defaultWorkEnvironmentId === workEnvironmentId ? allowed[0] : policy.defaultWorkEnvironmentId;
    if (allowed.length === policy.allowedWorkEnvironmentIds.length && defaultWorkEnvironmentId === policy.defaultWorkEnvironmentId) continue;
    const { defaultWorkEnvironmentId: _previousDefault, ...basePolicy } = policy;
    cmd.add(policyEntity, WorkEnvironmentPolicy, {
      ...basePolicy,
      allowedWorkEnvironmentIds: allowed,
      ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {}),
      updatedAt: Date.now()
    });
  }

  cmd.despawn(target);
}

function availableEnvironmentIds(world: WorldReader): string[] {
  return world
    .query(WorkEnvironment)
    .map((entity) => world.get(entity, WorkEnvironment))
    .filter((item): item is NonNullable<typeof item> => !!item && item.available)
    .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
    .map((item) => item.id);
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}
