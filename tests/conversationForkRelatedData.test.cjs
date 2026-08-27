const assert = require('node:assert/strict');
const test = require('node:test');
const { MapWorld } = require('../dist/extension/backend/ecs/World.js');
const { forkConversationInWorld } = require('../dist/extension/backend/application/conversationFork.js');
const {
  Agent,
  AgentConversationLink
} = require('../dist/extension/backend/world/modules/agent/components.js');
const {
  Conversation,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} = require('../dist/extension/backend/world/modules/chat/components.js');
const {
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy
} = require('../dist/extension/backend/world/modules/workflow/components.js');
const {
  ConversationProjectLink,
  ProjectContext
} = require('../dist/extension/backend/world/modules/project/components.js');
const {
  ToolCall,
  ToolPolicyScopeLink,
  ToolResultConsumed,
  ToolState
} = require('../dist/extension/backend/world/modules/tools/components.js');
const {
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} = require('../dist/extension/backend/world/modules/workEnvironment/components.js');
const {
  CompressionBlock,
  CompressionBlockSourceLink,
  CompressionContextVariant
} = require('../dist/extension/backend/world/modules/compression/components.js');
const {
  SkillPolicy,
  SkillPolicyScopeLink
} = require('../dist/extension/backend/world/modules/skill/components.js');
const {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot
} = require('../dist/extension/backend/world/modules/runtimeContext/components.js');
const {
  PlanReviewPolicy,
  PlanReviewPolicyScopeLink
} = require('../dist/extension/backend/world/modules/plan/components.js');
const {
  Checkpoint,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  CheckpointTimelineAnchor,
  ConversationCheckpointRepositoryLink,
  ShadowRepository
} = require('../dist/extension/backend/world/modules/checkpoint/components.js');
const {
  selectRunContextCompressionVariant
} = require('../dist/extension/backend/world/modules/agentRun/contextPolicy.js');

function addForkSource(world, id) {
  const agent = world.spawn();
  world.add(agent, Agent, { id: `agent-${id}`, name: 'Agent', source: 'builtin' });
  const conversation = world.spawn();
  world.add(conversation, Conversation, { id, title: '源对话', visibility: 'visible' });
  const link = world.spawn();
  world.add(link, AgentConversationLink, {
    id: `agent-link-${id}`,
    agent,
    conversation,
    role: 'default',
    createdAt: 1,
    updatedAt: 1
  });
  return { agent, conversation };
}

function addMessage(world, conversation, input) {
  const entity = world.spawn();
  const content = { role: input.role, parts: input.parts };
  world.add(entity, Message, {
    id: input.id,
    role: input.role,
    content,
    status: 'complete',
    seq: input.seq,
    createdAt: input.createdAt
  });
  world.add(entity, PartOf, { parent: conversation });
  const revision = world.spawn();
  world.add(revision, MessageRevision, {
    id: `revision-${input.id}`,
    content,
    createdAt: input.createdAt,
    reason: 'created'
  });
  world.add(revision, PartOf, { parent: entity });
  const current = world.spawn();
  world.add(current, MessageCurrentRevisionLink, {
    id: `current-${input.id}`,
    message: entity,
    revision
  });
  return { entity, revision };
}

function targetMessages(world, conversation) {
  return world.query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf).parent === conversation)
    .sort((left, right) => world.get(left, Message).seq - world.get(right, Message).seq);
}

