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
    description: '把当前 AgentRun 的阶段性结论或最终回答提交给指定 answerBridgeId。未传 answerBridgeId 时默认使用当前 run_agent 任务分配的 answerBridgeId；显式传 answerBridgeId 时可把内容提交到其它回答通道。',
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: '可选。目标 answerBridgeId。未传时使用当前 run_agent 任务里的默认 answerBridgeId。' },
        title: { type: 'string', description: '提交内容标题。用于主 Agent 快速判断这份回答的主题。' },
        content: { type: 'string', description: '提交给主 Agent 的完整内容。' }
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
    description: '按 run_agent 或 submit_agent_answer 响应中的 answerBridgeId 读取已保存的 AgentAnswer 正文。不读取普通 conversation transcript。',
    parameters: {
      type: 'object',
      properties: {
        answerBridgeId: { type: 'string', description: 'run_agent 或 submit_agent_answer 返回的 answerBridgeId。' }
      },
      required: ['answerBridgeId']
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
