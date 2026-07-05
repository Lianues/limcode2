import { READ_AGENT_ANSWER_TOOL_NAME, SUBMIT_AGENT_ANSWER_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

export const submitAgentAnswerToolModule = defineToolDefinitionModule({
  id: SUBMIT_AGENT_ANSWER_TOOL_NAME,
  create() {
    return submitAgentAnswerTool;
  }
});

export const readAgentAnswerToolModule = defineToolDefinitionModule({
  id: READ_AGENT_ANSWER_TOOL_NAME,
  create() {
    return readAgentAnswerTool;
  }
});

export const submitAgentAnswerTool: ToolDefinition = {
  declaration: {
    name: SUBMIT_AGENT_ANSWER_TOOL_NAME,
    description: "Submit this AgentRun's interim conclusion or final answer to a given answerBridgeId. When answerBridgeId is omitted, the default answerBridgeId assigned to the current run_agent task is used; pass answerBridgeId explicitly to submit to a different answer channel.",
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: 'Optional. Target answerBridgeId. Defaults to the answerBridgeId of the current run_agent task when omitted.' },
        title: { type: 'string', description: 'Title of the submitted content. Lets the parent agent quickly grasp the topic of this answer.' },
        content: { type: 'string', description: 'The full content submitted to the parent agent.' }
      },
      required: ['title', 'content']
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'agent',
      readonly: false,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'agent_answer_submit'),
  summary: summarizeSubmitAgentAnswerToolCall,
  async execute() {
    return { ok: false, output: 'submit_agent_answer 必须由 ECS ToolDispatchSystem 处理。' };
  }
};

export const readAgentAnswerTool: ToolDefinition = {
  declaration: {
    name: READ_AGENT_ANSWER_TOOL_NAME,
    description: 'Read a saved AgentAnswer body by the answerBridgeId returned in a run_agent or submit_agent_answer response. Does not read the regular conversation transcript. When no answer is available yet, the response distinguishes three cases via a "status" field: "running" — the child conversation is still active (including after a manual retry) and has not submitted yet, so retry later or wait for its completion notification (this is NOT a failure); "interrupted" — the child conversation exists but is neither running nor has submitted (the sub-agent errored or stopped); the response includes the child "agentId" so you can call run_agent({ agent: { id }, prompt }) to resume that same agent; "not_found" — the answerBridgeId does not match any answer or child conversation.',
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: 'The answerBridgeId returned by run_agent or submit_agent_answer.' }
      }
    },
    metadata: {
      category: 'agent',
      scope: 'agent',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'agent_answer_read'),
  summary: summarizeReadAgentAnswerToolCall,
  async execute() {
    return { ok: false, output: 'read_agent_answer 必须由 ECS ToolDispatchSystem 处理。' };
  }
};

function summarizeSubmitAgentAnswerToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { title?: unknown }
    : undefined;
  const title = typeof args?.title === 'string' ? args.title.trim().replace(/\s+/g, ' ') : '';
  return title ? `提交 Agent 回答 · ${title.slice(0, 80)}` : '提交 Agent 回答';
}

function summarizeReadAgentAnswerToolCall(rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs as { answerBridgeId?: unknown }
    : undefined;
  const answerBridgeId = typeof args?.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
  return answerBridgeId ? `读取 Agent 回答 · ${answerBridgeId}` : '读取 Agent 回答';
}