test('fork 深拷贝多模态内容并将历史工具结果标记为已消费', () => {
  const world = new MapWorld();
  const { conversation: source } = addForkSource(world, 'source-multimodal');
  const first = addMessage(world, source, {
    id: 'multi-1',
    role: 'user',
    parts: [
      { text: '请分析附件' },
      { inlineData: { mimeType: 'image/png', attachmentId: 'attachment-managed', name: 'image.png', storage: 'managed', status: 'available', sizeBytes: 12 } },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRm', name: 'doc.pdf', storage: 'embedded', status: 'available', sizeBytes: 3 } },
      { inlineData: { mimeType: 'text/plain', sourcePath: 'C:\\tmp\\note.txt', name: 'note.txt', storage: 'localPath', status: 'available', sizeBytes: 8 } },
      { fileData: { mimeType: 'text/plain', uri: 'file:///tmp/readme.txt' } }
    ],
    seq: 100,
    createdAt: 100
  });
  const model = addMessage(world, source, {
    id: 'multi-2',
    role: 'model',
    parts: [{ id: 'multi-call', functionCall: { name: 'read', args: { path: 'image.png' } } }],
    seq: 200,
    createdAt: 200
  });
  addMessage(world, source, {
    id: 'multi-response',
    role: 'user',
    parts: [{
      id: 'multi-call',
      functionResponse: {
        name: 'read',
        response: { ok: true },
        parts: [{ inlineData: { mimeType: 'image/webp', attachmentId: 'attachment-tool', name: 'tool.webp', storage: 'managed', status: 'available', sizeBytes: 20 } }]
      }
    }],
    seq: 250,
    createdAt: 250
  });
  const tool = world.spawn();
  world.add(tool, ToolCall, { id: 'multi-tool', functionCallId: 'multi-call', name: 'read', argsJson: '{}', createdAt: 210 });
  world.add(tool, PartOf, { parent: model.entity });
  world.add(tool, ToolState, { status: 'success', updatedAt: 240, result: { ok: true } });

  const result = forkConversationInWorld(world, {
    sourceConversationId: 'source-multimodal',
    throughMessageId: 'multi-2',
    targetConversationId: 'fork-multimodal',
    now: 1_000
  });
  const messages = targetMessages(world, result.conversation);
  assert.equal(messages.length, 3);
  assert.deepEqual(world.get(messages[0], Message).content.parts, world.get(first.entity, Message).content.parts);
  assert.notStrictEqual(world.get(messages[0], Message).content, world.get(first.entity, Message).content);
  assert.notStrictEqual(world.get(messages[0], Message).content.parts[1].inlineData, world.get(first.entity, Message).content.parts[1].inlineData);
  assert.deepEqual(world.get(messages[2], Message).content.parts[0].functionResponse.parts, [
    { inlineData: { mimeType: 'image/webp', attachmentId: 'attachment-tool', name: 'tool.webp', storage: 'managed', status: 'available', sizeBytes: 20 } }
  ]);
  const targetTool = world.query(ToolCall, PartOf)
    .find((entity) => world.get(entity, PartOf).parent === messages[1]);
  assert.ok(targetTool);
  assert.equal(world.has(targetTool, ToolResultConsumed), true);
});

