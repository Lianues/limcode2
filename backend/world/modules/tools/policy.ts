import type { ToolDefinitionRecord, ToolPolicyRecord } from '../../../../shared/protocol';

type ToolPolicyLike = Pick<ToolPolicyRecord, 'allowedTools' | 'sourceConfigs' | 'preset'>;
type ToolDefinitionLike = Pick<ToolDefinitionRecord, 'name' | 'source'>;

export function isYoloToolPolicy(policy: Pick<ToolPolicyRecord, 'preset'> | undefined): boolean {
  return policy?.preset === 'yolo';
}

export function isToolAllowedByPolicy(policy: ToolPolicyLike, tool: ToolDefinitionLike): boolean {
  if (isYoloToolPolicy(policy)) return true;
  if (policy.allowedTools.includes(tool.name)) return true;
  if (tool.source?.kind !== 'mcp') return false;
  const sourceId = tool.source.sourceId?.trim();
  if (!sourceId) return false;
  const sourceConfig = policy.sourceConfigs?.[sourceId];
  if (!sourceConfig?.enabled) return false;
  return !(sourceConfig.disabledTools ?? []).includes(tool.name);
}

export function isToolNameAllowedByPolicy(policy: ToolPolicyLike, toolName: string, tool?: ToolDefinitionLike): boolean {
  if (tool) return isToolAllowedByPolicy(policy, tool);
  const name = toolName.trim();
  return !!name && (isYoloToolPolicy(policy) || policy.allowedTools.includes(name));
}
