import { SKILLS_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunModeLink } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { ConversationModeSelection, Mode } from '../mode/components';
import type { ToolSchemaContributor } from '../tools/schemaContributors';
import { SkillPolicy, SkillPolicyScopeLink } from './components';
import { isSkillEnabledByPolicy } from './policy';
import { activeSkillPolicyForRun } from './queries';
import { SkillCatalogKey } from './resources';

const SOURCE_LABEL: Record<string, string> = { local: '项目', global: '全局' };

/**
 * 动态把「当前 run 已启用的技能」注入 skills 工具描述，让 AI 感知可用技能。
 * 技能正文只在 AI 调用 skills({ name }) 时按需返回，避免污染 system prompt。
 */
export const skillsToolSchemaContributor: ToolSchemaContributor = {
  key: 'skillsCatalog',
  reads: {
    components: [Agent, AgentRun, AgentRunTargetLink, RunModeLink, Conversation, ConversationModeSelection, Mode, SkillPolicy, SkillPolicyScopeLink],
    resources: [SkillCatalogKey]
  },
  augment(tools, context) {
    if (!tools.some((tool) => tool.name === SKILLS_TOOL_NAME)) return tools;
    const catalog = context.world.tryGetResource(SkillCatalogKey) ?? [];
    const policy = activeSkillPolicyForRun(context.world, context.run);
    const enabled = catalog.filter((skill) => isSkillEnabledByPolicy(policy, skill));
    return tools.map((tool): ToolSchema => (tool.name === SKILLS_TOOL_NAME
      ? { ...tool, description: composeSkillsDescription(tool.description, enabled) }
      : tool));
  }
};

function composeSkillsDescription(baseDescription: string, skills: Array<{ name: string; description: string; source: string }>): string {
  if (skills.length === 0) {
    return `${baseDescription}\n\n当前没有可用技能。`;
  }
  const lines = skills.map((skill) => {
    const label = SOURCE_LABEL[skill.source] ?? skill.source;
    const detail = skill.description.trim();
    return `- ${skill.name}（${label}）${detail ? `：${detail}` : ''}`;
  });
  return `${baseDescription}\n\n可用技能（调用 skills({ name }) 载入对应正文）：\n${lines.join('\n')}`;
}