test('fork 复制边界内的压缩总结链并重映射消息、Revision 与 retained block', () => {
  const world = new MapWorld();
  const { conversation: source } = addForkSource(world, 'source-compression');
  const first = addMessage(world, source, { id: 'compression-message-1', role: 'user', parts: [{ text: '第一轮' }], seq: 100, createdAt: 100 });
  const second = addMessage(world, source, { id: 'compression-message-2', role: 'model', parts: [{ text: '第二轮' }], seq: 200, createdAt: 200 });
  const third = addMessage(world, source, { id: 'compression-message-3', role: 'user', parts: [{ text: '未来内容' }], seq: 300, createdAt: 300 });

  const block1 = world.spawn();
  world.add(block1, CompressionBlock, {
    id: 'compression-block-1', conversation: source, title: '总结 1', status: 'complete', methodKind: 'segmented_summary',
    anchorMessageId: 'compression-message-1', anchorSeq: 100, startSeq: 100, endSeq: 100, sourceMessageCount: 1,
    createdAt: 110, updatedAt: 120, completedAt: 120
  });
  const block1Source = world.spawn();
  world.add(block1Source, CompressionBlockSourceLink, {
    id: 'compression-source-1', block: block1, source: first.entity, sourceKind: 'message', sourceId: 'compression-message-1',
    revisionId: 'revision-compression-message-1', role: 'anchor', order: 0, createdAt: 110, updatedAt: 110
  });
  const variant1 = world.spawn();
  world.add(variant1, CompressionContextVariant, {
    id: 'compression-variant-1', block: block1, kind: 'provider_neutral_summary',
    contents: [{ role: 'model', parts: [{ text: '<summary>第一轮摘要</summary>' }] }], createdAt: 120, updatedAt: 120
  });

  const block2 = world.spawn();
  world.add(block2, CompressionBlock, {
    id: 'compression-block-2', conversation: source, title: '总结 2', status: 'complete', methodKind: 'segmented_summary',
    anchorMessageId: 'compression-message-2', anchorSeq: 200, startSeq: 100, endSeq: 200, sourceMessageCount: 2,
    createdAt: 210, updatedAt: 220, completedAt: 220
  });
  const retained = world.spawn();
  world.add(retained, CompressionBlockSourceLink, {
    id: 'compression-source-retained', block: block2, source: block1, sourceKind: 'compressionBlock', sourceId: 'compression-block-1',
    role: 'retained', order: 0, createdAt: 210, updatedAt: 210
  });
  const block2Source = world.spawn();
  world.add(block2Source, CompressionBlockSourceLink, {
    id: 'compression-source-2', block: block2, source: second.entity, sourceKind: 'message', sourceId: 'compression-message-2',
    revisionId: 'revision-compression-message-2', role: 'anchor', order: 1, createdAt: 210, updatedAt: 210
  });
  const variant2 = world.spawn();
  world.add(variant2, CompressionContextVariant, {
    id: 'compression-variant-2', block: block2, kind: 'provider_neutral_summary',
    contents: [{ role: 'model', parts: [{ text: '<summary>累计摘要</summary>' }] }], createdAt: 220, updatedAt: 220
  });

  const futureBlock = world.spawn();
  world.add(futureBlock, CompressionBlock, {
    id: 'compression-block-future', conversation: source, title: '未来总结', status: 'complete', methodKind: 'segmented_summary',
    anchorMessageId: 'compression-message-3', anchorSeq: 300, startSeq: 100, endSeq: 300, sourceMessageCount: 3,
    createdAt: 310, updatedAt: 320, completedAt: 320
  });
  const futureSource = world.spawn();
  world.add(futureSource, CompressionBlockSourceLink, {
    id: 'compression-source-future', block: futureBlock, source: third.entity, sourceKind: 'message', sourceId: 'compression-message-3',
    revisionId: 'revision-compression-message-3', role: 'anchor', order: 0, createdAt: 310, updatedAt: 310
  });
  const runningBlock = world.spawn();
  world.add(runningBlock, CompressionBlock, {
    id: 'compression-block-running', conversation: source, title: '运行中', status: 'running', methodKind: 'segmented_summary',
    anchorMessageId: 'compression-message-2', anchorSeq: 200, startSeq: 100, endSeq: 200, sourceMessageCount: 2,
    createdAt: 215, updatedAt: 215
  });

  const result = forkConversationInWorld(world, {
    sourceConversationId: 'source-compression',
    throughMessageId: 'compression-message-2',
    targetConversationId: 'fork-compression',
    now: 1_000
  });
  const messages = targetMessages(world, result.conversation);
  const blocks = world.query(CompressionBlock)
    .filter((entity) => world.get(entity, CompressionBlock).conversation === result.conversation)
    .sort((left, right) => world.get(left, CompressionBlock).endSeq - world.get(right, CompressionBlock).endSeq);
  assert.equal(blocks.length, 2);
  const targetBlock1 = world.get(blocks[0], CompressionBlock);
  const targetBlock2 = world.get(blocks[1], CompressionBlock);
  assert.notEqual(targetBlock1.id, 'compression-block-1');
  assert.notEqual(targetBlock2.id, 'compression-block-2');
  assert.equal(targetBlock1.anchorMessageId, world.get(messages[0], Message).id);
  assert.equal(targetBlock2.anchorMessageId, world.get(messages[1], Message).id);

  const links = world.query(CompressionBlockSourceLink)
    .map((entity) => world.get(entity, CompressionBlockSourceLink))
    .filter((link) => blocks.includes(link.block));
  const targetMessageLink1 = links.find((link) => link.block === blocks[0] && link.sourceKind === 'message');
  const targetRetained = links.find((link) => link.block === blocks[1] && link.sourceKind === 'compressionBlock');
  const targetMessageLink2 = links.find((link) => link.block === blocks[1] && link.sourceKind === 'message');
  assert.equal(targetMessageLink1.source, messages[0]);
  assert.equal(targetMessageLink1.sourceId, world.get(messages[0], Message).id);
  assert.notEqual(targetMessageLink1.revisionId, 'revision-compression-message-1');
  assert.equal(targetRetained.source, blocks[0]);
  assert.equal(targetRetained.sourceId, targetBlock1.id);
  assert.equal(targetMessageLink2.source, messages[1]);
  assert.notEqual(targetMessageLink2.revisionId, 'revision-compression-message-2');

  const selected = selectRunContextCompressionVariant(world, result.conversation);
  assert.ok(selected);
  assert.equal(selected.block, blocks[1]);
  const selectedVariant = world.get(selected.variant, CompressionContextVariant);
  assert.deepEqual(selectedVariant.contents, [{ role: 'model', parts: [{ text: '<summary>累计摘要</summary>' }] }]);
  assert.notStrictEqual(selectedVariant.contents, world.get(variant2, CompressionContextVariant).contents);
});

