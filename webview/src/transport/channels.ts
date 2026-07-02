import { BridgeMessageType, type BridgeChannel, type WebviewToExtensionMessage } from '@shared/protocol';

/** 把出站消息类型映射到桥接通道。逻辑与旧 vscodeBridge 保持一致。 */
export function channelForType(type: WebviewToExtensionMessage['type']): BridgeChannel {
  switch (type) {
    case BridgeMessageType.ChatSend:
    case BridgeMessageType.ChatAbort:
    case BridgeMessageType.LlmRetryCancel:
    case BridgeMessageType.MessageEdit:
    case BridgeMessageType.MessageDeleteFrom:
    case BridgeMessageType.MessageRetryFrom:
    case BridgeMessageType.AgentRunCancel:
    case BridgeMessageType.AgentRunPause:
    case BridgeMessageType.AgentRunResume:
    case BridgeMessageType.AgentRunRetry:
    case BridgeMessageType.AgentRunRegenerate:
    case BridgeMessageType.AgentRunMarkStale:
    case BridgeMessageType.QueuePromote:
    case BridgeMessageType.QueueRemove:
    case BridgeMessageType.QueueReorder:
    case BridgeMessageType.QueuePause:
    case BridgeMessageType.QueueResume:
    case BridgeMessageType.QueueResumeAll:
    case BridgeMessageType.QueueInputUpdate:
    case BridgeMessageType.ModeCreate:
    case BridgeMessageType.ModeUpdate:
    case BridgeMessageType.ModeDelete:
    case BridgeMessageType.ConversationModeSelect:
    case BridgeMessageType.ConversationProjectSet:
    case BridgeMessageType.WorkEnvironmentSelect:
    case BridgeMessageType.WorkEnvironmentUpsert:
    case BridgeMessageType.WorkEnvironmentRemove:
    case BridgeMessageType.WorkEnvironmentImportFromVscode:
    case BridgeMessageType.WorkEnvironmentPolicyScopeSet:
    case BridgeMessageType.WorkEnvironmentPolicyScopeClear:
    case BridgeMessageType.ToolPolicyScopeSet:
    case BridgeMessageType.ToolPolicyScopeClear:
    case BridgeMessageType.SkillPolicyScopeSet:
    case BridgeMessageType.SkillPolicyScopeClear:
    case BridgeMessageType.SkillCatalogRefresh:
    case BridgeMessageType.RulesFileSave:
    case BridgeMessageType.RulesCatalogRefresh:
    case BridgeMessageType.RuntimeContextScopeSet:
    case BridgeMessageType.RuntimeContextScopeClear:
    case BridgeMessageType.RuntimeContextRefresh:
    case BridgeMessageType.RuntimeContextSnapshotClear:
    case BridgeMessageType.CheckpointPolicyScopeSet:
    case BridgeMessageType.CheckpointPolicyScopeClear:
    case BridgeMessageType.CheckpointShadowDelete:
    case BridgeMessageType.CheckpointDismiss:
    case BridgeMessageType.CheckpointRestore:
    case BridgeMessageType.ToolExecutionApprove:
    case BridgeMessageType.ToolExecutionReject:
    case BridgeMessageType.ToolChangeApply:
    case BridgeMessageType.ToolChangeReject:
    case BridgeMessageType.ToolResultSubmit:
    case BridgeMessageType.ToolResultReject:
    case BridgeMessageType.CheckpointDiffOpen:
    case BridgeMessageType.AttachmentOpen:
      return 'command';
    case BridgeMessageType.ClientResync:
    case BridgeMessageType.ConversationTimelinePageGet:
    case BridgeMessageType.FsStatGet:
    case BridgeMessageType.BackgroundCommandOutputGet:
    case BridgeMessageType.ProjectFoldersGet:
    case BridgeMessageType.RunHistoryPageGet:
    case BridgeMessageType.RunHistoryDetailGet:
    case BridgeMessageType.LlmDryRunGet:
    case BridgeMessageType.LlmProviderModelsGet:
    case BridgeMessageType.CheckpointGitStatusGet:
    case BridgeMessageType.CheckpointShadowStatsGet:
    case BridgeMessageType.AttachmentReload:
      return 'state';
    case BridgeMessageType.GlobalSettingsGet:
    case BridgeMessageType.GlobalSettingsUpdate:
    case BridgeMessageType.ConversationSettingsGet:
    case BridgeMessageType.ConversationSettingsUpdate:
      return 'settings';
    default:
      return 'control';
  }
}
