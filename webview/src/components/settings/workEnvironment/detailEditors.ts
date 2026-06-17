import type { Component } from 'vue';
import { REMOTE_SERVER_WORK_ENVIRONMENT_KIND } from '@shared/workEnvironmentCatalog';
import RemoteServerEnvironmentDetail from './RemoteServerEnvironmentDetail.vue';

const detailEditors: Record<string, Component> = {
  [REMOTE_SERVER_WORK_ENVIRONMENT_KIND]: RemoteServerEnvironmentDetail
};

export function workEnvironmentDetailEditorForKind(kind: string | undefined): Component | undefined {
  return kind ? detailEditors[kind] : undefined;
}