test('fork 复制 Conversation 配置、冻结运行时上下文和边界内 Checkpoint 图', () => {
  const world = new MapWorld();
  const { conversation: source } = addForkSource(world, 'source-context');
  addMessage(world, source, { id: 'context-message-1', role: 'user', parts: [{ text: '开始' }], seq: 100, createdAt: 100 });
  const second = addMessage(world, source, {
    id: 'context-message-2', role: 'model', parts: [{ id: 'context-call', functionCall: { name: 'edit', args: { path: 'a.ts' } } }, { text: '完成修改' }],
    seq: 200, createdAt: 200
  });
  addMessage(world, source, {
    id: 'context-response', role: 'user', parts: [{ id: 'context-call', functionResponse: { name: 'edit', response: { ok: true } } }],
    seq: 250, createdAt: 250
  });
  const future = addMessage(world, source, { id: 'context-message-3', role: 'user', parts: [{ text: '未来' }], seq: 300, createdAt: 300 });
  const sourceTool = world.spawn();
  world.add(sourceTool, ToolCall, { id: 'context-tool', functionCallId: 'context-call', name: 'edit', argsJson: '{"path":"a.ts"}', createdAt: 210 });
  world.add(sourceTool, PartOf, { parent: second.entity });
  world.add(sourceTool, ToolState, { status: 'success', updatedAt: 240, result: { ok: true } });

  const systemPrompt = world.spawn();
  world.add(systemPrompt, SystemPrompt, { id: 'system-prompt:conversation:source-context', name: '对话提示词', text: '只修改必要文件' });
  const systemPromptLink = world.spawn();
  world.add(systemPromptLink, SystemPromptScopeLink, { id: 'system-prompt-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', systemPrompt, conversation: source, role: 'active', order: 2, createdAt: 1, updatedAt: 2 });

  const modelProfile = world.spawn();
  world.add(modelProfile, ModelProfile, { id: 'model-profile:conversation:source-context', name: '对话模型', providerConfigId: 'provider-1', provider: 'openai-responses', model: 'model-a' });
  const modelProfileLink = world.spawn();
  world.add(modelProfileLink, ModelProfileScopeLink, { id: 'model-profile-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', modelProfile, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const runtimeContext = world.spawn();
  world.add(runtimeContext, RuntimeContext, { id: 'runtime-context:conversation:source-context', name: '对话运行时上下文', template: 'workspace={{$workspace.uri}}' });
  const runtimeContextLink = world.spawn();
  world.add(runtimeContextLink, RuntimeContextScopeLink, { id: 'runtime-context-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', runtimeContext, conversation: source, role: 'active', order: 3, createdAt: 1, updatedAt: 2 });

  const toolPolicy = world.spawn();
  world.add(toolPolicy, ToolPolicy, { id: 'tool-policy:conversation:source-context', name: '对话工具策略', allowedTools: ['read', 'edit'], preset: 'custom', toolConfigs: { edit: { config: { mode: 'safe' } } } });
  const toolPolicyLink = world.spawn();
  world.add(toolPolicyLink, ToolPolicyScopeLink, { id: 'tool-policy-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', toolPolicy, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const skillPolicy = world.spawn();
  world.add(skillPolicy, SkillPolicy, { id: 'shared-skill-policy', name: '共享技能策略', sourceConfigs: { global: { enabled: true, disabledSkills: ['skill-x'] } } });
  const skillPolicyLink = world.spawn();
  world.add(skillPolicyLink, SkillPolicyScopeLink, { id: 'skill-policy-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', skillPolicy, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const planPolicy = world.spawn();
  world.add(planPolicy, PlanReviewPolicy, { id: 'plan-review-policy:conversation:source-context', mode: 'before_mutation', allowReadonlyBeforeApproval: true, requireForToolRiskLevels: ['write'], createdAt: 1, updatedAt: 2 });
  const planPolicyLink = world.spawn();
  world.add(planPolicyLink, PlanReviewPolicyScopeLink, { id: 'plan-review-policy-link:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', planReviewPolicy: planPolicy, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const workPolicy = world.spawn();
  world.add(workPolicy, WorkEnvironmentPolicy, { id: 'work-environment-policy:conversation:source-context', name: '对话环境策略', enabled: true, allowedWorkEnvironmentIds: ['work-1'], defaultWorkEnvironmentId: 'work-1', createdAt: 1, updatedAt: 2 });
  const workPolicyLink = world.spawn();
  world.add(workPolicyLink, WorkEnvironmentPolicyScopeLink, { id: 'work-environment-policy-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', policy: workPolicy, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const checkpointPolicy = world.spawn();
  world.add(checkpointPolicy, CheckpointPolicy, {
    id: 'checkpoint-policy:conversation:source-context', name: '对话存档策略', enabled: true, initialSnapshotMaxBytes: 1024,
    preserveEmptyDirectories: true, useGitignore: true, skipPatterns: ['dist'],
    triggers: { conversationInitial: true, userMessageBefore: true, userMessageAfter: true, llmResponseBefore: false, llmResponseAfter: true, agentRunCompletedBefore: false, agentRunCompletedAfter: true, manual: true },
    toolTriggers: { edit: { before: true, after: true } }, createdAt: 1, updatedAt: 2
  });
  const checkpointPolicyLink = world.spawn();
  world.add(checkpointPolicyLink, CheckpointPolicyScopeLink, { id: 'checkpoint-policy-scope:conversation:source-context', scopeKind: 'conversation', scopeId: 'source-context', checkpointPolicy, conversation: source, role: 'active', createdAt: 1, updatedAt: 2 });

  const snapshot = world.spawn();
  world.add(snapshot, RuntimeContextSnapshot, {
    id: 'runtime-context-snapshot-source', name: '运行时上下文快照', text: 'Initial time: 2026-01-01T00:00:00.000Z',
    template: 'Initial time: {{$runtime.timestamp}}', conversation: source, sourceRuntimeContexts: [runtimeContext], sourceHash: 'hash-1',
    createdAt: 10, updatedAt: 10, refreshedAt: 10
  });
  const snapshotLink = world.spawn();
  world.add(snapshotLink, ConversationRuntimeContextSnapshotLink, { id: 'conversation-runtime-context:source-context', conversation: source, snapshot, role: 'active', createdAt: 10, updatedAt: 10 });

  const project = world.spawn();
  world.add(project, ProjectContext, { id: 'project-context', kind: 'folder', uri: 'file:///repo', name: 'repo', createdAt: 1, updatedAt: 1 });
  const projectLink = world.spawn();
  world.add(projectLink, ConversationProjectLink, { id: 'project-link-context', conversation: source, projectContext: project, role: 'primary', createdAt: 1, updatedAt: 1 });
  const shadow = world.spawn();
  world.add(shadow, ShadowRepository, { id: 'shadow-repository:source-context:repo', storageKey: 'shadow-source-context-repo', createdAt: 1, updatedAt: 1 });
  const repositoryLink = world.spawn();
  world.add(repositoryLink, ConversationCheckpointRepositoryLink, {
    id: 'checkpoint-repository-link-source', conversation: source, projectContext: project, shadowRepository: shadow,
    projectUri: 'file:///repo', projectDisplayPath: 'repo', role: 'active', createdAt: 1, updatedAt: 1
  });

  const initialCheckpoint = world.spawn();
  world.add(initialCheckpoint, Checkpoint, {
    id: 'checkpoint-initial', conversation: source, projectContext: project, shadowRepository: shadow, trigger: 'conversation_initial', status: 'created',
    projectUri: 'file:///repo', projectDisplayPath: 'repo', createdAt: 50, updatedAt: 50, commitSha: 'initial-sha'
  });
  const anchoredCheckpoint = world.spawn();
  world.add(anchoredCheckpoint, Checkpoint, {
    id: 'checkpoint-anchored', conversation: source, projectContext: project, shadowRepository: shadow, trigger: 'tool_execution_after', status: 'created',
    projectUri: 'file:///repo', projectDisplayPath: 'repo', createdAt: 220, updatedAt: 220, commitSha: 'tool-sha'
  });
  const anchoredLink = world.spawn();
  world.add(anchoredLink, CheckpointTimelineAnchor, {
    id: 'checkpoint-timeline-anchor:checkpoint-anchored', conversation: source, checkpoint: anchoredCheckpoint,
    floorMessage: second.entity, floorMessageId: 'context-message-2', position: 'after', order: 220,
    sourceToolCall: sourceTool, sourceToolCallId: 'context-tool', createdAt: 220, updatedAt: 220
  });
  const futureCheckpoint = world.spawn();
  world.add(futureCheckpoint, Checkpoint, {
    id: 'checkpoint-future', conversation: source, projectContext: project, shadowRepository: shadow, trigger: 'manual', status: 'created',
    projectUri: 'file:///repo', projectDisplayPath: 'repo', createdAt: 320, updatedAt: 320, commitSha: 'future-sha'
  });
  const futureAnchor = world.spawn();
  world.add(futureAnchor, CheckpointTimelineAnchor, {
    id: 'checkpoint-timeline-anchor:checkpoint-future', conversation: source, checkpoint: futureCheckpoint,
    floorMessage: future.entity, floorMessageId: 'context-message-3', position: 'after', order: 320, createdAt: 320, updatedAt: 320
  });

  const result = forkConversationInWorld(world, {
    sourceConversationId: 'source-context',
    throughMessageId: 'context-message-2',
    targetConversationId: 'fork-context',
    now: 1_000
  });

  const targetPromptLink = world.query(SystemPromptScopeLink).map((entity) => world.get(entity, SystemPromptScopeLink)).find((link) => link.conversation === result.conversation);
  const targetPrompt = world.get(targetPromptLink.systemPrompt, SystemPrompt);
  assert.equal(targetPrompt.id, 'system-prompt:conversation:fork-context');
  assert.notEqual(targetPromptLink.systemPrompt, systemPrompt);
  world.add(targetPromptLink.systemPrompt, SystemPrompt, { ...targetPrompt, text: '目标分支独立提示词' });
  assert.equal(world.get(systemPrompt, SystemPrompt).text, '只修改必要文件');

  const targetModelLink = world.query(ModelProfileScopeLink).map((entity) => world.get(entity, ModelProfileScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(world.get(targetModelLink.modelProfile, ModelProfile).id, 'model-profile:conversation:fork-context');
  assert.notEqual(targetModelLink.modelProfile, modelProfile);
  const targetToolPolicyLink = world.query(ToolPolicyScopeLink).map((entity) => world.get(entity, ToolPolicyScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(world.get(targetToolPolicyLink.toolPolicy, ToolPolicy).id, 'tool-policy:conversation:fork-context');
  assert.notEqual(targetToolPolicyLink.toolPolicy, toolPolicy);
  const targetSkillPolicyLink = world.query(SkillPolicyScopeLink).map((entity) => world.get(entity, SkillPolicyScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(targetSkillPolicyLink.skillPolicy, skillPolicy);
  assert.equal(world.get(targetSkillPolicyLink.skillPolicy, SkillPolicy).id, 'shared-skill-policy');
  const targetPlanPolicyLink = world.query(PlanReviewPolicyScopeLink).map((entity) => world.get(entity, PlanReviewPolicyScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(world.get(targetPlanPolicyLink.planReviewPolicy, PlanReviewPolicy).id, 'plan-review-policy:conversation:fork-context');
  const targetWorkPolicyLink = world.query(WorkEnvironmentPolicyScopeLink).map((entity) => world.get(entity, WorkEnvironmentPolicyScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(world.get(targetWorkPolicyLink.policy, WorkEnvironmentPolicy).id, 'work-environment-policy:conversation:fork-context');
  const targetCheckpointPolicyLink = world.query(CheckpointPolicyScopeLink).map((entity) => world.get(entity, CheckpointPolicyScopeLink)).find((link) => link.conversation === result.conversation);
  assert.equal(world.get(targetCheckpointPolicyLink.checkpointPolicy, CheckpointPolicy).id, 'checkpoint-policy:conversation:fork-context');
  const targetRuntimeContextLink = world.query(RuntimeContextScopeLink).map((entity) => world.get(entity, RuntimeContextScopeLink)).find((link) => link.conversation === result.conversation);
  const targetRuntimeContext = targetRuntimeContextLink.runtimeContext;
  assert.equal(world.get(targetRuntimeContext, RuntimeContext).id, 'runtime-context:conversation:fork-context');

  const targetSnapshotLink = world.query(ConversationRuntimeContextSnapshotLink)
    .map((entity) => world.get(entity, ConversationRuntimeContextSnapshotLink))
    .find((link) => link.conversation === result.conversation);
  const targetSnapshot = world.get(targetSnapshotLink.snapshot, RuntimeContextSnapshot);
  assert.notEqual(targetSnapshotLink.snapshot, snapshot);
  assert.equal(targetSnapshot.conversation, result.conversation);
  assert.equal(targetSnapshot.text, 'Initial time: 2026-01-01T00:00:00.000Z');
  assert.deepEqual(targetSnapshot.sourceRuntimeContexts, [targetRuntimeContext]);

  const messages = targetMessages(world, result.conversation);
  const targetModelMessage = messages.find((entity) => world.get(entity, Message).seq === 200);
  const targetTool = world.query(ToolCall, PartOf).find((entity) => world.get(entity, PartOf).parent === targetModelMessage);
  const checkpoints = world.query(Checkpoint).filter((entity) => world.get(entity, Checkpoint).conversation === result.conversation);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints.some((entity) => world.get(entity, Checkpoint).commitSha === 'future-sha'), false);
  assert.equal(checkpoints.every((entity) => world.get(entity, Checkpoint).shadowRepository === shadow), true);
  const anchors = world.query(CheckpointTimelineAnchor)
    .map((entity) => world.get(entity, CheckpointTimelineAnchor))
    .filter((anchor) => anchor.conversation === result.conversation);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].floorMessage, targetModelMessage);
  assert.equal(anchors[0].floorMessageId, world.get(targetModelMessage, Message).id);
  assert.equal(anchors[0].sourceToolCall, targetTool);
  assert.equal(anchors[0].sourceToolCallId, world.get(targetTool, ToolCall).id);
  assert.equal(anchors[0].sourceRun, undefined);
  assert.equal(anchors[0].sourceRunId, undefined);
  const repositoryLinks = world.query(ConversationCheckpointRepositoryLink)
    .map((entity) => world.get(entity, ConversationCheckpointRepositoryLink))
    .filter((link) => link.conversation === result.conversation);
  assert.equal(repositoryLinks.length, 1);
  assert.equal(repositoryLinks[0].role, 'history');
  assert.equal(repositoryLinks[0].shadowRepository, shadow);
});
