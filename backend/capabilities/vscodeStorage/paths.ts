import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENTS_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  ATTACHMENTS_ROOT_DIR,
  CONVERSATION_AGENT_SELECTIONS_ROOT_DIR,
  CONVERSATION_WORKFLOW_SELECTIONS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  INDEX_FILE,
  LLM_SETTINGS_FILE,
  WORKFLOWS_ROOT_DIR,
  MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  RUNTIME_CONTEXTS_ROOT_DIR,
  RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR,
  RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR,
  CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  RUN_HISTORY_ROOT_DIR,
  AGENT_ANSWERS_ROOT_DIR,
  AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR,
  AGENT_ANSWER_TARGET_LINKS_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  BACKGROUND_COMMANDS_ROOT_DIR,
  SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  TOOL_POLICY_SCOPE_LINKS_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR,
  SKILL_POLICIES_ROOT_DIR,
  SKILL_POLICY_SCOPE_LINKS_ROOT_DIR,
  WORK_ENVIRONMENTS_ROOT_DIR,
  CONVERSATION_WORK_ENVIRONMENT_LINKS_ROOT_DIR,
  RUN_WORK_ENVIRONMENT_LINKS_ROOT_DIR,
  WORK_ENVIRONMENT_POLICIES_ROOT_DIR,
  WORK_ENVIRONMENT_POLICY_SCOPE_LINKS_ROOT_DIR,
  CHECKPOINT_POLICIES_ROOT_DIR,
  CHECKPOINT_POLICY_SCOPE_LINKS_ROOT_DIR,
  SHADOW_REPOSITORIES_ROOT_DIR,
  CONVERSATION_CHECKPOINT_REPOSITORY_LINKS_ROOT_DIR,
  CHECKPOINTS_ROOT_DIR,
  CHECKPOINT_TIMELINE_ANCHORS_ROOT_DIR,
  CHECKPOINT_SHADOW_WORKTREES_ROOT_DIR,
  COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR,
  COMPRESSION_BLOCKS_ROOT_DIR,
  COMPRESSION_LLM_INVOCATIONS_ROOT_DIR,
  COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR,
  COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR
} from './constants';

