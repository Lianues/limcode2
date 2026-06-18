<script setup lang="ts">
import SettingsScopeLayout from './SettingsScopeLayout.vue';
import { DEFAULT_AGENT_SETTINGS_TAB, AGENT_SETTINGS_TABS } from './agent/agentSettingsTabs';
</script>

<template>
  <SettingsScopeLayout :tabs="AGENT_SETTINGS_TABS" :default-tab="DEFAULT_AGENT_SETTINGS_TAB" settings-label="Agent 设置" />
</template>

<style src="./global/settingsTabContent.css"></style>
