import type { ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const RUN_AGENT_TOOL_NAME = 'run_agent';

export const runAgentToolModule = defineToolDefinitionModule({
  id: RUN_AGENT_TOOL_NAME,
  create() {
    return runAgentTool;
  }
});

export const runAgentTool: ToolDefinition = {
  execution: 'agentRun',
  declaration: {
    name: RUN_AGENT_TOOL_NAME,
    description: `启动一个 AgentRun，让已有 Agent 继续执行任务，或创建一个新 Agent 执行任务。

使用方式：
- agent.type 表示要使用哪种 Agent 类型/配置（例如 main、worker、explore）；不传时默认 general-purpose。
- answerBridgeId 是继续/追加某个 run_agent 子对话的首选方式；传入后会自动找到它绑定的子 Agent 与子对话，并沿用同一个默认 submit_agent_answer 通道。
- agent.id 仅用于兼容直接复用 run_agent 返回的临时 Agent 镜像；首选传 answerBridgeId。agent.id 不是类型配置 id，找不到会报错。
- prompt 内应写清楚任务、背景、角色和补充信息，不再提供额外 context / conversation / mode / delivery 参数。
- timeout 为前台等待时间（毫秒）：0 表示直接转后台；超过 timeout 后 AgentRun 会继续在后台运行，工具立即返回 agentId/runId/conversationId/answerBridgeId。`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '交给目标 AgentRun 执行的任务描述。请在这里写清楚任务、背景、角色和所有补充信息。'
        },
        answerBridgeId: {
          type: 'string',
          description: '可选。继续/追加某个已有 run_agent 子任务时传 answerBridgeId；后端会自动找到它绑定的子 Agent/子对话，并保持 submit_agent_answer 默认值为同一个 answerBridgeId。'
        },
        agent: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: '兼容入口：run_agent 返回的临时 Agent 镜像 id。首选传 answerBridgeId；仅在没有 answerBridgeId 时使用。新开同类型独立镜像时不要传 id，只传 agent.type。'
            },
            type: {
              type: 'string',
              description: '要使用的 Agent 类型/配置 id（例如 main、worker、explore）。未传 answerBridgeId/agent.id 时后端会按该类型创建只属于本次子对话的临时镜像；可用类型会由后端运行时补充到工具说明中；默认 general-purpose。'
            }
          }
        },
        timeout: {
          type: 'number',
          description: '必填。前台等待 AgentRun 完成的超时时间（毫秒）。设为 0 表示不前台等待、直接转后台执行；超过该时间后会转入后台继续运行并返回 agentId/runId/conversationId/answerBridgeId。'
        },
        wait: {
          type: 'string',
          description: '是否等待前面的工具执行完再启动。默认不等待、并行启动；传 "true" 表示等待前面的工具完成后再启动。'
        },
        scheduling: {
          type: 'string',
          enum: ['parallel', 'serial'],
          description: '工具调度模式。默认 parallel；如果任务会互相影响，请显式传 serial。'
        }
      },
      required: ['prompt', 'timeout']
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: true,
      checkpoint: { before: true, after: true }
    }
  },
  scheduling: resolveRunAgentScheduling,
  summary: summarizeRunAgentToolCall
};

interface RunAgentSchedulingArgs {
  timeout?: number;
  wait?: string;
  scheduling?: string;
}

function summarizeRunAgentToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; agent?: { type?: unknown; id?: unknown } };
  const prompt = typeof args.prompt === 'string' ? normalizeSummaryText(args.prompt) : '';
  const target = typeof args.answerBridgeId === 'string' && args.answerBridgeId.trim()
    ? args.answerBridgeId.trim()
    : typeof args.agent?.id === 'string' && args.agent.id.trim()
      ? args.agent.id.trim()
      : typeof args.agent?.type === 'string' && args.agent.type.trim()
        ? args.agent.type.trim()
        : 'general-purpose';
  return prompt ? `运行 ${target} · ${truncateSummary(prompt, 96)}` : `运行 ${target}`;
}

function resolveRunAgentScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs;
  if (args.scheduling === 'serial') return { mode: 'serial', reason: 'explicit_serial' };
  if (args.scheduling === 'parallel') return { mode: 'parallel', reason: 'explicit_parallel' };

  const wait = typeof args.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'true') return { mode: 'serial', reason: 'wait_true' };
  return { mode: 'parallel', reason: 'default_parallel' };
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
