import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENT_MODE_LINKS_ROOT_DIR,
  AGENT_MODES_ROOT_DIR,
  AGENT_RUNS_ROOT_DIR,
  AGENT_RUN_SOURCE_LINKS_ROOT_DIR,
  AGENT_RUN_TARGET_LINKS_ROOT_DIR,
  AGENTS_ROOT_DIR,
  APPROVAL_POLICIES_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  INDEX_FILE,
  LLM_SETTINGS_FILE,
  MESSAGE_RUN_LINKS_ROOT_DIR,
  MODE_APPROVAL_POLICY_LINKS_ROOT_DIR,
  MODE_MODEL_PROFILE_LINKS_ROOT_DIR,
  MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR,
  MODE_TOOL_POLICY_LINKS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  RUN_POLICIES_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  TOOL_CALL_RUN_LINKS_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR
} from './constants';

export interface VscodeStorageUris {
  agentsRootUri: vscode.Uri;
  agentsIndexUri: vscode.Uri;
  agentModesRootUri: vscode.Uri;
  agentModesIndexUri: vscode.Uri;
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesIndexUri: vscode.Uri;
  approvalPoliciesRootUri: vscode.Uri;
  approvalPoliciesIndexUri: vscode.Uri;
  systemPromptsRootUri: vscode.Uri;
  systemPromptsIndexUri: vscode.Uri;
  modelProfilesRootUri: vscode.Uri;
  modelProfilesIndexUri: vscode.Uri;
  conversationsRootUri: vscode.Uri;
  conversationsIndexUri: vscode.Uri;
  conversationHistoryRootUri: vscode.Uri;
  conversationHistoryIndexUri: vscode.Uri;
  projectContextsRootUri: vscode.Uri;
  projectContextsIndexUri: vscode.Uri;
  conversationProjectLinksRootUri: vscode.Uri;
  conversationProjectLinksIndexUri: vscode.Uri;
  linksRootUri: vscode.Uri;
  linksIndexUri: vscode.Uri;
  agentModeLinksRootUri: vscode.Uri;
  agentModeLinksIndexUri: vscode.Uri;
  modeToolPolicyLinksRootUri: vscode.Uri;
  modeToolPolicyLinksIndexUri: vscode.Uri;
  modeApprovalPolicyLinksRootUri: vscode.Uri;
  modeApprovalPolicyLinksIndexUri: vscode.Uri;
  modeSystemPromptLinksRootUri: vscode.Uri;
  modeSystemPromptLinksIndexUri: vscode.Uri;
  modeModelProfileLinksRootUri: vscode.Uri;
  modeModelProfileLinksIndexUri: vscode.Uri;
  agentRunsRootUri: vscode.Uri;
  agentRunsIndexUri: vscode.Uri;
  agentRunSourceLinksRootUri: vscode.Uri;
  agentRunSourceLinksIndexUri: vscode.Uri;
  agentRunTargetLinksRootUri: vscode.Uri;
  agentRunTargetLinksIndexUri: vscode.Uri;
  messageRunLinksRootUri: vscode.Uri;
  messageRunLinksIndexUri: vscode.Uri;
  toolCallRunLinksRootUri: vscode.Uri;
  toolCallRunLinksIndexUri: vscode.Uri;
  runPoliciesRootUri: vscode.Uri;
  runPoliciesIndexUri: vscode.Uri;
  settingsRootUri: vscode.Uri;
  llmSettingsUri: vscode.Uri;
}

function root(globalStorageUri: vscode.Uri, dir: string): { rootUri: vscode.Uri; indexUri: vscode.Uri } {
  const rootUri = vscode.Uri.joinPath(globalStorageUri, dir);
  return { rootUri, indexUri: vscode.Uri.joinPath(rootUri, INDEX_FILE) };
}

