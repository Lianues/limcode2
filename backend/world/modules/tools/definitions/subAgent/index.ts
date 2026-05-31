import type { ToolDefinition } from '../../registry';
import { defineToolDefinitionModule } from '../types';

export const subAgentToolModule = defineToolDefinitionModule({
  id: 'sub_agent',
  create() {
    return subAgentTool;
  }
});

export const subAgentTool: ToolDefinition = {
  execution: 'agentRun',
  declaration: {
    name: 'sub_agent',
    description: `启动一个同级 AgentRun 来执行子任务。它不是低级 Agent，而是统一 AgentRun 执行体系中的另一次执行。

可通过 conversation 参数决定是否新建、复用、fork 或使用同一个对话；通过 mode 参数覆盖完整 mode 配置（systemPrompt/modelProfile/toolPolicy/approvalPolicy/context/delivery/edit）；通过 delivery 决定结果如何回流。默认同步返回 tool_response；run_in_background=true 时默认 notification。`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '交给目标 AgentRun 执行的任务描述，应尽量详细清晰。' },
        type: { type: 'string', description: '目标 Agent 类型/蓝图 kind，例如 general-purpose、explore、reviewer。默认 general-purpose。' },
        context: { type: 'string', description: '可选背景。目标 run 是否读取历史由 conversation/context policy 决定；这里用于显式补充关键上下文。' },
        conversation: {
          type: 'object',
          description: '目标 conversation 策略。',
          properties: {
            mode: { type: 'string', description: 'fresh | reuse | fork | same | branch' },
            reuseKey: { type: 'string' },
            conversationId: { type: 'string' },
            history: { type: 'string', description: 'none | summary | last_n | full | selected' },
            lastN: { type: 'number' },
            sinceMessageId: { type: 'string' },
            branchFromRevisionId: { type: 'string' },
            revisionId: { type: 'string' },
            visibility: { type: 'string', description: 'visible | hidden | collapsed' },
            selectedMessageIds: { type: 'array', items: { type: 'string' } },
            includeSourceContext: { type: 'boolean', description: '是否把 source conversation 中按 history policy 选中的上下文作为文本块注入 child run。' },
            includeSourceToolResult: { type: 'boolean', description: '是否把 source tool call 的状态/结果作为文本块注入 child run。' }
          }
        },
        mode: {
          type: 'object',
          description: 'Run 级完整 mode 覆盖。',
          properties: {
            modeId: { type: 'string' },
            systemPromptId: { type: 'string' },
            modelProfileId: { type: 'string' },
            toolPolicyId: { type: 'string' },
            approvalPolicyId: { type: 'string' },
            contextPolicyId: { type: 'string' },
            deliveryPolicyId: { type: 'string' },
            editPolicyId: { type: 'string' }
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
        run_in_background: { type: 'boolean', description: 'true 时默认使用 notification 回流；false/缺省时默认 tool_response 同步回流。' }
      },
      required: ['prompt']
    }
  }
};
