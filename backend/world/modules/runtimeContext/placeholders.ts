import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import * as path from 'path';
import type { Entity, WorldReader, AccessDeclaration } from '../../../ecs/types';
import type { PromptPlaceholderRecord } from '../../../../shared/protocol';
import { stripInitialWorkEnvironmentSection } from '../../../../shared/runtimeContextText';
import { formatWorkEnvironmentForDisplay } from '../../../../shared/workEnvironmentCatalog';
import { Agent } from '../agent/components';
import { AgentRunTargetLink, RunModeLink } from '../agentRun/components';
import { activeModeForRun, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { ConversationModeSelection, Mode } from '../mode/components';
import { ConversationProjectLink, ProjectContext } from '../project/components';
import { runtimeContextWorkEnvironmentsForConversation, toPublicWorkEnvironmentRecord } from '../workEnvironment/queries';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../workEnvironment/components';

export const SYSTEM_PROMPT_PLACEHOLDERS: PromptPlaceholderRecord[] = [
  { id: 'system:agent.name', token: '{{$agent.name}}', label: 'Agent 名称', description: '当前 Run 执行 Agent 的名称。', target: 'systemPrompt', order: 10 },
  { id: 'system:agent.description', token: '{{$agent.description}}', label: 'Agent 描述', description: '当前 Run 执行 Agent 的描述。', target: 'systemPrompt', order: 20 },
  { id: 'system:mode.name', token: '{{$mode.name}}', label: 'Workflow 名称', description: '当前 Run 选中的工作流名称；未选择工作流时为空。', target: 'systemPrompt', order: 30 },
  { id: 'system:mode.description', token: '{{$mode.description}}', label: 'Workflow 描述', description: '当前 Run 选中工作流的描述；未选择工作流时为空。', target: 'systemPrompt', order: 40 }
];

export const RUNTIME_CONTEXT_PLACEHOLDERS: PromptPlaceholderRecord[] = [
  { id: 'runtime:runtime.timestamp', token: '{{$runtime.timestamp}}', label: '初始时间戳', description: '生成运行时快照时的 ISO 时间。', target: 'runtimeContext', order: 10 },
  { id: 'runtime:runtime.date', token: '{{$runtime.date}}', label: '初始日期', description: '生成运行时快照时的本地日期。', target: 'runtimeContext', order: 20 },
  { id: 'runtime:platform.os', token: '{{$platform.os}}', label: '平台', description: '当前扩展宿主的 process.platform。', target: 'runtimeContext', order: 30 },
  { id: 'runtime:workEnvironment.current', token: '{{$workEnvironment.current}}', label: '初始工作环境', description: '生成快照时对话可访问的工作环境；工作环境停用时仍会列出已允许的本地环境。', target: 'runtimeContext', order: 40 },
  { id: 'runtime:workEnvironment.currentSection', token: '{{$workEnvironment.currentSection}}', label: '初始工作环境段落', description: '输出 Initial work environment 段落；工作环境停用时仍会列出已允许的本地环境。', target: 'runtimeContext', order: 45 },
  { id: 'runtime:workspace.name', token: '{{$workspace.name}}', label: '工作区名称', description: '当前对话绑定的项目/工作区名称。', target: 'runtimeContext', order: 50 },
  { id: 'runtime:workspace.uri', token: '{{$workspace.uri}}', label: '工作区 URI', description: '当前对话绑定的项目/工作区 URI。', target: 'runtimeContext', order: 60 }
];

export const PROMPT_PLACEHOLDERS: PromptPlaceholderRecord[] = [
  ...SYSTEM_PROMPT_PLACEHOLDERS,
  ...RUNTIME_CONTEXT_PLACEHOLDERS
];

export const DEFAULT_RUNTIME_CONTEXT_TEMPLATE = `[Runtime Background]\n\nInitial time: {{$runtime.timestamp}}\nInitial date: {{$runtime.date}}\nPlatform: {{$platform.os}}\n\nInitial workspace:\n{{$workspace.name}}\n{{$workspace.uri}}\n{{$workEnvironment.currentSection}}`;

export const PROMPT_CONTEXT_PLACEHOLDER_READS: AccessDeclaration = {
  components: [
    Agent,
    AgentRunTargetLink,
    RunModeLink,
    Conversation,
    ConversationModeSelection,
    Mode,
    ConversationProjectLink,
    ProjectContext,
    WorkEnvironment,
    WorkEnvironmentPolicy,
    WorkEnvironmentPolicyScopeLink,
    ConversationWorkEnvironmentLink,
    RunWorkEnvironmentLink
  ]
};

export interface PromptPlaceholderRenderContext {
  world: WorldReader;
  run?: Entity;
  conversation?: Entity;
  now?: Date;
}

export function renderSystemPromptTemplate(template: string, context: PromptPlaceholderRenderContext): string {
  return replacePlaceholders(template, (token) => resolveSystemPlaceholder(token, context));
}

export function renderRuntimeContextTemplate(template: string, context: PromptPlaceholderRenderContext): string {
  const rendered = replacePlaceholders(template, (token) => resolveRuntimePlaceholder(token, context));
  return currentWorkEnvironmentText(context) ? rendered : stripInitialWorkEnvironmentSection(rendered);
}

export function runtimeContextSourceHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function replacePlaceholders(template: string, resolve: (token: string) => string | undefined): string {
  return template.replace(/\{\{\$[a-zA-Z0-9_.-]+\}\}/g, (token) => resolve(token) ?? token);
}

function resolveSystemPlaceholder(token: string, context: PromptPlaceholderRenderContext): string | undefined {
  const { world, run } = context;
  const target = run !== undefined ? runTarget(world, run) : undefined;
  const agent = target ? world.get(target.agent, Agent) : undefined;
  const modeEntity = run !== undefined ? activeModeForRun(world, run) : undefined;
  const mode = modeEntity !== undefined ? world.get(modeEntity, Mode) : undefined;
  switch (token) {
    case '{{$agent.name}}': return agent?.name ?? '';
    case '{{$agent.description}}': return agent?.description ?? '';
    case '{{$mode.name}}': return mode?.name ?? '';
    case '{{$mode.description}}': return mode?.description ?? '';
    default: return undefined;
  }
}

function resolveRuntimePlaceholder(token: string, context: PromptPlaceholderRenderContext): string | undefined {
  const now = context.now ?? new Date();
  switch (token) {
    case '{{$runtime.timestamp}}': return now.toISOString();
    case '{{$runtime.date}}': return formatLocalDate(now);
    case '{{$platform.os}}': return process.platform;
    case '{{$workEnvironment.current}}': return currentWorkEnvironmentText(context);
    case '{{$workEnvironment.currentSection}}': return currentWorkEnvironmentSectionText(context);
    case '{{$workspace.name}}': return currentWorkspaceText(context, 'name');
    case '{{$workspace.uri}}': return currentWorkspaceText(context, 'uri');
    default: return undefined;
  }
}

function currentWorkEnvironmentText(context: PromptPlaceholderRenderContext): string {
  const conversation = context.conversation ?? (context.run !== undefined ? runTarget(context.world, context.run)?.conversation : undefined);
  if (conversation === undefined) return '';
  return runtimeContextWorkEnvironmentsForConversation(context.world, conversation)
    .map((environment) => formatWorkEnvironmentForDisplay(toPublicWorkEnvironmentRecord(environment.data)))
    .join('\n');
}

function currentWorkEnvironmentSectionText(context: PromptPlaceholderRenderContext): string {
  const text = currentWorkEnvironmentText(context);
  return text ? `\nInitial work environment:\n${text}` : '';
}

function currentWorkspaceText(context: PromptPlaceholderRenderContext, field: 'name' | 'uri'): string {
  const conversation = context.conversation ?? (context.run !== undefined ? runTarget(context.world, context.run)?.conversation : undefined);
  if (conversation === undefined) return '未绑定工作区。';
  const project = projectContextForConversation(context.world, conversation);
  if (!project) return '未绑定工作区。';
  return field === 'name' ? project.name : formatWorkspaceUriForPrompt(project.uri);
}

function projectContextForConversation(world: WorldReader, conversation: Entity): ProjectContextData | undefined {
  for (const entity of world.query(ConversationProjectLink)) {
    const link = world.get(entity, ConversationProjectLink);
    if (!link || link.conversation !== conversation || link.role !== 'primary') continue;
    return world.get(link.projectContext, ProjectContext);
  }
  return undefined;
}

type ProjectContextData = { id: string; kind: string; uri: string; name: string; createdAt: number; updatedAt: number };

export function formatWorkspaceUriForPrompt(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('file:')) return decodeUriFallback(trimmed);
  return fileUriToDisplayPath(trimmed) ?? decodeUriFallback(trimmed);
}

function fileUriToDisplayPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    const windowsDrivePath = decodedPath.match(/^\/([a-zA-Z]:)(?:\/(.*))?$/);
    if (windowsDrivePath) {
      const [, drive, rest = ''] = windowsDrivePath;
      return rest ? `${drive}\\${rest.replace(/\//g, '\\')}` : `${drive}\\`;
    }
    if (process.platform === 'win32') return fileURLToPath(parsed);
    return path.normalize(fileURLToPath(parsed));
  } catch {
    return undefined;
  }
}

function decodeUriFallback(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
