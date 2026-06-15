<script setup lang="ts">
import SettingsScopeLayout from './SettingsScopeLayout.vue';
import {
  DEFAULT_GLOBAL_SETTINGS_TAB,
  GLOBAL_SETTINGS_TABS
} from './global/globalSettingsTabs';
</script>

<template>
  <SettingsScopeLayout
    :tabs="GLOBAL_SETTINGS_TABS"
    :default-tab="DEFAULT_GLOBAL_SETTINGS_TAB"
    settings-label="全局设置"
  />
</template>

<style src="./global/settingsTabContent.css"></style>
