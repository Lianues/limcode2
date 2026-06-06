import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENT_MODE_LINKS_ROOT_DIR,
  AGENT_MODES_ROOT_DIR,
  AGENTS_ROOT_DIR,
  APPROVAL_POLICIES_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  INDEX_FILE,
  LLM_SETTINGS_FILE,
  MODE_APPROVAL_POLICY_LINKS_ROOT_DIR,
  MODE_MODEL_PROFILE_LINKS_ROOT_DIR,
  MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR,
  MODE_TOOL_POLICY_LINKS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  RUN_HISTORY_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
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
  runHistoryRootUri: vscode.Uri;
  runHistoryIndexUri: vscode.Uri;
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
  const runHistory = root(globalStorageUri, RUN_HISTORY_ROOT_DIR);
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
    runHistoryRootUri: runHistory.rootUri,
    runHistoryRootPath: runHistory.rootUri.fsPath,
    runHistoryIndexUri: runHistory.indexUri,
    runHistoryIndexPath: runHistory.indexUri.fsPath,
    settingsRootUri,
    settingsRootPath: settingsRootUri.fsPath,
    llmSettingsUri,
    llmSettingsPath: llmSettingsUri.fsPath
  };
}

export async function ensureStorageRoots(...roots: vscode.Uri[]): Promise<void> {
  await Promise.all(roots.map((root) => vscode.workspace.fs.createDirectory(root)));
}
