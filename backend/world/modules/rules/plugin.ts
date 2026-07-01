import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { rulesClientSyncContributor } from './clientSync';
import { RulesCatalogKey } from './resources';

/**
 * 规则模块：仅持有磁盘扫描的规则目录资源，并把它投影给前端设置页。
 * 无 ECS 组件/系统/事件；规则不落 record-store，因此不注册 storage contributor。
 * 规则正文的提示词注入发生在 RuntimeContextSnapshotSystem 冻结快照时。
 */
export function rulesPlugin(): WorldPlugin {
  return {
    name: 'rules',
    install(ctx) {
      ctx.world.setResource(RulesCatalogKey, []);
      ctx.world.getResource(ClientStateContributorsKey).register(rulesClientSyncContributor);
    }
  };
}
