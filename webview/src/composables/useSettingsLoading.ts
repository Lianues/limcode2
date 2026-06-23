import { computed, unref, type ComputedRef, type Ref } from 'vue';
import type { GlobalSettingsSection } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

type MaybeReactive<T> = T | Ref<T> | ComputedRef<T> | (() => T);

export interface SettingsLoadingOptions {
  globalSettingsSections?: MaybeReactive<readonly GlobalSettingsSection[] | undefined>;
}

function resolveValue<T>(value: MaybeReactive<T> | undefined): T | undefined {
  if (typeof value === 'function') return (value as () => T)();
  return value === undefined ? undefined : unref(value as T | Ref<T> | ComputedRef<T>);
}

export function settingsScopeLabel(scopeKind: string | undefined): string {
  switch (scopeKind) {
    case 'agent': return 'Agent ';
    case 'mode': return '模式';
    case 'conversation': return '对话';
    case 'run': return '运行';
    case 'agentSystem': return '多 Agent 系统';
    case 'global':
    default:
      return '';
  }
}

export function useSettingsLoadingText(
  targetLabel: MaybeReactive<string>,
  scopeKind?: MaybeReactive<string | undefined>,
  scopeId?: MaybeReactive<string | undefined>,
  options: SettingsLoadingOptions = {}
): { loading: ComputedRef<boolean>; text: ComputedRef<string> } {
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const sections = computed(() => resolveValue(options.globalSettingsSections) ?? []);
  const clientStateLoading = computed(() => clientState.isConfigScopeClientStateLoading(resolveValue(scopeKind), resolveValue(scopeId)));
  const settingsSectionsLoading = computed(() => sections.value.some((section) =>
    !!globalSettings.loadingSettingsSections[section] || (!globalSettings.loadedSections[section] && !globalSettings.failedSettingsSections[section])
  ));
  const settingsSectionsPending = computed(() => sections.value.some((section) => !!globalSettings.pendingSettingsSections[section]));
  const loading = computed(() => clientStateLoading.value || settingsSectionsLoading.value || settingsSectionsPending.value);
  const text = computed(() => {
    const label = `${settingsScopeLabel(resolveValue(scopeKind))}${resolveValue(targetLabel) ?? '配置'}`;
    return settingsSectionsPending.value && !settingsSectionsLoading.value
      ? `正在同步${label}...`
      : `正在加载${label}...`;
  });
  return { loading, text };
}
