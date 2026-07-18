const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const {
  PlanReviewAttentionTracker,
  collectPendingPlanReviewAttention,
  planReviewAttentionMessage
} = require('../dist/extension/backend/application/planReviewAttention.js');
const {
  AgentRunSourceLink,
  AgentRunTargetLink,
  ToolCallRunLink
} = require('../dist/extension/backend/world/modules/agentRun/components.js');
const { Conversation } = require('../dist/extension/backend/world/modules/chat/components.js');
const { OpenConversationPanelIdsKey } = require('../dist/extension/backend/world/modules/chat/resources.js');
const { ToolCall, ToolState } = require('../dist/extension/backend/world/modules/tools/components.js');

const PLAN_BODY = '1. 实现 Plan 通知\n2. 回归 ask_user';

test('open target conversation groups pending submit_plan attention', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-plan-notification',
    targetConversationTitle: 'Plan 通知测试'
  });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-plan-notification']);
  addPendingSubmitPlan(world, run, 'submit-plan-notification-1', PLAN_BODY, 10);
  addPendingSubmitPlan(world, run, 'submit-plan-notification-2', '第二个 Plan', 11);

  const requests = collectPendingPlanReviewAttention(world);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].conversationId, 'conversation-plan-notification');
  assert.equal(requests[0].conversationTitle, 'Plan 通知测试');
  assert.equal(requests[0].planCount, 2);
  assert.equal(requests[0].firstPlan, PLAN_BODY);
  assert.match(planReviewAttentionMessage(requests[0]), /2 个 Plan 等待审批/);
});

test('single pending submit_plan notification includes a compact Plan summary', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, { targetConversationId: 'conversation-single-plan' });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-single-plan']);
  addPendingSubmitPlan(world, run, 'submit-plan-single', PLAN_BODY, 10);

  const [request] = collectPendingPlanReviewAttention(world);
  assert.ok(request);
  assert.equal(request.planCount, 1);
  assert.match(planReviewAttentionMessage(request), /^LimCode 需要你审批 Plan：/);
  assert.match(planReviewAttentionMessage(request), /实现 Plan 通知/);
});

test('closed target conversation does not produce a stale Plan notification', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, { targetConversationId: 'conversation-closed-plan' });
  world.setResource(OpenConversationPanelIdsKey, []);
  addPendingSubmitPlan(world, run, 'submit-plan-closed', PLAN_BODY, 10);

  assert.deepEqual(collectPendingPlanReviewAttention(world), []);
});

test('parent tab does not replace a child Agent target tab for Plan notification', () => {
  const world = new MapWorld();
  const run = world.spawn();
  addRunContext(world, run, {
    targetConversationId: 'conversation-child-plan',
    sourceConversationId: 'conversation-parent'
  });
  world.setResource(OpenConversationPanelIdsKey, ['conversation-parent']);
  addPendingSubmitPlan(world, run, 'submit-plan-child', PLAN_BODY, 10);

  assert.deepEqual(collectPendingPlanReviewAttention(world), []);
});

test('Plan notification tracker emits once per continuous waiting episode', () => {
  const tracker = new PlanReviewAttentionTracker();
  const request = {
    conversationId: 'conversation-plan-notification',
    conversationTitle: 'Plan 通知测试',
    planCount: 1,
    firstPlan: PLAN_BODY,
    firstCreatedAt: 1
  };

  assert.deepEqual(tracker.takeNew([request]), [request]);
  assert.deepEqual(tracker.takeNew([request]), []);
  assert.deepEqual(tracker.takeNew([]), []);
  assert.deepEqual(tracker.takeNew([request]), [request]);
});

function addPendingSubmitPlan(world, run, id, plan, createdAt) {
  const toolCall = world.spawn();
  world.add(toolCall, ToolCall, {
    id,
    functionCallId: id,
    name: 'submit_plan',
    argsJson: JSON.stringify({ plan }),
    createdAt
  });
  world.add(toolCall, ToolState, {
    status: 'awaiting_user_input',
    updatedAt: createdAt,
    progress: {
      waitingFor: 'plan_review',
      planProposalId: `plan-proposal:${id}`
    }
  });
  const link = world.spawn();
  world.add(link, ToolCallRunLink, {
    id: `tool-run:${id}`,
    toolCall,
    run,
    role: 'produced_by',
    createdAt,
    updatedAt: createdAt
  });
  return toolCall;
}

function addRunContext(world, run, input) {
  const targetConversation = world.spawn();
  world.add(targetConversation, Conversation, {
    id: input.targetConversationId,
    title: input.targetConversationTitle ?? input.targetConversationId,
    visibility: 'visible'
  });
  const targetAgent = world.spawn();
  const targetLink = world.spawn();
  world.add(targetLink, AgentRunTargetLink, {
    id: `target-${run}`,
    run,
    agent: targetAgent,
    conversation: targetConversation,
    role: 'executor',
    createdAt: 1,
    updatedAt: 1
  });

  let sourceConversation;
  if (input.sourceConversationId) {
    sourceConversation = world.spawn();
    world.add(sourceConversation, Conversation, {
      id: input.sourceConversationId,
      title: input.sourceConversationId,
      visibility: 'visible'
    });
  }
  const sourceLink = world.spawn();
  world.add(sourceLink, AgentRunSourceLink, {
    id: `source-${run}`,
    run,
    sourceKind: sourceConversation === undefined ? 'user' : 'toolCall',
    ...(sourceConversation === undefined ? {} : { sourceConversation }),
    createdAt: 1,
    updatedAt: 1
  });
}
