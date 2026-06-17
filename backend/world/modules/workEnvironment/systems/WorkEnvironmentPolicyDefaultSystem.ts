import { defineSystem } from '../../../../ecs/types';
import { WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../components';
import { WorkEnvironmentBundle, upsertWorkEnvironmentPolicy, upsertWorkEnvironmentPolicyScopeLink, workEnvironmentPolicyIdForScope } from '../bundles';
import { workEnvironmentSortKey } from '../../../../../shared/workEnvironmentCatalog';

export const WorkEnvironmentPolicyDefaultSystem = defineSystem({
  name: 'WorkEnvironmentPolicyDefaultSystem',
  shouldRun({ world }) {
    const hasAvailable = world.query(WorkEnvironment).some((entity) => world.get(entity, WorkEnvironment)?.available === true);
    const hasGlobalPolicy = world.query(WorkEnvironmentPolicyScopeLink).some((entity) => {
      const link = world.get(entity, WorkEnvironmentPolicyScopeLink);
      return link?.scopeKind === 'global' && link.role === 'active';
    });
    return hasAvailable && !hasGlobalPolicy;
  },
  access: {
    reads: { components: [WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink] },
    bundles: [WorkEnvironmentBundle]
  },
  run({ world, cmd }) {
    const ids = world
      .query(WorkEnvironment)
      .map((entity) => world.get(entity, WorkEnvironment))
      .filter((item): item is NonNullable<typeof item> => !!item && item.available)
      .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
      .map((item) => item.id);
    if (ids.length === 0) return;
    const policy = upsertWorkEnvironmentPolicy(world, cmd, {
      id: workEnvironmentPolicyIdForScope('global'),
      name: '全局默认工作环境策略',
      allowedWorkEnvironmentIds: ids,
      defaultWorkEnvironmentId: ids[0]
    });
    upsertWorkEnvironmentPolicyScopeLink(world, cmd, { scopeKind: 'global', policy, data: {} });
  }
});
