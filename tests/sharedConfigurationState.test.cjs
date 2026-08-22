const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { hydrateClientStateSkeleton } = require('../dist/extension/backend/application/clientStateHydration.js');
const { stripConversationFromClientState } = require('../dist/extension/backend/utils/clientStateConversationCascade.js');
const {
  mergeSharedConfigurationAndWorkspaceRuntime,
  sharedConfigurationState,
  workspaceRuntimeState
} = require('../dist/extension/backend/application/sharedConfigurationState.js');
const { SystemPromptScopeLink } = require('../dist/extension/backend/world/modules/workflow/components.js');
const { ToolPolicyScopeLink } = require('../dist/extension/backend/world/modules/tools/components.js');
const { WorkEnvironmentPolicyScopeLink } = require('../dist/extension/backend/world/modules/workEnvironment/components.js');

function activeLink(id, scopeKind, foreignKey, foreignId, scopeId) {
  return {
    id,
    scopeKind,
    ...(scopeId ? { scopeId } : {}),
    [foreignKey]: foreignId,
    role: 'active',
    createdAt: 1,
    updatedAt: 2
  };
}

test('shared configuration contains reusable domains and every config scope link', () => {
  const state = createEmptyClientState();
  state.agents.push(
    { id: 'agent-main', name: 'Main', kind: 'main', source: 'user', status: 'running' },
    { id: 'agent-mirror', name: 'Mirror', kind: 'worker', source: 'builtin', status: 'running', runtimeRole: 'mirror', typeAgentId: 'worker' }
  );
  state.workflows.push({ id: 'workflow-review', name: 'Review', source: 'user', createdAt: 1, updatedAt: 1 });
  state.toolPolicies.push({ id: 'tool-policy-conversation', name: 'Conversation policy', allowedTools: ['read'] });
  state.toolPolicyScopeLinks.push(activeLink(
    'tool-link-conversation',
    'conversation',
    'toolPolicyId',
    'tool-policy-conversation',
    'conversation-a'
  ));
  state.conversations.push({ id: 'conversation-a', title: 'A' });

  const shared = sharedConfigurationState(state);
  const workspace = workspaceRuntimeState(state);

  assert.deepEqual(shared.agents.map((agent) => agent.id), ['agent-main']);
  assert.equal(shared.agents[0].status, 'idle');
  assert.deepEqual(shared.workflows.map((workflow) => workflow.id), ['workflow-review']);
  assert.deepEqual(shared.toolPolicies.map((policy) => policy.id), ['tool-policy-conversation']);
  assert.deepEqual(shared.toolPolicyScopeLinks.map((link) => [link.scopeKind, link.scopeId]), [['conversation', 'conversation-a']]);
  assert.deepEqual(workspace.agents.map((agent) => agent.id), ['agent-mirror']);
  assert.equal(workspace.workflows.length, 0);
  assert.equal(workspace.toolPolicies.length, 0);
  assert.equal(workspace.toolPolicyScopeLinks.length, 0);
  assert.deepEqual(workspace.conversations.map((conversation) => conversation.id), ['conversation-a']);
});

test('shared state is canonical while existing workspace-only configuration is adopted by id union', () => {
  const workspace = createEmptyClientState();
  workspace.agents.push(
    { id: 'agent-existing', name: 'Existing', kind: 'worker', source: 'user', status: 'done' },
    { id: 'agent-shared', name: 'Stale', kind: 'main', source: 'user', status: 'error' }
  );
  workspace.conversations.push({ id: 'conversation-workspace', title: 'Workspace conversation' });
  workspace.systemPrompts.push({ id: 'prompt-workspace', name: 'Workspace prompt', text: 'workspace' });
  workspace.systemPromptScopeLinks.push(activeLink(
    'prompt-link-workspace',
    'conversation',
    'systemPromptId',
    'prompt-workspace',
    'conversation-workspace'
  ));

  const shared = createEmptyClientState();
  shared.agents.push({ id: 'agent-shared', name: 'Canonical', kind: 'main', source: 'user', status: 'idle' });

  const merged = mergeSharedConfigurationAndWorkspaceRuntime(shared, workspace);
  assert.deepEqual(merged.agents.map((agent) => [agent.id, agent.name]), [
    ['agent-existing', 'Existing'],
    ['agent-shared', 'Canonical']
  ]);
  assert.deepEqual(merged.conversations.map((conversation) => conversation.id), ['conversation-workspace']);
  assert.deepEqual(merged.systemPrompts.map((prompt) => prompt.id), ['prompt-workspace']);
  assert.deepEqual(merged.systemPromptScopeLinks.map((link) => link.scopeId), ['conversation-workspace']);
});

