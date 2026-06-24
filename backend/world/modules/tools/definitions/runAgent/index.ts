import type { ToolDefinition } from '../../registry';
import { normalizeSchedulingHint } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

export const runAgentToolModule = defineToolDefinitionModule({
  id: 'run_agent',
  create() {
    return runAgentTool;
  }
});

export const runAgentTool: ToolDefinition = {
  execution: 'agentRun',
  declaration: {
    name: 'run_agent',
    description: `启动一个 AgentRun，让指定 Agent 或指定类型 Agent 执行任务。所有 Agent 都是平等的一等对象；本工具只是创建一次新的 AgentRun，不引入子 Agent / 委派 Agent 的特殊执行核心。

可通过 agent.id/agentId 指定已有 Agent；通过 agent.type/type 按蓝图选择或创建 Agent；通过 conversation 决定 same/fresh/reuse/fork/branch；通过 mode 覆盖 systemPrompt/modelProfile/toolPolicy/context/delivery/edit；通过 delivery 决定结果如何回流。

每次调用都会分配 answerBridgeId。目标 Agent 可通过 submit_agent_answer 提交正文；同步模式下 run_agent 会直接返回已提交正文，异步模式下调用方可稍后用 read_agent_answer({ answerBridgeId }) 读取。默认由 AI 自己选择同步/异步。`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '交给目标 AgentRun 执行的任务描述，应尽量详细清晰。' },
        agent: {
          type: 'object',
          description: '目标 Agent 选择器。id 指定已有 Agent；type 按蓝图 kind 找或创建 Agent。',
          properties: {
            id: { type: 'string', description: '已有 Agent id。指定后优先使用该 Agent。' },
            type: { type: 'string', description: 'Agent 蓝图 kind，例如 general-purpose、explore、reviewer。默认 general-purpose。' },
            name: { type: 'string', description: '按 type 创建 Agent 时使用的可选名称。' },
            createIfMissing: { type: 'boolean', description: '指定 agent.id 但找不到时，是否允许按 type 创建。默认 false。' }
          }
        },
        agentId: { type: 'string', description: 'agent.id 的简写。' },
        type: { type: 'string', description: 'agent.type 的简写。默认 general-purpose。' },
        context: { type: 'string', description: '可选背景。目标 run 是否读取历史由 conversation/context policy 决定；这里用于显式补充关键上下文。' },
        conversation: {
          type: 'object',
          description: '目标 conversation 策略。',
          properties: {
            mode: { type: 'string', description: 'fresh | reuse | fork | same | branch' },
            reuseKey: { type: 'string' },
            conversationId: { type: 'string' },
            history: { type: 'string', description: 'none | summary | last_n | full | selected/selected_messages | since/since_message' },
            lastN: { type: 'number' },
            sinceMessageId: { type: 'string' },
            branchFromRevisionId: { type: 'string' },
            revisionId: { type: 'string' },
            visibility: { type: 'string', description: 'visible | hidden | collapsed' },
            selectedMessageIds: { type: 'array', items: { type: 'string' } },
            includeSourceContext: { type: 'boolean', description: '是否把 source conversation 中按 history policy 选中的上下文作为文本块注入目标 run。' },
            includeSourceToolResult: { type: 'boolean', description: '是否把 source tool call 的状态/结果作为文本块注入目标 run。' }
          }
        },
        mode: {
          type: 'object',
          description: 'Run 级完整 mode 覆盖。',
          properties: {
            modeId: { type: 'string' },
            systemPromptId: { type: 'string' },
            systemPromptText: { type: 'string', description: 'Run 级临时追加 system prompt 文本。' },
            modelProfileId: { type: 'string' },
            toolPolicyId: { type: 'string' },
            contextPolicyId: { type: 'string' },
            deliveryPolicyId: { type: 'string' },
            editPolicyId: { type: 'string' },
            contextPolicy: {
              type: 'object',
              description: 'Inline 临时 ContextPolicy，优先于 contextPolicyId / conversation.history shorthand。',
              properties: {
                historyMode: { type: 'string', description: 'none | full | last_n | since_message | selected_messages | summary' },
                lastN: { type: 'number' },
                sinceMessageId: { type: 'string' },
                selectedMessageIds: { type: 'array', items: { type: 'string' } },
                includeSourceContext: { type: 'boolean' },
                includeSourceToolResult: { type: 'boolean' }
              }
            },
            deliveryPolicy: {
              type: 'object',
              description: 'Inline 临时 DeliveryPolicy，优先于 deliveryPolicyId / delivery shorthand。',
              properties: {
                mode: { type: 'string', description: 'direct_reply | tool_response | notification | append_to_source_conversation | silent' },
                includeTranscript: { type: 'string', description: 'none | summary | selected | full | link' }
              }
            },
            editPolicy: {
              type: 'object',
              description: 'Inline 临时 EditPolicy，优先于 editPolicyId / blueprint default。',
              properties: {
                onSourceEdited: { type: 'string', description: 'ignore_snapshot | abort_and_restart | append_correction | branch_new_run | mark_stale' },
                onNewUserMessageWhileRunning: { type: 'string', description: 'queue_next_run | interrupt_current | append_to_target | ignore' }
              }
            }
          }
        },
        delivery: {
          type: 'object',
          description: '结果回流策略。',
          properties: {
            mode: { type: 'string', description: 'tool_response | notification | append_to_source_conversation | silent' },
            includeTranscript: { type: 'string', description: 'none | summary | selected | full | link' }
          }
        },
        run_in_background: { type: 'boolean', description: 'true 时默认使用 notification 回流；false/缺省时默认 tool_response 同步回流。' },
        scheduling: {
          type: 'string',
          enum: ['auto', 'parallel', 'serial'],
          description: '工具调度提示。后台/通知型 AgentRun 可并行；同步 tool_response 默认串行。'
        }
      },
      required: ['prompt']
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: true,
      checkpoint: { before: true, after: true }
    },
    configSchema: {
      fields: [
        {
          key: 'launchMode',
          label: '运行模式',
          type: 'enum',
          description: 'auto=让 AI 根据任务选择同步/异步；sync=强制同步等待并直接返回子 Agent 正文；async=强制异步启动，稍后用 answerBridgeId 读取。',
          options: [
            { label: '让 AI 自己选择', value: 'auto', description: '默认。AI 可用 run_in_background/delivery 自行决定。' },
            { label: '同步模式', value: 'sync', description: '强制 tool_response，同步等待完成并返回正文。' },
            { label: '异步模式', value: 'async', description: '强制后台启动，返回 answerBridgeId 后稍后读取。' }
          ],
          defaultValue: 'auto'
        }
      ]
    },
    defaultConfig: { launchMode: 'auto' }
  },
  scheduling: resolveRunAgentScheduling,
  summary: summarizeRunAgentToolCall
};

