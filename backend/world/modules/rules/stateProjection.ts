import type { ClientState, RuleFileRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { RulesCatalogKey } from './resources';

/** ClientState 投影只读取 RulesCatalog 资源，把规则文件同步给前端设置页。 */
export const rulesClientStateProjectionReads: AccessDeclaration = {
  resources: [RulesCatalogKey]
};

export function projectRulesClientState(world: WorldReader): Partial<ClientState> {
  const ruleFiles = (world.tryGetResource(RulesCatalogKey) ?? []).map((rule): RuleFileRecord => ({ ...rule }));
  return { ruleFiles };
}
