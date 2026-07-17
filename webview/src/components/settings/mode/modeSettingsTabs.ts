import type { Component } from 'vue';
import { IconListDetails } from '@tabler/icons-vue';
import ModeEditorTab from './ModeEditorTab.vue';

export type ModeSettingsTabKey = 'mode-editor';

export interface ModeSettingsTabDefinition {
  key: ModeSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
}

export const MODE_SETTINGS_TABS: readonly ModeSettingsTabDefinition[] = [
  {
    key: 'mode-editor',
    label: '工作流编辑',
    description: '工作流与工具策略',
    icon: IconListDetails,
    component: ModeEditorTab
  }
];

export const DEFAULT_MODE_SETTINGS_TAB: ModeSettingsTabKey = 'mode-editor';
