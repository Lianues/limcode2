import { SKILLS_TOOL_NAME, type SkillSource } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

const SKILL_SOURCES: readonly SkillSource[] = ['agents', 'claude', 'global'];

interface SkillsToolArgs { name?: unknown; source?: unknown }

function normalizeSource(value: unknown): SkillSource | undefined {
  return typeof value === 'string' && (SKILL_SOURCES as readonly string[]).includes(value) ? value as SkillSource : undefined;
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
    description: `载入一个技能（skill）的完整说明正文，把它的指导步骤纳入当前上下文。

技能是预置的专项工作流/领域知识，来自三种来源：agents=项目 .agents/skills/，claude=项目 .claude/skills/，global=数据根 skills/。当某个已启用技能与当前任务相关时，先用本工具按 name + source 载入它的 SKILL.md 正文，再按其中的步骤执行。可用技能列表见本工具描述末尾（每项都标注了 name 与 source）。

返回结果包含：entryPath（SKILL.md 绝对路径）与 body（SKILL.md 正文）。技能自带的脚本/资源由正文说明，其相对路径均相对 entryPath 所在目录；需要时用 read 读取或 shell/bash 执行。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（其目录 slug）。必须是可用技能列表中的一个。' },
        source: { type: 'string', enum: ['agents', 'claude', 'global'], description: '技能来源：agents=项目 .agents/skills/；claude=项目 .claude/skills/；global=数据根 skills/。按可用技能列表中该技能标注的 source 传入。' }
      },
      required: ['name', 'source']
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
