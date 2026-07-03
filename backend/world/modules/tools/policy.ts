import type { ToolDefinitionRecord, ToolPolicyRecord } from '../../../../shared/protocol';

export function isYoloToolPolicy(policy: Pick<ToolPolicyRecord, 'preset'> | undefined): boolean {
  return policy?.preset === 'yolo';
}

export function isToolAllowedByPolicy(policy: Pick<ToolPolicyRecord, 'allowedTools' | 'sourceConfigs' | 'preset'>, tool: Pick<ToolDefinitionRecord, 'name' | 'source'>): boolean {
  if (isYoloToolPolicy(policy)) return true;
  if (policy.allowedTools.includes(tool.name)) return true;
  if (tool.source?.kind !== 'mcp') return false;
  const sourceId = tool.source.sourceId?.trim();
  if (!sourceId) return false;
  const sourceConfig = policy.sourceConfigs?.[sourceId];
  if (!sourceConfig?.enabled) return false;
  return !(sourceConfig.disabledTools ?? []).includes(tool.name);
}
