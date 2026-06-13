import type { Component } from 'vue';
import { IconSettings2, IconSettingsAi, IconTool } from '@tabler/icons-vue';
import ChannelSettingsTab from './ChannelSettingsTab.vue';
import OtherSettingsTab from './OtherSettingsTab.vue';
import ToolSettingsTab from './ToolSettingsTab.vue';

export type GlobalSettingsTabKey = 'channels' | 'tools' | 'other';

export interface GlobalSettingsTabDefinition {
  key: GlobalSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
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
    key: 'tools',
    label: '工具',
    description: '工具注册与默认策略',
    icon: IconTool,
    component: ToolSettingsTab
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
