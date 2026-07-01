export const STORAGE_VERSION = 1;
export const INDEX_FILE = 'index.json';
export const RECORDS_DIR = 'records';

export const AGENTS_ROOT_DIR = 'agents';
export const MODES_ROOT_DIR = 'modes';
export const TOOL_POLICIES_ROOT_DIR = 'tool-policies';
export const TOOL_POLICY_SCOPE_LINKS_ROOT_DIR = 'tool-policy-scope-links';
export const SKILL_POLICIES_ROOT_DIR = 'skill-policies';
export const SKILL_POLICY_SCOPE_LINKS_ROOT_DIR = 'skill-policy-scope-links';
export const SYSTEM_PROMPTS_ROOT_DIR = 'system-prompts';
export const MODEL_PROFILES_ROOT_DIR = 'model-profiles';
export const AGENT_CONVERSATION_LINKS_ROOT_DIR = 'agent-conversation-links';
export const SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR = 'system-prompt-scope-links';
export const RUNTIME_CONTEXTS_ROOT_DIR = 'runtime-contexts';
export const RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR = 'runtime-context-scope-links';
export const RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR = 'runtime-context-snapshots';
export const CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR = 'conversation-runtime-context-snapshot-links';
export const RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR = 'run-runtime-context-snapshot-links';
export const MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR = 'model-profile-scope-links';
export const CONVERSATION_MODE_SELECTIONS_ROOT_DIR = 'conversation-mode-selections';
export const CONVERSATION_AGENT_SELECTIONS_ROOT_DIR = 'conversation-agent-selections';
export const CONVERSATIONS_ROOT_DIR = 'conversations';
export const CONVERSATION_HISTORY_ROOT_DIR = 'conversation-history';
export const ATTACHMENTS_ROOT_DIR = 'attachments';
export const PROJECT_CONTEXTS_ROOT_DIR = 'project-contexts';
export const CONVERSATION_PROJECT_LINKS_ROOT_DIR = 'conversation-project-links';
export const RUN_HISTORY_ROOT_DIR = 'run-history';
export const AGENT_ANSWERS_ROOT_DIR = 'agent-answers';
export const AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR = 'agent-answer-submission-links';
export const AGENT_ANSWER_TARGET_LINKS_ROOT_DIR = 'agent-answer-target-links';
export const SETTINGS_ROOT_DIR = 'settings';
export const BACKGROUND_COMMANDS_ROOT_DIR = 'background-commands';
export const WORK_ENVIRONMENTS_ROOT_DIR = 'work-environments';
export const CONVERSATION_WORK_ENVIRONMENT_LINKS_ROOT_DIR = 'conversation-work-environment-links';
export const RUN_WORK_ENVIRONMENT_LINKS_ROOT_DIR = 'run-work-environment-links';
export const WORK_ENVIRONMENT_POLICIES_ROOT_DIR = 'work-environment-policies';
export const WORK_ENVIRONMENT_POLICY_SCOPE_LINKS_ROOT_DIR = 'work-environment-policy-scope-links';
export const CHECKPOINT_POLICIES_ROOT_DIR = 'checkpoint-policies';
export const CHECKPOINT_POLICY_SCOPE_LINKS_ROOT_DIR = 'checkpoint-policy-scope-links';
export const SHADOW_REPOSITORIES_ROOT_DIR = 'shadow-repositories';
export const CONVERSATION_CHECKPOINT_REPOSITORY_LINKS_ROOT_DIR = 'conversation-checkpoint-repository-links';
export const CHECKPOINTS_ROOT_DIR = 'checkpoints';
export const CHECKPOINT_TIMELINE_ANCHORS_ROOT_DIR = 'checkpoint-timeline-anchors';
export const CHECKPOINT_SHADOW_WORKTREES_ROOT_DIR = 'checkpoint-shadow-worktrees';
export const COMPRESSION_BLOCKS_ROOT_DIR = 'compression-blocks';
export const COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR = 'compression-block-source-links';
export const COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR = 'compression-context-variants';
export const COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR = 'compression-block-llm-invocation-links';
export const COMPRESSION_LLM_INVOCATIONS_ROOT_DIR = 'compression-llm-invocations';

/**
 * 当前插件明确注册的数据根目录名。
 * 自定义 data root 可能包含用户其它文件；迁移和删除只能触碰这些已注册目录。
 */
export const REGISTERED_STORAGE_ROOT_DIRS = [
  AGENTS_ROOT_DIR,
  MODES_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR,
  TOOL_POLICY_SCOPE_LINKS_ROOT_DIR,
  SKILL_POLICIES_ROOT_DIR,
  SKILL_POLICY_SCOPE_LINKS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR,
  RUNTIME_CONTEXTS_ROOT_DIR,
  RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR,
  RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR,
  CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR,
  CONVERSATION_MODE_SELECTIONS_ROOT_DIR,
  CONVERSATION_AGENT_SELECTIONS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  ATTACHMENTS_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  RUN_HISTORY_ROOT_DIR,
  AGENT_ANSWERS_ROOT_DIR,
  AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR,
  AGENT_ANSWER_TARGET_LINKS_ROOT_DIR,
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
  COMPRESSION_BLOCKS_ROOT_DIR,
  COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR,
  COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR,
  COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR,
  COMPRESSION_LLM_INVOCATIONS_ROOT_DIR,
  BACKGROUND_COMMANDS_ROOT_DIR,
  SETTINGS_ROOT_DIR
] as const;

export const LLM_SETTINGS_FILE = 'llm.json';
export const LLM_COMPRESSION_SETTINGS_FILE = 'llm-compression.json';
export const CHECKPOINT_MAINTENANCE_SETTINGS_FILE = 'checkpoint-maintenance.json';
export const APPEARANCE_SETTINGS_FILE = 'appearance.json';
export const ATTACHMENT_SETTINGS_FILE = 'attachments.json';
