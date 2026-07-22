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
    description: `Start, continue, or explicitly interrupt a child AgentRun.

Usage:
- Use agent.type to select an Agent type/configuration such as main, worker, or explore. It defaults to ${DEFAULT_RUN_AGENT_TYPE}. Runtime mirror ids are internal and must not be used as agent.type.
- Prefer answerBridgeId when continuing or appending to an existing run_agent child conversation. It resolves the bound child Agent/conversation and preserves the same default submit_agent_answer channel.
- In run mode, put the complete task, background, role, and supplemental instructions in prompt. Separate context, conversation, and delivery parameters are not supported.
- foregroundWaitMs is optional in run mode. Omit it or pass 0 to start the child Agent and return immediately. It is only a foreground wait budget, never an AgentRun timeout; when the budget expires, the child continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.
- Use a positive foregroundWaitMs only when the current reply truly cannot proceed without an immediate child result; keep it small.
- Use mode="interrupt" with answerBridgeId only when the user explicitly asks to stop/replace that child task. Interrupt recursively cancels the active child Run and descendants, including backgrounded descendants. Never interrupt merely because the child Agent is slow or read_agent_answer reports status="running".
- agent.id is an internal compatibility selector for a temporary Agent mirror previously returned by run_agent. The model normally should not use it; prefer answerBridgeId for an existing child conversation, or agent.type for a new child.

IMPORTANT - Async child Agent behavior:
Child Agents are asynchronous. The parent Agent should not keep its own response open just to wait for child completion.
Recommended pattern:
1. Delegate with run_agent using foregroundWaitMs=0 or omit foregroundWaitMs.
2. When run_agent returns backgrounded, immediately write useful text to the user (for example: the task has been dispatched, what is being checked, and that results will arrive later) and end the current turn.
3. Let the child submit via submit_agent_answer delivery, or check later in a new turn with read_agent_answer if needed.

Do NOT poll read_agent_answer in a loop in the same response. Do NOT use tools to wait for a long-running child. If the child is slow, it is still running normally in the background.`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['run', 'interrupt'],
          description: 'Operation mode. Defaults to "run". Use "interrupt" with answerBridgeId only when the user explicitly wants to stop/replace an existing child task; it recursively cancels descendant child AgentRuns. Do not interrupt merely because a child is slow or still running.'
        },
        prompt: {
          type: 'string',
          description: 'Required in run mode. The complete task for the target AgentRun, including all relevant background, role instructions, constraints, and supplemental information.'
        },
        answerBridgeId: {
          type: 'string',
          description: 'Continue, append to, or explicitly interrupt an existing run_agent child conversation. Required in interrupt mode. In run mode, the bound child Agent and conversation are reused and the same submit_agent_answer channel is preserved.'
        },
        agent: {
          type: 'object',
          description: 'Selects the child Agent. Omit this when answerBridgeId already identifies an existing child conversation.',
          properties: {
            id: {
              type: 'string',
              description: 'Internal compatibility selector for a temporary Agent mirror previously returned by run_agent. The model normally should not use this. Prefer answerBridgeId for an existing child conversation; to create a new child, omit id and provide agent.type.'
            },
            type: {
              type: 'string',
              description: `The Agent type/configuration id to use, such as main, worker, or explore. The backend may create a temporary runtime mirror internally, but mirror ids are not valid types and should not be supplied here. Available types are appended to the tool description at runtime. Defaults to ${DEFAULT_RUN_AGENT_TYPE}.`
            }
          }
        },
        foregroundWaitMs: {
          type: 'number',
          description: 'Optional in run mode. Foreground wait budget in milliseconds; this is not an AgentRun timeout. Omit or use 0 to background immediately (recommended for delegation). Use a small positive value only when the current reply truly needs an immediate child result. When the budget expires, the child continues in the background and the tool returns agentId, runId, conversationId, and answerBridgeId.'
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
