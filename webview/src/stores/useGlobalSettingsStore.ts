import { defineStore } from 'pinia';
import {
  GLOBAL_SETTINGS_SECTIONS,
  type GlobalSettingsRecord,
  type GlobalSettingsSection,
  type GlobalSettingsSnapshotPayload,
  type LlmSettingsRecord
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface GlobalSettingsState {
  common: GlobalSettingsRecord;
  llm: LlmSettingsRecord;
  /** 各 section 的来源文件路径，用于在 UI 展示。 */
  filePaths: Partial<Record<GlobalSettingsSection, string>>;
  status: string;
}

function emptyCommon(): GlobalSettingsRecord {
  return { dataFilePath: '', activeDataRootPath: '', defaultDataRootPath: '' };
}

function emptyLlm(): LlmSettingsRecord {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    apiKey: '',
    proxy: '',
    temperature: 0.2
  };
}

/** 全局设置（数据目录 + LLM）表单 store。组件只读 state + 调 action，传输细节收口在此。 */
export const useGlobalSettingsStore = defineStore('globalSettings', {
  state: (): GlobalSettingsState => ({
    common: emptyCommon(),
    llm: emptyLlm(),
    filePaths: {},
    status: ''
  }),
  actions: {
    requestAll(): void {
      this.status = '正在读取设置...';
      for (const section of GLOBAL_SETTINGS_SECTIONS) {
        bridge.request(BridgeMessageType.GlobalSettingsGet, { section });
      }
    },
    saveCommon(): void {
      this.status = '正在保存设置，并按需迁移、删除旧数据目录中的插件数据...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'common',
        settings: {
          dataFilePath: this.common.dataFilePath,
          activeDataRootPath: this.common.activeDataRootPath,
          defaultDataRootPath: this.common.defaultDataRootPath
        }
      });
    },
    saveLlm(): void {
      this.status = '正在保存设置...';
      bridge.request(BridgeMessageType.GlobalSettingsUpdate, {
        section: 'llm',
        settings: {
          provider: this.llm.provider,
          baseUrl: this.llm.baseUrl,
          model: this.llm.model,
          apiKey: this.llm.apiKey,
          ...(this.llm.proxy?.trim() ? { proxy: this.llm.proxy.trim() } : {}),
          temperature: Number(this.llm.temperature)
        }
      });
    },
    applySnapshot(payload: GlobalSettingsSnapshotPayload): void {
      if (payload.section === 'llm') {
        const settings = payload.settings as LlmSettingsRecord;
        this.llm = { ...settings, proxy: settings.proxy ?? '' };
      } else {
        this.common = payload.settings as GlobalSettingsRecord;
      }
      this.filePaths[payload.section] = payload.filePath;
      this.status = '设置已同步';
    },
    setError(message: string): void {
      this.status = `设置保存失败：${message}`;
    }
  }
});
