import type { ToolCallSummaryContext, ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const RUN_AGENT_TOOL_NAME = 'run_agent';
export const DEFAULT_RUN_AGENT_TYPE = 'worker';

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
    description: `Start an AgentRun to continue an existing child-agent conversation or create a new child agent for a task.

Usage:
- Use agent.type to select an Agent type/configuration such as main, worker, or explore. It defaults to ${DEFAULT_RUN_AGENT_TYPE}.
- Prefer answerBridgeId when continuing or appending to an existing run_agent child conversation. It resolves the bound child Agent and conversation and preserves the same default submit_agent_answer channel.
- If the reused child conversation is still responding, this call interrupts its current Run and force-sends the new message immediately instead of placing it in the normal queue.
- agent.id is a compatibility selector for a temporary Agent mirror previously returned by run_agent. Prefer answerBridgeId. agent.id is not an Agent type/configuration id and fails when the mirror cannot be found.
- Put the complete task, background, role, and supplemental instructions in prompt. Separate context, conversation, mode, and delivery parameters are not supported.
- foregroundWaitMs is the foreground wait budget in milliseconds, not an AgentRun termination timeout. Use 0 to background immediately. When the budget expires, the AgentRun continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete task for the target AgentRun, including all relevant background, role instructions, constraints, and supplemental information.'
        },
        answerBridgeId: {
          type: 'string',
          description: 'Optional. Continue or append to an existing run_agent child conversation by its answerBridgeId. The bound child Agent and conversation are reused, the same default submit_agent_answer channel is preserved, and any active response is interrupted before this message is force-sent.'
        },
        agent: {
          type: 'object',
          description: 'Selects the child Agent. Omit this when answerBridgeId already identifies an existing child conversation.',
          properties: {
            id: {
              type: 'string',
              description: 'Compatibility selector for a temporary Agent mirror previously returned by run_agent. Prefer answerBridgeId and use this only when answerBridgeId is unavailable. To create a separate mirror of the same type, omit id and provide only agent.type.'
            },
            type: {
              type: 'string',
              description: `The Agent type/configuration id to use, such as main, worker, or explore. When neither answerBridgeId nor agent.id is provided, the backend creates a temporary mirror dedicated to this child conversation. Available types are appended to the tool description at runtime. Defaults to ${DEFAULT_RUN_AGENT_TYPE}.`
            }
          }
        },
        foregroundWaitMs: {
          type: 'number',
          description: 'Required foreground wait budget in milliseconds; this is not an AgentRun termination timeout. Use 0 to background immediately. When the budget expires, the AgentRun continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.'
        },
        wait: {
          type: 'string',
          description: 'Whether this tool call should wait for preceding tool calls before it starts. The default is parallel execution without waiting; pass "true" to wait.'
        },
        scheduling: {
          type: 'string',
          enum: ['parallel', 'serial'],
          description: 'Tool-call scheduling mode. Defaults to parallel. Use serial when this task may interfere with other tool calls.'
        }
      },
      required: ['prompt', 'foregroundWaitMs']
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
  foregroundWaitMs?: number;
  wait?: string;
  scheduling?: string;
}

function summarizeRunAgentToolCall(rawArgs: unknown, context: ToolCallSummaryContext): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; agent?: { type?: unknown; id?: unknown } };
  const prompt = typeof args.prompt === 'string' ? normalizeSummaryText(args.prompt) : '';
  const resolvedType = runAgentTypeFromValue(context.result) ?? runAgentTypeFromValue(context.progress);
  const requestedType = typeof args.agent?.type === 'string' && args.agent.type.trim()
    ? args.agent.type.trim()
    : undefined;
  const hasIndirectTarget = (typeof args.answerBridgeId === 'string' && !!args.answerBridgeId.trim())
    || (typeof args.agent?.id === 'string' && !!args.agent.id.trim());
  const targetType = resolvedType ?? requestedType ?? (hasIndirectTarget ? 'Agent' : DEFAULT_RUN_AGENT_TYPE);
  return prompt ? `Run ${targetType} · ${truncateSummary(prompt, 96)}` : `Run ${targetType}`;
}

function runAgentTypeFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const output = record.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const nestedType = (output as Record<string, unknown>).agentType;
    if (typeof nestedType === 'string' && nestedType.trim()) return nestedType.trim();
  }
  return typeof record.agentType === 'string' && record.agentType.trim()
    ? record.agentType.trim()
    : undefined;
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
