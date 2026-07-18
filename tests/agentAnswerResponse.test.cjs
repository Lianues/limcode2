const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createCompletedAgentAnswerModelResponse
} = require('../dist/extension/backend/world/modules/agentAnswer/modelResponse.js');
const {
  simplifyToolResponseForModel
} = require('../dist/extension/backend/world/modules/tools/responseSimplifier.js');

test('completed Agent Answer keeps only ok, bridge, type, title, and content', () => {
  const response = createCompletedAgentAnswerModelResponse({
    answerBridgeId: 'agent-answer:test',
    agentType: 'worker',
    title: '实现完成',
    content: '已完成实现并通过测试。'
  });

  assert.deepEqual(response, {
    ok: true,
    answerBridgeId: 'agent-answer:test',
    agentType: 'worker',
    title: '实现完成',
    content: '已完成实现并通过测试。'
  });
  assert.equal('status' in response, false);
  assert.equal('answerSubmitted' in response, false);
  assert.equal('runId' in response, false);
  assert.equal('conversationId' in response, false);
  assert.equal('agentId' in response, false);
});

test('read_agent_answer model response removes completed noise and entity IDs', () => {
  const response = simplifyToolResponseForModel('read_agent_answer', 'success', {
    ok: true,
    status: 'completed',
    answerSubmitted: true,
    answerBridgeId: 'agent-answer:test',
    runId: 'run123',
    conversationId: 'conversation-child',
    agentId: 'agent-worker-runtime',
    agentType: 'worker',
    title: '实现完成',
    content: '正文'
  });

  assert.deepEqual(response, {
    answerBridgeId: 'agent-answer:test',
    agentType: 'worker',
    title: '实现完成',
    content: '正文'
  });
});

test('read_agent_answer pending response keeps status but exposes type instead of agentId', () => {
  const response = simplifyToolResponseForModel('read_agent_answer', 'success', {
    ok: false,
    status: 'running',
    answerBridgeId: 'agent-answer:test',
    agentId: 'agent-worker-runtime',
    agentType: 'worker',
    error: '子 Agent 仍在运行。'
  });

  assert.deepEqual(response, {
    ok: false,
    status: 'running',
    answerBridgeId: 'agent-answer:test',
    agentType: 'worker',
    error: '子 Agent 仍在运行。'
  });
});

test('run_agent background response only exposes meaningful model fields', () => {
  const response = simplifyToolResponseForModel('run_agent', 'success', {
    ok: true,
    status: 'backgrounded',
    agentId: 'agent-worker-runtime',
    agentType: 'worker',
    runId: 'run123',
    conversationId: 'conversation-child',
    answerBridgeId: 'agent-answer:test'
  });

  assert.deepEqual(response, {
    status: 'backgrounded',
    agentType: 'worker',
    answerBridgeId: 'agent-answer:test'
  });
});

test('delegated submit_plan model response omits navigation IDs', () => {
  const response = simplifyToolResponseForModel('submit_plan', 'success', {
    ok: true,
    output: {
      kind: 'submit_plan.result',
      proposalId: 'plan-proposal:test',
      status: 'approved',
      executionTarget: 'new_conversation',
      delegationStatus: 'backgrounded',
      agentId: 'agent-worker-runtime',
      agentType: 'worker',
      runId: 'run123',
      conversationId: 'conversation-child',
      answerBridgeId: 'agent-answer:test',
      userMessage: 'Plan 已下发给 Agent 执行，请耐心等待。'
    }
  });

  assert.deepEqual(response, {
    status: 'approved',
    executionTarget: 'new_conversation',
    delegationStatus: 'backgrounded',
    agentType: 'worker',
    answerBridgeId: 'agent-answer:test',
    userMessage: 'Plan 已下发给 Agent 执行，请耐心等待。'
  });
});

test('ok true remains the fallback when a tool has no other model response', () => {
  assert.deepEqual(
    simplifyToolResponseForModel('update_task_list', 'success', { ok: true }),
    { ok: true }
  );
});
