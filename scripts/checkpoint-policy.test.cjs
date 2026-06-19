const assert = require('node:assert/strict');

const {
  workspaceContainsProject,
  normalizeCheckpointPolicy,
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
  assert.equal(policy.triggers.toolExecutionBefore, true);
}

function testEmptyDirectoryManifest() {
  const manifest = emptyDirectoryManifest(['src/empty', 'nested/empty']);
  assert.deepEqual(manifest.emptyDirectories, ['nested/empty', 'src/empty']);
  assert.equal(manifest.schemaVersion, 1);
}

testWorkspaceContainsProject();
testPolicyNormalizationKeepsGitIgnoreSettings();
testEmptyDirectoryManifest();

console.log('checkpoint-policy tests passed');
