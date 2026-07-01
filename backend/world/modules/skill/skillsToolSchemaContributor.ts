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

const SOURCE_DISPLAY: Record<string, string> = { agents: '.agents', claude: '.claude', global: 'global' };

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

function composeSkillsDescription(baseDescription: string, skills: Array<{ name: string; slug: string; description: string; source: string }>): string {
  if (skills.length === 0) {
    return `${baseDescription}\n\nAvailable skills: none.`;
  }
  const lines = skills.map((skill) => {
    const source = SOURCE_DISPLAY[skill.source] ?? skill.source;
    const description = skill.description.trim();
    return [
      `- name: ${skill.slug}`,
      `  source: ${source}`,
      `  description: ${yamlScalar(description)}`
    ].join('\n');
  });
  return `${baseDescription}\n\nAvailable skills (YAML):\n${lines.join('\n')}`;
}

/** 把自由文本描述编码为安全的 YAML 标量：双引号包裹并转义换行/引号/反斜杠。 */
function yamlScalar(value: string): string {
  if (!value) return '""';
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}
