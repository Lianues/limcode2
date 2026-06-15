import * as vscode from 'vscode';
import type { RuntimePaths } from '../types';
import {
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENT_MODE_LINKS_ROOT_DIR,
  AGENTS_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  CONVERSATION_MODE_SELECTIONS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  INDEX_FILE,
  LLM_SETTINGS_FILE,
  MODE_MODEL_PROFILE_LINKS_ROOT_DIR,
  MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR,
  MODE_TOOL_POLICY_LINKS_ROOT_DIR,
  MODES_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  RUN_HISTORY_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  TOOL_POLICY_SCOPE_LINKS_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR
} from './constants';

export interface VscodeStorageUris {
  agentsRootUri: vscode.Uri;
  agentsIndexUri: vscode.Uri;
  modesRootUri: vscode.Uri;
  modesIndexUri: vscode.Uri;
  toolPoliciesRootUri: vscode.Uri;
  toolPoliciesIndexUri: vscode.Uri;
  toolPolicyScopeLinksRootUri: vscode.Uri;
  toolPolicyScopeLinksIndexUri: vscode.Uri;
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
  modeSystemPromptLinksRootUri: vscode.Uri;
  modeSystemPromptLinksIndexUri: vscode.Uri;
  modeModelProfileLinksRootUri: vscode.Uri;
  modeModelProfileLinksIndexUri: vscode.Uri;
  conversationModeSelectionsRootUri: vscode.Uri;
  conversationModeSelectionsIndexUri: vscode.Uri;
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
  const modes = root(globalStorageUri, MODES_ROOT_DIR);
  const toolPolicies = root(globalStorageUri, TOOL_POLICIES_ROOT_DIR);
  const toolPolicyScopeLinks = root(globalStorageUri, TOOL_POLICY_SCOPE_LINKS_ROOT_DIR);
  const systemPrompts = root(globalStorageUri, SYSTEM_PROMPTS_ROOT_DIR);
  const modelProfiles = root(globalStorageUri, MODEL_PROFILES_ROOT_DIR);
  const conversations = root(globalStorageUri, CONVERSATIONS_ROOT_DIR);
  const conversationHistory = root(globalStorageUri, CONVERSATION_HISTORY_ROOT_DIR);
  const projectContexts = root(globalStorageUri, PROJECT_CONTEXTS_ROOT_DIR);
  const conversationProjectLinks = root(globalStorageUri, CONVERSATION_PROJECT_LINKS_ROOT_DIR);
  const links = root(globalStorageUri, AGENT_CONVERSATION_LINKS_ROOT_DIR);
  const agentModeLinks = root(globalStorageUri, AGENT_MODE_LINKS_ROOT_DIR);
  const modeToolPolicyLinks = root(globalStorageUri, MODE_TOOL_POLICY_LINKS_ROOT_DIR);
  const modeSystemPromptLinks = root(globalStorageUri, MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR);
  const modeModelProfileLinks = root(globalStorageUri, MODE_MODEL_PROFILE_LINKS_ROOT_DIR);
  const conversationModeSelections = root(globalStorageUri, CONVERSATION_MODE_SELECTIONS_ROOT_DIR);
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
    modesRootUri: modes.rootUri,
    modesRootPath: modes.rootUri.fsPath,
    modesIndexUri: modes.indexUri,
    modesIndexPath: modes.indexUri.fsPath,
    toolPoliciesRootUri: toolPolicies.rootUri,
    toolPoliciesRootPath: toolPolicies.rootUri.fsPath,
    toolPoliciesIndexUri: toolPolicies.indexUri,
    toolPoliciesIndexPath: toolPolicies.indexUri.fsPath,
    toolPolicyScopeLinksRootUri: toolPolicyScopeLinks.rootUri,
    toolPolicyScopeLinksRootPath: toolPolicyScopeLinks.rootUri.fsPath,
    toolPolicyScopeLinksIndexUri: toolPolicyScopeLinks.indexUri,
    toolPolicyScopeLinksIndexPath: toolPolicyScopeLinks.indexUri.fsPath,
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
    modeSystemPromptLinksRootUri: modeSystemPromptLinks.rootUri,
    modeSystemPromptLinksRootPath: modeSystemPromptLinks.rootUri.fsPath,
    modeSystemPromptLinksIndexUri: modeSystemPromptLinks.indexUri,
    modeSystemPromptLinksIndexPath: modeSystemPromptLinks.indexUri.fsPath,
    modeModelProfileLinksRootUri: modeModelProfileLinks.rootUri,
    modeModelProfileLinksRootPath: modeModelProfileLinks.rootUri.fsPath,
    modeModelProfileLinksIndexUri: modeModelProfileLinks.indexUri,
    modeModelProfileLinksIndexPath: modeModelProfileLinks.indexUri.fsPath,
    conversationModeSelectionsRootUri: conversationModeSelections.rootUri,
    conversationModeSelectionsRootPath: conversationModeSelections.rootUri.fsPath,
    conversationModeSelectionsIndexUri: conversationModeSelections.indexUri,
    conversationModeSelectionsIndexPath: conversationModeSelections.indexUri.fsPath,
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