export function createVscodeStoragePaths(globalStorageUri: vscode.Uri): RuntimePaths & VscodeStorageUris {
  const agents = root(globalStorageUri, AGENTS_ROOT_DIR);
  const agentModes = root(globalStorageUri, AGENT_MODES_ROOT_DIR);
  const toolPolicies = root(globalStorageUri, TOOL_POLICIES_ROOT_DIR);
  const approvalPolicies = root(globalStorageUri, APPROVAL_POLICIES_ROOT_DIR);
  const systemPrompts = root(globalStorageUri, SYSTEM_PROMPTS_ROOT_DIR);
  const modelProfiles = root(globalStorageUri, MODEL_PROFILES_ROOT_DIR);
  const conversations = root(globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationHistory = root(globalStorageUri, CONVERSATION_HISTORY_ROOT_DIR);
  const projectContexts = root(globalStorageUri, PROJECT_CONTEXTS_ROOT_DIR);
  const conversationProjectLinks = root(globalStorageUri, CONVERSATION_PROJECT_LINKS_ROOT_DIR);
  const links = root(globalStorageUri, AGENT_CONVERSATION_LINKS_ROOT_DIR);
  const agentModeLinks = root(globalStorageUri, AGENT_MODE_LINKS_ROOT_DIR);
  const modeToolPolicyLinks = root(globalStorageUri, MODE_TOOL_POLICY_LINKS_ROOT_DIR);
  const modeApprovalPolicyLinks = root(globalStorageUri, MODE_APPROVAL_POLICY_LINKS_ROOT_DIR);
  const modeSystemPromptLinks = root(globalStorageUri, MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR);
  const modeModelProfileLinks = root(globalStorageUri, MODE_MODEL_PROFILE_LINKS_ROOT_DIR);
  const agentRuns = root(globalStorageUri, AGENT_RUNS_ROOT_DIR);
  const agentRunSourceLinks = root(globalStorageUri, AGENT_RUN_SOURCE_LINKS_ROOT_DIR);
  const agentRunTargetLinks = root(globalStorageUri, AGENT_RUN_TARGET_LINKS_ROOT_DIR);
  const messageRunLinks = root(globalStorageUri, MESSAGE_RUN_LINKS_ROOT_DIR);
  const toolCallRunLinks = root(globalStorageUri, TOOL_CALL_RUN_LINKS_ROOT_DIR);
  const runPolicies = root(globalStorageUri, RUN_POLICIES_ROOT_DIR);
  const settingsRootUri = vscode.Uri.joinPath(globalStorageUri, SETTINGS_ROOT_DIR);
  const llmSettingsUri = vscode.Uri.joinPath(settingsRootUri, LLM_SETTINGS_FILE);

  return {
    globalStorageUri,
    globalStoragePath: globalStorageUri.fsPath,
    agentsRootUri: agents.rootUri,
    agentsRootPath: agents.rootUri.fsPath,
    agentsIndexUri: agents.indexUri,
    agentsIndexPath: agents.indexUri.fsPath,
    agentModesRootUri: agentModes.rootUri,
    agentModesRootPath: agentModes.rootUri.fsPath,
    agentModesIndexUri: agentModes.indexUri,
    agentModesIndexPath: agentModes.indexUri.fsPath,
    toolPoliciesRootUri: toolPolicies.rootUri,
    toolPoliciesRootPath: toolPolicies.rootUri.fsPath,
    toolPoliciesIndexUri: toolPolicies.indexUri,
    toolPoliciesIndexPath: toolPolicies.indexUri.fsPath,
    approvalPoliciesRootUri: approvalPolicies.rootUri,
    approvalPoliciesRootPath: approvalPolicies.rootUri.fsPath,
    approvalPoliciesIndexUri: approvalPolicies.indexUri,
    approvalPoliciesIndexPath: approvalPolicies.indexUri.fsPath,
    systemPromptsRootUri: systemPrompts.rootUri,
    systemPromptsRootPath: systemPrompts.rootUri.fsPath,
    systemPromptsIndexUri: systemPrompts.indexUri,
    systemPromptsIndexPath: systemPrompts.indexUri.fsPath,
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
    projectContextsRootUri: projectContexts.rootUri,
    projectContextsRootPath: projectContexts.rootUri.fsPath,
    projectContextsIndexUri: projectContexts.indexUri,
    projectContextsIndexPath: projectContexts.indexUri.fsPath,
    conversationProjectLinksRootUri: conversationProjectLinks.rootUri,
    conversationProjectLinksRootPath: conversationProjectLinks.rootUri.fsPath,
    conversationProjectLinksIndexUri: conversationProjectLinks.indexUri,
    conversationProjectLinksIndexPath: conversationProjectLinks.indexUri.fsPath,
    linksRootUri: links.rootUri,
    linksRootPath: links.rootUri.fsPath,
    linksIndexUri: links.indexUri,
    linksIndexPath: links.indexUri.fsPath,
    agentModeLinksRootUri: agentModeLinks.rootUri,
    agentModeLinksRootPath: agentModeLinks.rootUri.fsPath,
    agentModeLinksIndexUri: agentModeLinks.indexUri,
    agentModeLinksIndexPath: agentModeLinks.indexUri.fsPath,
    modeToolPolicyLinksRootUri: modeToolPolicyLinks.rootUri,
    modeToolPolicyLinksRootPath: modeToolPolicyLinks.rootUri.fsPath,
    modeToolPolicyLinksIndexUri: modeToolPolicyLinks.indexUri,
    modeToolPolicyLinksIndexPath: modeToolPolicyLinks.indexUri.fsPath,
    modeApprovalPolicyLinksRootUri: modeApprovalPolicyLinks.rootUri,
    modeApprovalPolicyLinksRootPath: modeApprovalPolicyLinks.rootUri.fsPath,
    modeApprovalPolicyLinksIndexUri: modeApprovalPolicyLinks.indexUri,
    modeApprovalPolicyLinksIndexPath: modeApprovalPolicyLinks.indexUri.fsPath,
    modeSystemPromptLinksRootUri: modeSystemPromptLinks.rootUri,
    modeSystemPromptLinksRootPath: modeSystemPromptLinks.rootUri.fsPath,
    modeSystemPromptLinksIndexUri: modeSystemPromptLinks.indexUri,
    modeSystemPromptLinksIndexPath: modeSystemPromptLinks.indexUri.fsPath,
    modeModelProfileLinksRootUri: modeModelProfileLinks.rootUri,
    modeModelProfileLinksRootPath: modeModelProfileLinks.rootUri.fsPath,
    modeModelProfileLinksIndexUri: modeModelProfileLinks.indexUri,
    modeModelProfileLinksIndexPath: modeModelProfileLinks.indexUri.fsPath,
    agentRunsRootUri: agentRuns.rootUri,
    agentRunsRootPath: agentRuns.rootUri.fsPath,
    agentRunsIndexUri: agentRuns.indexUri,
    agentRunsIndexPath: agentRuns.indexUri.fsPath,
    agentRunSourceLinksRootUri: agentRunSourceLinks.rootUri,
    agentRunSourceLinksRootPath: agentRunSourceLinks.rootUri.fsPath,
    agentRunSourceLinksIndexUri: agentRunSourceLinks.indexUri,
    agentRunSourceLinksIndexPath: agentRunSourceLinks.indexUri.fsPath,
    agentRunTargetLinksRootUri: agentRunTargetLinks.rootUri,
    agentRunTargetLinksRootPath: agentRunTargetLinks.rootUri.fsPath,
    agentRunTargetLinksIndexUri: agentRunTargetLinks.indexUri,
    agentRunTargetLinksIndexPath: agentRunTargetLinks.indexUri.fsPath,
    messageRunLinksRootUri: messageRunLinks.rootUri,
    messageRunLinksRootPath: messageRunLinks.rootUri.fsPath,
    messageRunLinksIndexUri: messageRunLinks.indexUri,
    messageRunLinksIndexPath: messageRunLinks.indexUri.fsPath,
    toolCallRunLinksRootUri: toolCallRunLinks.rootUri,
    toolCallRunLinksRootPath: toolCallRunLinks.rootUri.fsPath,
    toolCallRunLinksIndexUri: toolCallRunLinks.indexUri,
    toolCallRunLinksIndexPath: toolCallRunLinks.indexUri.fsPath,
    runPoliciesRootUri: runPolicies.rootUri,
    runPoliciesRootPath: runPolicies.rootUri.fsPath,
    runPoliciesIndexUri: runPolicies.indexUri,
    runPoliciesIndexPath: runPolicies.indexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };
}

export async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}
