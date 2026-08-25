const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const {
  conversationWorkspaceSkeletonSlice,
  partitionWorkspaceSkeletonByConversationOwner
} = require('../dist/extension/backend/application/conversationWorkspaceSkeleton.js');

function fixture() {
  const state = createEmptyClientState();
  state.conversations.push(
    { id: 'conversation-a', title: 'A' },
    { id: 'conversation-b', title: 'B' }
  );
  state.agents.push({
    id: 'agent-mirror-a',
    name: 'Mirror A',
    kind: 'worker',
    source: 'builtin',
    status: 'idle',
    runtimeRole: 'mirror',
    typeAgentId: 'worker'
  });
  state.agentConversationLinks.push({
    id: 'agent-link-a',
    agentId: 'agent-mirror-a',
    conversationId: 'conversation-a',
    role: 'participant'
  });
  state.workflows.push({ id: 'workflow-shared', name: 'Shared', source: 'user', createdAt: 1, updatedAt: 1 });
  state.conversationWorkflowSelections.push({
    id: 'workflow-selection-a',
    conversationId: 'conversation-a',
    workflowId: 'workflow-shared',
    scopeKind: 'workflow',
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  state.projectContexts.push({ id: 'project-shared', kind: 'folder', uri: 'file:///project', name: 'Project', createdAt: 1, updatedAt: 1 });
  state.conversationProjectLinks.push(
    { id: 'project-link-a', conversationId: 'conversation-a', projectContextId: 'project-shared', role: 'primary', createdAt: 1, updatedAt: 1 },
    { id: 'project-link-b', conversationId: 'conversation-b', projectContextId: 'project-shared', role: 'primary', createdAt: 1, updatedAt: 1 }
  );
  state.runtimeContextSnapshots.push({
    id: 'runtime-snapshot-a',
    name: 'A snapshot',
    text: 'A',
    template: '{{text}}',
    conversationId: 'conversation-a',
    createdAt: 1,
    updatedAt: 1,
    refreshedAt: 1
  });
  state.conversationRuntimeContextSnapshotLinks.push({
    id: 'runtime-snapshot-link-a',
    conversationId: 'conversation-a',
    runtimeContextSnapshotId: 'runtime-snapshot-a',
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  state.shadowRepositories.push({ id: 'shadow-a', storageKey: 'shadow-a', createdAt: 1, updatedAt: 1 });
  state.conversationCheckpointRepositoryLinks.push({
    id: 'checkpoint-repository-link-a',
    conversationId: 'conversation-a',
    projectContextId: 'project-shared',
    shadowRepositoryId: 'shadow-a',
    projectUri: 'file:///project',
    projectDisplayPath: '/project',
    role: 'active',
    createdAt: 1,
    updatedAt: 1
  });
  state.checkpoints.push({
    id: 'checkpoint-a',
    conversationId: 'conversation-a',
    projectContextId: 'project-shared',
    shadowRepositoryId: 'shadow-a',
    trigger: 'manual',
    status: 'complete',
    projectUri: 'file:///project',
    projectDisplayPath: '/project',
    createdAt: 1,
    updatedAt: 1
  });
  state.checkpointTimelineAnchors.push({
    id: 'checkpoint-anchor-a',
    conversationId: 'conversation-a',
    checkpointId: 'checkpoint-a',
    floorMessageId: 'message-a',
    position: 'before',
    order: 1,
    createdAt: 1,
    updatedAt: 1
  });
  state.agentAnswers.push({ id: 'answer-a', title: 'A answer', content: 'done', createdAt: 1, updatedAt: 1 });
  state.agentAnswerTargetLinks.push({
    id: 'answer-target-a',
    answerId: 'answer-a',
    targetAgentId: 'agent-mirror-a',
    targetConversationId: 'conversation-a',
    createdAt: 1,
    updatedAt: 1
  });
  return state;
}

test('conversation workspace skeleton slice 保留局部关系与依赖且排除共享配置主体', () => {
  const slice = conversationWorkspaceSkeletonSlice(fixture(), 'conversation-a');
  assert.deepEqual(slice.conversations.map((record) => record.id), ['conversation-a']);
  assert.deepEqual(slice.agents.map((record) => record.id), ['agent-mirror-a']);
  assert.deepEqual(slice.agentConversationLinks.map((record) => record.id), ['agent-link-a']);
  assert.deepEqual(slice.projectContexts.map((record) => record.id), ['project-shared']);
  assert.deepEqual(slice.conversationProjectLinks.map((record) => record.id), ['project-link-a']);
  assert.deepEqual(slice.runtimeContextSnapshots.map((record) => record.id), ['runtime-snapshot-a']);
  assert.deepEqual(slice.checkpoints.map((record) => record.id), ['checkpoint-a']);
  assert.deepEqual(slice.shadowRepositories.map((record) => record.id), ['shadow-a']);
  assert.deepEqual(slice.agentAnswers.map((record) => record.id), ['answer-a']);
  assert.deepEqual(slice.workflows, []);
});

test('workspace skeleton 按 owner scope 分片并复制跨 scope 共享依赖', () => {
  const scopeA = 'a'.repeat(64);
  const scopeB = 'b'.repeat(64);
  const partitioned = partitionWorkspaceSkeletonByConversationOwner(
    fixture(),
    new Map([
      ['conversation-a', scopeA],
      ['conversation-b', scopeB]
    ]),
    scopeA
  );

  const stateA = partitioned.get(scopeA);
  const stateB = partitioned.get(scopeB);
  assert.ok(stateA);
  assert.ok(stateB);
  assert.deepEqual(stateA.conversations.map((record) => record.id), ['conversation-a']);
  assert.deepEqual(stateB.conversations.map((record) => record.id), ['conversation-b']);
  assert.deepEqual(stateA.projectContexts.map((record) => record.id), ['project-shared']);
  assert.deepEqual(stateB.projectContexts.map((record) => record.id), ['project-shared']);
  assert.deepEqual(stateA.agents.map((record) => record.id), ['agent-mirror-a']);
  assert.deepEqual(stateB.agents, []);
  assert.deepEqual(stateA.workflows, []);
  assert.deepEqual(stateB.workflows, []);
});
