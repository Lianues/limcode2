import { normalizeSubmitPlanToolRequest, submitPlanOutputFromResult } from '../../../../../../shared/planReview';
import { SUBMIT_PLAN_TOOL_NAME } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

export const submitPlanToolModule = defineToolDefinitionModule({
  id: SUBMIT_PLAN_TOOL_NAME,
  create() {
    return submitPlanTool;
  }
});

export const submitPlanTool: ToolDefinition = {
  declaration: {
    name: SUBMIT_PLAN_TOOL_NAME,
    description: `Submit an implementation plan for user review before making changes.

Use this tool when the active workflow requires plan approval, or when a task involves non-trivial file edits, commands, or child agents. After calling submit_plan, wait for the user's decision. If the user requests changes, revise the plan and call submit_plan again. If approved, continue with the approved plan.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Optional short title for the plan.'
        },
        plan: {
          type: 'string',
          description: 'The plan body. Include concise steps and acceptance criteria where helpful.'
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional risks, unknowns, or validation concerns.'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional files or areas likely to be touched.'
        }
      },
      required: ['plan']
    },
    metadata: {
      category: 'general',
      scope: 'conversation',
      riskLevel: 'read',
      readonly: true,
      requiresApproval: false,
      defaultEnabled: true,
      defaultAutoExpand: true,
      defaultAutoApproveExecution: true,
      defaultAutoSubmitResult: true,
      checkpoint: { before: false, after: false }
    }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('serial', 'await_plan_review'),
  summary: summarizeSubmitPlanToolCall,
  async execute() {
    // 该工具由 ToolDispatchSystem 创建 PlanProposal 并切换到等待用户审批状态。
    return { ok: false, output: 'submit_plan 必须由 ECS 计划审批系统处理。' };
  }
};

function summarizeSubmitPlanToolCall(rawArgs: unknown, context: { result?: unknown }): string | undefined {
  const output = submitPlanOutputFromResult(context.result);
  if (output) return `Plan · ${statusLabel(output.status)} · ${compact(output.title ?? output.plan, 80)}`;
  try {
    const request = normalizeSubmitPlanToolRequest(rawArgs);
    return `提交 Plan · ${compact(request.title ?? request.plan, 100)}`;
  } catch {
    return '提交 Plan';
  }
}

function statusLabel(status: 'approved' | 'change_requested' | 'rejected'): string {
  switch (status) {
    case 'approved': return '已批准';
    case 'change_requested': return '要求修改';
    case 'rejected': return '已拒绝';
  }
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
