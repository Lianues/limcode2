<script setup lang="ts">
import { computed, defineAsyncComponent, h, type Component } from 'vue';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useBridgeBootstrap } from '@webview/composables/useBridgeBootstrap';

const LoadingFallback: Component = {
  name: 'LimcodeViewLoading',
  setup() {
    return () => h('main', { class: 'limcode-loading-shell', role: 'status', 'aria-live': 'polite' }, [
      h('section', { class: 'limcode-loading-card', 'aria-label': '正在打开 LimCode' }, [
        h('div', { class: 'limcode-loading-mark', 'aria-hidden': 'true' }, [h('span'), h('span'), h('span')]),
        h('div', { class: 'limcode-loading-copy' }, [
          h('div', { class: 'limcode-loading-eyebrow' }, 'LimCode'),
          h('h1', '正在打开视图'),
          h('p', '正在加载当前视图资源。'),
          h('div', { class: 'limcode-loading-progress', 'aria-hidden': 'true' }, [h('span')])
        ])
      ])
    ]);
  }
};

function asyncView(loader: () => Promise<{ default: Component }>): Component {
  return defineAsyncComponent({
    loader,
    loadingComponent: LoadingFallback,
    delay: 0,
    suspensible: false
  });
}

const ChatView = asyncView(() => import('@webview/views/ChatView.vue'));
const GlobalSettingsView = asyncView(() => import('@webview/views/GlobalSettingsView.vue'));
const ModeSettingsView = asyncView(() => import('@webview/views/ModeSettingsView.vue'));
const AgentSettingsView = asyncView(() => import('@webview/views/AgentSettingsView.vue'));

// 必须先完成 bridge 握手，再加载具体业务视图；否则 ChatView/设置页的重组件初始化会阻塞 bridge.ready。
useBridgeBootstrap();
const session = useSessionStore();

const activeView = computed<Component | null>(() => {
  if (session.status !== 'ready') return null;
  if (session.isGlobalSettings) return GlobalSettingsView;
  if (session.isModeSettings) return ModeSettingsView;
  if (session.isAgentSettings) return AgentSettingsView;
  return ChatView;
});
</script>

<template>
  <component :is="activeView || LoadingFallback" />
</template>
