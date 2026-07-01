import { SKILLS_TOOL_NAME, type SkillSource } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

const SKILL_SOURCES: readonly SkillSource[] = ['agents', 'claude', 'global'];

interface SkillsToolArgs { name?: unknown; source?: unknown }

function normalizeSource(value: unknown): SkillSource | undefined {
  if (typeof value !== 'string') return undefined;
  // Accept both the dotted display form (`.agents`/`.claude`) surfaced in the tool
  // description and the bare source id.
  const normalized = value.trim().replace(/^\./, '').toLowerCase();
  return (SKILL_SOURCES as readonly string[]).includes(normalized) ? normalized as SkillSource : undefined;
}

export const skillsToolModule = defineToolDefinitionModule({
  id: SKILLS_TOOL_NAME,
  create() {
    return skillsTool;
  }
});

export const skillsTool: ToolDefinition = {
  declaration: {
    name: SKILLS_TOOL_NAME,
    description: `Load a skill's full instructions into the current context and follow its steps.

A skill is a prepackaged workflow / domain playbook. Skills come from three sources: .agents (project .agents/skills/), .claude (project .claude/skills/), and global (data-root skills/). When an available skill fits the task, call this tool with the skill's \`name\` (and \`source\` to disambiguate) to load its SKILL.md body, then follow it.

Returns \`entryPath\` (absolute path to SKILL.md) and \`body\` (the SKILL.md contents). Any bundled scripts/resources are described in the body; their relative paths resolve against the directory containing entryPath — use read to inspect them or shell/bash to run them.

The available skills are listed as YAML at the end of this description; each entry carries its \`name\` and \`source\`.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name (its directory slug), taken from the available skills list.' },
        source: { type: 'string' }
      },
      required: ['name']
    },
    metadata: {
      category: 'general',
      scope: 'skill',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_skill_load'),
  summary: summarizeSkillsToolCall,
  async execute(rawArgs, deps) {
    const args = (rawArgs ?? {}) as SkillsToolArgs;
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, output: 'Missing required argument: name' };
    const source = normalizeSource(args.source);
    const skill = deps.skills.get(name, source);
    if (!skill) return { ok: false, output: `未找到技能：${name}${source ? `（来源 ${source}）` : ''}` };
    const body = await deps.skills.readBody(skill.slug, skill.source);
    return {
      ok: true,
      output: {
        // SKILL.md 的绝对路径。AI 可据此定位技能目录，正文里对脚本/资源的相对路径说明均相对该文件所在目录。
        entryPath: skill.path,
        body
      }
    };
  }
};

function summarizeSkillsToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as SkillsToolArgs;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const source = normalizeSource(args.source);
  return name ? `载入技能 · ${source ? `${source}:` : ''}${name}` : undefined;
}
