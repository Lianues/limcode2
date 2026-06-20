const assert = require('node:assert/strict');

const {
  workspaceContainsProject,
  normalizeCheckpointPolicy,
  defaultCheckpointToolTriggerForDefinition,
  effectiveCheckpointToolTriggerConfig,
  emptyDirectoryManifest
} = require('../dist/extension/backend/world/modules/checkpoint/policy');

function testWorkspaceContainsProject() {
  assert.equal(workspaceContainsProject(['file:///f%3A/work'], 'file:///f%3A/work/app'), true);
  assert.equal(workspaceContainsProject(['file:///f%3A/work/app'], 'file:///f%3A/work'), false);
  assert.equal(workspaceContainsProject(['file:///f%3A/work/app'], 'file:///f%3A/work/app'), true);
}

function testPolicyNormalizationKeepsGitIgnoreSettings() {
  const policy = normalizeCheckpointPolicy({
    id: 'policy',
    name: 'policy',
    enabled: true,
    useGitignore: true,
    skipPatterns: ['node_modules/', 'dist/**', '*.log', 'node_modules/'],
    triggers: { userMessageAfter: true },
    initialSnapshotMaxBytes: 50 * 1024 * 1024,
    preserveEmptyDirectories: true
  });

  assert.equal(policy.useGitignore, true);
  assert.deepEqual(policy.skipPatterns, ['node_modules/', 'dist/**', '*.log']);
  assert.equal(policy.triggers.userMessageAfter, true);
  assert.equal(policy.triggers.userMessageBefore, true);
  assert.equal(policy.triggers.llmResponseBefore, false);
  assert.equal(policy.triggers.agentRunCompletedBefore, false);
  assert.deepEqual(policy.toolTriggers, {});
}

function testPolicyNormalizationUsesNewTriggerDefaults() {
  const policy = normalizeCheckpointPolicy({ id: 'defaults', name: 'defaults' });
  assert.equal(policy.triggers.userMessageBefore, true);
  assert.equal(policy.triggers.userMessageAfter, false);
  assert.equal(policy.triggers.llmResponseBefore, false);
  assert.equal(policy.triggers.agentRunCompletedBefore, false);
  assert.equal(policy.triggers.agentRunCompletedAfter, false);
}

function testPolicyNormalizationUsesToolTriggerDefaults() {
  const policy = normalizeCheckpointPolicy({
    id: 'tool-defaults',
    name: 'tool-defaults',
    toolTriggers: { custom_tool: { after: true } }
  });
  assert.deepEqual(policy.toolTriggers.custom_tool, { before: true, after: true });
}

function testToolDefinitionCheckpointDefaults() {
  const readTool = { name: 'read_file', metadata: { checkpoint: { before: false, after: false } } };
  const shellTool = { name: 'shell', metadata: { checkpoint: { before: true, after: true } } };
  const switchTool = { name: 'switch_work_environment', metadata: { checkpoint: { before: false, after: false } } };
  const unknownTool = { name: 'custom' };

  assert.deepEqual(defaultCheckpointToolTriggerForDefinition(readTool), { before: false, after: false });
  assert.deepEqual(defaultCheckpointToolTriggerForDefinition(shellTool), { before: true, after: true });
  assert.deepEqual(defaultCheckpointToolTriggerForDefinition(switchTool), { before: false, after: false });
  assert.deepEqual(defaultCheckpointToolTriggerForDefinition(unknownTool), { before: true, after: false });
}

function testEffectiveToolCheckpointConfigMergesOverrides() {
  const tool = { name: 'read_file', metadata: { checkpoint: { before: false, after: false } } };
  assert.deepEqual(effectiveCheckpointToolTriggerConfig('read_file', undefined, tool), { before: false, after: false });
  assert.deepEqual(effectiveCheckpointToolTriggerConfig('read_file', { read_file: { after: true } }, tool), { before: false, after: true });
  assert.deepEqual(effectiveCheckpointToolTriggerConfig('unknown_tool', undefined, undefined), { before: true, after: false });
}

function testEmptyDirectoryManifest() {
  const manifest = emptyDirectoryManifest(['src/empty', 'nested/empty']);
  assert.deepEqual(manifest.emptyDirectories, ['nested/empty', 'src/empty']);
  assert.equal(manifest.schemaVersion, 1);
}

testWorkspaceContainsProject();
testPolicyNormalizationKeepsGitIgnoreSettings();
testPolicyNormalizationUsesNewTriggerDefaults();
testPolicyNormalizationUsesToolTriggerDefaults();
testToolDefinitionCheckpointDefaults();
testEffectiveToolCheckpointConfigMergesOverrides();
testEmptyDirectoryManifest();

console.log('checkpoint-policy tests passed');