export interface VscodeStorageUris {
  agentsRootUri: vscode.Uri;
  agentsIndexUri: vscode.Uri;
  workflowsRootUri: vscode.Uri;
  workflowsIndexUri: vscode.Uri;
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesIndexUri: vscode.Uri;
  toolPolicyScopeLinksRootUri: vscode.Uri;
  toolPolicyScopeLinksIndexUri: vscode.Uri;
  skillPoliciesRootUri: vscode.Uri;
  skillPoliciesIndexUri: vscode.Uri;
  skillPolicyScopeLinksRootUri: vscode.Uri;
  skillPolicyScopeLinksIndexUri: vscode.Uri;
  systemPromptsRootUri: vscode.Uri;
  systemPromptsIndexUri: vscode.Uri;
  runtimeContextsRootUri: vscode.Uri;
  runtimeContextsIndexUri: vscode.Uri;
  runtimeContextScopeLinksRootUri: vscode.Uri;
  runtimeContextScopeLinksIndexUri: vscode.Uri;
  runtimeContextSnapshotsRootUri: vscode.Uri;
  runtimeContextSnapshotsIndexUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  conversationRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  runRuntimeContextSnapshotLinksRootUri: vscode.Uri;
  runRuntimeContextSnapshotLinksIndexUri: vscode.Uri;
  modelProfilesRootUri: vscode.Uri;
  modelProfilesIndexUri: vscode.Uri;
  conversationsRootUri: vscode.Uri;
  conversationsIndexUri: vscode.Uri;
  conversationHistoryRootUri: vscode.Uri;
  conversationHistoryIndexUri: vscode.Uri;
  attachmentsRootUri: vscode.Uri;
  attachmentsIndexUri: vscode.Uri;
  projectContextsRootUri: vscode.Uri;
  projectContextsIndexUri: vscode.Uri;
  conversationProjectLinksRootUri: vscode.Uri;
  conversationProjectLinksIndexUri: vscode.Uri;
  workEnvironmentsRootUri: vscode.Uri;
  workEnvironmentsIndexUri: vscode.Uri;
  workEnvironmentPoliciesRootUri: vscode.Uri;
  workEnvironmentPoliciesIndexUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksRootUri: vscode.Uri;
  workEnvironmentPolicyScopeLinksIndexUri: vscode.Uri;
  conversationWorkEnvironmentLinksRootUri: vscode.Uri;
  conversationWorkEnvironmentLinksIndexUri: vscode.Uri;
  runWorkEnvironmentLinksRootUri: vscode.Uri;
  runWorkEnvironmentLinksIndexUri: vscode.Uri;
  checkpointPoliciesRootUri: vscode.Uri;
  checkpointPoliciesIndexUri: vscode.Uri;
  checkpointPolicyScopeLinksRootUri: vscode.Uri;
  checkpointPolicyScopeLinksIndexUri: vscode.Uri;
  shadowRepositoriesRootUri: vscode.Uri;
  shadowRepositoriesIndexUri: vscode.Uri;
  conversationCheckpointRepositoryLinksRootUri: vscode.Uri;
  conversationCheckpointRepositoryLinksIndexUri: vscode.Uri;
  checkpointsRootUri: vscode.Uri;
  checkpointsIndexUri: vscode.Uri;
  checkpointTimelineAnchorsRootUri: vscode.Uri;
  checkpointTimelineAnchorsIndexUri: vscode.Uri;
  checkpointShadowWorktreesRootUri: vscode.Uri;
  compressionBlocksRootUri: vscode.Uri;
  compressionBlocksIndexUri: vscode.Uri;
  compressionBlockSourceLinksRootUri: vscode.Uri;
  compressionBlockSourceLinksIndexUri: vscode.Uri;
  compressionContextVariantsRootUri: vscode.Uri;
  compressionContextVariantsIndexUri: vscode.Uri;
  compressionBlockLlmInvocationLinksRootUri: vscode.Uri;
  compressionBlockLlmInvocationLinksIndexUri: vscode.Uri;
  compressionLlmInvocationsRootUri: vscode.Uri;
  compressionLlmInvocationsIndexUri: vscode.Uri;
  linksRootUri: vscode.Uri;
  linksIndexUri: vscode.Uri;
  systemPromptScopeLinksRootUri: vscode.Uri;
  systemPromptScopeLinksIndexUri: vscode.Uri;
  modelProfileScopeLinksRootUri: vscode.Uri;
  modelProfileScopeLinksIndexUri: vscode.Uri;
  conversationWorkflowSelectionsRootUri: vscode.Uri;
  conversationWorkflowSelectionsIndexUri: vscode.Uri;
  conversationAgentSelectionsRootUri: vscode.Uri;
  conversationAgentSelectionsIndexUri: vscode.Uri;
  runHistoryRootUri: vscode.Uri;
  runHistoryIndexUri: vscode.Uri;
  agentAnswersRootUri: vscode.Uri;
  agentAnswersIndexUri: vscode.Uri;
  agentAnswerSubmissionLinksRootUri: vscode.Uri;
  agentAnswerSubmissionLinksIndexUri: vscode.Uri;
  agentAnswerTargetLinksRootUri: vscode.Uri;
  agentAnswerTargetLinksIndexUri: vscode.Uri;
  backgroundCommandsRootUri: vscode.Uri;
  backgroundCommandsIndexUri: vscode.Uri;
  settingsRootUri: vscode.Uri;
  llmSettingsUri: vscode.Uri;
}

function root(globalStorageUri: vscode.Uri, dir: string): { rootUri: vscode.Uri; indexUri: vscode.Uri } {
  const rootUri = vscode.Uri.joinPath(globalStorageUri, dir);
  return { rootUri, indexUri: vscode.Uri.joinPath(rootUri, INDEX_FILE) };
}

