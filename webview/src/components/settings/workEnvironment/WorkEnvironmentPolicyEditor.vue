<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconCloudDown, IconPlus, IconServer, IconTrash } from '@tabler/icons-vue';
import type { WorkEnvironmentPolicyScopeKind, WorkEnvironmentRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import { useWorkEnvironmentStore } from '@webview/stores/useWorkEnvironmentStore';

const props = withDefaults(defineProps<{
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  title?: string;
  description?: string;
  readonly?: boolean;
}>(), {
  title: '工作环境策略',
  description: '',
  readonly: false
});

const store = useWorkEnvironmentStore();
const scroller = ref<HTMLElement | null>(null);
const descriptionScroller = ref<HTMLElement | null>(null);
const activeEnvironmentId = ref('');
const sshAuthMethodByEnvironmentId = ref<Record<string, 'identityFile' | 'password'>>({});
const createOpen = ref(false);
const deleteConfirmOpen = ref(false);

const resolution = computed(() => store.effectivePolicyFor(props.scopeKind, props.scopeId));
const localResolution = computed(() => store.localPolicyFor(props.scopeKind, props.scopeId));
const effectivePolicy = computed(() => resolution.value.policy);
const hasLocalOverride = computed(() => props.scopeKind === 'global' || !!localResolution.value.policy);
const canRestoreInheritance = computed(() => props.scopeKind !== 'global' && hasLocalOverride.value && !props.readonly);
const environments = computed(() => store.availableEnvironments);
const allowedSet = computed(() => new Set(effectivePolicy.value?.allowedWorkEnvironmentIds ?? environments.value.map((item) => item.id)));
const defaultEnvironmentId = computed(() => effectivePolicy.value?.defaultWorkEnvironmentId ?? environments.value.find((item) => allowedSet.value.has(item.id))?.id ?? '');
const activeEnvironment = computed(() => environments.value.find((item) => item.id === activeEnvironmentId.value) ?? environments.value[0]);
const activeRemoteEnvironment = computed(() => activeEnvironment.value?.kind === 'remoteServer' ? activeEnvironment.value : undefined);
const sourceLabel = computed(() => {
  if (props.scopeKind === 'global') return '全局默认策略';
  if (hasLocalOverride.value) return '当前作用域覆盖';
  if (resolution.value.inheritedFrom === 'mode') return '继承当前模式策略';
  if (resolution.value.inheritedFrom === 'global') return '继承全局默认策略';
  return '默认策略';
});
const enabledCount = computed(() => environments.value.filter((environment) => allowedSet.value.has(environment.id)).length);
const osOptions: SettingsDropdownOption[] = [
  { value: '', label: '未设置' },
  { value: 'linux', label: 'linux' },
  { value: 'windows', label: 'windows' },
  { value: 'macos', label: 'macos' },
  { value: 'unknown', label: 'unknown' }
];
const sshAuthMethodOptions: SettingsDropdownOption[] = [
  { value: 'identityFile', label: 'IdentityFile', description: '使用 SSH 密钥文件登录' },
  { value: 'password', label: 'Password', description: '使用密码登录' }
];

watch(
  () => environments.value.map((item) => item.id).join('|'),
  () => {
    if (activeEnvironmentId.value && environments.value.some((item) => item.id === activeEnvironmentId.value)) return;
    activeEnvironmentId.value = defaultEnvironmentId.value || environments.value[0]?.id || '';
  },
  { immediate: true }
);

function toggleAllowed(environment: WorkEnvironmentRecord, enabled: boolean): void {
  if (props.readonly) return;
  const next = new Set(allowedSet.value);
  if (enabled) next.add(environment.id);
  else next.delete(environment.id);
  const allowed = environments.value.map((item) => item.id).filter((id) => next.has(id));
  const defaultId = allowed.includes(defaultEnvironmentId.value) ? defaultEnvironmentId.value : allowed[0];
  store.setPolicyForScope(props.scopeKind, props.scopeId, allowed, defaultId, effectivePolicy.value?.name);
}

function setDefault(environment: WorkEnvironmentRecord): void {
  if (props.readonly || !allowedSet.value.has(environment.id)) return;
  store.setPolicyForScope(props.scopeKind, props.scopeId, [...allowedSet.value], environment.id, effectivePolicy.value?.name);
}

function restoreInheritance(): void {
  if (!canRestoreInheritance.value) return;
  store.clearPolicyScope(props.scopeKind, props.scopeId);
}

function openCreate(): void {
  if (props.readonly) return;
  createOpen.value = true;
}

function confirmCreate(host: string): void {
  createOpen.value = false;
  const text = host.trim();
  if (!text) return;
  const id = store.upsertRemoteServerEnvironment({ host: text, name: text, source: 'manual', available: true });
  activeEnvironmentId.value = id;
  toggleAllowed({ id, kind: 'remoteServer', name: text, available: true, createdAt: Date.now(), updatedAt: Date.now() }, true);
}

function cancelCreate(): void { createOpen.value = false; }

function importFromVscode(): void {
  if (props.readonly) return;
  store.importFromVscode();
}

function openDeleteConfirm(): void {
  if (props.readonly || activeRemoteEnvironment.value === undefined) return;
  deleteConfirmOpen.value = true;
}

function confirmDelete(): void {
  const environment = activeRemoteEnvironment.value;
  deleteConfirmOpen.value = false;
  if (!environment) return;
  store.removeEnvironment(environment.id);
  activeEnvironmentId.value = environments.value[0]?.id ?? '';
}

function cancelDelete(): void { deleteConfirmOpen.value = false; }

function updateRemoteField(field: keyof WorkEnvironmentRecord, value: string | number | boolean | undefined): void {
  const environment = activeRemoteEnvironment.value;
  if (!environment || props.readonly) return;
  const credentialPatch = field === 'identityFile' && typeof value === 'string' && value.trim()
    ? { password: undefined }
    : field === 'password' && typeof value === 'string' && value
      ? { identityFile: undefined }
      : {};
  if (field === 'identityFile' && typeof value === 'string' && value.trim()) sshAuthMethodByEnvironmentId.value[environment.id] = 'identityFile';
  if (field === 'password' && typeof value === 'string' && value) sshAuthMethodByEnvironmentId.value[environment.id] = 'password';
  store.upsertRemoteServerEnvironment({ ...environment, [field]: value, ...credentialPatch });
}

function sshAuthMethod(environment: WorkEnvironmentRecord | undefined): string {
  if (environment?.id && sshAuthMethodByEnvironmentId.value[environment.id]) return sshAuthMethodByEnvironmentId.value[environment.id];
  if (environment?.identityFile?.trim()) return 'identityFile';
  if (environment?.password) return 'password';
  return 'identityFile';
}

function updateSshAuthMethod(value: string): void {
  const environment = activeRemoteEnvironment.value;
  if (!environment || props.readonly) return;
  sshAuthMethodByEnvironmentId.value[environment.id] = value === 'password' ? 'password' : 'identityFile';
  if (value === 'password') updateRemoteField('identityFile', undefined);
  else updateRemoteField('password', undefined);
}

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

function editableText(event: Event): string {
  return (event.currentTarget as HTMLElement | null)?.textContent ?? '';
}

function inputOptionalNumber(event: Event): number | undefined {
  const raw = (event.target as HTMLInputElement).value.trim();
  return raw ? normalizePositiveInteger(raw) : undefined;
}

function environmentPath(environment: WorkEnvironmentRecord): string {
  if (environment.kind === 'remoteServer') {
    const userPart = environment.user ? `${environment.user}@` : '';
    const host = environment.host || environment.name || '未设置 Host';
    const port = environment.port && environment.port !== 22 ? `:${environment.port}` : '';
    return `${userPart}${host}${port}${environment.workdir ? ` ${environment.workdir}` : ''}`;
  }
  return environment.displayPath || environment.rootPath || environment.uri || environment.id;
}

function environmentName(environment: WorkEnvironmentRecord | undefined): string {
  return environment?.name?.trim() || environment?.host?.trim() || environment?.id || '未命名工作环境';
}

function kindLabel(environment: WorkEnvironmentRecord): string {
  return environment.kind === 'remoteServer' ? '服务器' : '本地';
}

function normalizePositiveInteger(value: string): number | undefined {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
</script>

<template>
  <section class="work-environment-policy-editor" :aria-label="title">
    <header class="work-env-header">
      <div class="work-env-title-block">
        <h3>{{ title }}</h3>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="work-env-summary" aria-live="polite">
        <span>{{ sourceLabel }}</span>
        <span>{{ enabledCount }} / {{ environments.length }} 已允许</span>
      </div>
    </header>

    <div class="work-env-actions">
      <button type="button" :disabled="readonly" @click="importFromVscode">
        <IconCloudDown stroke="2" aria-hidden="true" />
        <span>从 VS Code 导入</span>
      </button>
      <button type="button" class="secondary" :disabled="readonly" @click="openCreate">
        <IconPlus stroke="2" aria-hidden="true" />
        <span>新建服务器环境</span>
      </button>
      <button type="button" class="secondary" :disabled="!canRestoreInheritance" @click="restoreInheritance">恢复继承</button>
      <span class="work-env-status">{{ store.status }}</span>
    </div>

    <div class="work-env-layout">
      <div class="work-env-list-shell">
        <div ref="scroller" class="work-env-list-scroll">
          <div v-if="environments.length === 0" class="work-env-empty">暂无工作环境。可打开 VS Code 工作区，或从 SSH 配置导入服务器。</div>
          <article
            v-for="environment in environments"
            :key="environment.id"
            class="work-env-item"
            :class="{ 'is-active': environment.id === activeEnvironmentId, 'is-allowed': allowedSet.has(environment.id) }"
          >
            <button type="button" class="work-env-main" @click="activeEnvironmentId = environment.id">
              <span class="work-env-icon" aria-hidden="true"><IconServer stroke="2" /></span>
              <span class="work-env-copy">
                <span class="work-env-name-row">
                  <span class="work-env-name">{{ environmentName(environment) }}</span>
                </span>
                <span class="work-env-meta">
                  <span>{{ kindLabel(environment) }}</span><span v-if="environment.id === defaultEnvironmentId">默认</span>
                </span>
                <span class="work-env-path">{{ environmentPath(environment) }}</span>
              </span>
            </button>
            <div class="work-env-row-actions">
              <LcCheckbox
                :model-value="allowedSet.has(environment.id)"
                :disabled="readonly"
                @update:model-value="toggleAllowed(environment, $event)"
              >
                <span>允许</span>
              </LcCheckbox>
              <button type="button" class="mini-action" :disabled="readonly || !allowedSet.has(environment.id)" @click="setDefault(environment)">设为默认</button>
            </div>
          </article>
        </div>
        <AdvancedScrollbar :scroller="scroller" variant="minimal" />
      </div>

      <section class="work-env-detail" aria-label="工作环境详情">
        <template v-if="activeEnvironment">
          <header class="work-env-detail-header">
            <div>
              <h4>{{ environmentName(activeEnvironment) }}</h4>
              <p>{{ environmentPath(activeEnvironment) }}</p>
            </div>
            <button
              v-if="activeRemoteEnvironment"
              type="button"
              class="icon-action"
              :disabled="readonly"
              title="删除服务器环境"
              @click="openDeleteConfirm"
            >
              <IconTrash stroke="2" aria-hidden="true" />
            </button>
          </header>

          <div v-if="activeRemoteEnvironment" class="work-env-form-grid">
            <label class="global-settings-field">
              <span>Name</span>
              <input :value="activeRemoteEnvironment.name ?? ''" :readonly="readonly" type="text" placeholder="必填，环境显示名称，方便自己和 AI 识别" @change="updateRemoteField('name', inputValue($event))" />
            </label>
            <label class="global-settings-field">
              <span>Host</span>
              <input :value="activeRemoteEnvironment.host ?? activeRemoteEnvironment.name" :readonly="readonly" type="text" @change="updateRemoteField('host', inputValue($event))" />
            </label>
            <label class="global-settings-field">
              <span>User</span>
              <input :value="activeRemoteEnvironment.user ?? ''" :readonly="readonly" type="text" placeholder="必填，例如：root" @change="updateRemoteField('user', inputValue($event))" />
            </label>
            <label class="global-settings-field">
              <span>Port（可选）</span>
              <input :value="activeRemoteEnvironment.port ?? ''" :readonly="readonly" type="number" placeholder="默认 22" @change="updateRemoteField('port', inputOptionalNumber($event))" />
            </label>
            <label class="global-settings-field global-settings-field-wide">
              <span>SSH 登录方式</span>
              <SettingsDropdown
                :model-value="sshAuthMethod(activeRemoteEnvironment)"
                :options="sshAuthMethodOptions"
                title="选择 SSH 登录方式"
                :disabled="readonly"
                @update:model-value="updateSshAuthMethod"
              />
            </label>
            <label v-if="sshAuthMethod(activeRemoteEnvironment) === 'identityFile'" class="global-settings-field global-settings-field-wide">
              <span>IdentityFile</span>
              <input :value="activeRemoteEnvironment.identityFile ?? ''" :readonly="readonly" type="text" placeholder="必填，例如：C:\Users\you\.ssh\id_rsa" @change="updateRemoteField('identityFile', inputValue($event))" />
              <small>如果同时配置了 IdentityFile 和 Password，会优先使用 IdentityFile。</small>
            </label>
            <label v-else class="global-settings-field global-settings-field-wide">
              <span>Password</span>
              <input :value="activeRemoteEnvironment.password ?? ''" :readonly="readonly" type="password" autocomplete="off" placeholder="必填，输入 SSH 登录密码" @change="updateRemoteField('password', inputValue($event))" />
            </label>
            <label class="global-settings-field">
              <span>Workdir（可选）</span>
              <input :value="activeRemoteEnvironment.workdir ?? ''" :readonly="readonly" type="text" placeholder="例如：/root" @change="updateRemoteField('workdir', inputValue($event))" />
            </label>
            <label class="global-settings-field">
              <span>OS（可选）</span>
              <SettingsDropdown
                :model-value="activeRemoteEnvironment.os ?? ''"
                :options="osOptions"
                title="选择系统"
                :disabled="readonly"
                @update:model-value="updateRemoteField('os', $event)"
              />
            </label>
            <label class="global-settings-field global-settings-field-wide">
              <span>Description（可选）</span>
              <div class="work-env-description-shell">
                <div
                  :key="activeRemoteEnvironment.id"
                  ref="descriptionScroller"
                  class="work-env-description-editor"
                  :class="{ 'is-readonly': readonly }"
                  :contenteditable="readonly ? 'false' : 'plaintext-only'"
                  role="textbox"
                  aria-multiline="true"
                  data-placeholder="描述这个服务器环境的用途、权限边界或注意事项"
                  @blur="updateRemoteField('description', editableText($event))"
                >{{ activeRemoteEnvironment.description ?? '' }}</div>
                <AdvancedScrollbar :scroller="descriptionScroller" :refresh-key="activeRemoteEnvironment.id" variant="minimal" />
              </div>
            </label>
          </div>

          <p v-else class="work-env-note">本地工作环境由 VS Code 工作区自动同步，仅可在这里配置是否允许和默认选择。</p>
        </template>
        <div v-else class="work-env-empty">请选择一个工作环境。</div>
      </section>
    </div>

    <InputPanel
      :open="createOpen"
      title="新建服务器环境"
      description="输入 SSH Host，也就是实际用于 ssh user@host 的主机名、IP、域名或 SSH 配置别名。创建后可继续编辑 Name、User、IdentityFile、Password、Workdir 等字段。"
      label="Host"
      placeholder="例如：93.127.137.197"
      confirm-label="创建"
      @confirm="confirmCreate"
      @cancel="cancelCreate"
    />

    <ConfirmPanel
      :open="deleteConfirmOpen"
      title="删除服务器环境？"
      :description-html="`将删除「${activeRemoteEnvironment?.name ?? '当前服务器环境'}」，并从相关工作环境策略中移除引用。此操作<strong>无法撤销</strong>。`"
      confirm-label="删除"
      cancel-label="取消"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.work-environment-policy-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.work-env-header,
.work-env-actions,
.work-env-row-actions,
.work-env-detail-header {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.work-env-header,
.work-env-detail-header {
  justify-content: space-between;
  align-items: flex-start;
}

.work-env-title-block h3,
.work-env-detail-header h4 {
  margin: 0;
  font-size: var(--font-size-md);
}

.work-env-title-block p,
.work-env-detail-header p,
.work-env-status,
.work-env-note {
  margin: var(--space-1) 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.work-env-summary {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.work-env-summary span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.work-env-actions {
  flex-wrap: wrap;
}

.work-env-actions > button,
.mini-action,
.icon-action {
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
  box-shadow: none;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.work-env-actions > button {
  min-height: 30px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-sm);
}

.mini-action {
  min-height: 24px;
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.icon-action {
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.work-env-actions > button:hover:not(:disabled),
.work-env-actions > button:focus-visible,
.mini-action:hover:not(:disabled),
.mini-action:focus-visible,
.icon-action:hover:not(:disabled),
.icon-action:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.work-env-actions > button:disabled,
.mini-action:disabled,
.icon-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
  cursor: default;
}

.work-env-layout {
  min-height: 360px;
  display: grid;
  grid-template-columns: minmax(220px, 0.9fr) minmax(0, 1.2fr);
  gap: var(--space-3);
}

.work-env-list-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.work-env-list-scroll {
  max-height: 420px;
  overflow-y: auto;
  padding: var(--space-2);
  scrollbar-width: none;
}

.work-env-list-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.work-env-item {
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
}

.work-env-item:hover,
.work-env-item.is-active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, transparent);
}

.work-env-main {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: var(--space-2);
  text-align: left;
}

.work-env-main:hover:not(:disabled),
.work-env-main:focus-visible {
  background: transparent;
  outline: none;
}

.work-env-icon {
  width: 24px;
  height: 24px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
}

.work-env-icon svg {
  width: 15px;
  height: 15px;
}

.work-env-copy,
.work-env-name-row {
  min-width: 0;
}

.work-env-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.work-env-name-row {
  display: block;
}

.work-env-meta {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-2);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 84%, transparent);
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.work-env-name,
.work-env-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.work-env-name {
  font-weight: 600;
}

.work-env-path {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.work-env-detail {
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
}

.work-env-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.work-env-form-grid .global-settings-field small {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  opacity: 0.82;
}

.work-env-form-grid :deep(input[type='number']) {
  appearance: textfield;
  -moz-appearance: textfield;
}

.work-env-form-grid :deep(input[type='number']::-webkit-outer-spin-button),
.work-env-form-grid :deep(input[type='number']::-webkit-inner-spin-button) {
  margin: 0;
  appearance: none;
  -webkit-appearance: none;
}

.work-env-description-shell {
  position: relative;
  overflow: hidden;
}

.work-env-description-editor {
  width: 100%;
  height: 86px;
  overflow-y: auto;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: var(--space-2) calc(var(--space-2) + 10px) var(--space-2) var(--space-2);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-width: none;
}

.work-env-description-editor::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.work-env-description-editor:empty::before {
  content: attr(data-placeholder);
  color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
  pointer-events: none;
}

.work-env-description-editor:focus {
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
}

.work-env-description-editor.is-readonly {
  color: var(--vscode-descriptionForeground);
  cursor: default;
  opacity: 0.82;
}

.work-env-empty {
  padding: var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

@media (max-width: 820px) {
  .work-env-layout,
  .work-env-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
