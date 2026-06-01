<script setup lang="ts">
defineProps<{
  text: string;
  streaming?: boolean;
}>();
</script>

<template>
  <pre class="rc-text">{{ text }}<span v-if="streaming" class="rc-cursor">▋</span></pre>
</template>

<style scoped>
.rc-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.rc-cursor {
  animation: rc-blink 1s steps(2, start) infinite;
}

@keyframes rc-blink {
  to {
    opacity: 0;
  }
}
</style>
