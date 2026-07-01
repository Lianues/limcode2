import type { Component } from 'vue';
import { IconArchive, IconImageGeneration, IconMessage, IconPlugConnected, IconServer, IconSettings2, IconSettingsAi, IconTool } from '@tabler/icons-vue';
import ChannelSettingsTab from './ChannelSettingsTab.vue';
import CheckpointSettingsTab from './CheckpointSettingsTab.vue';
import AppearanceSettingsTab from './AppearanceSettingsTab.vue';
import OtherSettingsTab from './OtherSettingsTab.vue';
import SystemPromptSettingsTab from './SystemPromptSettingsTab.vue';
import ToolSettingsTab from './ToolSettingsTab.vue';
import McpToolSettingsTab from './McpToolSettingsTab.vue';
import WorkEnvironmentSettingsTab from './WorkEnvironmentSettingsTab.vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

export type GlobalSettingsTabKey = 'channels' | 'prompts' | 'tools' | 'mcp-tools' | 'checkpoints' | 'work-environments' | 'appearance' | 'other';

export interface GlobalSettingsTabDefinition {
  key: GlobalSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
  loading?: () => boolean;
  loadingText?: () => string;
}

function isMcpTabLoading(): boolean {
  const settings = useGlobalSettingsStore();
  const clientState = useClientStateStore();
  return clientState.settingsClientStateLoading
    || settings.loadingSettingsSections.mcpServers === true
    || settings.pendingSettingsSections.mcpServers === true
    || clientState.mcpToolSources.some((source) => source.status === 'connecting');
}

function mcpTabLoadingText(): string {
  const settings = useGlobalSettingsStore();
  const clientState = useClientStateStore();
  if (settings.pendingSettingsSections.mcpServers) return settings.status || '正在处理 MCP 工具...';
  if (clientState.mcpToolSources.some((source) => source.status === 'connecting')) return '正在连接 MCP...';
  return '正在加载 MCP...';
}

export const GLOBAL_SETTINGS_TABS: readonly GlobalSettingsTabDefinition[] = [
  {
    key: 'channels',
    label: '渠道',
    description: '模型渠道与 API 连接',
    icon: IconSettingsAi,
    component: ChannelSettingsTab
  },
  {
    key: 'prompts',
    label: '提示词',
    description: '系统提示词与运行时快照',
    icon: IconMessage,
    component: SystemPromptSettingsTab
  },
  {
    key: 'tools',
    label: '工具',
    description: '工具注册与默认策略',
    icon: IconTool,
    component: ToolSettingsTab
  },
  {
    key: 'mcp-tools',
    label: 'MCP',
    description: 'MCP 服务注册与工具开关',
    icon: IconPlugConnected,
    component: McpToolSettingsTab,
    loading: isMcpTabLoading,
    loadingText: mcpTabLoadingText
  },
  {
    key: 'checkpoints',
    label: '存档点',
    description: '内部 shadow git 存档策略',
    icon: IconArchive,
    component: CheckpointSettingsTab
  },
  {
    key: 'work-environments',
    label: '工作环境',
    description: '本地、服务器及后续扩展环境',
    icon: IconServer,
    component: WorkEnvironmentSettingsTab
  },
  {
    key: 'appearance',
    label: '外观',
    description: '自定义流式状态文字与动效',
    icon: IconImageGeneration,
    component: AppearanceSettingsTab
  },
  {
    key: 'other',
    label: '其他',
    description: '未归类全局配置',
    icon: IconSettings2,
    component: OtherSettingsTab
  }
];

export const DEFAULT_GLOBAL_SETTINGS_TAB: GlobalSettingsTabKey = 'channels';
