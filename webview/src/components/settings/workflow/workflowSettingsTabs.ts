import type { Component } from 'vue';
import { IconListDetails } from '@tabler/icons-vue';
import WorkflowEditorTab from './WorkflowEditorTab.vue';

export type WorkflowSettingsTabKey = 'workflow-editor';

export interface WorkflowSettingsTabDefinition {
  key: WorkflowSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
}

export const WORKFLOW_SETTINGS_TABS: readonly WorkflowSettingsTabDefinition[] = [
  {
    key: 'workflow-editor',
    label: '工作流编辑',
    description: '查看并编辑工作流原始数据',
    icon: IconListDetails,
    component: WorkflowEditorTab
  }
];

export const DEFAULT_WORKFLOW_SETTINGS_TAB: WorkflowSettingsTabKey = 'workflow-editor';
