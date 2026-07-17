<script setup lang="ts">
import SettingsScopeLayout from './SettingsScopeLayout.vue';
import { DEFAULT_WORKFLOW_SETTINGS_TAB, WORKFLOW_SETTINGS_TABS } from './workflow/workflowSettingsTabs';
</script>

<template>
  <SettingsScopeLayout
    :tabs="WORKFLOW_SETTINGS_TABS"
    :default-tab="DEFAULT_WORKFLOW_SETTINGS_TAB"
    settings-label="工作流编辑"
  />
</template>

<style src="./global/settingsTabContent.css"></style>
