<script setup lang="ts">
defineProps<{
  connected: boolean;
  lastPong: string;
}>();
</script>

<template>
  <section class="status-card">
    <div class="status-line">
      <span class="dot" :class="{ active: connected }" />
      <span>{{ connected ? '桥接层已连接' : '等待桥接层响应' }}</span>
    </div>
    <p class="muted">最近一次 Ping/Pong：{{ lastPong }}</p>
  </section>
</template>
