export interface CompletedAgentAnswerModelResponse {
  ok: true;
  answerBridgeId?: string;
  agentType?: string;
  title?: string;
  content: string;
}

/**
 * Agent Answer 的模型可见成功响应。实体/运行/对话 ID 属于内部导航元数据，
 * 不进入 Agent 间回答正文；answerBridgeId 是唯一协作定位标识。
 */
export function createCompletedAgentAnswerModelResponse(input: {
  answerBridgeId?: string;
  agentType?: string;
  title?: string;
  content: string;
}): CompletedAgentAnswerModelResponse {
  const answerBridgeId = input.answerBridgeId?.trim();
  const agentType = input.agentType?.trim();
  const title = input.title?.trim();
  return {
    ok: true,
    ...(answerBridgeId ? { answerBridgeId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(title ? { title } : {}),
    content: input.content
  };
}