export function createVscodeStoragePaths(globalStorageUri: vscode.Uri): RuntimePaths & VscodeStorageUris {
  const agents = root(globalStorageUri, AGENTS_ROOT_DIR);
  const workflows = root(globalStorageUri, WORKFLOWS_ROOT_DIR);
  const toolPolicies = root(globalStorageUri, TOOL_POLICIES_ROOT_DIR);
  const toolPolicyScopeLinks = root(globalStorageUri, TOOL_POLICY_SCOPE_LINKS_ROOT_DIR);
  const skillPolicies = root(globalStorageUri, SKILL_POLICIES_ROOT_DIR);
  const skillPolicyScopeLinks = root(globalStorageUri, SKILL_POLICY_SCOPE_LINKS_ROOT_DIR);
  const systemPrompts = root(globalStorageUri, SYSTEM_PROMPTS_ROOT_DIR);
  const runtimeContexts = root(globalStorageUri, RUNTIME_CONTEXTS_ROOT_DIR);
  const runtimeContextScopeLinks = root(globalStorageUri, RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR);
  const runtimeContextSnapshots = root(globalStorageUri, RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR);
  const conversationRuntimeContextSnapshotLinks = root(globalStorageUri, CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR);
  const runRuntimeContextSnapshotLinks = root(globalStorageUri, RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR);
  const modelProfiles = root(globalStorageUri, MODEL_PROFILES_ROOT_DIR);
  const conversations = root(globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationHistory = root(globalStorageUri, CONVERSATION_HISTORY_ROOT_DIR);
  const attachments = root(globalStorageUri, ATTACHMENTS_ROOT_DIR);
  const projectContexts = root(globalStorageUri, PROJECT_CONTEXTS_ROOT_DIR);
  const conversationProjectLinks = root(globalStorageUri, CONVERSATION_PROJECT_LINKS_ROOT_DIR);
  const workEnvironments = root(globalStorageUri, WORK_ENVIRONMENTS_ROOT_DIR);
  const workEnvironmentPolicies = root(globalStorageUri, WORK_ENVIRONMENT_POLICIES_ROOT_DIR);
  const workEnvironmentPolicyScopeLinks = root(globalStorageUri, WORK_ENVIRONMENT_POLICY_SCOPE_LINKS_ROOT_DIR);
  const conversationWorkEnvironmentLinks = root(globalStorageUri, CONVERSATION_WORK_ENVIRONMENT_LINKS_ROOT_DIR);
  const runWorkEnvironmentLinks = root(globalStorageUri, RUN_WORK_ENVIRONMENT_LINKS_ROOT_DIR);
  const checkpointPolicies = root(globalStorageUri, CHECKPOINT_POLICIES_ROOT_DIR);
  const checkpointPolicyScopeLinks = root(globalStorageUri, CHECKPOINT_POLICY_SCOPE_LINKS_ROOT_DIR);
  const shadowRepositories = root(globalStorageUri, SHADOW_REPOSITORIES_ROOT_DIR);
  const conversationCheckpointRepositoryLinks = root(globalStorageUri, CONVERSATION_CHECKPOINT_REPOSITORY_LINKS_ROOT_DIR);
  const checkpoints = root(globalStorageUri, CHECKPOINTS_ROOT_DIR);
  const checkpointTimelineAnchors = root(globalStorageUri, CHECKPOINT_TIMELINE_ANCHORS_ROOT_DIR);
  const checkpointShadowWorktreesRootUri = vscode.Uri.joinPath(globalStorageUri, CHECKPOINT_SHADOW_WORKTREES_ROOT_DIR);
  const compressionBlocks = root(globalStorageUri, COMPRESSION_BLOCKS_ROOT_DIR);
  const compressionBlockSourceLinks = root(globalStorageUri, COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR);
  const compressionContextVariants = root(globalStorageUri, COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR);
  const compressionBlockLlmInvocationLinks = root(globalStorageUri, COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR);
  const compressionLlmInvocations = root(globalStorageUri, COMPRESSION_LLM_INVOCATIONS_ROOT_DIR);
  const links = root(globalStorageUri, AGENT_CONVERSATION_LINKS_ROOT_DIR);
  const systemPromptScopeLinks = root(globalStorageUri, SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR);
  const modelProfileScopeLinks = root(globalStorageUri, MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR);
  const conversationWorkflowSelections = root(globalStorageUri, CONVERSATION_WORKFLOW_SELECTIONS_ROOT_DIR);
  const conversationAgentSelections = root(globalStorageUri, CONVERSATION_AGENT_SELECTIONS_ROOT_DIR);
  const runHistory = root(globalStorageUri, RUN_HISTORY_ROOT_DIR);
  const agentAnswers = root(globalStorageUri, AGENT_ANSWERS_ROOT_DIR);
  const agentAnswerSubmissionLinks = root(globalStorageUri, AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR);
  const agentAnswerTargetLinks = root(globalStorageUri, AGENT_ANSWER_TARGET_LINKS_ROOT_DIR);
  const backgroundCommands = root(globalStorageUri, BACKGROUND_COMMANDS_ROOT_DIR);
  const settingsRootUri = vscode.Uri.joinPath(globalStorageUri, SETTINGS_ROOT_DIR);
  const llmSettingsUri = vscode.Uri.joinPath(settingsRootUri, LLM_SETTINGS_FILE);

  return {
    globalStorageUri,
    globalStoragePath: globalStorageUri.fsPath,
    agentsRootUri: agents.rootUri,
    agentsRootPath: agents.rootUri.fsPath,
    agentsIndexUri: agents.indexUri,
    agentsIndexPath: agents.indexUri.fsPath,
    workflowsRootUri: workflows.rootUri,
    workflowsRootPath: workflows.rootUri.fsPath,
    workflowsIndexUri: workflows.indexUri,
    workflowsIndexPath: workflows.indexUri.fsPath,
    toolPoliciesRootUri: toolPolicies.rootUri,
    toolPoliciesRootPath: toolPolicies.rootUri.fsPath,
    toolPoliciesIndexUri: toolPolicies.indexUri,
    toolPoliciesIndexPath: toolPolicies.indexUri.fsPath,
    toolPolicyScopeLinksRootUri: toolPolicyScopeLinks.rootUri,
    toolPolicyScopeLinksRootPath: toolPolicyScopeLinks.rootUri.fsPath,
    toolPolicyScopeLinksIndexUri: toolPolicyScopeLinks.indexUri,
    toolPolicyScopeLinksIndexPath: toolPolicyScopeLinks.indexUri.fsPath,
    skillPoliciesRootUri: skillPolicies.rootUri,
    skillPoliciesRootPath: skillPolicies.rootUri.fsPath,
    skillPoliciesIndexUri: skillPolicies.indexUri,
    skillPoliciesIndexPath: skillPolicies.indexUri.fsPath,
    skillPolicyScopeLinksRootUri: skillPolicyScopeLinks.rootUri,
    skillPolicyScopeLinksRootPath: skillPolicyScopeLinks.rootUri.fsPath,
    skillPolicyScopeLinksIndexUri: skillPolicyScopeLinks.indexUri,
    skillPolicyScopeLinksIndexPath: skillPolicyScopeLinks.indexUri.fsPath,
    systemPromptsRootUri: systemPrompts.rootUri,
    systemPromptsRootPath: systemPrompts.rootUri.fsPath,
    systemPromptsIndexUri: systemPrompts.indexUri,
    systemPromptsIndexPath: systemPrompts.indexUri.fsPath,
    runtimeContextsRootUri: runtimeContexts.rootUri,
    runtimeContextsRootPath: runtimeContexts.rootUri.fsPath,
    runtimeContextsIndexUri: runtimeContexts.indexUri,
    runtimeContextsIndexPath: runtimeContexts.indexUri.fsPath,
    runtimeContextScopeLinksRootUri: runtimeContextScopeLinks.rootUri,
    runtimeContextScopeLinksRootPath: runtimeContextScopeLinks.rootUri.fsPath,
    runtimeContextScopeLinksIndexUri: runtimeContextScopeLinks.indexUri,
    runtimeContextScopeLinksIndexPath: runtimeContextScopeLinks.indexUri.fsPath,
    runtimeContextSnapshotsRootUri: runtimeContextSnapshots.rootUri,
    runtimeContextSnapshotsRootPath: runtimeContextSnapshots.rootUri.fsPath,
    runtimeContextSnapshotsIndexUri: runtimeContextSnapshots.indexUri,
    runtimeContextSnapshotsIndexPath: runtimeContextSnapshots.indexUri.fsPath,
    conversationRuntimeContextSnapshotLinksRootUri: conversationRuntimeContextSnapshotLinks.rootUri,
    conversationRuntimeContextSnapshotLinksRootPath: conversationRuntimeContextSnapshotLinks.rootUri.fsPath,
    conversationRuntimeContextSnapshotLinksIndexUri: conversationRuntimeContextSnapshotLinks.indexUri,
    conversationRuntimeContextSnapshotLinksIndexPath: conversationRuntimeContextSnapshotLinks.indexUri.fsPath,
    runRuntimeContextSnapshotLinksRootUri: runRuntimeContextSnapshotLinks.rootUri,
    runRuntimeContextSnapshotLinksRootPath: runRuntimeContextSnapshotLinks.rootUri.fsPath,
    runRuntimeContextSnapshotLinksIndexUri: runRuntimeContextSnapshotLinks.indexUri,
    runRuntimeContextSnapshotLinksIndexPath: runRuntimeContextSnapshotLinks.indexUri.fsPath,
    modelProfilesRootUri: modelProfiles.rootUri,
    modelProfilesRootPath: modelProfiles.rootUri.fsPath,
    modelProfilesIndexUri: modelProfiles.indexUri,
    modelProfilesIndexPath: modelProfiles.indexUri.fsPath,
    conversationsRootUri: conversations.rootUri,
    conversationsRootPath: conversations.rootUri.fsPath,
    conversationsIndexUri: conversations.indexUri,
    conversationsIndexPath: conversations.indexUri.fsPath,
    conversationHistoryRootUri: conversationHistory.rootUri,
    conversationHistoryRootPath: conversationHistory.rootUri.fsPath,
    conversationHistoryIndexUri: conversationHistory.indexUri,
    conversationHistoryIndexPath: conversationHistory.indexUri.fsPath,
    attachmentsRootUri: attachments.rootUri,
    attachmentsRootPath: attachments.rootUri.fsPath,
    attachmentsIndexUri: attachments.indexUri,
    attachmentsIndexPath: attachments.indexUri.fsPath,
    projectContextsRootUri: projectContexts.rootUri,
    projectContextsRootPath: projectContexts.rootUri.fsPath,
    projectContextsIndexUri: projectContexts.indexUri,
    projectContextsIndexPath: projectContexts.indexUri.fsPath,
    conversationProjectLinksRootUri: conversationProjectLinks.rootUri,
    conversationProjectLinksRootPath: conversationProjectLinks.rootUri.fsPath,
    conversationProjectLinksIndexUri: conversationProjectLinks.indexUri,
    conversationProjectLinksIndexPath: conversationProjectLinks.indexUri.fsPath,
    workEnvironmentsRootUri: workEnvironments.rootUri,
    workEnvironmentsRootPath: workEnvironments.rootUri.fsPath,
    workEnvironmentsIndexUri: workEnvironments.indexUri,
    workEnvironmentsIndexPath: workEnvironments.indexUri.fsPath,
    workEnvironmentPoliciesRootUri: workEnvironmentPolicies.rootUri,
    workEnvironmentPoliciesRootPath: workEnvironmentPolicies.rootUri.fsPath,
    workEnvironmentPoliciesIndexUri: workEnvironmentPolicies.indexUri,
    workEnvironmentPoliciesIndexPath: workEnvironmentPolicies.indexUri.fsPath,
    workEnvironmentPolicyScopeLinksRootUri: workEnvironmentPolicyScopeLinks.rootUri,
    workEnvironmentPolicyScopeLinksRootPath: workEnvironmentPolicyScopeLinks.rootUri.fsPath,
    workEnvironmentPolicyScopeLinksIndexUri: workEnvironmentPolicyScopeLinks.indexUri,
    workEnvironmentPolicyScopeLinksIndexPath: workEnvironmentPolicyScopeLinks.indexUri.fsPath,
    conversationWorkEnvironmentLinksRootUri: conversationWorkEnvironmentLinks.rootUri,
    conversationWorkEnvironmentLinksRootPath: conversationWorkEnvironmentLinks.rootUri.fsPath,
    conversationWorkEnvironmentLinksIndexUri: conversationWorkEnvironmentLinks.indexUri,
    conversationWorkEnvironmentLinksIndexPath: conversationWorkEnvironmentLinks.indexUri.fsPath,
    runWorkEnvironmentLinksRootUri: runWorkEnvironmentLinks.rootUri,
    runWorkEnvironmentLinksRootPath: runWorkEnvironmentLinks.rootUri.fsPath,
    runWorkEnvironmentLinksIndexUri: runWorkEnvironmentLinks.indexUri,
    runWorkEnvironmentLinksIndexPath: runWorkEnvironmentLinks.indexUri.fsPath,
    checkpointPoliciesRootUri: checkpointPolicies.rootUri,
    checkpointPoliciesRootPath: checkpointPolicies.rootUri.fsPath,
    checkpointPoliciesIndexUri: checkpointPolicies.indexUri,
    checkpointPoliciesIndexPath: checkpointPolicies.indexUri.fsPath,
    checkpointPolicyScopeLinksRootUri: checkpointPolicyScopeLinks.rootUri,
    checkpointPolicyScopeLinksRootPath: checkpointPolicyScopeLinks.rootUri.fsPath,
    checkpointPolicyScopeLinksIndexUri: checkpointPolicyScopeLinks.indexUri,
    checkpointPolicyScopeLinksIndexPath: checkpointPolicyScopeLinks.indexUri.fsPath,
    shadowRepositoriesRootUri: shadowRepositories.rootUri,
    shadowRepositoriesRootPath: shadowRepositories.rootUri.fsPath,
    shadowRepositoriesIndexUri: shadowRepositories.indexUri,
    shadowRepositoriesIndexPath: shadowRepositories.indexUri.fsPath,
    conversationCheckpointRepositoryLinksRootUri: conversationCheckpointRepositoryLinks.rootUri,
    conversationCheckpointRepositoryLinksRootPath: conversationCheckpointRepositoryLinks.rootUri.fsPath,
    conversationCheckpointRepositoryLinksIndexUri: conversationCheckpointRepositoryLinks.indexUri,
    conversationCheckpointRepositoryLinksIndexPath: conversationCheckpointRepositoryLinks.indexUri.fsPath,
    checkpointsRootUri: checkpoints.rootUri,
    checkpointsRootPath: checkpoints.rootUri.fsPath,
    checkpointsIndexUri: checkpoints.indexUri,
    checkpointsIndexPath: checkpoints.indexUri.fsPath,
    checkpointTimelineAnchorsRootUri: checkpointTimelineAnchors.rootUri,
    checkpointTimelineAnchorsRootPath: checkpointTimelineAnchors.rootUri.fsPath,
    checkpointTimelineAnchorsIndexUri: checkpointTimelineAnchors.indexUri,
    checkpointTimelineAnchorsIndexPath: checkpointTimelineAnchors.indexUri.fsPath,
    checkpointShadowWorktreesRootUri,
    checkpointShadowWorktreesRootPath: checkpointShadowWorktreesRootUri.fsPath,
    compressionBlocksRootUri: compressionBlocks.rootUri,
    compressionBlocksRootPath: compressionBlocks.rootUri.fsPath,
    compressionBlocksIndexUri: compressionBlocks.indexUri,
    compressionBlocksIndexPath: compressionBlocks.indexUri.fsPath,
    compressionBlockSourceLinksRootUri: compressionBlockSourceLinks.rootUri,
    compressionBlockSourceLinksRootPath: compressionBlockSourceLinks.rootUri.fsPath,
    compressionBlockSourceLinksIndexUri: compressionBlockSourceLinks.indexUri,
    compressionBlockSourceLinksIndexPath: compressionBlockSourceLinks.indexUri.fsPath,
    compressionContextVariantsRootUri: compressionContextVariants.rootUri,
    compressionContextVariantsRootPath: compressionContextVariants.rootUri.fsPath,
    compressionContextVariantsIndexUri: compressionContextVariants.indexUri,
    compressionContextVariantsIndexPath: compressionContextVariants.indexUri.fsPath,
    compressionBlockLlmInvocationLinksRootUri: compressionBlockLlmInvocationLinks.rootUri,
    compressionBlockLlmInvocationLinksRootPath: compressionBlockLlmInvocationLinks.rootUri.fsPath,
    compressionBlockLlmInvocationLinksIndexUri: compressionBlockLlmInvocationLinks.indexUri,
    compressionBlockLlmInvocationLinksIndexPath: compressionBlockLlmInvocationLinks.indexUri.fsPath,
    compressionLlmInvocationsRootUri: compressionLlmInvocations.rootUri,
    compressionLlmInvocationsRootPath: compressionLlmInvocations.rootUri.fsPath,
    compressionLlmInvocationsIndexUri: compressionLlmInvocations.indexUri,
    compressionLlmInvocationsIndexPath: compressionLlmInvocations.indexUri.fsPath,
    linksRootUri: links.rootUri,
    linksRootPath: links.rootUri.fsPath,
    linksIndexUri: links.indexUri,
    linksIndexPath: links.indexUri.fsPath,
    systemPromptScopeLinksRootUri: systemPromptScopeLinks.rootUri,
    systemPromptScopeLinksRootPath: systemPromptScopeLinks.rootUri.fsPath,
    systemPromptScopeLinksIndexUri: systemPromptScopeLinks.indexUri,
    systemPromptScopeLinksIndexPath: systemPromptScopeLinks.indexUri.fsPath,
    modelProfileScopeLinksRootUri: modelProfileScopeLinks.rootUri,
    modelProfileScopeLinksRootPath: modelProfileScopeLinks.rootUri.fsPath,
    modelProfileScopeLinksIndexUri: modelProfileScopeLinks.indexUri,
    modelProfileScopeLinksIndexPath: modelProfileScopeLinks.indexUri.fsPath,
    conversationWorkflowSelectionsRootUri: conversationWorkflowSelections.rootUri,
    conversationWorkflowSelectionsRootPath: conversationWorkflowSelections.rootUri.fsPath,
    conversationWorkflowSelectionsIndexUri: conversationWorkflowSelections.indexUri,
    conversationWorkflowSelectionsIndexPath: conversationWorkflowSelections.indexUri.fsPath,
    conversationAgentSelectionsRootUri: conversationAgentSelections.rootUri,
    conversationAgentSelectionsRootPath: conversationAgentSelections.rootUri.fsPath,
    conversationAgentSelectionsIndexUri: conversationAgentSelections.indexUri,
    conversationAgentSelectionsIndexPath: conversationAgentSelections.indexUri.fsPath,
    runHistoryRootUri: runHistory.rootUri,
    runHistoryRootPath: runHistory.rootUri.fsPath,
    runHistoryIndexUri: runHistory.indexUri,
    runHistoryIndexPath: runHistory.indexUri.fsPath,
    agentAnswersRootUri: agentAnswers.rootUri,
    agentAnswersRootPath: agentAnswers.rootUri.fsPath,
    agentAnswersIndexUri: agentAnswers.indexUri,
    agentAnswersIndexPath: agentAnswers.indexUri.fsPath,
    agentAnswerSubmissionLinksRootUri: agentAnswerSubmissionLinks.rootUri,
    agentAnswerSubmissionLinksRootPath: agentAnswerSubmissionLinks.rootUri.fsPath,
    agentAnswerSubmissionLinksIndexUri: agentAnswerSubmissionLinks.indexUri,
    agentAnswerSubmissionLinksIndexPath: agentAnswerSubmissionLinks.indexUri.fsPath,
    agentAnswerTargetLinksRootUri: agentAnswerTargetLinks.rootUri,
    agentAnswerTargetLinksRootPath: agentAnswerTargetLinks.rootUri.fsPath,
    agentAnswerTargetLinksIndexUri: agentAnswerTargetLinks.indexUri,
    agentAnswerTargetLinksIndexPath: agentAnswerTargetLinks.indexUri.fsPath,
    backgroundCommandsRootUri: backgroundCommands.rootUri,
    backgroundCommandsRootPath: backgroundCommands.rootUri.fsPath,
    backgroundCommandsIndexUri: backgroundCommands.indexUri,
    backgroundCommandsIndexPath: backgroundCommands.indexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };
}

export async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}
