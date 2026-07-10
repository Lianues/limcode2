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
    description: `Start, continue, or interrupt a child AgentRun.

Usage:
- Use agent.type to select an Agent type/configuration such as main, worker, or explore. It defaults to ${DEFAULT_RUN_AGENT_TYPE}.
- Prefer answerBridgeId when continuing or appending to an existing run_agent child conversation. It resolves the bound child Agent and conversation and preserves the same default submit_agent_answer channel.
- In the default run mode, if the reused child conversation is still responding, this call interrupts its current Run and force-sends the new message immediately instead of placing it in the normal queue.
- Use mode="interrupt" with answerBridgeId to interrupt the active Run in that child conversation and recursively cancel all descendant child AgentRuns, including already-backgrounded descendants. Interrupt mode does not require prompt or foregroundWaitMs.
- agent.id is a compatibility selector for a temporary Agent mirror previously returned by run_agent. Prefer answerBridgeId. agent.id is not an Agent type/configuration id and fails when the mirror cannot be found.
- In run mode, put the complete task, background, role, and supplemental instructions in prompt. Separate context, conversation, and delivery parameters are not supported.
- In run mode, foregroundWaitMs is the foreground wait budget in milliseconds, not an AgentRun termination timeout. Use 0 to background immediately. When the budget expires, the AgentRun continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.

IMPORTANT - Background execution behavior:
When a child Agent is executed in the background (foregroundWaitMs budget expires, or foregroundWaitMs=0), you MUST NOT attempt to perform the delegated task yourself or continue working on it — the child agent is handling it.

You have two options instead:
1. Respond to the user with a concise waiting message and end your current response, letting the child agent's result come back through the delivery policy (tool_response, notification, or append_to_source_conversation).
2. Continue doing other independent work that does NOT require the child agent's answer — i.e., work that you can fully complete without waiting for the child agent's result.`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['run', 'interrupt'],
          description: 'Operation mode. Defaults to "run". Use "interrupt" with answerBridgeId to stop the active Run in an existing child conversation and recursively cancel its descendant child AgentRuns.'
        },
        prompt: {
          type: 'string',
          description: 'Required in run mode. The complete task for the target AgentRun, including all relevant background, role instructions, constraints, and supplemental information.'
        },
        answerBridgeId: {
          type: 'string',
          description: 'Continue, append to, or interrupt an existing run_agent child conversation. Required in interrupt mode. Interrupt mode recursively cancels descendant child AgentRuns. In run mode, the bound child Agent and conversation are reused, the same submit_agent_answer channel is preserved, and any active response is interrupted before this message is force-sent.'
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
          description: 'Required in run mode. Foreground wait budget in milliseconds; this is not an AgentRun termination timeout. Use 0 to background immediately. When the budget expires, the AgentRun continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.'
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
      }
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
  mode?: string;
  foregroundWaitMs?: number;
  wait?: string;
  scheduling?: string;
}

function summarizeRunAgentToolCall(rawArgs: unknown, context: ToolCallSummaryContext): string | undefined {
  const args = (rawArgs ?? {}) as RunAgentSchedulingArgs & { prompt?: unknown; answerBridgeId?: unknown; agent?: { type?: unknown; id?: unknown } };
  const answerBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  if (args.mode?.trim() === 'interrupt') return answerBridgeId ? `Interrupt Agent · ${answerBridgeId}` : 'Interrupt Agent';
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
  if (args.mode?.trim() === 'interrupt') return { mode: 'serial', reason: 'interrupt_mode' };
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