test('configuration links keep stable scopeId when their conversation is outside the current workspace', async () => {
  const state = createEmptyClientState();
  state.systemPrompts.push({ id: 'prompt-foreign', name: 'Foreign prompt', text: 'foreign' });
  state.systemPromptScopeLinks.push(activeLink(
    'prompt-link-foreign',
    'conversation',
    'systemPromptId',
    'prompt-foreign',
    'conversation-foreign'
  ));
  state.toolPolicies.push({ id: 'tool-policy-foreign', name: 'Foreign tool policy', allowedTools: ['read'] });
  state.toolPolicyScopeLinks.push(activeLink(
    'tool-link-foreign',
    'run',
    'toolPolicyId',
    'tool-policy-foreign',
    'run-foreign'
  ));
  state.workEnvironmentPolicies.push({
    id: 'environment-policy-foreign',
    name: 'Foreign environment policy',
    enabled: false,
    allowedWorkEnvironmentIds: [],
    createdAt: 1,
    updatedAt: 1
  });
  state.workEnvironmentPolicyScopeLinks.push(activeLink(
    'environment-link-foreign',
    'conversation',
    'workEnvironmentPolicyId',
    'environment-policy-foreign',
    'conversation-foreign'
  ));

  const world = new MapWorld();
  assert.equal(await hydrateClientStateSkeleton(world, state, { allowDefaults: false }), true);

  const promptLink = world.get(world.query(SystemPromptScopeLink)[0], SystemPromptScopeLink);
  const toolLink = world.get(world.query(ToolPolicyScopeLink)[0], ToolPolicyScopeLink);
  const environmentLink = world.get(world.query(WorkEnvironmentPolicyScopeLink)[0], WorkEnvironmentPolicyScopeLink);
  assert.equal(promptLink.scopeId, 'conversation-foreign');
  assert.equal(promptLink.conversation, undefined);
  assert.equal(toolLink.scopeId, 'run-foreign');
  assert.equal(toolLink.run, undefined);
  assert.equal(environmentLink.scopeId, 'conversation-foreign');
  assert.equal(environmentLink.conversation, undefined);
});


test('conversation deletion removes conversation and run scoped configuration links from shared state', () => {
  const state = createEmptyClientState();
  state.toolPolicyScopeLinks.push(activeLink(
    'tool-link-conversation-delete',
    'conversation',
    'toolPolicyId',
    'tool-policy-delete',
    'conversation-delete'
  ));
  state.skillPolicyScopeLinks.push(activeLink(
    'skill-link-run-delete',
    'run',
    'skillPolicyId',
    'skill-policy-delete',
    'run-delete'
  ));
  state.systemPromptScopeLinks.push(activeLink(
    'prompt-link-agent-keep',
    'agent',
    'systemPromptId',
    'prompt-keep',
    'agent-keep'
  ));

  const stripped = stripConversationFromClientState(state, 'conversation-delete', {
    additionalRunIds: ['run-delete']
  });
  assert.equal(stripped.toolPolicyScopeLinks.length, 0);
  assert.equal(stripped.skillPolicyScopeLinks.length, 0);
  assert.deepEqual(stripped.systemPromptScopeLinks.map((link) => link.id), ['prompt-link-agent-keep']);
});

