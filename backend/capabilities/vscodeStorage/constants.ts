export const STORAGE_VERSION = 1;
export const INDEX_FILE = 'index.json';
export const RECORDS_DIR = 'records';

export const AGENTS_ROOT_DIR = 'agents';
export const AGENT_MODES_ROOT_DIR = 'agent-modes';
export const TOOL_POLICIES_ROOT_DIR = 'tool-policies';
export const TOOL_POLICY_SCOPE_LINKS_ROOT_DIR = 'tool-policy-scope-links';
export const APPROVAL_POLICIES_ROOT_DIR = 'approval-policies';
export const SYSTEM_PROMPTS_ROOT_DIR = 'system-prompts';
export const MODEL_PROFILES_ROOT_DIR = 'model-profiles';
export const AGENT_CONVERSATION_LINKS_ROOT_DIR = 'agent-conversation-links';
export const AGENT_MODE_LINKS_ROOT_DIR = 'agent-mode-links';
export const MODE_TOOL_POLICY_LINKS_ROOT_DIR = 'mode-tool-policy-links';
export const MODE_APPROVAL_POLICY_LINKS_ROOT_DIR = 'mode-approval-policy-links';
export const MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR = 'mode-system-prompt-links';
export const MODE_MODEL_PROFILE_LINKS_ROOT_DIR = 'mode-model-profile-links';
export const CONVERSATIONS_ROOT_DIR = 'conversations';
export const CONVERSATION_HISTORY_ROOT_DIR = 'conversation-history';
export const PROJECT_CONTEXTS_ROOT_DIR = 'project-contexts';
export const CONVERSATION_PROJECT_LINKS_ROOT_DIR = 'conversation-project-links';
export const RUN_HISTORY_ROOT_DIR = 'run-history';
export const SETTINGS_ROOT_DIR = 'settings';

/**
 * 当前插件明确注册的数据根目录名。
 * 自定义 data root 可能包含用户其它文件；迁移和删除只能触碰这些已注册目录。
 */
export const REGISTERED_STORAGE_ROOT_DIRS = [
  AGENTS_ROOT_DIR,
  AGENT_MODES_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR,
  TOOL_POLICY_SCOPE_LINKS_ROOT_DIR,
  APPROVAL_POLICIES_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  AGENT_MODE_LINKS_ROOT_DIR,
  MODE_TOOL_POLICY_LINKS_ROOT_DIR,
  MODE_APPROVAL_POLICY_LINKS_ROOT_DIR,
  MODE_SYSTEM_PROMPT_LINKS_ROOT_DIR,
  MODE_MODEL_PROFILE_LINKS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  RUN_HISTORY_ROOT_DIR,
  SETTINGS_ROOT_DIR
] as const;

export const LLM_SETTINGS_FILE = 'llm.json';