interface RunAgentSchedulingArgs {
  run_in_background?: boolean;
  scheduling?: string;
  delivery?: { mode?: string };
  mode?: { deliveryPolicy?: { mode?: string } };
}

function summarizeRunAgentToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; agent?: { type?: unknown; id?: unknown }; type?: unknown; agentId?: unknown };
  const prompt = typeof args.prompt === 'string' ? normalizeSummaryText(args.prompt) : '';
  const target = typeof args.agent?.type === 'string' && args.agent.type.trim()
    ? args.agent.type.trim()
    : typeof args.type === 'string' && args.type.trim()
      ? args.type.trim()
      : typeof args.agent?.id === 'string' && args.agent.id.trim()
        ? args.agent.id.trim()
        : typeof args.agentId === 'string' && args.agentId.trim()
          ? args.agentId.trim()
          : 'Agent';
  return prompt ? `运行 ${target} · ${truncateSummary(prompt, 96)}` : `运行 ${target}`;
}

function resolveRunAgentScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs;
  const hint = normalizeSchedulingHint(args.scheduling);
  const background = isBackgroundRunAgent(args);

  if (hint === 'serial') return { mode: 'serial', reason: 'explicit_serial' };
  if (hint === 'parallel') {
    return background
      ? { mode: 'parallel', reason: 'explicit_parallel_background_run_agent' }
      : { mode: 'serial', reason: 'explicit_parallel_rejected_sync_run_agent' };
  }
  return background
    ? { mode: 'parallel', reason: 'auto_background_run_agent' }
    : { mode: 'serial', reason: 'auto_sync_run_agent_barrier' };
}

function isBackgroundRunAgent(args: RunAgentSchedulingArgs): boolean {
  if (args.run_in_background === true) return true;
  const deliveryMode = args.delivery?.mode ?? args.mode?.deliveryPolicy?.mode;
  return deliveryMode === 'notification'
    || deliveryMode === 'silent'
    || deliveryMode === 'append_to_source_conversation';
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSummary(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}
