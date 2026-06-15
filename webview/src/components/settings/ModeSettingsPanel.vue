<script setup lang="ts">
import SettingsScopeLayout from './SettingsScopeLayout.vue';
import { DEFAULT_MODE_SETTINGS_TAB, MODE_SETTINGS_TABS } from './mode/modeSettingsTabs';
</script>

<template>
  <SettingsScopeLayout
    :tabs="MODE_SETTINGS_TABS"
    :default-tab="DEFAULT_MODE_SETTINGS_TAB"
    settings-label="模式设置"
  />
</template>

<style src="./global/settingsTabContent.css"></style>
