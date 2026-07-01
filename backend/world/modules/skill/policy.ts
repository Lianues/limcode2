import type { SkillDefinitionRecord, SkillPolicyRecord } from '../../../../shared/protocol';

/**
 * 技能默认全部启用（opt-out）。
 * 仅当来源分组显式关闭（enabled=false），或该技能被列入 disabledSkills 时才停用。
 */
export function isSkillEnabledByPolicy(
  policy: Pick<SkillPolicyRecord, 'sourceConfigs'> | undefined,
  skill: Pick<SkillDefinitionRecord, 'id' | 'source'>
): boolean {
  const config = policy?.sourceConfigs?.[skill.source];
  if (!config) return true;
  if (config.enabled === false) return false;
  return !(config.disabledSkills ?? []).includes(skill.id);
}
