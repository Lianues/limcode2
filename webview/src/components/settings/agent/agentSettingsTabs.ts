import type { Component } from 'vue';
import { IconRobot } from '@tabler/icons-vue';
import AgentEditorTab from './AgentEditorTab.vue';

export type AgentSettingsTabKey = 'agent-editor';

export interface AgentSettingsTabDefinition {
  key: AgentSettingsTabKey;
  label: string;
  description: string;
  icon: Component;
  component: Component;
}

export const AGENT_SETTINGS_TABS: readonly AgentSettingsTabDefinition[] = [
  { key: 'agent-editor', label: 'Agent 编辑', description: '角色、Prompt、工具与模型', icon: IconRobot, component: AgentEditorTab }
];

export const DEFAULT_AGENT_SETTINGS_TAB: AgentSettingsTabKey = 'agent-editor';
