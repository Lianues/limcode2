import { defineSystem, type CommandSink, type WorldReader } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { WorkEnvironmentEventType } from '../events';
import { WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import {
  WorkEnvironmentBundle,
  findActivePolicyScopeLink,
  markMissingLocalWorkEnvironmentsUnavailable,
  upsertLocalWorkEnvironment,
  upsertWorkEnvironmentPolicy,
  upsertWorkEnvironmentPolicyScopeLink,
  workEnvironmentPolicyIdForScope
} from '../bundles';

export const WorkEnvironmentSyncSystem = defineSystem({
  name: 'WorkEnvironmentSyncSystem',
  shouldRun(ctx) {
    return readEvents(ctx, WorkEnvironmentEventType.WorkspaceFoldersSynced).length > 0;
  },
  access: {
    reads: { components: [WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink] },
    bundles: [WorkEnvironmentBundle],
    events: { read: [WorkEnvironmentEventType.WorkspaceFoldersSynced] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, WorkEnvironmentEventType.WorkspaceFoldersSynced)) {
      const activeIds = new Set<string>();
      for (const folder of payload.folders) {
        activeIds.add(folder.id);
        upsertLocalWorkEnvironment(world, cmd, folder);
      }
      markMissingLocalWorkEnvironmentsUnavailable(world, cmd, activeIds);
      ensureGlobalPolicyIncludes(world, cmd, [...activeIds]);
    }
  }
});

function ensureGlobalPolicyIncludes(world: WorldReader, cmd: CommandSink, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const global = findActivePolicyScopeLink(world, 'global', undefined);
  const currentPolicy = global ? world.get(global.link.policy, WorkEnvironmentPolicy) : undefined;
  const allowed = unique([...(currentPolicy?.allowedWorkEnvironmentIds ?? availableEnvironmentIds(world)), ...ids]);
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

function availableEnvironmentIds(world: WorldReader): string[] {
  return world
    .query(WorkEnvironment)
    .map((entity) => world.get(entity, WorkEnvironment))
    .filter((item): item is NonNullable<typeof item> => !!item && item.available)
    .sort((left, right) => (left.index ?? 999999) - (right.index ?? 999999) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
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
