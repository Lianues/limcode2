const assert = require('node:assert/strict');
const test = require('node:test');

const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { Agent, AgentKind } = require('../dist/extension/backend/world/modules/agent/components.js');
const { AgentBlueprintsKey, createDefaultAgentBlueprints } = require('../dist/extension/backend/world/modules/agent/blueprints.js');
const { isRunAgentTemporaryId } = require('../dist/extension/backend/world/modules/agent/identity.js');
const { runAgentTool } = require('../dist/extension/backend/world/modules/tools/definitions/runAgent/index.js');
const { runAgentToolSchemaContributor } = require('../dist/extension/backend/world/modules/tools/runAgentToolSchemaContributor.js');

test('run_agent runtime mirror ids are recognized as temporary agents', () => {
  assert.equal(isRunAgentTemporaryId('agent-worker-mirror-mrui6ql0-sxsjim06', 'worker'), true);
  assert.equal(isRunAgentTemporaryId('agent-reviewer-mirror-mrv22cok-yruqmk9o', 'reviewer'), true);
  assert.equal(isRunAgentTemporaryId('agent-worker', 'worker'), false);
  assert.equal(isRunAgentTemporaryId('worker', 'worker'), false);
});

test('run_agent schema lists agent types without exposing runtime mirror ids', () => {
  const world = new MapWorld();
  world.setResource(AgentBlueprintsKey, createDefaultAgentBlueprints());
  addAgent(world, {
    id: 'agent-worker-mirror-mrui6ql0-sxsjim06',
    kind: 'worker',
    name: 'Worker Agent',
    description: 'Runtime mirror that must stay hidden'
  });
  addAgent(world, {
    id: 'custom-reviewer',
    kind: 'reviewer',
    name: 'Custom Reviewer',
    description: 'Custom review configuration'
  });

  const [tool] = runAgentToolSchemaContributor.augment(
    [runAgentTool.declaration],
    { world, run: 0, conversation: 0 }
  );

  assert.match(tool.description, /- worker: General-purpose worker Agent capable of multi-step tool operations\./);
  assert.match(tool.description, /- custom-reviewer: Custom review configuration/);
  assert.doesNotMatch(tool.description, /agent-worker-mirror-/);
  assert.doesNotMatch(agentTypeDescription(tool), /agent-worker-mirror-/);
  assert.match(agentTypeDescription(tool), /Runtime mirror ids are internal implementation details/);
});

function addAgent(world, input) {
  const entity = world.spawn();
  world.add(entity, Agent, {
    id: input.id,
    name: input.name,
    description: input.description,
    source: input.source ?? 'builtin'
  });
  world.add(entity, AgentKind, { kind: input.kind });
  return entity;
}

function agentTypeDescription(tool) {
  return tool.parameters.properties.agent.properties.type.description;
}
