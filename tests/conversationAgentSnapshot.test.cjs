const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLIENT_STATE_TABLES,
  createEmptyClientState
} = require('../dist/extension/shared/clientStateSchema.js');
const {
  projectConversationClientState
} = require('../dist/extension/backend/world/clientSync/systems/ClientSyncSystem.js');

function createStateWithConversationAgents() {
  const state = createEmptyClientState();
  state.agents = [
    { id: 'main', name: 'LimCode Agent', kind: 'main', source: 'builtin', status: 'idle' },
    { id: 'explore', name: 'Explore Agent', kind: 'explore', source: 'builtin', status: 'idle' }
  ];
  state.conversations = [
    { id: 'conversation-target', title: '目标对话', visibility: 'visible' },
    { id: 'conversation-other', title: '其他对话', visibility: 'visible' }
  ];
  state.agentConversationLinks = [
    { id: 'acl-target', agentId: 'main', conversationId: 'conversation-target', role: 'default' },
    { id: 'acl-target-reviewer', agentId: 'explore', conversationId: 'conversation-target', role: 'reviewer' },
    { id: 'acl-other', agentId: 'explore', conversationId: 'conversation-other', role: 'default' }
  ];
  state.conversationAgentSelections = [
    {
      id: 'conversation-agent:conversation-target:main',
      conversationId: 'conversation-target',
      agentId: 'main',
      role: 'active',
      createdAt: 1,
      updatedAt: 2
    },
    {
      id: 'conversation-agent:conversation-other:explore',
      conversationId: 'conversation-other',
      agentId: 'explore',
      role: 'active',
      createdAt: 3,
      updatedAt: 4
    }
  ];
  return state;
}

test('conversation snapshot carries only the target conversation Agent relations', () => {
  const projected = projectConversationClientState(createStateWithConversationAgents(), 'conversation-target');

  assert.deepEqual(
    projected.agentConversationLinks.map((link) => link.id),
    ['acl-target', 'acl-target-reviewer']
  );
  assert.deepEqual(
    projected.conversationAgentSelections.map((selection) => selection.id),
    ['conversation-agent:conversation-target:main']
  );
  assert.equal(projected.agentConversationLinks.every((link) => link.conversationId === 'conversation-target'), true);
  assert.equal(projected.conversationAgentSelections.every((selection) => selection.conversationId === 'conversation-target'), true);
});

test('conversation snapshot replaces ACL scope instead of only removing restored links', () => {
  const scope = CLIENT_STATE_TABLES.agentConversationLinks.clientSync.scope;

  assert.deepEqual(scope, {
    kind: 'conversation',
    field: 'conversationId',
    replace: 'replace'
  });
});
